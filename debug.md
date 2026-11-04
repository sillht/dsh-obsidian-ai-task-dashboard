---
cssclasses:
  - dashboard-debug
---

看板的数据层原样输出，用来和 vault 文件逐条核对。正式看板在根目录 `看板.md`。

```dataviewjs
await dv.view("_dashboard", { raw: true })
```
