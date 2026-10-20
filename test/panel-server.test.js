import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPanel, ALLOWED_RPC, deriveOptionsUrl } from '../deploy/panel/server.js';

// 面板是一个纯 HTTP 网关：这些用例用假的 CDP 客户端验证鉴权、CSRF、
// 白名单与路径防护，不启动浏览器。

function fakeCdp(calls = []) {
  return {
    calls,
    async rpc(type, payload) { calls.push([type, payload]); return { ok: true, echoed: type, payload }; },
    close() {},
  };
}

async function startPanel(options = {}) {
  const calls = [];
  const panel = createPanel({ token: 'test-panel-token-123456', cdp: fakeCdp(calls), ...options });
  await new Promise(resolve => panel.server.listen(0, '127.0.0.1', resolve));
  const { port } = panel.server.address();
  const base = 'http://127.0.0.1:' + port;
  return { base, calls, panel, close: () => new Promise(resolve => panel.server.close(resolve)) };
}

async function request(base, path, { method = 'GET', body, cookie, csrf, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-Panel-CSRF': csrf } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data, setCookie, headers: response.headers };
}

async function login(base, token = 'test-panel-token-123456') {
  const result = await request(base, '/api/login', { method: 'POST', body: { token } });
  assert.equal(result.status, 200);
  const cookie = result.setCookie.split(';')[0];
  return { cookie, csrf: result.data.csrf };
}

test('面板未登录时拒绝一切 RPC，登录后才放行', async () => {
  const x = await startPanel();
  try {
    const anonymous = await request(x.base, '/api/rpc', { method: 'POST', body: { type: 'options:status', assistant: 'hark' } });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.data.ok, false);
    assert.equal(x.calls.length, 0);

    const { cookie, csrf } = await login(x.base);
    const allowed = await request(x.base, '/api/rpc', { method: 'POST', body: { type: 'options:status', assistant: 'hark' }, cookie, csrf });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.data.ok, true);
    assert.equal(allowed.data.data.echoed, 'options:status');
    assert.deepEqual(x.calls.at(-1), ['options:status', { assistant: 'hark' }]);
  } finally { await x.close(); }
});

test('口令错误被拒绝，且同一来源连续失败后被限速', async () => {
  const x = await startPanel({ maxLoginAttempts: 3 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const bad = await request(x.base, '/api/login', { method: 'POST', body: { token: 'wrong-token-value' } });
      assert.equal(bad.status, 401);
    }
    const limited = await request(x.base, '/api/login', { method: 'POST', body: { token: 'test-panel-token-123456' } });
    assert.equal(limited.status, 429);
    assert.equal(limited.data.ok, false);
  } finally { await x.close(); }
});

test('写操作必须带 CSRF 头，读操作不需要', async () => {
  const x = await startPanel();
  try {
    const { cookie, csrf } = await login(x.base);
    const read = await request(x.base, '/api/rpc', { method: 'POST', body: { type: 'options:status' }, cookie });
    assert.equal(read.status, 200);

    const missing = await request(x.base, '/api/rpc', { method: 'POST', body: { type: 'options:assistant', assistant: 'hark', enabled: true }, cookie });
    assert.equal(missing.status, 403);
    assert.equal(x.calls.length, 1);

    const wrong = await request(x.base, '/api/rpc', { method: 'POST', body: { type: 'options:assistant', assistant: 'hark', enabled: true }, cookie, csrf: 'not-the-csrf' });
    assert.equal(wrong.status, 403);

    const good = await request(x.base, '/api/rpc', { method: 'POST', body: { type: 'options:assistant', assistant: 'hark', enabled: true }, cookie, csrf });
    assert.equal(good.status, 200);
    assert.deepEqual(x.calls.at(-1), ['options:assistant', { assistant: 'hark', enabled: true }]);
  } finally { await x.close(); }
});

test('跨站 Origin 的写请求被拒绝', async () => {
  const x = await startPanel();
  try {
    const { cookie, csrf } = await login(x.base);
    const crossSite = await request(x.base, '/api/rpc', {
      method: 'POST', body: { type: 'options:assistant', assistant: 'hark', enabled: true }, cookie, csrf,
      headers: { Origin: 'http://evil.example' },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(x.calls.length, 0);
  } finally { await x.close(); }
});

test('只转发白名单内的扩展操作，伪造的能力打不出去', async () => {
  const x = await startPanel();
  try {
    const { cookie, csrf } = await login(x.base);
    for (const type of ['options:import', 'options:exec', 'bridge:poll', '__proto__', 'toString']) {
      const result = await request(x.base, '/api/rpc', { method: 'POST', body: { type, assistant: 'hark' }, cookie, csrf });
      assert.equal(result.status, 400, type);
    }
    assert.equal(x.calls.length, 0);
    // 白名单本身不含协议内部与页面通道。
    assert.equal(ALLOWED_RPC.has('bridge:poll'), false);
    assert.equal(ALLOWED_RPC.has('bridge:result'), false);
  } finally { await x.close(); }
});

test('助手与平台取值被校验，非法值不会到达扩展', async () => {
  const x = await startPanel();
  try {
    const { cookie, csrf } = await login(x.base);
    const badAssistant = await request(x.base, '/api/rpc', { method: 'POST', body: { type: 'options:status', assistant: 'not-an-assistant' }, cookie, csrf });
    assert.equal(badAssistant.status, 400);
    const badPlatform = await request(x.base, '/api/rpc', { method: 'POST', body: { type: 'options:status', assistant: 'hark', platform: 'telegram' }, cookie, csrf });
    assert.equal(badPlatform.status, 400);
    assert.equal(x.calls.length, 0);
  } finally { await x.close(); }
});

test('静态资源只从面板目录提供，目录穿越被挡住', async () => {
  const x = await startPanel();
  try {
    const index = await request(x.base, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(index.headers.get('x-frame-options'), 'DENY');

    for (const path of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/public/../server.js']) {
      const response = await request(x.base, path);
      assert.ok(response.status === 404 || response.status === 400, path + ' -> ' + response.status);
    }
  } finally { await x.close(); }
});

test('会话过期后必须重新登录', async () => {
  let clock = 1_000_000;
  const x = await startPanel({ now: () => clock, sessionTtlMs: 60_000 });
  try {
    const { cookie, csrf } = await login(x.base);
    const before = await request(x.base, '/api/rpc', { method: 'POST', body: { type: 'options:status' }, cookie, csrf });
    assert.equal(before.status, 200);
    clock += 61_000;
    const after = await request(x.base, '/api/rpc', { method: 'POST', body: { type: 'options:status' }, cookie, csrf });
    assert.equal(after.status, 401);
  } finally { await x.close(); }
});

test('退出登录会销毁会话 Cookie', async () => {
  const x = await startPanel();
  try {
    const { cookie, csrf } = await login(x.base);
    const out = await request(x.base, '/api/logout', { method: 'POST', body: {}, cookie, csrf });
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /Max-Age=0/);
    const after = await request(x.base, '/api/rpc', { method: 'POST', body: { type: 'options:status' }, cookie, csrf });
    assert.equal(after.status, 401);
  } finally { await x.close(); }
});

test('扩展拒绝的操作把状态与说明原样透传给面板', async () => {
  const calls = [];
  const failing = {
    calls,
    async rpc(type) { calls.push([type]); throw Object.assign(new Error('助手还有未完成任务，请完成后再停用'), { status: 409 }); },
    close() {},
  };
  const panel = createPanel({ token: 'test-panel-token-123456', cdp: failing });
  await new Promise(resolve => panel.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + panel.server.address().port;
  try {
    const { cookie, csrf } = await login(base);
    const result = await request(base, '/api/rpc', { method: 'POST', body: { type: 'options:assistant', assistant: 'hark', enabled: false }, cookie, csrf });
    assert.equal(result.status, 409);
    assert.match(result.data.error, /未完成任务/);
  } finally { await new Promise(resolve => panel.server.close(resolve)); }
});

test('扩展设置页没打开时给出可操作的错误而不是崩溃', async () => {
  const offline = {
    async rpc() { throw Object.assign(new Error('没有打开的扩展设置页。请先在浏览器里打开一次扩展设置'), { status: 503 }); },
    close() {},
  };
  const panel = createPanel({ token: 'test-panel-token-123456', cdp: offline });
  await new Promise(resolve => panel.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + panel.server.address().port;
  try {
    const { cookie, csrf } = await login(base);
    const result = await request(base, '/api/rpc', { method: 'POST', body: { type: 'options:status' }, cookie, csrf });
    assert.equal(result.status, 503);
    assert.match(result.data.error, /扩展设置页/);
  } finally { await new Promise(resolve => panel.server.close(resolve)); }
});

test('从现场扩展目标推出设置页地址，不依赖写死的扩展 id', () => {
  assert.equal(
    deriveOptionsUrl([{ type: 'page', url: 'http://x/' }, { type: 'background_page', url: 'chrome-extension://abcdefghijklmnop/offscreen.html' }]),
    'chrome-extension://abcdefghijklmnop/options.html');
  assert.equal(
    deriveOptionsUrl([{ type: 'service_worker', url: 'chrome-extension://otherid/worker.js' }]),
    'chrome-extension://otherid/options.html');
  // 没有扩展目标时必须给出可操作的错误，而不是拼出 "null/options.html"。
  assert.throws(() => deriveOptionsUrl([]), /没有加载/);
  assert.throws(() => deriveOptionsUrl([{ type: 'page', url: 'http://127.0.0.1:8787/' }]), /没有加载/);
});

test('面板不信任 X-Forwarded-For 之类的代理头', async () => {
  const x = await startPanel({ maxLoginAttempts: 2 });
  try {
    // 每次都伪造不同来源头；若面板采信它，限速就会被绕过。
    for (let attempt = 0; attempt < 2; attempt++) {
      await request(x.base, '/api/login', { method: 'POST', body: { token: 'wrong' }, headers: { 'X-Forwarded-For': '10.0.0.' + attempt } });
    }
    const limited = await request(x.base, '/api/login', { method: 'POST', body: { token: 'test-panel-token-123456' }, headers: { 'X-Forwarded-For': '10.0.0.99' } });
    assert.equal(limited.status, 429);
  } finally { await x.close(); }
});
