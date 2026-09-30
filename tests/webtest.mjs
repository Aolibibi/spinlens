/**
 * 网页版 API 自测：规则引擎 / 模型引擎 / 进度轮询 / 错误路径
 * 用法： node tests/webtest.mjs [baseUrl]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8787';

const post = async (b) => (await fetch(base + '/api/analyze', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
})).json();

const wait = async (id, ms = 120000) => {
  const t0 = Date.now();
  const seen = [];
  while (Date.now() - t0 < ms) {
    const j = await (await fetch(base + '/api/job/' + id)).json();
    if (j.progress) seen.push(`${j.progress.phase}${j.progress.total ? ` ${j.progress.done}/${j.progress.total}` : ''}`);
    if (j.status !== 'running') { j._seen = seen.slice(-4); return j; }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { status: 'timeout' };
};

const line = (s) => console.log(s);
let fails = 0;
const check = (cond, what) => { if (!cond) { fails++; line(`  ✗ ${what}`); } else line(`  ✓ ${what}`); };

(async () => {
  line('=== 1) 首页 ===');
  const h = await (await fetch(base + '/')).text();
  check(h.includes('id="engModel"'), '有引擎切换卡');
  check(h.includes('id="modelBox"'), '有模型配置区');
  check(h.includes('id="progFill"'), '有进度条');
  check(!h.includes('id="pack"'), '已移除规则包选择');

  line('\n=== 2) 规则引擎 + demo ===');
  let r = await wait((await post({ demo: true, engine: 'rules' })).jobId);
  check(r.status === 'done', `任务完成（${r.status}）`);
  check(r.result?.hitCount > 0, `命中 ${r.result?.hitCount} 条`);
  check(/规则 event-deepseek/.test(r.result?.engineLabel ?? ''), `引擎标签：${r.result?.engineLabel}`);
  check(r.result?.hits?.[0]?.types?.[0]?.evidence?.[0]?.span != null, '规则模式证据带字符区间');

  line('\n=== 3) 规则引擎 + 真机抓取（BV1REaa6wE5k，上限 60）===');
  r = await wait((await post({ input: 'BV1REaa6wE5k', engine: 'rules', maxComments: 60 })).jobId);
  check(r.status === 'done', `任务完成（${r.status}）`);
  check(r.result?.meta?.mainCount === 60, `抓到 60 条（实际 ${r.result?.meta?.mainCount}）`);
  check(r.result?.engine === 'rules', '引擎 = rules');
  line(`    进度轨迹：${r._seen.join(' → ')}`);

  line('\n=== 4) 模型引擎 + 本地假模型（demo 12 条，每批 5）===');
  const id = (await post({
    demo: true, engine: 'model',
    ai: { spec: 'openai:http://127.0.0.1:8899/v1#mock', batchSize: 5 },
  })).jobId;
  r = await wait(id);
  check(r.status === 'done', `任务完成（${r.status}）`);
  check(r.result?.engine === 'model', '引擎 = model');
  check(/两级判定/.test(r.result?.engineLabel ?? ''), `引擎标签：${r.result?.engineLabel}`);
  check((r.result?.modelStats?.passes ?? 0) >= 2, `跑了两遍以上取共识（passes=${r.result?.modelStats?.passes}）`);
  check(typeof r.result?.modelStats?.selfAgreement === 'number', `自一致率 = ${(((r.result?.modelStats?.selfAgreement) ?? 0) * 100).toFixed(0)}%`);
  check(Array.isArray(r.result?.disputed), `争议池字段存在（${r.result?.disputed?.length ?? 0} 条）`);
  check(r.result?.hits?.length > 0, `命中 ${r.result?.hits?.length} 条`);
  check((r.result?.hits?.[0]?.types?.[0]?.evidence?.[0]?.src ?? '').startsWith('model'), '证据列写的是模型理由');
  check(Array.isArray(r.result?.hits?.[0]?.types?.[0]?.evidence?.[0]?.span), '证据带字符跨度（前端高亮用）');
  check(/语言模型判定/.test(r.result?.disclaimer ?? ''), '模型模式免责声明没写错');
  line(`    进度轨迹：${r._seen.join(' → ')}`);

  line('\n=== 5) 错误路径 ===');
  r = await wait((await post({ input: '随便一段话', engine: 'rules' })).jobId);
  check(r.status === 'error' && /无法识别的输入/.test(r.error ?? ''), `输入错误被正确报出：${r.error}`);
  r = await wait((await post({ input: 'BV1REaa6wE5k', engine: 'model', ai: { spec: 'openai:http://127.0.0.1:9999/v1#nope' }, maxComments: 30 })).jobId, 60000);
  check(r.status === 'done' && (r.result?.unjudged ?? 0) > 0, `模型连不上时如实报「未判定 ${r.result?.unjudged} 条」而不是崩掉`);

  line(`\n${fails === 0 ? '✓ 全部通过' : `✗ ${fails} 项未通过`}`);
  process.exitCode = fails === 0 ? 0 : 1;
})();
