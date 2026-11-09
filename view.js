/* _dashboard/view.js — SecondBrain 看板 v1
   由根目录 Dashboard.md 的 dataviewjs 块调用：await dv.view("_dashboard")
   dv = Dataview 行内 API；input.raw 为 true 时只打印数据（见 debug.md）。
   分三层：collect*（取数）→ render*（拼 HTML）→ bind（点击、打勾、记一笔、新建）。 */

// 下面的路径是缺省值；自己 vault 的真实路径写在同目录的 config.json（不进公开仓库，格式见 config.example.json）
const V = {
  dailyDir: "daily",
  weeklyDir: "weekly",
  planPath: "learning/plan.md",
  xhsDir: "xiaohongshu",
  todoPath: "To-do & inspiration.md",
  dailyTemplate: "templates/daily.md",
  weeklyTemplate: "templates/weekly.md",
  fontDir: "_dashboard/fonts",
  finishedDays: 30,
  ideasMax: 4,
  narrowBelow: 760,
  news: true, // 资讯卡要用 dsh 的 headless 一次性任务做总结；用不上就在 config.json 里写 "news": false，整张卡和后台抓取都关掉
  row3: 640, // 第三行（资讯卡 + 番茄钟）的高度；前两行仍然撑满一屏，第三行往下滚才看到
};
// [A 方案适配] 演示文件不一定在 vault 根：所有相对路径都相对「入口 md 所在目录」解析。
// 前缀来源优先级：config.json 的 base（显式、最稳）> 从 dv.current() 自动推导 > 空（vault 根即看板所在目录）。
// 例如 vault 根是 MyVault、看板在 Projects/demo-vault/ 下时，base 就是 "Projects/demo-vault"。
let BOARD_DIR = "";
try {
  const cp = dv.current()?.file?.path || "";
  const i = cp.lastIndexOf("/");
  if (i >= 0) BOARD_DIR = cp.slice(0, i + 1);
} catch (e) { /* 忽略 */ }
// 先读一次 config（此时用推导出的前缀），拿到 base 后覆盖，再重新按最终前缀读一次
const readCfg = async () => {
  try { return JSON.parse(await app.vault.adapter.read(BOARD_DIR + "_dashboard/config.json")); } catch (e) { return {}; }
};
let cfg = await readCfg();
if (typeof cfg.base === "string" && cfg.base.length) { BOARD_DIR = cfg.base.replace(/\/?$/, "/"); cfg = await readCfg(); }
const P = rel => BOARD_DIR + String(rel || "").replace(/^\/+/, "");
Object.assign(V, cfg);
const KEYS = ["dailyDir", "weeklyDir", "planPath", "xhsDir", "todoPath", "dailyTemplate", "weeklyTemplate", "fontDir", "newsDir"];
for (const k of KEYS) if (typeof V[k] === "string") V[k] = P(V[k]);
if (V.news === false) V.row3 = 440; // 没有资讯卡，第三行只剩番茄钟，压矮（和 view.css 的 .no-news 对应）
const baseName = p => String(p).split("/").pop().replace(/\.md$/, "");

// ---------- 小工具 ----------
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const MON = addDays(TODAY, -((TODAY.getDay() + 6) % 7));
const SUN = addDays(MON, 6);
const WEEK = [...Array(7)].map((_, i) => addDays(MON, i));
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cut = (s, n) => (s.length > n ? s.slice(0, n).replace(/[，。、：:,.（(\s]+$/, "") + "…" : s);
// 任务文字去掉 markdown 外壳，只留人话
const plain = s => String(s ?? "")
  .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
  .replace(/\[\[([^\]]+)\]\]/g, (m, p) => p.split("/").pop().replace(/#.*$/, ""))
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/\*\*([^*]+)\*\*/g, "$1")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/\s*\[[^\]]*::[^\]]*\]/g, "")
  .replace(/\s+/g, " ")
  .trim();

const tfile = p => app.vault.getAbstractFileByPath(p);
const isFile = f => !!f && typeof f.extension === "string";
const headings = p => (isFile(tfile(p)) && app.metadataCache.getFileCache(tfile(p))?.headings) || [];

// 某个标题管辖的行范围 [start, end)，end 是下一个同级或更高级标题的行
function sectionRange(path, match) {
  const hs = headings(path);
  const i = hs.findIndex(match);
  if (i < 0) return null;
  const start = hs[i].position.start.line;
  const next = hs.slice(i + 1).find(h => h.level <= hs[i].level);
  return { start, end: next ? next.position.start.line : Infinity };
}

// 一个文件里的顶层任务（缩进子项归父项，不单独算）。line 是 0 起的行号。
function tasksOf(path) {
  const page = dv.page(path);
  if (!page || !page.file || !page.file.tasks) return [];
  const arr = typeof page.file.tasks.array === "function" ? page.file.tasks.array() : Array.from(page.file.tasks);
  // 模板里留的空 `- [ ] ` 不算任务
  return arr.filter(t => t.parent == null && String(t.text || "").trim() !== "").map(t => ({
    text: t.text, status: t.status, done: t.status === "x" || t.status === "X", line: t.line, path: t.path,
  }));
}
const under = (items, r) => (r ? items.filter(t => t.line > r.start && t.line < r.end) : items);

// ---------- 取数 ----------
function collectDay(path) {
  if (!isFile(tfile(path))) return { path, exists: false, items: [], total: 0, done: 0 };
  const r = sectionRange(path, h => /^今日/.test(h.heading));
  const items = under(tasksOf(path), r);
  return { path, exists: true, hasSection: !!r, sectionLine: r ? r.start : 0, items, total: items.length, done: items.filter(t => t.done).length };
}

function collectToday() {
  const d = collectDay(`${V.dailyDir}/${ymd(TODAY)}.md`);
  return { ...d, date: ymd(TODAY), weekday: WD[TODAY.getDay()], shown: d.items };
}

// 「随手记」下的文字行（不含任务），给展开层用
async function collectNotes(path) {
  const f = tfile(path); if (!isFile(f)) return [];
  const r = sectionRange(path, h => /^随手记/.test(h.heading)); if (!r) return [];
  const lines = (await app.vault.cachedRead(f)).split("\n");
  return lines.slice(r.start + 1, r.end === Infinity ? undefined : r.end)
    .map(l => l.trim()).filter(l => l && !/^(?:[-*+]|\d+[.)])\s+\[.\]/.test(l) && !/^#/.test(l))
    .map(l => l.replace(/^(?:[-*+]|\d+[.)])\s+/, ""));
}

// 一到日 7 格：full 全勾完 / half 有没勾的 / none 没写当天或没定 / future 还没到
function collectDays() {
  return WEEK.map(d => {
    const key = ymd(d), path = `${V.dailyDir}/${key}.md`;
    if (d > TODAY) return { date: key, state: "future", items: [] };
    const day = collectDay(path);
    if (!day.exists) return { date: key, state: "none", items: [] };
    if (!day.total) return { date: key, state: "none", path, items: [] };
    return { date: key, state: day.done === day.total ? "full" : "half", path, done: day.done, total: day.total, items: day.items };
  });
}

function collectWeek() {
  const path = `${V.weeklyDir}/${ymd(MON)}.md`;
  const range = `${MON.getMonth() + 1}.${MON.getDate()} – ${SUN.getMonth() + 1}.${SUN.getDate()}`;
  const daysLeft = Math.round((SUN - TODAY) / 86400000);
  if (!isFile(tfile(path))) return { path, exists: false, items: [], total: 0, done: 0, range, daysLeft };
  const r = sectionRange(path, h => /^本周要完成/.test(h.heading));
  const all = under(tasksOf(path), r);
  const items = [...all.filter(t => !t.done), ...all.filter(t => t.done)];
  return { path, exists: true, sectionLine: r ? r.start : 0, items, total: all.length, done: all.filter(t => t.done).length, range, daysLeft };
}

async function collectRoute() {
  const path = V.planPath;
  const hs = headings(path).filter(h => h.level === 2);
  const all = tasksOf(path);
  const text = isFile(tfile(path)) ? await app.vault.cachedRead(tfile(path)) : "";
  const lines = text.split("\n");
  const stations = [];
  hs.forEach((h, i) => {
    const m = h.heading.match(/^第\s*(\d+)\s*周(起)?\s*[·・]\s*(.+)$/);
    if (!m) return;
    const start = h.position.start.line;
    const end = hs[i + 1] ? hs[i + 1].position.start.line : Infinity;
    const items = all.filter(t => t.line > start && t.line < end);
    stations.push({
      n: +m[1], label: `第${m[1]}周${m[2] || ""}`, title: m[3].trim(), heading: h.heading, line: start,
      items, total: items.length, done: items.filter(t => t.done).length,
    });
  });
  let cur = stations.findIndex(s => s.done < s.total);
  if (cur < 0) cur = stations.length - 1;
  const total = stations.reduce((a, s) => a + s.total, 0);
  const done = stations.reduce((a, s) => a + s.done, 0);
  const next = cur >= 0 ? stations[cur].items.filter(t => !t.done).slice(0, 3) : [];
  const block = cur >= 0 ? currentBlock(stations[cur], lines, hs) : null;
  // 接下来的站：先是本站后面的块，再是后面几周（只要名字和数量，任务文字在本周卡）
  const upcoming = [...(block && block.after ? block.after : []),
    ...stations.slice(cur + 1).map(s => ({ title: `${s.label.replace(/^第(\d+)周/, "第 $1 周")} · ${s.title}`, line: s.line, done: s.done, total: s.total }))].slice(0, 3);
  return { path, exists: isFile(tfile(path)), stations, cur, total, done, next, block, upcoming };
}

// 当前站里「正在做的那一块」。站内用粗体行（**Stage 1 · 某个主题**、**做**、**读**）分块：
// 第一个还有没勾条目的块是当前块；它是 Stage 就只给这一块；
// 不是 Stage（第 1 周起的 做 / 读 / 背，或第 0 周 Stage 之后的 出口测试 / 做 / 读 / 产出）就把后面同类的块一起给，分组显示。
function currentBlock(st, lines, hs) {
  const end = (() => { const i = hs.findIndex(h => h.position.start.line === st.line); const n = hs[i + 1]; return n ? n.position.start.line : lines.length; })();
  const marks = [];
  for (let i = st.line + 1; i < end; i++) { const m = lines[i].match(/^\s*\*\*(.+?)\*\*\s*(?:[（(].*)?$/); if (m) marks.push({ title: m[1].trim(), line: i }); }
  const blocks = [];
  const bounds = [{ title: "", line: st.line }, ...marks];
  bounds.forEach((b, k) => {
    const to = bounds[k + 1] ? bounds[k + 1].line : end;
    const items = st.items.filter(t => t.line > b.line && t.line < to);
    if (items.length) blocks.push({ title: b.title, line: b.line, items, done: items.filter(t => t.done).length, total: items.length, stage: /^stage\s*\d+/i.test(b.title) });
  });
  const i = blocks.findIndex(b => b.done < b.total);
  if (i < 0) return null;
  const wk = st.label.replace(/^第(\d+)周/, "第 $1 周");
  const after = blocks.slice(i + 1).map(b => ({ title: b.title || st.title, line: b.line, done: b.done, total: b.total }));
  if (blocks[i].stage) {
    const b = blocks[i];
    return { head: `${wk} · ${b.title}`, line: b.line, groups: [{ title: "", items: b.items }], done: b.done, total: b.total, after };
  }
  const rest = blocks.slice(i).filter(b => !b.stage && b.done < b.total);
  return { head: `${wk} · ${st.title}`, line: st.line, groups: rest.map(b => ({ title: b.title, items: b.items })),
    done: rest.reduce((a, b) => a + b.done, 0), total: rest.reduce((a, b) => a + b.total, 0), after: after.filter(b => b.stage) };
}

function collectXhs() {
  const dir = tfile(V.xhsDir);
  const projects = [];
  if (dir && Array.isArray(dir.children)) {
    for (const c of dir.children) {
      if (!Array.isArray(c.children)) continue; // 只看项目文件夹
      let mtime = 0;
      const walk = f => { if (Array.isArray(f.children)) f.children.forEach(walk); else if (f.stat) mtime = Math.max(mtime, f.stat.mtime); };
      walk(c);
      const readmePath = `${c.path}/README.md`;
      const readme = isFile(tfile(readmePath)) ? dv.page(readmePath) : null;
      const status = readme && readme.status != null ? String(readme.status) : null;
      projects.push({ name: c.name, path: c.path, mtime, days: Math.max(0, Math.floor((Date.now() - mtime) / 86400000)), status, readme: readme ? readmePath : null });
    }
  }
  const finished = projects.filter(p => p.days <= V.finishedDays).sort((a, b) => b.mtime - a.mtime).slice(0, 3);
  const doing = projects.filter(p => p.status && !/完成|done|归档|archiv|退役/i.test(p.status));
  return { total: projects.length, finished, doing, projects: projects.slice().sort((a, b) => b.mtime - a.mtime) };
}

async function collectTodo() {
  const path = V.todoPath, f = tfile(path);
  if (!isFile(f)) return { path, exists: false, planned: [], ideas: [], total: 0 };
  const text = await app.vault.cachedRead(f);
  const lines = text.split("\n");
  const stripMark = l => l.replace(/^\s*(?:[-*+]|\d+[.)])\s*(?:\[.\]\s*)?/, "").trim();
  const planned = lines.map((l, i) => ({ l, i })).filter(x => x.l.includes("下一期")).map(x => ({ text: stripMark(x.l), line: x.i }));
  // 段落 = 空行分开的一块
  const paras = []; let cur = null;
  lines.forEach((l, i) => {
    if (l.trim() === "") { cur = null; return; }
    if (!cur) { cur = { start: i, lines: [] }; paras.push(cur); }
    cur.lines.push(l);
  });
  const DATE1 = /^(\d{1,2})[.\-/](\d{1,2})\.?$/;            // 10.28
  const DATE2 = /^(\d{4})-(\d{2})-(\d{2})(?:\s*[·:：]\s*(.*))?$/; // 2026-10-30 · 文本
  const ideas = paras.map(p => {
    let date = null, body = p.lines, m;
    if ((m = p.lines[0].match(DATE1))) { date = `${pad(+m[1])}.${pad(+m[2])}`; body = p.lines.slice(1); }
    else if ((m = p.lines[0].match(DATE2))) { date = `${m[2]}.${m[3]}`; body = [m[4] || "", ...p.lines.slice(1)].filter(Boolean); }
    return { date, text: body.map(stripMark).join(" ").replace(/\s+/g, " ").trim(), line: p.start, isPlanned: p.lines.some(l => l.includes("下一期")) };
  }).filter(p => p.text);
  const shown = ideas.filter(p => !p.isPlanned).slice(-V.ideasMax).reverse();
  return { path, exists: true, planned, ideas: shown, total: ideas.length, lastLine: lines.length - 1, all: ideas.filter(p => !p.isPlanned).slice().reverse(),
    urls: [...text.matchAll(/https?:\/\/[^\s)）]+/g)].map(m => m[0]) }; // 资讯卡据此判断哪条已经「收进灵感」
}

// 资讯卡：读 today.json。看板自己不联网。
// [A 方案适配] 优先用 config.json 的 newsDir（相对 vault 根，数据由 dsh 直接写进 vault）；
// 未配置时回退到原仓库行为：~/.secondbrain-news/。这样 Windows / 无 Node 环境也能跑。
const NEWS_DIR = () => {
  const path = window.require("path");
  if (V.newsDir) {
    const base = app.vault.adapter.basePath;
    if (base) return path.join(base, V.newsDir);
  }
  return path.join(window.require("os").homedir(), ".secondbrain-news");
};
// 缩略图不用 <img src=网址> 直接加载：那样会存进 Obsidian 的网页缓存（在磁盘上，满 1.25GB 左右才清）。
// 改用 Node 下载到内存、做成 blob 地址给图片用，关掉 Obsidian 就没了，磁盘上不留
const thumbMap = () => window.__sbThumbs || (window.__sbThumbs = new Map()); // 原网址 → blob 地址（加载中是 null）
const thumbSrc = url => { const b = thumbMap().get(url); return typeof b === "string" ? b : ""; };
function loadThumbs() {
  const map = thumbMap();
  // [A 方案适配] 跳过空地址，离线演示时不发起无意义的网络请求
  const want = [...new Set([...document.querySelectorAll(".sb-board img[data-thumb]")].map(i => i.dataset.thumb).filter(Boolean))];
  for (const url of want) {
    if (map.has(url)) continue;
    map.set(url, null);
    window.require("https").get(url, res => {
      if (res.statusCode !== 200) { res.resume(); map.delete(url); return; }
      const parts = []; res.on("data", c => parts.push(c));
      res.on("end", () => {
        const b = URL.createObjectURL(new Blob([Buffer.concat(parts)], { type: res.headers["content-type"] || "image/jpeg" }));
        map.set(url, b);
        document.querySelectorAll(`.sb-board img[data-thumb="${CSS.escape(url)}"]`).forEach(i => { i.src = b; });
      });
    }).on("error", () => map.delete(url));
  }
  // 只留今天数据里还在的，旧的释放掉内存
  for (const [url, b] of map) if (!want.includes(url) && b) { URL.revokeObjectURL(b); map.delete(url); }
}
function collectNews() {
  try {
    const fs = window.require("fs"), path = window.require("path"), dir = NEWS_DIR();
    let t = null;
    try { t = JSON.parse(fs.readFileSync(path.join(dir, "today.json"), "utf8")); } catch (e) { /* 还没跑过 */ }
    let running = false;
    try { running = Date.now() - fs.statSync(path.join(dir, "run.lock")).mtimeMs < 15 * 60e3; } catch (e) { /* 没在跑 */ }
    return { t, running, dir };
  } catch (e) { return { t: null, running: false, err: String(e.message || e) }; }
}

// ---------- 画 ----------
const SVG_EXPAND = `<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>`;
const chrome = kind => `<span class="handle"></span><span class="tools"><button class="tb" data-act="expand" title="展开">${SVG_EXPAND}</button><button class="tb" data-act="more" title="更多">⋯</button></span>`;

function glyphField(seed = 11) {
  const g = "▲×#●·+"; let s = seed;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const rows = [];
  for (let y = 0; y < 4; y++) { let row = ""; for (let x = 0; x < 30; x++) row += rnd() < 0.42 ? g[Math.floor(rnd() * g.length)] : " "; rows.push(row); }
  return rows.join("\n");
}

function renderList(items, cls, fallbackPath, maxLen = 60) {
  return `<ul class="list ${cls}">${items.map(t =>
    `<li class="${t.done ? "done" : "todo"}" data-open="${esc(t.path || fallbackPath)}" data-line="${t.line}" data-text="${esc(String(t.text).split("\n")[0].trim())}"><span class="box" data-toggle title="${t.done ? "改回未完成" : "标记完成"}"></span><span class="txt">${esc(cut(plain(t.text), maxLen))}</span></li>`
  ).join("")}</ul>`;
}

const dayDots = days => `<ol class="days">${days.map((d, k) =>
  `<li class="${d.state}${d.date === ymd(TODAY) ? " now" : ""}"${d.path ? ` data-open="${esc(d.path)}"` : ""} title="${d.date}${d.total ? ` · ${d.done}/${d.total}` : ""}"><span class="wd">${"一二三四五六日"[k]}</span><span class="dot"></span></li>`
).join("")}</ol>`;

function cardToday(D) {
  const t = D.today, left = t.total - t.done;
  let big, hint;
  if (!t.exists) { big = `今天<b>还没定</b>`; hint = `<button class="btn" data-act="create-today">按模板新建今天</button>`; }
  else if (!t.total) { big = `今天<b>还没定</b>`; hint = `在右边输入框写今天要做的，回车就进「今日」`; }
  else if (left > 0) { big = `还剩<b data-num="today-left">${left}</b>件<small>共 ${t.total} 条</small>`; hint = `已完成 ${t.done} 条，先啃第一条`; }
  else { big = `今天<b>清</b>了<small>${t.total} 条全做完</small>`; hint = `去定明天的三条`; }
  const list = t.shown.length ? renderList(t.shown, "today-list", t.path, 48) : "";
  return `<section class="tile today" data-kind="today" data-src="${esc(t.path)}" data-src-line="${t.sectionLine ?? ""}">${chrome("today")}
    <div class="left"><div class="h">今天 <span class="lab">${t.date.slice(5).replace("-", ".")} ${t.weekday}</span></div>
      <div class="big">${big}</div><div class="hint">${hint}</div>
      ${dayDots(D.days)}</div>
    <div class="right"><pre class="field">${glyphField()}</pre>${list}${carryLine(D.carry.today, "carry-today")}${jotBox("today")}</div>
    <span class="tag">01 · today</span></section>`;
}

function cardXhs(D) {
  const x = D.xhs, td = D.todo;
  const fin = x.finished.length
    ? x.finished.map(p => `<span class="chip" data-open="${esc(p.readme || p.path)}"><b>${esc(p.name)}</b> ${p.days}d</span>`).join("")
    : `<span class="muted">${V.finishedDays} 天内没有收尾的项目</span>`;
  const doing = x.doing.length ? x.doing.map(p => `<li class="todo" data-open="${esc(p.readme)}"><span class="box static"></span><span class="txt">${esc(p.name)} <em>${esc(p.status)}</em></span></li>`).join("") : "";
  const planned = td.planned.length
    ? `<ul class="list planned">${td.planned.map(p => `<li class="todo" data-open="${esc(td.path)}" data-line="${p.line}"><span class="box static"></span><span class="txt">${esc(cut(p.text, 70))}</span></li>`).join("")}</ul>`
    : `<div class="muted">《${esc(baseName(V.todoPath))}》里还没有标「下一期」的句子</div>`;
  return `<section class="tile dots xhs" data-kind="xhs" data-src="${esc(V.xhsDir)}">${chrome("xhs")}
    <div class="h">小红书 <span class="lab">all ${x.total}</span></div>
    <div class="num"><span data-num="xhs-doing">${x.doing.length}</span><small>个进行中 · 最近刚收尾</small></div>
    ${doing ? `<ul class="list planned doing">${doing}</ul>` : ""}
    <div class="chips">${fin}</div>
    <div class="cnlab">打算做</div>${planned}
    <span class="tag">02 · xiaohongshu</span></section>`;
}

function routeSvg(r) {
  const n = r.stations.length; if (!n) return "";
  const W = 520, H = 76, x0 = 12, x1 = W - 12, step = n > 1 ? (x1 - x0) / (n - 1) : 0, y = 22;
  let s = `<svg class="line" viewBox="0 0 ${W} ${H}" width="100%" height="${H}">`;
  s += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" class="rail"/>`;
  s += `<line x1="${x0}" y1="${y}" x2="${x0 + step * r.cur}" y2="${y}" class="rail on"/>`;
  r.stations.forEach((w, i) => {
    const x = x0 + step * i, on = i === r.cur, past = i < r.cur;
    const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    s += `<g class="st ${on ? "on" : past ? "past" : "todo"}" data-open="${esc(r.path)}" data-line="${w.line}"><title>${esc(w.heading)}</title>`;
    s += on ? `<circle cx="${x}" cy="${y}" r="11" class="c1"/><circle cx="${x}" cy="${y}" r="4" class="c2"/>` : `<circle cx="${x}" cy="${y}" r="6" class="c0"/>`;
    s += `<text x="${x}" y="${y + 27}" text-anchor="${anchor}" class="wk">${esc(w.label)}</text>`;
    s += `<text x="${x}" y="${y + 43}" text-anchor="${anchor}" class="ct">${w.done}/${w.total}</text></g>`;
  });
  return s + `</svg>`;
}

function cardRoute(D) {
  const r = D.route, c = r.stations[r.cur];
  const pct = r.total ? Math.round(r.done / r.total * 100) : 0;
  const seg = [...Array(26)].map((_, i) => `<i class="${i < Math.round((r.total ? r.done / r.total : 0) * 26) ? "on" : ""}"></i>`).join("");
  const next = r.next.map((t, k) => `<li data-open="${esc(t.path)}" data-line="${t.line}"><b>${k === 0 ? "NEXT" : "THEN"}</b><span>${esc(cut(plain(t.text), 44))}</span></li>`).join("");
  const body = c ? `
    <div class="hero" data-open="${esc(r.path)}" data-line="${c.line}"><div class="n"><span data-num="route-done">${c.done}</span><small>/ ${c.total}</small></div><div class="where"><span class="lab">now at</span><b>${esc(c.label.replace(/^第(\d+)周/, "第 $1 周"))} · ${esc(c.title)}</b></div></div>
    ${routeSvg(r)}
    <div class="now-hint">${r.block ? `这一站还剩 ${r.block.total - r.block.done} 条 · 清单在本周卡` : "这一站全勾完了"}</div>
    <ol class="next">${r.upcoming.map((u, k) => `<li data-open="${esc(r.path)}" data-line="${u.line}"><b>${k === 0 ? "NEXT" : "THEN"}</b><span>${esc(cut(u.title, 40))} <em>${u.done}/${u.total}</em></span></li>`).join("")}</ol>`
    : `<div class="muted" data-open="${esc(r.path)}">没在《${esc(baseName(r.path))}》里找到「第 N 周 · 标题」的二级标题</div>`;
  return `<section class="tile dark route" data-kind="route" data-src="${esc(r.path)}" data-src-line="${c ? c.line : 0}">${chrome("route")}
    <div class="h">AI 学习路线 <span class="lab">6-week plan · ${r.stations.length} stops</span></div>
    ${body}
    <div class="totwrap"><span class="lab">total ${r.done} / ${r.total}</span><div class="seg">${seg}</div><span class="pct"><span data-num="route-pct">${pct}</span>%</span></div>
    <span class="tag">03 · ai route</span></section>`;
}

// 本周 = 学习计划当前区块（只列没勾的，勾了直接写回计划文件）+ 我加的（weekly 文件，可在卡上输入）
function planBlockHTML(D, cls, maxLen, undoneOnly) {
  const r = D.route, b = r.block;
  const head = b
    ? `<div class="plan-h" data-open="${esc(r.path)}" data-line="${b.line}"><span class="lab">学习计划</span><b>${esc(b.head)}</b><span class="cnt">${b.done}/${b.total}</span></div>`
    : `<div class="plan-h"><span class="lab">学习计划</span><b class="muted">${r.exists ? "计划里的条目都勾完了" : `没找到《${esc(baseName(r.path))}》`}</b></div>`;
  const groups = b ? b.groups.map(g => {
    const items = undoneOnly ? g.items.filter(t => !t.done) : g.items;
    return (g.title ? `<div class="grp">${esc(g.title)}</div>` : "") + (items.length ? renderList(items, cls, r.path, maxLen) : "");
  }).join("") : "";
  return head + groups;
}
function cardWeek(D) {
  const w = D.week, b = D.route.block;
  const done = w.done + (b ? b.done : 0), total = w.total + (b ? b.total : 0);
  const seg = [...Array(21)].map((_, i) => `<i class="${i < Math.round((total ? done / total : 0) * 21) ? "on" : ""}"></i>`).join("");
  const mine = !w.exists ? `<div class="empty">这周的文件还没建，下面写一条就建</div>`
    : !w.total ? `<div class="empty">计划之外还要做什么，下面写一条</div>`
    : renderList(w.items, "week-list", w.path, 44);
  return `<section class="tile mint week" data-kind="week" data-src="${esc(w.path)}" data-src-line="${w.sectionLine ?? ""}">${chrome("week")}
    <div class="h">本周要完成 <span class="lab">${esc(w.range)}</span></div>
    <div class="top"><div class="n"><span data-num="week-done">${done}</span><small>/ ${total} 做完</small></div><div class="left">还有 ${w.daysLeft} 天<br>${total - done} 条没动</div></div>
    <div class="sections">
      ${planBlockHTML(D, "week-list plan-list", 38, true)}
      <div class="plan-h mine-h"><span class="lab">我加的</span></div>
      ${mine}${carryLine(D.carry.week, "carry-week")}
    </div>
    ${jotBox("week")}
    <div class="dayswrap"><div class="cap">每天定了没、做完没<br>■ 做完 ◧ 没做完 □ 没定</div>${dayDots(D.days)}</div>
    <span class="tag">04 · this week</span></section>`;
}

function cardIdeas(D) {
  const td = D.todo;
  const items = td.ideas.length
    ? td.ideas.map(i => `<li data-open="${esc(td.path)}" data-line="${i.line}"><span class="when">${i.date || "·"}</span><span class="txt">${esc(cut(i.text, 86))}</span></li>`).join("")
    : `<li><span class="when">·</span><span class="txt muted">还没有内容，先在下面记一笔</span></li>`;
  return `<section class="tile ideas" data-kind="ideas" data-src="${esc(td.path)}" data-src-line="${td.lastLine ?? ""}">${chrome("ideas")}
    <div class="h">灵感收件箱 <span class="cnt" data-open="${esc(td.path)}">${td.total} 段</span></div>
    <ul class="ideas-list">${items}</ul>
    ${jotBox("idea")}
    <div class="foot">05 · inbox · to-do &amp; inspiration.md</div></section>`;
}

// ---------- 06 今天 AI 圈（资讯卡） ----------
const fmtViews = n => n == null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
const fmtAgo = h => h == null ? "" : h < 1 ? "刚刚" : h < 24 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
const xWhen = iso => { const d = new Date(iso), y = new Date(Date.now() - 864e5); if (Number.isNaN(+d)) return ""; const w = d.toDateString() === new Date().toDateString() ? "今天" : d.toDateString() === y.toDateString() ? "昨天" : `${d.getMonth() + 1}.${d.getDate()}`; return `${w} ${hhmm(iso)} 整理`; };
const hhmm = iso => { const d = new Date(iso); return Number.isNaN(+d) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const marks = it => `${it.xhs ? `<span class="mk xhs" title="能做成你的选题">✦ 选题</span>` : ""}${it.learn ? `<span class="mk learn" title="作为工程师值得学">学</span>` : ""}`;
const saveBtn = (D, ref, url) => (D.todo.urls || []).includes(url)
  ? `<span class="saved">已收进</span>` : `<button class="lnk save" data-act="news-save" data-ref="${esc(ref)}" title="追加到 ${esc(V.todoPath)}">收进灵感</button>`;
function newsStatus(N) {
  const t = N.t;
  if (N.running) return `<span class="upd run">正在更新…</span>`;
  if (!t) return `<span class="upd">${N.err ? "读不到数据" : "还没有数据"}</span>`;
  const stale = t.date && t.date !== ymd(TODAY) ? `<b class="stale">这是 ${t.date.slice(5).replace("-", ".")} 的</b>` : "";
  const err = t.lastError ? `<b class="stale" title="${esc(t.lastError.message)}">上次更新失败</b>` : "";
  return `<span class="upd">${stale}${err}${t.generatedAt ? `更新于 ${hhmm(t.generatedAt)}` : ""}</span>`;
}
function refLabel(t, ref) {
  const [k, id] = String(ref).split(/:(.+)/);
  if (k === "yt") { const v = (t.youtube || []).find(x => x.id === id); return v ? { label: v.title_zh || v.title, url: v.url, src: "YouTube · " + v.channel } : null; }
  if (k === "hn") { const h = (t.hn || []).find(x => x.id === id); return h ? { label: h.title_zh || h.title, url: h.hnUrl, src: "Hacker News" } : null; }
  if (k === "x") return { label: "@" + id, url: `https://x.com/${id}`, src: "X" };
  if (k === "pod") { const p = (t.podcasts || []).find(x => x.guid === id); return p ? { label: p.title_zh || p.title, url: p.url, src: "播客 · " + p.name } : null; }
  return null;
}
const countLine = c => !c ? "" : [["YT", c.yt], ["X", c.x], ["HN", c.hn], ["播客", c.pod]].filter(x => x[1]).map(x => `${x[0]} ${x[1]}`).join(" · ");
function ytItem(D, v, full) {
  return `<li class="ni yt" data-url="${esc(v.url)}">
    <img class="th" data-thumb="${esc(v.thumb)}"${thumbSrc(v.thumb) ? ` src="${thumbSrc(v.thumb)}"` : ""} alt="">
    <div class="nb"><div class="nt" title="${esc(v.title)}">${esc(v.title_zh || v.title)}</div>
      <div class="nm">${esc(v.channel)} · ${fmtAgo(v.agoH)} · ${fmtViews(v.views)}${v.hot ? ` <b class="hot" title="播放量明显高于这个频道平时（中位数 ${fmtViews(v.median)}）">爆</b>` : ""}${marks(v)}</div>
      ${v.gist ? `<div class="ng">${esc(v.gist)}</div>` : ""}
      ${v.angle ? `<div class="na">✦ ${esc(v.angle)}</div>` : ""}
      ${full ? `<div class="orig">${esc(v.title)}</div>` : ""}
      <div class="nf">${saveBtn(D, "yt:" + v.id, v.url)}</div></div></li>`;
}
function xItem(D, x, full) {
  const url = (x.links && x.links[0] && x.links[0].url) || (x.who && x.who[0] ? `https://x.com/${x.who[0]}` : "");
  const who = (x.who || []).map(w => `<span class="who" data-url="https://x.com/${esc(w)}">@${esc(w)}</span>`).join(" ");
  const links = full && x.links && x.links.length ? `<div class="nf">${x.links.map((l, i) => `<span class="lnk" data-url="${esc(l.url)}">原推 ${i + 1} · @${esc(l.handle)}</span>`).join("")}</div>` : "";
  return `<li class="ni x"${url ? ` data-url="${esc(url)}"` : ""}><div class="nb"><div class="nt">${esc(x.title)}${marks(x)}</div>
    <div class="ng">${esc(x.summary)}</div><div class="nm">${who}</div>${links}
    ${url ? `<div class="nf">${saveBtn(D, "x:" + x.key, url)}</div>` : ""}</div></li>`;
}
function hnItem(D, h, full) {
  return `<li class="ni hn" data-url="${esc(h.hnUrl)}"><div class="nb">
    <div class="nt" title="${esc(h.title)}">${esc(h.title_zh || h.title)}</div>
    <div class="nm">${h.points} 分 · ${h.comments} 评论${marks(h)}</div>
    ${full && h.what ? `<div class="ng"><em>是什么</em>${esc(h.what)}</div>` : ""}
    ${h.engineer ? `<div class="ng">${full ? "<em>工程师角度</em>" : ""}${esc(h.engineer)}</div>` : ""}
    ${full && h.debate ? `<div class="ng"><em>评论区</em>${esc(h.debate)}</div>` : ""}
    ${full ? `<div class="orig">${esc(h.title)}</div><div class="nf"><span class="lnk" data-url="${esc(h.url)}">原文</span><span class="lnk" data-url="${esc(h.hnUrl)}">HN 讨论</span>${saveBtn(D, "hn:" + h.id, h.hnUrl)}</div>`
      : `<div class="nf">${saveBtn(D, "hn:" + h.id, h.hnUrl)}</div>`}</div></li>`;
}
function headItem(t, h, k, full) {
  const refs = full ? (h.refs || []).map(r => refLabel(t, r)).filter(Boolean) : [];
  return `<li class="hd"${full ? "" : ` data-act="expand"`}><span class="hk">${pad(k + 1)}</span>
    <div class="hb"><div class="ht">${esc(h.title)}${h.new ? `<span class="mk new" title="近 30 天第一次出现">新</span>` : ""}${marks(h)}<span class="hc">${countLine(h.count)}</span></div>
      <div class="hs">${esc(h.summary)}</div>
      ${refs.length ? `<div class="hr">${refs.map(r => `<span class="lnk" data-url="${esc(r.url)}" title="${esc(r.src)}">${esc(cut(r.label, 26))}</span>`).join("")}</div>` : ""}</div></li>`;
}
function cardNews(D) {
  const N = D.news, t = N.t || {};
  const tools = `<span class="tools"><button class="tb" data-act="news-refresh" title="现在就更新（约 1 分钟）">↻</button><button class="tb" data-act="expand" title="展开">${SVG_EXPAND}</button><button class="tb" data-act="more" title="更多">⋯</button></span>`;
  const empty = msg => `<div class="muted">${msg}</div>`;
  // 没抓成功过时把原因直接写在卡上（不只是鼠标悬停才看得到）；找不到 dsh 是最常见的一种，单独说怎么办
  const fail = t.lastError ? (/找不到 dsh|dsh CLI/.test(t.lastError.message)
    ? `这张卡要用 dsh 的一次性任务（dsh headless）做总结，这台电脑上没找到 dsh 命令。用不上这张卡的话，在 _dashboard/config.json 里写 "news": false 把它关掉；想用这张卡，见 RESTORE.md 的「让脚本找到 dsh」一节`
    : `上次更新失败：${esc(t.lastError.message)}`) : "";
  const heads = (t.headlines || []).length ? `<ol class="heads">${t.headlines.map((h, k) => headItem(t, h, k, false)).join("")}</ol>`
    : empty(N.running ? "正在第一次抓取，大约 1 分钟" : fail || "还没有数据。点右上角 ↻ 抓一次（要用 dsh headless，大约 1 分钟）");
  const yt = (t.youtube || []).map(v => ytItem(D, v, false)).join("");
  const xs = ((t.x && t.x.topics) || []).map(x => xItem(D, x, false)).join("");
  const pods = (t.podcasts || []).filter(p => p.gist).map(p => `<li class="ni pod" data-url="${esc(p.url)}"><div class="nb"><div class="nt">${esc(p.title_zh || p.title)}${marks(p)}</div><div class="nm">播客 · ${esc(p.name)}</div></div></li>`).join("");
  const hn = (t.hn || []).map(h => hnItem(D, h, false)).join("");
  const err = (t.sources && t.sources.youtube && t.sources.youtube.ok < t.sources.youtube.total) ? `<span class="warn" title="${esc((t.sources.youtube.errors || []).join("\n"))}">${t.sources.youtube.total - t.sources.youtube.ok} 个频道没抓到</span>` : "";
  return `<section class="tile news" data-kind="news" data-src="">${`<span class="handle"></span>`}${tools}
    <div class="h">今天 AI 圈 <span class="lab">youtube · x · hacker news</span>${newsStatus(N)}</div>
    ${heads}
    <div class="ncols">
      <div class="ncol"><div class="nh">YouTube 博主在做什么 <em>${(t.youtube || []).length}</em>${err}</div><ul class="nl">${yt || `<li class="muted">7 天内没有新视频</li>`}</ul></div>
      <div class="ncol"><div class="nh">X 上大家在聊什么 <em>${t.x && t.x.generatedAt ? xWhen(t.x.generatedAt) : ""}</em></div><ul class="nl">${xs || `<li class="muted">没有数据</li>`}${pods}</ul></div>
      <div class="ncol"><div class="nh">Hacker News <em>工程师圈</em></div><ul class="nl">${hn || `<li class="muted">首页上暂时没有 AI 相关的帖子</li>`}</ul></div>
    </div>
    <span class="tag">06 · ai news</span></section>`;
}
function detailNews(D) {
  const N = D.news, t = N.t || {};
  const xs = ((t.x && t.x.topics) || []).map(x => xItem(D, x, true)).join("");
  const pods = (t.podcasts || []).map(p => `<li class="ni pod" data-url="${esc(p.url)}"><div class="nb"><div class="nt">${esc(p.title_zh || p.title)}${marks(p)}</div><div class="nm">播客 · ${esc(p.name)}</div>${p.gist ? `<div class="ng">${esc(p.gist)}</div>` : ""}<div class="orig">${esc(p.title)}</div></div></li>`).join("");
  return `
    <div class="stats">${stat((t.headlines || []).length, "要闻")}${stat((t.youtube || []).length, "YouTube")}${stat(((t.x && t.x.topics) || []).length, "X 话题")}${stat((t.hn || []).length, "HN")}${stat(t.generatedAt ? hhmm(t.generatedAt) : "—", t.date ? t.date.slice(5).replace("-", ".") + " 更新" : "更新")}</div>
    ${secH("要闻 · 按几个来源在聊排序")}<ol class="heads full">${(t.headlines || []).map((h, k) => headItem(t, h, k, true)).join("") || `<div class="muted">还没有数据</div>`}</ol>
    ${secH("YouTube 博主在做什么 · 近 7 天")}<ul class="nl yt-grid">${(t.youtube || []).map(v => ytItem(D, v, true)).join("")}</ul>
    <div class="cols">
      <div>${secH("X 上大家在聊什么")}<ul class="nl">${xs}${pods}</ul></div>
      <div>${secH("Hacker News · 工程师圈")}<ul class="nl">${(t.hn || []).map(h => hnItem(D, h, true)).join("")}</ul></div>
    </div>
    <div class="muted news-foot">数据在 ${esc(N.dir || "~/.secondbrain-news")}，每天 8:30 自动更新，总量不超过 200KB。${t.llm ? `上次总结用时 ${t.llm.seconds} 秒。` : ""}</div>`;
}

// 点「收进灵感」：往 To-do & inspiration.md 末尾追加一段，灵感卡当场多一条
function newsRefText(D, ref) {
  const t = D.news.t || {}, [k, id] = String(ref).split(/:(.+)/);
  if (k === "yt") { const v = (t.youtube || []).find(x => x.id === id); if (v) return `【YouTube · ${v.channel}】${v.title_zh || v.title}${v.angle ? `——角度：${v.angle}` : v.gist ? `——${v.gist}` : ""} ${v.url}`; }
  if (k === "hn") { const h = (t.hn || []).find(x => x.id === id); if (h) return `【Hacker News】${h.title_zh || h.title}${h.engineer ? `——${h.engineer}` : ""} ${h.hnUrl}`; }
  if (k === "x") { const x = ((t.x && t.x.topics) || []).find(o => o.key === id); if (x) { const u = (x.links && x.links[0] && x.links[0].url) || `https://x.com/${(x.who || [])[0] || ""}`; return `【X】${x.title}——${x.summary} ${u}`; } }
  return null;
}
async function saveNews(root, D, btn) {
  const text = newsRefText(D, btn.dataset.ref); if (!text) return;
  const f = tfile(V.todoPath); if (!isFile(f)) return;
  root.querySelectorAll(`[data-act="news-save"][data-ref="${CSS.escape(btn.dataset.ref)}"]`).forEach(b => { b.outerHTML = `<span class="saved">已收进</span>`; });
  const ul = root.querySelector(".ideas .ideas-list");
  if (ul) {
    ul.querySelectorAll("li .muted").forEach(m => m.closest("li").remove());
    ul.insertAdjacentHTML("afterbegin", `<li><span class="when">${pad(TODAY.getMonth() + 1)}.${pad(TODAY.getDate())}</span><span class="txt">${esc(cut(text, 86))}</span></li>`);
    while (ul.children.length > V.ideasMax) ul.lastElementChild.remove();
    const cnt = root.querySelector(".ideas .cnt"); if (cnt) cnt.textContent = `${(parseInt(cnt.textContent, 10) || 0) + 1} 段`;
  }
  await app.vault.process(f, data => data.replace(/\s+$/, "") + `\n\n${ymd(TODAY)} · ${text}\n`);
}

// 跑一次刷新（刷新按钮 / 数据不是今天的时自动补跑）。跑完 today.json 一变，下面的文件监视会让看板重画。
// [A 方案适配] 上游原实现是 spawn node 去跑 fetch.mjs 再调 claude -p，强依赖 macOS + Node + Claude Code。
// 这里改为 spawn 同目录下的 refresh.ps1，由它去调 dsh headless（一次性任务）完成抓取+总结+写回。
// 不依赖系统 Node、不需要 Claude Code、凭据固定在 ~/.dsh/.env。
// [A 方案适配] 关键：用户实际打开的 vault 根可能是更上层目录（例如 vault 根是 MyVault、看板在 Projects/demo-vault/），
// app.vault.adapter.basePath 返回的是那个根，不是 demo-vault。
// BOARD_DIR 是 config.json 的 base 前缀（vault 相对路径，指向 demo-vault），
// 用 basePath + BOARD_DIR 才能得到 demo-vault 的绝对路径。
const BOARD_ABS = () => {
  const path = window.require("path");
  const base = app.vault.adapter.basePath;
  if (!base) return null;
  return BOARD_DIR ? path.resolve(base, BOARD_DIR) : base;
};
const RUN_REFRESH = () => {
  const fs = window.require("fs"), path = window.require("path");
  const board = BOARD_ABS();
  if (!board) return null;
  // refresh.ps1 在 demo-vault 上一层，也在 _dashboard/ 下放一份兜底
  const candidates = [
    path.join(board, "_dashboard", "refresh.ps1"),
    path.join(board, "..", "refresh.ps1"),
  ];
  return candidates.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
};
function runNews(root) {
  const script = RUN_REFRESH(), board = BOARD_ABS();
  if (!script || !board) { if (typeof Notice === "function") new Notice("找不到 refresh.ps1，无法更新资讯"); return; }
  const p = window.require("child_process").spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Async", "-Vault", board],
    { cwd: board, stdio: "ignore", windowsHide: true }
  );
  p.on("error", e => console.warn("[sb-board] 资讯刷新启动失败", e));
  root.querySelectorAll(".news .upd").forEach(u => { u.className = "upd run"; u.textContent = "正在更新…"; });
  if (typeof Notice === "function") new Notice("已开始刷新资讯，几十秒后看板会自动重画");
}
// 盯着数据文件夹：定时任务或刷新按钮写完 today.json，看板自己重画（只装一个监视器，代码更新后换新的）
function watchNews() {
  if (V.news === false) return;
  try {
    const fs = window.require("fs"), dir = NEWS_DIR();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (window.__sbNewsWatch) window.__sbNewsWatch.close();
    let t = null;
    window.__sbNewsWatch = fs.watch(dir, (ev, name) => {
      if (name !== "today.json" && name !== "run.lock") return;
      clearTimeout(t); t = setTimeout(() => { try { dv.index.touch(); } catch (e) { /* 忽略 */ } }, 800);
    });
  } catch (e) { console.warn("[sb-board] 监视资讯文件夹失败", e); }
}
// 数据不是今天的、已经过了 8:30、没在跑：自动补跑一次（Mac 关机错过定时任务时）。同一天只试一次
function maybeAutoNews(root, N) {
  const now = new Date(), day = ymd(TODAY);
  // 一次都没抓过（新装的）不自动跑：第一次要自己点 ↻，免得一打开看板就替人花一次模型用量
  if (V.news === false || !N.t || N.running || N.t.date === day || window.__sbNewsAuto === day) return;
  if (now.getHours() * 60 + now.getMinutes() < 8 * 60 + 30) return;
  window.__sbNewsAuto = day;
  runNews(root);
}

// ---------- 07 番茄钟：25 分专注 / 5 分休息。按结束时间戳算剩余，存 localStorage，看板重画、切笔记、重启 Obsidian 都接得上 ----------
const POMO_KEY = "sb-pomo";
const POMO_MS = () => window.__sbPomoMs || { focus: 25 * 60e3, brk: 5 * 60e3 }; // 测试时可在控制台改短
function pomoLoad() {
  try { const s = JSON.parse(localStorage.getItem(POMO_KEY)); if (s && s.phase) return s; } catch (e) { /* 没有或读不了 */ }
  return { phase: "focus", running: false, endsAt: 0, left: POMO_MS().focus, day: ymd(new Date()), count: 0 };
}
function pomoSave(s) { try { localStorage.setItem(POMO_KEY, JSON.stringify(s)); } catch (e) { /* 存不了就只在这次会话里有效 */ } }
const pomoTotal = s => s.phase === "focus" ? POMO_MS().focus : POMO_MS().brk;
const pomoLeft = s => s.running ? Math.max(0, s.endsAt - Date.now()) : s.left;
// 到点：专注结束 → 计数 +1、自动开始休息；休息结束 → 回到专注、停着等你点开始。离开太久错过的只补状态，不补发通知
function pomoStep(s) {
  const today = ymd(new Date());
  let changed = false;
  if (s.day !== today) { s.day = today; s.count = 0; changed = true; }
  while (s.running && Date.now() >= s.endsAt) {
    const late = Date.now() - s.endsAt > 60e3;
    if (s.phase === "focus") {
      s.count++; s.phase = "break"; s.endsAt += POMO_MS().brk;
      if (!late) pomoNotify("专注 25 分钟完成", `今天第 ${s.count} 个。休息 5 分钟，起来走走`);
    } else {
      s.phase = "focus"; s.running = false; s.left = POMO_MS().focus;
      if (!late) pomoNotify("休息结束", "回来点「开始」进入下一个番茄");
    }
    changed = true;
  }
  return changed;
}
function pomoNotify(title, body) {
  try { new Notification(title, { body }); } catch (e) { console.warn("[sb-board] 通知发不出来", e); }
}
const pomoFmt = ms => { const sec = Math.ceil(ms / 1000); return { mm: Math.floor(sec / 60), ss: sec % 60 }; };
const pad2 = n => pad(n);
function pomoPaint(el, s) {
  const left = pomoLeft(s), total = pomoTotal(s), { mm, ss } = pomoFmt(left);
  const set = (k, v, fmt) => { const n = el.querySelector(`[data-pomo="${k}"]`); if (!n) return; const want = fmt ? fmt(v) : String(v); if ((n.firstChild && n.firstChild.textContent) !== want) rollTo(n, v, fmt); };
  set("mm", mm, pad2); set("ss", ss, pad2); set("count", s.count);
  const arc = el.querySelector(".arc"); if (arc) arc.style.strokeDashoffset = String(553 * (1 - (total ? (total - left) / total : 0)));
  el.classList.toggle("running", !!s.running); el.classList.toggle("brk", s.phase === "break");
  const ph = el.querySelector(".ph"); const phT = s.phase === "break" ? "休息" : s.running ? "专注中" : left < total ? "暂停" : "专注"; if (ph && ph.textContent !== phT) ph.textContent = phT;
  const btn = el.querySelector('[data-act="pomo-toggle"]'); const bT = s.running ? "暂停" : left < total ? "继续" : "开始"; if (btn && btn.textContent !== bT) btn.textContent = bT;
}
function pomoTick() {
  const s = pomoLoad();
  if (pomoStep(s)) pomoSave(s);
  document.querySelectorAll(".sb-board:not(.sb-ghost) .pomo").forEach(el => pomoPaint(el, s));
}
function pomoAct(name) {
  const s = pomoLoad(); pomoStep(s);
  if (name === "pomo-toggle") {
    if (s.running) { s.left = Math.max(0, s.endsAt - Date.now()); s.running = false; }
    else { s.endsAt = Date.now() + s.left; s.running = true; }
  } else if (name === "pomo-reset") { s.phase = "focus"; s.running = false; s.left = POMO_MS().focus; }
  pomoSave(s); pomoTick();
}
function startPomo() {
  if (window.__sbPomoTimer) clearInterval(window.__sbPomoTimer); // 代码更新后换成新的；只留一个
  window.__sbPomoTimer = setInterval(pomoTick, 250);
}
function cardPomo() {
  const s = pomoLoad(); pomoStep(s);
  const left = pomoLeft(s), total = pomoTotal(s), { mm, ss } = pomoFmt(left);
  const off = 553 * (1 - (total ? (total - left) / total : 0));
  const phT = s.phase === "break" ? "休息" : s.running ? "专注中" : left < total ? "暂停" : "专注";
  return `<section class="tile dark pomo${s.running ? " running" : ""}${s.phase === "break" ? " brk" : ""}" data-kind="pomo"><span class="handle"></span>
    <div class="h">番茄钟 <span class="lab">25 / 5</span></div>
    <div class="ring"><svg viewBox="0 0 200 200"><circle class="trk" cx="100" cy="100" r="88"/><circle class="arc" cx="100" cy="100" r="88" style="stroke-dashoffset:${off}"/></svg>
      <div class="clock"><span data-pomo="mm">${pad(mm)}</span><i>:</i><span data-pomo="ss">${pad(ss)}</span></div><div class="ph">${phT}</div></div>
    <div class="ctl"><button class="pbtn main" data-act="pomo-toggle">${s.running ? "暂停" : left < total ? "继续" : "开始"}</button><button class="pbtn" data-act="pomo-reset" title="回到 25:00">重置</button></div>
    <div class="pcnt">今天完成 <b data-pomo="count">${s.count}</b> 个</div>
    <span class="tag">07 · pomodoro</span></section>`;
}

const renderAll = D => cardToday(D) + cardXhs(D) + cardRoute(D) + cardWeek(D) + cardIdeas(D) + (V.news === false ? "" : cardNews(D)) + cardPomo();

// ---------- 字体：把 fonts/*.css 里的相对 url 换成 Obsidian 资源路径 ----------
async function ensureFonts() {
  if (document.getElementById("sb-fonts")) return;
  const files = ["doto.css", "spacemono.css"];
  let css = "";
  for (const name of files) {
    try {
      const raw = await app.vault.adapter.read(`${V.fontDir}/${name}`);
      css += raw.replace(/url\(([^)]+)\)/g, (m, u) => `url("${app.vault.adapter.getResourcePath(`${V.fontDir}/${u.replace(/['"]/g, "")}`)}")`) + "\n";
    } catch (e) { console.warn("[sb-board] 字体文件读不到", name, e); }
  }
  const st = document.createElement("style"); st.id = "sb-fonts"; st.textContent = css;
  document.head.appendChild(st);
}

// ---------- 打开原文：在看板右边分一栏，之后一直复用那一栏 ----------
function boardLeaf(root) {
  return app.workspace.getLeavesOfType("markdown").find(l => l.view?.containerEl?.contains(root)) || app.workspace.activeLeaf;
}
function sideLeaf(root) {
  const alive = l => l && app.workspace.getLeafById(l.id);
  if (alive(window.__sbSideLeaf)) return window.__sbSideLeaf;
  const bl = boardLeaf(root);
  const inMain = bl && bl.getRoot && bl.getRoot() === app.workspace.rootSplit;
  const leaf = inMain ? app.workspace.createLeafBySplit(bl, "vertical") : app.workspace.getLeaf(false);
  window.__sbSideLeaf = leaf;
  return leaf;
}
async function openAt(root, path, line) {
  const f = tfile(path);
  if (!f) return;
  if (!isFile(f)) { // 文件夹：找里面的 README 或第一个 md
    const md = f.children.find(c => c.name === "README.md") || f.children.find(c => isFile(c) && c.extension === "md");
    if (!md) return; return openAt(root, md.path, undefined);
  }
  const leaf = sideLeaf(root);
  await leaf.openFile(f, { active: true, eState: line != null && !Number.isNaN(line) ? { line, scroll: line } : undefined });
}

// ---------- 三种写入 ----------
async function toggleTask(path, line, text) {
  const f = tfile(path); if (!isFile(f)) return;
  const want = String(text || "").trim();
  let missed = false;
  await app.vault.process(f, data => {
    const lines = data.split("\n");
    const box = l => (l || "").match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([^\]])\]\s*(.*)$/);
    const same = m => !want || m[3].trim() === want;
    // 看板画好之后笔记可能被改过（自己加了一行、agent 插了一行），行号会错位：先核对这一行是不是那条任务，不是就按文字找，找不到唯一的一条就不动
    let i = line, m = box(lines[i]);
    if (!m || !same(m)) {
      const hits = lines.map((l, k) => [k, box(l)]).filter(([, x]) => x && same(x));
      if (hits.length !== 1) { missed = true; return data; }
      [i, m] = hits[0];
    }
    lines[i] = lines[i].slice(0, m[1].length) + (/x/i.test(m[2]) ? " " : "x") + lines[i].slice(m[1].length + 1);
    return lines.join("\n");
  });
  if (missed) { new Notice("这篇笔记刚被改过，没找到这条任务，没有改动。等看板刷新后再点一次"); try { dv.index.touch(); } catch (e) { /* 忽略 */ } }
}
// 三种输入框：idea → To-do 文件末尾；today → 今天 daily 的「今日」；week → 本周 weekly 的「本周要完成」
const JOT_META = {
  idea:  { ph: "记一笔，回车就进收件箱", title: "写进收件箱", done: "记下了" },
  today: { ph: "加一条今天要做的，回车", title: "写进今天的「今日」", done: "加上了" },
  week:  { ph: "这周还要做什么，回车", title: "写进「本周要完成」", done: "加上了" },
};
const jotBox = kind => `<div class="jot" data-jot="${kind}"><input type="text" placeholder="${JOT_META[kind].ph}" spellcheck="false"><button class="add" data-act="jot" title="${JOT_META[kind].title}">+</button></div>`;
async function submitJot(inp) {
  const text = inp.value.trim(); if (!text) return;
  const kind = inp.closest(".jot")?.dataset.jot || "idea";
  if (kind === "idea") {
    const f = tfile(V.todoPath); if (!isFile(f)) return;
    await app.vault.process(f, data => data.replace(/\s+$/, "") + `\n\n${ymd(TODAY)} · ${text}\n`);
  } else {
    optimisticAdd(inp.closest(".sb-board"), kind, [text]);
    await appendUnder(kind, [`- [ ] ${text}`]);
  }
  inp.value = ""; window.__sbJot[kind] = ""; inp.placeholder = JOT_META[kind].done;
  window.__sbJotFocus = { kind, inModal: !!inp.closest(".sb-modal"), at: Date.now() }; // 重画后把焦点放回来
}
async function createFromTemplate(root, path, tplPath, dateStr) {
  if (isFile(tfile(path))) return openAt(root, path, 0);
  const tpl = tfile(tplPath);
  let body = isFile(tpl) ? await app.vault.read(tpl) : "## 今日\n\n- [ ] \n\n## 随手记\n";
  body = body.replace(/{{\s*date[^}]*}}/g, dateStr).replace(/{{\s*title\s*}}/g, dateStr);
  await app.vault.create(path, body);
  await openAt(root, path, 2);
}

// ---------- 右上两个按钮：⤢ 打开来源，⋯ 小菜单 ----------
async function revealInExplorer(f) {
  const leaf = app.workspace.getLeavesOfType("file-explorer")[0];
  if (!leaf) return;
  await app.workspace.revealLeaf(leaf); // 侧栏收着就展开，并切到文件列表
  if (typeof leaf.view.revealInFolder === "function") leaf.view.revealInFolder(f);
}
async function openSource(root, tile) {
  const { kind, src, srcLine } = tile.dataset;
  if (!src) return;
  const f = tfile(src);
  if (!f) { // 文件还没建：今天 / 本周按模板建
    if (kind === "today") return createFromTemplate(root, src, V.dailyTemplate, ymd(TODAY));
    if (kind === "week") return createFromTemplate(root, src, V.weeklyTemplate, ymd(MON));
    return;
  }
  if (!isFile(f)) return revealInExplorer(f); // 文件夹（小红书）：在文件列表里展开
  return openAt(root, src, srcLine != null && srcLine !== "" ? +srcLine : undefined);
}
function closeMenu() {
  document.querySelectorAll(".sb-menu").forEach(m => m.remove());
  document.removeEventListener("pointerdown", menuDocDown, true);
  document.removeEventListener("keydown", menuEsc, true);
}
function menuDocDown(e) {
  if (e.target.closest(".sb-menu")) return;
  // 点的是"同一张卡"的 ⋯ 才记时间（让它表现成开关）；点别的卡的 ⋯ 要能直接换过去
  const more = e.target.closest("[data-act=more]"), open = document.querySelector(".sb-menu");
  if (more && open && more.closest(".tile") === open.closest(".tile")) window.__sbMenuClosedAt = Date.now();
  closeMenu();
}
function menuEsc(e) { if (e.key === "Escape") closeMenu(); }
function showMenu(root, tile) {
  if (Date.now() - (window.__sbMenuClosedAt || 0) < 300) return; // 刚被同一次点击关掉，别马上又弹开
  closeMenu();
  const { kind, src } = tile.dataset;
  const f = src ? tfile(src) : null;
  const items = [];
  if (f && !isFile(f)) items.push(["在文件列表里显示这个文件夹", () => revealInExplorer(f)]);
  else if (f) { items.push(["打开来源笔记", () => openSource(root, tile)]); items.push(["在文件列表里显示", () => revealInExplorer(f)]); }
  else if (kind === "today" || kind === "week") items.push([kind === "today" ? "按模板新建今天" : "按模板新建本周", () => openSource(root, tile)]);
  if (kind === "news") {
    items.push(["现在就更新资讯（约 1 分钟）", () => runNews(root)]);
    items.push(["打开数据文件夹", () => { try { window.require("electron").shell.openPath(NEWS_DIR()); } catch (e) { console.warn(e); } }]);
  }
  items.push(["刷新看板", () => { try { dv.index.touch(); } catch (e) { console.warn("[sb-board] 刷新失败", e); } }]);
  const m = document.createElement("div"); m.className = "sb-menu";
  m.innerHTML = items.map((it, i) => `<button class="mi" data-i="${i}">${esc(it[0])}</button>`).join("") + (src ? `<div class="mf">${esc(src)}</div>` : "");
  m.addEventListener("click", e => { e.stopPropagation(); const b = e.target.closest(".mi"); if (!b) return; closeMenu(); items[+b.dataset.i][1](); });
  tile.appendChild(m);
  document.addEventListener("pointerdown", menuDocDown, true);
  document.addEventListener("keydown", menuEsc, true);
}

// ---------- 展开层：⤢ 把一张卡放大成盖住整个看板的大窗（照 Kimi 的做法：遮罩压暗、约 140ms 淡入、关闭即时） ----------
const DETAIL_META = {
  today: { tag: "01 · today", name: "今天", skin: "" },
  xhs:   { tag: "02 · xiaohongshu", name: "小红书", skin: "dots" },
  route: { tag: "03 · ai route", name: "AI 学习路线", skin: "dark" },
  week:  { tag: "04 · this week", name: "本周", skin: "mint" },
  ideas: { tag: "05 · inbox", name: "灵感收件箱", skin: "" },
  news:  { tag: "06 · ai news", name: "今天 AI 圈", skin: "" },
};
const stat = (n, label) => `<div class="st"><b>${n}</b><span>${esc(label)}</span></div>`;
const secH = t => `<div class="sec-h">${esc(t)}</div>`;

function detailToday(D) {
  const t = D.today, left = t.total - t.done;
  const notes = (t.notes || []).length
    ? `<ul class="notes">${t.notes.map(n => `<li data-open="${esc(t.path)}">${esc(n)}</li>`).join("")}</ul>`
    : `<div class="muted">「随手记」下还没有内容</div>`;
  const tasks = t.exists && t.total ? renderList(t.items, "today-full", t.path, 200)
    : t.exists ? `<div class="muted link" data-open="${esc(t.path)}" data-line="${t.sectionLine}">「今日」下还没写任务，点这里去写</div>`
    : `<div class="muted">今天的文件还没建 <button class="btn" data-act="create-today">按模板新建今天</button></div>`;
  return `
    <div class="stats">${stat(left, "还剩")}${stat(t.done, "做完")}${stat(t.total, "共")}${stat(t.date.slice(5).replace("-", "."), t.weekday)}</div>
    <div class="cols"><div>${secH("今日")}${tasks}${carryLine(D.carry.today, "carry-today")}${jotBox("today")}</div><div>${secH("随手记")}${notes}</div></div>
    <div class="days-wrap">${secH("这一周")}${dayDots(D.days)}</div>`;
}

function detailWeek(D) {
  const w = D.week, days = D.days;
  const defined = days.filter(d => d.total).length;
  const cols = days.map((d, k) => {
    const now = d.date === ymd(TODAY);
    const body = d.state === "future" ? `<div class="muted">还没到</div>`
      : d.items && d.items.length ? renderList(d.items, "day-list", d.path, 80)
      : d.path ? `<div class="muted link" data-open="${esc(d.path)}">没定任务</div>`
      : `<div class="muted">没写</div>`;
    return `<div class="dc ${d.state}${now ? " now" : ""}"><div class="dh"><span>${"一二三四五六日"[k]}</span><span>${d.date.slice(5).replace("-", ".")}${d.total ? ` · ${d.done}/${d.total}` : ""}</span></div>${body}</div>`;
  }).join("");
  const list = !w.exists ? `<div class="muted">这周的文件还没建，下面写一条就建</div>`
    : !w.total ? `<div class="muted">计划之外还要做什么，下面写一条</div>`
    : renderList(w.items, "week-full", w.path, 200);
  const b = D.route.block, done = w.done + (b ? b.done : 0), total = w.total + (b ? b.total : 0);
  return `
    <div class="stats">${stat(`${done}<small>/ ${total}</small>`, "本周 · 做完")}${stat(w.daysLeft, "还有几天")}${stat(`${defined}<small>/ 7</small>`, "定了任务的天数")}${stat(esc(w.range), "日期")}</div>
    <div class="cols"><div>${planBlockHTML(D, "week-full plan-list", 200, false)}</div><div><div class="plan-h mine-h"><span class="lab">我加的</span></div>${list}${carryLine(D.carry.week, "carry-week")}${jotBox("week")}</div></div>
    ${secH("每天")}<div class="days7">${cols}</div>`;
}

function detailRoute(D) {
  const r = D.route, pct = r.total ? Math.round(r.done / r.total * 100) : 0, c = r.stations[r.cur];
  const stations = r.stations.map((s, i) => {
    const p = s.total ? Math.round(s.done / s.total * 100) : 0;
    const state = i === r.cur ? "on" : i < r.cur ? "past" : "todo";
    return `<div class="stn ${state}">
      <div class="sth" data-open="${esc(r.path)}" data-line="${s.line}"><b>${esc(s.label)}</b><span>${esc(s.title)}</span><span class="cnt">${s.done}/${s.total}</span></div>
      <div class="bar"><i style="width:${p}%"></i></div>
      ${s.items.length ? renderList(s.items, "stn-list", r.path, 200) : `<div class="muted">这一周下面没有任务行</div>`}
    </div>`;
  }).join("");
  return `
    <div class="stats">${stat(`${r.done}<small>/ ${r.total}</small>`, "total")}${stat(c ? esc(c.label) : "—", "now at")}${stat(`${pct}%`, "进度")}${stat(r.stations.length, "stops")}</div>
    ${stations || `<div class="muted">没在计划里找到「第 N 周 · 标题」的二级标题</div>`}`;
}

function detailXhs(D) {
  const x = D.xhs, td = D.todo;
  const cards = (x.projects || []).map(p => `<div class="pc" data-open="${esc(p.readme || p.path)}"><b>${esc(p.name)}</b><span>${p.days}d ago${p.status ? ` · ${esc(p.status)}` : ""}</span></div>`).join("");
  const planned = td.planned.length
    ? `<ul class="list planned">${td.planned.map(p => `<li class="todo" data-open="${esc(td.path)}" data-line="${p.line}"><span class="box static"></span><span class="txt">${esc(p.text)}</span></li>`).join("")}</ul>`
    : `<div class="muted">《${esc(baseName(V.todoPath))}》里还没有标「下一期」的句子</div>`;
  return `
    <div class="stats">${stat(x.total, "all")}${stat(x.finished.length, `${V.finishedDays} 天内收尾`)}${stat(x.doing.length, "进行中")}</div>
    ${secH("打算做")}${planned}
    <div class="pgrid-wrap">${secH("全部项目 · 按最近改动排序")}<div class="pgrid">${cards || `<div class="muted">文件夹里还没有项目</div>`}</div></div>`;
}

function detailIdeas(D) {
  const td = D.todo, all = td.all || [];
  const items = all.length
    ? `<ul class="ideas-full">${all.map(i => `<li data-open="${esc(td.path)}" data-line="${i.line}"><span class="when">${i.date || "·"}</span><span class="txt">${esc(i.text)}</span></li>`).join("")}</ul>`
    : `<div class="muted">还没有内容，先在下面记一笔</div>`;
  const latest = all.find(i => i.date);
  return `
    <div class="stats">${stat(td.total, "段")}${stat(latest ? latest.date : "—", "最近一条带日期的")}</div>
    ${items}
    ${jotBox("idea")}`;
}

function detailHTML(kind, D, src) {
  const m = DETAIL_META[kind]; if (!m) return "";
  const body = { today: detailToday, week: detailWeek, route: detailRoute, xhs: detailXhs, ideas: detailIdeas, news: detailNews }[kind](D);
  return `<div class="sb-backdrop" data-act="close-detail"></div>
    <section class="tile sb-sheet ${m.skin}" data-kind="${kind}" data-src="${esc(src.src || "")}" data-src-line="${esc(src.srcLine || "")}">
      <header class="sh"><span class="lab">${esc(m.tag)}</span><b>${esc(m.name)}</b><span class="sp"></span><button class="tb" data-act="more" title="更多">⋯</button><button class="tb" data-act="close-detail" title="关闭 (Esc)">✕</button></header>
      <div class="sbody">${body}</div>
    </section>`;
}

function closeDetail(root) {
  root.querySelectorAll(".sb-modal").forEach(m => m.remove());
  window.__sbDetail = null;
  const sc = root.closest(".markdown-preview-view"); if (sc) sc.classList.remove("sb-lock");
}
// 看板比一屏高（第三行资讯卡 + 番茄钟），大窗要盖住「现在看得见的这一屏」，并且开着时外面不滚
function placeModal(root) {
  const m = root.querySelector(".sb-modal"), sc = root.closest(".markdown-preview-view");
  if (!m || !sc) return;
  const top = Math.max(0, sc.getBoundingClientRect().top - root.getBoundingClientRect().top);
  m.style.top = top + "px"; m.style.bottom = "auto"; m.style.height = sc.clientHeight + "px";
  sc.classList.add("sb-lock");
}
// restore=true 是看板重画后把刚才开着的大窗原样放回来（不做淡入，滚动位置也回到原处）
function openDetail(root, kind, D, src, restore) {
  closeMenu();
  root.querySelectorAll(".sb-modal").forEach(m => m.remove());
  const m = document.createElement("div");
  m.className = "sb-modal" + (restore ? " in restore" : "");
  m.dataset.kind = kind; m.tabIndex = -1;
  m.innerHTML = detailHTML(kind, D, src || {});
  root.appendChild(m);
  placeModal(root);
  const body = m.querySelector(".sbody");
  if (restore && window.__sbDetail && window.__sbDetail.scroll) body.scrollTop = window.__sbDetail.scroll;
  window.__sbDetail = { kind, src: src || {}, scroll: body.scrollTop };
  bindModal(root, m);
  if (!restore) { void m.offsetWidth; m.classList.add("in"); } // 强制一次排版再加 in，淡入从初始态起步；不用 rAF，窗口没焦点时 rAF 可能不跑
  m.focus({ preventScroll: true });
  loadThumbs();
  refocusJot(m); // 放在 m.focus 之后，不然刚在大窗输入框回车、重画后焦点会被大窗本身抢走
}
function bindModal(root, m) {
  m.querySelectorAll(".jot input").forEach(bindJot);
  if (m.__sbBound) return; m.__sbBound = true;
  const body = m.querySelector(".sbody");
  body.addEventListener("scroll", () => { if (window.__sbDetail) window.__sbDetail.scroll = body.scrollTop; });
  m.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); closeDetail(root); } });
}

function bindJot(inp) {
  if (inp.__sbBound) return; inp.__sbBound = true; // 原位修补会留下原来的输入框，别重复绑、别把正在输的内容冲掉
  const kind = inp.closest(".jot")?.dataset.jot || "idea";
  window.__sbJot = window.__sbJot && typeof window.__sbJot === "object" ? window.__sbJot : {};
  inp.value = window.__sbJot[kind] || "";
  inp.addEventListener("input", () => { window.__sbJot[kind] = inp.value; const r = inp.closest(".sb-board"); if (r) r.__sbFocus = inp; }); // 正在打字的框也记成焦点所在（窗口没系统焦点时 focusin 不会发）
  inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submitJot(inp); } });
}

// ---------- 接过来：把最近一天 / 上周没做完的任务复制进今天 / 本周（原文件不动，条目不加标记） ----------
// kind = today：往前找最近一个「今日」下有任务的 daily；kind = week：上周一的 weekly
function collectCarry(kind, cur) {
  const have = new Set((cur.items || []).map(t => plain(t.text)));
  if (kind === "today") {
    for (let i = 1; i <= 30; i++) {
      const d = addDays(TODAY, -i), path = `${V.dailyDir}/${ymd(d)}.md`;
      if (!isFile(tfile(path))) continue;
      const day = collectDay(path);
      if (!day.total) continue;
      const seen = new Set(); // 同一条任务在那天的笔记里写了好几遍，只算一条
      const items = day.items.filter(t => { const k = plain(t.text); if (t.done || have.has(k) || seen.has(k)) return false; seen.add(k); return true; });
      return { from: path, date: ymd(d), label: i === 1 ? "昨天" : `${d.getMonth() + 1}.${d.getDate()} `, items, to: cur.path };
    }
    return null;
  }
  const prevMon = addDays(MON, -7), path = `${V.weeklyDir}/${ymd(prevMon)}.md`;
  if (!isFile(tfile(path))) return null;
  const r = sectionRange(path, h => /^本周要完成/.test(h.heading));
  const items = under(tasksOf(path), r).filter(t => !t.done && !have.has(plain(t.text)));
  return { from: path, date: ymd(prevMon), label: "上周", items, to: cur.path };
}

const carryLine = (c, act) => (!c || !c.items.length) ? ""
  : `<div class="carry">${esc(c.label)}还有 ${c.items.length} 条没做完<button class="lnk" data-act="${act}" title="复制到${act === "carry-today" ? "今天" : "本周"}的清单里，原文件不动">接过来</button></div>`;

// 把若干行插到某个标题管辖的段落末尾；模板留的空 `- [ ] ` 直接被第一条顶掉；没有这个标题就在文末补一个
function insertUnder(text, headRe, heading, lines) {
  const L = text.split("\n");
  const h = L.findIndex(l => headRe.test(l));
  if (h < 0) return text.replace(/\s*$/, "") + `\n\n## ${heading}\n\n${lines.join("\n")}\n`;
  const level = (L[h].match(/^#+/) || ["##"])[0].length;
  let end = L.length;
  for (let i = h + 1; i < L.length; i++) { const m = L[i].match(/^(#+)\s/); if (m && m[1].length <= level) { end = i; break; } }
  let last = -1;
  for (let i = h + 1; i < end; i++) if (L[i].trim() !== "") last = i;
  if (last >= 0 && /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s*$/.test(L[last])) L.splice(last, 1, ...lines);
  else if (last >= 0) L.splice(last + 1, 0, ...lines);
  else L.splice(h + 1, 0, "", ...lines);
  return L.join("\n");
}

// 把几行任务写进今天 daily 的「今日」/ 本周 weekly 的「本周要完成」；文件不存在就按模板建好再插
async function appendUnder(kind, lines) {
  const heading = kind === "today" ? "今日" : "本周要完成";
  const headRe = new RegExp(`^#{1,6}\\s*${heading}`);
  const path = kind === "today" ? `${V.dailyDir}/${ymd(TODAY)}.md` : `${V.weeklyDir}/${ymd(MON)}.md`;
  const f = tfile(path);
  if (isFile(f)) {
    await app.vault.process(f, text => insertUnder(text, headRe, heading, lines));
  } else {
    const tplPath = kind === "today" ? V.dailyTemplate : V.weeklyTemplate, dateStr = kind === "today" ? ymd(TODAY) : ymd(MON);
    const tpl = tfile(tplPath);
    let body = isFile(tpl) ? await app.vault.read(tpl) : (kind === "today" ? "## 今日\n\n- [ ] \n\n## 随手记\n" : "## 本周要完成\n\n- [ ] \n");
    body = body.replace(/{{\s*date[^}]*}}/g, dateStr).replace(/{{\s*title\s*}}/g, dateStr);
    await app.vault.create(path, insertUnder(body, headRe, heading, lines));
  }
}
async function carryTasks(root, kind, D) {
  const c = D.carry && D.carry[kind]; if (!c || !c.items.length) return;
  const lines = c.items.map(t => `- [ ] ${String(t.text).trim()}`);
  const target = kind === "today" ? `${V.dailyDir}/${ymd(TODAY)}.md` : `${V.weeklyDir}/${ymd(MON)}.md`; // 和 appendUnder 写的是同一篇
  if (c.from === target) { new Notice("看板还停在旧的一天，没有接过来。关掉看板再打开后再点一次"); try { dv.index.touch(); } catch (e) { /* 忽略 */ } return; }
  optimisticAdd(root, kind, c.items.map(t => String(t.text)));
  await appendUnder(kind, lines);
  root.querySelectorAll(`.carry .lnk[data-act="carry-${kind}"]`).forEach(b => { b.closest(".carry").textContent = `接过来了 ${lines.length} 条`; });
}

// ---------- 当场改屏幕：点勾 / 回车那一刻就把卡上的清单和数字改掉，2.5 秒后 Dataview 的重画只是悄悄对账 ----------
const numOf = el => parseInt((el && el.firstChild && el.firstChild.textContent) || (el && el.textContent) || "", 10);
const REDUCED = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
// 数字滚动：旧值翻出去、新值升进来，0.32s；减少时方向反过来。只在值真的变了时动。fmt 用来显示成 05 这种格式（番茄钟）
function rollTo(el, to, fmt) {
  const show = v => (fmt ? fmt(v) : String(v));
  const from = numOf(el);
  el.querySelectorAll(".num-old").forEach(o => o.remove());
  if (Number.isNaN(from) || from === to || REDUCED() || document.hidden) { el.textContent = show(to); return; }
  const dn = to < from;
  el.textContent = show(to);
  const old = document.createElement("span"); old.className = "num-old" + (dn ? " dn" : ""); old.textContent = show(from);
  el.appendChild(old);
  el.classList.remove("num-in-up", "num-in-dn"); void el.offsetWidth;
  el.classList.add(dn ? "num-in-dn" : "num-in-up");
  const clean = () => { old.remove(); el.classList.remove("num-in-up", "num-in-dn"); };
  old.addEventListener("animationend", clean, { once: true });
  setTimeout(clean, 700);
}
const readToday = root => { const lis = [...root.querySelectorAll(".today .today-list li")]; return { total: lis.length, done: lis.filter(l => l.classList.contains("done")).length }; };
const weekTotal = root => parseInt(((root.querySelector(".week .top .n small") || {}).textContent || "").replace(/[^\d]/g, ""), 10);
function setTodayBig(root, left, total) {
  if (!(total > 0)) return;
  const big = root.querySelector(".today .big"), hint = root.querySelector(".today .hint");
  const cur = big && big.querySelector('[data-num="today-left"]');
  if (cur && left > 0) { rollTo(cur, left); const sm = big.querySelector("small"); if (sm) sm.textContent = `共 ${total} 条`; }
  else if (big) big.innerHTML = left > 0 ? `还剩<b data-num="today-left">${left}</b>件<small>共 ${total} 条</small>` : `今天<b>清</b>了<small>${total} 条全做完</small>`;
  if (hint) hint.textContent = left > 0 ? `已完成 ${total - left} 条，先啃第一条` : "去定明天的三条";
}
function setWeekTop(root, done, total) {
  const n = root.querySelector(".week .top .n"), cur = n && n.querySelector('[data-num="week-done"]');
  if (cur) { rollTo(cur, done); const sm = n.querySelector("small"); if (sm) sm.textContent = `/ ${total} 做完`; }
  else if (n) n.innerHTML = `<span data-num="week-done">${done}</span><small>/ ${total} 做完</small>`;
  const l = root.querySelector(".week .top .left"); if (l) l.innerHTML = l.innerHTML.replace(/\d+ 条没动/, `${Math.max(0, total - done)} 条没动`);
}
function bumpRoute(root, d) { const el = root.querySelector('[data-num="route-done"]'); const n = numOf(el); if (el && !Number.isNaN(n)) rollTo(el, n + d); }
// 大窗开着时，顶上的统计块也跟着改
function setModalStats(root) {
  const m = root.querySelector(".sb-modal"); if (!m) return;
  const sts = m.querySelectorAll(".stats .st b");
  if (m.dataset.kind === "today" && sts.length >= 3) { const c = readToday(root); sts[0].textContent = c.total - c.done; sts[1].textContent = c.done; sts[2].textContent = c.total; }
  if (m.dataset.kind === "week" && sts[0]) { const n = numOf(root.querySelector('[data-num="week-done"]')), tot = weekTotal(root); if (!Number.isNaN(n) && !Number.isNaN(tot)) sts[0].innerHTML = `${n}<small>/ ${tot}</small>`; }
}
// 点了勾：同一条在卡上和大窗里的另一份也一起变，然后按它属于哪个文件改对应的数字
function afterTick(root, D, li) {
  const path = li.dataset.open, line = li.dataset.line, done = li.classList.contains("done"), d = done ? 1 : -1;
  root.querySelectorAll("li[data-open][data-line]").forEach(o => {
    if (o.dataset.open !== path || o.dataset.line !== line) return;
    if (o !== li) { o.classList.toggle("done", done); o.classList.toggle("todo", !done); }
    const b = o.querySelector("[data-toggle]"); if (b) b.title = done ? "改回未完成" : "标记完成"; // 提示文字也当场改成对账后的那句，不然 2.5 秒后会被换掉
  });
  // 这条是不是本周卡里学习计划块的一条，要在下面把它从卡上拿掉之前判断，不然卡上没了就查不到、本周数字不会当场动
  const inPlanBlock = path === D.route.path && [...root.querySelectorAll(".plan-list li")].some(o => o.dataset.line === line);
  // 本周「我加的」清单是没做完在上、做完在下（各自按文件顺序），勾了就当场挪到对账后的位置；卡上的学习计划块只列没勾的，勾了就当场拿掉
  root.querySelectorAll("li[data-open][data-line]").forEach(o => {
    if (o.dataset.open !== path || o.dataset.line !== line) return;
    const ul = o.parentElement;
    if (ul.matches(".week-list:not(.plan-list), .week-full:not(.plan-list)")) placeByStatus(ul, o);
    else if (ul.matches(".week .plan-list") && done) o.remove();
  });
  // 大窗里把学习计划的一条改回未完成：卡上的块按行号把它插回去
  if (!done && path === D.route.path && li.closest(".sb-modal .plan-list")) {
    const cardUl = root.querySelector(".week .plan-list");
    if (cardUl && ![...cardUl.children].some(x => x.dataset.line === line)) {
      const c = li.cloneNode(true); c.querySelector(".txt").textContent = cut(plain(li.querySelector(".txt").textContent), 38);
      cardUl.insertBefore(c, [...cardUl.children].find(x => +x.dataset.line > +line) || null);
    }
  }
  if (path === D.today.path) { const c = readToday(root); setTodayBig(root, c.total - c.done, c.total); }
  if (path === D.week.path || inPlanBlock) { const n = numOf(root.querySelector('[data-num="week-done"]')), tot = weekTotal(root); if (!Number.isNaN(n) && !Number.isNaN(tot)) setWeekTop(root, n + d, tot); }
  if (path === D.route.path) bumpRoute(root, d);
  setModalStats(root);
}
// 把一条放到"没做完在上、做完在下、组内按文件行号"的位置上
function placeByStatus(ul, li) {
  const done = li.classList.contains("done"), line = +li.dataset.line;
  const others = [...ul.children].filter(x => x !== li && x.tagName === "LI");
  const group = others.filter(x => x.classList.contains("done") === done);
  const next = group.find(x => x.classList.contains("pending") ? false : +x.dataset.line > line);
  if (next) ul.insertBefore(li, next);
  else if (done) ul.appendChild(li);
  else { const firstDone = others.find(x => x.classList.contains("done")); ul.insertBefore(li, firstDone || null); }
}
// 加了几条（回车 / 接过来）：先画到清单末尾，标成 pending（还没有行号，等对账后才能勾），数字跟着加
// 本周「我加的」清单是没做完在上、做完在下，新条目要插在第一条已勾的前面，和 2.5 秒后重画出来的位置一样，不然会往上跳一下
function insertAboveDone(ul, html) {
  const firstDone = ul.querySelector("li.done");
  if (firstDone) firstDone.insertAdjacentHTML("beforebegin", html); else ul.insertAdjacentHTML("beforeend", html);
}
function optimisticAdd(root, kind, texts) {
  if (!root || !texts.length) return;
  const lis = texts.map(t => `<li class="todo pending" title="刚加的，看板对账后才能勾"><span class="box static"></span><span class="txt">${esc(cut(plain(t), kind === "today" ? 48 : 44))}</span></li>`).join("");
  if (kind === "today") {
    const right = root.querySelector(".today .right"); if (!right) return;
    let ul = right.querySelector(".today-list");
    if (!ul) { ul = document.createElement("ul"); ul.className = "list today-list"; right.insertBefore(ul, right.querySelector(".carry, .jot")); }
    ul.insertAdjacentHTML("beforeend", lis);
    const full = root.querySelector(".sb-modal .today-full"); if (full) full.insertAdjacentHTML("beforeend", lis);
    const c = readToday(root); setTodayBig(root, c.total - c.done, c.total);
  } else {
    const sec = root.querySelector(".week .sections");
    if (sec) {
      let ul = sec.querySelector(".week-list:not(.plan-list)");
      if (!ul) { ul = document.createElement("ul"); ul.className = "list week-list"; const empty = sec.querySelector(".empty"); if (empty) empty.replaceWith(ul); else sec.insertBefore(ul, sec.querySelector(".carry")); }
      insertAboveDone(ul, lis);
    }
    const full = root.querySelector(".sb-modal .week-full:not(.plan-list)"); if (full) insertAboveDone(full, lis);
    const n = numOf(root.querySelector('[data-num="week-done"]')), tot = weekTotal(root);
    if (!Number.isNaN(n) && !Number.isNaN(tot)) setWeekTop(root, n, tot + texts.length);
  }
  setModalStats(root);
}

// ---------- B. 顶住重画的空白：Dataview 重画前会把旧看板整个拆掉、几十毫秒后新的才画好。这里盯着容器，旧看板一被拆就立刻放回去当占位，新看板画好后一步换掉 ----------
function armGhost(root) {
  const cont = root.parentElement; if (!cont) return;
  if (root.__sbGhostMO) root.__sbGhostMO.disconnect();
  let readds = 0;
  const mo = new MutationObserver(ms => {
    for (const m of ms) for (const n of m.removedNodes) {
      if (n !== root) continue;
      if (window.__sbGhostOff || !cont.isConnected || cont.querySelector(".sb-board") || readds >= 3) { mo.disconnect(); return; }
      readds++; root.classList.add("sb-ghost"); cont.appendChild(root);
      // 被拆下来的那一下，正在输入框里的光标会丢；放回去后立刻还给同一个元素
      const f = root.__sbFocus; if (f && root.contains(f) && document.activeElement !== f) { try { f.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ } }
      return;
    }
  });
  mo.observe(cont, { childList: true });
  root.__sbGhostMO = mo;
}
const findGhost = () => [...dv.container.children].find(x => x.classList && x.classList.contains("sb-board") && x.classList.contains("sb-ghost"));
function swapInRoot(root) {
  const ghost = findGhost();
  if (ghost && ghost.__sbGhostMO) ghost.__sbGhostMO.disconnect();
  if (ghost) ghost.replaceWith(root); else dv.container.appendChild(root);
}

// ---------- C. 原位修补：新画好的看板不整块换上去，而是和屏幕上这块逐节点比对，只改有差异的地方 ----------
// 没变的节点原样留着：鼠标正停着的那条不会被换掉（原生提示气泡不会闪一下）、清单滚进去的位置、输入框的光标都保得住。
// 匹配规则：任务行按「文件#行号」认，卡 / 大窗 / 输入框按 data-kind / data-jot 认，其余按同一标签名就近认；对不上的插新删旧。
const keyOf = n => n.nodeType !== 1 ? "" : n.tagName + "|" + (n.dataset.line != null && n.dataset.open ? n.dataset.open + "#" + n.dataset.line : n.dataset.kind || n.dataset.jot || n.dataset.num || "");
function morph(oldEl, newEl) {
  if (oldEl.nodeType !== 1) { if (oldEl.nodeValue !== newEl.nodeValue) oldEl.nodeValue = newEl.nodeValue; return; }
  for (const a of [...oldEl.attributes]) if (!newEl.hasAttribute(a.name)) oldEl.removeAttribute(a.name);
  for (const a of newEl.attributes) if (oldEl.getAttribute(a.name) !== a.value) oldEl.setAttribute(a.name, a.value);
  morphChildren(oldEl, newEl);
}
function morphChildren(oldEl, newEl) {
  const want = [...newEl.childNodes];
  want.forEach((n, i) => {
    const key = keyOf(n), cur = oldEl.childNodes[i];
    let match = null;
    for (let j = i; j < oldEl.childNodes.length; j++) { const c = oldEl.childNodes[j]; if (c.nodeType === n.nodeType && keyOf(c) === key) { match = c; break; } }
    if (!match) { oldEl.insertBefore(n, cur || null); return; } // 新树里的节点直接搬过来
    if (match !== cur) oldEl.insertBefore(match, cur || null);
    morph(match, n);
  });
  while (oldEl.childNodes.length > want.length) oldEl.lastChild.remove(); // 没对上的旧节点都被挤到了末尾
}

// ---------- 事件 ----------
function bind(root, D) {
  root.__sbD = D; // 原位修补后还是同一个 root，数据换新的，点击处理读这里
  if (!root.__sbBound) {
    root.__sbBound = true;
    root.addEventListener("click", e => onClick(root, root.__sbD, e));
    // 记住看板里最后一个拿到焦点的元素（重画拆下来再放回去时还给它）；焦点真的离开看板就忘掉，别把焦点从别处抢回来
    root.addEventListener("focusin", e => { root.__sbFocus = e.target; });
    root.addEventListener("focusout", e => { const t = e.target; queueMicrotask(() => { if (root.isConnected && t.isConnected && !root.contains(document.activeElement)) root.__sbFocus = null; }); });
  }
  root.querySelectorAll(".jot input").forEach(bindJot);
  refocusJot(root);
}
function onClick(root, D, e) {
  {
    const act = e.target.closest("[data-act]");
    if (act) {
      e.preventDefault();
      const name = act.dataset.act;
      if (name === "create-today") return createFromTemplate(root, `${V.dailyDir}/${ymd(TODAY)}.md`, V.dailyTemplate, ymd(TODAY));
      if (name === "create-week") return createFromTemplate(root, `${V.weeklyDir}/${ymd(MON)}.md`, V.weeklyTemplate, ymd(MON));
      if (name === "jot") { const inp = act.closest(".jot")?.querySelector("input"); if (inp) return submitJot(inp); }
      if (name === "expand") { const tile = act.closest(".tile"); return openDetail(root, tile.dataset.kind, D, { src: tile.dataset.src, srcLine: tile.dataset.srcLine }); }
      if (name === "close-detail") return closeDetail(root);
      if (name === "carry-today" || name === "carry-week") return carryTasks(root, name.slice(6), D);
      if (name === "more") return showMenu(root, act.closest(".tile"));
      if (name === "news-refresh") return runNews(root);
      if (name === "news-save") return saveNews(root, D, act);
      if (name === "pomo-toggle" || name === "pomo-reset") return pomoAct(name);
      return;
    }
    const box = e.target.closest("[data-toggle]");
    if (box) {
      e.preventDefault(); e.stopPropagation();
      const li = box.closest("[data-open]");
      li.classList.toggle("done"); li.classList.toggle("todo");
      afterTick(root, D, li);
      return toggleTask(li.dataset.open, +li.dataset.line, li.dataset.text);
    }
    // 资讯条目：在系统浏览器里打开（不进 Obsidian 的网页标签）
    const u = e.target.closest("[data-url]");
    if (u) { e.preventDefault(); try { window.require("electron").shell.openExternal(u.dataset.url); } catch (err) { window.open(u.dataset.url); } return; }
    const o = e.target.closest("[data-open]");
    if (o) { e.preventDefault(); return openAt(root, o.dataset.open, o.dataset.line != null ? +o.dataset.line : undefined); }
  }
}
// 刚在某个输入框回车过（5 秒内），看板重画后把焦点还给同一个框，能连着输
function refocusJot(scope) {
  const f = window.__sbJotFocus; if (!f || Date.now() - f.at > 5000) return;
  const inModal = !!scope.closest(".sb-modal") || scope.classList.contains("sb-modal");
  if (inModal !== f.inModal) return;
  const inp = scope.querySelector(`.jot[data-jot="${f.kind}"] input`);
  if (inp) { inp.placeholder = JOT_META[f.kind].done; inp.focus({ preventScroll: true }); window.__sbJotFocus = null; }
}

// 让看板撑满所在的面板；窄栏（侧栏）里不撑
function fitHeight(root, tries = 0) {
  const vc = root.closest(".view-content");
  if (!vc) { if (tries < 20) setTimeout(() => fitHeight(root, tries + 1), 100); return; }
  const apply = () => {
    const pw = root.parentElement ? root.parentElement.clientWidth : 0;
    const w = pw > 0 ? Math.min(vc.clientWidth, pw) : vc.clientWidth, h = vc.clientHeight;
    root.classList.toggle("narrow", w > 0 && w < V.narrowBelow);
    root.style.height = w >= V.narrowBelow && h > 0 ? Math.max(680, h) + V.row3 + 14 + "px" : "";
  };
  apply();
  // 也盯着看板自己：阅读模式下藏着的编辑视图里有一份宽度为 0 的看板，用户切到编辑模式时它从 0 变宽，这里顺手把视图切回阅读
  // 不直接盯 root：apply() 会改 root 的高度，盯自己会触发 "ResizeObserver loop" 警告；盯外层的编辑视图容器就够了
  const sv = root.closest(".markdown-source-view");
  const ro = new ResizeObserver(() => { if (!root.isConnected) { ro.disconnect(); return; } apply(); if (sv && sv.offsetWidth > 0) setTimeout(() => ensureReadingView(root), 0); }); // 切视图放到观察回调之外，否则浏览器报 ResizeObserver loop
  ro.observe(vc); if (sv) ro.observe(sv);
}

// 过了零点但没人改笔记时，Dataview 不会重画，看板会停在昨天。
// 每分钟看一眼日期，变了就碰一下 Dataview 索引（revision+1），它会在刷新间隔后自己重画。
function watchMidnight(root) {
  const day = ymd(TODAY);
  const t = setInterval(() => {
    if (!root.isConnected) { clearInterval(t); return; }
    const now = new Date(); now.setHours(0, 0, 0, 0);
    if (ymd(now) !== day) { clearInterval(t); try { dv.index.touch(); } catch (e) { console.warn("[sb-board] 跨日刷新失败", e); } }
  }, 60 * 1000);
}

// 看板只在阅读视图里排版。Homepage 打开时会强制阅读视图，但从文件列表 / 最近文件 / 搜索点开会落到编辑模式，
// 这里发现自己被渲染在编辑视图里，就把这一栏切回阅读视图（控制台设 window.__sbAllowEdit = true 可临时关掉，用来编辑这篇笔记）。
function ensureReadingView(el) {
  if (window.__sbAllowEdit) return false;
  if (!el.closest(".markdown-source-view")) return false;
  const leaf = app.workspace.getLeavesOfType("markdown").find(l => l.view?.containerEl?.contains(el));
  if (!leaf || leaf.view.getMode?.() !== "source") return false;
  const st = leaf.getViewState();
  leaf.setViewState({ ...st, state: { ...st.state, mode: "preview" } });
  return true;
}

// ---------- 主流程 ----------
async function main() {
  const D = {
    today: collectToday(), days: collectDays(), week: collectWeek(), route: await collectRoute(), xhs: collectXhs(), todo: await collectTodo(),
    generatedAt: new Date().toISOString(),
  };
  D.today.notes = await collectNotes(D.today.path);
  D.carry = { today: collectCarry("today", D.today), week: collectCarry("week", D.week) };
  D.news = collectNews();
  if (input && input.raw) {
    const pre = document.createElement("pre"); pre.className = "sb-raw";
    pre.textContent = JSON.stringify(D, null, 2);
    dv.container.appendChild(pre);
    return;
  }
  if (ensureReadingView(dv.container)) return; // 切视图后 Dataview 会在阅读视图里重新跑一遍这个脚本
  await ensureFonts();
  const fresh = document.createElement("div");
  fresh.className = V.news === false ? "sb-board no-news" : "sb-board";
  fresh.innerHTML = renderAll(D);
  // 代码版本戳：view.js / view.css 改过之后，旧看板上绑的还是旧代码的处理函数，这时不能修补复用，必须整块换新
  // 日期也算进去：点击处理是第一次整块画时绑上的，记着那天的「今天」。跨了天还修补复用，接过来 / 加一条会写回昨天的笔记
  const ver = ["view.js", "view.css"].map(n => { const f = tfile(P(`_dashboard/${n}`)); return f && f.stat ? f.stat.mtime : 0; }).join("-") + "-" + ymd(TODAY);
  fresh.dataset.sbVer = ver;
  const ghost = window.__sbNoMorph ? null : findGhost();
  if (ghost && ghost.dataset.sbVer === ver) {
    // 屏幕上还顶着重画前的旧看板：把新看板逐节点修补上去，旧看板继续当正主
    const det = window.__sbDetail;
    if (det) { const m = document.createElement("div"); m.className = "sb-modal in"; m.dataset.kind = det.kind; m.tabIndex = -1; m.innerHTML = detailHTML(det.kind, D, det.src || {}); fresh.appendChild(m); }
    morphChildren(ghost, fresh);
    ghost.classList.remove("sb-ghost");
    armGhost(ghost);
    bind(ghost, D);
    const m = ghost.querySelector(".sb-modal");
    if (m) { placeModal(ghost); bindModal(ghost, m); if (!m.contains(document.activeElement)) m.focus({ preventScroll: true }); refocusJot(m); }
    setTimeout(() => ensureReadingView(ghost), 300);
    startPomo(); watchNews(); loadThumbs(); maybeAutoNews(ghost, D.news);
    return;
  }
  const root = fresh;
  swapInRoot(root);
  armGhost(root);
  bind(root, D);
  fitHeight(root);
  watchMidnight(root);
  setTimeout(() => ensureReadingView(root), 300); // 容器刚才可能还没挂进 DOM，补查一次
  if (window.__sbDetail) openDetail(root, window.__sbDetail.kind, D, window.__sbDetail.src, true); // 重画前开着大窗，就原样放回去
  startPomo(); watchNews(); loadThumbs(); maybeAutoNews(root, D.news);
}

try { await main(); }
catch (e) {
  const pre = document.createElement("pre"); pre.className = "sb-error";
  pre.textContent = "看板出错：" + (e && e.stack || e);
  const g = findGhost(); if (g) g.remove();
  dv.container.appendChild(pre);
  console.error("[sb-board]", e);
}
