/**
 * 一个视频的诚实审计：把规则在该视频上到底报了什么、报错了什么、漏了什么全摊开。
 * 用法： node tools/audit-video.cjs <BV号> [阈值...]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const huashu = require('../huashu.js');

const BV = process.argv[2] ?? 'BV1AGaL6AEc6';
const THRESHOLDS = process.argv.slice(3).map(Number).filter((n) => n > 0);
const thresholds = THRESHOLDS.length ? THRESHOLDS : [0.6, 0.3];

const { compiled } = huashu.compileRuleSet(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules', 'event-deepseek.json'), 'utf8')));

(async () => {
  const out = [];
  const say = (s) => { out.push(s); console.log(s); };

  say(`审计视频：${BV}`);
  const payload = await huashu.fetchComments(BV, { maxComments: 5000, onProgress: (m) => process.stderr.write(`· ${m}\n`) });
  const comments = payload.comments.map((c) => ({ ...c, msg: huashu.normalizeEqualLength(c.msg) }));
  say(`《${payload.target.title}》  主评论 ${comments.length} 条（总评论 ${payload.meta.allCount}）`);
  const corpus = { note: `审计用：${BV}`, target: payload.target, meta: payload.meta, comments };
  fs.mkdirSync(path.join(__dirname, '..', 'lab', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'lab', 'audit', `${BV}.json`), JSON.stringify(corpus, null, 1), 'utf8');

  for (const th of thresholds) {
    const { hits } = huashu.detect(comments, compiled, { threshold: th });
    say(`\n${'='.repeat(78)}\n阈值 ${th} → 命中 ${hits.length} 条（占 ${(hits.length / comments.length * 100).toFixed(1)}%）\n${'='.repeat(78)}`);
    for (const h of hits) {
      const tys = h.types.map((t) => `${t.id}(${t.score})`).join('/');
      const ev = h.types.map((t) => t.evidence.filter((e) => e.span).map((e) => e.src).join('+')).join(' ; ');
      say(`\n[${tys}] 赞${h.like} ${h.user}`);
      say(`  原文：${h.msg.replace(/\s+/g, ' ')}`);
      say(`  依据：${ev}`);
    }
  }

  // 用户点名的两条长评论，看它们到底有没有被报
  const named = ['不管怎样不都是自己的喜好吗', '大家可以理智一点吗'];
  say(`\n${'='.repeat(78)}\n用户点名的长评论，规则报了吗？\n${'='.repeat(78)}`);
  const base = huashu.detect(comments, compiled, { threshold: 0.6 });
  for (const key of named) {
    const c = comments.find((x) => x.msg.includes(key));
    if (!c) { say(`\n（该视频里没找到含「${key}」的评论）`); continue; }
    const hit = base.hits.find((h) => h.rpid === c.rpid);
    say(`\n含「${key}」：${hit ? `报了 ${hit.types.map((t) => t.id).join('/')}` : '❌ 没报'}`);
    say(`  原文：${c.msg.replace(/\s+/g, ' ').slice(0, 120)}…`);
  }

  const p = path.join(__dirname, '..', 'lab', 'audit', `audit-${BV}.txt`);
  fs.writeFileSync(p, out.join('\n'), 'utf8');
  console.log(`\n（完整审计已写入 ${path.relative(path.join(__dirname, '..'), p)}）`);
})();
