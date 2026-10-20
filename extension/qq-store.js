import { clearableHistoryIds } from './history.js';
import { IndexedDBStorage } from './storage.js';
import { ASSISTANT_NAMES, assistantId, conversationUrl, resultTiming } from './shared.js';
import { buildAnswerPosts } from './answer-text.js';

export class BridgeError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'BridgeError'; this.status = status; }
}
export function validateReplyStyle(value) {
  if (value !== 'separate') throw new BridgeError('QQ 使用 Markdown 正文与独立图片回复');
  return value;
}
export const IMAGE_MAX_BYTES = 10_000_000;
export const OUTPUT_IMAGE_MAX_BYTES = 4_900_000;
export const REPLY_WINDOW_MS = 5 * 60_000;
const DELIVERY_RESERVE_MS = 45_000;
export const IMAGE_TOTAL_BYTES = 30_000_000;
export const IMAGE_MAX_COUNT = 4;
const ACTIVE = new Set(['queued', 'leased', 'running']);
const DAY = 86_400_000;
const GENERATION_TIMEOUT = 4 * 60_000;
const RETRY_WINDOW = REPLY_WINDOW_MS;
const TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });
const PUBLIC_METHODS = ['clearHistory', 'ingest', 'cancel', 'poll', 'started', 'inputImage', 'image', 'result', 'error', 'bind', 'unbind', 'status', 'nextReply', 'replySent', 'replyFailed', 'nextInputImage', 'inputImageDownloaded', 'inputImageFailed', 'imageBuffer', 'imageUploaded', 'imageReplyRejected', 'postReplyRejected', 'sweep', 'recover', 'replyRejected', 'deliveryStarted'];
const MODERATION_MESSAGES = Object.freeze({
  keyword: '已拦截：这条消息触发本群关键词限制，未发送到 ChatGPT。请换一个合适的问题。',
  configuration: '已停止：扩展关键词过滤配置不可用，暂不向 ChatGPT 发送问题。请管理员检查扩展词表。',
});
function moderationMessage(decision, assistant) { return (MODERATION_MESSAGES[decision.reason] ?? MODERATION_MESSAGES.configuration).replaceAll('ChatGPT', ASSISTANT_NAMES[assistant]); }
function emptyState() { return { version: 1, revision: 0, groups: {}, jobs: [], seen: {}, receipts: {}, outbox: [] }; }
function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new BridgeError(`${label}不能为空，且不能超过 ${max} 字符`);
  return value.trim();
}
function chatId(value) {
  const id = text(value, 'QQ群 ID', 128);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new BridgeError('请输入 QQ 回调中的 group_openid，不能填写普通群号');
  return id;
}
function identity(input, assistant) {
  if (!input || typeof input !== 'object') throw new BridgeError('浏览器身份无效');
  const browserId = text(input.browserId, '浏览器标识', 100);
  if (!Number.isSafeInteger(input.tabId) || input.tabId < 0) throw new BridgeError('标签页 ID 无效');
  const url = conversationUrl(input.conversationUrl, assistant);
  if (!url) throw new BridgeError(`请绑定已经创建的 ${({ chatgpt: 'chatgpt.com/c/…', claude: 'claude.ai/chat/…', gemini: 'gemini.google.com/app/…', qwen: 'chat.qwen.ai/c/…', hark: 'app.hark.com/chat/…' })[assistant]} 对话，不能绑定首页或其他助手页面`);
  return { browserId, tabId: input.tabId, conversationUrl: url };
}
// 绑定身份判定（用于 bind / poll：这个群对应哪段对话）：同一浏览器 +
// 同一会话地址即视为同一绑定。刻意不比较 tabId —— 浏览器重启后标签页 ID
// 会变，旧实现导致绑定每次重启失效、必须手动重绑。conversationUrl 已经
// 规范化，足以区分不同对话。
function sameBinding(a, b) { return !!a && !!b && a.browserId === b.browserId && a.conversationUrl === b.conversationUrl; }
// 租约身份判定（用于 started / result 等提交动作）：必须连 tabId 一起比对。
// 绑定可以跨重启继承，但一次已经开始的提交只能由当初那个标签页完成，
// 否则另一个绑定了同一对话的标签页就能顶替它提交/回传。
function sameIdentity(a, b) { return sameBinding(a, b) && a.tabId === b.tabId; }
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
    const store = new BridgeStore({ storage: storage ?? await IndexedDBStorage.open(assistant === 'chatgpt' ? undefined : `chatgpt-bot-bridge-${assistant}-qq`), assistant, now, moderate });
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
    if (this.data.version !== 1 || !Number.isSafeInteger(this.data.revision) || this.data.revision < 0 || !this.data.receipts || !this.data.groups || !Array.isArray(this.data.jobs) || !this.data.seen || !Array.isArray(this.data.outbox)) throw new BridgeError('扩展队列状态损坏或版本不兼容，已停止以避免重复发送', 409);
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
    const context = state.receipts[messageId];
    if (!context || context.expiresAt <= this.now() || context.nextSeq > 5) return;
    state.outbox.push({ id, messageId, chatId: chat, text: body, msgSeq: context.nextSeq++,
      expiresAt: context.expiresAt, createdAt: this.now(), attempts: 0, nextAttemptAt: this.now() });
  }

  queueJobReply(state, job, body) {
    this.addReply(state, job.messageId, job.chatId, body, job.id);
  }

  finishSeparateDelivery(state, job) {
    if (!job || job.replyStyle !== 'separate' || job.state !== 'completed' || !job.answerDelivery) return;
    if (state.outbox.some(item => item.jobId === job.id && ['post', 'image'].includes(item.kind) && !item.abandoned)) return;
    const delivery = job.answerDelivery;
    const failed = delivery.failed || delivery.sentPosts !== delivery.posts || delivery.sentImages !== delivery.images;
    const next = failed ? 'failed' : 'sent';
    if (delivery.state === next) return;
    delivery.state = next;
    delivery.finishedAt = this.now();
    if (failed) job.error = '正文或图片未能全部确认送达，请检查投递状态。';
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
      const group = Object.hasOwn(state.groups, id) ? state.groups[id] : { chatId: id, lastSeen: 0 };
      group.binding = { ...destination, version: crypto.randomUUID() };
      state.groups[id] = group;
      return { ok: true };
    });
  }

  async unbind(input) {
    const id = chatId(input.chatId);
    return await this.commit(state => {
      if (state.jobs.some(j => j.chatId === id && ACTIVE.has(j.state))) throw new BridgeError('该群还有待完成任务，请等待完成或超时后再解除绑定', 409);
      if (Object.hasOwn(state.groups, id)) delete state.groups[id].binding;
      return { ok: true };
    });
  }

  async ingest(message, { replyStyle = 'separate' } = {}) {
    validateReplyStyle(replyStyle);
    const id = text(message.messageId, '消息 ID', 512);
    if (Object.hasOwn(this.data.seen, id)) return { accepted: false, duplicate: true };
    const chat = chatId(message.chatId);
    // Don't replay old QQ deliveries after restart or an extended offline period.
    const timestamp = Number(message.createdAt);
    if (!Number.isFinite(timestamp) || timestamp < this.now() - REPLY_WINDOW_MS + 5000 || timestamp > this.now() + 5 * 60000) return { accepted: false, stale: true };
    return await this.commit(state => {
      Object.defineProperty(state.seen, id, { value: this.now(), enumerable: true, writable: true, configurable: true });
      Object.defineProperty(state.receipts, id, { value: { expiresAt: Math.min(timestamp, this.now()) + REPLY_WINDOW_MS - 5000, nextSeq: 1 }, enumerable: true, writable: true, configurable: true });
      const group = Object.hasOwn(state.groups, chat) ? state.groups[chat] : { chatId: chat, lastSeen: 0 };
      group.lastSeen = this.now();
      state.groups[chat] = group;
      let prompt = typeof message.text === 'string' ? message.text.trim() : '';
      const reject = reason => { this.addReply(state, id, chat, reason); return { accepted: false }; };
      if (message.unsupportedAttachments) {
        if (message.unsupportedReason === 'reference_without_current_content') return reject('QQ 没有提供这条引用回复中可读取的文字或当前图片，请取消引用后重新发送问题。');
        if (message.unsupportedReason === 'reference_too_large') return reject('这条引用回复包含过多或过长的内容，请缩短引用内容，或取消引用后重新发送问题。');
        if (message.unsupportedReason === 'reference_image_unavailable') return reject('QQ 没有提供可读取的引用图片，或该附件格式不受支持。请把图片重新附在本次 @ 提问里；支持 PNG、JPEG 和 WebP。');
        return reject('这条消息包含不支持的附件；请只发送文字以及 PNG、JPEG 或 WebP 图片。');
      }
      if (state.receipts[id].expiresAt - DELIVERY_RESERVE_MS <= this.now()) return reject('这条消息接近 QQ 的 5 分钟回复期限，请重新 @机器人 提问。');
      const images = message.images ?? [];
      if (!Array.isArray(images) || images.length > IMAGE_MAX_COUNT) return reject('每条问题最多包含 4 张图片，请分成多条消息发送。');
      if (images.some(image => !image || typeof image.imageKey !== 'string' || image.imageKey.length > 8192 || !image.imageKey.startsWith('https://'))) return reject(`这条消息的图片标识无效，未向 ${this.assistantName} 发送问题，请重新发送图片。`);
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
        createdAt: this.now(), replyExpiresAt: state.receipts[id].expiresAt, deadline: state.receipts[id].expiresAt - DELIVERY_RESERVE_MS,
        binding: structuredClone(group.binding), replyStyle,
        ...(imageKeys.length ? { imageRefs: imageKeys.map(imageKey => ({ imageKey, attempts: 0, nextAttemptAt: this.now() })), inputImages: [] } : {}),
      };
      state.jobs.push(job);
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
      // Keep deduplication and local history without consuming a QQ reply slot.
      return { ok: true };
    });
  }

  async poll(input) {
    const caller = identity(input, this.assistant);
    const group = Object.values(this.data.groups).find(g => sameBinding(g.binding, caller));
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
      job.deadline = Math.min(job.deadline, this.now() + GENERATION_TIMEOUT);
      return { job: { id: job.id, leaseToken: job.leaseToken, prompt: job.prompt, conversationUrl: job.binding.conversationUrl, timeoutMs: job.deadline - this.now(), ...(job.inputImages?.length ? { images: structuredClone(job.inputImages) } : {}) } };
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
      if (!current.inputImages.some(image => image.id === decoded.id)) current.inputImages.push({ id: decoded.id, mimeType: decoded.mimeType, name: `qq-${decoded.id.slice(0, 16)}.${decoded.extension}`, bytes: decoded.bytes });
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
      return { ok: true };
    });
  }

  async result(id, input) {
    const current = this.authorize(this.data, id, input);
    if (current.state === 'completed') return { ok: true };
    const imageIds = input.images ?? [];
    if (!Array.isArray(imageIds) || imageIds.length > IMAGE_MAX_COUNT || imageIds.some(imageId => typeof imageId !== 'string' || !/^[a-f0-9]{64}$/.test(imageId))) throw new BridgeError('回复图片标识无效');
    if (typeof input.text !== 'string' || input.text.length > 120000 || (!input.text.trim() && !imageIds.length)) throw new BridgeError('网页回复不能为空，且不能超过 120000 字符');
    let posts;
    try { posts = input.text.trim() ? buildAnswerPosts(input.text.trim()) : []; }
    catch { throw new BridgeError('回复无法完整转换为 QQ Markdown（可能有过长的单行代码），请在网页查看完整结果，并要求较短的回复后再试'); }
    if (posts.length + imageIds.length > 5) throw new BridgeError('QQ 每条提问最多回复 5 条消息，正文与图片合计超限。请在网页查看完整结果，并要求缩短答案后重新提问。');
    return await this.commit(state => {
      const job = this.authorize(state, id, input);
      if (job.state !== 'running' || job.deadline <= this.now()) throw new BridgeError('任务已经失效，未转发本次结果', 409);
      const uploads = job.uploads ?? [];
      if (imageIds.length !== uploads.length || imageIds.some((imageId, index) => uploads[index]?.id !== imageId)) throw new BridgeError('回复图片与本次已上传图片不一致', 409);
      const context = state.receipts[job.messageId];
      if (!context || context.nextSeq + posts.length + uploads.length - 1 > 5) throw new BridgeError('QQ 被动回复额度不足，未发送不完整答案', 409);
      job.state = 'completed'; job.finishedAt = this.now(); delete job.prompt; delete job.imageRefs; delete job.inputImages;
      job.timing = resultTiming(input.timing);
      job.answerDelivery = { state: 'pending', posts: posts.length, images: uploads.length, sentPosts: 0, sentImages: 0, failed: false };
      posts.forEach((post, index) => state.outbox.push({
        id: `${job.id}:post:${index}`, kind: 'post', jobId: job.id,
        messageId: job.messageId, chatId: job.chatId, post, index, msgSeq: context.nextSeq++, expiresAt: context.expiresAt,
        createdAt: this.now(), attempts: 0, nextAttemptAt: this.now(),
      }));
      for (const upload of uploads) state.outbox.push({
        id: `${job.id}:image:${upload.index}`, kind: 'image', jobId: job.id,
        messageId: job.messageId, chatId: job.chatId, image: upload, msgSeq: context.nextSeq++, expiresAt: context.expiresAt,
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
    if (decoded.bytes > OUTPUT_IMAGE_MAX_BYTES) throw new BridgeError('QQ 直传图片最大 4.9 MB，请在网页下载原图，或生成较小的图片后再试');
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

  async imageUploaded(id, imageKey, ttl) {
    if (typeof imageKey !== 'string' || !imageKey || imageKey.length > 65536 || /\s/.test(imageKey)) throw new Error('QQ未返回有效图片标识');
    await this.commit(state => {
      const item = state.outbox.find(o => o.id === id && o.kind === 'image');
      if (!item) throw new Error('图片投递任务不存在');
      item.imageKey = imageKey;
      if (Number.isFinite(ttl) && ttl > 0) item.imageKeyExpiresAt = this.now() + ttl * 1000;
      else delete item.imageKeyExpiresAt;
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
      Object.values(this.data.seen).some(t => t < now - 7 * DAY) || this.data.outbox.some(o => !o.abandoned && (o.expiresAt ?? o.createdAt + RETRY_WINDOW) <= now);
    if (!needs) { await this.sweepMedia(); return; }
    await this.commit(state => {
      for (const job of state.jobs) if (ACTIVE.has(job.state) && job.deadline <= now) this.failJob(state, job, job.state === 'queued' ? '等待绑定网页上线超时，请确认 Chrome 与对应标签页保持打开' : '网页任务超时或页面连接已中断');
      for (const item of state.outbox) if (!item.abandoned && (item.expiresAt ?? item.createdAt + RETRY_WINDOW) <= now) {
        item.abandoned = true; item.error = 'QQ 的 5 分钟回复期限已到，已停止发送；请在网页查看结果后重新提问';
        if (['post', 'image'].includes(item.kind)) {
          const job = state.jobs.find(job => job.id === item.jobId);
          if (job?.answerDelivery) job.answerDelivery.failed = true;
        }
      }
      for (const job of state.jobs) this.finishSeparateDelivery(state, job);
      state.jobs = state.jobs.filter(j => !j.finishedAt || j.finishedAt >= now - 7 * DAY);
      state.receipts = Object.fromEntries(Object.entries(state.receipts).filter(([,receipt]) => receipt.expiresAt >= now - DAY));
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
      if (!item.abandoned && item.nextAttemptAt <= this.now() && this.now() < (item.expiresAt ?? item.createdAt + RETRY_WINDOW)) {
        if (item.kind === 'image' && item.imageKey && item.imageKeyExpiresAt <= this.now()) {
          await this.commit(state => { const current = state.outbox.find(o => o.id === item.id); delete current.imageKey; delete current.imageKeyExpiresAt; });
          return structuredClone(this.data.outbox.find(o => o.id === item.id));
        }
        return structuredClone(item);
      }
    }
    return null;
  }

  async deliveryStarted(id) {
    const item = this.data.outbox.find(item => item.id === id);
    const job = item && this.data.jobs.find(job => job.id === item.jobId);
    if (!job?.answerDelivery || Number.isFinite(job.answerDelivery.startedAt)) return;
    await this.commit(state => {
      const current = state.jobs.find(current => current.id === job.id);
      current.answerDelivery.startedAt = this.now();
    });
  }

  async replySent(id) {
    await this.commit(state => {
      const item = state.outbox.find(item => item.id === id);
      if (!item) return;
      state.outbox = state.outbox.filter(item => item.id !== id);
      if (['post', 'image'].includes(item.kind)) {
        const job = state.jobs.find(job => job.id === item.jobId);
        if (job?.answerDelivery) {
          if (!Number.isFinite(job.answerDelivery.firstSentAt)) job.answerDelivery.firstSentAt = this.now();
          if (item.kind === 'post') job.answerDelivery.sentPosts += 1;
          else job.answerDelivery.sentImages += 1;
        }
        this.finishSeparateDelivery(state, job);
      }
    });
  }

  async replyRejected(id) {
    await this.commit(state => {
      const item = state.outbox.find(o => o.id === id);
      if (!item || item.abandoned) return;
      item.abandoned = true; item.error = 'QQ 未确认此次回复送达，已停止重试；请检查权限、回复期限和群消息。';
      item.attempts += 1;
      const job = state.jobs.find(job => job.id === item.jobId);
      if (job?.answerDelivery) job.answerDelivery.failed = true;
      this.finishSeparateDelivery(state, job);
    });
  }

  async replyFailed(id, revision) {
    await this.commit(state => {
      const item = state.outbox.find(o => o.id === id);
      // A failed old status request must not back off or overwrite a newer
      // answer that was committed while the network operation was in flight.
      if (!item || (revision !== undefined && item.revision !== revision)) return;
      item.attempts += 1;
      item.error = 'QQ回复发送暂未成功，正在重试';
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
      jobs: visibleJobs.map(({ id, chatId, state, createdAt, startedAt, error, answerDelivery, timing, finishedAt }) => {
        const delivery = answerDelivery;
        const end = Number.isFinite(delivery?.finishedAt) ? delivery.finishedAt : delivery?.state === 'pending' ? this.now() : undefined;
        return { id, chatId, state: delivery?.state === 'pending' ? 'delivering' : delivery?.state === 'failed' ? 'failed' : state, createdAt, error,
          ...(delivery || Number.isFinite(startedAt) ? { timing: { ...timing,
            ...(Number.isFinite(startedAt) && Number.isFinite(createdAt) ? { handoffMs: Math.max(0, startedAt - createdAt) } : {}),
            ...(Number.isFinite(delivery?.startedAt ?? end) && Number.isFinite(finishedAt) ? { queueMs: Math.max(0, (delivery.startedAt ?? end) - finishedAt) } : {}),
            ...(Number.isFinite(delivery?.startedAt) && Number.isFinite(end) ? { deliveryMs: Math.max(0, end - delivery.startedAt) } : {}),
            ...(Number.isFinite(delivery?.firstSentAt) ? { firstReplyMs: Math.max(0, delivery.firstSentAt - finishedAt) } : {}),
          } } : {}),
        };
      }),
      delivery: this.data.outbox.map(({ id, chatId, abandoned, error, attempts }) => ({ id, chatId, state: abandoned ? 'needs_attention' : 'pending', error, attempts })),
    };
  }
}
