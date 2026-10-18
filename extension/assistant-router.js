import { ASSISTANTS, assistantId } from './shared.js';
import { PLATFORMS, platformId } from './platform-router.js';

function fault(message, status = 400) { return Object.assign(new Error(message), { status }); }

/** Each assistant owns a platform router and request queue; each transport has its own work pump. Only a
 * short synchronous account reservation is shared between the profiles. */
export class AssistantRouter {
  constructor({ routers, readEnabled = async () => undefined, writeEnabled = async () => {} }) {
    if (!ASSISTANTS.every(id => routers?.[id])) throw fault('助手引擎配置不完整');
    this.routers = routers; this.readEnabled = readEnabled; this.writeEnabled = writeEnabled;
    this.tails = Object.fromEntries(ASSISTANTS.map(id => [id, Promise.resolve()]));
    this.accounts = new Map();
  }

  async init() {
    const preferences = await Promise.all(ASSISTANTS.map(async id => {
      const enabled = await this.readEnabled(id);
      if (enabled !== undefined && enabled !== null && typeof enabled !== 'boolean') throw fault('助手启用配置无效');
      await this.routers[id].init({ connect: false });
      return enabled ?? id === 'chatgpt';
    }));
    // Load every saved account before starting transports. Disabled profiles
    // and inactive platforms still reserve their own bot identity.
    for (const platform of PLATFORMS) {
      const owners = new Set();
      for (const assistant of ASSISTANTS) {
        const appId = this.routers[assistant].engines[platform].config.appId?.trim();
        if (!appId) continue;
        if (owners.has(appId)) throw fault('不同 AI 助手不能使用同一个平台机器人，请分别配置不同的 App ID', 409);
        owners.add(appId);
      }
    }
    await Promise.all(ASSISTANTS.map((id, index) => this.routers[id].setEnabled(preferences[index])));
  }

  summary(id) {
    const router = this.routers[id]; const platform = router.activePlatform;
    const engine = router.engines[platform];
    return {
      enabled: router.enabled, platform,
      platforms: Object.fromEntries(PLATFORMS.map(id => [id, {
        enabled: router.channels[id], running: router.enabled && router.channels[id],
        configured: Boolean(router.engines[id].config.appId && router.engines[id].config.appSecret),
        connection: { state: router.engines[id][id]?.state ?? 'stopped' },
      }])),
      connection: { state: engine[platform]?.state ?? 'stopped' },
      configured: Boolean(engine.config.appId && engine.config.appSecret), appId: engine.config.appId || '',
    };
  }

  async status(id = 'chatgpt', platform) {
    const assistant = assistantId(id);
    const state = await this.routers[assistant].status(platform);
    return {
      ...state, assistant, enabled: this.routers[assistant].enabled,
      assistants: Object.fromEntries(ASSISTANTS.map(id => [id, this.summary(id)])),
    };
  }

  request(route, body = {}) {
    let assistant;
    try { assistant = assistantId(route === '/v1/status' && body?.assistant === undefined ? 'chatgpt' : body?.assistant); }
    catch (error) { return Promise.reject(error); }
    const operation = this.tails[assistant].then(() => this.dispatch(assistant, route, body));
    this.tails[assistant] = operation.catch(() => {});
    return operation;
  }

  async dispatch(assistant, route, body) {
    const router = this.routers[assistant];
    if (route === '/v1/status') return this.status(assistant, body.platform);
    if (route === '/v1/assistant') {
      const result = await router.setEnabled(body.enabled, () => this.writeEnabled(assistant, body.enabled));
      return { ...result, assistant };
    }
    const { assistant: _assistant, ...input } = body;
    let reservation;
    if (route === '/v1/config') {
      const platform = platformId(input.platform);
      const appId = typeof input.appId === 'string' ? input.appId.trim() : '';
      if (appId) {
        const owned = ASSISTANTS.some(id => id !== assistant && this.routers[id].engines[platform].config.appId?.trim() === appId);
        reservation = `${platform}:${appId}`;
        if (owned || this.accounts.has(reservation)) throw fault('这个平台机器人已经属于另一助手，请为不同 AI 助手使用不同的 App ID', 409);
        // No await between checking and reserving: simultaneous saves cannot
        // both pass while an asynchronous credential write is still pending.
        this.accounts.set(reservation, assistant);
      }
    }
    try {
      const data = await router.request(route, input);
      if (route === '/v1/poll' && data.job) return { ...data, job: { ...data.job, assistant, platform: input.platform } };
      return data;
    } finally {
      if (reservation) this.accounts.delete(reservation);
    }
  }

  tick(id, platform) { return this.routers[assistantId(id)].tick(platform); }
}
