import { upgradeWordConfig } from '../extension/word-presets.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { AssistantRouter } from '../extension/assistant-router.js';
import { PlatformRouter } from '../extension/platform-router.js';
import { ASSISTANTS, assistantId, assistantForUrl, conversationUrl } from '../extension/shared.js';
import { BridgeStore as QQStore } from '../extension/qq-store.js';
import { BridgeStore as FeishuStore } from '../extension/feishu-store.js';
import { ExtensionEngine as QQEngine } from '../extension/qq-runtime.js';
import { ExtensionEngine as FeishuEngine } from '../extension/feishu-runtime.js';
import { createWordFilter } from '../extension/moderation.js';
import { IndexedDBStorage } from '../extension/storage.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const jobId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function engineFixture(assistant, platform) {
  const state = { groups: [], jobs: [], delivery: [] }; const calls = [];
  const engine = {
    config: { appId: `${assistant}-${platform}`, appSecret: `${assistant}-${platform}-private` }, enabled: false,
    [platform]: { state: 'stopped' }, store: { async status() { return structuredClone(state); } },
    async init(options) { calls.push(['init', options]); },
    async activate() { calls.push(['activate']); this.enabled = true; this[platform] = { state: 'connected' }; },
    async deactivate() { calls.push(['deactivate']); this.enabled = false; this[platform] = { state: 'stopped' }; },
    async status() { return { ...structuredClone(state), [platform]: { ...this[platform] } }; },
    async tick() { calls.push(['tick']); return true; },
    async request(route, body) {
      calls.push(['request', route, body]);
      if (route === '/v1/config') this.config = { ...this.config, ...body };
      return route === '/v1/poll' ? { job: { id: jobId, platform: 'spoofed', assistant: 'spoofed' } } : { ok: true };
    },
  };
  return { engine, state, calls };
}
async function fixture({ enabled = {}, selected = {}, writeEnabled, beforeInit } = {}) {
  const routers = {}; const profiles = {}; const writes = [];
  for (const assistant of ASSISTANTS) {
    profiles[assistant] = Object.fromEntries(['qq', 'feishu'].map(platform => [platform, engineFixture(assistant, platform)]));
    routers[assistant] = new PlatformRouter({ engines: Object.fromEntries(['qq', 'feishu'].map(platform => [platform, profiles[assistant][platform].engine])),
      readSelection: async () => selected[assistant], writeSelection: async platform => { selected[assistant] = platform; },
    });
  }
  beforeInit?.(profiles);
  const router = new AssistantRouter({ routers, readEnabled: async assistant => enabled[assistant],
    writeEnabled: async (assistant, value) => { await writeEnabled?.(assistant, value); writes.push([assistant, value]); enabled[assistant] = value; },
  });
  await router.init();
  return { router, routers, profiles, writes, selected };
}

test('assistant routing preserves ChatGPT default and keeps new profiles disconnected until explicitly enabled', async () => {
  const f = await fixture();
  const status = await f.router.request('/v1/status');
  assert.equal(status.assistant, 'chatgpt'); assert.equal(status.enabled, true);
  assert.deepEqual(Object.fromEntries(Object.entries(status.assistants).map(([id, { platforms, ...summary }]) => [id, summary])), {
    chatgpt: { enabled: true, platform: 'qq', connection: { state: 'connected' }, configured: true, appId: 'chatgpt-qq' },
    claude: { enabled: false, platform: 'qq', connection: { state: 'stopped' }, configured: true, appId: 'claude-qq' },
    gemini: { enabled: false, platform: 'qq', connection: { state: 'stopped' }, configured: true, appId: 'gemini-qq' },
    qwen: { enabled: false, platform: 'qq', connection: { state: 'stopped' }, configured: true, appId: 'qwen-qq' },
    hark: { enabled: false, platform: 'qq', connection: { state: 'stopped' }, configured: true, appId: 'hark-qq' },
  });
  assert.doesNotMatch(JSON.stringify(status), /private|appSecret/);
  assert.equal((await f.router.request('/v1/status', { assistant: 'claude' })).enabled, false);
  assert.deepEqual(await f.router.request('/v1/assistant', { assistant: 'claude', enabled: true }), { ok: true, assistant: 'claude', enabled: true, platform: 'qq' });
  assert.equal(f.profiles.chatgpt.qq.engine.enabled, true); assert.equal(f.profiles.claude.qq.engine.enabled, true);
  assert.deepEqual(f.writes, [['claude', true]]);
});

test('saved assistant enable state and platform selections restore independently', async () => {
  const f = await fixture({ enabled: { chatgpt: false, claude: true }, selected: { chatgpt: 'qq', claude: 'feishu' } });
  assert.equal(f.profiles.chatgpt.qq.engine.enabled, false); assert.equal(f.profiles.claude.feishu.engine.enabled, true);
  await f.router.request('/v1/platform', { assistant: 'chatgpt', platform: 'feishu' });
  assert.equal(f.profiles.chatgpt.feishu.engine.enabled, false); assert.equal(f.profiles.claude.feishu.engine.enabled, true);
  assert.equal(await f.router.tick('chatgpt'), false); assert.equal(await f.router.tick('claude'), true);
  assert.equal(f.profiles.chatgpt.feishu.calls.some(call => call[0] === 'tick' || call[0] === 'activate'), false);
  assert.equal(f.routers.gemini.enabled, false);
  assert.equal(f.routers.gemini.activePlatform, 'qq');
  const restored = await fixture({ enabled: { chatgpt: false, claude: true, gemini: true }, selected: { claude: 'feishu', gemini: 'feishu' } });
  assert.equal(restored.profiles.gemini.feishu.engine.enabled, true);
  assert.equal(restored.profiles.claude.feishu.engine.enabled, true);
  assert.equal(restored.profiles.chatgpt.qq.engine.enabled, false);
});

test('disabled assistant permits settings and binding changes but cannot poll, run or connect', async () => {
  const f = await fixture(); const body = { assistant: 'claude', platform: 'qq' };
  for (const route of ['/v1/config', '/v1/moderation', '/v1/bind', '/v1/unbind']) await f.router.request(route, { ...body, appId: 'different-claude-qq' });
  assert.equal((await f.router.request('/v1/poll', body)).job, null);
  for (const action of ['started', 'input-image', 'image', 'result', 'error']) await assert.rejects(f.router.request(`/v1/jobs/${jobId}/${action}`, body), error => error.status === 409);
  assert.equal(await f.router.tick('claude'), false);
  assert.equal(f.profiles.claude.qq.calls.some(call => call[0] === 'activate' || call[1] === '/v1/poll'), false);
  await f.router.request('/v1/platform', { assistant: 'claude', platform: 'feishu' });
  assert.equal(f.profiles.claude.feishu.engine.enabled, false); assert.equal(f.routers.chatgpt.activePlatform, 'qq');
});

test('non-status requests require explicit valid assistant ownership and poll labels are authoritative', async () => {
  const f = await fixture({ enabled: { claude: true } });
  for (const assistant of [undefined, '', '__proto__', 'Claude']) for (const route of ['/v1/config', '/v1/assistant', '/v1/platform', '/v1/poll']) {
    await assert.rejects(f.router.request(route, { assistant, platform: 'qq', enabled: true }), error => error.status === 400);
  }
  await assert.rejects(f.router.request('/v1/status', { assistant: 'other' }), error => error.status === 400);
  await assert.rejects(f.router.request('/v1/assistant', { assistant: 'claude', enabled: 'true' }), error => error.status === 400);
  const result = await f.router.request('/v1/poll', { assistant: 'claude', platform: 'qq', tabId: 7 });
  assert.equal(result.job.assistant, 'claude'); assert.equal(result.job.platform, 'qq');
  assert.deepEqual(f.profiles.claude.qq.calls.at(-1), ['request', '/v1/poll', { tabId: 7 }]);
});

test('disabling refuses unfinished tasks and deliveries before disconnecting', async () => {
  for (const pending of [{ jobs: [{ state: 'queued' }] }, { jobs: [{ state: 'running' }] }, { delivery: [{ state: 'pending' }] }, { activeJobCount: 1 }]) {
    const f = await fixture(); Object.assign(f.profiles.chatgpt.qq.state, pending);
    await assert.rejects(f.router.request('/v1/assistant', { assistant: 'chatgpt', enabled: false }), error => error.status === 409);
    assert.equal(f.profiles.chatgpt.qq.calls.some(call => call[0] === 'deactivate'), false);
    assert.deepEqual(f.writes, []);
  }
});

test('new work racing deactivation restores the source without disabling the other assistant', async () => {
  const f = await fixture({ enabled: { claude: true } }); const source = f.profiles.chatgpt.qq;
  source.engine.deactivate = async () => { source.engine.enabled = false; source.state.jobs.push({ state: 'queued' }); };
  await assert.rejects(f.router.request('/v1/assistant', { assistant: 'chatgpt', enabled: false }), /收到新消息/);
  assert.equal(f.routers.chatgpt.enabled, true); assert.equal(source.engine.enabled, true);
  assert.equal(f.profiles.claude.qq.engine.enabled, true); assert.deepEqual(f.writes, []);
});

test('failed enable persistence leaves a disabled profile disconnected and failed disable restores its source', async () => {
  const f = await fixture({ writeEnabled: async () => { throw new Error('disk full'); } });
  await assert.rejects(f.router.request('/v1/assistant', { assistant: 'claude', enabled: true }), /disk full/);
  assert.equal(f.profiles.claude.qq.engine.enabled, false); assert.equal(f.routers.claude.enabled, false);
  await assert.rejects(f.router.request('/v1/assistant', { assistant: 'chatgpt', enabled: false }), /disk full/);
  assert.equal(f.profiles.chatgpt.qq.engine.enabled, true); assert.equal(f.routers.chatgpt.enabled, true);
});

test('duplicate bot guard includes saved inactive accounts and never writes their credentials', async () => {
  const f = await fixture();
  await f.router.request('/v1/platform', { assistant: 'claude', platform: 'feishu' });
  await assert.rejects(f.router.request('/v1/config', { assistant: 'claude', platform: 'feishu', appId: ' chatgpt-feishu ', appSecret: 'never-write' }), error => error.status === 409);
  assert.equal(f.profiles.claude.feishu.calls.some(call => call[1] === '/v1/config'), false);
  await assert.rejects(fixture({ beforeInit(profiles) { profiles.claude.feishu.engine.config.appId = profiles.chatgpt.feishu.engine.config.appId; } }), error => error.status === 409);
});

test('concurrent config reservation rejects duplicate App IDs while unrelated assistant requests and ticks continue', { timeout: 3000 }, async () => {
  const f = await fixture({ enabled: { claude: true } }); const saving = deferred(); const entered = deferred();
  const original = f.profiles.chatgpt.qq.engine.request;
  f.profiles.chatgpt.qq.engine.request = async function(route, body) {
    if (route === '/v1/config') { entered.resolve(); await saving.promise; }
    return original.call(this, route, body);
  };
  const pending = f.router.request('/v1/config', { assistant: 'chatgpt', platform: 'qq', appId: 'shared-new-app' });
  await entered.promise;
  await assert.rejects(f.router.request('/v1/config', { assistant: 'claude', platform: 'qq', appId: 'shared-new-app' }), error => error.status === 409);
  assert.equal((await f.router.request('/v1/poll', { assistant: 'claude', platform: 'qq' })).job.assistant, 'claude');
  assert.equal((await f.router.request('/v1/status', { assistant: 'claude' })).assistant, 'claude');
  assert.equal(await f.router.tick('claude'), true);
  saving.resolve(); await pending;
  await f.router.request('/v1/config', { assistant: 'claude', platform: 'qq', appId: 'different-app' });
});

test('all assistant pairs reject duplicate saved and newly configured bots even when disabled or on an inactive platform', async () => {
  for (const platform of ['qq', 'feishu']) for (const owner of ASSISTANTS) for (const contender of ASSISTANTS.filter(id => id !== owner)) {
    const f = await fixture({ enabled: { chatgpt: false, claude: false, gemini: false } });
    await f.router.request('/v1/platform', { assistant: contender, platform });
    await assert.rejects(f.router.request('/v1/config', { assistant: contender, platform, appId: ` ${owner}-${platform} `, appSecret: 'never-write' }), error => error.status === 409);
    assert.equal(f.profiles[contender][platform].calls.some(call => call[1] === '/v1/config'), false);
    await assert.rejects(fixture({ beforeInit(profiles) { profiles[contender][platform].engine.config.appId = profiles[owner][platform].engine.config.appId; } }), error => error.status === 409);
  }
  const f = await fixture();
  await f.router.request('/v1/config', { assistant: 'gemini', platform: 'qq', appId: 'claude-feishu' });
  assert.equal(f.profiles.gemini.qq.engine.config.appId, 'claude-feishu', 'different platforms have separate account namespaces');
});

test('Gemini credentials reserve accounts atomically while both other assistant queues remain available', { timeout: 3000 }, async () => {
  const f = await fixture({ enabled: { claude: true, gemini: true } }); const saving = deferred(); const entered = deferred();
  const original = f.profiles.gemini.qq.engine.request;
  f.profiles.gemini.qq.engine.request = async function(route, body) {
    if (route === '/v1/config') { entered.resolve(); await saving.promise; }
    return original.call(this, route, body);
  };
  const pending = f.router.request('/v1/config', { assistant: 'gemini', platform: 'qq', appId: 'shared-new-app' });
  await entered.promise;
  for (const assistant of ['chatgpt', 'claude']) {
    await assert.rejects(f.router.request('/v1/config', { assistant, platform: 'qq', appId: 'shared-new-app' }), error => error.status === 409);
    assert.equal((await f.router.request('/v1/poll', { assistant, platform: 'qq' })).job.assistant, assistant);
    assert.equal(await f.router.tick(assistant), true);
  }
  saving.resolve(); await pending;
});

test('trusted assistant URLs reject credentials, lookalike hosts, cross-provider paths and home pages', () => {
  assert.equal(assistantId('claude'), 'claude'); assert.throws(() => assistantId('CLAUDE'));
  assert.equal(assistantForUrl('https://claude.ai/'), 'claude'); assert.equal(assistantForUrl('https://chatgpt.com/'), 'chatgpt');
  assert.equal(conversationUrl('https://claude.ai/chat/conversation-one/?x=1#part', 'claude'), 'https://claude.ai/chat/conversation-one');
  assert.equal(conversationUrl('https://chatgpt.com/g/custom/c/conversation-one/'), 'https://chatgpt.com/g/custom/c/conversation-one');
  for (const url of ['https://claude.ai.evil.test/chat/conversation-one', 'https://user@claude.ai/chat/conversation-one', 'http://claude.ai/chat/conversation-one', 'https://claude.ai:444/chat/conversation-one']) assert.equal(assistantForUrl(url), null);
  for (const url of ['https://claude.ai/', 'https://claude.ai/chat/short', 'https://claude.ai/c/conversation-one', 'https://chatgpt.com/c/conversation-one']) assert.equal(conversationUrl(url, 'claude'), null);
  assert.equal(conversationUrl('https://claude.ai/chat/conversation-one'), null);
});

test('Hark accepts only signed-in conversation routes on app.hark.com and rejects entry, auth and settings pages', () => {
  assert.equal(assistantId('hark'), 'hark');
  assert.equal(assistantForUrl('https://app.hark.com/login'), 'hark');
  // The marketing site is never a bindable assistant page.
  assert.equal(assistantForUrl('https://hark.com/'), null);
  assert.equal(conversationUrl('https://app.hark.com/chat/conversation-one/?x=1#part', 'hark'), 'https://app.hark.com/chat/conversation-one');
  assert.equal(conversationUrl('https://app.hark.com/project/project-one/message-one', 'hark'), 'https://app.hark.com/project/project-one/message-one');
  assert.equal(conversationUrl('https://app.hark.com/room/room-one', 'hark'), 'https://app.hark.com/room/room-one');
  for (const path of ['/', '/login', '/chat', '/chat/short', '/projects', '/projects/new', '/rooms', '/settings', '/settings/billing', '/plans', '/profile', '/soul', '/connect', '/docs/realtime', '/verify-age']) {
    assert.equal(conversationUrl('https://app.hark.com' + path, 'hark'), null, path);
  }
  assert.equal(conversationUrl('https://hark.com/chat/conversation-one', 'hark'), null);
  assert.equal(conversationUrl('https://app.hark.com/chat/conversation-one', 'chatgpt'), null);
  for (const value of ['https://app.hark.com.evil.test/chat/conversation-one', 'https://user@app.hark.com/chat/conversation-one', 'http://app.hark.com/chat/conversation-one', 'https://app.hark.com:444/chat/conversation-one']) assert.equal(assistantForUrl(value), null);
});

test('Gemini accepts only existing canonical conversations on its exact HTTPS origin, including account-scoped URLs', () => {
  assert.equal(assistantId('gemini'), 'gemini');
  assert.equal(assistantForUrl('https://gemini.google.com/app'), 'gemini');
  for (const path of ['/app/123456abcdef', '/u/0/app/abcdef01', '/u/12/app/conversation-id_1']) {
    assert.equal(conversationUrl(`https://gemini.google.com${path}/?hl=en#response`, 'gemini'), `https://gemini.google.com${path}`);
    assert.equal(conversationUrl(`https://gemini.google.com${path}`, 'chatgpt'), null);
    assert.equal(conversationUrl(`https://gemini.google.com${path}`, 'claude'), null);
  }
  for (const value of ['https://gemini.google.com.evil.test/app/abcdefgh', 'https://user:pass@gemini.google.com/app/abcdefgh', 'http://gemini.google.com/app/abcdefgh', 'https://gemini.google.com:444/app/abcdefgh', 'https://aistudio.google.com/app/abcdefgh']) assert.equal(assistantForUrl(value), null);
  for (const path of ['/', '/app', '/app/short', '/share/123456abcdef', '/u/a/app/123456abcdef', '/u/-1/app/123456abcdef', '/u/0/app', '/foo/app/123456abcdef', '/app/abcdefgh/more', '/chat/123456abcdef', '/app/abc%2Fdefghi']) assert.equal(conversationUrl(`https://gemini.google.com${path}`, 'gemini'), null);
});

class MemoryStorage {
  state = null;
  async readState() { return structuredClone(this.state); }
  async listImageKeys() { return []; }
  async commit({ expectedRevision, state }) {
    assert.equal(this.state?.revision ?? 0, expectedRevision);
    this.state = { ...structuredClone(state), revision: expectedRevision + 1 }; return this.state.revision;
  }
}
for (const [platform, Store, chatId] of [['qq', QQStore, 'QQ_TEST_GROUP'], ['feishu', FeishuStore, 'oc_test_group']]) for (const assistant of ['claude', 'gemini', 'qwen']) {
  const ownUrl = assistant === 'qwen' ? 'https://chat.qwen.ai/c/qwen-conversation' : assistant === 'gemini' ? 'https://gemini.google.com/u/2/app/gemini-conversation' : 'https://claude.ai/chat/claude-conversation';
  const domain = new RegExp(assistant === 'qwen' ? 'chat.qwen.ai' : assistant === 'gemini' ? 'gemini.google.com' : 'claude.ai');
  test(`${platform} ${assistant} stores own provider URLs through binding, polling and lease commits`, async () => {
    const store = await Store.open({ storage: new MemoryStorage(), assistant, moderate: () => ({ blocked: false }) });
    const caller = { chatId, browserId: 'browser', tabId: 7, conversationUrl: ownUrl, capabilities: ['image-input-v1'] };
    const wrong = { ...caller, conversationUrl: 'https://chatgpt.com/c/claude-conversation' };
    await assert.rejects(store.bind(wrong), domain);
    await store.bind(caller);
    await store.ingest({ messageId: 'message-1', chatId, text: 'hello', createdAt: Date.now() });
    await assert.rejects(store.poll(wrong), domain);
    const { job } = await store.poll(caller); assert.ok(job);
    await assert.rejects(store.started(job.id, { ...wrong, leaseToken: job.leaseToken }), domain);
    await store.started(job.id, { ...caller, leaseToken: job.leaseToken });
    await assert.rejects(store.result(job.id, { ...wrong, leaseToken: job.leaseToken, text: 'wrong' }), domain);
    await store.result(job.id, { ...caller, leaseToken: job.leaseToken, text: 'right' });
    const legacy = await Store.open({ storage: new MemoryStorage() });
    await assert.rejects(legacy.bind(caller), /chatgpt.com/);
  });

  test(`${platform} ${assistant} moderation notices identify the correct assistant`, async () => {
    const store = await Store.open({ storage: new MemoryStorage(), assistant, moderate: () => ({ blocked: true, reason: 'keyword' }) });
    await store.ingest({ messageId: 'blocked-message', chatId, text: 'blocked text', createdAt: Date.now() });
    const reply = await store.nextReply(); assert.match(reply.text, new RegExp({ qwen: 'Qwen', gemini: 'Gemini', hark: 'Hark' }[assistant] || 'Claude')); assert.doesNotMatch(reply.text, /ChatGPT/);
  });
}

test('standalone store defaults preserve legacy storage names and keep new Gemini databases separate from Claude', async () => {
  const original = IndexedDBStorage.open; const names = [];
  IndexedDBStorage.open = async name => { names.push(name); return new MemoryStorage(); };
  try {
    for (const Store of [QQStore, FeishuStore]) for (const assistant of ASSISTANTS) await Store.open({ assistant });
    assert.deepEqual(names, [undefined, 'chatgpt-bot-bridge-claude-qq', 'chatgpt-bot-bridge-gemini-qq', 'chatgpt-bot-bridge-qwen-qq', 'chatgpt-bot-bridge-hark-qq', undefined, 'chatgpt-bot-bridge-claude-feishu', 'chatgpt-bot-bridge-gemini-feishu', 'chatgpt-bot-bridge-qwen-feishu', 'chatgpt-bot-bridge-hark-feishu']);
  } finally { IndexedDBStorage.open = original; }
});

for (const selected of ['qq', 'feishu']) {
  test(`${selected} assistants isolate real queues, leases and replies while the other assistant has a slow delivery`, { timeout: 3000 }, async () => {
    const routers = {}; const profiles = {}; const outgoing = []; const sending = deferred(); const entered = deferred();
    for (const assistant of ASSISTANTS) {
      const engines = {}; profiles[assistant] = {};
      for (const [platform, Store, Engine] of [['qq', QQStore, QQEngine], ['feishu', FeishuStore, FeishuEngine]]) {
        let saved = { appId: platform === 'qq' ? ({ chatgpt: '123456789', claude: '987654321', gemini: '111222333', qwen: '444555666', hark: '777888999' })[assistant] : `cli_${assistant}`, appSecret: `${assistant}-${platform}-test-secret` };
        let filter = createWordFilter(['initial blocked']);
        const store = await Store.open({ storage: new MemoryStorage(), assistant, moderate: prompt => filter(prompt) });
        const profile = { callbacks: [], saved: () => saved, caller: {
          chatId: platform === 'qq' ? 'QQ_SAME_GROUP' : 'oc_same_group', browserId: 'browser', tabId: 8 + ASSISTANTS.indexOf(assistant),
          conversationUrl: ({ chatgpt: 'https://chatgpt.com/c/independent-conversation', claude: 'https://claude.ai/chat/independent-conversation', gemini: 'https://gemini.google.com/app/independent-conversation', qwen: 'https://chat.qwen.ai/c/independent-conversation', hark: 'https://app.hark.com/chat/independent-conversation' })[assistant], capabilities: ['image-input-v1'],
        } };
        engines[platform] = new Engine({ store, readConfig: async () => saved, writeConfig: async value => { saved = structuredClone(value); },
          defaultWords: ['initial blocked'], setWords: words => { filter = createWordFilter(words); },
          adapterFactory: options => {
            profile.callbacks.push(options);
            return {
              async start() { options.onState({ state: 'connected' }); }, async stop() {},
              async createCard() { return { messageId: `card-${assistant}` }; }, async updateCard() {},
              async replyPost(...args) {
                outgoing.push({ assistant, platform, args });
                if (assistant === 'chatgpt') { entered.resolve(); await sending.promise; }
              },
            };
          },
        });
        profiles[assistant][platform] = profile;
      }
      routers[assistant] = new PlatformRouter({ engines, readSelection: async () => selected, writeSelection: async () => {} });
    }
    const router = new AssistantRouter({ routers, readEnabled: async () => true });
    await router.init();
    for (const assistant of ASSISTANTS) {
      await routers[assistant].engines[selected].connecting;
      const profile = profiles[assistant][selected]; const envelope = { assistant, platform: selected, ...profile.caller };
      await router.request('/v1/bind', envelope);
      await router.request('/v1/moderation', { assistant, platform: selected, words: [`${assistant} forbidden`] });
      await profile.callbacks.at(-1).onMessage({ messageId: 'same-message', chatId: profile.caller.chatId, text: `${assistant} question`, createdAt: Date.now() });
      const { job } = await router.request('/v1/poll', envelope);
      assert.equal(job.assistant, assistant); assert.equal(job.platform, selected); assert.equal(job.prompt, `${assistant} question`);
      const auth = { ...envelope, leaseToken: job.leaseToken };
      await router.request(`/v1/jobs/${job.id}/started`, auth);
      const other = assistant === 'chatgpt' ? 'claude' : 'chatgpt';
      await assert.rejects(router.request(`/v1/jobs/${job.id}/result`, { ...auth, assistant: other, ...profiles[other][selected].caller, text: 'misdirected result' }));
      await router.request(`/v1/jobs/${job.id}/result`, { ...auth, text: `${assistant} final answer` });
    }
    const slow = (async () => { for (let i = 0; i < 6; i++) await router.tick('chatgpt'); })(); await entered.promise;
    for (const assistant of ['claude', 'gemini', 'qwen', 'hark']) for (let i = 0; i < 6; i++) await router.tick(assistant);
    assert.equal((await router.request('/v1/status', { assistant: 'claude' })).jobs[0].state, 'completed');
    assert.ok((await routers.chatgpt.engines[selected].store.status()).delivery.length > 0);
    assert.equal(outgoing.length, 5);
    for (const assistant of ASSISTANTS) {
      const reply = JSON.stringify(outgoing.find(item => item.assistant === assistant).args);
      assert.match(reply, new RegExp(`${assistant} final answer`)); assert.doesNotMatch(reply, /misdirected result/);
      assert.deepEqual(profiles[assistant][selected].saved().words, [`${assistant} forbidden`]);
    }
    sending.resolve(); await slow;
    for (const assistant of ASSISTANTS) await router.request('/v1/assistant', { assistant, enabled: false });
  });
}

test('engine bootstrap retains legacy settings and databases, isolates three profiles, and emits only authenticated fixed work hints', async () => {
  const settings = new Map([
    ['config.qq', { appId: '123456789', appSecret: 'qq-test-fixture-secret', words: ['QQ旧词表'] }],
    ['config.feishu', { appId: 'cli_old', appSecret: 'feishu-test-fixture-secret', words: ['飞书旧词表'] }],
    ['active-platform', 'feishu'],
    ['assistant.claude.config.qq', { appId: '987654321', appSecret: 'claude-existing-fixture', words: ['Claude旧词表'] }],
    ['assistant.claude.enabled', false],
  ]);
  const names = []; const pumps = []; const hints = []; const adapters = [];
  const database = { transaction() {
    const tx = { objectStore: () => ({
      get(key) { const request = { result: structuredClone(settings.get(key)) }; queueMicrotask(() => tx.oncomplete()); return request; },
      put(value, key) { settings.set(key, structuredClone(value)); const request = { result: key }; queueMicrotask(() => tx.oncomplete()); return request; },
    }) }; return tx;
  } };
  const adapter = platform => options => {
    adapters.push({ platform, options });
    return { async start() { options.onState({ state: 'connected' }); }, async stop() {} };
  };
  const engineUrl = new URL('../extension/engine.js', import.meta.url);
  const source = (await fs.readFile(engineUrl, 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(engineUrl.href));
  const context = vm.createContext({
    URL, structuredClone, indexedDB: { open(name) { assert.equal(name, 'chatgpt-bot-bridge-settings'); const request = { result: database }; queueMicrotask(() => request.onsuccess()); return request; } },
    fetch: async () => ({ json: async () => ({ version: 1, revision: 2, words: ['默认词表', 'new preset'], updates: [{ revision: 2, words: ['new preset'] }] }) }),
    self: { addEventListener() {}, postMessage: message => hints.push(structuredClone(message)) },
    IndexedDBStorage: { async open(name) { names.push(name); return new MemoryStorage(); } },
    QQStore, FeishuStore, QQEngine, FeishuEngine, createWordFilter, upgradeWordConfig, PlatformRouter, AssistantRouter, ASSISTANTS,
    createBrowserQQAdapter: adapter('qq'), createBrowserFeishuAdapter: adapter('feishu'),
    createWorkPump(options) { const pump = { options, starts: 0, wakes: 0, start() { this.starts++; }, wake() { this.wakes++; } }; pumps.push(pump); return pump; },
  });
  vm.runInContext(source + '\nglobalThis.bootstrap = ready;', context);
  const router = await context.bootstrap;
  assert.deepEqual(names, ['chatgpt-bot-bridge-qq', 'chatgpt-bot-bridge-feishu', 'chatgpt-bot-bridge-claude-qq', 'chatgpt-bot-bridge-claude-feishu', 'chatgpt-bot-bridge-gemini-qq', 'chatgpt-bot-bridge-gemini-feishu', 'chatgpt-bot-bridge-qwen-qq', 'chatgpt-bot-bridge-qwen-feishu', 'chatgpt-bot-bridge-hark-qq', 'chatgpt-bot-bridge-hark-feishu']);
  assert.equal(router.routers.chatgpt.activePlatform, 'feishu'); assert.equal(router.routers.chatgpt.enabled, true); assert.equal(router.routers.claude.enabled, false);
  assert.deepEqual(router.routers.chatgpt.engines.feishu.config.words, ['飞书旧词表', 'new preset']);
  assert.equal(router.routers.claude.engines.qq.store.assistant, 'claude');
  assert.deepEqual(router.routers.claude.engines.qq.config.words, ['Claude旧词表', 'new preset']);
  assert.equal(router.routers.gemini.enabled, false); assert.equal(router.routers.gemini.engines.qq.store.assistant, 'gemini');
  assert.equal(adapters.length, 1); assert.equal(adapters[0].options.assistant, 'chatgpt');
  assert.deepEqual(pumps.map(pump => pump.starts), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  const previousWakes = pumps.map(pump => pump.wakes);
  router.routers.chatgpt.engines.feishu.onWork();
  assert.equal(pumps[0].wakes, previousWakes[0]); assert.equal(pumps[1].wakes, previousWakes[1] + 1);
  assert.equal(pumps[2].wakes, previousWakes[2]);
  await router.request('/v1/config', { assistant: 'gemini', platform: 'qq', appId: '111222333', appSecret: 'gemini-test-fixture-secret' });
  await router.request('/v1/moderation', { assistant: 'gemini', platform: 'qq', words: ['Gemini词表'] });
  assert.equal(settings.get('assistant.gemini.config.qq').appId, '111222333');
  assert.deepEqual(settings.get('assistant.gemini.config.qq').words, ['Gemini词表']);
  assert.deepEqual(settings.get('assistant.claude.config.qq').words, ['Claude旧词表', 'new preset']);
  assert.equal(settings.get('config.qq').appId, '123456789');
  assert.equal(adapters.length, 1);
  await router.request('/v1/assistant', { assistant: 'gemini', enabled: true });
  await router.routers.gemini.engines.qq.connecting;
  assert.equal(settings.get('assistant.gemini.enabled'), true); assert.equal(adapters.at(-1).options.assistant, 'gemini');
  await router.request('/v1/assistant', { assistant: 'gemini', enabled: false });
  await router.request('/v1/platform', { assistant: 'gemini', platform: 'feishu' });
  assert.equal(settings.get('assistant.gemini.active-platform'), 'feishu');
  assert.equal(router.routers.claude.activePlatform, 'qq');
  await router.request('/v1/config', { assistant: 'claude', platform: 'qq', appId: '987654321', appSecret: 'claude-test-fixture-secret' });
  assert.equal(settings.get('assistant.claude.config.qq').appId, '987654321');
  assert.equal(settings.get('config.qq').appId, '123456789');
  assert.equal(adapters.length, 2);
  await router.request('/v1/assistant', { assistant: 'claude', enabled: true });
  await router.routers.claude.engines.qq.connecting;
  assert.equal(settings.get('assistant.claude.enabled'), true); assert.equal(adapters.at(-1).options.assistant, 'claude');
  await router.request('/v1/assistant', { assistant: 'claude', enabled: false });
  await router.request('/v1/platform', { assistant: 'claude', platform: 'feishu' });
  assert.equal(settings.get('assistant.claude.active-platform'), 'feishu'); assert.equal(settings.get('active-platform'), 'feishu');
  assert.ok(hints.length > 0); assert.ok(hints.every(hint => JSON.stringify(hint) === '{"type":"bridge:work-available"}'));
  await router.request('/v1/assistant', { assistant: 'chatgpt', enabled: false });
  assert.equal(settings.get('assistant.chatgpt.enabled'), false);
});
