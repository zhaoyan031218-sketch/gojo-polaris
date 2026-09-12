// OpenRouter 1h-cache 注入代理 — Zeabur / Node (>=18) 版
// v8: 动态时间搬迁 (time-shift)
//   核心新增: 把 system 提示词里"随时间变化的行"(当前时间/日期/星期等)
//   从稳定前缀里摘出来, 追加到最后一条 user 消息尾部。
//   —— 信息不丢失, 只是换了个位置: 模型照样看得到时间,
//      但它不再污染缓存前缀, 跨整点也不会掉缓存。
//
// 其余能力沿用:
//   v6 智能断点 (system 头部 + 尾部真实 user/assistant, 跳过 tool 与动态注入)
//   v7 前缀指纹 (tools / system / 断点前缀哈希)
//   ttl 一律 1h; anthropic/ 系模型钉死 Anthropic 官方线路
//   响应侧真实 usage 抓取
//
// 环境变量 (都可不设):
//   DISABLE_TIME_STRIP=1  关闭时间搬迁, 回到 v7 行为
//   DEBUG_SHOW_MOVED=1    日志里显示被搬走的原文 (默认只记长度和类型, 保护隐私)

const http = require("http");
const crypto = require("crypto");

const VERSION = "v8-timeshift";
const PORT = process.env.PORT || 8080;
const TARGET = "https://openrouter.ai";
const CC = { type: "ephemeral", ttl: "1h" };

const DISABLE_TIME_STRIP = process.env.DISABLE_TIME_STRIP === "1";
const DEBUG_SHOW_MOVED = process.env.DEBUG_SHOW_MOVED === "1";

// 误伤保护:
//   带明确标记词的行 (如"当前时间：...") 最长 200 字符, 直接搬
//   只是碰巧含日期/时刻的行, 必须"短" 且 "时间占了这行的大部分" 才搬
//   —— 这样人设正文里的 "他出生于 1999 年 3 月 2 日, 是一个……" 不会被误伤
const MAX_LABEL_LINE_CHARS = 200;
const MAX_BARE_LINE_CHARS = 80;
const MIN_BARE_MATCH_RATIO = 0.3;

const TIME_PATTERNS = [
  // 明确的标记词, 信号最强
  { k: "label", re: /(当前|现在|此刻|今天|系统)\s*(时间|日期|时刻)/ },
  { k: "label", re: /(current|today'?s)\s*(time|date)/i },
  { k: "label", re: /距离(上次|上一次)/ },
  // 日期
  { k: "date", re: /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}/ },
  { k: "date", re: /\d{1,2}\s*月\s*\d{1,2}\s*日/ },
  // 时钟
  { k: "clock", re: /\d{1,2}\s*[:：]\s*\d{2}/ },
  { k: "clock", re: /\d\s*(am|pm)\b/i },
  // 星期
  { k: "weekday", re: /(星期|周)\s*[一二三四五六日天]/ },
  {
    k: "weekday",
    re: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  },
];

function h(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);
}

function classifyLine(line) {
  const len = line.trim().length;
  if (!len) return null;

  let hasLabel = false;
  let bestMatch = 0;
  let kind = null;

  for (const p of TIME_PATTERNS) {
    const m = line.match(p.re);
    if (!m) continue;
    if (p.k === "label") hasLabel = true;
    if (m[0].length > bestMatch) {
      bestMatch = m[0].length;
      kind = p.k;
    }
  }
  if (!kind) return null;

  // 有标记词 -> 几乎可以确定是注入的动态信息
  if (hasLabel) return len <= MAX_LABEL_LINE_CHARS ? "label" : null;

  // 没标记词 -> 必须又短、时间又占了大头, 才敢搬
  if (len > MAX_BARE_LINE_CHARS) return null;
  if (bestMatch / len < MIN_BARE_MATCH_RATIO) return null;
  return kind;
}

// 把一段文本拆成 { kept, moved[] }
function splitVolatile(text) {
  const lines = text.split("\n");
  const kept = [];
  const moved = [];
  for (const line of lines) {
    const kind = line.trim() ? classifyLine(line) : null;
    if (kind) moved.push({ kind: kind, chars: line.length, text: line });
    else kept.push(line);
  }
  return { kept: kept.join("\n"), moved: moved };
}

function isEmptyContent(c) {
  if (typeof c === "string") return c.trim() === "";
  if (Array.isArray(c)) {
    return c.every(
      (b) => !b || (b.type === "text" && (!b.text || b.text.trim() === ""))
    );
  }
  return !c;
}

function appendToLastUser(msgs, text) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") {
      m.content = m.content + "\n\n" + text;
      return i;
    }
    if (Array.isArray(m.content)) {
      for (let j = m.content.length - 1; j >= 0; j--) {
        const b = m.content[j];
        if (b && b.type === "text" && typeof b.text === "string") {
          b.text = b.text + "\n\n" + text;
          return i;
        }
      }
      m.content.push({ type: "text", text: text });
      return i;
    }
  }
  return -1;
}

// 从开头连续的 system 段里摘走动态时间行, 返回被搬走的条目
function timeShift(msgs) {
  const moved = [];
  let headEnd = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i] && msgs[i].role === "system") headEnd = i;
    else break;
  }
  if (headEnd < 0) return { moved: moved, appendedTo: -1, dropped: [] };

  for (let i = 0; i <= headEnd; i++) {
    const m = msgs[i];
    if (typeof m.content === "string") {
      const r = splitVolatile(m.content);
      if (r.moved.length) {
        m.content = r.kept;
        for (const mv of r.moved) moved.push({ from: i, ...mv });
      }
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === "text" && typeof b.text === "string") {
          const r = splitVolatile(b.text);
          if (r.moved.length) {
            b.text = r.kept;
            for (const mv of r.moved) moved.push({ from: i, ...mv });
          }
        }
      }
    }
  }

  if (moved.length === 0) return { moved: moved, appendedTo: -1, dropped: [] };

  // 搬空了的 system 消息直接移除 (从后往前删, 避免索引错位)
  const dropped = [];
  for (let i = headEnd; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === "system" && isEmptyContent(msgs[i].content)) {
      dropped.push(i);
      msgs.splice(i, 1);
    }
  }

  const text = moved.map((m) => m.text).join("\n");
  const appendedTo = appendToLastUser(msgs, text);

  // 没有 user 消息可挂靠 -> 回滚: 作为一条新的尾部 system 消息放回去
  if (appendedTo === -1) {
    msgs.push({ role: "system", content: text });
  }

  return { moved: moved, appendedTo: appendedTo, dropped: dropped };
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

// 供本地测试复用
function transform(data) {
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  const shift = DISABLE_TIME_STRIP
    ? { moved: [], appendedTo: -1, dropped: [] }
    : timeShift(msgs);

  const anchors = chooseAnchors(msgs);
  const toolsStr = JSON.stringify(data.tools || null);
  const prefixHashes = anchors.map((i) => ({
    at: i,
    hash: h(toolsStr + "|" + JSON.stringify(msgs.slice(0, i + 1))),
  }));
  const sysHashes = [];
  for (let i = 0; i < msgs.length; i++) {
    if (!msgs[i] || msgs[i].role !== "system") break;
    const s = JSON.stringify(msgs[i].content);
    sysHashes.push({ i: i, chars: s.length, hash: h(s) });
  }
  return { msgs, shift, anchors, toolsStr, prefixHashes, sysHashes };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/__version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          version: VERSION,
          time_strip: !DISABLE_TIME_STRIP,
        })
      );
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = Buffer.concat(chunks);

    let reqId = null;
    const isChat = req.url.includes("/chat/completions");

    if (req.method === "POST" && body.length > 0 && isChat) {
      try {
        const data = JSON.parse(body.toString("utf8"));

        // 1) 先搬时间, 再算指纹和断点 (指纹反映的是真正发出去的形态)
        const { msgs, shift, anchors, prefixHashes, sysHashes } = transform(data);

        const toolsStr = JSON.stringify(data.tools || null);
        const toolsInfo = {
          count: Array.isArray(data.tools) ? data.tools.length : 0,
          chars: toolsStr.length,
          hash: h(toolsStr),
          names_hash: Array.isArray(data.tools)
            ? h(
                data.tools
                  .map(
                    (t) => (t && t.function && t.function.name) || (t && t.name) || "?"
                  )
                  .join(",")
              )
            : null,
        };

        // 2) 注入缓存断点
        injectTtl(data);
        const pre = [];
        findCacheControls(data, "$", pre);

        let injected = 0;
        if (pre.length === 0 && msgs.length > 0) {
          for (const i of anchors) if (markMessage(msgs[i])) injected++;
        }

        if (
          typeof data.model === "string" &&
          data.model.startsWith("anthropic/") &&
          !data.provider
        ) {
          data.provider = { order: ["anthropic"], allow_fallbacks: false };
        }

        reqId = Math.random().toString(36).slice(2, 8);

        console.log(
          JSON.stringify({
            t: new Date().toISOString(),
            v: VERSION,
            id: reqId,
            kind: "request",
            model: data.model,
            stream: !!data.stream,
            time_shift: {
              moved_count: shift.moved.length,
              kinds: shift.moved.map((m) => m.kind),
              chars: shift.moved.reduce((a, b) => a + b.chars, 0),
              appended_to_msg: shift.appendedTo,
              dropped_system: shift.dropped,
              text: DEBUG_SHOW_MOVED ? shift.moved.map((m) => m.text) : undefined,
            },
            preexisting_cc: pre.length,
            injected_cc: injected,
            anchors: anchors,
            prefix_hashes: prefixHashes,
            tools: toolsInfo,
            sys_hashes: sysHashes,
            msg_count: msgs.length,
            total_body_chars: body.length,
            msg_sizes: msgs.map((m, i) => ({
              i: i,
              role: m && m.role,
              chars: JSON.stringify(m && m.content ? m.content : "").length,
            })),
          })
        );

        body = Buffer.from(JSON.stringify(data), "utf8");
      } catch (e) {
        console.log("chat body parse failed, forwarding as-is:", e.message);
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

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(
      `openrouter 1h-cache proxy ${VERSION} listening on :${PORT} (time_strip=${!DISABLE_TIME_STRIP})`
    );
  });
}

module.exports = { transform, timeShift, splitVolatile, chooseAnchors, h };
