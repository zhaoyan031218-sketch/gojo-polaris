// OpenRouter 1h-cache 注入代理 — Zeabur / Node (>=18) 版
// v7: 在 v6 智能断点的基础上, 增加"前缀指纹"观测
//   - tools / 每条 system / 每个断点处的前缀, 各算一个哈希
//   - 两轮请求对比哈希, 即可判断稳定前缀是否被悄悄改动 (时间变量、工具顺序等)
//   - 响应侧继续抓取真实 usage (含 5m / 1h 写入明细)

const http = require("http");
const crypto = require("crypto");

const VERSION = "v7-fingerprint";
const PORT = process.env.PORT || 8080;
const TARGET = "https://openrouter.ai";
const CC = { type: "ephemeral", ttl: "1h" };

function h(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);
}

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
    if (node.cache_control) out.push(path);
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

// 断点选位: 1) 开头连续 system 段的最后一条  2) 尾部最近两条真实 user/assistant
function chooseAnchors(msgs) {
  const anchors = [];
  let headEnd = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i] && msgs[i].role === "system") headEnd = i;
    else break;
  }
  if (headEnd >= 0) anchors.push(headEnd);

  let found = 0;
  for (let i = msgs.length - 1; i >= 0 && found < 2; i--) {
    if (i <= headEnd) break;
    const role = msgs[i] && msgs[i].role;
    if (role === "user" || role === "assistant") {
      if (role === "assistant" && msgs[i].tool_calls) continue;
      anchors.push(i);
      found++;
    }
  }
  return anchors;
}

function extractUsage(sseText) {
  let usage = null;
  for (const line of sseText.split("\n")) {
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
        const raw = body.toString("utf8");
        const data = JSON.parse(raw);
        const msgs = Array.isArray(data.messages) ? data.messages : [];

        // ---------- 1. 先在"未改动"的请求上算指纹 ----------
        const anchors = chooseAnchors(msgs);

        const toolsStr = JSON.stringify(data.tools || null);
        const toolsInfo = {
          count: Array.isArray(data.tools) ? data.tools.length : 0,
          chars: toolsStr.length,
          hash: h(toolsStr),
          // 工具名顺序: 顺序一变前缀就变, 单独记录便于比对
          names_hash: Array.isArray(data.tools)
            ? h(
                data.tools
                  .map((t) => (t && t.function && t.function.name) || (t && t.name) || "?")
                  .join(",")
              )
            : null,
        };

        // 开头连续 system 段: 逐条记哈希, 精确定位是哪一条在变
        const sysHashes = [];
        for (let i = 0; i < msgs.length; i++) {
          if (!msgs[i] || msgs[i].role !== "system") break;
          const s = JSON.stringify(msgs[i].content);
          sysHashes.push({ i: i, chars: s.length, hash: h(s) });
        }

        // 每个断点处的完整前缀指纹 (tools + 到该断点为止的消息)
        const prefixHashes = anchors.map((i) => ({
          at: i,
          hash: h(toolsStr + "|" + JSON.stringify(msgs.slice(0, i + 1))),
        }));

        // ---------- 2. 再做注入 ----------
        injectTtl(data);

        const pre = [];
        findCacheControls(data, "$", pre);

        let injected = 0;
        if (pre.length === 0 && msgs.length > 0) {
          for (const i of anchors) {
            if (markMessage(msgs[i])) injected++;
          }
        }

        if (
          typeof data.model === "string" &&
          data.model.startsWith("anthropic/") &&
          !data.provider
        ) {
          data.provider = { order: ["anthropic"], allow_fallbacks: false };
        }

        const sizes = msgs.map((m, i) => ({
          i: i,
          role: m && m.role,
          chars: JSON.stringify(m && m.content ? m.content : "").length,
        }));

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
            preexisting_cc: pre.length,
            injected_cc: injected,
            anchors: anchors,
            prefix_hashes: prefixHashes, // ← 两轮之间对比这个
            tools: toolsInfo, // ← 工具定义是否稳定
            sys_hashes: sysHashes, // ← system 头部是否稳定
            msg_count: msgs.length,
            total_body_chars: body.length,
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

    let tail = "";
    const TAIL_MAX = 262144;
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
          usage: usage,
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
