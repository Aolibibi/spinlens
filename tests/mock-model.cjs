/**
 * 假模型 v2：模拟两级流水线（粗筛家族 / 逐字证据定位），只为验证管道与机械闸门，不联网不花钱。
 * 用法： node tests/mock-model.cjs [port]
 *
 * 识别规则（看提示词里要的是 families 还是 spans）：
 *   · 粗筛阶段：msg 命中触发词 → 给出对应家族
 *   · 定位阶段：把 msg 里的触发片段当 quote 返回
 *   · 特例（用于验证机械闸门）：
 *       msg 含「测试编造」→ 返回一句原文里不存在的话
 *       msg 含「测试引号」→ 返回引号内的片段
 *       msg 含「测试转述」→ 返回「说」后面的片段
 */
'use strict';
const http = require('node:http');

const PORT = Number(process.argv[2] ?? 8899);

const FAMILY_RULES = [
  { fam: '劝和', re: /(都别|别吵|没必要|路人|中立|各退一步|圈地自萌|两边都|两个都)/ },
  { fam: '消解', re: /(不如|多大点事|散了吧|而已)/ },
  { fam: '扣帽', re: /(软色情|rsq|擦边|媚宅|小仙女|打拳|藤壶|寄生虫)/i },
  { fam: '元框架', re: /(信息茧房|饭圈)/ },
];
const TYPE_OF = { 劝和: 'T1', 消解: 'T3', 扣帽: 'T5', 元框架: 'T7' };

function firstTrigger(msg) {
  const m = /(都别吵了|都别争了|没必要争|纯路人|各退一步|圈地自萌|不如奶鲸|多大点事|软色情|rsq|信息茧房|饭圈那一套)/i.exec(msg);
  return m ? m[0] : null;
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let results = [];
    try {
      const parsed = JSON.parse(body);
      const user = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
      const wantFamilies = /"families"/.test(user) || /families/.test(user);
      const isSpan = /"spans"/.test(user) || /逐字复制/.test(user);
      // 提示词最后一行是 JSON 数组
      const lastLine = user.trim().split('\n').pop();
      const items = JSON.parse(lastLine);

      if (!isSpan) {
        // 粗筛
        results = items.map(({ id, msg }) => {
          const fams = FAMILY_RULES.filter((r) => r.re.test(msg)).map((r) => r.fam);
          return { id, families: fams };
        });
      } else {
        // 定位
        results = items.map(({ id, msg }) => {
          let quote = null, type = 'T1';
          if (msg.includes('测试编造')) { quote = '这句话原文里根本没有出现过'; }
          else if (msg.includes('测试引号')) {
            const m = /[“「]([^”」]+)[”」]/.exec(msg);
            quote = m ? m[1] : null;
          } else if (msg.includes('测试转述')) {
            const m = /说([^，。！？]{2,12})/.exec(msg);
            quote = m ? m[1] : null;
          } else {
            quote = firstTrigger(msg);
            const fam = FAMILY_RULES.find((r) => r.re.test(quote ?? ''))?.fam;
            type = TYPE_OF[fam] ?? 'T1';
          }
          return { id, spans: quote ? [{ quote, type, reason: '假模型' }] : [] };
        });
      }
    } catch { /* 忽略 */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`假模型 v2 已启动： http://127.0.0.1:${PORT}/v1`));
