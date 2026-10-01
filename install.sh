#!/usr/bin/env bash
# ============================================================================
#  spinlens 一键安装（macOS / Linux）
#
#  做两件事：
#    1. 把模型权重从 GitHub Release 下载到 ./model/
#    2. 找一台装了 torch + transformers 的 Python，路径写进 ./python-path.txt
#
#  用法：
#      git clone https://github.com/Aolibibi/spinlens.git
#      cd spinlens
#      ./install.sh
#
#  不装模型也能用：网页里的「LLM 模式」和「决策模型模式」不需要权重。
#  注意：项目自带的 启动.cmd 是 Windows 专用；Mac/Linux 请按脚本最后打印的
#        两条命令分别启动「模型服务」和「网页服务」。
# ============================================================================

set -u

TAG="${SPINLENS_TAG:-0.0.1-bigfisho7}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_DIR="$ROOT/model"
BASE="https://github.com/Aolibibi/spinlens/releases/download/$TAG"

FILES="config.json tokenizer.json tokenizer_config.json model.safetensors README.md LABELS.md apply_info.json LICENSE"

step() { printf '\n==> %s\n' "$1"; }
ok()   { printf '    [OK] %s\n' "$1"; }
warn() { printf '    [!]  %s\n' "$1"; }

printf '\n  spinlens · 话术照妖镜 · 安装程序\n'
printf '  ------------------------------------------\n'
printf '  项目目录：%s\n' "$ROOT"
printf '  权重来源：%s\n' "$BASE"

# ---------------------------------------------------------------- 1) 下载权重
step "1/2  下载模型权重（约 390 MB，只有第一次需要）"
mkdir -p "$MODEL_DIR"

DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then DOWNLOADER="wget"
fi

if [ -z "$DOWNLOADER" ]; then
  warn "系统里既没有 curl 也没有 wget，请手动下载权重到 $MODEL_DIR"
else
  for f in $FILES; do
    out="$MODEL_DIR/$f"
    if [ -s "$out" ]; then
      ok "$f 已存在，跳过"
      continue
    fi
    printf '    下载 %s …\n' "$f"
    if [ "$DOWNLOADER" = "curl" ]; then
      if curl -fL --progress-bar -o "$out" "$BASE/$f"; then ok "$f"; else warn "$f 下载失败（手动下载：$BASE/$f）"; fi
    else
      if wget -q --show-progress -O "$out" "$BASE/$f"; then ok "$f"; else warn "$f 下载失败（手动下载：$BASE/$f）"; fi
    fi
  done
fi

if [ -s "$MODEL_DIR/model.safetensors" ]; then
  SIZE=$(du -sh "$MODEL_DIR" 2>/dev/null | cut -f1)
  ok "权重就绪（$MODEL_DIR 共 $SIZE）"
else
  warn "没下到 model.safetensors（权重本体，约 390 MB）"
  warn "本地模型引擎暂时用不了，但「LLM 模式」和「决策模型模式」照常可用。"
fi

# ------------------------------------------------- 2) 找一台带 torch 的 Python
step "2/2  找 Python（本地模型引擎需要，缺 torch/transformers 就跳过）"

FOUND=""
for cand in "${HUASHU_PY:-}" "$ROOT/python_embeded/bin/python3" "$ROOT/../python_embeded/bin/python3" "$ROOT/.venv/bin/python" python3 python; do
  [ -n "$cand" ] || continue
  if command -v "$cand" >/dev/null 2>&1 || [ -x "$cand" ]; then
    if "$cand" -c "import torch, transformers" >/dev/null 2>&1; then
      FOUND="$cand"
      break
    fi
  fi
done

if [ -n "$FOUND" ]; then
  printf '%s\n' "$FOUND" > "$ROOT/python-path.txt"
  ok "找到可用的 Python：$FOUND"
  ok "已写入 python-path.txt"
else
  warn "没找到同时装有 torch 和 transformers 的 Python。"
  warn "本地模型引擎会用不了，但不影响另外两个引擎。"
  printf '      补上的办法：python3 -m pip install torch transformers\n'
  printf '      然后把 python3 的完整路径写进 %s/python-path.txt（一行）\n' "$ROOT"
fi

# ------------------------------------------------------------------ 下一步
step "好了，这样启动（Mac/Linux 分两个终端）"

cat <<EOF

    终端 A —— 模型服务（没下权重/没 Python 就跳过这条）：
      python3 model-server/serve.py --port 8790 --model model

    终端 B —— 网页服务：
      node server.js
      然后浏览器打开 http://127.0.0.1:8787

    页面右上角可以在「本地模型 / LLM 模式 / 决策模型模式」之间切换。

    提醒：这个本地模型人工验收精确率 29.4% / 召回 55.6%（验收集仅 8 条正例），
    只能当粗召回源，必须人工复核。详见 README 的「诚实的准确率」。

EOF
