---
cssclasses:
  - dashboard
---

# 与 dsh 对话

> [!tip] 双向演示
> 在 [[给 dsh 的信]] 的「我说」下写一行，dsh 处理后会把回复写回那篇信，也会把 `待办：` 开头的输入加进 [[看板]] 的「今天」卡。
> 这一页只读地展示「我们聊过什么」。

```dataviewjs
const p = dv.page("给 dsh 的信.md");
if (!p) { dv.paragraph("没找到「给 dsh 的信」"); return; }
const raw = await app.vault.cachedRead(app.vault.getAbstractFileByPath("给 dsh 的信.md"));
const lines = raw.split("\n");
const start = lines.findIndex(l => /^##\s+dsh 回复\s*$/.test(l));
dv.header(2, "对话记录");
if (start < 0 || !lines.slice(start + 1).some(l => l.includes("**我说**"))) {
  dv.paragraph("还没有对话。去 [[给 dsh 的信]] 写一句试试。");
} else {
  const items = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s+/.test(l)) break;
    const q = l.match(/^>\s*\*\*我说\*\*：(.+?)\s*$/);
    if (q) { cur = { q: q[1], a: [] }; items.push(cur); continue; }
    const a = l.match(/^>\s*\*\*dsh\*\*：(.+?)\s*$/);
    if (a && cur) cur.a.push(a[1]);
  }
  for (const it of items) {
    dv.paragraph(`**🧑 我**：${it.q}`);
    dv.paragraph(`**🤖 dsh**：${it.a.join(" ")}`);
    dv.paragraph("---");
  }
}

dv.header(2, "今天还没做完");
const today = new Date();
const pad = n => String(n).padStart(2, "0");
const key = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
const dp = dv.page(`daily/${key}.md`);
if (dp && dp.file && dp.file.tasks) {
  const undone = dp.file.tasks.where(t => t.status !== "x" && t.status !== "X" && String(t.text || "").trim() !== "");
  if (undone.length) dv.taskList(undone, false);
  else dv.paragraph("今天的事全做完了 🎉");
} else {
  dv.paragraph("今天的日记还没建。");
}
```
