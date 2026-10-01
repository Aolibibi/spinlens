# ============================================================================
#  spinlens 一键安装（Windows）
#
#  做三件事：
#    1. 把模型权重从 GitHub Release 下载到 .\model\
#    2. 找一台装了 torch + transformers 的 Python，路径写进 .\python-path.txt
#    3. 告诉你下一步怎么启动
#
#  用法：在项目根目录执行
#      powershell -ExecutionPolicy Bypass -File .\install.ps1
#  或已经 clone 好了、直接双击本文件（右键 → 使用 PowerShell 运行）。
#
#  不装模型也能用：网页里的「LLM 模式」和「决策模型模式」两个引擎不需要权重。
#  本脚本失败也不影响这两个引擎，可以放心 Ctrl+C。
# ============================================================================

[CmdletBinding()]
param(
  [string]$Tag = '0.0.1-bigfisho7',
  [switch]$SkipPython
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ModelDir = Join-Path $Root 'model'
$Base = "https://github.com/Aolibibi/spinlens/releases/download/$Tag"

# 权重清单（8 个文件；前 4 个是推理必需，后 4 个是说明/许可）
$Files = @(
  'config.json', 'tokenizer.json', 'tokenizer_config.json', 'model.safetensors',
  'README.md', 'LABELS.md', 'apply_info.json', 'LICENSE'
)

function Write-Step($s) { Write-Host "`n==> $s" -ForegroundColor Cyan }
function Write-Ok($s)   { Write-Host "    [OK] $s" -ForegroundColor Green }
function Write-Warn2($s){ Write-Host "    [!]  $s" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  spinlens · 话术照妖镜 · 安装程序" -ForegroundColor White
Write-Host "  ------------------------------------------" -ForegroundColor DarkGray
Write-Host "  项目目录：$Root"
Write-Host "  权重来源：$Base"

# ---------------------------------------------------------------- 1) 下载权重
Write-Step "1/3  下载模型权重（约 390 MB，只有第一次需要）"

if (-not (Test-Path $ModelDir)) { New-Item -ItemType Directory -Path $ModelDir -Force | Out-Null }

# 优先用 Windows 自带的 curl.exe：有进度条、比 Invoke-WebRequest 快很多
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue

foreach ($f in $Files) {
  $out = Join-Path $ModelDir $f
  if (Test-Path $out) {
    $sz = (Get-Item $out).Length
    if ($sz -gt 0) { Write-Ok "$f 已存在（$([math]::Round($sz/1KB,1)) KB），跳过"; continue }
  }
  $url = "$Base/$f"
  Write-Host "    下载 $f …"
  try {
    if ($curl) {
      # 加超时与重试：断网时不要卡住 ~21 秒×8 个文件
      & $curl.Source -L --fail --silent --show-error --connect-timeout 15 --retry 2 --retry-delay 1 -o $out $url
      if ($LASTEXITCODE -ne 0) { throw "curl 退出码 $LASTEXITCODE" }
    } else {
      # 老系统没有 curl.exe 时兜底；进度条关掉以免刷屏
      $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
      $ProgressPreference = $old
    }
    Write-Ok "$f  ($([math]::Round((Get-Item $out).Length/1KB,1)) KB)"
  } catch {
    Write-Warn2 "$f 下载失败：$($_.Exception.Message)"
    Write-Warn2 "  可以手动到这个地址下载，放进 $ModelDir"
    Write-Warn2 "  $url"
  }
}

$got = @(Get-ChildItem $ModelDir -File -ErrorAction SilentlyContinue)
$need = (Test-Path (Join-Path $ModelDir 'model.safetensors'))
Write-Host ""
if ($need) {
  $total = ($got | Measure-Object -Property Length -Sum).Sum
  Write-Ok "权重就绪：$($got.Count) 个文件 / $([math]::Round($total/1MB,2)) MB"
} else {
  Write-Warn2 "没下到 model.safetensors（这是权重本体，约 390 MB）"
  Write-Warn2 "本地模型引擎暂时用不了，但「LLM 模式」和「决策模型模式」照常可用。"
}

# ------------------------------------------------- 2) 找一台带 torch 的 Python
Write-Step "2/3  找 Python（本地模型引擎需要，缺 torch/transformers 就跳过）"

if ($SkipPython) {
  Write-Warn2 "（-SkipPython，跳过）"
} else {
  $cands = New-Object System.Collections.ArrayList
  if ($env:HUASHU_PY) { [void]$cands.Add(@{ cmd = $env:HUASHU_PY; why = 'HUASHU_PY 环境变量' }) }
  foreach ($rel in @('python_embeded\python.exe', '..\python_embeded\python.exe', '.venv\Scripts\python.exe')) {
    $p = Join-Path $Root $rel
    if (Test-Path $p) { [void]$cands.Add(@{ cmd = $p; why = "项目内 $rel" }) }
  }
  foreach ($n in @('python', 'python3', 'py')) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { [void]$cands.Add(@{ cmd = $c.Source; why = "PATH 上的 $n" }) }
  }

  $found = $null
  foreach ($c in $cands) {
    try {
      # 关键：不能只测 --version，必须确认真的能 import torch 和 transformers
      $null = & $c.cmd -c "import torch, transformers" 2>&1
      if ($LASTEXITCODE -eq 0) { $found = $c; break }
    } catch { }
  }

  if ($found) {
    # 必须写「无 BOM 的 UTF-8」：Windows PowerShell 5.1 的 -Encoding UTF8 会带 BOM，
    # 那个隐藏字符会跑到路径最前面，启动器就拿它当路径去找 python 了。
    [System.IO.File]::WriteAllText(
      (Join-Path $Root 'python-path.txt'),
      $found.cmd,
      (New-Object System.Text.UTF8Encoding $false))
    Write-Ok "找到可用的 Python：$($found.cmd)"
    Write-Ok "（来源：$($found.why)；已写入 python-path.txt，启动器会自动读它）"
  } else {
    Write-Warn2 "没找到同时装有 torch 和 transformers 的 Python。"
    Write-Warn2 "本地模型引擎会用不了，但不影响另外两个引擎。"
    Write-Host  "      想补上的话：装好依赖后，把 python.exe 的完整路径写进"
    Write-Host  "      $Root\python-path.txt  一行即可。"
    Write-Host  "      例：python -m pip install torch transformers"
  }
}

# ------------------------------------------------------------------ 3) 下一步
Write-Step "3/3  好了，这样启动"

Write-Host ""
Write-Host "    双击项目里的  启动.cmd" -ForegroundColor White
Write-Host "    它会拉起服务并自动打开浏览器；用完了点黑窗口的 X 关闭。"
Write-Host ""
Write-Host "    不想用本地模型 / 没下权重也能跑：" -ForegroundColor DarkGray
Write-Host "      网页右上角切到「LLM 模式」或「决策模型模式」即可。" -ForegroundColor DarkGray
Write-Host ""
Write-Host "    提醒：这个本地模型人工验收精确率 29.4% / 召回 55.6%（验收集仅 8 条正例），" -ForegroundColor Yellow
Write-Host "    只能当粗召回源，必须人工复核。详见 README 的「诚实的准确率」。" -ForegroundColor Yellow
Write-Host ""
