// OpenRouter 1h-cache 注入代理 — Zeabur / Node (>=18) 版
// v6: 智能断点放置
//   - 队首: 找到开头连续的 system 消息段, 在最后一条上打标 (整块罩住人设区)
//   - 移动断点: 从队尾往前找, 跳过 tool 消息和尾部动态 system 注入,
//     只在最近两条真实 user/assistant 消息上打标
//   - 动态尾巴 (时间/状态类 system 注入) 留在缓存区外, 不再污染书签
//   - 全部 ttl: "1h"; anthropic/ 系模型钉死 Anthropic 官方线路
//   - 保留 v5 的观测: 请求侧消息体积分布 + 响应侧真实 usage

const http = require("http");

const VERSION = "v6-smart";
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

// v6 断点选位:
// 1) 开头连续 system 段的最后一条
// 2) 从尾部向前, 跳过 system/tool, 找最近两条 user/assistant
function chooseAnchors(msgs) {
  const anchors = [];

  // 1) 队首 system 段
  let headEnd = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i] && msgs[i].role === "system") headEnd = i;
    else break;
  }
  if (headEnd >= 0) anchors.push(headEnd);

  // 2) 移动断点: 跳过尾部动态 system 和 tool 消息
  let found = 0;
  for (let i = msgs.length - 1; i >= 0 && found < 2; i--) {
    if (i <= headEnd) break;
    const role = msgs[i] && msgs[i].role;
    if (role === "user" || role === "assistant") {
      // 跳过带 tool_calls 的 assistant 消息 (内容常为空, 且形态特殊)
      if (role === "assistant" && msgs[i].tool_calls) continue;
      anchors.push(i);
      found++;
    }
  }
  return anchors;
}

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

        let anchorIdx = [];
        let injected = 0;
        if (before.length === 0 && Array.isArray(data.messages) && data.messages.length > 0) {
          anchorIdx = chooseAnchors(data.messages);
          for (const i of anchorIdx) {
            if (markMessage(data.messages[i])) injected++;
          }
        }

        if (
          typeof data.model === "string" &&
          data.model.startsWith("anthropic/") &&
          !data.provider
        ) {
          data.provider = { order: ["anthropic"], allow_fallbacks: false };
        }

        const sizes = Array.isArray(data.messages)
          ? data.messages.map((m, i) => ({
              i: i,
              role: m && m.role,
              chars: JSON.stringify(m && m.content ? m.content : "").length,
            }))
          : [];

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
            anchor_indexes: anchorIdx,
            provider: data.provider || null,
            has_reasoning: data.reasoning !== undefined,
            msg_count: sizes.length,
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
