import { validateWordList } from './moderation.js';
import { BridgeError, validateReplyStyle } from './qq-store.js';

export class ExtensionEngine {
  constructor({ store, readConfig, writeConfig, adapterFactory, defaultWords, setWords, onWork = () => {} }) {
    Object.assign(this, { store, readConfig, writeConfig, adapterFactory, defaultWords, setWords, onWork });
    this.config = {}; this.adapter = null; this.qq = { state: 'stopped' };
    this.deliveryBusy = false; this.configBusy = false;
    this.connecting = null; this.enabled = false; this.connectionEpoch = 0;
    this.operations = new Set(); this.stopping = null;
  }

  async init({ connect = true } = {}) {
    this.config = await this.readConfig() ?? {};
    if (!Object.hasOwn(this.config, 'replyStyle')) this.config.replyStyle = 'separate';
    if (!Object.hasOwn(this.config, 'words')) this.config.words = this.defaultWords;
    this.setWords(this.config.words);
    await this.store.recover();
    if (connect) await this.activate();
  }

  track(work) {
    const task = Promise.resolve().then(work);
    this.operations.add(task);
    task.finally(() => this.operations.delete(task)).catch(() => {});
    return task;
  }

  wake() { if (this.enabled) { try { this.onWork(); } catch {} } }

  beginConnection(onFinished = () => {}) {
    if (!this.enabled) { onFinished(); return; }
    const task = this.connect(); this.connecting = task;
    task.finally(() => { if (this.connecting === task) this.connecting = null; onFinished(); }).catch(() => {});
  }

  async activate() {
    if (this.stopping) await this.stopping;
    if (this.enabled) return;
    this.enabled = true;
    this.beginConnection();
  }

  deactivate() {
    if (this.configBusy) return Promise.reject(new BridgeError('平台正在保存配置，请稍后再切换', 409));
    if (this.stopping) return this.stopping;
    // Revoke new callbacks and page work synchronously. Already accepted work
    // drains into this platform's own store before the router checks it.
    const previousEpoch = this.connectionEpoch;
    const previousState = this.qq;
    this.enabled = false; this.connectionEpoch++;
    const previous = this.adapter; this.adapter = null;
    const connection = this.connecting;
    this.qq = { state: 'stopped' };
    const task = (async () => {
      while (this.operations.size) await Promise.allSettled([...this.operations]);
      try {
        if (previous) await previous.stop();
      } catch {
        // The router has not switched platforms yet. Reuse the same adapter
        // on an interrupted stop; never leave the source disabled or create a
        // second adapter whose connection could overlap the failed one.
        this.enabled = true; this.connectionEpoch = previousEpoch;
        this.adapter = previous; this.qq = previousState;
        const restoring = (async () => {
          try { await previous.start(); }
          catch { if (this.enabled && this.adapter === previous) this.qq = { state: 'error', error: '原平台连接恢复失败，请检查配置后重试' }; }
        })();
        this.connecting = restoring;
        restoring.finally(() => { if (this.connecting === restoring) this.connecting = null; }).catch(() => {});
        this.wake();
        throw new BridgeError('平台连接未能安全停止，已保留原平台，请稍后重试切换', 409);
      }
      if (connection) await connection;
    })();
    this.stopping = task;
    task.finally(() => { if (this.stopping === task) this.stopping = null; }).catch(() => {});
    return task;
  }

  requireEnabled() {
    if (!this.enabled || this.stopping) throw new BridgeError('该平台已停用，请在当前平台重新发起请求', 409);
  }

  async status() {
    const words = validateWordList(this.config.words);
    return {
      enabled: this.enabled, configured: Boolean(this.config.appId && this.config.appSecret), appId: this.config.appId || '',
      replyStyle: validateReplyStyle(this.config.replyStyle ?? 'separate'),
      qq: { ...this.qq }, moderation: { valid: words.valid, count: words.valid ? words.words.length : 0, presetUpdatePending: Boolean(this.config.wordPresetUpdatePending) },
      ...(await this.store.status()),
    };
  }

  async connect() {
    const generation = ++this.connectionEpoch;
    let adapter;
    const valid = () => this.enabled && generation === this.connectionEpoch;
    try {
      const previous = this.adapter; this.adapter = null;
      if (previous) await previous.stop();
      if (!valid()) return;
      if (!this.config.appId || !this.config.appSecret) { this.qq = { state: 'stopped' }; return; }
      this.qq = { state: 'connecting' };
      adapter = this.adapterFactory({
        appId: this.config.appId, appSecret: this.config.appSecret,
        onState: state => { if (valid() && this.adapter === adapter) { this.qq = state; if (state.state === 'connected') this.wake(); } },
        onMessage: message => {
          if (!valid() || this.adapter !== adapter) return;
          const replyStyle = validateReplyStyle(this.config.replyStyle ?? 'separate');
          return this.track(async () => {
            if (!valid() || this.adapter !== adapter) return;
            const receipt = await this.store.ingest(message, { replyStyle });
            if (valid() && this.adapter === adapter) this.wake();
            return receipt;
          });
        },
      });
      this.adapter = adapter;
      await adapter.start();
    } catch {
      if (!valid() || (adapter && this.adapter !== adapter)) return;
      if (!['reconnecting', 'error'].includes(this.qq.state)) this.qq = { state: 'error', error: 'QQ连接失败，请核对应用凭据、权限、发布状态与网络。' };
    }
  }

  credentials(input) {
    if (typeof input.appId !== 'string' || !/^\d{5,30}$/.test(input.appId.trim())) throw new BridgeError('QQ App ID 应为开放平台提供的数字标识');
    const appId = input.appId.trim();
    const appSecret = typeof input.appSecret === 'string' && input.appSecret.trim() ? input.appSecret.trim() : appId === this.config.appId ? this.config.appSecret : '';
    if (!appSecret || appSecret.length > 300) throw new BridgeError('请输入有效的 App Secret');
    return { appId, appSecret };
  }

  async configure(input) {
    if (this.stopping) throw new BridgeError('平台正在切换，请稍后再保存配置', 409);
    if (this.configBusy || this.deliveryBusy) throw new BridgeError('扩展正在处理请求，请稍后再保存配置', 409);
    const next = { ...this.credentials(input), replyStyle: 'separate' };
    this.configBusy = true;
    let stopped = false;
    try {
      // Revoke the old callback before draining it. Events received while a
      // save is awaiting storage must not migrate from one app to another.
      this.connectionEpoch++;
      const previous = this.adapter; this.adapter = null;
      if (previous) await previous.stop();
      stopped = true; this.qq = { state: 'stopped' };
      await this.connecting;
      while (this.operations.size) await Promise.allSettled([...this.operations]);
      const status = await this.store.status();
      if (this.config.appId && next.appId !== this.config.appId && (status.groups.length || status.jobs.length || status.delivery.length)) throw new BridgeError('已有群与任务属于原应用，请勿切换到其他QQ应用', 409);
      const updated = { ...this.config, ...next };
      await this.writeConfig(updated); this.config = updated;
      this.beginConnection(() => { this.configBusy = false; });
      return { ok: true };
    } catch (error) {
      this.configBusy = false;
      if (stopped) this.beginConnection();
      throw error;
    }
  }

  words() {
    const checked = validateWordList(this.config.words);
    return { words: checked.valid ? checked.words : [], valid: checked.valid };
  }

  async saveWords(input) {
    if (this.stopping) throw new BridgeError('平台正在切换，请稍后再保存词表', 409);
    if (this.configBusy) throw new BridgeError('应用配置正在更新，请稍后再保存词表', 409);
    const checked = validateWordList(input.words);
    if (!checked.valid) throw new BridgeError('词表格式无效，请填写至少一条词语，并检查词条数量与长度');
    this.configBusy = true;
    try {
      const next = { ...this.config, words: checked.words };
      await this.writeConfig(next); this.config = next; this.setWords(checked.words);
      await this.store.sweep(); this.wake();
      return { ok: true, count: checked.words.length };
    } finally { this.configBusy = false; }
  }

  tick() {
    if (!this.enabled || this.deliveryBusy || this.configBusy) return Promise.resolve(false);
    this.deliveryBusy = true;
    return this.track(async () => {
      await this.store.sweep(); // Expire work even while this platform is offline.
      if (!this.enabled || this.qq.state !== 'connected' || !this.adapter) return false;
      return this.deliverNext(this.adapter);
    }).finally(() => { this.deliveryBusy = false; });
  }

  async deliverNext(adapter) {
    const item = await this.store.nextReply();
    // Finished answers take priority over downloading another question's images.
    const inputImage = item ? null : await this.store.nextInputImage();
    if (!item && !inputImage) return false;
    if (inputImage) {
      try {
        const downloaded = await adapter.downloadImage({ imageKey: inputImage.imageKey });
        await this.store.inputImageDownloaded(inputImage, downloaded);
      } catch (error) { await this.store.inputImageFailed(inputImage, { retryable: error?.retryable !== false && !(error instanceof BridgeError) }); }
      return true;
    }
    try {
      await this.store.deliveryStarted(item.id);
      if (item.kind === 'post') {
        await adapter.replyPost({ chatId: item.chatId, messageId: item.messageId, post: item.post, msgSeq: item.msgSeq, expiresAt: item.expiresAt });
        await this.store.replySent(item.id);
      } else if (item.kind === 'image') {
        if (!item.imageKey) {
          const receipt = await adapter.uploadImage({ chatId: item.chatId, expiresAt: item.expiresAt, buffer: await this.store.imageBuffer(item), mimeType: item.image.mimeType });
          await this.store.imageUploaded(item.id, receipt.imageKey, receipt.ttl);
        } else {
          await adapter.replyImage({ chatId: item.chatId, messageId: item.messageId, imageKey: item.imageKey, msgSeq: item.msgSeq, expiresAt: item.expiresAt });
          await this.store.replySent(item.id);
        }
      } else {
        await adapter.reply({ chatId: item.chatId, messageId: item.messageId, text: item.text, msgSeq: item.msgSeq, expiresAt: item.expiresAt });
        await this.store.replySent(item.id);
      }
    } catch (error) {
      if (item.kind === 'image' && error?.retryable === false) await this.store.imageReplyRejected(item.id);
      else if (item.kind === 'post' && error?.retryable === false) await this.store.postReplyRejected(item.id);
      else if (error?.retryable === false) await this.store.replyRejected(item.id);
      else await this.store.replyFailed(item.id, item.revision);
    }
    return true;
  }

  async request(route, body = {}) {
    switch (route) {
      case '/v1/status': return this.status();
      case '/v1/history/clear':
        if (this.stopping || this.configBusy) throw new BridgeError('配置正在更新，请稍后再清除记录', 409);
        return this.track(() => this.store.clearHistory());
      case '/v1/config': return this.configure(body);
      case '/v1/moderation': return Object.hasOwn(body, 'words') ? this.saveWords(body) : this.words();
      case '/v1/bind':
      case '/v1/unbind':
        if (this.configBusy) throw new BridgeError('应用配置正在更新，请稍后再修改群绑定', 409);
        return route === '/v1/bind' ? this.store.bind(body) : this.store.unbind(body);
      case '/v1/poll':
        if (!this.enabled) return { job: null, notice: '该平台已停用' };
        return this.track(() => { this.requireEnabled(); return this.store.poll(body); });
      default: {
        const match = /^\/v1\/jobs\/([a-f0-9-]{36})\/(started|input-image|image|result|error|cancel)$/.exec(route);
        if (!match) throw new BridgeError('不允许的扩展请求', 404);
        if (match[2] === 'cancel') return this.track(async () => {
          const receipt = await this.store.cancel(match[1]);
          this.wake();
          return receipt;
        });
        this.requireEnabled();
        return this.track(async () => {
          this.requireEnabled();
          const receipt = await this.store[match[2] === 'input-image' ? 'inputImage' : match[2]](match[1], body);
          if (['result', 'error'].includes(match[2])) this.wake();
          return receipt;
        });
      }
    }
  }
}
