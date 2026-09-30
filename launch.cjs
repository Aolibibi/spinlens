#!/usr/bin/env node
/**
 * 一键启动器（由 启动.cmd 调用）
 * ---------------------------------------------------------------------------
 * 为什么需要它：老板要的是「蓝色大肥鱼那样的启动体验」——双击得到一个黑窗口
 * 加一个网页，关掉黑窗口时模型服务随之结束、显存释放。
 *
 * 两个子服务：
 *   ① 本地模型服务  lab/train/serve-erlangshen.py  （127.0.0.1:8790）
 *   ② 网页服务      server.js                     （127.0.0.1:8787）
 *
 * 「关窗口 = 一起死」做了三重保险：
 *   1. 子进程都用 stdio:'inherit' 挂在同一个控制台上 —— 点 X 关窗口时 Windows 会给
 *      控制台上的所有进程发关闭事件，python / node 会一起被收掉；
 *   2. Ctrl+C / 收到信号时，显式 taskkill /PID <子进程> /T /F，按 PID（不是按进程名，
 *      避免误杀别的 node/python）；
 *   3. 本进程的 'exit' 钩子里再同步杀一遍，防孤儿。
 *
 * 可用的环境变量覆盖（测试用，正常双击不用管）：
 *   HUASHU_PY / HUASHU_MODEL / HUASHU_PY_PORT / HUASHU_WEB_PORT / HUASHU_CHUNK / HUASHU_NO_OPEN
 */
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = __dirname;
const PY_OVERRIDE = process.env.HUASHU_PY || '';   // 显式指定优先；没设就自动探测（见 findPython）
const MODEL = process.env.HUASHU_MODEL || path.join(ROOT, 'lab', 'train', 'runs', 'all20', 'best');
const PY_PORT = Number(process.env.HUASHU_PY_PORT || 8790);
const WEB_PORT = Number(process.env.HUASHU_WEB_PORT || 8787);
const CHUNK = String(process.env.HUASHU_CHUNK || '64');
const NO_OPEN = process.env.HUASHU_NO_OPEN === '1';
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

try { process.title = 'spinlens · 话术照妖镜'; } catch { /* 设置标题失败不影响运行 */ }

const kids = [];
let closing = false;
let pyExpected = false;   // 本次是否真的需要/已经有一个本地模型服务
const log = (s) => process.stdout.write(String(s) + '\n');
const step = (s) => log('  ' + s);

/**
 * 找一个能用的 Python 解释器。返回 { cmd, args, label, version }，找不到返回 null。
 * 顺序：① 环境变量 HUASHU_PY ② 项目内 / 项目同级的 python_embeded ③ .venv ④ PATH 上的 python / python3 / py -3
 * 本地模型只是可选引擎之一，找不到 Python 不应该让整个启动器崩掉。
 */
function findPython() {
  const cands = [];
  if (PY_OVERRIDE) cands.push({ cmd: PY_OVERRIDE, args: [], label: 'HUASHU_PY' });

  // python-path.txt（项目根目录，已在 .gitignore 里）：写一行 python.exe 的完整路径。
  // 为什么需要它：setx 写的是注册表，而**已经运行的 explorer.exe 不会刷新环境变量** ——
  // 从资源管理器双击 启动.cmd 时，子进程继承的是 explorer 的旧环境，HUASHU_PY 看不到。
  // 文件不受这个问题影响，双击就能生效，也不用重新登录。
  try {
    const pf = path.join(ROOT, 'python-path.txt');
    if (fs.existsSync(pf)) {
      const line = fs.readFileSync(pf, 'utf8').split(/\r?\n/).map((s) => s.trim())
        .find((s) => s && !s.startsWith('#'));
      if (line) cands.push({ cmd: line, args: [], label: 'python-path.txt' });
    }
  } catch { /* 读不到就跳过 */ }
  const rels = [
    path.join(ROOT, 'python_embeded', 'python.exe'),
    path.join(ROOT, '..', 'python_embeded', 'python.exe'),
    path.join(ROOT, 'python_embeded', 'python'),
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.venv', 'bin', 'python'),
  ];
  for (const r of rels) cands.push({ cmd: r, args: [], label: path.relative(path.join(ROOT, '..'), r) });
  cands.push({ cmd: 'python', args: [], label: 'PATH 上的 python' });
  cands.push({ cmd: 'python3', args: [], label: 'PATH 上的 python3' });
  if (process.platform === 'win32') cands.push({ cmd: 'py', args: ['-3'], label: 'PATH 上的 py -3' });

  for (const c of cands) {
    const looksLikePath = c.cmd.includes(path.sep) || c.cmd.includes('/');
    if (looksLikePath && !fs.existsSync(c.cmd)) continue;
    try {
      // 只取退出码、不走管道（stdio:'ignore'）：这样在没有管道权限的受限环境里也能探测
      const r = spawnSync(c.cmd, [...c.args, '--version'], { stdio: 'ignore', timeout: 20000 });
      if (r.status === 0) return c;
    } catch { /* 这个候选不可用，试下一个 */ }
  }
  return null;
}

function probe(url, ms = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: ms }, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function probeWeb(url, ms = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: ms }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; if (b.length > 4000) req.destroy(); });
      res.on('end', () => resolve(res.statusCode === 200 && b.includes('话术照妖镜')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function killTree(pid, label) {
  if (!pid) return;
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  step(`已结束 ${label}（PID ${pid}）${r.status === 0 ? '' : '（它可能已经自己退出了）'}`);
}

function shutdown(code, why) {
  if (closing) return;
  closing = true;
  log('');
  log(`  正在收尾${why ? `（${why}）` : ''}…`);

  // 点 X 关窗时 Windows 只给进程 ~5 秒，之后强杀。同步 taskkill 有可能来不及跑完
  //（实测现象：只关了模型，网页服务变成孤儿留在后台）。
  // 所以先把清理交给一个 detached 的助手进程 —— 它不随我们死，一定能把两棵进程树杀干净。
  const pids = kids.map((k) => k.pid).filter(Boolean);
  if (pids.length) {
    try {
      const args = pids.flatMap((p) => ['/PID', String(p)]);
      // ping 当延时器：等我们退出之后再动手，避免和我们自己的 taskkill 抢
      const helper = spawn('cmd', ['/c', 'ping', '-n', '2', '127.0.0.1', '>nul', '&', 'taskkill', ...args, '/T', '/F'], {
        stdio: 'ignore', detached: true, windowsHide: true,
      });
      helper.unref();
    } catch { /* 尽力而为 */ }
  }

  // 再同步杀一遍：正常路径下这一步就够了，助手进程是保底
  for (const k of kids) { try { killTree(k.pid, k.label); } catch { /* 尽力而为 */ } }
  log('  全部结束，本地模型占的显存应当已经释放。');
  if (code !== undefined) process.exit(code);
}

process.on('SIGINT', () => shutdown(0, 'Ctrl+C'));
process.on('SIGBREAK', () => shutdown(0, '窗口被关闭'));
process.on('SIGHUP', () => shutdown(0, '窗口被关闭'));
process.on('SIGTERM', () => shutdown(0, '收到终止信号'));
process.on('exit', () => {
  for (const k of kids) {
    try { spawnSync('taskkill', ['/PID', String(k.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
});

async function waitReady(url, label, timeoutMs, fn = probe, abort = null) {
  const t0 = Date.now();
  process.stdout.write(`  等 ${label} 就绪`);
  while (Date.now() - t0 < timeoutMs) {
    if (abort && abort()) { log(' ✗ 服务已退出，不再等'); return false; }
    if (await fn(url)) { log(' ✓'); return true; }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 700));
  }
  log(' ✗ 超时');
  return false;
}

function openBrowser(url) {
  if (NO_OPEN) { step('（HUASHU_NO_OPEN=1，跳过自动打开浏览器）'); return; }
  try {
    const c = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
    c.unref();
  } catch {
    step('（自动打开浏览器失败，请手动复制上面的网址）');
  }
}

async function main() {
  log('');
  log('  ==================================================');
  log('   spinlens · 话术照妖镜 · 一键启动');
  log('  ==================================================');
  log('');

  /* ---------- ① 本地模型服务 ---------- */
  if (await probe(`http://127.0.0.1:${PY_PORT}/health`)) {
    pyExpected = true;
    step(`127.0.0.1:${PY_PORT} 上已经有一个模型服务在跑，直接复用（关窗口时不会去动它）。`);
  } else {
    const pyInfo = findPython();
    if (!pyInfo) {
      pyExpected = false;
      log('  ⚠ 没找到可用的 Python 解释器 —— 跳过「本地模型」引擎（另外两种引擎不受影响）。');
      log('     本地模型引擎需要 Python 3.10+，且装了 torch + transformers。');
      log('     装好后设环境变量 HUASHU_PY 指向你的 python 可执行文件：');
      log('       Windows  :  set HUASHU_PY=<你的 python.exe 完整路径>');
      log('       mac/Linux:  export HUASHU_PY=<你的 python3 完整路径>');
      log('     或者把 python_embeded/ 放到项目同级目录，本启动器会自动找到它。');
      log('     不想装本地模型也行：网页右上角还有「LLM 模式」和「决策模型模式」。');
    } else if (!fs.existsSync(MODEL)) {
      pyExpected = false;
      log(`  ⚠ 找到了 Python（${pyInfo.label}）但没找到模型权重目录：${path.relative(ROOT, MODEL) || MODEL}`);
      log('     权重有几百 MB，不随仓库发布；跳过「本地模型」引擎，另外两种引擎不受影响。');
    } else {
      pyExpected = true;
      step(`启动本地模型服务（端口 ${PY_PORT}）… 加载权重约 5–20 秒，请稍候`);
      const py = spawn(pyInfo.cmd, [
        ...pyInfo.args,
        path.join(ROOT, 'lab', 'train', 'serve-erlangshen.py'),
        '--port', String(PY_PORT), '--model', MODEL, '--chunk', CHUNK,
      ], {
        cwd: ROOT,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True' },
        stdio: 'inherit',
      });
      kids.push({ pid: py.pid, label: '本地模型服务(python)' });
      py.on('exit', (c) => {
        if (closing) return;
        pyExpected = false;   // 不再等它、也不再因为它而整体收尾
        log('');
        log(`  ⚠ 本地模型服务退出了（退出码 ${c}）——多半是这台机器缺 torch/transformers、权重目录不对，或端口被占。`);
        log('     网页服务会继续跑，只是「本地模型」引擎不可用；请改用「规则 / LLM / 决策模型」引擎。');
      });
    }
  }

  /* ---------- ② 网页服务 ---------- */
  let webOwned = false;
  if (await probeWeb(WEB_URL)) {
    step(`127.0.0.1:${WEB_PORT} 上已经有一个话术照妖镜网页服务在跑，直接复用它（关窗口时不会去动它）。`);
  } else {
    step(`启动网页服务（端口 ${WEB_PORT}）…`);
    const web = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(WEB_PORT)], {
      cwd: ROOT, env: process.env, stdio: 'inherit',
    });
    webOwned = true;
    kids.push({ pid: web.pid, label: '网页服务(node)' });
    web.on('exit', (c) => {
      if (closing) return;
      log('');
      log(`  ✗ 网页服务退出了（退出码 ${c}）——多半是 ${WEB_PORT} 端口被占。`);
      shutdown(1, '网页服务异常退出');
    });
  }

  /* ---------- ③ 等就绪 ---------- */
  const pyOk = pyExpected ? await waitReady(`http://127.0.0.1:${PY_PORT}/health`, '本地模型服务', 180000, probe, () => !pyExpected) : true;
  const webOk = await waitReady(WEB_URL, '网页服务', 30000, probeWeb);   // 必须是「真的话术照妖镜页面」，不能只看状态码

  log('');
  if (!webOk) {
    log('  网页服务没能起来，启动失败。下面留着的信息可以拿去看问题。');
    shutdown(1, '网页服务就绪超时');
    return;
  }
  if (!pyOk) {
    log('  ⚠ 本地模型服务没能就绪 —— 只跑网页服务，「本地模型」引擎不可用。');
    log('     可以用「规则 / LLM / 决策模型」引擎；修好 Python 环境后重开即可。');
    log('');
  }

  log('  --------------------------------------------------');
  log('   都起来了：');
  log(`   网页前端    ${WEB_URL}`);
  if (pyExpected && pyOk) {
    log(`   本地模型    http://127.0.0.1:${PY_PORT}/health`);
    log(`   模型权重    ${path.relative(ROOT, MODEL) || MODEL}`);
  } else {
    log('   本地模型    （未启用 —— 需要 Python + torch + 权重，见上方说明）');
  }
  log('  --------------------------------------------------');
  log('');
  if (!kids.length) {
    log('  注：两个服务都是复用的（本来就在跑），所以关窗口不会释放显存。');
  } else if (!webOwned) {
    log('  注：网页服务是复用的；关窗口会结束本次拉起的本地模型服务。');
  }
  log('   ★ 关掉这个黑窗口（点 X，或按 Ctrl+C）= 本次拉起的服务一起结束、显存自动释放。');
  log('     想再跑一次：重新双击 启动.cmd。');
  log('');
  openBrowser(WEB_URL);

  // 挂住不退：子进程的输出会一直打到这个窗口里
  await new Promise(() => {});
}

main().catch((e) => {
  log('  启动器出错：' + (e && e.message ? e.message : e));
  shutdown(1);
});
