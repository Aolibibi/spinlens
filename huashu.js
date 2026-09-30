#!/usr/bin/env node
/**
 * spinlens · 话术照妖镜（文件名 huashu.js 为历史遗留，改名会牵动 require 路径，故保留）
 * ---------------------------------------------------------------------------
 * 输入一个 B 站视频链接（或 BV/av 号），得到一份「这条视频里有多少条评论在
 * 使用话术、分别是哪几类、原文是哪条」的可核对报告。
 *
 * 设计约束（沿用 SPEC）：
 *   · 零第三方运行时依赖（只用 node: 内置模块 + 全局 fetch）
 *   · 单入口文件，可直接复制到别人电脑上跑
 *   · 检测过程完全基于规则（正则 + 字符串），不调用任何模型
 *   · 免责声明硬性输出：这是筛子，不是判决
 *
 * 模块划分（每个模块都可以单独删掉做「删除测试」）：
 *   RuleSet   —— 规则加载与编译（含正则安全 lint）
 *   Detector  —— 纯函数：Comment[] + RuleSet → Hit[]（不认识 B 站，也不知道怎么打印）
 *   Fetcher   —— 只管把评论拿回来（含 WBI 签名、游标翻页、风控降级自检）
 *   Refiner   —— 可选 AI 精排（只做精排，不做召回；失败静默降级但会显示）
 *   Reporter  —— renderSummary / renderCsv
 *   CLI       —— 参数解析、错误提示、退出码
 *
 * 用法： node huashu.js --help
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* =========================================================================
 * 0. 常量与错误
 * ========================================================================= */

const VERSION = '1.0.0';
const RULE_SCHEMA_VERSION = 2;
const DISCLAIMER = '本结果由当前规则匹配得出，不是事实判定，请结合原文人工复核。';
const DEFAULT_MAX_COMMENTS = 2000;   // 实测 7176 字节/条，十万条就是 684MB，必须设上限
const DEFAULT_DELAY_MS = 120;
const MAX_RETRY = 3;
const RETRY_BACKOFF_MS = [800, 1600, 2400];
const HTTP_TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

const EXIT = { OK: 0, USAGE: 1, NETWORK: 2, RULES: 3 };

/** 统一的错误类型：kind 决定退出码与提示措辞 */
class HuashuError extends Error {
  constructor(message, kind = 'usage', detail = '') {
    super(message);
    this.name = 'HuashuError';
    this.kind = kind;       // usage | network | rules
    this.detail = detail;
  }
}

const EXIT_OF_KIND = { usage: EXIT.USAGE, network: EXIT.NETWORK, rules: EXIT.RULES };

/* =========================================================================
 * 1. 文本归一化与通用工具
 * ========================================================================= */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等长归一化（关键！）
 * 换行/制表 → 空格；孤立代理字符（半个 emoji）→ U+FFFD。
 * 这里必须「一个字符换一个字符」，否则证据的字符区间会整体错位。
 */
function normalizeEqualLength(s) {
  const src = String(s ?? '');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x0a || c === 0x0d || c === 0x09) { out += ' '; continue; }
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = src.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) { out += src[i] + src[i + 1]; i++; continue; }
      out += '\uFFFD';           // 孤立高位代理：直接替换，绝不能留在请求体里
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) { out += '\uFFFD'; continue; }
    out += src[i];
  }
  return out;
}

/** B 站表情标记 [xxx] → 等长空格（否则「[吃瓜]」里的“吃瓜”会喂给正则） */
const blankTags = (s) => s.replace(/\[[^\]]{0,14}\]/g, (m) => ' '.repeat(m.length));

const QUOTE_PAIRS = [['“', '”'], ['"', '"'], ['「', '」'], ['『', '』']];

/** 命中片段是否落在成对引号内（= 引用他人原话） */
function insideQuote(msg, at) {
  for (const [open, close] of QUOTE_PAIRS) {
    let i = msg.indexOf(open);
    while (i !== -1) {
      const j = msg.indexOf(close, i + 1);
      if (j === -1) break;
      if (at > i && at < j) return true;
      i = msg.indexOf(open, j + 1);
    }
  }
  return false;
}

const SENT_SEP = /[。！？!?\n]/;

/** 取命中位置所在的整句 */
function sentenceAt(msg, at) {
  let s = at;
  let e = at;
  while (s > 0 && !SENT_SEP.test(msg[s - 1])) s--;
  while (e < msg.length && !SENT_SEP.test(msg[e])) e++;
  return msg.slice(s, e);
}

/** 指控式反问：「总不能…吧」「谁才是…」「是不是…」——这类是反驳，不是使用 */
function looksRhetorical(msg, at) {
  const t = sentenceAt(msg, at).trim();
  return /(总不能|难道|是不是|谁才|还用(别人)?说|哪来的|凭什么)/.test(t);
}

/** CSV 单元格：永远加引号 + 公式注入防护（Excel 会把 = + - @ 开头当公式） */
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function timestampTag(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/* =========================================================================
 * 2. RuleSet —— 规则加载与编译
 * ========================================================================= */

/** 灾难性回溯的静态 lint：宁可跳过一条正则，也不能让主线程卡死 */
const REGEX_LINT = [
  { re: /\([^()]*[+*][^()]*\)[+*]/, why: '嵌套量词，可能灾难性回溯' },
  { re: /\(\.\*\)[+*]/, why: '嵌套量词，可能灾难性回溯' },
  { re: /\(\.\+\)[+*]/, why: '嵌套量词，可能灾难性回溯' },
  { re: /\{\d{3,}(,\d*)?\}/, why: '重复次数过大' },
];

/**
 * 编译一条正则：失败只跳过这一条并记警告（SPEC §6.1：不整体崩溃）。
 * 注意：我们是从字符串编译的，所以 g / y 标志天然不存在——不会出现
 * 「带 g 的 lastIndex 残留导致漏匹配」这种坑。
 */
function compileRuleRegex(src, where, warnings) {
  try {
    if (typeof src !== 'string' || src.length === 0) throw new Error('空正则');
    if (src.length > 200) throw new Error('正则过长（>200 字符）');
    for (const l of REGEX_LINT) if (l.re.test(src)) throw new Error(l.why);
    return new RegExp(src);
  } catch (e) {
    warnings.push(`${where} 跳过一条正则：${e.message}`);
    return null;
  }
}

function mergeRuleSets(packs) {
  const merged = {
    version: RULE_SCHEMA_VERSION,
    names: packs.map((p) => p.name),
    threshold: packs[0].threshold,
    lexiconWeight: packs[0].lexiconWeight,
    lexiconCap: packs[0].lexiconCap,
    contextGuards: packs[0].contextGuards ?? { negationBefore: [], negationWindow: 12, penalty: 0.7 },
    metaGuards: [],
    stanceBlacklists: { combat: [] },
    types: [],
  };
  const seenType = new Set();
  for (const p of packs) {
    for (const g of p.metaGuards ?? []) if (!merged.metaGuards.includes(g)) merged.metaGuards.push(g);
    for (const w of p.stanceBlacklists?.combat ?? []) if (!merged.stanceBlacklists.combat.includes(w)) merged.stanceBlacklists.combat.push(w);
    for (const t of p.types ?? []) {
      if (seenType.has(t.id)) continue;   // 后加载的包不覆盖同名类型，先到先得
      seenType.add(t.id);
      merged.types.push(t);
    }
  }
  return merged;
}

/** 编译整个规则集（把字符串正则变成 RegExp，并收集警告） */
function compileRuleSet(raw) {
  if (!raw || typeof raw !== 'object') throw new HuashuError('规则文件不是合法 JSON 对象', 'rules');
  if (Number(raw.version) !== RULE_SCHEMA_VERSION) {
    throw new HuashuError(
      `规则文件版本不支持：期望 ${RULE_SCHEMA_VERSION}，实际 ${raw.version ?? '(缺失)'}`,
      'rules',
      '请使用配套版本的规则包，或升级本脚本。',
    );
  }
  if (!Array.isArray(raw.types) || raw.types.length === 0) throw new HuashuError('规则文件里没有任何类型（types 为空）', 'rules');

  const warnings = [];
  const compiled = {
    names: raw.names ?? [raw.name ?? 'unknown'],
    threshold: Number(raw.threshold ?? 0.6),
    lexiconWeight: Number(raw.lexiconWeight ?? 0.25),
    lexiconCap: Number(raw.lexiconCap ?? 2),
    contextGuards: {
      negationBefore: raw.contextGuards?.negationBefore ?? [],
      negationWindow: Number(raw.contextGuards?.negationWindow ?? 12),
      penalty: Number(raw.contextGuards?.penalty ?? 0.7),
    },
    metaGuards: [],
    combat: raw.stanceBlacklists?.combat ?? [],
    types: [],
  };

  for (const g of raw.metaGuards ?? []) {
    const re = compileRuleRegex(g, 'metaGuards', warnings);
    if (re) compiled.metaGuards.push({ src: g, re });
  }

  for (const t of raw.types) {
    if (!t || typeof t.id !== 'string' || typeof t.name !== 'string') {
      warnings.push('跳过一条类型定义：缺少 id 或 name');
      continue;
    }
    const type = {
      id: t.id,
      name: t.name,
      note: t.note ?? '',
      combatSafe: t.combatSafe === true,
      lexicon: Array.isArray(t.lexicon) ? t.lexicon.filter((w) => typeof w === 'string' && w) : [],
      patterns: [],
    };
    for (const p of t.patterns ?? []) {
      const re = compileRuleRegex(p?.re, `${t.id}`, warnings);
      if (!re) continue;
      const require = (p.require ?? []).map((r) => compileRuleRegex(r, `${t.id}.require`, warnings)).filter(Boolean);
      const guard = (p.guard ?? []).map((r) => compileRuleRegex(r, `${t.id}.guard`, warnings)).filter(Boolean);
      const guardBefore = (p.guardBefore ?? []).map((r) => compileRuleRegex(r, `${t.id}.guardBefore`, warnings)).filter(Boolean);
      type.patterns.push({ src: p.re, re, score: Number(p.score ?? 0.8), require, guard, guardBefore, qGuard: p.qGuard === true });
    }
    if (type.patterns.length === 0 && type.lexicon.length === 0) {
      warnings.push(`跳过类型 ${t.id}：既没有可用句式，也没有词表`);
      continue;
    }
    compiled.types.push(type);
  }
  if (compiled.types.length === 0) throw new HuashuError('规则文件里没有可用类型（全部编译失败）', 'rules');

  return { compiled, warnings };
}

/* =========================================================================
 * 3. Detector —— 纯函数
 * ========================================================================= */

/**
 * 检测评论。
 * @param {Array} comments  Comment[]
 * @param {Object} ruleSet  compileRuleSet() 的产物
 * @param {Object} opts     { types?: string[], threshold?: number }
 * @returns {{hits: Array, lowConfidence: Array, stats: Object}}
 *
 * 两段式闸门：一条命中必须同时满足
 *   ① 至少有一条「句式」命中且没被任何闸门压掉（词表只能加成，不能单独越线）
 *   ② 总分 ≥ 阈值
 */
function detect(comments, ruleSet, opts = {}) {
  const typeFilter = opts.types && opts.types.length ? new Set(opts.types) : null;
  const threshold = Number(opts.threshold ?? ruleSet.threshold);
  const types = ruleSet.types.filter((t) => !typeFilter || typeFilter.has(t.id));
  const LW = ruleSet.lexiconWeight;
  const CAP = ruleSet.lexiconCap;
  const CG = ruleSet.contextGuards;

  const hits = [];
  const lowConfidence = [];
  const stats = { metaGuarded: 0, quoteGuarded: 0, qGuarded: 0, guardedPatterns: 0, belowThreshold: 0, combatSkipped: 0 };

  for (const c of comments) {
    const norm = normalizeEqualLength(c.msg);      // guard 看这份（等长）
    const mt = blankTags(norm);                    // 句式匹配看这份（等长）

    // 元话语/清单闸门：整条评论在讨论「话术本身」→ 不评
    if (ruleSet.metaGuards.some((g) => g.re.test(norm))) { stats.metaGuarded++; continue; }

    const isCombat = ruleSet.combat.length > 0 && ruleSet.combat.some((w) => norm.includes(w));
    const per = [];

    for (const t of types) {
      // 战斗词黑名单：劝和者不会同时骂人
      if (t.combatSafe === true && isCombat) { stats.combatSkipped++; continue; }

      let raw = 0;
      let patternHit = false;
      let anyGuarded = false;
      const evidence = [];

      for (const p of t.patterns) {
        if (!p.re.test(mt)) continue;
        const m = mt.match(p.re);
        if (m && insideQuote(mt, m.index)) {
          stats.quoteGuarded++; anyGuarded = true;
          lowConfidence.push({ rpid: c.rpid, type: t.id, score: null, reason: '引用（命中片段在引号内）', msg: c.msg });
          continue;
        }
        if (p.require.length && !p.require.some((r) => r.test(mt))) continue;
        // guardBefore：只看命中点【之前】的文字。专门用来识别「说 X 是 Y」这种转述结构，
        // 而不会被句子末尾的「…还有什么好说的」误伤。
        if (p.guardBefore.length && m && p.guardBefore.some((g) => g.test(mt.slice(0, m.index)))) {
          stats.guardedPatterns++; anyGuarded = true;
          lowConfidence.push({ rpid: c.rpid, type: t.id, score: null, reason: '命中点之前出现转述标记', msg: c.msg });
          continue;
        }
        if (p.guard.length && p.guard.some((g) => g.test(norm))) {
          stats.guardedPatterns++; anyGuarded = true;
          lowConfidence.push({ rpid: c.rpid, type: t.id, score: null, reason: '撞上转述/反讽 guard', msg: c.msg });
          continue;
        }
        if (p.qGuard && m && looksRhetorical(mt, m.index)) {
          stats.qGuarded++; anyGuarded = true;
          lowConfidence.push({ rpid: c.rpid, type: t.id, score: null, reason: '指控式反问', msg: c.msg });
          continue;
        }
        raw += p.score;
        patternHit = true;
        evidence.push({ src: `pattern:${p.src}`, span: [m.index, m.index + m[0].length], text: m[0] });
      }

      let lexN = 0;
      for (const w of t.lexicon) {
        if (mt.includes(w)) { lexN++; evidence.push({ src: `lexicon:${w}` }); }
      }
      if (lexN) raw += LW * Math.min(lexN, CAP);

      if (raw <= 0) {
        if (anyGuarded) stats.belowThreshold++;
        continue;
      }

      let score = Math.min(1, raw);

      // 兼容 SPEC v1 的老式语境闸门（默认规则包为空列表）
      for (const g of CG.negationBefore) {
        const gi = norm.indexOf(g);
        if (gi < 0) continue;
        for (const w of t.lexicon) {
          const wi = norm.indexOf(w);
          if (wi > gi && wi - gi <= CG.negationWindow) score *= 1 - CG.penalty;
        }
      }

      if (score >= threshold && patternHit) {
        per.push({ id: t.id, name: t.name, score: Number(score.toFixed(3)), evidence: evidence.slice(0, 6) });
      } else if (patternHit) {
        stats.belowThreshold++;
        lowConfidence.push({ rpid: c.rpid, type: t.id, score: Number(score.toFixed(3)), reason: '分数低于阈值', msg: c.msg });
      }
    }

    if (per.length) {
      hits.push({
        rpid: String(c.rpid),
        user: c.user ?? '',
        uid: c.uid ?? '',
        like: c.like ?? 0,
        ctime: c.ctime ?? 0,
        jumpUrl: c.jumpUrl ?? '',
        msg: c.msg,
        types: per,
        maxScore: Math.max(...per.map((x) => x.score)),
      });
    }
  }
  return { engine: 'rules', hits, lowConfidence, stats, threshold };
}

/* =========================================================================
 * 4. Fetcher —— WBI 签名 + 游标翻页 + 风控自检
 * ========================================================================= */

const WBI_MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const mixinKey = (imgKey, subKey) => WBI_MIXIN_TAB.map((i) => (imgKey + subKey)[i]).join('').slice(0, 32);

/** 把目标（URL / BV / av / 整段分享文本 / b23 短链）解析成可识别的对象 */
function parseTarget(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new HuashuError('没有输入视频地址', 'usage');
  const bv = /BV[0-9A-Za-z]{10}/.exec(text);
  if (bv) return { kind: 'bvid', bvid: bv[0] };
  const av = /\bav(\d{1,12})\b/i.exec(text);
  if (av) return { kind: 'aid', aid: Number(av[1]) };
  const short = /https?:\/\/b23\.tv\/[0-9A-Za-z]+/.exec(text);
  if (short) return { kind: 'short', url: short[0] };
  if (/^\d{1,12}$/.test(text)) return { kind: 'aid', aid: Number(text) };
  throw new HuashuError(`无法识别的输入：${text.slice(0, 60)}`, 'usage', '支持：完整链接 / BV 号 / av 号 / 分享文本 / b23.tv 短链。');
}

function createHttp({ fetchImpl, cookie, timeoutMs }) {
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
  if (cookie) headers.Cookie = cookie;

  async function request(url, extraHeaders = {}) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetchImpl(url, { headers: { ...headers, ...extraHeaders }, signal: ctrl ? ctrl.signal : undefined });
    } catch (e) {
      // Node 的全局 fetch 不走 HTTP(S)_PROXY：这里把底层原因翻出来，方便用户判断
      const cause = e?.cause?.code ?? e?.cause?.message ?? '';
      throw new HuashuError(`网络请求失败：${e.message}${cause ? `（${cause}）` : ''}`, 'network',
        'Node 自带 fetch 不吃系统代理；如需代理请用支持代理的 Node 版本或换网络环境。');
    } finally {
      if (timer) clearTimeout(timer);
    }
    return res;
  }

  async function getJson(url) {
    const res = await request(url);
    if (!res.ok) throw new HuashuError(`接口返回 HTTP ${res.status}`, 'network');
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) throw new HuashuError(`接口没有返回 JSON（content-type: ${ct || '空'}）`, 'network',
      '常见原因：Referer 不对被 403、或接口已经变更。');
    return res.json();
  }

  return { request, getJson };
}

/**
 * 抓取一个视频的主评论。
 * @returns {{target, comments, meta}}
 */
async function fetchComments(input, options = {}) {
  const {
    fetchImpl = fetch,
    now = Date.now,
    sleepImpl = sleep,
    delayMs = DEFAULT_DELAY_MS,
    maxComments = DEFAULT_MAX_COMMENTS,
    cookie = '',
    timeoutMs = HTTP_TIMEOUT_MS,
    onProgress = () => {},
  } = options;

  const http = createHttp({ fetchImpl, cookie, timeoutMs });
  const startedAt = now();

  async function withRetry(fn, what) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (attempt === MAX_RETRY) break;
        await sleepImpl(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
        onProgress(`重试 ${what}（第 ${attempt + 1} 次）：${e.message}`);
      }
    }
    throw lastErr;
  }

  // 1) 解析目标
  let parsed = parseTarget(input);
  if (parsed.kind === 'short') {
    const res = await withRetry(() => http.request(parsed.url), '短链解析');
    const finalUrl = res.url ?? '';
    const m = /BV[0-9A-Za-z]{10}/.exec(finalUrl);
    if (!m) throw new HuashuError('短链解析失败：跳转后没有 BV 号（动态/专栏链接不支持）', 'network');
    parsed = { kind: 'bvid', bvid: m[0] };
    onProgress(`短链解析 → ${m[0]}`);
  }

  // 2) 视频信息（顺带拿到 aid）
  const viewUrl = parsed.kind === 'bvid'
    ? `https://api.bilibili.com/x/web-interface/view?bvid=${parsed.bvid}`
    : `https://api.bilibili.com/x/web-interface/view?aid=${parsed.aid}`;
  const view = await withRetry(() => http.getJson(viewUrl), '取视频信息');
  if (view.code !== 0) throw new HuashuError(`取视频信息失败：code=${view.code} ${view.message ?? ''}`, 'network');
  const { aid, bvid, title, owner, pubdate, duration, stat } = view.data;
  onProgress(`目标：${bvid}《${title}》`);

  // 3) WBI 密钥（nav 未登录也能拿到）
  const nav = await withRetry(() => http.getJson('https://api.bilibili.com/x/web-interface/nav'), '取 WBI 密钥');
  const imgKey = String(nav?.data?.wbi_img?.img_url ?? '').split('/').pop().split('.')[0];
  const subKey = String(nav?.data?.wbi_img?.sub_url ?? '').split('/').pop().split('.')[0];
  if (!imgKey || !subKey) throw new HuashuError('取不到 WBI 密钥（nav 接口异常）', 'network',
    '接口可能已变更，请到项目主页看有没有更新。');
  const mixin = mixinKey(imgKey, subKey);

  const sign = (params) => {
    const withWts = { ...params, wts: Math.round(now() / 1000) };
    const query = Object.keys(withWts).sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withWts[k]).replace(/[!'()*]/g, ''))}`)
      .join('&');
    const wRid = crypto.createHash('md5').update(query + mixin).digest('hex');
    return `${query}&w_rid=${wRid}`;
  };

  // 4) 翻页抓主评论
  const comments = [];
  let offset = '';
  let prevIds = '';
  let errorCount = 0;
  let pages = 0;
  let truncated = false;
  let allCount = 0;
  let rcountSum = 0;

  for (let page = 0; page < 2000; page++) {
    if (comments.length >= maxComments) { truncated = true; break; }
    const query = sign({
      oid: aid, type: 1, mode: 2, next: 0, ps: 30, plat: 1,
      web_location: 1315873, pagination_str: JSON.stringify({ offset }),
    });
    let json;
    try {
      json = await withRetry(() => http.getJson('https://api.bilibili.com/x/v2/reply/wbi/main?' + query), '取评论');
    } catch (e) {
      errorCount++;
      onProgress(`第 ${page + 1} 页失败：${e.message}`);
      if (errorCount >= 3) break;
      continue;
    }
    if (json.code !== 0) { errorCount++; onProgress(`接口返回 code=${json.code} ${json.message ?? ''}`); break; }

    const replies = json.data?.replies ?? [];
    allCount = json.data?.cursor?.all_count ?? allCount;
    const ids = replies.map((x) => String(x.rpid)).join(',');
    // B-2 游标失效自检：实测传非法 offset 仍返回首页且 next_offset 会变，只能靠 rpid 集合判死
    if (ids && ids === prevIds) { onProgress('检测到游标失效（本页与上页完全相同）→ 立即中止'); break; }
    prevIds = ids;

    for (const x of replies) {
      rcountSum += Number(x.rcount ?? 0);
      comments.push({
        rpid: String(x.rpid),
        user: x.member?.uname ?? '',
        uid: String(x.mid ?? x.member?.mid ?? ''),
        like: Number(x.like ?? 0),
        ctime: Number(x.ctime ?? 0),
        isPinned: Boolean(x?.reply_control?.is_pinned ?? false),
        msg: normalizeEqualLength(String(x.content?.message ?? '')),
        rcount: Number(x.rcount ?? 0),
        jumpUrl: String(x.content?.jump_url ?? ''),
      });
    }
    pages++;
    onProgress(`已抓 ${comments.length} 条（第 ${pages} 页）`);

    const cursor = json.data?.cursor ?? {};
    const next = cursor.pagination_reply?.next_offset;
    if (cursor.is_end || !next || next === offset) break;
    offset = next;
    await sleepImpl(delayMs);
  }

  const elapsedMs = now() - startedAt;
  // 风控降级自检：实测带半套 cookie 时接口平静地只给 3 条且不报错
  const degraded = comments.length === 3 && allCount > 3;

  return {
    target: { bvid, aid, title, owner: owner?.name ?? '', pubdate: pubdate ?? 0, duration: duration ?? 0, view: stat?.view ?? 0 },
    comments,
    meta: {
      mainCount: comments.length,
      allCount: allCount || comments.length,
      rcountSum,
      elapsedMs,
      errorCount,
      truncated,
      degraded,
      pages,
    },
  };
}

/* =========================================================================
 * 5. Refiner —— 可选 AI 精排（只做精排，不做召回）
 * ========================================================================= */

const REFINER_MAX_CANDIDATES = 50;

function parseAiSpec(spec, apiKey = '') {
  const s = String(spec ?? '');
  if (s.startsWith('http://') || s.startsWith('https://')) {
    // 允许直接写 "<baseUrl>#<model>"
    const [base, model] = s.split('#');
    if (!base || !model) throw new HuashuError('直接写地址时要带模型名：<baseUrl>#<model>', 'usage');
    return { kind: 'openai', baseUrl: base.replace(/\/$/, ''), url: base.replace(/\/$/, '') + '/chat/completions', model, apiKey, label: `${model}` };
  }
  if (s.startsWith('ollama:')) {
    const model = s.slice('ollama:'.length);
    if (!model) throw new HuashuError('--ai ollama: 后面要跟模型名，例如 ollama:qwen2.5', 'usage');
    const baseUrl = 'http://127.0.0.1:11434/v1';
    return { kind: 'ollama', baseUrl, url: baseUrl + '/chat/completions', model, apiKey: '', label: `ollama:${model}` };
  }
  if (s.startsWith('openai:')) {
    const rest = s.slice('openai:'.length);
    const [base, model] = rest.split('#');
    if (!base || !model) throw new HuashuError('--ai openai: 格式应为 openai:<baseUrl>#<model>', 'usage');
    const baseUrl = base.replace(/\/$/, '');
    return { kind: 'openai', baseUrl, url: baseUrl + '/chat/completions', model, apiKey, label: `openai:${model}` };
  }
  throw new HuashuError(`不认识的 --ai 规格：${s}`, 'usage', '支持 openai:<baseUrl>#<model>、<baseUrl>#<model> 或 ollama:<model>');
}

/**
 * 把规则算出的候选交给模型「确认 / 否认」。
 * 任何失败（无网络、超时、返回解析不了）都不影响主流程，只标记 degraded。
 */
async function refineHits(result, specText, ruleSet, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const spec = parseAiSpec(specText);
  const candidates = [];
  for (const h of result.hits) {
    for (const t of h.types) {
      if (t.score >= result.threshold * 0.5) candidates.push({ rpid: h.rpid, type: t.id, msg: h.msg });
    }
  }
  const chosen = candidates.slice(0, REFINER_MAX_CANDIDATES);
  if (chosen.length === 0) return { spec, degraded: false, verdicts: [], note: '没有需要复核的候选' };

  const typeDefs = ruleSet.types.map((t) => `${t.id} ${t.name}：${t.note || ''}`).join('\n');
  const prompt = [
    '你在做「话术识别」的复核，只做确认或否认，不要新增类型。',
    '判定口径：只有说话人**本人正在做出该动作**才算；转述、引用、反驳、反问、反讽、玩梗一律不算。',
    '可选的类型定义：', typeDefs, '',
    '待复核评论（JSON 数组）：', JSON.stringify(chosen.map((c) => ({ rpid: c.rpid, type: c.type, msg: c.msg.slice(0, 300) })), null, 1), '',
    '只返回 JSON 数组，每项形如 {"rpid":"...","type":"T1","verdict":"confirm|deny","reason":"一句话"}。',
  ].join('\n');

  try {
    const body = { model: spec.model, messages: [{ role: 'user', content: prompt }], temperature: 0 };
    if (spec.kind === 'openai') body.response_format = { type: 'json_object' };
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetchImpl(spec.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) return { spec, degraded: true, verdicts: [], note: `模型接口 HTTP ${res.status}` };
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? '';
    const arr = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    const verdicts = Array.isArray(arr) ? arr : (arr.verdicts ?? []);
    return { spec, degraded: false, verdicts, note: `复核了 ${chosen.length} 个候选` };
  } catch (e) {
    // 静默降级 ≠ 悄悄降级：这里如实报告，让摘要里能看见
    return { spec, degraded: true, verdicts: [], note: `AI 精排失败，已保留规则原判：${e.message}` };
  }
}

/* =========================================================================
 * 5b. 模型引擎 —— 两级判定（粗筛家族 → 逐字证据 + 细分），完全不用规则
 * =========================================================================
 *
 * 设计依论文（见 lab/judge/PIPELINE.md）：
 *   ① 粒度越细越不可靠（ArPro 实测：二元 α 0.62，多标签 α 0.375）
 *      → 先问粗一级的「话术家族」，只在命中的评论上再问细分类型
 *   ② 片段识别（SI）与类型分类（TC）是两步（SemEval-2020 Task 11）
 *      → 要求模型**逐字抄出证据原话**，而不是只给标签
 *   ③ 专业标注员一致率也就 0.24~0.38（ArPro）
 *      → 多次投票 + 共识/争议分开，不自欺地只报共识
 *   ④ 引述/转述要独立成关（引语归属文献）
 *      → quote 落在引号内、或前面有转述线索 → 不算命中（机械校验，不花 token）
 */

const MODEL_BATCH_DEFAULT = 20;
const MODEL_PASSES_DEFAULT = 2;

/** 话术家族：粗一级的判定单位（比 9 个细分类型可靠得多） */
const MODEL_FAMILIES = [
  { name: '劝和', def: '劝双方别吵 / 各退一步 / 自称中立或路人 / 两边都好 / 赢了之后劝对方收手' },
  { name: '消解', def: '用梗或打趣把议题变轻（不如XX）/ 把争议说成多大点事、散了吧、一个形象而已' },
  { name: '扣帽', def: '直接给人或作品扣帽子：软色情/擦边/媚宅，或归因到性别对立，或用寄生虫藤壶这类污名标签' },
  { name: '元框架', def: '拿“信息茧房”这类概念解释对方为什么错，或用“饭圈那一套”把对方的诉求定性' },
];

/** 细分类型 → 家族（模型只给了 type 时用来回推家族） */
const FAMILY_OF_TYPE = { T1: '劝和', T2: '劝和', T8: '劝和', T3: '消解', T4: '消解', T5: '扣帽', T6: '扣帽', T7: '元框架', T9: '元框架' };
/** 转述线索：出现在命中点之前就说明「他在说别人怎么说」 */
const MODEL_FAMILY_NAMES = MODEL_FAMILIES.map((f) => f.name);
const REPORT_CUES = /(说|称|讲|提到|评论|骂|指责|污蔑|扣|打成|所谓|被|宣称|美其名曰|反问|引用|复述|转发)/;

const normalizeQuote = (s) => String(s ?? '').replace(/\s+/g, '').replace(/[“”"「」『』]/g, '');

/**
 * 机械校验一条模型给的 quote：
 *   · 必须在原文里逐字找得到（找不到 → 丢弃）
 *   · 落在成对引号里 → 疑似引述
 *   · 前面 10 字内有转述线索 → 疑似转述
 * 这三条完全可复算，是模型自由度之外的那道闸门。
 */
function verifyQuote(msg, rawQuote) {
  const q = String(rawQuote ?? '').trim().replace(/^[“"「『]+/, '').replace(/[”"」』]+$/, '').trim();
  if (!q) return { ok: false, reason: '空 quote' };
  const at = msg.indexOf(q);
  if (at < 0) {
    const flat = msg.replace(/\s+/g, '');
    if (flat.includes(q.replace(/\s+/g, ''))) return { ok: false, reason: '只在忽略空白后才能对上（模型动了原文）' };
    return { ok: false, reason: '原文里找不到（疑似编造或改写的）' };
  }
  const insideQ = insideQuote(msg, at);
  const before = msg.slice(Math.max(0, at - 10), at);
  const reported = REPORT_CUES.test(before);
  return { ok: true, span: [at, at + q.length], insideQuote: insideQ, reported, text: msg.slice(at, at + q.length) };
}

/** 第 1 关：只问「本人有没有在用某类话术」，要家族不要细分 */
function buildCoarsePrompt(ruleSet, batch) {
  const families = MODEL_FAMILIES.map((f) => `- ${f.name}：${f.def}`).join('\n');
  const rubric = ruleSet.modelRubric ?? '只有说话人本人正在做出该动作才算；转述、引用、反驳、反问、反讽、玩梗一律不算。';
  const system = [
    '你是一个评论标注员。你只标注语言现象，不做道德判断，也不判断谁对谁错。',
    rubric,
    '关键区分：说话人**本人**在这样做 / 还是他在转述、引用、反驳、嘲讽别人的话——只有前者算。',
    '可用的话术家族：', families,
    '只输出 JSON，不要解释文字。',
  ].join('\n');
  const user = [
    '对下面每条评论，判断说话人本人有没有使用上述某一类话术。',
    '输出格式：{"results":[{"id":"<原样返回的 id>","families":["劝和"]}]}',
    '每条评论都要出现在 results 里；不命中就给空数组。一条评论可以属于多个家族。',
    JSON.stringify(batch.map((c) => ({ id: c.rpid, msg: c.msg.slice(0, 500) }))),
  ].join('\n');
  return { system, user };
}

/**
 * 第 2 关：只对第 1 关命中的评论，要求【逐字证据】。
 * B+C 定稿：**命中以“那段逐字原话”为判据**（跨度级一致性 γ 0.546 > 多标签 α 0.375）；
 * family / type 都只是附注，且 type 允许留空。
 */
function buildSpanPrompt(ruleSet, batch, familyOf) {
  const fams = MODEL_FAMILIES.map((f) => `- ${f.name}：${f.def}`).join('\n');
  const types = ruleSet.types.map((t) => `- ${t.id} ${t.name}`).join('\n');
  const rubric = ruleSet.modelRubric ?? '只有说话人本人正在做出该动作才算；转述、引用、反驳、反问、反讽、玩梗一律不算。';
  const system = [
    '你是一个评论标注员，只标注语言现象。',
    rubric,
    '你的主要任务是【逐字抄出证据】，不是分类。',
    '可用家族：', fams,
    '可用于附注的细分类型（可留空）：', types,
    '只输出 JSON，不要解释文字。',
  ].join('\n');
  const user = [
    '对每条评论：把说话人本人使用话术的那段原话【逐字复制】出来。',
    '硬要求：quote 必须与原文完全一致（包括标点），不要改写、不要省略、不要加字；quote 要短、只包含真正起作用的那几个字词句。',
    '如果那段话其实是在转述/引用/反驳/反问/玩梗，就不要输出它；没有就给空数组。',
    'family 必须从「可能家族」里选；type 只当附注，拿不准就留空字符串。',
    '输出格式：{"results":[{"id":"...","spans":[{"quote":"逐字原话","family":"劝和","type":"T1","reason":"20字内"}]}]}',
    JSON.stringify(batch.map((c) => ({ id: c.rpid, msg: c.msg.slice(0, 500), 可能家族: familyOf.get(String(c.rpid)) ?? [] }))),
  ].join('\n');
  return { system, user };
}

/** 解析模型返回的 results 数组；失败返回 null */
function parseModelRows(text) {
  if (!text) return null;
  let s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const j = JSON.parse(s);
    const arr = Array.isArray(j) ? j : (j.results ?? j.data ?? null);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

/**
 * 模型引擎主入口：两级 × N 遍投票。
 * @returns { engine, hits, disputed, lowConfidence, stats, threshold }
 */
async function classifyWithModel(comments, ruleSet, options = {}) {
  const {
    kind = 'openai', baseUrl, apiKey = '', model,
    batchSize = MODEL_BATCH_DEFAULT, passes = MODEL_PASSES_DEFAULT,
    timeoutMs = 120000, fetchImpl = fetch, onProgress = () => {}, signal = null,
    temperature = 0.3,
  } = options;
  if (!model || !baseUrl) throw new HuashuError('模型模式需要提供 baseUrl 与 model', 'usage');

  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  const validTypes = new Set(ruleSet.types.map((t) => t.id));
  const stats = { requests: 0, failedCalls: 0, unjudged: 0, quotedOut: 0, notFound: 0, disputedCount: 0, judged: 0 };

  async function callModel(system, user, forceJson) {
    const body = { model, temperature, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (forceJson) {
      if (kind === 'ollama') body.format = 'json';
      else body.response_format = { type: 'json_object' };
    }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    if (signal && ctrl) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
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

  /** 跑一遍：返回 Map<rpid, Map<归一化 quote, {type, reason, raw}>> */
  async function onePass(passIdx, total) {
    const perComment = new Map();
    for (let i = 0; i < comments.length; i += batchSize) {
      if (signal?.aborted) throw new HuashuError('已取消', 'usage');
      const batch = comments.slice(i, i + batchSize);
      onProgress(Math.min(i + batch.length, total), total, `第 ${passIdx + 1}/${passes} 遍·粗筛`);

      // 第 1 关：粗筛（失败重试一次）
      let coarse = null, err = null;
      for (let t = 0; t < 2 && !coarse; t++) {
        try {
          const p = buildCoarsePrompt(ruleSet, batch);
          const rows = parseModelRows(await callModel(p.system, p.user, t === 0));
          if (rows) { coarse = new Map(rows.map((r) => [String(r.id), Array.isArray(r.families) ? r.families : []])); }
        } catch (e) { err = e; }
      }
      if (!coarse) {
        stats.failedCalls++;
        stats.unjudged += batch.length;
        onProgress(Math.min(i + batch.length, total), total, `本批粗筛失败，已跳过${err ? `（${err.message}）` : ''}`);
        continue;
      }
      const flagged = batch.filter((c) => (coarse.get(String(c.rpid)) ?? []).length > 0);
      if (!flagged.length) { onProgress(Math.min(i + batch.length, total), total, ''); continue; }

      // 第 2 关：只对命中的求「逐字证据 + 细分」
      const familyOf = new Map(flagged.map((c) => [String(c.rpid), coarse.get(String(c.rpid))]));
      let spanned = null, err2 = null;
      for (let t = 0; t < 2 && !spanned; t++) {
        try {
          const p = buildSpanPrompt(ruleSet, flagged, familyOf);
          const rows = parseModelRows(await callModel(p.system, p.user, t === 0));
          if (rows) spanned = new Map(rows.map((r) => [String(r.id), Array.isArray(r.spans) ? r.spans : []]));
        } catch (e) { err2 = e; }
      }
      if (!spanned) {
        stats.failedCalls++;
        stats.unjudged += flagged.length;
        onProgress(Math.min(i + batch.length, total), total, `本批定位失败，已跳过${err2 ? `（${err2.message}）` : ''}`);
        continue;
      }

      for (const c of flagged) {
        const spans = spanned.get(String(c.rpid)) ?? [];
        for (const sp of spans) {
          const v = verifyQuote(c.msg, sp?.quote);
          if (!v.ok) { stats.notFound++; continue; }
          if (v.insideQuote || v.reported) { stats.quotedOut++; continue; }   // 引述/转述 → 不算
          // C 定稿：命中判据 = 通过闸门的逐字证据；family/type 只作附注
          const fam = MODEL_FAMILIES.some((f) => f.name === sp?.family)
            ? String(sp.family)
            : (FAMILY_OF_TYPE[String(sp?.type)] ?? null);
          if (!fam) { stats.noFamily++; continue; }
          const type = validTypes.has(String(sp?.type)) ? String(sp.type) : '';
          const key = normalizeQuote(v.text);
          if (!perComment.has(String(c.rpid))) perComment.set(String(c.rpid), new Map());
          perComment.get(String(c.rpid)).set(key, { fam, type, reason: String(sp?.reason ?? ''), raw: v.text, span: v.span });
        }
      }
      onProgress(Math.min(i + batch.length, total), total, '');
    }
    return perComment;
  }

  // ---- 跑 N 遍 ----
  const runs = [];
  for (let p = 0; p < Math.max(1, passes); p++) runs.push(await onePass(p, comments.length));

  // ---- 投票合并 ----
  const N = runs.length;
  const minVotes = N;
  const votes = new Map();   // rpid -> Map<quoteKey, {count, fam, type, reason, raw, span, famVotes}>
  let agreeFull = 0, flaggedAny = 0;
  for (const c of comments) {
    const k = String(c.rpid);
    const sets = runs.map((r) => r.get(k) ?? new Map());
    const anyHit = sets.some((s) => s.size > 0);
    if (anyHit) flaggedAny++;
    if (sets.every((s) => s.size === (sets[0]?.size ?? 0))) agreeFull++;
    for (const s of sets) {
      for (const [qk, v] of s) {
        if (!votes.has(k)) votes.set(k, new Map());
        const m = votes.get(k);
        if (!m.has(qk)) m.set(qk, { count: 0, fam: v.fam, type: v.type, reason: v.reason, raw: v.raw, span: v.span, famVotes: {} });
        const rec = m.get(qk);
        rec.count++;
        rec.famVotes[v.fam] = (rec.famVotes[v.fam] ?? 0) + 1;
      }
    }
  }

  const hits = [];
  const disputed = [];
  const familyCounts = {};
  for (const c of comments) {
    const m = votes.get(String(c.rpid));
    if (!m) continue;
    const passed = [];
    for (const [qk, v] of m) {
      if (v.count >= minVotes) passed.push(v);
      else disputed.push({ rpid: String(c.rpid), msg: c.msg, quote: v.raw, family: v.fam, type: v.type, votes: v.count, of: N, reason: v.reason });
    }
    if (!passed.length) continue;
    // 家族：按票数取最多（家族不一致不影响命中——命中由证据跨度决定）
    const famVotes = {};
    for (const v of passed) for (const [f, n] of Object.entries(v.famVotes)) famVotes[f] = (famVotes[f] ?? 0) + n;
    const famSorted = Object.entries(famVotes).sort((a, b) => b[1] - a[1]);
    for (const [f] of famSorted) familyCounts[f] = (familyCounts[f] ?? 0) + 1;
    const spans = passed.map((v) => ({ quote: v.raw, span: v.span, family: v.fam, type: v.type || '', reason: v.reason, votes: v.count, of: N }));
    const families = famSorted.map(([name, n]) => ({
      name, score: n / passed.length,
      evidence: passed.filter((v) => v.fam === name).map((v) => ({ src: `model:${v.reason || '无理由'}`, span: v.span, text: v.raw })),
    }));
    // 细分类型仅作参考（可能为空）
    const typeVotes = {};
    for (const v of passed) if (v.type) typeVotes[v.type] = (typeVotes[v.type] ?? 0) + 1;
    const types = Object.entries(typeVotes).sort((a, b) => b[1] - a[1]).map(([id, n]) => ({
      id, name: ruleSet.types.find((t) => t.id === id)?.name ?? '', score: n / passed.length, ref: true,
      evidence: passed.filter((v) => v.type === id).map((v) => ({ src: `model:${v.reason || '无理由'}`, span: v.span, text: v.raw })),
    }));
    hits.push({
      rpid: String(c.rpid), user: c.user ?? '', uid: c.uid ?? '', like: c.like ?? 0,
      ctime: c.ctime ?? 0, jumpUrl: c.jumpUrl ?? '', msg: c.msg,
      spans, families, types, maxScore: 1,
    });
  }
  stats.familyCounts = familyCounts;
  stats.disputedCount = disputed.length;
  stats.judged = comments.length - stats.unjudged;

  return {
    engine: 'model',
    hits,
    disputed,
    lowConfidence: [],
    stats: {
      ...stats,
      passes: N,
      minVotes,
      selfAgreement: comments.length ? agreeFull / comments.length : 0,
      flaggedAny,
    },
    threshold: null,
  };
}

/* =========================================================================
 * 6. Reporter —— 终端摘要 + CSV
 * ========================================================================= */

function anonName(user, uid) {
  const h = crypto.createHash('sha1').update(String(uid || user || '')).digest('hex').slice(0, 6);
  return `用户#${h}`;
}

function disclaimerFor(engine) {
  return engine === 'model'
    ? '本结果由语言模型判定得出，模型可能出错，请结合原文人工复核。'
    : DISCLAIMER;
}

function renderSummary(model, opts = {}) {
  const { color = true, maxExamples = 8 } = opts;
  const c = (code, s) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const lines = [];
  const { target, meta, result, rules } = model;

  lines.push(c('1', `话术照妖镜 v${VERSION} · ${target.bvid}`));
  lines.push(`《${target.title}》`);
  lines.push('─'.repeat(60));
  lines.push(`抓取  主评论 ${meta.mainCount} 条｜总评论 ${meta.allCount} 条（含楼中楼 ${meta.rcountSum}）｜${(meta.elapsedMs / 1000).toFixed(1)}s｜${meta.errorCount} 错误`);
  if (meta.truncated) lines.push(c('33', `      ⚠ 达到 --max-comments 上限，结果不完整`));
  if (meta.degraded) lines.push(c('31', `      ⚠ 只拿到 3 条且总评论数更多 → 疑似风控降级，本次结果不可用`));
  lines.push(`识别  命中 ${result.hits.length} 条 (${(result.hits.length / Math.max(1, meta.mainCount) * 100).toFixed(1)}%)｜${model.engineLabel ?? `规则 ${rules.names.join('+')}｜阈值 ${result.threshold}`}`);
  lines.push('─'.repeat(60));

  if (result.engine === 'model') {
    // B+C：命中以「逐字证据」为准；家族次之；细分类型仅供参考
    const byFam = new Map();
    for (const h of result.hits) for (const f of (h.families ?? [])) byFam.set(f.name, (byFam.get(f.name) ?? 0) + 1);
    const famNames = ['劝和', '消解', '扣帽', '元框架'];
    for (const name of famNames) {
      const n = byFam.get(name) ?? 0;
      lines.push(`${name.padEnd(4)} ${' '.repeat(10)} ${String(n).padStart(4)} 条  ${'█'.repeat(Math.min(20, n))}`);
    }
    lines.push(c('2', `（命中判据是「逐字证据」；家族为粗分类，细分类型仅供参考）`));
  } else {
    const byType = new Map();
    for (const h of result.hits) for (const t of h.types) byType.set(t.id, (byType.get(t.id) ?? 0) + 1);
    if (byType.size === 0) lines.push('（这一次没有命中任何类型——「没有话术」也是合法结果）');
    for (const t of rules.types) {
      const n = byType.get(t.id) ?? 0;
      const bar = '█'.repeat(Math.min(20, n));
      lines.push(`${t.id.padEnd(4)} ${t.name.padEnd(12)} ${String(n).padStart(4)} 条  ${bar}`);
    }
  }
  lines.push('─'.repeat(60));

  const top = result.hits.slice().sort((a, b) => b.maxScore - a.maxScore).slice(0, maxExamples);
  if (top.length) {
    lines.push('命中样例（完整证据见 CSV）：');
    for (const h of top) {
      const tag = result.engine === 'model'
        ? `[${(h.families ?? []).map((f) => f.name).join('/') || '家族未定'}] 证据「${(h.spans ?? [])[0]?.quote ?? ''}」`
        : `[${h.types.map((t) => t.id).join('/')}]`;
      lines.push(`  ${tag} 赞${h.like} ${h.msg.replace(/\s+/g, ' ').slice(0, 40)}`);
    }
    lines.push('─'.repeat(60));
  }
  if (model.refine) {
    lines.push(model.refine.degraded ? c('33', `AI 精排：${model.refine.note}`) : `AI 精排：${model.refine.note}`);
  }
  lines.push(c('33', `⚠ ${disclaimerFor(result.engine)}`));
  return lines.join('\n');
}

function renderCsv(model, opts = {}) {
  const { anon = false, lowConfidence = null } = opts;
  const out = [];
  // 免责声明也进 CSV（合规要求）：第一行以 # 开头，Excel 会当普通行显示
  out.push('# ' + disclaimerFor(model.result?.engine));
  if (anon) out.push('# --anon 已开启：用户名被替换为不可逆短哈希。');
  const isModel = model.result?.engine === 'model';
  out.push('rpid,user,like,ctime,time,msg,evidence_quote,families,ref_types,evidence,guarded,guard_note,jump_url');
  for (const h of model.result.hits) {
    const evidence = h.types.map((t) => `${t.id}:${t.evidence.map((e) => (e.span ? `${e.src}@${e.span[0]}-${e.span[1]}` : e.src)).join('|')}`).join(';');
    const guarded = h.types.some((t) => t.evidence.some((e) => e.src.startsWith('lexicon:'))) ? 'partial' : 'no';
    const row = [
      h.rpid,
      anon ? anonName(h.user, h.uid) : h.user,
      h.like,
      h.ctime,
      h.ctime ? new Date(h.ctime * 1000).toISOString().slice(0, 19).replace('T', ' ') : '',
      h.msg,
      (h.spans ?? []).map((s) => s.quote).join(' | '),
      (h.families ?? []).map((f) => `${f.name}:${f.score.toFixed(2)}`).join(';'),
      h.types.map((t) => `${t.id}:${t.score}`).join(';'),
      evidence,
      guarded,
      '',
      h.jumpUrl,
    ];
    out.push(row.map(csvCell).join(','));
  }
  if (lowConfidence && lowConfidence.length) {
    out.push('# 以下为低置信候选：被闸门压掉或分数不足，不计入上面的命中统计，仅供人工复核。');
    out.push('rpid,type,score,reason,msg');
    for (const l of lowConfidence) out.push([l.rpid, l.type, l.score ?? '', l.reason, l.msg].map(csvCell).join(','));
  }
  return out.join('\n') + '\n';
}

/* =========================================================================
 * 7. 自检夹具（原型回归）与内置示例语料
 * ========================================================================= */

/** 24 条原型夹具：正例来自七套数据集的真命中，反例是踩过的坑 */
const SELFTEST_FIXTURES = [
  { msg: '都别争了', expect: ['T1'], why: '最朴素的劝停' },
  { msg: '我觉得双方没必要吵 哦对了，什么时候统一度量衡？[汤圆]', expect: [], why: '反讽（统一度量衡是梗）' },
  { msg: '莫名其妙的节奏，圈地自萌不就好了吗，就一个投票搞出这么大节奏', expect: ['T1'], why: '真劝和' },
  { msg: '都别吵了，明明是男D更早，好早之前我在埃及就看到D老师举着压路机', expect: [], why: '劝停后紧跟玩梗断言' },
  { msg: '路人 不太明白为啥这种事都能吵起来 问问为啥大家都在说这个事', expect: ['T2'], why: '自称路人的中立姿态' },
  { msg: '左边跟路人一样一点辨识度没有，搞不懂跟ds有什么关系', expect: [], why: '「路人」是比喻不是自称' },
  { msg: '我一开始是中立的路人，我只是稍微有些正义感，非要赶尽杀绝吗？要知道适可而止', expect: ['T2', 'T8'], why: '自立中立 + 劝停（已知边界项）' },
  { msg: '感觉不如奶鲸......颜值。', expect: ['T3'], why: '梗式消解' },
  { msg: '现在我见的最多的四凤评论就是各打一大板的，说不如第三个奶鲸形象的', expect: [], why: '转述别人的话' },
  { msg: '其实对面骂的什么 rsq 媚男之类的全是她们自己的映射，那乙游男形象才是 rsq 甲基八媚女形象吧', expect: ['T5'], why: '反向扣帽也是扣帽' },
  { msg: '说这个形象是软色情的，这衣服都厚成啥了，色在哪', expect: [], why: '反驳式转述' },
  { msg: '总不能长得好看就是软色情吧', expect: [], why: '指控式反问' },
  { msg: '这不就只是单纯的信息茧房吗？真没必要啥都搞男女对立吧。', expect: ['T1', 'T7'], why: '自用茧房论点 + 劝和' },
  { msg: '注意，注意来袭，信息茧房来了，当然，谁是真的信息茧房，我不好说[汤圆]', expect: [], why: '元评论 + 反讽' },
  { msg: '所谓信息茧房也是绘圈小团体炒作出来的，信息茅房还差不多', expect: [], why: '「所谓」= 转述' },
  { msg: '都是二创形象只看传播度，早有鸡扒用。', expect: [], why: '无该动作' },
  { msg: '同人女搞得盗版牢理都不如奶龙鲸鱼[笑哭]', expect: ['T3'], why: '奶龙消解' },
  { msg: '反对者反对最可笑的是她们反对的理由本来就是在侮辱女性', expect: [], why: '转述/反击' },
  { msg: '好多年前日本有个画巨乳的就被日本网游阴阳怪气说媚男故意画巨乳丑化物化女性', expect: [], why: '拿历史案例举例' },
  { msg: '警惕盾兵出来清理战场，盾兵常见话术为: 1. 和稀泥型：都别吵了…', expect: [], why: '照抄话术清单 → 整条不评' },
  { msg: '顺风：子午皇统一度量衡 交战：这波是信息茧房了 逆风：不能两个都喜欢吗', expect: [], why: '三段式引用' },
  { msg: '去xhs逛了逛，有一说一这两完全没必要打架[汤圆]', expect: ['T1'], why: '真劝和' },
  { msg: '挺好看的啊，这两个都挺好的，都保留不行吗', expect: ['T2'], why: '中立姿态（只有 T2，没有劝停）' },
  { msg: '那个要是好看 不至于连3d模都没有吧', expect: [], why: '「不至于」与消解议题无关' },
];

/** 内置示例语料：不联网也能把流程跑通（--demo） */
const DEMO_COMMENTS = [
  { rpid: 'd01', user: '示例用户A', like: 263, msg: '都别争了', jumpUrl: '' },
  { rpid: 'd02', user: '示例用户B', like: 61, msg: '莫名其妙的节奏，圈地自萌不就好了吗，就一个投票搞出这么大节奏' },
  { rpid: 'd03', user: '示例用户C', like: 33, msg: '那我就是纯路人啊，国内版新开的对话窗口，让deep seek可自己选的呀' },
  { rpid: 'd04', user: '示例用户D', like: 21, msg: '感觉不如奶鲸......颜值。' },
  { rpid: 'd05', user: '示例用户E', like: 6, msg: '男d形象用来情感解闷还有聊天啥的，所以就是乙游男主的rsq形象来满足性幻想和情绪价值' },
  { rpid: 'd06', user: '示例用户F', like: 9, msg: '这不就只是单纯的信息茧房吗？真没必要啥都搞男女对立吧。' },
  { rpid: 'd07', user: '示例用户G', like: 71, msg: '肥鱼这立绘都快裹成粽子了还软色情呢？总不能长得好看就是软色情吧' },
  { rpid: 'd08', user: '示例用户H', like: 44, msg: '都别吵了，明明是男D更早，好早之前我在埃及就看到D老师举着压路机' },
  { rpid: 'd09', user: '示例用户I', like: 119, msg: '警惕盾兵出来清理战场，盾兵常见话术为: 1. 和稀泥型：都别吵了，两边都有问题。' },
  { rpid: 'd10', user: '示例用户J', like: 7, msg: '去xhs逛了逛，有一说一这两完全没必要打架[汤圆]' },
  { rpid: 'd11', user: '示例用户K', like: 0, msg: '完全不要去在乎，不玩饭圈那一套，让你赢就是了' },
  { rpid: 'd12', user: '示例用户L', like: 13, msg: '看到寄生虫就必须赶尽杀绝，最讨厌寄生虫了[doge]' },
];

/* =========================================================================
 * 8. CLI
 * ========================================================================= */

const HELP = `
话术照妖镜 spinlens v${VERSION}
把一个 B 站视频的评论区过一遍，看看有多少条评论在使用「话术」，并给出可核对的原文证据。

用法：
  node huashu.js <视频链接|BV号|av号|分享文本> [选项]
  node huashu.js --demo                用内置示例语料跑一遍（不联网）
  node huashu.js --from-json <文件>    用本地评论 JSON 跑（不联网）
  node huashu.js --selftest            跑规则自检（24 条原型夹具）
  node huashu.js --help | --version

选项：
  --out <路径|->      CSV 输出位置；'-' 表示写到屏幕。默认 huashu-<BV号>-<时间>.csv
  --rules <路径>      用自己的规则文件（替代内置规则包）
  --pack <列表>       规则包：event-deepseek(默认) | t10(实验) | all，逗号分隔
  --types T1,T2      只跑指定类型
  --min-score <n>     命中阈值，默认取规则文件里的值
  --max-comments <n>  最多抓多少条主评论，默认 ${DEFAULT_MAX_COMMENTS}
  --delay <ms>        每页之间的间隔，默认 ${DEFAULT_DELAY_MS}（请勿调太小）
  --cookie <串>       显式携带 cookie（默认不带——实测带半套 cookie 反而被风控砍到 3 条）
  --anon              匿名化输出：用户名替换为不可逆短哈希（合规推荐）
  --allow-partial     疑似风控降级时也出报告（默认拒绝并退出码 2）
  --low-confidence    额外把「被闸门压掉的候选」写进 CSV 尾部，供人工复核
  --engine <rules|model>  判定引擎。rules（默认）用本地规则；model 完全不用规则，
                     把每条评论都交给语言模型判（更慢、可能花钱，但上限更高）
  --ai <规格>        rules 模式＝可选 AI 精排复核；model 模式＝必填。写法：
                     openai:<baseUrl>#<model> ；ollama:<model> ；或 <baseUrl>#<model>
  --ai-key <key>    模型接口的 API key（也可用环境变量 OPENAI_API_KEY）
  --batch <n>       model 模式每批多少条评论（默认 20，越大越省请求）
  --passes <n>      model 模式跑几遍取共识（默认 2；越大越准、也越贵）
  --json              摘要以 JSON 输出
  --quiet             只输出 CSV，不打摘要
  --no-color          关闭彩色

退出码： 0 成功 | 1 用法错误 | 2 网络/接口失败 | 3 规则文件无效
（注意：没有命中任何话术属于「成功」，退出码仍是 0）

红线：本工具只输出「哪条评论命中了哪条规则」，不回答「谁在使坏」；
      请勿用它生成针对具体个人的挂人名单。
`.trim();

function parseArgs(argv) {
  const opts = {
    input: null, out: null, rules: null, pack: 'event-deepseek', types: null, minScore: null,
    maxComments: DEFAULT_MAX_COMMENTS, delay: DEFAULT_DELAY_MS, cookie: '', anon: false,
    allowPartial: false, lowConfidence: false, ai: null, aiKey: '', batch: 20, passes: 2, engine: 'rules', json: false, quiet: false,
    color: process.stdout.isTTY !== false, fromJson: null, demo: false, selftest: false,
    help: false, version: false,
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) throw new HuashuError(`${name} 后面缺参数`, 'usage');
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--out': opts.out = need(i, '--out'); i++; break;
      case '--rules': opts.rules = need(i, '--rules'); i++; break;
      case '--pack': opts.pack = need(i, '--pack'); i++; break;
      case '--types': opts.types = need(i, '--types').split(',').map((s) => s.trim()).filter(Boolean); i++; break;
      case '--min-score': opts.minScore = Number(need(i, '--min-score')); i++; break;
      case '--max-comments': opts.maxComments = Number(need(i, '--max-comments')); i++; break;
      case '--delay': opts.delay = Number(need(i, '--delay')); i++; break;
      case '--cookie': opts.cookie = need(i, '--cookie'); i++; break;
      case '--ai': opts.ai = need(i, '--ai'); i++; break;
      case '--ai-key': opts.aiKey = need(i, '--ai-key'); i++; break;
      case '--batch': opts.batch = Number(need(i, '--batch')); i++; break;
      case '--passes': opts.passes = Number(need(i, '--passes')); i++; break;
      case '--engine': opts.engine = need(i, '--engine'); i++; break;
      case '--from-json': opts.fromJson = need(i, '--from-json'); i++; break;
      case '--anon': opts.anon = true; break;
      case '--allow-partial': opts.allowPartial = true; break;
      case '--low-confidence': opts.lowConfidence = true; break;
      case '--json': opts.json = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--no-color': opts.color = false; break;
      case '--demo': opts.demo = true; break;
      case '--selftest': opts.selftest = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--version': case '-v': opts.version = true; break;
      default:
        if (a.startsWith('-')) throw new HuashuError(`不认识的选项：${a}`, 'usage');
        if (opts.input) throw new HuashuError('只能处理一个视频地址', 'usage');
        opts.input = a;
    }
  }
  if (opts.minScore !== null && (!Number.isFinite(opts.minScore) || opts.minScore <= 0 || opts.minScore > 1)) {
    throw new HuashuError('--min-score 应该在 0~1 之间', 'usage');
  }
  if (!Number.isFinite(opts.maxComments) || opts.maxComments <= 0) throw new HuashuError('--max-comments 必须是正整数', 'usage');
  if (!['rules', 'model'].includes(opts.engine)) throw new HuashuError(`--engine 只支持 rules 或 model（收到 ${opts.engine}）`, 'usage');
  if (!Number.isFinite(opts.batch) || opts.batch < 1) throw new HuashuError('--batch 必须是正整数', 'usage');
  return opts;
}

/** 定位规则包目录：优先脚本同级的 rules/，再往上一级找 */
function resolveRulesDir() {
  const here = __dirname;
  const candidates = [path.join(here, 'rules'), path.join(here, '..', 'rules')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

function loadRulePacks(opts) {
  const warnings = [];
  if (opts.rules) {
    let raw;
    try {
      raw = readJson(opts.rules);
    } catch (e) {
      throw new HuashuError(`规则文件读不了：${opts.rules}`, 'rules', e.message);
    }
    const { compiled, warnings: w } = compileRuleSet(raw);
    return { ruleSet: compiled, warnings: [...warnings, ...w] };
  }
  const dir = resolveRulesDir();
  const wanted = String(opts.pack).split(',').map((s) => s.trim()).filter(Boolean);
  const files = [];
  for (const w of wanted) {
    if (w === 'all') { files.push('event-deepseek.json', 'event-deepseek-t10.json'); continue; }
    if (w === 'event-deepseek') { files.push('event-deepseek.json'); continue; }
    if (w === 't10') { files.push('event-deepseek-t10.json'); continue; }
    throw new HuashuError(`不认识的规则包：${w}`, 'usage', '可选：event-deepseek | t10 | all');
  }
  const packs = [];
  for (const f of files) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) throw new HuashuError(`规则包不存在：${p}`, 'rules');
    try { packs.push(readJson(p)); } catch (e) { throw new HuashuError(`规则包读不了：${p}`, 'rules', e.message); }
    if (f.includes('t10')) warnings.push('T10「污名化标签」是实验包，尚未经过完整评测。');
  }
  const merged = mergeRuleSets(packs);
  const { compiled, warnings: w } = compileRuleSet(merged);
  return { ruleSet: compiled, warnings: [...warnings, ...w] };
}

function loadCommentsFromJson(p) {
  const j = readJson(p);
  const arr = Array.isArray(j) ? j : (j.comments ?? null);
  if (!Array.isArray(arr)) throw new HuashuError(`${p} 里没有 comments 数组`, 'usage');
  return arr.map((c, i) => ({
    rpid: String(c.rpid ?? `row-${i + 1}`),
    user: c.user ?? '',
    uid: String(c.uid ?? ''),
    like: Number(c.like ?? 0),
    ctime: Number(c.ctime ?? 0),
    msg: normalizeEqualLength(String(c.msg ?? c.message ?? '')),
    jumpUrl: c.jumpUrl ?? c.jump_url ?? '',
  }));
}

function runSelftest(ruleSet) {
  const comments = SELFTEST_FIXTURES.map((f, i) => ({ rpid: `st-${i + 1}`, user: '', like: 0, msg: normalizeEqualLength(f.msg) }));
  const { hits } = detect(comments, ruleSet, {});
  const got = new Map(hits.map((h) => [h.rpid, h.types.map((t) => t.id).sort()]));
  let pass = 0;
  const fails = [];
  SELFTEST_FIXTURES.forEach((f, i) => {
    const g = (got.get(`st-${i + 1}`) ?? []).slice().sort();
    const e = f.expect.slice().sort();
    if (g.join(',') === e.join(',')) pass++;
    else fails.push({ msg: f.msg.slice(0, 42), expect: e.join('/') || '(无)', got: g.join('/') || '(无)', why: f.why });
  });
  console.log(`规则自检：${pass}/${SELFTEST_FIXTURES.length} 通过`);
  if (fails.length) {
    console.log('\n未通过的用例（这些正是历史踩过的坑）：');
    for (const f of fails) console.log(`  ✗ ${f.msg}\n      期望 ${f.expect}，实际 ${f.got}   [${f.why}]`);
  }
  return fails.length === 0 ? EXIT.OK : EXIT.RULES;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP); return EXIT.OK; }
  if (opts.version) { console.log(`spinlens ${VERSION}`); return EXIT.OK; }

  const { ruleSet, warnings } = loadRulePacks(opts);
  for (const w of warnings) console.error(`⚠ ${w}`);
  const threshold = opts.minScore ?? ruleSet.threshold;

  if (opts.selftest) return runSelftest(ruleSet);

  // ---- 取数据（三条路：联网抓 / 本地 JSON / 内置示例）----
  let payload;
  if (opts.demo) {
    console.error('使用内置示例语料（--demo）');
    payload = {
      target: { bvid: 'DEMO', aid: 0, title: '内置示例语料（12 条，覆盖 9 类与常见误报陷阱）', owner: '', pubdate: 0, duration: 0, view: 0 },
      comments: DEMO_COMMENTS.map((c) => ({ ...c, msg: normalizeEqualLength(c.msg), uid: '', ctime: 0, rcount: 0 })),
      meta: { mainCount: DEMO_COMMENTS.length, allCount: DEMO_COMMENTS.length, rcountSum: 0, elapsedMs: 0, errorCount: 0, truncated: false, degraded: false, pages: 0 },
    };
  } else if (opts.fromJson) {
    const comments = loadCommentsFromJson(opts.fromJson);
    console.error(`从本地文件读取 ${comments.length} 条评论（不联网）`);
    payload = {
      target: { bvid: path.basename(opts.fromJson).replace(/\.[^.]+$/, ''), aid: 0, title: `本地语料：${opts.fromJson}`, owner: '', pubdate: 0, duration: 0, view: 0 },
      comments,
      meta: { mainCount: comments.length, allCount: comments.length, rcountSum: 0, elapsedMs: 0, errorCount: 0, truncated: false, degraded: false, pages: 0 },
    };
  } else {
    if (!opts.input) { console.error(HELP); throw new HuashuError('没有给视频地址（也可以用 --demo / --from-json / --selftest）', 'usage'); }
    payload = await fetchComments(opts.input, {
      cookie: opts.cookie, delayMs: opts.delay, maxComments: opts.maxComments,
      onProgress: (m) => { if (!opts.quiet) console.error('· ' + m); },
    });
    if (payload.meta.degraded && !opts.allowPartial) {
      throw new HuashuError('疑似风控降级：只拿到 3 条主评论，但视频总评论数更多', 'network',
        '默认拒绝出报告（避免「平静地打出一份错报告」）。确要继续请加 --allow-partial。');
    }
  }

  // ---- 判定：规则引擎 / 模型引擎 ----
  let result;
  let refine = null;
  let engineLabel;
  if (opts.engine === 'model') {
    if (!opts.ai) throw new HuashuError('模型模式需要同时指定模型：--ai ollama:qwen2.5 或 --ai openai:<baseUrl>#<model>', 'usage');
    const spec = parseAiSpec(opts.ai, opts.aiKey || process.env.OPENAI_API_KEY || '');
    const total = payload.comments.length;
    const progress = (done, all, msg) => {
      if (opts.quiet) return;
      process.stderr.write(`\r· 模型判定 ${done}/${all}${msg ? ` — ${msg}` : ''}          `);
    };
    if (!opts.quiet) {
      const batches = Math.ceil(total / opts.batch);
      process.stderr.write(`· 模型模式（两级判定）：把 ${total} 条评论交给 ${spec.label}\n`);
      process.stderr.write(`  第①关粗筛 ${batches} 批 + 第②关定位（只对命中的）→ 至少 ${batches * Math.max(1, opts.passes)} 次请求，×${Math.max(1, opts.passes)} 遍\n`);
    }
    result = await classifyWithModel(payload.comments, ruleSet, {
      kind: spec.kind, baseUrl: spec.baseUrl, apiKey: spec.apiKey, model: spec.model,
      batchSize: Math.max(1, opts.batch), passes: Math.max(1, opts.passes), onProgress: progress,
    });
    if (!opts.quiet) process.stderr.write('\n');
    engineLabel = `模型 ${spec.label}${result.stats.unjudged ? `｜未判定 ${result.stats.unjudged} 条` : ''}`;
  } else {
    result = detect(payload.comments, ruleSet, { types: opts.types, threshold });
    engineLabel = `规则 ${ruleSet.names.join('+')}｜阈值 ${threshold}`;
    // ---- 可选 AI 精排（规则先筛、模型复核）----
    if (opts.ai) {
      refine = await refineHits(result, opts.ai, ruleSet);
      if (!refine.degraded && refine.verdicts.length) {
        const deny = new Set(refine.verdicts.filter((v) => /deny|否认|假/i.test(v.verdict ?? '')).map((v) => `${v.rpid}|${v.type}`));
        result.hits = result.hits
          .map((h) => ({ ...h, types: h.types.filter((t) => !deny.has(`${h.rpid}|${t.id}`)) }))
          .filter((h) => h.types.length > 0);
      }
    }
  }

  const model = { target: payload.target, meta: payload.meta, result, rules: ruleSet, refine, opts, engineLabel };

  // ---- 输出 ----
  const csv = renderCsv(model, { anon: opts.anon, lowConfidence: opts.lowConfidence ? result.lowConfidence : null });
  let outPath = opts.out;
  if (outPath === '-') {
    process.stdout.write(csv);
  } else {
    if (!outPath) {
      const base = `${payload.target.bvid || 'comments'}`;
      outPath = path.join(process.cwd(), `huashu-${base}-${timestampTag()}.csv`);
    }
    // 显式写 UTF-8 with BOM（Windows 上不加 BOM，Excel 打开就是乱码）
    fs.writeFileSync(outPath, '\uFEFF' + csv, 'utf8');
    if (!opts.quiet) console.error(`CSV: ${outPath}`);
  }

  if (!opts.quiet) {
    if (opts.json) {
      console.log(JSON.stringify({
        version: VERSION,
        target: payload.target,
        meta: payload.meta,
        rules: ruleSet.names,
        threshold: result.threshold,
        hitCount: result.hits.length,
        hits: result.hits,
        lowConfidenceCount: result.lowConfidence.length,
        refine: refine ? { spec: refine.spec.label, degraded: refine.degraded, note: refine.note } : null,
        disclaimer: DISCLAIMER,
      }, null, 2));
    } else {
      console.log(renderSummary(model, { color: opts.color }));
    }
  }
  return EXIT.OK;
}

/* =========================================================================
 * 9. 入口
 * ========================================================================= */

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      if (e instanceof HuashuError) {
        console.error(`\n✗ ${e.message}`);
        if (e.detail) console.error(`  ${e.detail}`);
        process.exitCode = EXIT_OF_KIND[e.kind] ?? EXIT.USAGE;
      } else {
        console.error(`\n✗ 未预期的错误：${e && e.stack ? e.stack : e}`);
        process.exitCode = EXIT.USAGE;
      }
    });
}

module.exports = {
  VERSION, DISCLAIMER, EXIT, HuashuError,
  normalizeEqualLength, blankTags, insideQuote, looksRhetorical, csvCell,
  compileRuleSet, mergeRuleSets, detect,
  parseTarget, fetchComments, createHttp,
  parseAiSpec, refineHits, classifyWithModel, buildCoarsePrompt, buildSpanPrompt, parseModelRows, verifyQuote, MODEL_FAMILIES,
  renderSummary, renderCsv, anonName,
  SELFTEST_FIXTURES, DEMO_COMMENTS,
  loadRulePacks, loadCommentsFromJson, resolveRulesDir,
  parseArgs, main,
};
