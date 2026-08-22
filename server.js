// OpenRouter 1h-cache 注入代理 — Zeabur / Node (>=18) 版
// v3: 新增观测日志 + 版本自检端点
// 作用: 转发请求到 OpenRouter, 并把请求里所有
// { "cache_control": { "type": "ephemeral" } }
// 深度改写为 { "type": "ephemeral", "ttl": "1h" };
// anthropic/ 系模型钉死到 Anthropic 官方线路。

const http = require("http");

const VERSION = "v3-debug";
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

// 收集所有 cache_control 的位置, 用于日志
function findCacheControls(node, path, out) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => findCacheControls(item, path + "[" + i + "]", out));
    return;
  }
  if (node && typeof node === "object") {
    if (node.cache_control) {
      out.push({ path: path, cache_control: node.cache_control });
    }
    for (const key of Object.keys(node)) {
      findCacheControls(node[key], path + "." + key, out);
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    // 版本自检: 浏览器打开 /__version 即可确认部署的是哪一版
    if (req.method === "GET" && req.url === "/__version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: VERSION }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = Buffer.concat(chunks);

    if (req.method === "POST" && body.length > 0) {
      try {
        const data = JSON.parse(body.toString("utf8"));
        injectTtl(data);

        const segs = [];
        findCacheControls(data, "$", segs);

        // 一个 cache_control 都没有时, 补一个顶层兜底
        if (segs.length === 0) {
          data.cache_control = { type: "ephemeral", ttl: "1h" };
        }

        // anthropic/ 系模型: 钉死到 Anthropic 官方线路
        if (
          typeof data.model === "string" &&
          data.model.startsWith("anthropic/") &&
          !data.provider
        ) {
          data.provider = { order: ["anthropic"], allow_fallbacks: false };
        }

        // 观测日志 (在 Zeabur 的 Logs 面板查看)
        console.log(
          JSON.stringify({
            t: new Date().toISOString(),
            url: req.url,
            model: data.model,
            stream: !!data.stream,
            cache_control_count: segs.length,
            cache_segments: segs,
            top_level_fallback: segs.length === 0,
            provider: data.provider || null,
            has_reasoning: data.reasoning !== undefined,
            msg_count: Array.isArray(data.messages) ? data.messages.length : 0,
          })
        );

        body = Buffer.from(JSON.stringify(data), "utf8");
      } catch (e) {
        console.log("non-JSON POST body, forwarding as-is:", e.message);
      }
    }

    const headers = { ...req.headers };
    delete headers["host"];
    delete headers["content-length"];
    delete headers["connection"];

    const upstream = await fetch(TARGET + req.url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });

    const outHeaders = { "x-proxy-version": VERSION };
    upstream.headers.forEach((v, k) => {
      if (!["content-encoding", "content-length", "transfer-encoding"].includes(k)) {
        outHeaders[k] = v;
      }
    });
    res.writeHead(upstream.status, outHeaders);

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
  console.log(`openrouter 1h-cache proxy ${VERSION} listening on :${PORT}`);
});
