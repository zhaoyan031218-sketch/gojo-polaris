// OpenRouter 1h-cache 注入代理 — Zeabur / Node (>=18) 版
// v9: 自适应锚点 (learned boundary)
//
// 不再靠"猜形状"决定书签放哪, 而是靠观察:
//   把最近若干次请求的逐条消息哈希记在内存里, 新请求进来时和它们比对,
//   找出"最长公共前缀" —— 也就是这个平台实际稳定到第几条消息。
//   书签就钉在那个边界上, 绝不越界。
//
// 为什么重要:
//   越界写入的代价是真金白银 —— 1h 缓存写入是普通输入的 2 倍价,
//   而写进去的如果下一轮对不上, 这笔钱就纯粹打水漂。
//   实测 Aru 平台上, 越界写入每轮浪费约 40% 成本。
//
// 沿用: v8 动态时间搬迁 / v7 前缀指纹 / ttl 1h / Anthropic 线路钉死 / 响应 usage
//
// 环境变量:
//   DISABLE_LCP=1         关闭自适应, 回到 v8 的固定规则
//   DISABLE_TIME_STRIP=1  关闭时间搬迁
//   DEBUG_SHOW_MOVED=1    日志显示被搬走的原文

const http = require("http");
const crypto = require("crypto");

const VERSION = "v10-divergence";
const PORT = process.env.PORT || 8080;
const TARGET = "https://openrouter.ai";
const CC = { type: "ephemeral", ttl: "1h" };

const DISABLE_TIME_STRIP = process.env.DISABLE_TIME_STRIP === "1";
const DEBUG_SHOW_MOVED = process.env.DEBUG_SHOW_MOVED === "1";
const DISABLE_LCP = process.env.DISABLE_LCP === "1";

const MAX_LABEL_LINE_CHARS = 200;
const MAX_BARE_LINE_CHARS = 80;
const MIN_BARE_MATCH_RATIO = 0.3;

// 最近请求的记忆 (进程内, 重启即忘 —— 忘了也只是退回保守模式, 不会出错)
const RECENT_MAX = 24;
const RECENT_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时
const recent = []; // [{ hashes: string[], t: number }]

const TIME_PATTERNS = [
  { k: "label", re: /(当前|现在|此刻|今天|系统)\s*(时间|日期|时刻)/ },
  { k: "label", re: /(current|today'?s)\s*(time|date)/i },
  { k: "label", re: /距离(上次|上一次)/ },
  { k: "date", re: /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}/ },
  { k: "date", re: /\d{1,2}\s*月\s*\d{1,2}\s*日/ },
  { k: "clock", re: /\d{1,2}\s*[:：]\s*\d{2}/ },
  { k: "clock", re: /\d\s*(am|pm)\b/i },
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
  if (hasLabel) return len <= MAX_LABEL_LINE_CHARS ? "label" : null;
  if (len > MAX_BARE_LINE_CHARS) return null;
  if (bestMatch / len < MIN_BARE_MATCH_RATIO) return null;
  return kind;
}

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

function headEndIndex(msgs) {
  let headEnd = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i] && msgs[i].role === "system") headEnd = i;
    else break;
  }
  return headEnd;
}

function timeShift(msgs) {
  const moved = [];
  const headEnd = headEndIndex(msgs);
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

  const dropped = [];
  for (let i = headEnd; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === "system" && isEmptyContent(msgs[i].content)) {
      dropped.push(i);
      msgs.splice(i, 1);
    }
  }
  const text = moved.map((m) => m.text).join("\n");
  const appendedTo = appendToLastUser(msgs, text);
  if (appendedTo === -1) msgs.push({ role: "system", content: text });
  return { moved: moved, appendedTo: appendedTo, dropped: dropped };
}

// 逐条消息哈希 —— 自适应比对的原料
function messageHashes(msgs) {
  return msgs.map((m) =>
    h((m && m.role ? m.role : "?") + "|" + JSON.stringify(m && m.content))
  );
}

function longestCommonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// 描述一条消息的形态 (只记结构与体积, 不记正文)
function describeMessage(m) {
  const d = { role: (m && m.role) || "?", chars: 0, blocks: [], has_image: false };
  if (!m) return d;
  const c = m.content;
  d.chars = JSON.stringify(c === undefined ? "" : c).length;
  if (typeof c === "string") {
    d.blocks.push("text");
  } else if (Array.isArray(c)) {
    for (const b of c) {
      const t = b && b.type ? b.type : "?";
      d.blocks.push(t);
      if (/image|video|audio|file/i.test(t)) d.has_image = true;
      // 记录媒体块的引用形态: 远程链接还是内联 base64
      if (b && b.image_url && typeof b.image_url.url === "string") {
        d.media_ref = b.image_url.url.startsWith("data:") ? "inline_base64" : "remote_url";
        d.media_chars = b.image_url.url.length;
      }
    }
  }
  if (m.tool_calls) d.blocks.push("tool_calls");
  return d;
}

// 和最近的请求比对, 返回稳定长度 + 最佳匹配的那次记录 (用于定位断点)
function learnedStable(hashes) {
  const now = Date.now();
  let best = 0;
  let bestEntry = null;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (now - recent[i].t > RECENT_TTL_MS) {
      recent.splice(i, 1);
      continue;
    }
    const l = longestCommonPrefix(hashes, recent[i].hashes);
    if (l > best || bestEntry === null) {
      best = Math.max(best, l);
      if (l >= best) bestEntry = recent[i];
    }
  }
  return { len: best, entry: bestEntry };
}

function learnedStableLen(hashes) {
  return learnedStable(hashes).len;
}

function remember(hashes, descs) {
  recent.push({ hashes: hashes, descs: descs || null, t: Date.now() });
  while (recent.length > RECENT_MAX) recent.shift();
}

// v9 锚点: 头部 system 段 + "已证实稳定"的边界 (绝不越界写入)
function chooseAnchors(msgs, stableLen) {
  const anchors = [];
  const headEnd = headEndIndex(msgs);
  if (headEnd >= 0) anchors.push(headEnd);

  if (DISABLE_LCP) {
    // 回退: v8 的固定规则
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

  // 稳定边界的最后一条消息下标
  const stableIdx = stableLen - 1;
  if (stableIdx > headEnd) anchors.push(stableIdx);
  return anchors;
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
      res.end(
        JSON.stringify({
          version: VERSION,
          adaptive: !DISABLE_LCP,
          time_strip: !DISABLE_TIME_STRIP,
          remembered_requests: recent.length,
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
        const msgs = Array.isArray(data.messages) ? data.messages : [];

        // 1) 时间搬迁
        const shift = DISABLE_TIME_STRIP
          ? { moved: [], appendedTo: -1, dropped: [] }
          : timeShift(msgs);

        // 2) 观察: 这次和最近的请求稳定到哪, 以及链条从哪一条断的
        const hashes = messageHashes(msgs);
        const descs = msgs.map(describeMessage);
        const learned = learnedStable(hashes);
        const stableLen = learned.len;

        // 断点诊断: 第一条和上次对不上的消息长什么样
        let diverge = null;
        if (learned.entry && stableLen < msgs.length) {
          const i = stableLen;
          const prevDescs = learned.entry.descs;
          diverge = {
            at: i,
            now: descs[i] || null,
            prev: prevDescs && prevDescs[i] ? prevDescs[i] : null,
            prev_msg_count: learned.entry.hashes.length,
            // 同一位置、同样形态却哈希不同 => 内容每轮在变 (最可疑)
            same_shape_diff_bytes:
              !!(prevDescs && prevDescs[i] &&
                 prevDescs[i].role === (descs[i] && descs[i].role) &&
                 prevDescs[i].chars === (descs[i] && descs[i].chars)),
          };
        }
        // 这次请求里第一张图片在第几条
        const firstMedia = descs.findIndex((d) => d.has_image);

        remember(hashes, descs);

        // 3) 定锚
        const anchors = chooseAnchors(msgs, stableLen);

        const toolsStr = JSON.stringify(data.tools || null);
        const prefixHashes = anchors.map((i) => ({
          at: i,
          hash: h(toolsStr + "|" + JSON.stringify(msgs.slice(0, i + 1))),
        }));

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
            adaptive: {
              msg_count: msgs.length,
              stable_len: stableLen, // 已证实稳定到第几条
              head_end: headEndIndex(msgs),
              anchors: anchors, // 书签落点
              compared_against: recent.length - 1,
              first_media_at: firstMedia, // 第一张图片在第几条 (-1 = 无)
              diverge: diverge, // 链条从哪一条断的
            },
            time_shift: {
              moved_count: shift.moved.length,
              kinds: shift.moved.map((m) => m.kind),
              appended_to_msg: shift.appendedTo,
              text: DEBUG_SHOW_MOVED ? shift.moved.map((m) => m.text) : undefined,
            },
            preexisting_cc: pre.length,
            injected_cc: injected,
            prefix_hashes: prefixHashes,
            tools_hash: h(toolsStr),
            total_body_chars: body.length,
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
      `openrouter 1h-cache proxy ${VERSION} listening on :${PORT} (adaptive=${!DISABLE_LCP}, time_strip=${!DISABLE_TIME_STRIP})`
    );
  });
}

module.exports = {
  timeShift,
  splitVolatile,
  chooseAnchors,
  messageHashes,
  learnedStableLen,
  learnedStable,
  describeMessage,
  remember,
  headEndIndex,
  h,
};
