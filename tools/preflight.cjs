#!/usr/bin/env node
/**
 * 发布前自检：扫一遍「会被提交进仓库的文件」，发现本机隐私 / 密钥残留就报错退出。
 *
 * 用法：
 *   node tools/preflight.cjs            正常用法（只扫会被提交的文件）
 *   node tools/preflight.cjs --list     顺便把「将要发布」的文件清单打出来
 *   node tools/preflight.cjs --all      连被 .gitignore 排除的文件一起扫（排查用，别用于发布判定）
 *
 * 退出码：0 = 全绿可以发；1 = 有命中，必须先清掉。
 *
 * 扫描范围怎么定的：它照着 .gitignore 的排除规则走一遍（lab/、_recovered/、
 * node_modules/、*.bak*、权重文件、*.log 等都不扫），所以「扫的就是会被 clone 到的」。
 * .gitignore 自身只豁免「临时目录」这一条规则——.gitignore 的职责本来就是列出要忽略的路径。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ARGV = process.argv.slice(2);
const SCAN_ALL = ARGV.includes('--all');
const SHOW_LIST = ARGV.includes('--list');

/* ────────────────────────── 敏感特征表 ────────────────────────── */
const RULES = [
  { id: 'win-d-drive', what: '本机 D 盘绝对路径', re: /D:[\\/]/ },
  { id: 'win-home', what: '本机用户目录', re: /C:[\\/]Users[\\/]/i },
  { id: 'comfyui', what: '本机 ComfyUI 安装路径', re: /comfyui/i },
  { id: 'username', what: '本机用户名 30844', re: /30844/ },
  { id: 'api-key', what: '疑似 sk- 密钥', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { id: 'jev-key', what: '疑似 jv_live_ 密钥', re: /jv_live_/ },
  { id: 'tmp-dir', what: '本机临时目录引用', re: /\.tmp[\\/]/ },
  { id: 'posix-home', what: '类 Unix 家目录绝对路径', re: /\/(?:Users|home)\/[A-Za-z0-9._-]+\// },
];

/* 逐文件豁免：这些文件里出现某些特征串是它们的本职，不是泄漏 */
const EXEMPT = {
  '.gitignore': ['tmp-dir'],
  'tools/preflight.cjs': ['*'], // 本脚本自己就写着上面那些特征串
};

/* ──────────────── 不参与发布的路径（与 .gitignore 对齐） ──────────────── */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '.idea', '.vscode', '.tmp', '__pycache__',
  'lab', '_recovered', 'dist',
]);
const SKIP_FILE_RES = [
  /\.bak/i, /\.orig$/i, /\.rej$/i, /\.tmp$/i, /\.log$/i, /\.pyc$/i,
  /\.(safetensors|pt|pth|ckpt|onnx|bin)$/i,
  /^huashu-.*\.csv$/i, /\.low\.csv$/i,
  /^(Thumbs\.db|desktop\.ini|\.DS_Store)$/i,
  /^_.*\.(mjs|cjs|json)$/i,
];
const SKIP_REL = new Set([
  'tools/agreement.cjs',
  'tools/list-rules-hits.cjs',
  'tools/make-step-candidates.cjs',
  'tools/make-product-pack.cjs',
]);
const BINARY_RE = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|7z|rar|mp[34]|wav|ogg|woff2?|ttf|otf|eot|xlsx?|docx?|pptx?)$/i;

/* ─────────────────────────── 工具函数 ─────────────────────────── */
const C = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const ok = (s) => C('32', s);
const bad = (s) => C('31', s);
const dim = (s) => C('2', s);
const bold = (s) => C('1', s);

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SCAN_ALL && SKIP_DIRS.has(e.name)) continue;
      out.push(...walk(path.join(dir, e.name), rel));
    } else if (e.isFile()) {
      if (!SCAN_ALL && (SKIP_REL.has(rel) || SKIP_FILE_RES.some((r) => r.test(e.name)))) continue;
      out.push(rel);
    }
  }
  return out;
}

/* ──────────────────────────── 主流程 ──────────────────────────── */
console.log(bold('spinlens 发布前自检') + dim(SCAN_ALL ? '  [--all：含被忽略的文件]' : '  [只扫会被提交的文件]'));
console.log(dim(`项目根目录：${path.basename(ROOT)}/`) + '\n');

const files = walk(ROOT).sort();
const hits = [];
const warnings = [];
let scanned = 0;
let skipped = 0;

for (const rel of files) {
  const abs = path.join(ROOT, rel);
  let st;
  try { st = fs.statSync(abs); } catch { continue; }
  if (BINARY_RE.test(rel) || st.size > 2 * 1024 * 1024) { skipped++; continue; }

  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { skipped++; continue; }
  scanned++;

  if (st.size > 512 * 1024) {
    warnings.push(`${rel} 体积 ${(st.size / 1024).toFixed(0)} KB —— 确认它不是语料 / 权重？`);
  }

  const exempt = EXEMPT[rel] || [];
  if (exempt.includes('*')) continue;

  const lines = text.split('\n');
  for (const rule of RULES) {
    if (exempt.includes(rule.id)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (rule.re.test(lines[i])) {
        hits.push({ rel, line: i + 1, what: rule.what, sample: lines[i].trim().slice(0, 150) });
      }
    }
  }
}

/* ──────────────────────────── 输出 ──────────────────────────── */
console.log(`  扫描文本文件  ${String(scanned).padStart(4)} 个`);
console.log(`  跳过二进制/超大 ${String(skipped).padStart(4)} 个`);
console.log(dim(SCAN_ALL ? '  （--all：以上包含被 .gitignore 排除的文件）' : '  （lab/、_recovered/、node_modules/、*.bak*、dist/ 等已排除，不会被扫）'));
console.log('');

if (SHOW_LIST) {
  console.log(bold('将要发布的文件：'));
  for (const f of files) console.log('  ' + f);
  console.log('');
}

if (warnings.length) {
  console.log(C('33', `⚠ 提醒 ${warnings.length} 条（不阻断，自己看一眼）：`));
  for (const w of warnings) console.log('  · ' + w);
  console.log('');
}

if (hits.length) {
  console.log(bad(bold(`✗ 发现 ${hits.length} 处可疑内容 —— 发布前必须清掉：`)));
  console.log('');
  const w1 = Math.max(...hits.map((h) => `${h.rel}:${h.line}`.length), 12);
  for (const h of hits) {
    console.log(`  ${bad(`${h.rel}:${h.line}`.padEnd(w1))}  ${bold('[' + h.what + ']')}`);
    console.log(`  ${' '.repeat(w1)}  ${dim(h.sample)}`);
  }
  console.log('');
  console.log(dim('  想连被忽略的文件一起看：node tools/preflight.cjs --all'));
  console.log(dim('  看将要发布的文件清单：node tools/preflight.cjs --list'));
  process.exitCode = 1;
} else {
  console.log(ok(bold('✓ 全绿：没有发现本机路径 / 密钥残留，可以发布。')));
  if (!SHOW_LIST) console.log(dim('  （加 --list 可以看到「将要发布」的完整文件清单）'));
  process.exitCode = 0;
}
