#!/usr/bin/env node
// AIChat桥接 局域网管理面板（全功能）
//
// 它不是扩展的一部分，也不改扩展的任何信任边界：面板只做一件事——
// 通过 DevTools Protocol 在**已经在跑的 options.html 页面里**执行
// chrome.runtime.sendMessage({ type: 'options:*' })，把结果回给浏览器。
// 因此扩展自己的校验（设置页来源、配置互斥、单飞、绑定查重）一条不少。
//
// 安全边界（刻意保持窄）：
//   * CDP 端口始终只连 127.0.0.1，面板不会把 CDP 暴露到局域网。
//   * 面板自身默认只绑 127.0.0.1；要局域网访问必须显式 PANEL_BIND=0.0.0.0。
//   * 所有请求要求口令换来的 HttpOnly + SameSite=Strict 会话 Cookie。
//   * 改状态类接口额外要求 X-Panel-CSRF 头（防跨站表单提交）。
//   * 口令比较用 timingSafeEqual；登录失败按来源 IP 限速。
//   * 不记录凭据；appSecret 只进不出（状态接口本来就不返回它）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

// 面板只转发扩展设置页本来就有的操作，别的一律拒绝（纵深防御：
// 即使有人绕过 UI 直接打 /api/rpc，也打不出扩展没有的能力）。
export const ALLOWED_RPC = Object.freeze(new Set([
  'options:status', 'options:tabs', 'options:moderation',
  'options:config', 'options:bind', 'options:unbind',
  'options:save-words', 'options:reply-style',
  'options:assistant', 'options:channel', 'options:platform',
  'options:cancel-job', 'options:clear-history', 'options:clear-notices',
]));
const READ_ONLY_RPC = new Set(['options:status', 'options:tabs', 'options:moderation']);

const ASSISTANTS = Object.freeze(['chatgpt', 'claude', 'gemini', 'qwen', 'hark']);
const PLATFORMS = Object.freeze(['qq', 'feishu']);

function fail(status, message) { return Object.assign(new Error(message), { status }); }

// 从现场任意一个扩展目标推出设置页地址。不能用 new URL(...).origin：
// chrome-extension: 不是 special scheme，origin 会变成字符串 "null"。
export function deriveOptionsUrl(targets) {
  const own = Array.isArray(targets)
    ? targets.find(target => target && typeof target.url === 'string' && target.url.startsWith('chrome-extension://'))
    : null;
  if (!own) throw fail(503, '调试端口上没有加载 AIChat桥接 扩展。请确认浏览器是用 --load-extension 启动的。');
  let base;
  try { base = new URL(own.url); } catch { throw fail(503, '扩展目标地址无法解析'); }
  if (base.protocol !== 'chrome-extension:' || !base.host) throw fail(503, '扩展目标地址无法解析');
  return 'chrome-extension://' + base.host + '/options.html';
}

// ---------------------------------------------------------------------------
// CDP 客户端：连 127.0.0.1 的调试端口，在 options.html 里求值。
// ---------------------------------------------------------------------------
export function createCdpClient({ port = 9222, connectTimeoutMs = 8000 } = {}) {
  let socket = null;
  let targetId = null;
  let serial = 0;
  const pending = new Map();

  const endpoint = p => 'http://127.0.0.1:' + port + p;

  async function listTargets() {
    const response = await fetch(endpoint('/json/list'), { redirect: 'error' });
    if (!response.ok) throw fail(502, '调试端口返回异常：' + response.status);
    return await response.json();
  }

  function isOptions(target) {
    return target.type === 'page' && typeof target.url === 'string' &&
      target.url.startsWith('chrome-extension://') && target.url.endsWith('/options.html');
  }

  // 扩展 id 因扩展目录的绝对路径不同而不同，所以按 URL 形状找，不写死 id。
  async function findOptions() {
    const targets = await listTargets();
    return targets.find(isOptions) || null;
  }

  // 设置页被关掉时，面板自己开一个。扩展 id 由目录绝对路径决定，所以从
  // 现场已有的任何一个扩展目标上读出来，不写死。
  async function openOptionsPage(targets) {
    const optionsUrl = deriveOptionsUrl(targets);
    const response = await fetch(endpoint('/json/new?' + encodeURIComponent(optionsUrl)), { method: 'PUT' });
    if (!response.ok) throw fail(503, '无法打开扩展设置页（调试端口返回 ' + response.status + '）');
    const created = await response.json().catch(() => null);
    if (!created || typeof created.id !== 'string') throw fail(503, '无法打开扩展设置页（调试端口没有返回目标）');
    return created;
  }

  async function ensureSocket() {
    if (socket && socket.readyState === 1) return socket;
    let page = await findOptions();
    if (!page) {
      // 自愈：设置页可能被关掉了，面板用调试端口重新打开一个再连。
      page = await openOptionsPage(await listTargets());
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    if (socket && targetId !== page.id) { try { socket.close(); } catch {} socket = null; }
    if (!socket) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(fail(503, '连接扩展设置页超时')), connectTimeoutMs);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(timer); reject(fail(503, '无法连接扩展设置页的调试通道')); }, { once: true });
      });
      ws.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); pending.delete(message.id); request.resolve(message);
      });
      ws.addEventListener('close', () => {
        for (const request of pending.values()) { clearTimeout(request.timer); request.resolve({ ok: false, error: '调试通道已断开' }); }
        pending.clear();
        if (socket === ws) { socket = null; targetId = null; }
      });
      socket = ws; targetId = page.id;
    }
    return socket;
  }

  function send(method, params, timeoutMs) {
    const ws = socket;
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(fail(504, '扩展设置页响应超时')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); pending.delete(id); reject(fail(503, '调试通道写入失败')); }
    });
  }

  // 在设置页主世界求值。表达式里必须自带超时，避免扩展后台卡住时面板一起挂。
  async function evaluate(expression, { timeoutMs = 20000 } = {}) {
    await ensureSocket();
    const reply = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: false,
    }, timeoutMs + 2000);
    if (reply.error) throw fail(502, '扩展设置页求值失败：' + (reply.error.message || '未知错误'));
    const details = reply.result?.exceptionDetails;
    if (details) {
      const text = details.exception?.description || details.text || '设置页抛出异常';
      throw fail(502, String(text).split('\n')[0].slice(0, 300));
    }
    return reply.result?.result?.value;
  }

  async function rpc(type, body = {}, { timeoutMs = 20000 } = {}) {
    const message = JSON.stringify({ type, ...body });
    // 用 JSON.stringify 把消息嵌进表达式，避免任何注入；超时在页面内也做一层，
    // 原因是 service worker 若进入重启，回调可能永远不来。
    const expression = '(async () => {' +
      'const reply = await Promise.race([' +
      'chrome.runtime.sendMessage(' + message + '),' +
      'new Promise(resolve => setTimeout(() => resolve({ ok: false, error: "扩展后台没有在 15 秒内响应" }), 15000))' +
      ']);' +
      'return reply === undefined ? { ok: false, error: "扩展后台没有响应" } : reply;' +
      '})()';
    const value = await evaluate(expression, { timeoutMs });
    if (!value || typeof value !== 'object') throw fail(502, '扩展返回了无法识别的结果');
    if (!value.ok) throw fail(Number.isInteger(value.status) ? value.status : 502, String(value.error || '扩展拒绝了该操作').slice(0, 300));
    return value.data;
  }

  return { rpc, listTargets, findOptions, openOptionsPage, evaluate, close() { try { socket?.close(); } catch {} socket = null; } };
}

// ---------------------------------------------------------------------------
// 会话与口令
// ---------------------------------------------------------------------------
function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    // 仍然做一次常量时间比较，避免明显的长度侧信道。
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function readOrCreateToken(file) {
  try { const text = fs.readFileSync(file, 'utf8').trim(); if (text) return text; } catch {}
  const token = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------
export function createPanel({
  token,
  cdp = createCdpClient({ port: Number(process.env.AICHAT_DEBUG_PORT || 9222) }),
  now = Date.now,
  sessionTtlMs = 12 * 60 * 60 * 1000,
  maxLoginAttempts = 6,
  loginWindowMs = 5 * 60 * 1000,
  publicDir = PUBLIC_DIR,
} = {}) {
  if (typeof token !== 'string' || token.length < 8) throw fail(500, '面板口令过短');

  const sessions = new Map();      // sid -> { expiresAt, ip }
  const attempts = new Map();      // ip -> { count, resetAt }

  const cookieName = 'aichat_panel';
  const csrfSecret = crypto.randomBytes(32);

  function sessionFrom(request) {
    const raw = request.headers.cookie || '';
    for (const part of raw.split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key !== cookieName) continue;
      const sid = rest.join('=');
      const session = sessions.get(sid);
      if (!session) return null;
      if (session.expiresAt <= now()) { sessions.delete(sid); return null; }
      return { sid, ...session };
    }
    return null;
  }

  function rateLimited(ip) {
    const record = attempts.get(ip);
    if (!record) return false;
    if (record.resetAt <= now()) { attempts.delete(ip); return false; }
    return record.count >= maxLoginAttempts;
  }
  function noteFailure(ip) {
    const record = attempts.get(ip);
    if (!record || record.resetAt <= now()) attempts.set(ip, { count: 1, resetAt: now() + loginWindowMs });
    else record.count += 1;
  }

  function clientIp(request) {
    // 面板不信任任何代理头：它跑在局域网，直接取 socket 地址。
    return request.socket?.remoteAddress || 'unknown';
  }

  function cookie(sid, maxAgeSeconds) {
    // SameSite=Strict + HttpOnly：跨站请求带不上这个 Cookie。
    // 局域网 http 下不能加 Secure（加了浏览器就不回传），所以这里不加。
    return cookieName + '=' + sid + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + maxAgeSeconds;
  }

  const MIME = Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
  });

  function securityHeaders(response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  }

  function sendJson(response, status, value) {
    const body = Buffer.from(JSON.stringify(value));
    securityHeaders(response);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    response.end(body);
  }

  function readBody(request, limit = 1_000_000) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      request.on('data', chunk => {
        size += chunk.length;
        if (size > limit) { reject(fail(413, '请求体过大')); request.destroy(); return; }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (!chunks.length) { resolve({}); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(fail(400, '请求体不是合法 JSON')); }
      });
      request.on('error', () => reject(fail(400, '请求读取失败')));
    });
  }

  function serveStatic(request, response, pathname) {
    const relative = pathname === '/' ? '/index.html' : pathname;
    const resolved = path.resolve(publicDir, '.' + relative);
    // 目录穿越防护：解析后的路径必须仍落在 public 目录内。
    if (!resolved.startsWith(publicDir + path.sep) && resolved !== path.join(publicDir, 'index.html')) {
      return sendJson(response, 404, { ok: false, error: 'Not found' });
    }
    let data;
    try { data = fs.readFileSync(resolved); }
    catch { return sendJson(response, 404, { ok: false, error: 'Not found' }); }
    securityHeaders(response);
    response.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream', 'Content-Length': data.length });
    response.end(data);
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://panel.invalid');
    const pathname = url.pathname;

    if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/app.js' || pathname === '/style.css')) {
      return serveStatic(request, response, pathname);
    }

    if (pathname === '/api/login' && request.method === 'POST') {
      const ip = clientIp(request);
      if (rateLimited(ip)) return sendJson(response, 429, { ok: false, error: '尝试次数过多，请稍后再试' });
      const body = await readBody(request).catch(error => { throw error; });
      if (typeof body.token !== 'string' || !timingSafeEqual(body.token, token)) {
        noteFailure(ip);
        return sendJson(response, 401, { ok: false, error: '口令不正确' });
      }
      attempts.delete(ip);
      const sid = crypto.randomBytes(32).toString('base64url');
      sessions.set(sid, { expiresAt: now() + sessionTtlMs, ip });
      securityHeaders(response);
      response.setHeader('Set-Cookie', cookie(sid, Math.floor(sessionTtlMs / 1000)));
      return sendJson(response, 200, { ok: true, csrf: csrfFor(sid) });
    }

    if (pathname === '/api/logout' && request.method === 'POST') {
      const session = sessionFrom(request);
      if (session) sessions.delete(session.sid);
      securityHeaders(response);
      response.setHeader('Set-Cookie', cookie('', 0));
      return sendJson(response, 200, { ok: true });
    }

    if (pathname === '/api/session' && request.method === 'GET') {
      const session = sessionFrom(request);
      return sendJson(response, 200, { ok: true, authenticated: Boolean(session), csrf: session ? csrfFor(session.sid) : null });
    }

    if (pathname === '/api/rpc' && request.method === 'POST') {
      const session = sessionFrom(request);
      if (!session) return sendJson(response, 401, { ok: false, error: '请先登录' });
      const body = await readBody(request);
      const type = body?.type;
      if (typeof type !== 'string' || !ALLOWED_RPC.has(type)) return sendJson(response, 400, { ok: false, error: '不允许的面板操作' });
      if (!READ_ONLY_RPC.has(type)) {
        // 双保险：SameSite Cookie 之外再做一次自定义头校验。
        if (request.headers['x-panel-csrf'] !== csrfFor(session.sid)) return sendJson(response, 403, { ok: false, error: '请求校验失败，请刷新页面' });
        if (request.headers['origin'] && request.headers.origin !== originOf(request)) return sendJson(response, 403, { ok: false, error: '请求来源不被接受' });
      }
      const payload = { ...body }; delete payload.type;
      if (payload.assistant !== undefined && !ASSISTANTS.includes(payload.assistant)) return sendJson(response, 400, { ok: false, error: '助手无效' });
      if (payload.platform !== undefined && !PLATFORMS.includes(payload.platform)) return sendJson(response, 400, { ok: false, error: '平台无效' });
      try {
        const data = await cdp.rpc(type, payload);
        return sendJson(response, 200, { ok: true, data });
      } catch (error) {
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 502;
        return sendJson(response, status, { ok: false, error: String(error.message || '扩展操作失败').slice(0, 300) });
      }
    }

    return sendJson(response, 404, { ok: false, error: 'Not found' });
  }

  function csrfFor(sid) {
    return crypto.createHmac('sha256', csrfSecret).update(sid).digest('base64url').slice(0, 32);
  }
  function originOf(request) {
    const host = request.headers.host || '';
    return 'http://' + host;
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(error => {
      if (response.headersSent) { try { response.destroy(); } catch {} return; }
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      sendJson(response, status, { ok: false, error: status === 500 ? '面板内部错误' : String(error.message || '请求失败') });
    });
  });
  server.keepAliveTimeout = 15000;
  server.headersTimeout = 20000;
  return { server, cdp, sessions };
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
function start() {
  const port = Number(process.env.PANEL_PORT || 8787);
  const bind = process.env.PANEL_BIND || '127.0.0.1';
  const tokenFile = process.env.PANEL_TOKEN_FILE ||
    path.join(process.env.HOME || '.', '.local/share/aichat-bridge/panel/token');
  const token = process.env.PANEL_TOKEN?.trim() || readOrCreateToken(tokenFile);
  const debugPort = Number(process.env.AICHAT_DEBUG_PORT || 9222);

  const cdp = createCdpClient({ port: debugPort });
  const { server } = createPanel({ token, cdp });
  server.listen(port, bind, () => {
    const lan = bind !== '127.0.0.1' && bind !== '::1';
    process.stdout.write('[panel] listening on http://' + bind + ':' + port + '\n');
    if (lan) process.stdout.write('[panel] 局域网可访问：请用口令登录，不要把这个端口映射到公网\n');
    process.stdout.write('[panel] 口令来源：' + (process.env.PANEL_TOKEN ? 'PANEL_TOKEN 环境变量' : tokenFile) + '\n');
    process.stdout.write('[panel] 扩展调试端口：127.0.0.1:' + debugPort + '（面板不会把这个端口暴露出去）\n');
  });
  const shutdown = () => { cdp.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) start();
