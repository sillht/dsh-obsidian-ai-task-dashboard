# A 方案双向桥接脚本（Windows 自带 PowerShell，无需安装任何东西）
#
# 设计：dsh 在回路里，脚本只做「搬运」，不假装成 AI。
#   -Scan                 输出「我说」里还没回复的消息（JSON），交给 dsh 读
#   -Apply -ReplyFile p   把 dsh 写好的回复 JSON 写回信 + 把「待办：」加进今天的日记
#
# 幂等：已回复的消息按原文去重，不会重复写；待办也按文字去重。
# 用法示例见 Projects/obsidian-ai-dashboard/README.md

param(
  [switch]$Scan,
  [switch]$Apply,
  [string]$ReplyFile,
  [string]$Vault = (Join-Path $PSScriptRoot 'demo-vault')
)

$ErrorActionPreference = 'Stop'
$letter = Join-Path $Vault '给 dsh 的信.md'

function Read-Utf8([string]$p) { [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) }
function Write-Utf8([string]$p, [string]$s) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($p, $s, $enc)
}

if (-not (Test-Path -LiteralPath $letter)) { throw "找不到信件文件：$letter" }
$text = Read-Utf8 $letter

# 取「## 我说」到下一个二级标题之间的行
$lines = $text -split "`r?`n"
$start = -1; $end = $lines.Count
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($start -lt 0 -and $lines[$i] -match '^##\s+我说\s*$') { $start = $i; continue }
  if ($start -ge 0 -and $i -gt $start -and $lines[$i] -match '^##\s+') { $end = $i; break }
}
if ($start -lt 0) { throw '信里没有「## 我说」段落' }

$spoken = @()
for ($i = $start + 1; $i -lt $end; $i++) {
  $m = [regex]::Match($lines[$i], '^\s*[-*+]\s+(.+?)\s*$')
  if ($m.Success) { $spoken += $m.Groups[1].Value }
}

# 已回复的原文：从「## dsh 回复」段落里已有的 > 引用行提取
$repliedSet = @{}
$rStart = -1
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^##\s+dsh 回复\s*$') { $rStart = $i; break } }
if ($rStart -ge 0) {
  for ($i = $rStart + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^##\s+') { break }
    $m = [regex]::Match($lines[$i], '^>\s*\*\*我说\*\*：(.+?)\s*$')
    if ($m.Success) { $repliedSet[$m.Groups[1].Value] = $true }
  }
}

$pending = @($spoken | Where-Object { -not $repliedSet.ContainsKey($_) })

if ($Scan) {
  $out = [ordered]@{
    vault      = $Vault
    letter     = $letter
    pending    = @($pending)
    spokenTotal = $spoken.Count
    repliedTotal = $repliedSet.Count
  }
  $out | ConvertTo-Json -Depth 5
  return
}

if (-not $Apply) { throw '请指定 -Scan 或 -Apply' }
if (-not $ReplyFile -or -not (Test-Path -LiteralPath $ReplyFile)) { throw "找不到回复文件：$ReplyFile" }
$replies = (Read-Utf8 $ReplyFile | ConvertFrom-Json)

# ---- 1) 组装回复块 ----
$now = Get-Date -Format 'yyyy-MM-dd HH:mm'
$blocks = @()
foreach ($r in $replies) {
  $q = [string]$r.q
  $a = [string]$r.a
  if (-not $q -or -not $a) { continue }
  if ($repliedSet.ContainsKey($q)) { continue }
  $blocks += "> **我说**：$q`n>`n> **dsh**：$a`n>`n> <small>$now</small>`n"
}

if ($blocks.Count -eq 0) { Write-Output '没有新回复需要写入（已全部处理过）'; }

# ---- 2) 把「待办：」写进今天的 daily 笔记 ----
$today = Get-Date -Format 'yyyy-MM-dd'
$dailyPath = Join-Path $Vault "daily/$today.md"
$todoAdded = @()
if (Test-Path -LiteralPath $dailyPath) {
  $daily = Read-Utf8 $dailyPath
  foreach ($r in $replies) {
    foreach ($t in @($r.todos)) {
      $t = [string]$t
      if (-not $t) { continue }
      if ($daily.Contains("- [ ] $t")) { continue }
      # 插到「## 今日」段末尾（下一个二级标题之前）
      $dl = $daily -split "`r?`n"
      $h = -1; $nx = $dl.Count
      for ($i = 0; $i -lt $dl.Count; $i++) {
        if ($h -lt 0 -and $dl[$i] -match '^##\s+今日\s*$') { $h = $i; continue }
        if ($h -ge 0 -and $i -gt $h -and $dl[$i] -match '^##\s+') { $nx = $i; break }
      }
      if ($h -lt 0) { continue }
      $insert = $nx
      while ($insert -gt $h + 1 -and $dl[$insert - 1].Trim() -eq '') { $insert-- }
      $dl = @($dl[0..($insert - 1)]) + "- [ ] $t" + @($dl[$insert..($dl.Count - 1)])
      $daily = $dl -join "`n"
      $todoAdded += $t
    }
  }
  Write-Utf8 $dailyPath $daily
} else {
  Write-Output "注意：今天的日记 $dailyPath 不存在，跳过待办写入"
}

# ---- 3) 把回复追加到「## dsh 回复」段末尾 ----
if ($blocks.Count -gt 0) {
  $newText = $text
  if ($rStart -lt 0) {
    $newText = $text.TrimEnd() + "`n`n## dsh 回复`n`n" + ($blocks -join "`n")
  } else {
    $rEnd = $lines.Count
    for ($i = $rStart + 1; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^##\s+') { $rEnd = $i; break } }
    $insertAt = $rEnd
    while ($insertAt -gt $rStart + 1 -and $lines[$insertAt - 1].Trim() -eq '') { $insertAt-- }
    $head = @($lines[0..($insertAt - 1)])
    $tail = @($lines[$insertAt..($lines.Count - 1)])
    $newText = (@($head) + @('') + @($blocks) + @($tail)) -join "`n"
  }
  Write-Utf8 $letter $newText
}

Write-Output ("已写入 {0} 条回复，新增 {1} 条待办：{2}" -f $blocks.Count, $todoAdded.Count, ($todoAdded -join ' / '))
