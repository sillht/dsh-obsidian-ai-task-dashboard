#!/usr/bin/env node
/* demo/make-demo.mjs — 生成一个装满虚构内容的演示 vault，用来截图、录屏，或者先看看看板长什么样。
   用法：node demo/make-demo.mjs                       生成到仓库根目录的 demo-vault/
        node demo/make-demo.mjs --out=<文件夹>         生成到别处（仓库放在某个 vault 里时必须指定，免得演示笔记混进那个 vault）
        node demo/make-demo.mjs --refresh              已经生成过，按今天的日期刷新演示笔记
        node demo/make-demo.mjs --from-vault=<路径>    顺便从你的 vault 复制 Dataview 插件和外观设置（只读那个 vault）
   安全规则：这个脚本不删除任何文件。它只写进自己生成的文件夹；刷新时只覆盖自己上次写的、之后没被改过的文件，
   被人改过的（比如有人在演示库里写了真实笔记）一律跳过并列出来。 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = new Set(process.argv.slice(2).filter(a => !a.includes("=")));
const ARGV = Object.fromEntries(process.argv.slice(2).filter(a => a.includes("=")).map(a => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const OUT = path.resolve(ARGV.out || path.join(REPO, "demo-vault"));
const MARK = path.join(OUT, ".made-by-make-demo.json"); // 记着脚本写过的每个文件和它的指纹

// 保护 1：输出位置在某个 vault 里面（比如仓库按 README 装成了 _dashboard），演示笔记会混进那个 vault，拒绝
const inVault = dir => { for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) if (fs.existsSync(path.join(d, ".obsidian"))) return d; return null; };
const host = inVault(path.dirname(OUT));
if (host) { console.error(`生成位置 ${OUT} 在 vault「${host}」里面，演示笔记会混进去。请用 --out= 指定一个 vault 外面的文件夹，比如 --out=$HOME/ai-dashboard-demo`); process.exit(1); }
// 保护 2：已有内容、但不是这个脚本生成的文件夹（没有记录文件），可能是真实笔记，一个字都不写
const exists = fs.existsSync(OUT) && fs.readdirSync(OUT).length > 0;
if (exists && !fs.existsSync(MARK)) { console.error(`${OUT} 已经有内容，但不是这个脚本生成的。为了不碰到真实笔记，不往里写。请换一个空文件夹。`); process.exit(1); }
// 保护 3：生成过的文件夹，不加 --refresh 不动
if (exists && !ARGS.has("--refresh")) { console.error(`${OUT} 已经生成过。要按今天的日期刷新演示笔记，加 --refresh。`); process.exit(1); }

const sha = buf => crypto.createHash("sha1").update(buf).digest("hex");
const manifest = (() => { try { return JSON.parse(fs.readFileSync(MARK, "utf8")).files || {}; } catch { return {}; } })();
const skipped = [];
// 唯一的写文件入口：新文件直接写；已存在的文件只有「上次就是脚本写的、内容没被改过」才覆盖
function put(rel, data) {
  const p = path.join(OUT, rel), buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (fs.existsSync(p) && manifest[rel] !== sha(fs.readFileSync(p))) { skipped.push(rel); return null; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf); manifest[rel] = sha(buf); return p;
}
const copyDir = (src, rel, skip = () => false) => { for (const e of fs.readdirSync(src, { withFileTypes: true })) { if (skip(e.name)) continue; const s = path.join(src, e.name); if (e.isDirectory()) copyDir(s, `${rel}/${e.name}`, skip); else put(`${rel}/${e.name}`, fs.readFileSync(s)); } };

const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const md = d => `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const MON = addDays(TODAY, -((TODAY.getDay() + 6) % 7));

const write = (rel, text) => put(rel, text.replace(/^\n/, ""));
const task = (done, text) => `- [${done ? "x" : " "}] ${text}`;

// ---------- 看板代码：从仓库复制一份 ----------
for (const f of ["view.js", "view.css", "debug.md"]) put(`_dashboard/${f}`, fs.readFileSync(path.join(REPO, f)));
copyDir(path.join(REPO, "fonts"), "_dashboard/fonts");
copyDir(path.join(REPO, "news"), "_dashboard/news", n => n === "persona.md");
// 演示库用缺省路径；资讯只读，不会用演示内容去更新 ~/.secondbrain-news 里的真实数据
write("_dashboard/config.json", JSON.stringify({ newsReadOnly: true }, null, 2) + "\n");
write("看板.md", fs.readFileSync(path.join(REPO, "examples/看板.md"), "utf8"));
write("templates/daily.md", "## 今日\n\n- [ ] \n\n## 随手记\n\n");
write("templates/weekly.md", "## 本周要完成\n\n- [ ] \n");

// ---------- 今天 + 这周之前的几天 ----------
const days = [
  ["整理上周收藏的 AI 资讯，挑 3 条值得学的", "给新视频列大纲"],
  ["跑通一个最小的 RAG 例子", "回复评论区的问题", "看完一期 Agent 设计的播客"],
  ["写评测用的 10 道测试题", "拍新视频的口播"],
  ["对比两个模型在测试题上的回答", "剪辑新视频的中段"],
  ["整理这周的学习笔记", "发一条短视频预告"],
  ["复盘这周的数据", "看两篇 Hacker News 上的讨论"],
];
for (let d = new Date(MON), k = 0; d < TODAY; d = addDays(d, 1), k++) {
  const items = days[k % days.length];
  const half = k === 1; // 留一天没做完，日历上能看到「没做完」的样子
  write(`daily/${ymd(d)}.md`, `## 今日\n\n${items.map((t, i) => task(!(half && i === items.length - 1), t)).join("\n")}\n\n## 随手记\n\n`);
}
write(`daily/${ymd(TODAY)}.md`, `
## 今日

${task(false, "读完一篇讲 RAG 的长文，记下三个能用的技巧")}
${task(false, "剪下一期视频的开头 30 秒")}

## 随手记

`);

write(`weekly/${ymd(MON)}.md`, `
## 本周要完成

${task(false, "发一期 Obsidian 看板的视频")}
${task(false, "把评测这一站的笔记整理成一篇长文")}
`);

// ---------- AI 学习路线：通用的 AI 应用工程 6 周路线，进度停在「评测」 ----------
write("learning/plan.md", `
# AI 应用工程 · 6 周路线

## 第 0 周 · 大模型基础

${task(true, "搞懂 token、上下文窗口、温度这几个词")}
${task(true, "读一篇讲 Transformer 的入门文章")}
${task(true, "用自己的话写一页「大模型是怎么回答问题的」")}

## 第 1 周 · 调用 API

${task(true, "注册 API，跑通第一次调用")}
${task(true, "试一遍流式输出和结构化输出")}
${task(true, "写一个能连续对话的命令行小程序")}

## 第 2 周 · RAG

${task(true, "把 20 篇笔记切块、做向量化")}
${task(true, "做一个能按笔记回答问题的小助手")}
${task(true, "对比切块大小对回答的影响")}
${task(true, "写一篇踩坑记录")}

## 第 3 周 · Agent

${task(true, "读懂「循环调用工具」这个最小结构")}
${task(true, "手写一个能查天气、能算数的小 agent")}
${task(true, "给 agent 加上失败重试")}
${task(true, "录一期边做边讲的视频")}

## 第 4 周 · 评测

${task(true, "读一篇讲 LLM 评测方法的综述")}
${task(true, "看看别人是怎么用模型给模型打分的")}
${task(false, "给自己的 RAG 小助手写 20 道测试题")}
${task(false, "跑一遍自动评分，改一处再跑，对比分数")}

## 第 5 周 · 部署上线

${task(false, "把小助手做成网页")}
${task(false, "部署到免费的云服务")}
${task(false, "加上用量和费用的记录")}

## 第 6 周起 · 作品集与复盘

${task(false, "整理三个项目写进作品集")}
${task(false, "写一篇 6 周学习复盘")}
${task(false, "定下一阶段的方向")}
`);

// ---------- 小红书：项目文件夹 + README 里的 status；用修改时间区分「最近刚收尾」 ----------
const projects = [
  ["Obsidian 看板", "写脚本中", 0],
  ["AI 编程入门", "剪辑中", 2],
  ["AI 资讯不焦虑", "已完成", 6],
  ["零基础搭 RAG", "已完成", 15],
];
for (const [name, status, ago] of projects) {
  const files = [
    write(`xiaohongshu/${name}/README.md`, `---\nstatus: ${status}\n---\n\n# ${name}\n\n（演示内容）\n`),
    write(`xiaohongshu/${name}/脚本.md`, `# ${name} · 脚本\n\n（演示内容）\n`),
  ];
  const t = addDays(new Date(), -ago);
  for (const f of files) if (f) fs.utimesSync(f, t, t);
}

// ---------- 灵感收件箱 ----------
write("To-do & inspiration.md", `
- [ ] 下一期：用 Obsidian 做一个 AI 资讯看板

${md(addDays(TODAY, -6))}
想做一期「AI 工具太多怎么选」，用三个问题帮零基础的人筛选。

${md(addDays(TODAY, -4))}
看到有人用 agent 自动整理会议记录，可以拆成一期边做边教。

${md(addDays(TODAY, -2))}
评测这件事普通人也用得上：同一个问题问三个模型，怎么判断谁答得好。

${md(addDays(TODAY, -1))}
番茄钟 + 看板的组合，可以单独拍一条短视频。
`);

// ---------- 可选：从已有 vault 复制 Dataview 插件和外观（只复制设置，不碰笔记） ----------
if (ARGV["from-vault"]) {
  const src = path.join(path.resolve(ARGV["from-vault"]), ".obsidian");
  copyDir(path.join(src, "plugins/dataview"), ".obsidian/plugins/dataview");
  put(".obsidian/community-plugins.json", JSON.stringify(["dataview"], null, 2));
  if (fs.existsSync(path.join(src, "appearance.json"))) put(".obsidian/appearance.json", fs.readFileSync(path.join(src, "appearance.json")));
}

fs.writeFileSync(MARK, JSON.stringify({ note: "这个文件夹由 demo/make-demo.mjs 生成，是演示库，不要在里面写真实笔记。下面是脚本写过的文件和指纹，刷新时据此判断哪些没被改过。", files: manifest }, null, 1));
if (skipped.length) console.log(`这些文件被改过，没有覆盖：\n  ${skipped.join("\n  ")}`);
console.log(`演示 vault 已生成：${OUT}`);
console.log("在 Obsidian 里选「打开本地仓库」打开这个文件夹，再打开根目录的「看板」。");
if (!ARGV["from-vault"]) console.log("如果还没装 Dataview：设置 → 第三方插件 → 浏览，搜 Dataview 安装并启用，再打开它的 Enable JavaScript queries。");
