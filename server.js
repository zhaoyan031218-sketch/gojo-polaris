// OpenRouter 1h-cache 注入代理 — Zeabur / Node (>=18) 版
// 作用: 转发请求到 OpenRouter, 并把请求里所有
// { "cache_control": { "type": "ephemeral" } }
// 深度改写为 { "type": "ephemeral", "ttl": "1h" },
// 无论它在顶层、messages 里还是 tools 里。
// 零依赖, 直接 node server.js 即可运行。

const http = require("http");

const PORT = process.env.PORT || 8080;
const TARGET = "https://openrouter.ai";

function injectTtl(node) {
  if (Array.isArray(node)) {
    for (const item of node) injectTtl(item);
    return;
  }
  if (node && typeof node === "object") {
    if (
      node.cache_control &&
      typeof node.cache_control === "object" &&
      node.cache_control.type === "ephemeral"
    ) {
      node.cache_control.ttl = "1h";
    }
    for (const key of Object.keys(node)) injectTtl(node[key]);
  }
}

function hasCacheControl(node) {
  if (Array.isArray(node)) return node.some(hasCacheControl);
  if (node && typeof node === "object") {
    if (node.cache_control) return true;
    return Object.keys(node).some((k) => hasCacheControl(node[k]));
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    // 读取完整请求体
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = Buffer.concat(chunks);

    // POST 且是 JSON 时注入 ttl
    if (req.method === "POST" && body.length > 0) {
      try {
        const data = JSON.parse(body.toString("utf8"));
        injectTtl(data);
        // 整个请求里一个 cache_control 都没有时, 补一个顶层兜底
        if (!hasCacheControl(data)) {
          data.cache_control = { type: "ephemeral", ttl: "1h" };
        }
        // Anthropic 系模型: 钉死到 Anthropic 官方线路,
        // 防止 OpenRouter 负载均衡把请求派到别家 provider 导致缓存读不到
        if (
          typeof data.model === "string" &&
          data.model.startsWith("anthropic/") &&
          !data.provider
        ) {
          data.provider = { order: ["anthropic"], allow_fallbacks: false };
        }
        body = Buffer.from(JSON.stringify(data), "utf8");
      } catch (e) {
        // 不是 JSON 就原样转发
      }
    }

    // 组装转发 header
    const headers = { ...req.headers };
    delete headers["host"];
    delete headers["content-length"];
    delete headers["connection"];

    const upstream = await fetch(TARGET + req.url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });

    // 回传响应 header (去掉与解压/分块冲突的几个)
    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      if (!["content-encoding", "content-length", "transfer-encoding"].includes(k)) {
        outHeaders[k] = v;
      }
    });
    res.writeHead(upstream.status, outHeaders);

    // 流式回传 (SSE 打字机效果不受影响)
    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("proxy error: " + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`openrouter 1h-cache proxy listening on :${PORT}`);
});
