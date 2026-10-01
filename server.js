#!/usr/bin/env node
/**
 * spinlens · 话术照妖镜 · 本地网页版服务端
 * ---------------------------------------------------------------------------
 * 为什么需要它：浏览器里的网页没法直接请求 B 站接口（跨域会被拦），
 * 所以让这个小服务在本机做「抓取 + 判定」，网页只负责显示。
 * 服务只监听 127.0.0.1，不对外网开放；不写任何日志文件。
 *
 * 两种判定引擎（由网页选择）：
 *   rules —— 本地规则，秒出结果，零成本（默认）
 *   model —— 完全不用规则，把每条评论交给语言模型判（你接 API 或本地 Ollama）
 *
 * 用法：
 *   node server.js              启动后手动打开 http://127.0.0.1:8787
 *   node server.js --open       启动并自动打开浏览器
 *   node server.js --port 9000  换端口
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const huashu = require('./huashu.js');

const argv = process.argv.slice(2);
const PORT = (() => {
  const i = argv.indexOf('--port');
  return i >= 0 ? Number(argv[i + 1]) : Number(process.env.PORT || 8787);
})();
const HOST = '127.0.0.1';
const WEB_DIR = path.join(__dirname, 'web');
const MAX_BODY = 1 << 20;
const JOB_TTL_MS = 30 * 60 * 1000;

/* ---------------- 任务表：抓取/判定可能要几十秒，网页靠轮询看进度 ---------------- */
const jobs = new Map();
let jobSeq = 0;

function newJob() {
  const id = `j${Date.now().toString(36)}${(++jobSeq).toString(36)}`;
  const job = {
    id, status: 'running', createdAt: Date.now(),
    progress: { phase: '准备', done: 0, total: 0, message: '' },
    result: null, error: null, detail: '',
  };
  jobs.set(id, job);
  for (const [k, v] of jobs) if (Date.now() - v.createdAt > JOB_TTL_MS) jobs.delete(k);
  return job;
}

const setProgress = (job, phase, done, total, message = '') => {
  job.progress = { phase, done, total, message };
};

/* ================= 外部模型引擎：两条子路径 =================
 * 网页在 engine === 'model' 下还要选一种接法（前端 modelMode）：
 *
 *   llm      —— 把九类规则写成提示词交给「用户自己的 LLM」，让它对每条评论逐条判断，
 *               只返回结构化 JSON：命中类型 id + 从原文【逐字复制】的证据 + 一句理由。
 *               证据就是判据：机械校验（huashu.verifyQuote）在原文里找不到 → 直接丢弃；
 *               落在成对引号里、或前面 10 字内有转述线索 → 也不算命中。
 *               这两条完全可复算，是模型自由度之外的那道闸门，且不花 token。
 *               分批调用，走 job 的进度机制上报（前端已有进度条）。
 *
 *   decision —— typed 决策模型（Jev 类）：把每条评论当一个 state、每个类型当一个独立的是非题
 *               （state + question + options → typed 结果），读的是 **P(true) 校准概率**。
 *               ⚠️ 绝对不要读 top_probability —— 那是「获胜选项」的概率，不是 P(true)；
 *               在多选项结构里它恒等于 max(options)，拿它当 P(true) 会把每一类都判成命中
 *               （本项目踩过这个坑，extractPTrue() 里显式不认这个字段）。
 */

const BV_RE = /^BV[0-9A-Za-z]{8,}$/;
const HTTP_RE = /^https?:\/\//;

/**
 * 拼「去 B 站看这条评论」的链接。
 * 为什么不直接用 c.jumpUrl：huashu.js 取的是 B 站接口的 jump_url 字段，而那个字段现在是个**对象**，
 * String(对象) 会变成 "[object Object]" —— 前端 <a href> 就变成一个点不了的链接（实测踩到）。
 * 所以这里优先自己拿 bv + rpid 拼，拿不到能用 bv 就把非 http(s) 的垃圾值吐成空串（前端就不渲染链接）。
 */
function jumpUrlFor(c, bvid) {
  const bv = BV_RE.test(String(c.bv || '')) ? String(c.bv) : (BV_RE.test(String(bvid || '')) ? String(bvid) : '');
  if (bv && c.rpid) return `https://www.bilibili.com/video/${bv}/#reply${c.rpid}`;
  const raw = c.jumpUrl;
  return (typeof raw === 'string' && HTTP_RE.test(raw)) ? raw : '';
}

const jumpUrlOf = (c) => jumpUrlFor(c, '');

// 九类定义（LLM 提示词用）。
// ⚠ 不能只读 ruleSet.types：loadRulePacks() 编译后只留 id/name/note，modelDef 会被丢掉（note 也是空串），
// 结果提示词里一直输出「（无定义）」——模型看不到“什么算/什么不算”只能瞎猜。
// 所以这里回头读一次规则包原文件（loadTypeDefs，函数声明会提升）把定义补回来。
let _typeDefsCache = null;
const typeDefsOf = (ruleSet) => {
  if (!_typeDefsCache) _typeDefsCache = loadTypeDefs();
  const raw = _typeDefsCache;
  return ruleSet.types
    .map((t) => `- ${t.id} ${t.name}：${t.modelDef || t.note || (raw[t.id] && raw[t.id].def) || '（无定义）'}`)
    .join('\n');
};

/**
 * 从规则包原始 JSON 里取每类的 modelDef，供决策模型（Jev）的 criteria.true 用。
 * 为什么不在 ruleSet.types 里直接拿：loadRulePacks() 编译后只留 id/name/note，modelDef 会被丢掉（note 也是空串），
 * 所以这里回头读一次原文件。读不到就留空串——官方 criteria 本来就是可选的。
 */
function loadTypeDefs() {
  const out = {};
  try {
    const dir = huashu.resolveRulesDir();
    for (const f of ['event-deepseek.json', 'event-deepseek-t10.json']) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const t of (Array.isArray(raw.types) ? raw.types : [])) {
        if (!t.id || out[t.id]) continue;
        const def = String(t.modelDef || t.note || '').trim();
        if (def) out[t.id] = { def, neg: String(t.modelFalse || t.modelNegDef || '').trim() };
      }
    }
  } catch { /* 读不到就把 criteria 留空 */ }
  return out;
}
/** LLM 模式提示词：九类规则 + 输出格式（要逐字证据 + 一句理由），完全不用规则匹配 */
function buildLlmPrompt(ruleSet, batch) {
  const rubric = ruleSet.modelRubric || '只有说话人本人正在做出该动作才算；转述、引用、反驳、反问、反讽、玩梗一律不算。';
  const system = [
    '你是一个评论文本标注员。你只标注语言现象，不做道德判断，也不判断谁对谁错。',
    rubric,
    '关键区分：说话人【本人】正在这样做，还是他在转述、引用、反驳、嘲讽别人的话——只有前者算。',
    '可用类型（只能从下面这些里选；一条评论可以命中多个类型，也可以一个都不命中）：',
    typeDefsOf(ruleSet),
    '只输出 JSON，不要输出任何解释文字、不要用 markdown 代码块。',
  ].join('\n');
  const user = [
    '对下面每条评论，判断说话人本人有没有使用上述某一类话术。',
    '硬要求：quote 必须是从这条评论原文里【逐字复制】的一段文字（标点也要一致），不要改写、不要省略、不要加字、不要把两段拼起来；quote 要短，只保留真正起作用的那几个字词句。',
    'reason 用 20 字以内说明为什么算这一类。',
    '输出格式：{"results":[{"id":"<原样返回的 id>","matches":[{"type":"T1","quote":"逐字原话","reason":"20字内的理由"}]}]}',
    '每条评论都要出现在 results 里；不命中就给 "matches":[]。',
    JSON.stringify(batch.map((c) => ({ id: c.rpid, msg: c.msg.slice(0, 500) }))),
  ].join('\n');
  return { system, user };
}

/** LLM 模式主流程：分批 → 要逐字证据 → 机械闸门 → 通过闸门的才算命中 */
async function classifyWithLlm(comments, ruleSet, opts = {}) {
  const {
    kind = 'openai', baseUrl, apiKey = '', model,
    batchSize = 20, timeoutMs = 120000, fetchImpl = fetch, onProgress = () => {},
  } = opts;
  if (!baseUrl || !model) throw new huashu.HuashuError('LLM 模式需要提供 baseUrl 与模型名', 'usage');
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  const typeMap = new Map(ruleSet.types.map((t) => [t.id, t]));
  const stats = {
    requests: 0, failedCalls: 0, unjudged: 0, notFound: 0, quotedOut: 0,
    badType: 0, batches: 0, judged: 0, evidenceKept: 0,
  };
  const dropped = [];
  const perType = Object.fromEntries(ruleSet.types.map((t) => [t.id, 0]));
  const t0 = Date.now();
  const total = comments.length;

  async function callModel(system, user) {
    const body = { model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (kind === 'ollama') body.format = 'json';
    else body.response_format = { type: 'json_object' };
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      stats.requests++;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return j?.choices?.[0]?.message?.content ?? j?.message?.content ?? '';
    } finally { if (timer) clearTimeout(timer); }
  }

  const hits = [];
  for (let i = 0; i < total; i += batchSize) {
    const batch = comments.slice(i, i + batchSize);
    const reached = Math.min(i + batch.length, total);
    onProgress(reached, total, `LLM 逐条判定 ${reached}/${total}`);
    let rows = null, err = null;
    for (let t = 0; t < 2 && !rows; t++) {
      try {
        const p = buildLlmPrompt(ruleSet, batch);
        rows = huashu.parseModelRows(await callModel(p.system, p.user));
      } catch (e) { err = e; }
    }
    if (!rows) {
      stats.failedCalls++;
      stats.unjudged += batch.length;
      onProgress(reached, total, `本批失败，已跳过${err ? `（${err.message}）` : ''}`);
      continue;
    }
    stats.batches++;
    const byId = new Map(rows.map((r) => [String(r?.id), Array.isArray(r?.matches) ? r.matches : []]));
    for (const c of batch) {
      const accepted = [];
      for (const m of byId.get(String(c.rpid)) ?? []) {
        const id = String((m && (m.type ?? m.id)) ?? '').trim().toUpperCase();
        if (!typeMap.has(id)) { stats.badType++; continue; }            // 模型自己编的类型 → 丢
        const v = huashu.verifyQuote(c.msg, m && m.quote);
        if (!v.ok) {                                                    // 原文里找不到 → 丢
          stats.notFound++;
          dropped.push({ rpid: String(c.rpid), type: id, quote: String((m && m.quote) ?? ''), why: v.reason });
          continue;
        }
        if (v.insideQuote || v.reported) {                              // 疑似引述/转述 → 不算
          stats.quotedOut++;
          dropped.push({ rpid: String(c.rpid), type: id, quote: v.text, why: '疑似引述/转述，不算命中' });
          continue;
        }
        accepted.push({ id, name: typeMap.get(id).name, reason: String((m && m.reason) ?? ''), span: v.span, quote: v.text });
      }
      if (!accepted.length) continue;
      const byType = new Map();
      for (const a of accepted) {
        if (!byType.has(a.id)) byType.set(a.id, { id: a.id, name: a.name, score: null, reasons: [], evidence: [] });
        const rec = byType.get(a.id);
        if (a.reason && !rec.reasons.includes(a.reason)) rec.reasons.push(a.reason);
        rec.evidence.push({ src: 'llm', span: a.span, text: a.quote });
        stats.evidenceKept++;
      }
      for (const id of byType.keys()) perType[id] = (perType[id] ?? 0) + 1;   // 同一条评论同一类只计一次
      hits.push({
        rpid: String(c.rpid), user: c.user ?? '', uid: c.uid ?? '', like: c.like ?? 0,
        ctime: c.ctime ?? 0, bv: c.bv ?? '', jumpUrl: jumpUrlOf(c), msg: c.msg,
        types: [...byType.values()].map((t) => ({ ...t, reason: t.reasons.join('；') })),
        spans: accepted.map((a) => ({ quote: a.quote, span: a.span, type: a.id, reason: a.reason })),
        maxScore: 1, probs: null,
      });
    }
    onProgress(reached, total, '');
  }

  stats.judged = total - stats.unjudged;
  return {
    engine: 'model', mode: 'llm', hits, disputed: dropped.slice(0, 50), lowConfidence: [],
    modelLabel: model,
    stats: { ...stats, elapsedMs: Date.now() - t0, perType, threshold: null, passes: 1 },
    threshold: null,
  };
}

/* ---------- 决策模型（Jev / TypeSafe System One）客户端 ----------
 * 已按官方文档 lab/judge/JEV-API.md 落定（2026-09 调研：https://docs.typesafe.ai/api）：
 *   POST <baseUrl><path>，path 默认 "/v1/systemone"，baseUrl 默认 https://api.typesafe.ai
 *   body = { state, model, questions: { <类型id>: { type:"noul", instructions, criteria:{true,false} } } }
 *   resp = { model, answers: { <类型id>: { type:"noul", noul: 0~1 } }, usage }
 *
 * 官方没有 batch 端点（一次请求只能带一个 state），所以外层必然是「一评一请求」；
 * 但同一次请求可以带多个问题（官方 fan-out），所以 **8 个类型塞进同一个请求 = 1 条评论 1 次请求**（不是 8 次）。
 * 官方默认超时 10s、失败重试 2 次（退避 500ms→5s）；限流 100K tok/s、40 req/s；无 SSE。
 *
 * 三处可配（都从 body.decision 里配，不用改代码）：
 *   ① 端点：baseUrl 留空默认 https://api.typesafe.ai，path 留空默认 /v1/systemone
 *   ② 请求字段：questions 固定按官方 noul 形状（type/instructions/criteria.true|false）
 *   ③ 概率字段：默认读 answers[<类型id>].noul；读不到时用 decision.probabilityPath 手工指定
 *      （例如 "result.calibrated.true"）；**绝不退回读 top_probability**（那是「获胜选项」的概率，不是 P(true)）
 */
function readPath(obj, dotted) {
  // dotted 可以是 'a.b.c' 这样的点分字符串（前端手工填的「概率字段」），
  // 也可以是 ['a','b','c'] 这样的数组（extractPTrue 内置的那批候选路径）。
  // ⚠ 旧代码无条件 String(dotted).split('.')：数组会被 join 成 "a,b,c"，
  //   于是 ['probabilities','true'] 这种多段路径永远读不到（内置兜底路径全是死的）。
  const segs = Array.isArray(dotted) ? dotted.map((s) => String(s)) : String(dotted).split('.');
  let cur = obj;
  for (const seg of segs) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * 从决策模型返回里读 P(true)。显式不认 top_probability（那是获胜选项概率，不是 P(true)）。
 * @param answer    该题的答案对象（官方为 answers[<类型id>]；旧/自定义形状可能是整份响应）
 * @param probabilityPath 手工指定的字段路径（旧/自建网关用）：在 answer 里找不到时再去 rootJson 里找
 * @param rootJson  整份响应，仅用于 probabilityPath 的回退查找
 */
function extractPTrue(answer, probabilityPath = '', rootJson = null) {
  const clamp = (v) => Math.max(0, Math.min(1, v));
  // ① 手工指定的路径最优先（旧的 / 自建网关形状仍然生效）
  if (probabilityPath) {
    for (const src of [answer, rootJson]) {
      if (src == null || typeof src !== 'object') continue;
      const v = Number(readPath(src, probabilityPath));
      if (Number.isFinite(v)) return clamp(v);
    }
  }
  if (answer == null || typeof answer !== 'object') return null;
  // ② 官方 Jev 的 noul 形状：answers.<问题名>.noul 就是 P(true)（0~1）
  const noul = Number(answer.noul);
  if (Number.isFinite(noul)) return clamp(noul);
  // ③ 旧的通用形状兜底（p_true / true_probability / probabilities.true …）
  const paths = [
    ['p_true'], ['pTrue'], ['true_probability'], ['trueProbability'],
    ['prob_true'], ['probTrue'], ['probability_true'], ['calibrated_true'],
    ['calibrated', 'true'], ['probabilities', 'true'], ['probs', 'true'], ['scores', 'true'],
    ['result', 'p_true'], ['result', 'true_probability'], ['result', 'probabilities', 'true'],
    ['data', 'p_true'], ['data', 'true_probability'],
  ];
  for (const p of paths) {
    const v = Number(readPath(answer, p));
    if (Number.isFinite(v)) return clamp(v);
  }
  const t = Number(readPath(answer, 'true'));
  const f = Number(readPath(answer, 'false'));
  if (Number.isFinite(t) && Number.isFinite(f)) return clamp(t);
  return null;
}

async function classifyWithDecision(comments, ruleSet, opts = {}) {
  const {
    baseUrl = 'https://api.typesafe.ai', path: apiPath = '/v1/systemone', apiKey = '', probabilityPath = '',
    threshold = 0.6, batchSize = 8, timeoutMs = 10000, fetchImpl = fetch, onProgress = () => {},
    typeIds = null, typeDefs = null,
  } = opts;
  // batchSize 只为兼容前端旧字段而保留：官方没有 batch 端点，现在是「一评一请求」，这个值不再影响请求数
  void batchSize;
  // 官方 model 字段必填：留空就用 alias jev-latest
  const model = String(opts.model || '').trim() || 'jev-latest';
  if (!baseUrl) throw new huashu.HuashuError('决策模型模式需要填 API 地址（baseUrl）', 'usage');
  const types = ruleSet.types.filter((t) => !typeIds || typeIds.includes(t.id));
  const url = baseUrl.replace(/\/$/, '') + (String(apiPath).startsWith('/') ? apiPath : '/' + apiPath);
  const stats = { requests: 0, failedCalls: 0, unjudged: 0, questions: 0, singleQuestionFallback: false, batches: 0, judged: 0 };
  const perType = Object.fromEntries(ruleSet.types.map((t) => [t.id, 0]));
  const t0 = Date.now();
  const total = comments.length;
  const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };

  async function post(body) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      stats.requests++;
      const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { if (timer) clearTimeout(timer); }
  }

  const questionOf = (c, t) => `这段话的作者本人是否正在做出「${t.name}」这一动作？`;

  /** 组题：官方「一次请求 = 一个 state + 多个问题」（fan-out）的形状 */
  function buildQuestions(asked) {
    const questions = {};
    for (const t of asked) {
      const d = (typeDefs && typeDefs[t.id]) || {};
      const def = String(d.def || t.modelDef || t.note || '').trim();
      questions[t.id] = {
        type: 'noul',
        instructions: questionOf(null, t),
        criteria: {
          true: def,
          false: d.neg || t.modelFalse || (def ? `没有做出「${t.name}」这一动作，即不属于上述定义` : ''),
        },
      };
    }
    return questions;
  }

  /** 取某题的答案对象：官方是 answers.<问题名>；旧/自定义形状没有 answers 层时，整份响应就当答案行 */
  function answerOf(j, id) {
    const a = j && j.answers;
    if (a && typeof a === 'object' && !Array.isArray(a)) return a[id] ?? null;
    return j ?? null;
  }

  /** 一问多题：1 条评论 1 次请求，8 个类型在同一个请求里问完 */
  async function askTypes(c) {
    const j = await post({ state: c.msg, model, questions: buildQuestions(types) });
    stats.questions += types.length;
    const out = new Map();
    for (const t of types) {
      const p = extractPTrue(answerOf(j, t.id), probabilityPath, j);
      if (p != null) out.set(t.id, p);
    }
    return out;
  }

  /** 兜底：一问一题（多题形状不被支持时退化；仍是官方单题形状） */
  async function askTypeOne(c, t) {
    const j = await post({ state: c.msg, model, questions: buildQuestions([t]) });
    stats.questions++;
    return extractPTrue(answerOf(j, t.id), probabilityPath, j);
  }

  /** 先试「一问多题」；请求被拒（HTTP 错误）时退化成「一问一题」逐题问 */
  async function askComment(c) {
    let many = null, shapeError = null;
    try {
      many = await askTypes(c);
      if (many.size) return many;
    } catch (e) { many = null; shapeError = e; }
    // 请求回 200、但 8 道题里一道 P(true) 都认不出来 → 这是「字段名不对」，不是「形状不支持」：
    // 换成一问一题也是同一个字段名，白打 9 倍请求。所以第一条就发生的话直接报错说怎么查。
    if (!shapeError) {
      if (!stats.batches) {
        throw new huashu.HuashuError(
          `决策模型返回里读不出 P(true)（${url}）`,
          'network',
          '请求通了、但 8 道题的答案里都没有官方 noul 字段（answers.<问题名>.noul）。若这是自建/旧版网关、字段名不同，请在「概率字段」里手工指定（例如 result.calibrated.true）。注意 top_probability 不算 P(true)（那是「获胜选项」的概率）。',
        );
      }
      return new Map();
    }
    // 走到这里：多题形状被拒（HTTP 错误）→ 退化成单问
    stats.singleQuestionFallback = true;
    const out = new Map();
    if (many) for (const [k, v] of many) out.set(k, v);
    for (const t of types) {
      if (out.has(t.id)) continue;
      try {
        const p = await askTypeOne(c, t);
        if (p != null) out.set(t.id, p);
      } catch (e) {
        stats.failedCalls++;
        // 一条评论都没成功过 + 单问也报错 → 是接口/地址本身的问题，直接抛，
        // 不然的话一个填错的地址会把「每条评论 × 每个类型」都试一遍（上百次请求）。
        if (!stats.batches) {
          throw new huashu.HuashuError(
            `决策模型接口打不通（${url}）：${e.message}`,
            'network',
            '已按官方形状（state + questions，一问多题）和单题形状各试一次，都失败。请确认地址与请求路径（官方是 https://api.typesafe.ai/v1/systemone）；若接口能通但字段名不同，请在「概率字段」里手工指定（例如 result.calibrated.true）。注意 top_probability 不算 P(true)。',
          );
        }
      }
    }
    return out;
  }

  const hits = [];
  // 官方没有 batch 端点：一次请求只能带一个 state，所以这里就是「一评一请求」；
  // 8 个类型已经合并进同一个请求的 questions（见 askTypes），所以请求数 ≈ 评论数（而不是评论数 × 8）。
  for (let i = 0; i < total; i++) {
    const c = comments[i];
    const reached = i + 1;
    onProgress(reached, total, `决策模型判定 ${reached}/${total}（一评一请求）`);
    let probs;
    try {
      probs = await askComment(c);
    } catch (e) {
      if (e instanceof huashu.HuashuError) throw e;   // 接口本身打不通：不能静默跳成一份 0 命中的报告
      stats.unjudged++;
      onProgress(reached, total, `本条失败，已跳过（${e.message}）`);
      continue;
    }
    if (!probs.size) {
      stats.unjudged++;
      onProgress(reached, total, `本条没读出概率，已跳过（${c.rpid}）`);
      continue;
    }
    stats.batches++;
    const row = {};
    let answered = 0;
    for (const t of types) {
      const p = probs.get(t.id);
      if (p == null) continue;
      row[t.id] = Number(p.toFixed(4));
      answered++;
    }
    if (!answered) { stats.unjudged++; continue; }
    const hitTypes = types.filter((t) => (row[t.id] ?? 0) >= threshold).map((t) => ({
      id: t.id, name: t.name, score: row[t.id],
      evidence: [{ src: `decision:p=${row[t.id].toFixed(3)}`, span: null, text: '' }],
    }));
    if (!hitTypes.length) continue;
    for (const t of hitTypes) perType[t.id] = (perType[t.id] ?? 0) + 1;
    hits.push({
      rpid: String(c.rpid), user: c.user ?? '', uid: c.uid ?? '', like: c.like ?? 0,
      ctime: c.ctime ?? 0, bv: c.bv ?? '', jumpUrl: jumpUrlOf(c), msg: c.msg,
      types: hitTypes, spans: null, maxScore: Math.max(...hitTypes.map((t) => t.score)), probs: row,
    });
    onProgress(reached, total, '');
  }

  stats.judged = total - stats.unjudged;
  // 一次都没成功 → 不要“安静地打出一份 0 命中的报告”，直接失败并说清怎么查
  if (!stats.batches) {
    throw new huashu.HuashuError(
      `决策模型接口没能回答任何问题（${url}）`,
      'network',
      `已请求 ${stats.requests} 次全部失败。请确认：① 地址与请求路径对不对（官方是 https://api.typesafe.ai/v1/systemone）；② 返回里有没有 P(true)（官方 noul 形状为 answers.<问题名>.noul；旧形状为 p_true / true_probability / probabilities.true …）；③ 字段名不同时，在「概率字段」里手工指定（例如 result.calibrated.true）。注意 top_probability 不算 P(true)。`,
    );
  }
  return {
    engine: 'model', mode: 'decision', hits, disputed: [], lowConfidence: [], modelLabel: model,
    stats: { ...stats, elapsedMs: Date.now() - t0, perType, threshold, typesAsked: types.map((t) => t.id) },
    threshold,
  };
}

/* ---------------- 核心：抓评论 → 判定 → 结构化结果 ---------------- */
async function analyze(body, job) {
  const { ruleSet, warnings } = huashu.loadRulePacks({ pack: 'event-deepseek', rules: null });
  const engine = ['model', 'local'].includes(body.engine) ? body.engine : 'rules';
  const threshold = body.minScore ? Number(body.minScore) : ruleSet.threshold;
  const types = Array.isArray(body.types) && body.types.length ? body.types : null;

  let payload;
  if (body.demo) {
    setProgress(job, '示例语料', 0, huashu.DEMO_COMMENTS.length, '');
    payload = {
      target: { bvid: 'DEMO', aid: 0, title: '内置示例语料（12 条，覆盖 9 类与常见误报陷阱）', owner: '', pubdate: 0, duration: 0, view: 0 },
      comments: huashu.DEMO_COMMENTS.map((c) => ({ ...c, msg: huashu.normalizeEqualLength(c.msg), uid: '', ctime: 0, rcount: 0 })),
      meta: { mainCount: huashu.DEMO_COMMENTS.length, allCount: huashu.DEMO_COMMENTS.length, rcountSum: 0, elapsedMs: 0, errorCount: 0, truncated: false, degraded: false, pages: 0 },
    };
  } else {
    if (!body.input || !String(body.input).trim()) throw new huashu.HuashuError('请先填视频链接或 BV 号', 'usage');
    setProgress(job, '抓取评论', 0, 0, '正在取视频信息…');
    payload = await huashu.fetchComments(String(body.input).trim(), {
      cookie: body.cookie ? String(body.cookie) : '',
      delayMs: body.delay ? Number(body.delay) : 120,
      maxComments: body.maxComments ? Number(body.maxComments) : 2000,
      onProgress: (msg) => {
        const m = /已抓 (\d+) 条/.exec(msg);
        setProgress(job, '抓取评论', m ? Number(m[1]) : job.progress.done, 0, msg);
      },
    });
    if (payload.meta.degraded && !body.allowPartial) {
      throw new huashu.HuashuError('疑似风控降级：只拿到 3 条主评论，但视频总评论数更多', 'network',
        '默认拒绝出报告（避免“平静地打出一份错报告”）。确认视频真的只有 3 条主评论时，可勾选“允许风控降级结果”。');
    }
  }

  const total = payload.comments.length;
  let result;
  const typeName = (t) => (ruleSet.types.find((x) => x.id === t) || {}).name || t;
  if (engine === 'local') {
    // 本地微调模型（Erlangshen-110M，8 类）：调 model-server/serve.py
    // 地址优先级：请求体指定 > 启动器传入的 HUASHU_MODEL_URL > 默认 8790。
    // 启动器若用 HUASHU_PY_PORT 挪了模型端口，会同步把这个变量传给网页服务，
    // 否则两边对不上（表现为「分析失败：fetch failed」）。
    const base = (body.local && body.local.url)
      || process.env.HUASHU_MODEL_URL
      || 'http://127.0.0.1:8790';
    const th = Number(body.minScore) || Number(body.local && body.local.threshold) || 0.5;
    setProgress(job, '本地模型判定', 0, total, `8 类多标签，阈值 ${th}`);
    const texts = payload.comments.map((c) => String(c.msg));
    const res = await fetch(base.replace(/\/$/, '') + '/classify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts }),
    });
    if (!res.ok) throw new Error(`本地模型服务返回 HTTP ${res.status}（先跑 model-server/serve.py）`);
    const j = await res.json();
    const T = j.types;
    const hits = [];
    const perType = Object.fromEntries(T.map((t) => [t, 0]));
    payload.comments.forEach((c, i) => {
      const row = j.results[i] || {};
      const types2 = T.filter((t) => (row[t] ?? 0) >= th).map((t) => ({
        id: t, name: typeName(t), score: Number((row[t]).toFixed(4)),
        evidence: [{ src: `local:p=${(row[t]).toFixed(3)}`, span: null, text: '' }],
      }));
      if (!types2.length) return;
      for (const t of types2) perType[t.id] = (perType[t.id] ?? 0) + 1;
      hits.push({
        rpid: String(c.rpid), user: c.user ?? '', uid: c.uid ?? '', like: c.like ?? 0,
        ctime: c.ctime ?? 0, bv: c.bv ?? '',
        // 语料里没有 jumpUrl 字段，得自己拼 —— 之前这里取的 c.jumpUrl 恒为空，所以按钮是坏的
        jumpUrl: c.bv ? `https://www.bilibili.com/video/${c.bv}/#reply${c.rpid}` : (c.jumpUrl || ''), msg: c.msg,
        types: types2, maxScore: Math.max(...types2.map((t) => t.score)),
        probs: Object.fromEntries(T.map((t) => [t, row[t]])),
      });
    });
    result = {
      engine: 'local', hits, lowConfidence: [],
      stats: { judged: total, unjudged: 0, elapsedMs: j.elapsed_ms, perType, threshold: th },
      threshold: th,
    };
    setProgress(job, '本地模型判定', total, total, '');
  } else if (engine === 'model') {
    const ai = body.ai ?? {};
    // 子模式：llm（把九类规则写成提示词交给用户的 LLM）/ decision（typed 决策模型读 P(true)）
    const wantMode = String(body.modelMode || '').toLowerCase();
    const modelMode = wantMode === 'decision' ? 'decision'
      : wantMode === 'llm' ? 'llm'
        : (body.decision ? 'decision' : 'llm');

    if (modelMode === 'decision') {
      const d = body.decision ?? {};
      const th = Number(body.minScore) || Number(d.threshold) || 0.6;
      setProgress(job, '决策模型判定', 0, total, `typed 决策模型（Jev）：1 条评论 1 次请求、8 类合并成一个请求，阈值 ${th}`);
      result = await classifyWithDecision(payload.comments, ruleSet, {
        baseUrl: d.url || d.baseUrl || 'https://api.typesafe.ai',
        path: d.path || '/v1/systemone',
        apiKey: d.apiKey || '',
        model: d.model || 'jev-latest',
        probabilityPath: d.probabilityPath || '',
        threshold: th,
        typeIds: Array.isArray(d.types) && d.types.length ? d.types : null,
        typeDefs: loadTypeDefs(),   // 每类的 modelDef → 官方 criteria.true
        batchSize: Math.max(1, Number(d.batchSize) || 8),   // 兼容前端旧字段（现已不影响请求数）
        timeoutMs: Number(ai.timeoutMs) || 120000,
        onProgress: (done, all, msg) => setProgress(job, '决策模型判定', done, all, msg || ''),
      });
    } else {
      const spec = huashu.parseAiSpec(
        ai.spec || `openai:${ai.baseUrl || 'http://127.0.0.1:11434/v1'}#${ai.model || ''}`,
        ai.apiKey || '',
      );
      const batchSize = Math.max(1, Number(ai.batchSize) || 20);
      if (String(ai.style || '') === 'two') {
        // 旧的「两级判定」路径原样保留：先判家族、再逐字定位（已验证过，别动）
        const passes = Math.max(1, Number(ai.passes) || 2);
        setProgress(job, '模型判定', 0, total, `两级判定（粗筛→逐字证据）× ${passes} 遍，交给 ${spec.label}`);
        result = await huashu.classifyWithModel(payload.comments, ruleSet, {
          kind: spec.kind, baseUrl: spec.baseUrl, apiKey: spec.apiKey, model: spec.model,
          batchSize, passes, timeoutMs: Number(ai.timeoutMs) || 120000,
          onProgress: (done, all, msg) => setProgress(job, '模型判定', done, all, msg || ''),
        });
        result.mode = 'two';
      } else {
        setProgress(job, 'LLM 判定', 0, total, `九类规则写成提示词，逐条判断 + 逐字证据闸门，交给 ${spec.label}`);
        result = await classifyWithLlm(payload.comments, ruleSet, {
          kind: spec.kind, baseUrl: spec.baseUrl, apiKey: spec.apiKey, model: spec.model,
          batchSize, timeoutMs: Number(ai.timeoutMs) || 120000,
          onProgress: (done, all, msg) => setProgress(job, 'LLM 判定', done, all, msg || ''),
        });
      }
    }
  } else {
    setProgress(job, '规则判定', 0, total, '');
    result = huashu.detect(payload.comments, ruleSet, { types, threshold });
    setProgress(job, '规则判定', total, total, '');
  }

  // 统一兜底：所有引擎的 jumpUrl 都得是能点的 http(s) 链接（demo 语料没真 bv → 空串，前端不渲染链接）
  for (const h of result.hits) h.jumpUrl = jumpUrlFor(h, payload.target.bvid);

  const modelLabel = engine === 'model' ? job.progress.message : '';
  return {
    ok: true,
    engine,
    mode: result.mode ?? null,
    warnings,
    target: payload.target,
    meta: payload.meta,
    rules: ruleSet.names,
    engineLabel: engine === 'local'
      ? `本地微调模型（Erlangshen-110M·8类）｜阈值 ${result.threshold}｜命中 ${result.hits.length} 条｜作者体感约 70%（未做严格人工统计）`
      : engine === 'model'
        ? (result.mode === 'decision'
          ? `决策模型·typed 判定（state + 8 道 noul 是非题 → answers.<id>.noul）｜阈值 ${result.threshold}｜请求 ${result.stats?.requests ?? 0} 次（≈评论数）｜未判定 ${result.stats?.unjudged ?? 0} 条｜⚠ 官方称中文准确率不背书、不同决策模型的阈值也不同，需自行微调`
          : result.mode === 'two'
            ? `模型·两级判定${result.stats?.unjudged ? `｜未判定 ${result.stats.unjudged} 条` : ''}｜自一致率 ${(((result.stats?.selfAgreement) ?? 0) * 100).toFixed(1)}%`
            : `LLM 逐条判定｜模型 ${result.modelLabel || ''}｜请求 ${result.stats?.requests ?? 0} 次｜证据过闸门 ${result.stats?.evidenceKept ?? 0} 条（丢弃 ${(result.stats?.notFound ?? 0) + (result.stats?.quotedOut ?? 0)} 条）｜命中 ${result.hits.length} 条｜本模式不出概率`)
        : `规则 ${ruleSet.names.join('+')}｜阈值 ${threshold}`,
    types: ruleSet.types.map((t) => ({ id: t.id, name: t.name, note: t.note })),
    threshold: result.threshold,
    hitCount: result.hits.length,
    stats: result.stats,
    unjudged: result.stats?.unjudged ?? 0,
    lowConfidenceCount: result.lowConfidence?.length ?? 0,
    hits: result.hits,
    disputed: result.disputed ?? [],
    modelStats: result.stats ?? null,
    disclaimer: engine === 'local'
      ? '本结果由【本地微调模型】判定（Erlangshen-110M，8 类多标签，弱标签训练）。它在教科书样本上区分度很高，但真实评论上的准确率没有做过严格人工统计，作者体感约 70%——**请当粗筛用，必须人工复核**。'
      : engine === 'model'
        ? (result.mode === 'decision'
          ? '本结果由【决策模型（Jev / TypeSafe System One）】判定：一次请求带一个 state + 多道 noul 是非题，读的是 answers.<类型id>.noul（P(true) 校准概率）。⚠ 官方明确说中文（CJK）准确率不背书、不同模型的口径/阈值/准确度也都不一样，同一套阈值换个模型就会失效——请自己微调阈值，且必须人工复核。'
          : result.mode === 'two'
            ? '本结果由语言模型判定得出（两级：先判家族、再逐字抄证据），模型可能出错，请结合原文人工复核。'
            : '本结果由【LLM 逐条判定】得出：只保留能从原文逐字抄回证据的命中，抄不回的一律丢弃。模型仍可能出错，请结合原文人工复核。')
        : huashu.DISCLAIMER,
  };
}

/* ---------------- HTTP ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const p = path.join(WEB_DIR, 'index.html');
    if (!fs.existsSync(p)) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('找不到 web/index.html'); return; }
    const html = fs.readFileSync(p);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
    res.end(html);
    return;
  }

  // 提交任务：立刻返回 jobId，网页拿它轮询进度
  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); }
    catch { sendJson(res, 200, { ok: false, kind: 'usage', error: '请求体不是合法 JSON' }); return; }
    const job = newJob();
    sendJson(res, 200, { ok: true, jobId: job.id });
    analyze(body, job)
      .then((out) => { job.result = out; job.status = 'done'; })
      .catch((e) => {
        job.status = 'error';
        job.error = e.message;
        job.detail = e.detail ?? '';
        job.kind = e instanceof huashu.HuashuError ? e.kind : 'usage';
        process.stdout.write(`[分析失败] ${e.message}\n`);
      });
    return;
  }

  // 查询任务
  if (req.method === 'GET' && url.pathname.startsWith('/api/job/')) {
    const id = url.pathname.slice('/api/job/'.length);
    const job = jobs.get(id);
    if (!job) { sendJson(res, 404, { ok: false, error: '任务不存在或已过期' }); return; }
    sendJson(res, 200, {
      ok: true, status: job.status, progress: job.progress,
      result: job.status === 'done' ? job.result : null,
      error: job.error, detail: job.detail, kind: job.kind ?? null,
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404');
});

server.listen(PORT, HOST, () => {
  const link = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  话术照妖镜 · spinlens 网页版已启动');
  console.log(`  在浏览器打开： ${link}`);
  console.log('  按 Ctrl + C 停止服务');
  console.log('');
  if (argv.includes('--open')) {
    try {
      const child = spawn('cmd', ['/c', 'start', '', link], { stdio: 'ignore', detached: true });
      child.unref();
    } catch {
      console.log('  （自动打开浏览器失败，请手动复制上面的地址）');
    }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`端口 ${PORT} 被占用了，换一个：node server.js --port 8899`);
  else console.error('服务启动失败：', e.message);
  process.exit(1);
});
