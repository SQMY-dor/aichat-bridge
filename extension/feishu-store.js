import { clearableHistoryIds } from './history.js';
import { IndexedDBStorage } from './storage.js';
import { ASSISTANT_NAMES, assistantId, conversationUrl, resultTiming } from './shared.js';
import { buildAnswerPosts } from './answer-post.js';

export class BridgeError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'BridgeError'; this.status = status; }
}
export function validateReplyStyle(value) {
  if (!['separate', 'card'].includes(value)) throw new BridgeError('回复方式无效，请选择独立正文或完整卡片');
  return value;
}
export const IMAGE_MAX_BYTES = 10_000_000;
export const IMAGE_TOTAL_BYTES = 30_000_000;
export const IMAGE_MAX_COUNT = 4;
const ACTIVE = new Set(['queued', 'leased', 'running']);
const DAY = 86_400_000;
const GENERATION_TIMEOUT = 10 * 60_000;
const RETRY_WINDOW = 45 * 60_000;
const TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });
const PUBLIC_METHODS = ['clearHistory', 'ingest', 'cancel', 'poll', 'started', 'inputImage', 'image', 'result', 'error', 'bind', 'unbind', 'status', 'nextReply', 'cardCreated', 'cardUpdated', 'replySent', 'replyFailed', 'nextInputImage', 'inputImageDownloaded', 'inputImageFailed', 'imageBuffer', 'imageUploaded', 'imageReplyRejected', 'postReplyRejected', 'sweep', 'recover', 'importBindings'];
const MODERATION_MESSAGES = Object.freeze({
  keyword: '已拦截：这条消息触发本群关键词限制，未发送到 ChatGPT。请换一个合适的问题。',
  configuration: '已停止：扩展关键词过滤配置不可用，暂不向 ChatGPT 发送问题。请管理员检查扩展词表。',
});
function moderationMessage(decision, assistant) { return (MODERATION_MESSAGES[decision.reason] ?? MODERATION_MESSAGES.configuration).replaceAll('ChatGPT', ASSISTANT_NAMES[assistant]); }
function emptyState() { return { version: 1, revision: 0, groups: {}, jobs: [], seen: {}, outbox: [] }; }
function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new BridgeError(`${label}不能为空，且不能超过 ${max} 字符`);
  return value.trim();
}
function chatId(value) {
  const id = text(value, '飞书群 ID', 100);
  if (!/^oc_[A-Za-z0-9_-]+$/.test(id)) throw new BridgeError('飞书群 ID 应以 oc_ 开头');
  return id;
}
function identity(input, assistant) {
  if (!input || typeof input !== 'object') throw new BridgeError('浏览器身份无效');
  const browserId = text(input.browserId, '浏览器标识', 100);
  if (!Number.isSafeInteger(input.tabId) || input.tabId < 0) throw new BridgeError('标签页 ID 无效');
  const url = conversationUrl(input.conversationUrl, assistant);
  if (!url) throw new BridgeError(`请绑定已经创建的 ${({ chatgpt: 'chatgpt.com/c/…', claude: 'claude.ai/chat/…', gemini: 'gemini.google.com/app/…', qwen: 'chat.qwen.ai/c/…' })[assistant]} 对话，不能绑定首页或其他助手页面`);
  return { browserId, tabId: input.tabId, conversationUrl: url };
}
function sameIdentity(a, b) { return !!a && !!b && a.browserId === b.browserId && a.tabId === b.tabId && a.conversationUrl === b.conversationUrl; }
function randomHex(bytes) { return [...crypto.getRandomValues(new Uint8Array(bytes))].map(value => value.toString(16).padStart(2, '0')).join(''); }
function mediaKey(kind, jobId, imageId) {
  if (!['input', 'output'].includes(kind) || !/^[a-f0-9-]{36}$/.test(jobId) || !/^[a-f0-9]{64}$/.test(imageId)) throw new BridgeError('扩展图片标识无效');
  return `${kind}:${jobId}:${imageId}`;
}
function retainedImages(state) {
  const keys = new Set();
  for (const job of state.jobs) {
    if (ACTIVE.has(job.state)) for (const image of job.inputImages ?? []) keys.add(mediaKey('input', job.id, image.id));
    for (const image of job.uploads ?? []) keys.add(mediaKey('output', job.id, image.id));
  }
  for (const item of state.outbox) if (item.kind === 'image') keys.add(mediaKey('output', item.jobId, item.image.id));
  return keys;
}
function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}
async function prepareImage({ buffer, blob, base64, mimeType } = {}) {
  const extension = TYPES[mimeType];
  if (!extension) throw new BridgeError('图片仅支持 PNG、JPEG 和 WebP');
  let bytes;
  if (base64 !== undefined) {
    if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new BridgeError('图片编码无效或超过 10 MB');
    try { bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0)); } catch { throw new BridgeError('图片编码无效'); }
    if (encodeBase64(bytes) !== base64) throw new BridgeError('图片编码无效');
  } else {
    const input = buffer ?? blob;
    if (input instanceof Blob) {
      if (input.size > IMAGE_MAX_BYTES) throw new BridgeError('图片超过 10 MB');
      bytes = new Uint8Array(await input.arrayBuffer());
    } else if (input instanceof Uint8Array) {
      if (input.byteLength > IMAGE_MAX_BYTES) throw new BridgeError('图片超过 10 MB');
      bytes = new Uint8Array(input);
    } else if (input instanceof ArrayBuffer) {
      if (input.byteLength > IMAGE_MAX_BYTES) throw new BridgeError('图片超过 10 MB');
      bytes = new Uint8Array(input.slice(0));
    }
    else throw new BridgeError('图片必须是浏览器二进制数据');
  }
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) throw new BridgeError('图片内容为空或超过 10 MB');
  const matches = mimeType === 'image/png'
    ? bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    : mimeType === 'image/jpeg'
      ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
  if (!matches) throw new BridgeError('图片内容与声明格式不一致');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const id = [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
  return { id, extension, buffer: bytes, blob: new Blob([bytes], { type: mimeType }), mimeType, bytes: bytes.length };
}
function permanentImage(message, code) { return Object.assign(new BridgeError(message), { code, retryable: false }); }

export class BridgeStore {
  static async open({ storage, assistant = 'chatgpt', now = Date.now, moderate = () => ({ blocked: true, reason: 'configuration' }) } = {}) {
    assistantId(assistant);
    const store = new BridgeStore({ storage: storage ?? await IndexedDBStorage.open(assistant === 'chatgpt' ? undefined : `chatgpt-bot-bridge-${assistant}-feishu`), assistant, now, moderate });
    await store.refresh();
    return store;
  }

  constructor({ storage, assistant = 'chatgpt', now = Date.now, moderate = () => ({ blocked: true, reason: 'configuration' }) } = {}) {
    if (!storage || typeof moderate !== 'function' || typeof now !== 'function') throw new BridgeError('扩展队列配置无效');
    this.storage = storage; this.now = now; this.moderate = moderate; this.assistant = assistantId(assistant); this.assistantName = ASSISTANT_NAMES[assistant];
    this.data = emptyState(); this.tail = Promise.resolve();
    // All public operations share one serial chain. IndexedDB revision checks
    // also prevent a second extension context from overwriting a newer state.
    for (const name of PUBLIC_METHODS) {
      const method = this[name].bind(this);
      this[name] = (...args) => this.run(() => method(...args));
    }
  }

  async refresh() {
    const state = await this.storage.readState();
    this.data = state ?? emptyState();
    if (this.data.version !== 1 || !Number.isSafeInteger(this.data.revision) || this.data.revision < 0 || !this.data.groups || !Array.isArray(this.data.jobs) || !this.data.seen || !Array.isArray(this.data.outbox)) throw new BridgeError('扩展队列状态损坏或版本不兼容，已停止以避免重复发送', 409);
  }

  run(operation) {
    const pending = this.tail.then(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.refresh();
        try { return await operation(); }
        catch (error) { if (error?.code !== 'storage_conflict' || attempt === 3) throw error; }
      }
    });
    this.tail = pending.catch(() => {});
    return pending;
  }

  async commit(change, { putImages = [], deleteImages = [] } = {}) {
    const next = structuredClone(this.data);
    const result = change(next);
    const retained = retainedImages(next);
    const remove = new Set([...deleteImages, ...[...retainedImages(this.data)].filter(key => !retained.has(key))]);
    if (putImages.some(image => !retained.has(image.key))) throw new BridgeError('图片与当前任务状态不匹配，未保存', 409);
    const revision = await this.storage.commit({ expectedRevision: this.data.revision, state: next, putImages, deleteImages: [...remove] });
    this.data = { ...next, revision };
    return result;
  }

  addReply(state, messageId, chat, body, id = crypto.randomUUID()) {
    state.outbox.push({ id, messageId, chatId: chat, text: body, createdAt: this.now(), attempts: 0, nextAttemptAt: this.now() });
  }

  queueCard(state, job, body = '') {
    job.cardRevision = (job.cardRevision ?? 0) + 1;
    let item = state.outbox.find(o => o.id === job.id);
    if (!item) {
      item = {
        id: job.id, kind: 'card', messageId: job.messageId, chatId: job.chatId,
        // Creation retries share the original deadline and UUID, even if the
        // answer arrives while the first send is still unconfirmed.
        createdAt: job.cardMessageId ? this.now() : job.createdAt,
        attempts: 0, nextAttemptAt: this.now(),
      };
      state.outbox.push(item);
    }
    // A known card can safely receive a new PATCH after an older revision
    // exhausted retries. Never extend the UUID window for card creation.
    if (item.abandoned && job.cardMessageId) {
      delete item.abandoned; delete item.error;
      item.attempts = 0; item.createdAt = this.now(); item.nextAttemptAt = this.now();
    }
    Object.assign(item, {
      state: job.blocked ? 'blocked' : job.replyStyle === 'separate' && job.state === 'completed'
        ? job.answerDelivery?.state === 'sent' ? 'completed' : job.answerDelivery?.state === 'failed' ? 'failed' : 'sending'
        : job.state,
      text: body, revision: job.cardRevision,
      ...(job.cardMessageId ? { cardMessageId: job.cardMessageId } : {}),
    });
  }

  queueJobReply(state, job, body) {
    if (job.replyKind === 'card') this.queueCard(state, job, body);
    else this.addReply(state, job.messageId, job.chatId, body, job.id);
  }

  finishSeparateDelivery(state, job) {
    if (!job || job.replyStyle !== 'separate' || job.state !== 'completed' || !job.answerDelivery) return;
    if (state.outbox.some(item => item.jobId === job.id && ['post', 'image'].includes(item.kind) && !item.abandoned)) return;
    const delivery = job.answerDelivery;
    const failed = delivery.failed || delivery.sentPosts !== delivery.posts || delivery.sentImages !== delivery.images;
    const next = failed ? 'failed' : 'sent';
    if (delivery.state === next) return;
    delivery.state = next;
    const body = failed
      ? '正文或图片未能全部送达，请检查扩展中的投递状态。'
      : delivery.posts && delivery.images ? '正文和图片已发送，请查看独立回复。'
        : delivery.posts ? '正文已发送，请查看独立回复。' : '图片已发送，请查看独立回复。';
    this.queueCard(state, job, body);
  }

  failJob(state, job, reason) {
    job.state = 'failed'; job.error = reason; job.finishedAt = this.now();
    delete job.prompt; delete job.uploads; delete job.imageRefs; delete job.inputImages;
    this.queueJobReply(state, job, `网页桥接未完成：${reason}\n本次不会自动重新向 ${this.assistantName} 提问。检查网页后可重新 @机器人。`);
  }

  checkModeration(prompt) {
    try {
      const decision = this.moderate(prompt);
      if (decision?.blocked === false) return { blocked: false };
      if (decision?.blocked === true && decision.reason === 'keyword') return decision;
    } catch { /* An unavailable filter must not authorize a webpage send. */ }
    return { blocked: true, reason: 'configuration' };
  }

  blockJob(state, job, decision) {
    job.state = 'failed'; job.blocked = true; job.error = moderationMessage(decision, this.assistant); job.finishedAt = this.now();
    delete job.prompt; delete job.uploads; delete job.imageRefs; delete job.inputImages;
    this.queueJobReply(state, job, job.error);
  }

  async blockQueuedJobs(chat) {
    const rejected = new Map();
    for (const job of this.data.jobs) {
      if (job.state !== 'queued' || (chat && job.chatId !== chat)) continue;
      const decision = this.checkModeration(job.prompt);
      if (decision.blocked) rejected.set(job.id, decision);
    }
    if (!rejected.size) return;
    await this.commit(state => {
      for (const job of state.jobs) if (rejected.has(job.id)) this.blockJob(state, job, rejected.get(job.id));
    });
  }

  async recover() {
    if (!this.data.jobs.some(j => ACTIVE.has(j.state))) return;
    await this.commit(state => {
      for (const job of state.jobs) if (ACTIVE.has(job.state)) this.failJob(state, job, '扩展后台已重启，之前的网页任务已停止');
    });
  }

  async importBindings({ groups = {}, seen = {} } = {}) {
    if (!groups || typeof groups !== 'object' || !seen || typeof seen !== 'object' || Array.isArray(seen)) throw new BridgeError('迁移文件中的群绑定或去重记录无效');
    const entries = Array.isArray(groups) ? groups.map(group => [group?.chatId, group]) : Object.entries(groups);
    if (entries.length > 1000 || Object.keys(seen).length > 100000) throw new BridgeError('迁移记录数量过多');
    const normalized = entries.map(([key, group]) => {
      if (!group || typeof group !== 'object' || Array.isArray(group)) throw new BridgeError('迁移群记录无效');
      const id = chatId(group.chatId ?? key);
      if (key !== undefined && key !== id) throw new BridgeError('迁移群 ID 不一致');
      return { chatId: id, ...(group.binding ? { binding: identity(group.binding, this.assistant) } : {}) };
    });
    const recent = Object.entries(seen).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= this.now() - 7 * DAY && value <= this.now() + 5 * 60_000)
      .map(([id, value]) => {
        if (!/^[A-Za-z0-9_-]{1,150}$/.test(id)) throw new BridgeError('迁移消息 ID 无效');
        return [id, value];
      });
    return await this.commit(state => {
      if (state.jobs.length || state.outbox.length) throw new BridgeError('扩展队列已有任务或回复，不能再导入旧绑定', 409);
      for (const group of normalized) {
        const current = state.groups[group.chatId];
        if (current?.binding && (!group.binding || !sameIdentity(current.binding, group.binding))) throw new BridgeError('迁移绑定与扩展已有绑定冲突', 409);
        if (group.binding) for (const existing of Object.values(state.groups)) {
          if (existing.chatId !== group.chatId && existing.binding && (existing.binding.conversationUrl.split('/').at(-1) === group.binding.conversationUrl.split('/').at(-1) || (existing.binding.browserId === group.binding.browserId && existing.binding.tabId === group.binding.tabId))) throw new BridgeError('迁移记录将同一个对话或标签页绑定到了多个群', 409);
        }
        state.groups[group.chatId] = { chatId: group.chatId, lastSeen: current?.lastSeen ?? 0, ...(group.binding ? { binding: current?.binding ?? { ...group.binding, version: crypto.randomUUID() } } : {}) };
      }
      for (const [id, value] of recent) Object.defineProperty(state.seen, id, { value: Math.max(value, Object.hasOwn(state.seen, id) ? state.seen[id] : 0), enumerable: true, writable: true, configurable: true });
      return { ok: true, groups: normalized.length, seen: recent.length };
    });
  }

  async bind(input) {
    const id = chatId(input.chatId);
    const destination = identity(input, this.assistant);
    return await this.commit(state => {
      if (state.jobs.some(j => j.chatId === id && ACTIVE.has(j.state))) throw new BridgeError('该群还有待完成任务，请等待完成或超时后再修改绑定', 409);
      for (const group of Object.values(state.groups)) {
        if (group.chatId !== id && group.binding &&
          (group.binding.conversationUrl.split('/').at(-1) === destination.conversationUrl.split('/').at(-1) ||
            (group.binding.browserId === destination.browserId && group.binding.tabId === destination.tabId))) {
          throw new BridgeError(`这个 ${this.assistantName} 对话或标签页已经绑定其他群，请使用独立对话`, 409);
        }
      }
      const group = state.groups[id] ?? { chatId: id, lastSeen: 0 };
      group.binding = { ...destination, version: crypto.randomUUID() };
      state.groups[id] = group;
      return { ok: true };
    });
  }

  async unbind(input) {
    const id = chatId(input.chatId);
    return await this.commit(state => {
      if (state.jobs.some(j => j.chatId === id && ACTIVE.has(j.state))) throw new BridgeError('该群还有待完成任务，请等待完成或超时后再解除绑定', 409);
      if (state.groups[id]) delete state.groups[id].binding;
      return { ok: true };
    });
  }

  async ingest(message, { replyStyle = 'separate' } = {}) {
    validateReplyStyle(replyStyle);
    const id = text(message.messageId, '消息 ID', 150);
    if (Object.hasOwn(this.data.seen, id)) return { accepted: false, duplicate: true };
    const chat = chatId(message.chatId);
    // Don't replay old Feishu deliveries after restart or an extended offline period.
    const timestamp = Number(message.createdAt);
    if (!Number.isFinite(timestamp) || timestamp < this.now() - 15 * 60000 || timestamp > this.now() + 5 * 60000) return { accepted: false, stale: true };
    return await this.commit(state => {
      Object.defineProperty(state.seen, id, { value: this.now(), enumerable: true, writable: true, configurable: true });
      const group = state.groups[chat] ?? { chatId: chat, lastSeen: 0 };
      group.lastSeen = this.now();
      state.groups[chat] = group;
      let prompt = typeof message.text === 'string' ? message.text.trim() : '';
      const reject = reason => { this.addReply(state, id, chat, reason); return { accepted: false }; };
      const images = message.images ?? [];
      if (!Array.isArray(images) || images.length > IMAGE_MAX_COUNT) return reject('每条问题最多包含 4 张图片，请分成多条消息发送。');
      if (images.some(image => !image || typeof image.imageKey !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(image.imageKey))) return reject(`这条消息的图片标识无效，未向 ${this.assistantName} 发送问题，请重新发送图片。`);
      const imageKeys = [...new Set(images.map(image => image.imageKey))];
      if (!prompt && imageKeys.length) prompt = '请分析这条消息中的图片。';
      if (!prompt) return reject('请在 @机器人 后输入文字问题。');
      if (prompt.length > 12000) return reject('这条消息超过 12000 字符，请拆成较短的问题再发送。');
      const decision = this.checkModeration(prompt);
      if (decision.blocked) { reject(moderationMessage(decision, this.assistant)); return { accepted: false, blocked: true }; }
      if (!group.binding) return reject(`这个群还没有绑定 ${this.assistantName} 网页。请在 Chrome 桥接扩展设置中选择该群并绑定专用对话。\n群 ID：${chat}`);
      const pending = state.jobs.filter(j => ACTIVE.has(j.state));
      if (pending.length >= 100 || pending.filter(j => j.chatId === chat).length >= 20) return reject('当前排队消息较多，请稍后再发送。');
      const job = {
        id: crypto.randomUUID(), messageId: id, chatId: chat, prompt, state: 'queued',
        createdAt: this.now(), deadline: this.now() + 15 * 60000,
        binding: structuredClone(group.binding), replyKind: 'card', replyStyle,
        ...(imageKeys.length ? { imageRefs: imageKeys.map(imageKey => ({ imageKey, attempts: 0, nextAttemptAt: this.now() })), inputImages: [] } : {}),
      };
      state.jobs.push(job);
      this.queueCard(state, job);
      return { accepted: true, jobId: job.id };
    });
  }

  async cancel(jobId) {
    const id = text(jobId, '任务 ID', 100);
    const current = this.data.jobs.find(job => job.id === id);
    if (!current) throw new BridgeError('任务不存在，请刷新任务列表', 404);
    if (current.state === 'cancelled') return { ok: true };
    if (current.state !== 'queued') throw new BridgeError('只能取消排队中的任务，当前任务已开始处理或已结束，请刷新任务列表', 409);
    return await this.commit(state => {
      const job = state.jobs.find(job => job.id === id);
      job.state = 'cancelled'; job.finishedAt = this.now();
      delete job.prompt; delete job.uploads; delete job.imageRefs; delete job.inputImages;
      // Reuse this job's status card, including an unacknowledged creation.
      if (job.replyKind === 'card') this.queueCard(state, job, `已手动取消，未发送到 ${this.assistantName}。`);
      return { ok: true };
    });
  }

  async poll(input) {
    const caller = identity(input, this.assistant);
    const group = Object.values(this.data.groups).find(g => sameIdentity(g.binding, caller));
    if (!group) return { job: null };
    await this.blockQueuedJobs(group.chatId);
    if (this.data.jobs.some(j => j.chatId === group.chatId && ['leased', 'running'].includes(j.state))) return { job: null };
    const pending = this.data.jobs.find(j => j.chatId === group.chatId && j.state === 'queued');
    if (!pending || pending.deadline <= this.now() || pending.imageRefs?.some(image => !image.ready)) return { job: null };
    if (pending.inputImages?.length && (!Array.isArray(input.capabilities) || !input.capabilities.includes('image-input-v1'))) {
      return { job: null, notice: `请重新加载桥接扩展和 ${this.assistantName} 页面以启用图片输入` };
    }
    return await this.commit(state => {
      const job = state.jobs.find(j => j.id === pending.id);
      if (job.binding.version !== group.binding.version) throw new BridgeError('绑定已变化，请重新发送消息', 409);
      const decision = this.checkModeration(job.prompt);
      if (decision.blocked) { this.blockJob(state, job, decision); return { job: null }; }
      job.state = 'leased'; job.leaseToken = randomHex(24);
      job.deadline = this.now() + GENERATION_TIMEOUT;
      return { job: { id: job.id, leaseToken: job.leaseToken, prompt: job.prompt, conversationUrl: job.binding.conversationUrl, timeoutMs: GENERATION_TIMEOUT, ...(job.inputImages?.length ? { images: structuredClone(job.inputImages) } : {}) } };
    });
  }

  async nextInputImage() {
    await this.blockQueuedJobs();
    const blocked = new Set();
    for (const job of this.data.jobs) {
      if (!ACTIVE.has(job.state) || blocked.has(job.chatId)) continue;
      blocked.add(job.chatId);
      if (job.state !== 'queued' || job.deadline <= this.now()) continue;
      const index = job.imageRefs?.findIndex(image => !image.ready) ?? -1;
      if (index < 0 || job.imageRefs[index].nextAttemptAt > this.now()) continue;
      return { jobId: job.id, messageId: job.messageId, imageKey: job.imageRefs[index].imageKey, index };
    }
    return null;
  }

  async inputImageDownloaded(item, input) {
    const job = this.data.jobs.find(job => job.id === item.jobId);
    const ref = job?.imageRefs?.[item.index];
    if (!job || job.state !== 'queued' || job.deadline <= this.now() || !ref || ref.ready || ref.imageKey !== item.imageKey) return false;
    let decision = this.checkModeration(job.prompt);
    if (decision.blocked) { await this.commit(state => this.blockJob(state, state.jobs.find(current => current.id === job.id), decision)); return false; }
    const decoded = await prepareImage(input);
    decision = this.checkModeration(job.prompt);
    if (decision.blocked) { await this.commit(state => this.blockJob(state, state.jobs.find(current => current.id === job.id), decision)); return false; }
    if (job.deadline <= this.now()) return false;
    if (job.imageRefs.reduce((sum, image) => sum + (image.bytes ?? 0), 0) + decoded.bytes > IMAGE_TOTAL_BYTES) throw new BridgeError(`这条消息的图片合计超过 30 MB，未向 ${this.assistantName} 发送问题`);
    await this.commit(state => {
      const current = state.jobs.find(job => job.id === item.jobId);
      Object.assign(current.imageRefs[item.index], { ready: true, bytes: decoded.bytes });
      if (!current.inputImages.some(image => image.id === decoded.id)) current.inputImages.push({ id: decoded.id, mimeType: decoded.mimeType, name: `feishu-${decoded.id.slice(0, 16)}.${decoded.extension}`, bytes: decoded.bytes });
    }, { putImages: [{ key: mediaKey('input', job.id, decoded.id), blob: decoded.blob }] });
    return true;
  }

  async inputImageFailed(item, { retryable = true } = {}) {
    await this.commit(state => {
      const job = state.jobs.find(job => job.id === item.jobId);
      const ref = job?.imageRefs?.[item.index];
      if (!job || job.state !== 'queued' || !ref || ref.ready || ref.imageKey !== item.imageKey) return;
      ref.attempts += 1;
      if (!retryable || ref.attempts >= 3 || job.deadline <= this.now()) {
        this.failJob(state, job, `群消息中的图片下载失败、格式不受支持或超过大小限制，未向 ${this.assistantName} 发送这条问题；请检查机器人读取权限后重新发送（最多 4 张，单张 10 MB、合计 30 MB）`);
      } else ref.nextAttemptAt = this.now() + Math.min(30000, 1000 * 2 ** ref.attempts);
    });
  }

  async inputImage(id, input) {
    const job = this.authorize(this.data, id, input);
    if (!['leased', 'running'].includes(job.state) || job.deadline <= this.now()) throw new BridgeError('任务已结束或失效，不能读取输入图片', 409);
    if (typeof input.imageId !== 'string' || !/^[a-f0-9]{64}$/.test(input.imageId)) throw new BridgeError('输入图片标识无效');
    const image = job.inputImages?.find(image => image.id === input.imageId);
    if (!image || job.imageRefs?.some(ref => !ref.ready)) throw new BridgeError('图片不属于本次任务或尚未准备完成', 409);
    const blob = await this.storage.readImage(mediaKey('input', job.id, image.id));
    let decoded;
    try {
      if (!(blob instanceof Blob) || blob.size !== image.bytes) throw new Error();
      decoded = await prepareImage({ buffer: blob, mimeType: image.mimeType });
      if (decoded.id !== image.id) throw new Error();
    } catch { throw new BridgeError('扩展输入图片丢失或损坏，已停止提交问题，请重新发送', 409); }
    // A second extension context may finish/rebind the job while IndexedDB
    // and hashing are pending; reauthorize before returning any pixels.
    await this.refresh();
    const current = this.authorize(this.data, id, input);
    if (!['leased', 'running'].includes(current.state) || current.deadline <= this.now() || !current.inputImages?.some(item => item.id === image.id)) throw new BridgeError('任务已结束或失效，不能读取输入图片', 409);
    return { ok: true, imageId: image.id, mimeType: image.mimeType, name: image.name, base64: encodeBase64(decoded.buffer) };
  }

  authorize(state, id, input) {
    const job = state.jobs.find(j => j.id === id);
    if (!job) throw new BridgeError('任务不存在', 404);
    const caller = identity(input, this.assistant);
    const binding = state.groups[job.chatId]?.binding;
    if (!job.leaseToken || input.leaseToken !== job.leaseToken || !sameIdentity(job.binding, caller) || !sameIdentity(binding, caller) || job.binding.version !== binding.version) {
      throw new BridgeError('任务与当前群、浏览器或网页对话不匹配', 409);
    }
    return job;
  }

  async started(id, input) {
    const current = this.authorize(this.data, id, input);
    if (current.state !== 'leased' || current.deadline <= this.now()) throw new BridgeError('任务已启动或失效，不会再次提交网页', 409);
    const decision = this.checkModeration(current.prompt);
    if (decision.blocked) {
      await this.commit(state => this.blockJob(state, state.jobs.find(job => job.id === id), decision));
      throw new BridgeError(moderationMessage(decision, this.assistant), 409);
    }
    return await this.commit(state => {
      const job = this.authorize(state, id, input);
      // Never authorize a second send, even after the first response was lost.
      if (job.state !== 'leased' || job.deadline <= this.now()) throw new BridgeError('任务已启动或失效，不会再次提交网页', 409);
      job.state = 'running'; job.startedAt = this.now();
      if (job.replyKind === 'card') this.queueCard(state, job);
      return { ok: true };
    });
  }

  async result(id, input) {
    const current = this.authorize(this.data, id, input);
    if (current.state === 'completed') return { ok: true };
    const imageIds = input.images ?? [];
    if (!Array.isArray(imageIds) || imageIds.length > IMAGE_MAX_COUNT || imageIds.some(imageId => typeof imageId !== 'string' || !/^[a-f0-9]{64}$/.test(imageId))) throw new BridgeError('回复图片标识无效');
    if (typeof input.text !== 'string' || input.text.length > 120000 || (!input.text.trim() && !imageIds.length)) throw new BridgeError('网页回复不能为空，且不能超过 120000 字符');
    const body = input.text.trim() || `已生成 ${imageIds.length} 张图片，请查看下方图片。`;
    // Freeze split post payloads in the same transaction as the final result.
    // Later configuration or renderer updates must not change retry contents.
    const posts = current.replyStyle === 'separate' && input.text.trim() ? buildAnswerPosts(input.text.trim()) : [];
    return await this.commit(state => {
      const job = this.authorize(state, id, input);
      if (job.state !== 'running' || job.deadline <= this.now()) throw new BridgeError('任务已经失效，未转发本次结果', 409);
      const uploads = job.uploads ?? [];
      if (imageIds.length !== uploads.length || imageIds.some((imageId, index) => uploads[index]?.id !== imageId)) throw new BridgeError('回复图片与本次已上传图片不一致', 409);
      job.state = 'completed'; job.finishedAt = this.now(); delete job.prompt; delete job.imageRefs; delete job.inputImages;
      job.timing = resultTiming(input.timing);
      if (job.replyStyle === 'separate') {
        job.answerDelivery = { state: 'pending', posts: posts.length, images: uploads.length, sentPosts: 0, sentImages: 0, failed: false };
        this.queueCard(state, job, '回复已生成，正在发送正文和图片。');
        posts.forEach((post, index) => state.outbox.push({
          id: `${job.id}:post:${index}`, kind: 'post', jobId: job.id,
          messageId: job.messageId, chatId: job.chatId, post: structuredClone(post), index,
          createdAt: this.now(), attempts: 0, nextAttemptAt: this.now(),
        }));
      } else this.queueJobReply(state, job, body);
      for (const upload of uploads) state.outbox.push({
        id: `${job.id}:image:${upload.index}`, kind: 'image', jobId: job.id,
        messageId: job.messageId, chatId: job.chatId, image: upload,
        createdAt: this.now(), attempts: 0, nextAttemptAt: this.now(),
      });
      delete job.uploads;
      this.finishSeparateDelivery(state, job);
      return { ok: true };
    });
  }

  async image(id, input) {
    const job = this.authorize(this.data, id, input);
    if (job.state !== 'running' || job.deadline <= this.now()) throw new BridgeError('任务已经失效，不能继续上传图片', 409);
    if (!Number.isInteger(input.index) || input.index < 0 || input.index >= IMAGE_MAX_COUNT) throw new BridgeError('每次最多回传 4 张图片');
    const decoded = await prepareImage(input);
    if (job.deadline <= this.now()) throw new BridgeError('任务已经失效，不能继续上传图片', 409);
    const uploads = job.uploads ?? [];
    const previous = uploads[input.index];
    if (previous) {
      if (previous.id !== decoded.id || previous.mimeType !== decoded.mimeType) throw new BridgeError('不能替换已经上传的图片', 409);
      return { ok: true, imageId: previous.id };
    }
    if (input.index !== uploads.length) throw new BridgeError('请按顺序上传回复图片', 409);
    if (uploads.reduce((sum, item) => sum + item.bytes, 0) + decoded.bytes > IMAGE_TOTAL_BYTES) throw new BridgeError('本次回复图片合计超过 30 MB');
    return await this.commit(state => {
      const current = state.jobs.find(job => job.id === id);
      (current.uploads ??= []).push({ id: decoded.id, index: input.index, mimeType: decoded.mimeType, bytes: decoded.bytes });
      return { ok: true, imageId: decoded.id };
    }, { putImages: [{ key: mediaKey('output', id, decoded.id), blob: decoded.blob }] });
  }

  async imageBuffer(item) {
    const blob = await this.storage.readImage(mediaKey('output', item.jobId, item.image.id));
    if (!blob) throw permanentImage('扩展待发送图片已丢失，无法回传', 'image_missing');
    try {
      if (!(blob instanceof Blob) || blob.size !== item.image.bytes) throw new Error();
      const decoded = await prepareImage({ buffer: blob, mimeType: item.image.mimeType });
      if (decoded.id !== item.image.id) throw new Error();
      return decoded.buffer;
    } catch { throw permanentImage('扩展待发送图片已损坏，无法回传', 'image_corrupt'); }
  }

  async imageUploaded(id, imageKey) {
    if (typeof imageKey !== 'string' || !imageKey || imageKey.length > 512 || /\s/.test(imageKey)) throw new Error('飞书未返回有效图片标识');
    await this.commit(state => {
      const item = state.outbox.find(o => o.id === id && o.kind === 'image');
      if (!item) throw new Error('图片投递任务不存在');
      item.imageKey = imageKey;
      item.attempts = 0; item.nextAttemptAt = this.now(); delete item.error;
    });
  }

  async imageReplyRejected(id) {
    await this.commit(state => {
      const item = state.outbox.find(item => item.id === id && item.kind === 'image');
      if (!item || item.abandoned) return;
      item.abandoned = true;
      item.error = '图片未能回传，请检查图片格式、大小及机器人上传和发送权限';
      item.attempts += 1;
      const failureId = `${item.id}:failure`;
      if (!state.outbox.some(reply => reply.id === failureId)) {
        this.addReply(state, item.messageId, item.chatId, '图片未能回传。文字答复已保留；请检查图片格式、大小及机器人上传和发送权限。', failureId);
      }
      const job = state.jobs.find(job => job.id === item.jobId);
      if (job?.answerDelivery) job.answerDelivery.failed = true;
      this.finishSeparateDelivery(state, job);
    });
  }

  async postReplyRejected(id) {
    await this.commit(state => {
      const item = state.outbox.find(item => item.id === id && item.kind === 'post');
      if (!item || item.abandoned) return;
      // A permanent rejection cannot silently skip a section of the answer.
      // Retain unsent parts for inspection and stop retrying this answer body.
      for (const part of state.outbox) if (part.kind === 'post' && part.jobId === item.jobId && !part.abandoned) {
        part.abandoned = true; part.error = '正文未能完整发送，请检查机器人权限和扩展投递状态';
        if (part.id === id) part.attempts += 1;
      }
      const job = state.jobs.find(job => job.id === item.jobId);
      if (job?.answerDelivery) job.answerDelivery.failed = true;
      this.finishSeparateDelivery(state, job);
    });
  }

  async error(id, input) {
    const reason = text(input.error, '错误信息', 500);
    const current = this.authorize(this.data, id, input);
    if (['completed', 'failed'].includes(current.state)) return { ok: true };
    return await this.commit(state => {
      const job = this.authorize(state, id, input);
      if (!['leased', 'running'].includes(job.state)) throw new BridgeError('任务状态无效', 409);
      this.failJob(state, job, reason);
      return { ok: true };
    });
  }

  async sweep() {
    await this.blockQueuedJobs();
    const now = this.now();
    const needs = this.data.jobs.some(j => (ACTIVE.has(j.state) && j.deadline <= now) || (j.finishedAt && j.finishedAt < now - 7 * DAY)) ||
      Object.values(this.data.seen).some(t => t < now - 7 * DAY) || this.data.outbox.some(o => !o.abandoned && now - o.createdAt >= RETRY_WINDOW);
    if (!needs) { await this.sweepMedia(); return; }
    await this.commit(state => {
      for (const job of state.jobs) if (ACTIVE.has(job.state) && job.deadline <= now) this.failJob(state, job, job.state === 'queued' ? '等待绑定网页上线超时，请确认 Chrome 与对应标签页保持打开' : '网页任务超时或页面连接已中断');
      for (const item of state.outbox) if (!item.abandoned && now - item.createdAt >= RETRY_WINDOW) {
        item.abandoned = true; item.error = '回复发送未确认，已超过自动重试时限，请人工核对飞书';
        if (['post', 'image'].includes(item.kind)) {
          const job = state.jobs.find(job => job.id === item.jobId);
          if (job?.answerDelivery) job.answerDelivery.failed = true;
        }
      }
      for (const job of state.jobs) this.finishSeparateDelivery(state, job);
      state.jobs = state.jobs.filter(j => !j.finishedAt || j.finishedAt >= now - 7 * DAY);
      state.seen = Object.fromEntries(Object.entries(state.seen).filter(([,time]) => time >= now - 7 * DAY));
      state.outbox = state.outbox.filter(o => !o.abandoned || o.createdAt >= now - DAY);
    });
    await this.sweepMedia();
  }

  async sweepMedia() {
    if (this.nextMediaSweep > this.now()) return;
    const retained = retainedImages(this.data);
    const keys = await this.storage.listImageKeys();
    const orphaned = keys.filter(key => typeof key === 'string' && /^(?:input|output):/.test(key) && !retained.has(key));
    if (orphaned.length) await this.commit(() => {}, { deleteImages: orphaned });
    this.nextMediaSweep = this.now() + 60_000;
  }

  async nextReply() {
    const blocked = new Set();
    for (const item of this.data.outbox) {
      if (item.abandoned) continue;
      if (blocked.has(item.chatId)) continue;
      blocked.add(item.chatId);
      if (!item.abandoned && item.nextAttemptAt <= this.now() && this.now() - item.createdAt < RETRY_WINDOW) return structuredClone(item);
    }
    return null;
  }

  async replySent(id) {
    await this.commit(state => {
      const item = state.outbox.find(item => item.id === id);
      if (!item) return;
      state.outbox = state.outbox.filter(item => item.id !== id);
      if (['post', 'image'].includes(item.kind)) {
        const job = state.jobs.find(job => job.id === item.jobId);
        if (job?.answerDelivery) {
          if (item.kind === 'post') job.answerDelivery.sentPosts += 1;
          else job.answerDelivery.sentImages += 1;
        }
        this.finishSeparateDelivery(state, job);
      }
    });
  }

  async cardCreated(id, messageId) {
    if (typeof messageId !== 'string' || !messageId || /\s/.test(messageId) || messageId.length > 256) throw new Error('飞书未返回有效卡片消息 ID');
    await this.commit(state => {
      const job = state.jobs.find(j => j.id === id);
      const item = state.outbox.find(o => o.id === id && o.kind === 'card');
      if (!job || !item) throw new Error('卡片任务不存在');
      if (job.cardMessageId && job.cardMessageId !== messageId) throw new Error('卡片消息 ID 不一致');
      job.cardMessageId = messageId;
      item.cardMessageId = messageId;
      // createCard ALWAYS sends the immutable queued card. A final answer
      // arriving during that request must remain pending for a later PATCH.
      if (item.state === 'queued') state.outbox = state.outbox.filter(o => o.id !== id);
      else {
        item.attempts = 0; item.nextAttemptAt = this.now();
        delete item.error;
      }
    });
  }

  async cardUpdated(id, revision) {
    await this.commit(state => {
      state.outbox = state.outbox.filter(o => o.id !== id || o.revision !== revision);
    });
  }

  async replyFailed(id, revision) {
    await this.commit(state => {
      const item = state.outbox.find(o => o.id === id);
      // A failed old status request must not back off or overwrite a newer
      // answer that was committed while the network operation was in flight.
      if (!item || (revision !== undefined && item.revision !== revision)) return;
      item.attempts += 1;
      item.error = '飞书回复发送暂未成功，正在重试';
      item.nextAttemptAt = this.now() + Math.min(60000, 1000 * 2 ** Math.min(item.attempts, 6));
    });
  }

  async clearHistory() {
    const ids = clearableHistoryIds(this.data);
    if (!ids.size) return { ok: true, count: 0 };
    return this.commit(state => {
      for (const job of state.jobs) if (ids.has(job.id)) job.historyCleared = true;
      return { ok: true, count: ids.size };
    });
  }

  async status() {
    let historyCount = 0;
    const visibleJobs = this.data.jobs.slice().reverse().filter(job => ACTIVE.has(job.state) || (!job.historyCleared && historyCount++ < 100));
    return {
      clearableHistoryCount: clearableHistoryIds(this.data).size,
      activeJobCount: this.data.jobs.filter(job => ACTIVE.has(job.state)).length,
      queuedChatIds: [...new Set(this.data.jobs.filter(job => job.state === 'queued').map(job => job.chatId))],
      groups: Object.values(this.data.groups).map(g => ({ ...g, binding: g.binding ? { conversationUrl: g.binding.conversationUrl, browserId: g.binding.browserId, tabId: g.binding.tabId } : undefined })),
      jobs: visibleJobs.map(({ id, chatId, state, createdAt, startedAt, error, timing }) => ({ id, chatId, state, createdAt, error,
        ...(timing || Number.isFinite(startedAt) ? { timing: { ...timing,
          ...(Number.isFinite(startedAt) && Number.isFinite(createdAt) ? { handoffMs: Math.max(0, startedAt - createdAt) } : {}),
        } } : {}),
      })),
      delivery: this.data.outbox.map(({ id, chatId, abandoned, error, attempts }) => ({ id, chatId, state: abandoned ? 'needs_attention' : 'pending', error, attempts })),
    };
  }
}
