/**
 * 打包发布版：只把「代码 + 规则 + 文档 + 虚构示例」拷进 dist/，**抓取下来的语料一律不进包**。
 * 用法： node tools/package-release.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '1.0.0';
const OUT = path.join(ROOT, 'dist', `spinlens-v${VERSION}`);

// 白名单：只有这些文件会进发布包
const FILES = [
  'package.json',
  'huashu.js',
  'server.js',
  'launch.cjs',
  '启动.cmd',
  '启动网页版.cmd',
  'README.md',
  'SPEC.md',
  'IMPLEMENTATION-NOTES.md',
  'LICENSE',
  '.gitignore',
  'rules/event-deepseek.json',
  'web/index.html',
  'docs/GUIDELINES.md',
  'docs/DATA.md',
  'reviews/DECISIONS.md',
  'reviews/coupling.md',
  'reviews/feasibility.md',
  'reviews/rules-engine.md',
  'tests/mock-model.cjs',
  'tests/webtest.mjs',
  'tests/eval.js',
  'tests/sample-comments.json',
  'tests/golden-demo.csv',
  'tools/audit-video.cjs',
  'tools/regress.cjs',
  'tools/preflight.cjs',
  'tools/package-release.mjs',
];

// 安全网：任何路径命中这些模式的都不许进包
const DENY_PATH = /(^|\/)(lab|corpora|dist|node_modules|backups)(\/|$)|hits-v|golden-(dev|exam|clean|stance|holdout)|comments-dev-pool|search-merged|search[0-9]-/;
// 评论 ID 形如 3xxxxxxxxxxx（12 位以上、以 3 开头）——发布包里不该出现
const DENY_CONTENT = /\b3\d{11,}\b/;

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const problems = [];
let total = 0;
console.log('打包内容：');
for (const rel of FILES) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { problems.push(`缺少文件：${rel}`); continue; }
  if (DENY_PATH.test(rel)) { problems.push(`路径命中黑名单，拒绝打包：${rel}`); continue; }
  const text = fs.readFileSync(src, 'utf8');
  if (DENY_CONTENT.test(text)) problems.push(`内容里出现疑似评论 ID，拒绝打包：${rel}`);
  fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
  fs.writeFileSync(path.join(OUT, rel), text, 'utf8');
  total += Buffer.byteLength(text);
  console.log(`  ${String(Buffer.byteLength(text)).padStart(7)}  ${rel}`);
}

// 反向校验：发布包里除了白名单，不许有别的东西
const extra = walk(OUT).filter((f) => !FILES.includes(f));
if (extra.length) problems.push(`发布包里出现白名单外的文件：${extra.join(', ')}`);

console.log(`\n合计 ${walk(OUT).length} 个文件 / ${(total / 1024).toFixed(1)} KB`);
if (problems.length) {
  console.log('\n✗ 打包中止：');
  for (const p of problems) console.log('  - ' + p);
  process.exitCode = 1;
} else {
  console.log('✓ 已生成：' + path.relative(ROOT, OUT));
  console.log('✓ 校验通过：无 lab/ 语料、无抓取评论文件、无评论 ID');
}
