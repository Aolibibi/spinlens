/**
 * 评测器：拿人工标注样本算混淆矩阵（SPEC M-2/M-13/M-14 的验收脚本）
 *
 * 用法：
 *   node tests/eval.js                     用仓库自带样本（218 条候选池）
 *   node tests/eval.js <comments.json> <golden.csv>
 *   node tests/eval.js --min-precision 0.9 自定义验收线（默认 0.8）
 *
 * 输出：逐类型 precision / recall / F1 + 总混淆矩阵 + 误报明细；精确率不达标则退出码 1。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const huashu = require('../huashu.js');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const minPrecision = (() => {
  const i = args.indexOf('--min-precision');
  return i >= 0 ? Number(args[i + 1]) : 0.8;
})();
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--min-precision');
// 默认样本：优先用本地真实标注样本（lab/，不上传），没有则用仓库自带的虚构样本
const REAL_SAMPLE = path.join(ROOT, 'lab', 'eval-sample');
const useReal = !positional.length && fs.existsSync(path.join(REAL_SAMPLE, 'comments-dev-pool.json'));
const commentsPath = positional[0] ?? (useReal ? path.join(REAL_SAMPLE, 'comments-dev-pool.json') : path.join(__dirname, 'sample-comments.json'));
const goldenPath = positional[1] ?? (useReal ? path.join(REAL_SAMPLE, 'golden-sample.csv') : path.join(__dirname, 'golden-demo.csv'));
console.log(useReal ? '（使用本地真实标注样本 lab/eval-sample/ —— 该目录不进发布包）' : '（使用仓库自带虚构样本 tests/sample-comments.json）');

const packPath = path.join(ROOT, 'rules', 'event-deepseek.json');
const { compiled, warnings } = huashu.compileRuleSet(JSON.parse(fs.readFileSync(packPath, 'utf8')));
for (const w of warnings) console.warn('⚠ ' + w);

const raw = JSON.parse(fs.readFileSync(commentsPath, 'utf8'));
const comments = (Array.isArray(raw) ? raw : raw.comments).map((c, i) => ({
  rpid: String(c.rpid ?? `row-${i}`),
  user: c.user ?? '',
  like: Number(c.like ?? 0),
  msg: huashu.normalizeEqualLength(String(c.msg ?? c.message ?? '')),
}));

const labels = new Map();
for (const line of fs.readFileSync(goldenPath, 'utf8').split('\n').slice(1)) {
  if (!line.trim() || line.startsWith('#')) continue;
  if (!line.trim()) continue;
  const [rpid, types] = line.split(',');
  labels.set(rpid, (types ?? '').split(';').map((s) => s.trim()).filter(Boolean));
}

const { hits } = huashu.detect(comments, compiled, {});

// ---- 统计 ----
const perType = new Map();
const bump = (id, k) => { if (!perType.has(id)) perType.set(id, { tp: 0, fp: 0, fn: 0 }); perType.get(id)[k]++; };
const hitsByRpid = new Map(hits.map((h) => [h.rpid, new Set(h.types.map((t) => t.id))]));
const fpList = [];

for (const c of comments) {
  const gold = new Set(labels.get(c.rpid) ?? []);
  const got = hitsByRpid.get(c.rpid) ?? new Set();
  for (const t of gold) if (got.has(t)) bump(t, 'tp'); else bump(t, 'fn');
  for (const t of got) if (!gold.has(t)) { bump(t, 'fp'); fpList.push({ rpid: c.rpid, type: t, msg: c.msg }); }
}

let TP = 0, FP = 0, FN = 0;
console.log(`语料：${commentsPath}（${comments.length} 条，其中人工标注真命中 ${[...labels.values()].filter((v) => v.length).length} 条）`);
console.log(`规则：${compiled.names.join('+')}｜阈值 ${compiled.threshold}｜命中 ${hits.length} 条\n`);
console.log('类型      命中  TP   FP   FN   precision  recall   F1');
for (const t of compiled.types) {
  const s = perType.get(t.id) ?? { tp: 0, fp: 0, fn: 0 };
  const p = s.tp + s.fp ? s.tp / (s.tp + s.fp) : null;
  const r = s.tp + s.fn ? s.tp / (s.tp + s.fn) : null;
  const f1 = p && r ? (2 * p * r) / (p + r) : 0;
  TP += s.tp; FP += s.fp; FN += s.fn;
  const fmt = (v) => (v === null ? '  n/a' : (v * 100).toFixed(0).padStart(4) + '%');
  console.log(`${t.id.padEnd(5)} ${t.name.padEnd(8)} ${String(s.tp + s.fp).padStart(3)} ${String(s.tp).padStart(4)} ${String(s.fp).padStart(4)} ${String(s.fn).padStart(4)}   ${fmt(p)}     ${fmt(r)}   ${f1 ? (f1 * 100).toFixed(0) + '%' : ' n/a'}`);
}
const P = TP + FP ? TP / (TP + FP) : 0;
const R = TP + FN ? TP / (TP + FN) : 0;
const F1 = P + R ? (2 * P * R) / (P + R) : 0;
console.log('─'.repeat(62));
console.log(`合计  TP ${TP}  FP ${FP}  FN ${FN}   precision ${(P * 100).toFixed(1)}%   recall ${(R * 100).toFixed(1)}%   F1 ${(F1 * 100).toFixed(1)}%`);

if (fpList.length) {
  console.log(`\n误报明细（${fpList.length} 条）：`);
  for (const f of fpList.slice(0, 15)) console.log(`  [${f.type}] ${f.msg.replace(/\s+/g, ' ').slice(0, 80)}`);
}
const missed = [];
for (const c of comments) {
  const gold = labels.get(c.rpid) ?? [];
  const got = hitsByRpid.get(c.rpid) ?? new Set();
  const miss = gold.filter((t) => !got.has(t));
  if (miss.length) missed.push({ types: miss.join('/'), msg: c.msg });
}
if (missed.length) {
  console.log(`\n漏报明细（${missed.length} 条）：`);
  for (const m of missed.slice(0, 10)) console.log(`  [${m.types}] ${m.msg.replace(/\s+/g, ' ').slice(0, 80)}`);
}

const ok = P >= minPrecision;
console.log(`\n验收：precision ${(P * 100).toFixed(1)}% ${ok ? '≥' : '<'} 门槛 ${(minPrecision * 100).toFixed(0)}% → ${ok ? '通过' : '不通过'}`);
process.exitCode = ok ? 0 : 1;
