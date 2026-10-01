# -*- coding: utf-8 -*-
"""
微调版 Erlangshen-110M 的本地推理服务（只用 Python 标准库 + torch/transformers，零新依赖）。
- GET  /health              → {"ok":true,"types":[...],"model":"..."}
- POST /classify {"texts":["...","..."]} → {"results":[{"T1":0.02,"T2":0.31,...}, ...]}
用法：
  python model-server/serve.py [--port 8790] [--model <dir>]
"""
import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_MODEL = HERE / "lab" / "train" / "runs" / "unfrozen2" / "best"   # 注意：脚本会重复拼 out-dir
FALLBACK_MODEL = HERE / "runs" / "unfrozen2" / "best"

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8790)
ap.add_argument("--model", default=None)
ap.add_argument("--max-len", type=int, default=256)
ap.add_argument("--chunk", type=int, default=64, help="每块推理的条数（控制峰值显存/内存）")
args = ap.parse_args()

MODEL_DIR = Path(args.model) if args.model else (DEFAULT_MODEL if DEFAULT_MODEL.exists() else FALLBACK_MODEL)
if not MODEL_DIR.exists():
    print(f"[serve] 找不到模型目录：{MODEL_DIR}", file=sys.stderr)
    sys.exit(1)

import torch
from transformers import BertTokenizer, BertForSequenceClassification

T0 = time.time()
tok = BertTokenizer.from_pretrained(str(MODEL_DIR))
model = BertForSequenceClassification.from_pretrained(str(MODEL_DIR))
dev = "cuda" if torch.cuda.is_available() else "cpu"
model.to(dev).eval()
# 从模型 config 里读标签顺序（训练时写进去的）
id2label = {int(k): v for k, v in (model.config.id2label or {}).items()}
TYPES = [id2label[i] for i in sorted(id2label)]
print(f"[serve] 模型 {MODEL_DIR}", file=sys.stderr)
print(f"[serve] 标签 {TYPES}  设备 {dev}  加载 {time.time() - T0:.1f}s", file=sys.stderr)


def classify(texts, chunk=None):
    """分块推理。
    为什么必须分块：网页会把整个视频的评论一次性发过来（上千条）。
    若不分块，一次前向就是一个 [上千 × 256] 的张量，激活值直接把 12GB 显存吃干
    （实测 400 条 → 88 秒 / 进程内存 14.7GB）。分块后峰值内存由 chunk 决定，与总条数无关。
    """
    if not texts:
        return []
    texts = list(texts)
    chunk = chunk or args.chunk
    out = []
    for i in range(0, len(texts), chunk):
        part = texts[i:i + chunk]
        enc = tok(part, padding=True, truncation=True, max_length=args.max_len, return_tensors="pt").to(dev)
        with torch.no_grad():
            logits = model(**enc).logits
            probs = torch.sigmoid(logits).cpu().tolist()
        out.extend({t: round(float(p), 4) for t, p in zip(TYPES, row)} for row in probs)
        # 每个小块用完就释放：评论长短不一 → 张量形状每次都变 → 缓存块会越攒越碎
        if dev == "cuda":
            del enc, logits, probs
            torch.cuda.empty_cache()
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, {"ok": True, "types": TYPES, "model": str(MODEL_DIR), "device": dev})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/classify"):
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length", 0))
            payload = json.loads(self.rfile.read(n) or b"{}")
            texts = payload.get("texts") or []
            t0 = time.time()
            results = classify(texts)
            self._send(200, {"results": results, "types": TYPES, "elapsed_ms": round((time.time() - t0) * 1000, 1)})
        except Exception as e:  # 出错要如实返回，别假装成功
            self._send(500, {"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[serve] 已启动 http://127.0.0.1:{args.port}", file=sys.stderr)
    srv.serve_forever()
