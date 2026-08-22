// OpenRouter 1h-cache 注入代理 — Zeabur / Node (>=18) 版
// v4: 不再依赖 OpenRouter 顶层自动缓存, 改为在消息里种显式断点
//   - system 消息尾部打一个断点 (稳定大块)
//   - 最后两条消息尾部各打一个断点 (移动断点, 随对话增长前进)
//   - 全部使用 ttl: "1h"
//   - Anthropic 命中时会自动向前回溯查找已缓存前缀, 所以断点后移不影响命中
// anthropic/ 系模型继续钉死到 Anthropic 官方线路。

const http = require("http");

const VERSION = "v4-explicit";
const PORT = process.env.PORT || 8080;
const TARGET = "https://openrouter.ai";
const CC = { type: "ephemeral", ttl: "1h" };

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

// 给一条消息的内容尾部打上缓存断点。返回 true 表示成功。
function markMessage(msg) {
  if (!msg || msg.cache_control) return false;
  const c = msg.content;
  if (typeof c === "string") {
    if (c.length === 0) return false;
    msg.content = [{ type: "text", text: c, cache_control: { ...CC } }];
    return true;
  }
  if (Array.isArray(c) && c.length > 0) {
    // 从尾部找最后一个 object 块打标
    for (let i = c.length - 1; i >= 0; i--) {
      if (c[i] && typeof c[i] === "object") {
        c[i].cache_control = { ...CC };
        return true;
      }
    }
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
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

        const before = [];
        findCacheControls(data, "$", before);

        let injected = 0;
        if (before.length === 0 && Array.isArray(data.messages) && data.messages.length > 0) {
          const msgs = data.messages;
          // 1) 第一条 system 消息 (稳定人设大块)
          const sys = msgs.find((m) => m && m.role === "system");
          if (sys && markMessage(sys)) injected++;
          // 2) 最后两条消息 (移动断点), 跳过已经打过标的
          for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 2; i--) {
            if (msgs[i] !== sys && markMessage(msgs[i])) injected++;
          }
        }

        // anthropic/ 系模型: 钉死到 Anthropic 官方线路
        if (
          typeof data.model === "string" &&
          data.model.startsWith("anthropic/") &&
          !data.provider
        ) {
          data.provider = { order: ["anthropic"], allow_fallbacks: false };
        }

        const after = [];
        findCacheControls(data, "$", after);

        console.log(
          JSON.stringify({
            t: new Date().toISOString(),
            v: VERSION,
            url: req.url,
            model: data.model,
            stream: !!data.stream,
            preexisting_cc: before.length,
            injected_cc: injected,
            cache_segments: after.map((s) => s.path),
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
