# dsh 版刷新入口（Windows）
# 由 Obsidian 看板「今天 AI 圈」的 ↻ 按钮调用：view.js 的 runNews() spawn 本脚本。
# 本脚本再 spawn `dsh headless` 一次性任务，让它用 dsh 自带工具完成
# 「抓 HN / X / 播客 / YouTube → 按 JSON Schema 总结 → 写 today.json」。
#
# 上游原版用 macOS + Node + `claude -p` + launchd；这里全部去掉，只用 dsh。
#
# 会话清理：跑完自动清掉本次 headless 产生的会话目录，避免列表堆积。
# 做法：启动前记录 ~/.dsh/sessions 下的会话目录快照；进程结束后由后台守护
# 找出「新增的那几个目录」并删除，同时清掉它们的投影缓存记录。
# 只删本次新增、绝不碰已有会话。不想要这个行为就加 -NoCleanup。
#
# 本脚本不写密钥、不建临时任务文件。密钥由 dsh headless 自己从
# ~/.dsh/.env 或启动环境读取，provider 配置在
# ~/.dsh/profiles/headless/cordis.patch.yml（详见 README 与 RESTORE.md）。
#
# 参数：
#   -Async      后台启动后立即返回（Obsidian 用这个，避免阻塞 UI）
#   -NoCleanup  调试用：跳过自动清理（默认会清理）
#   -Vault      你的 vault 目录（默认脚本旁边的 demo-vault）
#   -WorkDir    headless 的工作目录，决定会话归属哪个工作区（默认取 vault 的上级）
#   默认同步等待完成并返回 stdout（命令行手动测试用）

param(
  [switch]$Async,
  [switch]$NoCleanup,
  [string]$Vault = (Join-Path $PSScriptRoot 'demo-vault'),
  [string]$WorkDir
)

$ErrorActionPreference = 'Stop'

# ---- 找 dsh CLI ----
# 不写死安装路径（否则换台电脑就跑不了）。优先级：
#   1) 环境变量 DSH_CLI 显式指定
#   2) PATH 里的 dsh.cmd / dsh
#   3) 常见安装位置
# 全找不到就报错并给出设置方法，不静默降级。
$dsh = $env:DSH_CLI
if (-not $dsh) {
  $cmd = Get-Command dsh.cmd -ErrorAction SilentlyContinue
  if (-not $cmd) { $cmd = Get-Command dsh -ErrorAction SilentlyContinue }
  if ($cmd) { $dsh = $cmd.Source }
}
if (-not $dsh) {
  foreach ($guess in @(
    'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
  )) {
    if ($guess -and (Test-Path -LiteralPath $guess)) { $dsh = $guess; break }
  }
}
if (-not $dsh -or -not (Test-Path -LiteralPath $dsh)) {
  throw @"
找不到 dsh CLI。请任选一种方式指定：
  1) 设置环境变量 DSH_CLI 指向 dsh.cmd，例如：
       [Environment]::SetEnvironmentVariable('DSH_CLI','C:\path\to\dsh.cmd','User')
  2) 把 dsh 加到 PATH
  3) 用 -DshCli 参数显式传入（见下）
dsh 是 DeepSeek Harness 的桌面应用，不是 npm 包。
"@
}

$newsDir = Join-Path $Vault '_dashboard\news-data'
$todayPath = Join-Path $newsDir 'today.json'

# 上游 fetch.mjs 只用作 SCHEMA / prompt 风格的参考，取第一个存在的即可。
# 发布版在仓库根 news/ 下；装进 vault 后在 <vault>/_dashboard/news/ 下。
$upstream = $null
foreach ($cand in @(
  (Join-Path $PSScriptRoot 'news\fetch.mjs'),
  (Join-Path $Vault '_dashboard\news\fetch.mjs')
)) {
  if (Test-Path -LiteralPath $cand) { $upstream = $cand; break }
}

if (-not (Test-Path -LiteralPath $newsDir)) {
  throw "找不到资讯数据目录：$newsDir（先确认 `$Vault` 指向你的 vault，且里面已有 `_dashboard/news-data`）"
}

# 会话归属由 headless 进程的 cwd 决定。不显式设置的话，子进程会继承
# Obsidian spawn 时的 cwd（= vault 本身），dsh 就会在 sessions 下新建一个
# 对应 vault 的工作区目录，而它通常不在 workspace.json 的注册表里，
# GUI 里显示成「未分组/其他工作区」，同时清理守护也容易漏删。
# 所以这里把 cwd 固定到一个稳定目录。
# 优先级：-WorkDir 参数 > $Vault 的上层（若 vault 嵌在项目里）> $Vault 本身
$wsRoot = $WorkDir
if (-not $wsRoot) {
  $parent = Split-Path $Vault -Parent
  if ($parent -and (Test-Path -LiteralPath $parent)) { $wsRoot = $parent } else { $wsRoot = $Vault }
}
if (-not (Test-Path -LiteralPath $wsRoot)) { $wsRoot = $Vault }

# 清理守护扫描 sessions 下所有工作区目录（而不是猜某一个名字），
# 这样无论 headless 的 cwd 把会话落到哪个工作区，都能被差集找出来。
$sessionsRoot = Join-Path $env:USERPROFILE '.dsh\sessions'
if (-not (Test-Path -LiteralPath $sessionsRoot)) {
  throw "找不到 dsh 会话根目录：$sessionsRoot（dsh 是否装好并至少跑过一次？）"
}

# 启动前快照：记录所有工作区目录下已有的会话（绝对路径）
$snapshot = @(Get-ChildItem -LiteralPath $sessionsRoot -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue } |
  ForEach-Object { $_.FullName })

# 让脚本自己算时间，不让模型猜（否则 dsh 可能写一个过时的时间戳）。
$now = Get-Date
$dateStr = $now.ToString('yyyy-MM-dd')
$isoStr = $now.ToString('yyyy-MM-ddTHH:mm:sszzz')

$upstreamHint = if ($upstream) {
  "2. 参考 $upstream 里的 SCHEMA 与 prompt 风格（可用 read 工具读），把内容整理成中文："
} else {
  "2. 按下述字段结构把内容整理成中文："
}

$task = @"
你是 obsidian-ai-dashboard 的资讯整理 agent。请完成一次资讯刷新，严格按下面步骤：

本次刷新的固定值（必须原样使用，不要自己推算）：
- date = $dateStr
- generatedAt = $isoStr

1. 用 web_fetch 抓这四个源（哪个失败就跳过并在结果里注明，不要中断）：
   - HN Algolia 首页：https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=60
   - X / 播客：https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json 与 feed-podcasts.json
   - YouTube 频道页（能抓到几个算几个）：https://www.youtube.com/@mattpocockuk/videos 、/@nateherk/videos 、/@GregIsenberg/videos
$upstreamHint
   headlines(3-5 条，按多来源合并排序) / youtube / x.topics / podcasts / hn(最多 5 条) / sources / llm。
   中文用直白口语，不确定的不要编。视频与播客的 gist、title_zh、「选题/学」判断由你写。
3. 读现有的 $todayPath，保留其中仍有效的字段结构；把新结果合并进去：
   - date 原样写上面的固定值，generatedAt 原样写上面的固定值，不要改、不要重新计算
   - 保留 v:1 与字段名不变，各数组长度上限沿用上游：headlines 5 / x.topics 5 / hn 5 / youtube 20 / podcasts 6
   - 在 _note 里写明本次实际抓到了哪些源、哪些失败
4. 用 write 工具把结果写回 $todayPath（UTF-8，合法 JSON）。写完用 read 回读确认 JSON 合法。
5. 最后只回复一行：已更新 today.json（要闻 N 条，YouTube N 条，HN N 条）。

注意：不要修改除了 $todayPath 之外的任何文件。
"@

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:ComSpec   # cmd.exe，dsh.cmd 是批处理需要由它启动
$psi.Arguments = '/c ""' + $dsh + '" headless --approval-policy never --permission-mode workspace-write --add-dir "' + $Vault + '" -"'
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true   # 任务文本从这里送进去
$psi.CreateNoWindow = $true
$psi.WorkingDirectory = $wsRoot      # [修复] 显式 cwd，决定会话归属哪个工作区

if (-not $Async) {
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
}

$p = New-Object System.Diagnostics.Process
$p.StartInfo = $psi
$null = $p.Start()
$childPid = $p.Id

# 把任务写进子进程 stdin 后关闭，headless 的 `-` 会把它当作 task。
# Windows PowerShell 5.1 的 ProcessStartInfo 没有 StandardInputEncoding，
# 直接把 UTF-8（无 BOM）字节写进 BaseStream，避免中文经 cmd 传参乱码。
$utf8 = [System.Text.UTF8Encoding]::new($false)
$bytes = $utf8.GetBytes($task)
$p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
$p.StandardInput.BaseStream.Flush()
$p.StandardInput.BaseStream.Close()

# ---- 会话清理逻辑 ----
# 用一段独立的后台 PowerShell 完成：等 headless 退出 → 找出新增会话目录 → 只删新增的。
# 用 -Async 时父进程会立刻返回，守护进程仍独立存活（不依赖父进程）。
# 守护脚本写在 $env:TEMP 下，是自己产生的唯一临时文件，用完自删。
# [修复] 扫描 sessionsRoot 下所有工作区目录，而不是只盯一个，
# 这样即使 headless 的 cwd 把它落到别的工作区目录，也能被差集找出来删掉。
if (-not $NoCleanup) {
  $snapshotArg = ($snapshot -join '|')
  $guard = Join-Path $env:TEMP ("dsh-news-cleanup-{0}.ps1" -f [guid]::NewGuid().ToString('N').Substring(0,8))
  $guardBody = @'
param([int]$Pid2, [string]$SessionsRoot, [string]$SnapshotJoined, [string]$SelfPath)
$ErrorActionPreference = 'SilentlyContinue'
# 等 headless 进程结束（最多 15 分钟）
$proc = Get-Process -Id $Pid2 -ErrorAction SilentlyContinue
if ($proc) { $proc.WaitForExit(900000) | Out-Null }
Start-Sleep -Seconds 2
# 只删「快照之后新增」的会话目录，且必须是 session-* 目录
$before = @($SnapshotJoined -split '\|' | Where-Object { $_ })
$after = @(Get-ChildItem -LiteralPath $SessionsRoot -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue } |
  ForEach-Object { $_.FullName })
$new = @($after | Where-Object { $_ -notin $before -and (Split-Path $_ -Leaf) -like 'session-*' })
# [新增] 删会话目录的同时，清掉它在投影缓存里的记录
# （<dsh>\.dsh\storages\session_projcache\sessions\<会话id>.json）。
# 原因：投影缓存是列表读取用的加速副本，删掉会话目录后它不会自动消失，
# 会留下一条约 7 KB 的孤儿 json，每点一次刷新就多一条、永久累积。
# 缓存可由会话日志重建，删掉不影响任何存活会话。
# 只有在确认目录真的删掉了之后才删缓存，避免出现「目录还在、缓存没了」。
$projCacheDir = Join-Path (Split-Path $SessionsRoot -Parent) 'storages\session_projcache\sessions'
foreach ($d in $new) {
  $leaf = Split-Path $d -Leaf
  Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $d)) {
    $cacheFile = Join-Path $projCacheDir ($leaf + '.json')
    if (Test-Path -LiteralPath $cacheFile) {
      Remove-Item -LiteralPath $cacheFile -Force -ErrorAction SilentlyContinue
    }
  }
}
# 清理后如果某个工作区目录因此变空、且看起来是 demo-vault 衍生的（未注册工作区），一并移走，
# 免得 GUI 里留下「未分组」的空工作区条目。
foreach ($ws in @(Get-ChildItem -LiteralPath $SessionsRoot -Directory -ErrorAction SilentlyContinue)) {
  $wsDirs = @(Get-ChildItem -LiteralPath $ws.FullName -Directory -ErrorAction SilentlyContinue)
  $wsFiles = @(Get-ChildItem -LiteralPath $ws.FullName -File -ErrorAction SilentlyContinue)
  if ($wsDirs.Count -eq 0 -and $wsFiles.Count -eq 0 -and $ws.Name -match 'demo-vault') {
    Remove-Item -LiteralPath $ws.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}
# 守护脚本自删
Remove-Item -LiteralPath $SelfPath -Force -ErrorAction SilentlyContinue
'@
  [System.IO.File]::WriteAllText($guard, $guardBody, (New-Object System.Text.UTF8Encoding($true)))
  $gp = New-Object System.Diagnostics.ProcessStartInfo
  $gp.FileName = 'powershell.exe'
  $gp.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $guard + '" -Pid2 ' + $childPid + ' -SessionsRoot "' + $sessionsRoot + '" -SnapshotJoined "' + $snapshotArg + '" -SelfPath "' + $guard + '"'
  $gp.UseShellExecute = $false
  $gp.CreateNoWindow = $true
  $g = New-Object System.Diagnostics.Process
  $g.StartInfo = $gp
  $null = $g.Start()
}

if ($Async) {
  # 后台：不等待、不读输出流。父进程必须确认子进程已接管 stdin 再退出，
  # 否则 stdin 缓冲区可能随父进程一起被丢弃（实测踩过）。
  Start-Sleep -Milliseconds 1500
  if ($p.HasExited) {
    Write-Output ("资讯刷新进程异常退出，code=" + $p.ExitCode)
    return
  }
  Write-Output "已启动资讯刷新（后台，PID=$($p.Id)，本次会话日志将在完成后自动清理）"
  return
}

$stdout = $p.StandardOutput.ReadToEnd()
$stderr = $p.StandardError.ReadToEnd()
$p.WaitForExit()
if ($stderr) { Write-Output ("[stderr] " + ($stderr -replace 'sk-[A-Za-z0-9]+','sk-***')) }
Write-Output $stdout
exit $p.ExitCode
