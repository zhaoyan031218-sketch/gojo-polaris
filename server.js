// OpenRouter 1h-cache 注入代理 — Zeabur / Node (>=18) 版
// v5: 在 v4 显式断点的基础上, 增加两类观测:
//   1) 响应侧 usage 捕获 (从 SSE 流里解析 Anthropic 实际返回的缓存读写明细)
//   2) 请求侧消息体积分布 (每条消息的字符数, 用于定位突然膨胀的内容)

const http = require("http");

const VERSION = "v5-usage";
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

function markMessage(msg) {
  if (!msg || msg.cache_control) return false;
  const c = msg.content;
  if (typeof c === "string") {
    if (c.length === 0) return false;
    msg.content = [{ type: "text", text: c, cache_control: { ...CC } }];
    return true;
  }
  if (Array.isArray(c) && c.length > 0) {
    for (let i = c.length - 1; i >= 0; i--) {
      if (c[i] && typeof c[i] === "object") {
        c[i].cache_control = { ...CC };
        return true;
      }
    }
  }
  return false;
}

// 从 SSE 文本中提取最后一个带 usage 的 JSON
function extractUsage(sseText) {
  let usage = null;
  const lines = sseText.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      if (obj && obj.usage) usage = obj.usage;
    } catch (e) {}
  }
  return usage;
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

    let reqId = null;
    let isChat = false;

    if (req.method === "POST" && body.length > 0) {
      try {
        const data = JSON.parse(body.toString("utf8"));
        injectTtl(data);

        const before = [];
        findCacheControls(data, "$", before);

        let injected = 0;
        if (before.length === 0 && Array.isArray(data.messages) && data.messages.length > 0) {
          const msgs = data.messages;
          const sys = msgs.find((m) => m && m.role === "system");
          if (sys && markMessage(sys)) injected++;
          for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 2; i--) {
            if (msgs[i] !== sys && markMessage(msgs[i])) injected++;
          }
        }

        if (
          typeof data.model === "string" &&
          data.model.startsWith("anthropic/") &&
          !data.provider
        ) {
          data.provider = { order: ["anthropic"], allow_fallbacks: false };
        }

        const after = [];
        findCacheControls(data, "$", after);

        // 消息体积分布: 每条消息 JSON 字符数
        const sizes = Array.isArray(data.messages)
          ? data.messages.map((m, i) => ({
              i: i,
              role: m && m.role,
              chars: JSON.stringify(m && m.content ? m.content : "").length,
            }))
          : [];
        const totalChars = body.length;

        isChat = req.url.includes("/chat/completions");
        reqId = Math.random().toString(36).slice(2, 8);

        console.log(
          JSON.stringify({
            t: new Date().toISOString(),
            v: VERSION,
            id: reqId,
            kind: "request",
            url: req.url,
            model: data.model,
            stream: !!data.stream,
            preexisting_cc: before.length,
            injected_cc: injected,
            cache_segments: after.map((s) => s.path),
            provider: data.provider || null,
            has_reasoning: data.reasoning !== undefined,
            msg_count: sizes.length,
            total_body_chars: totalChars,
            msg_sizes: sizes,
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

    // 流式转发的同时抓取响应尾部, 用于解析 usage
    let tail = "";
    const TAIL_MAX = 262144; // 保留最后 256KB 足够覆盖 usage 块
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder("utf8");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        if (isChat) {
          tail += decoder.decode(value, { stream: true });
          if (tail.length > TAIL_MAX) tail = tail.slice(-TAIL_MAX);
        }
      }
    }
    res.end();

    if (isChat) {
      let usage = null;
      try {
        // 流式: SSE; 非流式: 整体 JSON
        usage = extractUsage(tail);
        if (!usage) {
          const obj = JSON.parse(tail);
          if (obj && obj.usage) usage = obj.usage;
        }
      } catch (e) {}
      console.log(
        JSON.stringify({
          t: new Date().toISOString(),
          v: VERSION,
          id: reqId,
          kind: "response_usage",
          status: upstream.status,
          usage: usage, // null 表示响应里没找到 usage
        })
      );
    }
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("proxy error: " + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`openrouter 1h-cache proxy ${VERSION} listening on :${PORT}`);
});
