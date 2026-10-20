export const PLATFORMS = Object.freeze(['qq', 'feishu']);
function fault(message, status = 400) { return Object.assign(new Error(message), { status }); }
export function platformId(value) {
  if (!PLATFORMS.includes(value)) throw fault('请选择 QQ 或飞书平台');
  return value;
}
function unfinished(status) {
  return status.activeJobCount > 0 || (status.jobs ?? []).some(job => ['queued', 'leased', 'started', 'running', 'delivering', 'result_pending', 'pending'].includes(job.state)) ||
    (status.delivery ?? []).some(item => item.state !== 'needs_attention');
}
function sameConversation(a, b) {
  try { return new URL(a).pathname.replace(/\/+$/, '').split('/').at(-1) === new URL(b).pathname.replace(/\/+$/, '').split('/').at(-1); }
  catch { return false; }
}

// Selection is only the default settings view. Each transport has its own
// saved enable flag, store and connection, under the assistant master switch.
export class PlatformRouter {
  constructor({ engines, readSelection, writeSelection, readChannels = async () => undefined, writeChannels = async () => {}, onWork = () => {} }) {
    Object.assign(this, { engines, readSelection, writeSelection, readChannels, writeChannels, onWork });
    this.activePlatform = null; this.enabled = false; this.channels = { qq: false, feishu: false };
    this.switching = false; this.changingChannels = new Set(); this.tail = Promise.resolve();
    if (!PLATFORMS.every(platform => engines[platform])) throw fault('平台引擎配置不完整');
  }
  async init({ connect = true } = {}) {
    const stored = await this.readSelection();
    this.activePlatform = stored === undefined || stored === null ? 'qq' : platformId(stored);
    const channels = await this.readChannels();
    if (channels === undefined || channels === null) {
      this.channels = Object.fromEntries(PLATFORMS.map(id => [id, id === this.activePlatform]));
      // Persist migration before opening sockets. An old inactive account must
      // never start receiving messages just because it already has credentials.
      await this.writeChannels({ ...this.channels });
    } else {
      if (typeof channels !== 'object' || Array.isArray(channels) || !PLATFORMS.every(id => typeof channels[id] === 'boolean')) throw fault('通道启用配置无效');
      this.channels = Object.fromEntries(PLATFORMS.map(id => [id, channels[id]]));
    }
    await Promise.all(PLATFORMS.map(platform => this.engines[platform].init({ connect: false })));
    if (connect) await this.setEnabled(true);
  }
  async status(selected = this.activePlatform) {
    const platform = platformId(selected);
    const states = Object.fromEntries(await Promise.all(PLATFORMS.map(async id => [id, await this.engines[id].status()])));
    return {
      ...states[platform], enabled: this.enabled, channelEnabled: this.channels[platform], running: this.enabled && this.channels[platform],
      platform, connection: { ...states[platform][platform] },
      platforms: Object.fromEntries(PLATFORMS.map(id => [id, {
        active: id === platform, enabled: this.channels[id], running: this.enabled && this.channels[id],
        configured: Boolean(this.engines[id].config.appId && this.engines[id].config.appSecret), appId: this.engines[id].config.appId || '',
        connection: { ...states[id][id] }, groups: states[id].groups || [], queuedChatIds: states[id].queuedChatIds ||
          (states[id].jobs || []).filter(job => job.state === 'queued').map(job => job.chatId),
      }])),
    };
  }
  async setEnabled(enabled, persist = async () => {}) {
    if (typeof enabled !== 'boolean') throw fault('助手启用状态无效');
    if (enabled === this.enabled) return { ok: true, enabled, platform: this.activePlatform };
    for (const platform of PLATFORMS) {
      const engine = this.engines[platform];
      if (engine.configBusy || !enabled && unfinished(await engine.status())) throw fault('当前助手还有配置操作、生成任务或回复等待送达，请完成后再停用', 409);
    }
    this.switching = true;
    try {
      if (!enabled) {
        for (const platform of PLATFORMS) if (this.engines[platform].enabled) await this.engines[platform].deactivate();
        for (const platform of PLATFORMS) if (unfinished(await this.engines[platform].status())) throw fault('停用前收到新消息，请等当前助手的任务完成后再停用', 409);
      }
      await persist(); this.enabled = enabled;
      if (enabled) await Promise.all(PLATFORMS.filter(id => this.channels[id]).map(id => this.engines[id].activate()));
      this.onWork(); return { ok: true, enabled, platform: this.activePlatform };
    } catch (error) {
      if (this.enabled) await Promise.all(PLATFORMS.filter(id => this.channels[id] && !this.engines[id].enabled).map(id => this.engines[id].activate()));
      throw error;
    } finally { this.switching = false; }
  }
  async setChannel(value, enabled) {
    const platform = platformId(value);
    if (typeof enabled !== 'boolean') throw fault('通道启用状态无效');
    if (enabled === this.channels[platform]) return { ok: true, platform, enabled };
    const engine = this.engines[platform];
    if (engine.configBusy || !enabled && unfinished(await engine.status())) throw fault('此通道还有配置操作、生成任务或回复等待送达，请完成后再停用', 409);
    this.changingChannels.add(platform);
    try {
      if (!enabled) {
        if (engine.enabled) await engine.deactivate();
        if (unfinished(await engine.status())) throw fault('停用前收到新消息，请等此通道任务完成后再停用', 409);
      }
      const next = { ...this.channels, [platform]: enabled };
      await this.writeChannels(next); this.channels = next;
      if (enabled && this.enabled) await engine.activate();
      this.onWork(); return { ok: true, platform, enabled };
    } catch (error) {
      if (this.enabled && this.channels[platform] && !engine.enabled) await engine.activate();
      throw error;
    } finally { this.changingChannels.delete(platform); }
  }
  async switchPlatform(value) {
    const platform = platformId(value);
    if (platform !== this.activePlatform) { await this.writeSelection(platform); this.activePlatform = platform; }
    return { ok: true, platform };
  }
  request(route, body) {
    const operation = this.tail.then(() => this.dispatch(route, body));
    this.tail = operation.catch(() => {}); return operation;
  }
  async dispatch(route, body) {
    if (route === '/v1/status') return this.status(body?.platform ?? this.activePlatform);
    if (route === '/v1/platform') return this.switchPlatform(body?.platform);
    if (route === '/v1/channel') return this.setChannel(body?.platform, body?.enabled);
    const platform = platformId(body?.platform);
    if (this.switching || this.changingChannels.has(platform)) throw fault('连接正在启停，请稍后重试', 409);
    if (!/^\/v1\/(?:config|moderation|history\/clear|bind|unbind|poll|jobs\/[a-f0-9-]{36}\/(?:started|input-image|image|result|error|cancel))$/.test(route)) throw fault('不允许的平台请求', 404);
    const { platform: _platform, ...input } = body;
    if (route === '/v1/bind') {
      for (const other of PLATFORMS.filter(id => id !== platform)) {
        const status = await this.engines[other].store.status();
        if (status.groups.some(group => group.binding &&
          // 只按会话地址判重：不同群不能绑同一个对话。
          // 同一对话换标签页（重启后）仍是同一个对话，不该被当成新绑定拦下。
          sameConversation(group.binding.conversationUrl, input.conversationUrl))) {
          throw fault('这个对话或标签页已经绑定另一平台，请为 QQ 和飞书分别使用独立的助手对话与标签页', 409);
        }
      }
    }
    if (route === '/v1/config' && platform === 'qq' && Object.hasOwn(input, 'replyStyle')) throw fault('QQ 使用 Markdown 回复，不支持飞书卡片样式');
    if ((!this.enabled || !this.channels[platform]) && route === '/v1/poll') return { job: null, notice: '该助手或通道已停用' };
    if ((!this.enabled || !this.channels[platform]) && route.startsWith('/v1/jobs/') && !route.endsWith('/cancel')) throw fault('该助手或通道已停用，请启用后重新发起请求', 409);
    const data = await this.engines[platform].request(route, input);
    if (route === '/v1/poll' && data.job) return { ...data, job: { ...data.job, platform } };
    return data;
  }
  async tick(platform) {
    if (!this.enabled || this.switching) return false;
    if (platform !== undefined) {
      platformId(platform);
      return this.channels[platform] && !this.changingChannels.has(platform) ? this.engines[platform].tick() : false;
    }
    const results = await Promise.allSettled(PLATFORMS.map(id => this.tick(id)));
    return results.some(result => result.status === 'fulfilled' && result.value === true);
  }
}
