# 重建这份看板（换电脑 / 灾难恢复）

这份文档解决一个问题：**这台电脑坏了，怎么最快把这套东西搭回来。**

重点不是文件（核心文件才几百 KB），而是下面这些「不看文档就想不起来」的坑。
逐条核对，漏一条就会卡住。

---

## 0. 先装三样东西

| 软件 | 版本参考 | 说明 |
|---|---|---|
| [Obsidian](https://obsidian.md) | 任意较新版本 | 笔记与看板宿主 |
| Dataview 插件 | 0.5.68+ | Obsidian → 设置 → 第三方插件 → 浏览 → 搜 `Dataview` → 安装 → 启用 → **打开 `Enable JavaScript queries`** |
| [DeepSeek Harness (dsh)](https://github.com/deepseek-ai) | 0.2.2-rc.1 | **桌面应用，不是 npm 包**。装好后确认 `dsh --version` 有输出 |

> 上游原版还要 Node.js + Claude Code + macOS；dsh 版**不需要**这些。

---

## 1. 放文件

```
工作区/
├── dsh-obsidian-ai-task-dashboard/      ← 本仓库（代码）
│   ├── view.js / view.css / debug.md
│   ├── fonts/  news/  examples/  docs/
│   ├── refresh.ps1                     ← ↻ 刷新入口
│   └── bridge.ps1                      ← 双向桥接
└── demo-vault/                          ← 你的 vault（不提交，自己建或从备份恢复）
    ├── 看板.md
    ├── 给 dsh 的信.md
    ├── 与 dsh 对话.md
    └── _dashboard/                      ← 从仓库复制进来的
        ├── view.js / view.css / debug.md
        ├── fonts/  news/  config.json
        └── news-data/today.json
```

装进 vault 的 `_dashboard/` 就是把仓库里的 `view.js`、`view.css`、`debug.md`、`fonts/`、`news/`
拷过去；`examples/` 里的三个 md（`看板.md`、`给 dsh 的信.md`、`与 dsh 对话.md`）拷到 vault 根目录。

---

## 2. 配置 dsh（这步最容易漏）

### 2.1 装 provider 插件

```powershell
dsh plugin --profile headless add @anysearch/anysearch-dsh
```

> 为什么要 this？dsh headless 默认的 `web_fetch` 是裸 HTTP、没有浏览器指纹，
> 抓 YouTube 频道页会 `TypeError: fetch failed`。anysearch 能抓。

### 2.2 恢复被禁用的三个服务

编辑 `%USERPROFILE%\.dsh\profiles\headless\cordis.patch.yml`，**必须**包含：

```yaml
- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
```

> **漏了会怎样**：报 `configured web provider "anysearch" is not registered`，
> YouTube 抓不到。headless 模板默认禁用这三个（原本为了不依赖 GUI 登录态），
> 但 anysearch 依赖 `credentials` 服务。

### 2.3 配模型 provider 与默认模型

同一个 `cordis.patch.yml` 里加上（以 agens 为例，可换成任意 OpenAI 兼容网关）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      agens:
        displayName: agens
        apiKeyEnv: AGENS_API_KEY
        api: openai-completions
        baseURL: https://api.agnes-ai.cn/v1
        models:
          - id: agnes-3.0-flash
            name: agnes-3.0-flash
            maxTokens: 64000
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: agens
    model: agnes-3.0-flash
```

> 配置里**只写环境变量名**，不写密钥本身。

### 2.4 放密钥

`%USERPROFILE%\.dsh\.env`：

```
AGENS_API_KEY=你的密钥
```

> headless 的凭据查找顺序（官方行为）：启动环境变量 → `<命令运行目录>/.env` → `$DSH_HOME/.env`。
> **GUI 里保存的登录凭据 headless 不会用。**

---

## 3. 让脚本找到 dsh

`refresh.ps1` 不写死安装路径，按这个顺序找：

1. 环境变量 `DSH_CLI`
2. `PATH` 里的 `dsh.cmd` / `dsh`
3. 几个常见安装位置

找不到就报错并给出设置方法。推荐直接设一次环境变量：

```powershell
[Environment]::SetEnvironmentVariable('DSH_CLI','C:\你的路径\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd','User')
```

---

## 4. 六个必须知道的坑

| # | 坑 | 现象 | 解法 |
|---|---|---|---|
| 1 | **`.ps1` 必须 UTF-8 带 BOM** | PowerShell 5.1 按 GBK 解码，中文全乱、解析失败 | 用带 BOM 的编辑器保存；`edit`/`write` 类工具重写会丢 BOM，改完要补 |
| 2 | **执行策略** | `无法加载文件…禁止运行脚本` | 用 `powershell -NoProfile -ExecutionPolicy Bypass -File xxx.ps1`，不要直接 `& xxx.ps1` |
| 3 | **`dsh headless` 每次必然新建会话** | 会话列表越堆越多 | 官方无 ephemeral 模式，本项目用清理守护按快照差集删除 |
| 4 | **会话落到错误工作区** | GUI 里出现「未分组/其他工作区」 | `$psi.WorkingDirectory` 必须显式设置 |
| 5 | **删会话目录后 projcache 残留** | `~/.dsh/storages/session_projcache/` 无限增长 | 删目录后连带删同 id 的 `.json` |
| 6 | **`config.json` 的 `base` 前缀** | 7 张卡全空 | vault 根 ≠ 看板目录时，必须在 `config.json` 里写 `base` |

---

## 5. 验证清单

按顺序跑，每步都要通过：

- [ ] 打开 Obsidian，打开 vault，打开 `看板.md`
- [ ] 7 张卡都有内容（不是空白/「没有数据」）
- [ ] 打开 `给 dsh 的信.md`，在「## 我说」下加一行 `- 测试`，保存
- [ ] 跑 `powershell -NoProfile -ExecutionPolicy Bypass -File refresh.ps1 -Async`
- [ ] 等约 5~13 分钟，`_dashboard/news-data/today.json` 的 `generatedAt` 变新
- [ ] 看板「今天 AI 圈」卡出现内容，点 ↻ 能刷新
- [ ] **检查会话数**：`(Get-ChildItem "$env:USERPROFILE\.dsh\sessions" -Recurse -Directory -Filter 'session-*').Count` 刷新前后**不变**
- [ ] **检查 projcache**：`(Get-ChildItem "$env:USERPROFILE\.dsh\storages\session_projcache\sessions").Count` 也**不变**
- [ ] 双向：跑 `bridge.ps1 -Scan`，能看到你刚写的「测试」

---

## 6. 出问题时先查这几处

| 现象 | 查什么 |
|---|---|
| 报 `MISSING_CREDENTIAL` | `~/.dsh/.env` 里的 key 名是否与 `apiKeyEnv` 一致 |
| 报 `configured web provider "anysearch" is not registered` | `cordis.patch.yml` 里三个服务是否 `disabled: false` |
| 报 `找不到 dsh CLI` | 设 `DSH_CLI` 环境变量 |
| 点 ↻ 没反应 | `config.json` 里 `news` 是否为 `true`；`newsReadOnly` 是否被误加 |
| 卡全空白 | `config.json` 的 `base` 对不对；`_dashboard/` 是否真的在 vault 里 |
| 中文乱码 | `.ps1` 是不是丢了 BOM |
| 刷新跑了但 today.json 没变 | 看 `~/.dsh/sessions` 下最新会话日志里模型返回了什么 |

---

## 7. 上游信息

本项目 fork 自 [ziyu-llm/obsidian-ai-dashboard](https://github.com/ziyu-llm/obsidian-ai-dashboard)（MIT）。

上游用 macOS + Node + `claude -p` + launchd 刷新资讯；本版换成 Windows + `dsh headless`，
并解决了上面第 3~5 条那些会话与缓存问题。**两者不兼容，不要互相拉更新。**
