/**
 * 数据集回归（进程内跑，不起子进程）
 *
 * 用法：
 *   node tools/regress.cjs [规则文件]        默认 rules/event-deepseek.json
 *
 * 数据从哪来（默认项目相对路径，可用环境变量覆盖）：
 *   · 虚构样本（随仓库发布，clone 下来就能跑）
 *       tests/sample-comments.json + tests/golden-demo.csv
 *   · 本地真实语料（不随仓库发布，需要自备）
 *       HUASHU_DEV_RAW      含 { comments: [...] } 的 JSON，默认 lab/dev-raw.json
 *       HUASHU_HOLDOUT_CSV  评论 CSV，默认 lab/holdout-comments.csv
 *       其余几套读 lab/ 下的 golden-*.json，没有就自动跳过
 *
 * 缺哪套数据就跳过哪套，不会因为缺文件而崩。这是改规则时的第一道闸门：
 * 任何一处规则改动，跑这个工具，FP 必须为 0。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const huashu = require('../huashu.js');

const ROOT = path.join(__dirname, '..');
const LAB = path.join(ROOT, 'lab');
const CORP = path.join(LAB, 'corpora');
const RULES = path.resolve(ROOT, process.argv[2] ?? path.join('rules', 'event-deepseek.json'));
// 真实语料不随仓库发布，用环境变量指到你自己准备的数据；默认落在 lab/（本仓库已 gitignore）
const DEV_RAW = path.resolve(ROOT, process.env.HUASHU_DEV_RAW || path.join('lab', 'dev-raw.json'));
const HOLDOUT_CSV = path.resolve(ROOT, process.env.HUASHU_HOLDOUT_CSV || path.join('lab', 'holdout-comments.csv'));

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const loadList = (p) => fs.readFileSync(p, 'utf8').split('\n').map((l) => l.split('\t')[0].trim()).filter((s) => /^BV[0-9A-Za-z]{10}$/.test(s));

function parseCsv(p) {
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n').slice(1)) {
    if (!line) continue;
    let m = line.match(/^"([^"]*)","([^"]*)","([^"]*)","([^"]*)","(.*)"$/);
    if (m) { out.push({ rpid: m[1], user: m[2], like: +m[3], msg: m[5].replace(/""/g, '"') }); continue; }
    m = line.match(/^([^,]*),"([^"]*)",([0-9]+),([0-9]+),"(.*)"$/);
    if (m) out.push({ rpid: m[1], user: m[2], like: +m[3], msg: m[5].replace(/""/g, '"') });
  }
  return out;
}

const sets = [
  { label: '开发集(lab)', comments: () => readJson(DEV_RAW).comments, golden: 'golden-dev-BV1pWaY6mEcM.json' },
  { label: '验证视频(lab)', comments: () => parseCsv(HOLDOUT_CSV), golden: 'golden-holdout-A.json' },
  { label: '考卷 7368', comments: () => loadList(path.join(CORP, '_exam-list.txt')).flatMap((bv) => parseCsv(path.join(CORP, `${bv}.csv`))), golden: 'golden-exam-v2.json' },
  { label: '干净集 4544', comments: () => loadList(path.join(CORP, '_clean-all.txt')).flatMap((bv) => parseCsv(path.join(CORP, `${bv}.csv`))), golden: 'golden-clean-v7.json' },
  { label: '立场集 2680', comments: () => loadList(path.join(CORP, '_stance-list.tsv')).flatMap((bv) => parseCsv(path.join(CORP, `${bv}.csv`))), golden: 'golden-stance.json' },
  { label: '立场集② 1594', comments: () => loadList(path.join(CORP, '_stance2-list.tsv')).flatMap((bv) => parseCsv(path.join(CORP, `${bv}.csv`))), golden: 'golden-stance2.json' },
  // 第七套：产品自带的虚构样本（发布包里也有），用来盯住已知缺口
  { label: '虚构样本 20', comments: () => readJson(path.join(ROOT, 'tests', 'sample-comments.json')).comments, golden: path.join(ROOT, 'tests', 'golden-demo.csv'), csvGolden: true },
];

if (!fs.existsSync(CORP)) {
  console.log('没有找到 lab/corpora（真实语料不上传，只在本机存在）——只能跑虚构样本。');
}

const { compiled, warnings } = huashu.compileRuleSet(readJson(RULES));
console.log(`规则：${path.relative(ROOT, RULES)}｜类型 ${compiled.types.map((t) => t.id).join(',')}｜阈值 ${compiled.threshold}`);
for (const w of warnings) console.log('  ⚠ ' + w);
console.log('\n数据集'.padEnd(18) + '命中条'.padStart(7) + '命中对'.padStart(8) + 'TP'.padStart(5) + 'FP'.padStart(5) + 'FN'.padStart(5) + 'precision'.padStart(11) + 'recall'.padStart(9));

let tot = { pair: 0, tp: 0, fp: 0, fn: 0 };
let skippedSets = 0;
const fpSamples = [];
const fnSamples = [];
for (const s of sets) {
  let comments, labels;
  try {
    comments = s.comments();
    labels = new Map();
    if (s.csvGolden) {
      for (const line of fs.readFileSync(s.golden, 'utf8').split('\n').slice(1)) {
        if (!line.trim() || line.startsWith('#')) continue;
        const [rpid, t] = line.split(',');
        if (rpid === 'rpid') continue;
        labels.set(rpid, (t ?? '').split(';').map((x) => x.trim()).filter(Boolean));
      }
    } else {
      const g = readJson(path.join(LAB, s.golden)).labels ?? {};
      for (const [k, v] of Object.entries(g)) labels.set(k, v);
    }
  } catch (e) { skippedSets++; console.log(s.label.padEnd(18) + ' 跳过（缺数据：' + String(e.message).replace(/\s+/g, ' ').slice(0, 60) + '）'); continue; }

  const { hits } = huashu.detect(comments.map((c, i) => ({
    rpid: String(c.rpid ?? `row-${i}`), user: c.user ?? '', uid: c.uid ?? '', like: Number(c.like ?? 0),
    ctime: Number(c.ctime ?? 0), msg: huashu.normalizeEqualLength(String(c.msg ?? '')), jumpUrl: c.jumpUrl ?? '',
  })), compiled, {});

  let pair = 0, tp = 0, fp = 0, fn = 0;
  for (const h of hits) {
    const gold = labels.get(String(h.rpid)) ?? [];
    for (const t of h.types) {
      pair++;
      if (gold.includes(t.id)) tp++;
      else { fp++; fpSamples.push(`[${s.label}] ${t.id} 赞${h.like}: ${h.msg.replace(/\s+/g, ' ').slice(0, 90)}`); }
    }
  }
  for (const [rpid, ts] of labels) {
    const got = new Set((hits.find((h) => String(h.rpid) === rpid)?.types ?? []).map((t) => t.id));
    const miss = ts.filter((t) => !got.has(t));
    if (miss.length) {
      const src = comments.find((c) => String(c.rpid) === rpid);
      fn += miss.length;
      fnSamples.push(`[${s.label}] 漏 ${miss.join('/')} :: ${String(src?.msg ?? '').replace(/\s+/g, ' ').slice(0, 78)}`);
    }
  }
  tot.pair += pair; tot.tp += tp; tot.fp += fp; tot.fn += fn;
  const P = tp + fp ? tp / (tp + fp) : 0;
  const R = tp + fn ? tp / (tp + fn) : 0;
  console.log(s.label.padEnd(18) + String(hits.length).padStart(7) + String(pair).padStart(8) + String(tp).padStart(5) + String(fp).padStart(5) + String(fn).padStart(5)
    + ((P * 100).toFixed(1) + '%').padStart(11) + ((R * 100).toFixed(1) + '%').padStart(9));
}
if (skippedSets) {
  console.log(`\n提示：有 ${skippedSets} 套数据被跳过——真实语料不随本仓库发布。`);
  console.log('      自备数据后，用 HUASHU_DEV_RAW / HUASHU_HOLDOUT_CSV 指过去，或放到 lab/ 下。详见文件头注释。');
}
const P = tot.tp + tot.fp ? tot.tp / (tot.tp + tot.fp) : 0;
const R = tot.tp + tot.fn ? tot.tp / (tot.tp + tot.fn) : 0;
console.log('-'.repeat(66));
console.log('合计'.padEnd(18) + ''.padStart(7) + String(tot.pair).padStart(8) + String(tot.tp).padStart(5) + String(tot.fp).padStart(5) + String(tot.fn).padStart(5)
  + ((P * 100).toFixed(1) + '%').padStart(11) + ((R * 100).toFixed(1) + '%').padStart(9));
if (fnSamples.length) {
  console.log(`\n漏报明细（${fnSamples.length} 条，改规则要盯的就是这些）：`);
  for (const f of fnSamples.slice(0, 20)) console.log('  ○ ' + f);
}
if (fpSamples.length) {
  console.log(`\n误报明细（${fpSamples.length} 条，改规则时必须为 0）：`);
  for (const f of fpSamples.slice(0, 20)) console.log('  ✗ ' + f);
}
process.exitCode = tot.fp === 0 ? 0 : 1;
