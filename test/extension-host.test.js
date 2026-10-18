import test from 'node:test';
import assert from 'node:assert/strict';

let instance = 0;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function setup(t, { sendMessage } = {}) {
  const saved = { Worker: globalThis.Worker, chrome: globalThis.chrome };
  const forwarded = []; const listeners = []; const engines = [];
  class FakeWorker {
    constructor(url, options) { this.url = url; this.options = options; this.listeners = new Map(); this.requests = []; engines.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    postMessage(message) { this.requests.push(structuredClone(message)); }
    emit(data) { this.listeners.get('message')({ data }); }
    fail() { this.listeners.get('error')(); }
  }
  globalThis.Worker = FakeWorker;
  globalThis.chrome = { runtime: {
    id: 'extension-id', getURL: path => 'chrome-extension://extension-id/' + path,
    sendMessage(message) { forwarded.push(structuredClone(message)); return sendMessage ? sendMessage(message) : Promise.resolve({ ok: true }); },
    onMessage: { addListener(listener) { listeners.push(listener); } },
  } };
  t.after(() => { globalThis.Worker = saved.Worker; globalThis.chrome = saved.chrome; });
  await import(`../extension/host.js?isolated=${++instance}`);
  const engine = engines[0];
  const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/worker.js' };
  function request(message = { target: 'bridge-host', route: '/v1/status' }, source = sender) {
    const responses = [];
    const keepOpen = listeners[0](message, source, response => responses.push(response));
    return { responses, keepOpen };
  }
  return { engine, forwarded, sender, request };
}

test('host forwards only the fixed work-available notice and leaves pending RPC responses intact', async t => {
  const x = await setup(t);
  assert.equal(x.engine.options.type, 'module'); assert.match(x.engine.url.pathname, /\/engine\.js$/);
  const request = x.request(); assert.equal(request.keepOpen, true);
  const { id } = x.engine.requests[0];
  for (const notice of [
    { type: 'bridge:work-available', id },
    { type: 'bridge:work-available', prompt: 'private answer' },
    { type: 'bridge:work-available', platform: 'qq' },
    Object.assign([], { type: 'bridge:work-available' }),
    { type: 'bridge:unknown' }, null,
  ]) x.engine.emit(notice);
  await flush(); assert.deepEqual(x.forwarded, []); assert.deepEqual(request.responses, []);
  x.engine.emit({ type: 'bridge:work-available' }); await flush();
  assert.deepEqual(x.forwarded, [{ type: 'bridge:work-available' }]);
  assert.deepEqual(request.responses, []);
  const response = { id, ok: true, data: { platform: 'qq' } };
  x.engine.emit(response); assert.deepEqual(request.responses, [response]);
});

test('wake forwarding failures do not reject an engine RPC or disable later requests', async t => {
  for (const synchronous of [false, true]) {
    const x = await setup(t, { sendMessage: () => {
      if (synchronous) throw Error('worker unavailable');
      return Promise.reject(Error('worker unavailable'));
    } });
    const request = x.request(); const { id } = x.engine.requests[0];
    x.engine.emit({ type: 'bridge:work-available' }); await flush();
    assert.deepEqual(request.responses, []);
    x.engine.emit({ id, ok: true, data: { ok: true } });
    assert.equal(request.responses[0].ok, true);
    const next = x.request(); x.engine.emit({ id: x.engine.requests[1].id, ok: true, data: { ok: true } });
    assert.equal(next.responses[0].ok, true);
  }
});

test('host ignores notification messages on its RPC listener and stops forwarding after engine failure', async t => {
  const x = await setup(t);
  assert.deepEqual(x.request({ type: 'bridge:work-available' }), { keepOpen: false, responses: [] });
  for (const sender of [{ ...x.sender, id: 'foreign' }, { ...x.sender, url: 'chrome-extension://extension-id/options.html' }, { ...x.sender, tab: { id: 7 } }]) {
    const rejected = x.request(undefined, sender); assert.equal(rejected.keepOpen, false); assert.equal(rejected.responses[0].status, 403);
  }
  const pending = x.request(); x.engine.fail(); assert.equal(pending.responses[0].status, 503);
  x.engine.emit({ type: 'bridge:work-available' }); await flush(); assert.deepEqual(x.forwarded, []);
  const rejected = x.request(); assert.equal(rejected.keepOpen, false); assert.equal(rejected.responses[0].status, 503);
});
