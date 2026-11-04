#!/usr/bin/env node
/* _dashboard/news/fetch.mjs — 看板「今天 AI 圈」资讯卡的数据脚本（方案-v1 §13）
   每天 8:30 由 launchd 跑一次；看板的刷新按钮也调它。
   ① 抓（只在内存里）：YouTube 9 个频道页 + 新视频的视频页；follow-builders 的 X / 播客 JSON；Hacker News 首页 AI 帖 + 评论
   ② 复用：上一份 today.json 里已经总结过的条目直接沿用，只把新条目交给模型
   ③ 总结：claude -p 一次调用，按 JSON Schema 返回
   ④ 写：只写 ~/.secondbrain-news/ 下的 today.json / topics.json / run.log（运行中多一个 run.lock），总量封顶 200KB
   参数：--cap=字节（临时改上限，测试用）  --force（不复用，全部重新总结）  --no-llm（只抓不总结，调试用）
   环境变量：SB_NEWS_DIR（数据目录，测试时指到别处）、SB_CLAUDE（claude 可执行文件路径） */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const DIR = process.env.SB_NEWS_DIR || path.join(HOME, ".secondbrain-news");
const VAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARGS = new Set(process.argv.slice(2).filter(a => !a.includes("=")));
const ARGV = Object.fromEntries(process.argv.slice(2).filter(a => a.includes("=")).map(a => a.replace(/^--/, "").split("=")));
const CAP = +(ARGV.cap || 200 * 1024);

const CHANNELS = [
  { handle: "rileybrownai", name: "Riley Brown" },
  { handle: "nateherk", name: "Nate Herk" },
  { handle: "mattpocockuk", name: "Matt Pocock" },
  { handle: "TinaHuang1", name: "Tina Huang" },
  { handle: "GregIsenberg", name: "Greg Isenberg" },
  { handle: "马克的技术工作坊", name: "马克的技术工作坊" },
  { handle: "tech-shrimp", name: "技术爬爬虾" },
  { handle: "qiuzhi2046", name: "秋芝2046" },
  { handle: "SiliconValleyGirl", name: "Silicon Valley Girl" },
];
const FB = "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main";
const HN_FRONT = "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=60";
const HN_ITEM = id => `https://hn.algolia.com/api/v1/items/${id}`;
// 个人设置（学习计划路径等）和看板共用 _dashboard/config.json；读者介绍在本目录 persona.md。两个都只留在本机，不进公开仓库
const CONFIG = (() => { try { return JSON.parse(fs.readFileSync(path.join(VAULT, "_dashboard/config.json"), "utf8")); } catch { return {}; } })();
const PLAN = CONFIG.planPath ? path.join(VAULT, CONFIG.planPath) : "";

const LIMIT = { ytWindowH: 168, yt: 20, hn: 5, hnCandidates: 8, xTopics: 5, pods: 6, headlines: 5, topicDays: 30, logLines: 200 };
const LOG_BUDGET = Math.min(20 * 1024, Math.floor(CAP / 10)); // 日志最多占上限的十分之一
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ---------- 小工具 ----------
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const NOW = new Date(), TODAY = ymd(NOW);
const cut = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const LOG = [];
const log = (...a) => { const l = `[${new Date().toTimeString().slice(0, 8)}] ${a.join(" ")}`; LOG.push(l); console.error(l); };
const readJSON = (f, dflt) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch { return dflt; } };
// 先写临时文件再改名，看板读的时候不会读到写了一半的文件
const writeJSON = (f, obj) => { const p = path.join(DIR, f), tmp = p + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, p); };

async function get(url, as = "text") {
  const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return as === "json" ? r.json() : r.text();
}
// 同时最多跑 n 个
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all([...Array(Math.min(n, items.length))].map(async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------- 抓 YouTube ----------
const jsonAfter = (html, marker) => {
  const i = html.indexOf(marker); if (i < 0) return null;
  const s = html.indexOf("{", i); let depth = 0, inStr = false, esc = false;
  for (let k = s; k < html.length; k++) {
    const c = html[k];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) return JSON.parse(html.slice(s, k + 1));
  }
  return null;
};
// "15 thousand views" / "1.2 million views" / "15K views" / "1,234 views" → 数字
function parseViews(s) {
  if (!s) return null; s = String(s).toLowerCase().replace(/,/g, "");
  if (/no views/.test(s)) return 0;
  const m = s.match(/([\d.]+)\s*(thousand|million|billion|k|m|b)?/); if (!m) return null;
  const mul = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, b: 1e9 }[m[2]] || 1;
  return Math.round(parseFloat(m[1]) * mul);
}
// "10 hours ago" / "Streamed 2 days ago" → 小时
function parseAgoH(s) {
  const m = String(s || "").toLowerCase().match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/); if (!m) return null;
  return +m[1] * { second: 1 / 3600, minute: 1 / 60, hour: 1, day: 24, week: 168, month: 720, year: 8760 }[m[2]];
}
function parseChannel(html) {
  const d = jsonAfter(html, "var ytInitialData"); if (!d) throw new Error("页面里没有 ytInitialData（YouTube 可能改版了）");
  const vids = [];
  const walk = o => {
    if (!o || typeof o !== "object") return;
    if (o.lockupViewModel && o.lockupViewModel.contentId) {
      const l = o.lockupViewModel, s = JSON.stringify(l), md = l.metadata?.lockupMetadataViewModel;
      const labels = [...s.matchAll(/"accessibilityLabel":"([^"]*)"/g)].map(m => m[1]);
      vids.push({ id: l.contentId, title: md?.title?.content || "", views: parseViews(labels.find(x => /views?$/.test(x))), agoH: parseAgoH(labels.find(x => /ago$/.test(x))), duration: (s.match(/"text":"(\d{1,2}:\d{2}(?::\d{2})?)"/) || [])[1] || "" });
      return;
    }
    if (o.videoRenderer && o.videoRenderer.videoId) {
      const v = o.videoRenderer;
      vids.push({ id: v.videoId, title: v.title?.runs?.[0]?.text || "", views: parseViews(v.viewCountText?.simpleText), agoH: parseAgoH(v.publishedTimeText?.simpleText), duration: v.lengthText?.simpleText || "" });
      return;
    }
    for (const k in o) walk(o[k]);
  };
  walk(d.contents || d);
  const seen = new Set();
  return vids.filter(v => v.id && !seen.has(v.id) && seen.add(v.id));
}
const median = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

async function fetchYouTube(prev) {
  const prevById = new Map((prev.youtube || []).map(v => [v.id, v]));
  const errors = [], out = [];
  await pool(CHANNELS, 3, async ch => {
    try {
      const url = `https://www.youtube.com/@${encodeURIComponent(ch.handle)}/videos`;
      // 偶尔会拿到一个没有数据的页面，隔 2 秒再试一次
      let vids; try { vids = parseChannel(await get(url)); } catch (e) { log("YouTube 重试", ch.name, e.message); await new Promise(r => setTimeout(r, 2000)); vids = parseChannel(await get(url)); }
      if (!vids.length) throw new Error("频道页没解析出视频");
      // 「爆」的基准：这个频道最近 15 条里发布满 1 天的那些的播放量中位数
      const base = median(vids.slice(0, 15).filter(v => v.agoH != null && v.agoH >= 24).map(v => v.views));
      for (const v of vids.filter(v => v.agoH != null && v.agoH <= LIMIT.ytWindowH)) {
        const hot = base && v.views != null ? (v.agoH >= 24 ? v.views >= 2 * base : v.views >= base) : false;
        out.push({ ...v, channel: ch.name, handle: ch.handle, median: base, hot, url: `https://www.youtube.com/watch?v=${v.id}`, thumb: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, published: new Date(NOW - v.agoH * 3600e3).toISOString() });
      }
      log("YouTube", ch.name, `${vids.length} 条，7 天内 ${vids.filter(v => v.agoH != null && v.agoH <= LIMIT.ytWindowH).length} 条，中位数 ${base}`);
    } catch (e) { errors.push(`${ch.name}: ${e.message}`); log("YouTube 失败", ch.name, e.message); }
  });
  out.sort((a, b) => a.agoH - b.agoH);
  const list = out.slice(0, LIMIT.yt);
  // 新视频（上一份里没有总结的）读视频页拿简介、章节、准确发布时间
  await pool(list.filter(v => !(prevById.get(v.id) || {}).gist), 3, async v => {
    try {
      const html = await get(v.url);
      // 不登录时播放器数据常被拦成「请登录确认你不是机器人」，简介改从页面数据 ytInitialData 里取（带章节）
      const str = re => { const m = html.match(re); try { return m ? JSON.parse(`"${m[1]}"`) : ""; } catch { return ""; } };
      v.desc = cut(str(/"attributedDescription":\{"content":"((?:[^"\\]|\\.)*)"/) || str(/"shortDescription":"((?:[^"\\]|\\.)*)"/), 1500);
      const dt = Date.parse(str(/"dateText":\{"simpleText":"((?:[^"\\]|\\.)*)"/));
      if (!Number.isNaN(dt)) v.published = new Date(dt).toISOString();
      if (!v.desc) log("视频页没有简介", v.id);
    } catch (e) { log("视频页失败", v.id, e.message); }
  });
  for (const v of list) { const o = prevById.get(v.id); if (o && o.gist && !ARGS.has("--force")) Object.assign(v, pick(o, ["title_zh", "gist", "angle", "xhs", "learn", "published"]), { old: true }); }
  return { list, ok: CHANNELS.length - errors.length, total: CHANNELS.length, errors };
}
const pick = (o, ks) => Object.fromEntries(ks.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

// ---------- 抓 X / 播客（follow-builders 公共数据，每天由它的 GitHub Actions 生成） ----------
async function fetchFollowBuilders(prev) {
  const r = { x: null, pods: null, errors: [] };
  try {
    const fx = await get(`${FB}/feed-x.json`, "json");
    const tweets = (fx.x || []).flatMap(b => (b.tweets || []).map(t => ({ id: String(t.id), handle: b.handle, name: b.name, text: cut(t.text, 600), url: t.url, likes: t.likes || 0, at: t.createdAt })));
    const same = prev.x && prev.x.generatedAt === fx.generatedAt && (prev.x.topics || []).length && !ARGS.has("--force");
    r.x = { generatedAt: fx.generatedAt, tweets, reuse: same ? prev.x.topics : null };
    log("X", `${tweets.length} 条推文，数据生成于 ${fx.generatedAt}${same ? "（和上次相同，沿用话题）" : ""}`);
  } catch (e) { r.errors.push(`X: ${e.message}`); log("X 失败", e.message); }
  try {
    const fp = await get(`${FB}/feed-podcasts.json`, "json");
    const prevBy = new Map((prev.podcasts || []).map(p => [p.guid, p]));
    r.pods = (fp.podcasts || []).slice(0, LIMIT.pods).map(p => {
      const o = prevBy.get(p.guid);
      const base = { guid: p.guid, name: p.name, title: p.title, url: p.url, published: p.publishedAt };
      return o && o.gist && !ARGS.has("--force") ? { ...base, ...pick(o, ["title_zh", "gist", "learn"]), old: true } : { ...base, transcript: cut(p.transcript, 5000) };
    });
    log("播客", `${r.pods.length} 期`);
  } catch (e) { r.errors.push(`播客: ${e.message}`); log("播客失败", e.message); }
  return r;
}

// ---------- 抓 Hacker News（首页里和 AI 相关的帖子 + 热门评论） ----------
const AI_RE = /\b(ai|a\.i\.|llms?|gpt[-\w.]*|chatgpt|openai|anthropic|claude|gemini|deepmind|mistral|llama|qwen|deepseek|grok|copilot|cursor|agents?|agentic|mcp|rag|transformers?|diffusion|inference|fine-?tun\w*|embeddings?|neural|machine learning|ml|model|models|tokens?|prompt\w*|vibe cod\w*|codex|hugging ?face|nvidia|gpu|tpu)\b/i;
const unhtml = s => String(s || "").replace(/<p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&#x2F;/g, "/");
async function fetchHN(prev) {
  try {
    const j = await get(HN_FRONT, "json");
    const hits = (j.hits || []).filter(h => AI_RE.test(`${h.title} ${h.url || ""}`)).sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, LIMIT.hnCandidates);
    const prevBy = new Map((prev.hn || []).map(h => [h.id, h]));
    const list = hits.map(h => ({ id: h.objectID, title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, hnUrl: `https://news.ycombinator.com/item?id=${h.objectID}`, points: h.points || 0, comments: h.num_comments || 0, at: h.created_at }));
    await pool(list, 3, async h => {
      const o = prevBy.get(h.id);
      if (o && o.what && !ARGS.has("--force")) { Object.assign(h, pick(o, ["title_zh", "what", "engineer", "debate", "xhs", "learn", "skip"]), { old: true }); return; }
      try {
        const it = await get(HN_ITEM(h.id), "json");
        h.text = cut(unhtml(it.text), 800);
        h.top = (it.children || []).filter(c => c.text).slice(0, 12).map(c => cut(unhtml(c.text), 350));
      } catch (e) { log("HN 评论失败", h.id, e.message); h.top = []; }
    });
    log("HN", `首页 ${(j.hits || []).length} 帖，AI 相关候选 ${list.length} 帖`);
    return { list, ok: true };
  } catch (e) { log("HN 失败", e.message); return { list: [], ok: false, error: e.message }; }
}

// ---------- 读者背景（给模型判断「能不能做成选题」「值不值得学」） ----------
function studyNow() {
  try {
    if (!PLAN) return "";
    const L = fs.readFileSync(PLAN, "utf8").split("\n");
    const i = L.findIndex(l => /^\s*[-*+]\s+\[ \]/.test(l)); if (i < 0) return "";
    let h2 = "", bold = "";
    for (let k = i; k >= 0; k--) { if (!bold) { const m = L[k].match(/^\s*\*\*(.+?)\*\*/); if (m) bold = m[1]; } const m2 = L[k].match(/^##\s+(.+)/); if (m2) { h2 = m2[1]; break; } }
    return `${h2}${bold ? " · " + bold : ""}；下一条要做：${cut(L[i].replace(/^\s*[-*+]\s+\[ \]\s*/, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"), 120)}`;
  } catch { return ""; }
}
const DEFAULT_PERSONA = `读者是一位 AI 工程师，同时做 AI 科技内容。读资讯有三个目的：①掌握 AI 圈全市场动向；②作为工程师学习新的技术方案；③找能做成视频的选题。
判断 xhs 时：这条能不能做成一期面向普通人的 AI 视频。
判断 learn 时：对一个正在补 agent、LLM 应用工程基础的工程师，这条有没有能学到的具体技术方案或做法。`;
const PERSONA = (() => { try { return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "persona.md"), "utf8").trim(); } catch { return DEFAULT_PERSONA; } })();

// ---------- 交给 claude -p 总结 ----------
const S = { type: "string" }, B = { type: "boolean" };
const obj = (props, req) => ({ type: "object", properties: props, required: req || Object.keys(props), additionalProperties: false });
const SCHEMA = obj({
  headlines: { type: "array", items: obj({ key: S, title: S, summary: S, refs: { type: "array", items: S }, xhs: B, learn: B }) },
  youtube: { type: "array", items: obj({ id: S, title_zh: S, gist: S, angle: S, xhs: B, learn: B }) },
  x_topics: { type: "array", items: obj({ key: S, title: S, summary: S, who: { type: "array", items: S }, tweet_ids: { type: "array", items: S }, xhs: B, learn: B }) },
  podcasts: { type: "array", items: obj({ guid: S, title_zh: S, gist: S, learn: B }) },
  hn: { type: "array", items: obj({ id: S, title_zh: S, what: S, engineer: S, debate: S, xhs: B, learn: B, skip: B }) },
});

function buildPrompt(yt, fb, hn, topics) {
  const known = Object.entries(topics).map(([k, t]) => `${k} = ${t.label}`).join("\n") || "（还没有）";
  const input = {
    youtube: yt.map(v => v.old ? { id: v.id, old: true, channel: v.channel, title: v.title, title_zh: v.title_zh, gist: v.gist } : { id: v.id, channel: v.channel, title: v.title, hours_ago: Math.round(v.agoH), views: v.views, channel_median_views: v.median, description: v.desc || "" }),
    x: fb.x ? (fb.x.reuse ? { reuse: true, topics: fb.x.reuse.map(t => ({ key: t.key, title: t.title, summary: t.summary })) } : { tweets: fb.x.tweets.map(t => ({ id: t.id, who: t.handle, text: t.text, likes: t.likes })) }) : null,
    podcasts: (fb.pods || []).map(p => p.old ? { guid: p.guid, old: true, name: p.name, title: p.title, gist: p.gist } : { guid: p.guid, name: p.name, title: p.title, transcript_head: p.transcript }),
    hn: hn.map(h => h.old ? { id: h.id, old: true, title: h.title, what: h.what, skip: h.skip } : { id: h.id, title: h.title, url: h.url, points: h.points, comments: h.comments, text: h.text || "", top_comments: h.top || [] }),
  };
  return `${PERSONA}
读者当前的学习进度：${studyNow() || "（没读到）"}

下面是今天抓到的 AI 资讯（JSON）。标了 old:true 的条目昨天已经总结过，不要再输出它们的总结，但要把它们算进要闻。x 如果是 reuse:true，x_topics 输出空数组。

要输出：
1. headlines：今天 AI 圈最值得知道的 3–5 件事。把 YouTube / X / 播客 / HN 里讲同一件事的条目合并成一条，按「有几个来源在聊」和重要性排序。refs 列出相关条目，格式 "yt:视频id" / "x:推特账号" / "hn:帖子id" / "pod:guid"。title 是中文一句话标题（≤24 字），summary 说清楚发生了什么、为什么重要（≤80 字）。
2. youtube：只给没有 old 的视频，每条一个。title_zh 是标题的中文意译（≤30 字，不要直译腔）；gist 讲这期视频具体讲了什么（≤70 字，从简介和章节里提炼，说具体的东西，不要「介绍了一些新功能」这种空话）；xhs 为 true 时 angle 写读者可以怎么做成自己的视频（≤60 字，落到读者的偏好上），否则 angle 为空字符串。
3. x_topics：把推文按话题归纳成 3–5 个（只归纳有信息量的，闲聊和转发不算）。title ≤20 字，summary ≤80 字说清楚大家在说什么、谁持什么观点，who 是相关账号，tweet_ids 是最能代表的 1–3 条推文 id。
4. podcasts：只给没有 old 的，title_zh ≤30 字，gist ≤80 字。
5. hn：只给没有 old 的帖子。title_zh ≤30 字；what 是这是什么（≤60 字）；engineer 是工程师角度的要点，具体到方案、做法或数字（≤80 字）；debate 是评论区在争什么、主流看法是什么（≤80 字，没有评论就写空字符串）；如果其实和 AI 无关（关键词误判），skip 为 true。
key：每个要闻和 X 话题给一个英文短横线连接的话题 key（如 claude-duet、openai-usage-limits）。下面是近 30 天出现过的话题，同一件事必须复用同一个 key：
${known}

所有中文用直白口语，不用「赋能、闭环、抓手、颗粒度、底层逻辑」这类词。不确定的事不要编。

资讯：
${JSON.stringify(input)}`;
}

function findClaude() {
  const c = [process.env.SB_CLAUDE, path.join(HOME, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].filter(Boolean);
  return c.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
}
function runClaude(prompt) {
  const bin = findClaude(); if (!bin) throw new Error("找不到 claude 命令");
  return new Promise((resolve, reject) => {
    // 不存对话记录、不给任何工具、不加载设置里的钩子和插件；在数据目录里跑，不读 vault 的 CLAUDE.md
    // --strict-mcp-config：不连 claude.ai 账号里配的连接器，否则每次运行都会在 ~/Library/Caches/claude-cli-nodejs/ 多留两份连接日志
    const args = ["-p", "--model", "sonnet", "--no-session-persistence", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA),
      "--system-prompt", "你是一个 AI 资讯编辑，只按要求输出符合 JSON Schema 的结果。"];
    const p = spawn(bin, args, { cwd: DIR, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGTERM"); reject(new Error("claude 超过 8 分钟没返回")); }, 8 * 60e3);
    p.stdout.on("data", d => out += d); p.stderr.on("data", d => err += d);
    p.on("error", e => { clearTimeout(timer); reject(e); });
    p.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude 退出码 ${code}：${cut(err || out, 300)}`));
      try {
        const env = JSON.parse(out);
        if (env.is_error) return reject(new Error(`claude 报错：${cut(env.result, 300)}`));
        const r = env.structured_output || JSON.parse(String(env.result).replace(/^```json\s*|\s*```$/g, ""));
        resolve({ r, cost: env.total_cost_usd, ms: env.duration_ms });
      } catch (e) { reject(new Error(`claude 返回的不是合法 JSON：${e.message}`)); }
    });
    p.stdin.end(prompt);
  });
}

// ---------- 合并、截断、写盘 ----------
function countRefs(refs) {
  const c = { yt: new Set(), x: new Set(), hn: new Set(), pod: new Set() };
  for (const r of refs || []) { const m = String(r).match(/^(yt|x|hn|pod):(.+)$/); if (m) c[m[1]].add(m[2].replace(/^@/, "").toLowerCase()); }
  return { yt: c.yt.size, x: c.x.size, hn: c.hn.size, pod: c.pod.size };
}
function folderSize(skipLog) { return fs.readdirSync(DIR).filter(f => !(skipLog && f === "run.log")).reduce((a, f) => { try { const s = fs.statSync(path.join(DIR, f)); return a + (s.isFile() ? s.size : 0); } catch { return a; } }, 0); }
// 超过上限：先删最旧的话题，再从末尾砍 YouTube / HN 条目，直到降到上限以下（日志单独限在 LOG_BUDGET 里，这里给它留出位置）
function enforceCap(today, topics) {
  const limit = CAP - LOG_BUDGET;
  let size = folderSize(true);
  if (size <= limit) return size;
  log(`警告：数据 ${size} 字节，超过上限 ${limit}（总上限 ${CAP} 减去日志预留 ${LOG_BUDGET}），开始删旧数据`);
  const keys = Object.keys(topics).sort((a, b) => (topics[a].last || "").localeCompare(topics[b].last || ""));
  while (size > limit && keys.length) { delete topics[keys.shift()]; writeJSON("topics.json", topics); size = folderSize(true); }
  while (size > limit && (today.youtube.length || today.hn.length || today.headlines.length || today.podcasts.length || today.x.topics.length)) {
    if (today.youtube.length) today.youtube.pop(); else if (today.hn.length) today.hn.pop(); else if (today.podcasts.length) today.podcasts.pop(); else if (today.x.topics.length) today.x.topics.pop(); else today.headlines.pop();
    writeJSON("today.json", today); size = folderSize(true);
  }
  log(`删完 ${size} 字节`);
  return size;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  // 同一时间只跑一个（定时任务和看板的刷新按钮可能撞上）；锁超过 15 分钟当作上次异常退出
  const lock = path.join(DIR, "run.lock");
  try { const st = fs.statSync(lock); if (Date.now() - st.mtimeMs < 15 * 60e3) { console.error("已经有一个在跑，退出"); process.exit(0); } } catch { /* 没有锁 */ }
  fs.writeFileSync(lock, String(process.pid));
  const t0 = Date.now();
  const prev = readJSON("today.json", {});
  const topics = readJSON("topics.json", {});
  let today;
  try {
    log(`开始；数据目录 ${DIR}，上限 ${CAP} 字节`);
    const [yt, fb, hn] = await Promise.all([fetchYouTube(prev), fetchFollowBuilders(prev), fetchHN(prev)]);
    if (!yt.list.length && !fb.x && !hn.list.length && yt.ok === 0) throw new Error("所有来源都没抓到（可能断网了）");
    const xNew = fb.x && !fb.x.reuse;
    const needLLM = yt.list.some(v => !v.old) || xNew || (fb.pods || []).some(p => !p.old) || hn.list.some(h => !h.old) || !(prev.headlines || []).length || ARGS.has("--force");
    let r = null, llm = null;
    if (needLLM && !ARGS.has("--no-llm")) {
      const prompt = buildPrompt(yt.list, fb, hn.list, topics);
      log(`交给 claude 总结：提示词 ${prompt.length} 字`);
      llm = await runClaude(prompt);
      r = llm.r;
      log(`claude 完成：${Math.round(llm.ms / 1000)} 秒，按官方价折合 $${(llm.cost || 0).toFixed(3)}（订阅内，不另收费）`);
    } else log(needLLM ? "跳过总结（--no-llm）" : "没有新内容，沿用上次的总结");

    // 合并：新总结覆盖到条目上，截断每段字数
    const ytBy = new Map((r?.youtube || []).map(x => [x.id, x]));
    const youtube = yt.list.map(v => {
      const s = ytBy.get(v.id) || {};
      const o = { id: v.id, channel: v.channel, title: cut(v.title, 140), url: v.url, thumb: v.thumb, published: v.published, agoH: Math.round(v.agoH), views: v.views, median: v.median, hot: v.hot, duration: v.duration };
      const t = v.old ? v : s;
      return { ...o, title_zh: cut(t.title_zh, 48), gist: cut(t.gist, 140), angle: cut(t.angle, 100), xhs: !!t.xhs, learn: !!t.learn };
    });
    const tweetBy = new Map((fb.x?.tweets || []).map(t => [t.id, t]));
    const xTopics = (fb.x?.reuse || (!fb.x ? prev.x?.topics || [] : (r?.x_topics || []).map(t => ({
      key: cut(t.key, 60), title: cut(t.title, 30), summary: cut(t.summary, 120), who: (t.who || []).slice(0, 6).map(w => String(w).replace(/^@/, "")), xhs: !!t.xhs, learn: !!t.learn,
      links: (t.tweet_ids || []).slice(0, 3).map(id => tweetBy.get(String(id))).filter(Boolean).map(tw => ({ handle: tw.handle, url: tw.url })),
    })))).slice(0, LIMIT.xTopics);
    const podBy = new Map((r?.podcasts || []).map(p => [p.guid, p]));
    const podcasts = (fb.pods || (prev.podcasts || []).map(p => ({ ...p, old: true }))).map(p => { const t = p.old ? p : (podBy.get(p.guid) || {}); return { guid: p.guid, name: p.name, title: cut(p.title, 140), url: p.url, published: p.published, title_zh: cut(t.title_zh, 40), gist: cut(t.gist, 120), learn: !!t.learn }; });
    const hnBy = new Map((r?.hn || []).map(h => [h.id, h]));
    const hnList = hn.list.map(h => { const t = h.old ? h : (hnBy.get(h.id) || {}); return { id: h.id, title: cut(h.title, 140), url: h.url, hnUrl: h.hnUrl, points: h.points, comments: h.comments, title_zh: cut(t.title_zh, 40), what: cut(t.what, 90), engineer: cut(t.engineer, 120), debate: cut(t.debate, 120), xhs: !!t.xhs, learn: !!t.learn, skip: !!t.skip }; })
      .filter(h => !h.skip).slice(0, LIMIT.hn);

    const heads = (r ? r.headlines : prev.headlines || []).slice(0, LIMIT.headlines).map(h => ({
      key: cut(h.key, 60), title: cut(h.title, 40), summary: cut(h.summary, 130), refs: (h.refs || []).slice(0, 12), count: h.count || countRefs(h.refs), xhs: !!h.xhs, learn: !!h.learn,
      new: r ? !topics[h.key] || topics[h.key].first === TODAY : !!h.new,
    }));
    // 话题表：记首次 / 最近出现日期，30 天没再出现的删掉，每天最多新记 15 个
    let added = 0;
    for (const t of [...heads, ...(fb.x && !fb.x.reuse ? xTopics : [])]) {
      if (!t.key) continue;
      if (topics[t.key]) topics[t.key].last = TODAY;
      else if (added++ < 15) topics[t.key] = { label: t.title, first: TODAY, last: TODAY };
    }
    const cutoff = ymd(new Date(NOW - LIMIT.topicDays * 864e5));
    for (const k of Object.keys(topics)) if ((topics[k].last || "") < cutoff) delete topics[k];

    today = {
      v: 1, date: TODAY, generatedAt: new Date().toISOString(),
      sources: { youtube: { ok: yt.ok, total: yt.total, errors: yt.errors.slice(0, 9) }, x: { ok: !!fb.x, generatedAt: fb.x?.generatedAt || prev.x?.generatedAt || null }, hn: { ok: hn.ok }, errors: fb.errors },
      headlines: heads, youtube, x: { generatedAt: fb.x?.generatedAt || null, topics: xTopics }, podcasts, hn: hnList,
      llm: llm ? { seconds: Math.round(llm.ms / 1000), cost: llm.cost } : prev.llm || null,
    };
    writeJSON("topics.json", topics);
    writeJSON("today.json", today);
    const size = enforceCap(today, topics);
    log(`完成：要闻 ${heads.length}，YouTube ${youtube.length}，X 话题 ${xTopics.length}，播客 ${podcasts.length}，HN ${hnList.length}；文件夹 ${size} 字节；用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  } catch (e) {
    log("失败：", e.message);
    // 保留上一份内容，只记下这次失败，看板据此提示
    if (prev && prev.date) { prev.lastError = { at: new Date().toISOString(), message: cut(e.message, 200) }; writeJSON("today.json", prev); }
    else writeJSON("today.json", { v: 1, date: null, lastError: { at: new Date().toISOString(), message: cut(e.message, 200) }, headlines: [], youtube: [], x: { topics: [] }, podcasts: [], hn: [] });
    process.exitCode = 1;
  } finally {
    // 日志只留最后 200 行，并且不超过 LOG_BUDGET 字节
    const old = (() => { try { return fs.readFileSync(path.join(DIR, "run.log"), "utf8").split("\n").filter(Boolean); } catch { return []; } })();
    let lines = [...old, `—— ${new Date().toISOString()}`, ...LOG].slice(-LIMIT.logLines);
    while (lines.length > 1 && Buffer.byteLength(lines.join("\n") + "\n") > LOG_BUDGET) lines.shift();
    fs.writeFileSync(path.join(DIR, "run.log"), lines.join("\n") + "\n");
    try { fs.unlinkSync(lock); } catch { /* 已经没了 */ }
  }
}

main();
