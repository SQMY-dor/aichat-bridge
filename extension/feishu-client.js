import { buildCards } from './cards.js';
import { normalizeMessage, splitReplyText } from './feishu-message.js';
import { encodeFrame, decodeFrame, frameHeaders, EventAssembler } from './feishu-protocol.js';
import { serializeAnswerPost } from './answer-post.js';
export { normalizeMessage, splitReplyText } from './feishu-message.js';

const ORIGIN = 'https://open.feishu.cn';
const IMAGE_LIMIT = 10_000_000;
const encoder = new TextEncoder();
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const requestIdValid = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);
export class FeishuTransportError extends Error {
  constructor(message, { retryable = true, code = 'feishu_transport' } = {}) { super(message); this.name = 'FeishuTransportError'; this.retryable = retryable; this.code = code; }
}
const invalid = message => new FeishuTransportError(message, { retryable: false, code: 'invalid_input' });
function failure(code, status) {
  if ([403, 230027, 230035, 99991671, 99991672, 234009].includes(code) || status === 403) return new FeishuTransportError('飞书权限不足，请检查机器人、消息读取和资源上传权限', { retryable: false, code: 'permission' });
  if ([230020, 99991400].includes(code) || status === 429) return new FeishuTransportError('飞书请求过于频繁，请稍后重试', { code: 'rate_limit' });
  if ([230002, 230011, 230050, 232009, 234037, 234038, 234040, 234041, 234043].includes(code)) return new FeishuTransportError('原消息、资源或群聊不可用', { retryable: false, code: 'target_unavailable' });
  if ([234006, 234010, 234011, 234039].includes(code) || status === 413) return new FeishuTransportError('飞书拒绝图片，请检查格式、大小与分辨率', { retryable: false, code: 'invalid_image' });
  if ([10003, 10014, 10017, 10023, 10024, 10064, 10068, 10069, 514, 99991663].includes(code) || status === 401) return new FeishuTransportError('飞书应用鉴权失败，请核对 App ID 与 App Secret', { retryable: false, code: 'authentication' });
  return new FeishuTransportError('飞书接口请求失败，请检查应用配置、权限和网络', { retryable: !(status >= 400 && status < 500), code: 'api_error' });
}
export function validateWebSocketEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid('飞书长连接地址无效'); }
  if (url.protocol !== 'wss:' || url.username || url.password || url.port || url.hash || !(url.hostname === 'feishu.cn' || url.hostname.endsWith('.feishu.cn'))) throw invalid('飞书长连接地址不属于允许的官方域名');
  const service = url.searchParams.get('service_id');
  if (!/^\d+$/.test(service ?? '') || !Number.isSafeInteger(Number(service)) || Number(service) > 0x7fffffff) throw invalid('飞书长连接服务标识无效');
  return { url: url.href, service: Number(service) };
}
export async function transportUuid(namespace, requestId, messageId, index = 0, cryptoImpl = globalThis.crypto) {
  if (!requestIdValid(requestId) || !identifier(messageId) || !Number.isInteger(index) || index < 0 || index > 10000) throw invalid('飞书消息标识无效');
  const digest = await cryptoImpl.subtle.digest('SHA-256', encoder.encode(JSON.stringify([namespace, requestId, messageId, index])));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 48);
}
export function validateImage(buffer, declaredType) {
  if (buffer instanceof ArrayBuffer) buffer = new Uint8Array(buffer);
  if (!(buffer instanceof Uint8Array) || !buffer.length || buffer.length > IMAGE_LIMIT) throw invalid('图片为空、格式无效或超过 10 MB');
  const bytes = new Uint8Array(buffer);
  const match = values => values.every((value, index) => bytes[index] === value);
  const mimeType = match([137, 80, 78, 71, 13, 10, 26, 10]) ? 'image/png' : match([255, 216, 255]) ? 'image/jpeg' :
    match([82, 73, 70, 70]) && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value) ? 'image/webp' : null;
  if (!mimeType || (declaredType !== undefined && declaredType !== mimeType)) throw invalid('图片内容与格式不一致，仅支持 PNG、JPEG、WebP');
  return { buffer: bytes, mimeType, bytes: bytes.length };
}

/** No chrome, DOM, Node or remote-code dependencies: run inside an extension worker. */
export function createBrowserFeishuAdapter({ appId, appSecret, assistant = 'chatgpt', onMessage, onState = () => {} }, dependencies = {}) {
  if (!/^cli_[A-Za-z0-9_-]+$/.test(appId ?? '') || typeof appSecret !== 'string' || !appSecret.trim() || appSecret.length > 512 || typeof onMessage !== 'function') throw invalid('请填写有效的飞书应用配置');
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const Socket = dependencies.WebSocket ?? globalThis.WebSocket;
  const cryptoImpl = dependencies.crypto ?? globalThis.crypto;
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.setTimeout ?? globalThis.setTimeout;
  const cancelTimer = dependencies.clearTimeout ?? globalThis.clearTimeout;
  const wait = dependencies.wait ?? (ms => new Promise(resolve => schedule(resolve, ms)));
  const timeoutMs = dependencies.requestTimeoutMs ?? 20000;
  let active = false; let generation = 0; let socket = null; let initialized = false; let botOpenId;
  let token = null; let tokenTask = null; let startTask = null; let outbound = Promise.resolve(); let lastRequestAt = -Infinity;
  let pingTimer; let watchdog; let reconnectTimer; let attempts = 0;
  let wsConfig = { pingMs: 120000, reconnectMs: 5000, nonceMs: 1000, maxReconnects: -1 };
  const requests = new Set(); const acknowledgements = new Map(); const processing = new Map();
  const assembler = new EventAssembler({ now });
  function report(state, error) { try { onState({ state, ...(error ? { error } : {}) }); } catch {} }
  function current(epoch) { if (!active || epoch !== generation) throw new FeishuTransportError('飞书连接已停止', { code: 'stopped' }); }
  function assertReady(epoch) { current(epoch); if (!initialized) throw new FeishuTransportError('飞书尚未完成连接', { code: 'not_ready' }); }
  function clean(error) { return error instanceof FeishuTransportError ? error : new FeishuTransportError('飞书连接或接口请求失败，请检查网络和应用配置'); }
  async function readBounded(response, limit) {
    if (Number(response.headers.get('content-length')) > limit) throw invalid('飞书响应超过允许大小');
    const reader = response.body?.getReader();
    if (!reader) throw new FeishuTransportError('飞书响应为空');
    const chunks = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw invalid('飞书响应超过允许大小'); chunks.push(value); }
      const output = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
      return output;
    } finally { reader.cancel().catch(() => {}); }
  }
  async function http(path, { epoch, method = 'GET', data, authorization, binary = false } = {}) {
    current(epoch);
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || !['/callback/ws/endpoint', '/open-apis/auth/v3/tenant_access_token/internal', '/open-apis/bot/v3/info'].includes(url.pathname) && !/^\/open-apis\/im\/v1\/(?:images|messages\/[A-Za-z0-9_-]+(?:\/reply|\/resources\/[A-Za-z0-9_-]+)?)$/.test(url.pathname)) throw invalid('不允许的飞书接口');
    const controller = new AbortController(); requests.add(controller);
    const timer = schedule(() => controller.abort(), timeoutMs);
    try {
      const multipart = data instanceof FormData;
      const response = await fetchImpl(url.href, { method, headers: { ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}), ...(data === undefined || multipart ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : multipart ? data : JSON.stringify(data), signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      const raw = await readBounded(response, binary ? IMAGE_LIMIT : 2 * 1024 * 1024);
      current(epoch);
      if (controller.signal.aborted) throw new FeishuTransportError('飞书请求超时或已取消');
      const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (binary && response.ok && mimeType !== 'application/json') {
        if (mimeType && mimeType !== 'application/octet-stream' && !mimeType.startsWith('image/')) throw invalid('飞书返回的资源不是图片');
        return validateImage(raw, mimeType.startsWith('image/') ? mimeType : undefined);
      }
      let body;
      try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new FeishuTransportError('飞书接口确认不完整'); }
      if (!response.ok || body?.code !== 0) {
        const error = failure(Number(body?.code), response.status);
        // Only a definitive token rejection can retry a mutation; unknown
        // network outcomes are retried by the durable owner with the same UUID.
        if ([99991661, 99991663, 99991664, 99991668].includes(Number(body?.code))) error.tokenRejected = true;
        throw error;
      }
      return body;
    } catch (error) { throw clean(error); }
    finally { cancelTimer(timer); requests.delete(controller); }
  }
  async function tenantToken(epoch) {
    current(epoch);
    if (token && token.expiresAt > now()) return token.value;
    if (!tokenTask) {
      const task = (async () => {
        const body = await http('/open-apis/auth/v3/tenant_access_token/internal', { epoch, method: 'POST', data: { app_id: appId, app_secret: appSecret } });
        if (typeof body.tenant_access_token !== 'string' || !body.tenant_access_token || !Number.isFinite(body.expire) || body.expire <= 0) throw new FeishuTransportError('飞书应用令牌确认不完整');
        current(epoch);
        token = { value: body.tenant_access_token, expiresAt: now() + Math.max(1, body.expire - Math.min(180, body.expire / 10)) * 1000 };
        return token.value;
      })();
      tokenTask = task;
      task.finally(() => { if (tokenTask === task) tokenTask = null; }).catch(() => {});
    }
    return tokenTask;
  }
  async function authenticated(path, options) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const authorization = await tenantToken(options.epoch);
      try { return await http(path, { ...options, authorization }); }
      catch (error) { if (!attempt && error.tokenRejected) { token = null; continue; } throw error; }
    }
  }
  function configFrom(value = {}) {
    const seconds = (number, fallback, min, max) => Number.isFinite(number) ? Math.max(min, Math.min(max, number * 1000)) : fallback;
    wsConfig = {
      pingMs: seconds(value.PingInterval, wsConfig.pingMs, 1000, 300000),
      reconnectMs: seconds(value.ReconnectInterval, wsConfig.reconnectMs, 1000, 120000),
      nonceMs: seconds(value.ReconnectNonce, wsConfig.nonceMs, 0, 30000),
      maxReconnects: Number.isInteger(value.ReconnectCount) && value.ReconnectCount >= -1 ? value.ReconnectCount : wsConfig.maxReconnects,
    };
  }
  function clearConnectionTimers() { for (const timer of [pingTimer, watchdog]) cancelTimer(timer); pingTimer = watchdog = undefined; }
  function sendFrame(ws, frame) { if (ws === socket && ws.readyState === 1) ws.send(encodeFrame(frame)); }
  function ping(ws, epoch, service) {
    if (!active || generation !== epoch || ws !== socket || ws.readyState !== 1) return;
    try { sendFrame(ws, { SeqID: 0n, LogID: 0n, method: 0, service, headers: [{ key: 'type', value: 'ping' }] }); }
    catch { ws.close(); return; }
    cancelTimer(watchdog);
    watchdog = schedule(() => { if (ws === socket) ws.close(); }, Math.min(30000, wsConfig.pingMs));
    pingTimer = schedule(() => ping(ws, epoch, service), wsConfig.pingMs);
  }
  function acknowledge(ws, frame, code, duration) {
    sendFrame(ws, { ...frame, headers: [...frame.headers.filter(header => header.key !== 'biz_rt'), { key: 'biz_rt', value: String(Math.max(0, duration)) }], payload: encoder.encode(JSON.stringify({ code })) });
  }
  async function handleFrame(ws, epoch, value) {
    current(epoch); if (ws !== socket) return;
    const frame = decodeFrame(value); const headers = frameHeaders(frame);
    cancelTimer(watchdog); watchdog = undefined;
    if (frame.method === 0) {
      if (headers.type === 'pong' && frame.payload?.length) { let body; try { body = JSON.parse(new TextDecoder().decode(frame.payload)); } catch { throw invalid('飞书心跳数据无效'); } configFrom(body); }
      return;
    }
    if (frame.method !== 1 || headers.type !== 'event') return;
    for (const [id, at] of acknowledgements) if (now() - at > 10 * 60000) acknowledgements.delete(id);
    if (acknowledgements.has(headers.message_id)) { acknowledge(ws, frame, 200, 0); return; }
    const merged = assembler.add(frame); if (!merged) return;
    const begin = now();
    let task = processing.get(merged.messageId);
    if (!task) {
      task = (async () => {
        const payload = merged.payload;
        if (payload.header?.app_id && payload.header.app_id !== appId) throw invalid('飞书事件应用标识不匹配');
        const message = normalizeMessage(payload, botOpenId);
        if (message) await onMessage(message); // owner must durably ingest before ACK
        current(epoch);
        acknowledgements.set(merged.messageId, now());
        while (acknowledgements.size > 1024) acknowledgements.delete(acknowledgements.keys().next().value);
      })();
      processing.set(merged.messageId, task);
    }
    try { await task; current(epoch); acknowledge(ws, frame, 200, now() - begin); }
    catch { if (active && generation === epoch) { acknowledge(ws, frame, 500, now() - begin); report('connected', '飞书事件未完成持久化，将等待官方重试'); } }
    finally { if (processing.get(merged.messageId) === task) processing.delete(merged.messageId); }
  }
  function reconnect(epoch, error) {
    if (!active || epoch !== generation || reconnectTimer !== undefined) return;
    if (error?.retryable === false || (wsConfig.maxReconnects >= 0 && attempts >= wsConfig.maxReconnects)) { report('error', clean(error).message); return; }
    attempts++;
    report('reconnecting', '飞书长连接已断开，正在自动重连');
    reconnectTimer = schedule(() => {
      reconnectTimer = undefined;
      (initialized ? connect(epoch) : initialize(epoch)).catch(next => reconnect(epoch, clean(next)));
    }, wsConfig.reconnectMs + Math.floor((dependencies.random ?? Math.random)() * wsConfig.nonceMs));
  }
  async function connect(epoch) {
    current(epoch);
    const body = await http('/callback/ws/endpoint', { epoch, method: 'POST', data: { AppID: appId, AppSecret: appSecret } });
    const endpoint = validateWebSocketEndpoint(body.data?.URL); configFrom(body.data?.ClientConfig);
    current(epoch);
    await new Promise((resolve, reject) => {
      let opened = false; let settled = false; let handshake;
      const ws = new Socket(endpoint.url); socket = ws; ws.binaryType = 'arraybuffer';
      const rejectOnce = () => { if (!settled) { settled = true; reject(new FeishuTransportError('飞书长连接建立失败')); } };
      handshake = schedule(() => { rejectOnce(); ws.close(); }, timeoutMs);
      ws.addEventListener('open', () => {
        cancelTimer(handshake);
        if (!active || generation !== epoch || ws !== socket) { ws.close(); rejectOnce(); return; }
        opened = true; settled = true; attempts = 0; report('connected'); ping(ws, epoch, endpoint.service); resolve();
      });
      ws.addEventListener('message', event => {
        if (!active || generation !== epoch || ws !== socket) return;
        const data = event.data instanceof Blob ? event.data.arrayBuffer() : Promise.resolve(event.data);
        data.then(value => handleFrame(ws, epoch, value)).catch(() => { if (active && generation === epoch && ws === socket) report('connected', '飞书长连接收到无法处理的数据，将等待官方重试'); });
      });
      ws.addEventListener('error', () => { if (!opened) { rejectOnce(); ws.close(); } });
      ws.addEventListener('close', () => {
        cancelTimer(handshake); rejectOnce();
        if (ws !== socket) return;
        socket = null; clearConnectionTimers(); assembler.clear();
        if (opened) reconnect(epoch, new FeishuTransportError('飞书长连接断开'));
      });
    });
  }
  async function initialize(epoch) {
    try {
      const bot = await authenticated('/open-apis/bot/v3/info', { epoch });
      const ownId = bot.bot?.open_id ?? bot.data?.bot?.open_id;
      if (!identifier(ownId)) throw new FeishuTransportError('飞书机器人身份确认不完整');
      current(epoch); botOpenId = ownId; initialized = true;
      await connect(epoch);
    } catch (error) {
      if (active && generation === epoch) {
        reconnect(epoch, clean(error));
      }
      throw clean(error);
    }
  }
  function start() {
    if (active) return startTask ?? Promise.resolve();
    active = true; attempts = 0; const epoch = ++generation; report('connecting');
    const task = initialize(epoch); startTask = task;
    task.finally(() => { if (startTask === task) startTask = null; }).catch(() => {});
    return task;
  }
  async function stop() {
    active = false; generation++; initialized = false; token = null; tokenTask = null; botOpenId = undefined;
    cancelTimer(reconnectTimer); reconnectTimer = undefined; clearConnectionTimers();
    for (const controller of requests) controller.abort();
    const previous = socket; socket = null; try { previous?.close(); } catch {}
    assembler.clear(); acknowledgements.clear(); processing.clear(); startTask = null;
    report('stopped');
  }
  async function paced(epoch, path, options) {
    assertReady(epoch);
    const remaining = 250 - (now() - lastRequestAt); if (remaining > 0) await wait(remaining);
    assertReady(epoch); lastRequestAt = now();
    return authenticated(path, { ...options, epoch });
  }
  function enqueue(operation) {
    const epoch = generation;
    const run = async () => { assertReady(epoch); try { return await operation(epoch); } catch (error) { throw clean(error); } };
    const task = outbound.then(run, run); outbound = task.catch(() => {}); return task;
  }
  function receipt(body) { if (!identifier(body?.data?.message_id)) throw new FeishuTransportError('飞书消息确认缺少有效消息 ID'); return { messageId: body.data.message_id }; }
  function reply(messageId, text, requestId) {
    if (!identifier(messageId) || !requestIdValid(requestId)) return Promise.reject(invalid('飞书回复标识无效'));
    let parts; try { parts = splitReplyText(text); } catch { return Promise.reject(invalid('飞书回复正文无效')); }
    return enqueue(async epoch => {
      for (let index = 0; index < parts.length; index++) receipt(await paced(epoch, `/open-apis/im/v1/messages/${messageId}/reply`, { method: 'POST', data: { msg_type: 'text', content: JSON.stringify({ text: parts[index] }), uuid: await transportUuid('feishu-reply-v1', requestId, messageId, index, cryptoImpl) } }));
    });
  }
  function createCard(messageId, requestId) {
    if (!identifier(messageId) || !requestIdValid(requestId)) return Promise.reject(invalid('飞书卡片标识无效'));
    return enqueue(async epoch => receipt(await paced(epoch, `/open-apis/im/v1/messages/${messageId}/reply`, { method: 'POST', data: { msg_type: 'interactive', content: JSON.stringify(buildCards({ state: 'queued', assistant })[0]), uuid: await transportUuid('feishu-card-queued-v1', requestId, messageId, 0, cryptoImpl) } })));
  }
  function replyPost(messageId, post, requestId) {
    if (!identifier(messageId) || !requestIdValid(requestId)) return Promise.reject(invalid('飞书富文本回复标识无效'));
    let content;
    try { content = serializeAnswerPost(post); } catch { return Promise.reject(invalid('飞书富文本回复正文无效或超过分段大小限制')); }
    return enqueue(async epoch => {
      const uuid = await transportUuid('feishu-answer-post-v1', requestId, messageId, 0, cryptoImpl);
      return { ...receipt(await paced(epoch, `/open-apis/im/v1/messages/${messageId}/reply`, { method: 'POST', data: { msg_type: 'post', content, uuid } })), uuid };
    });
  }
  function updateCard(cardMessageId, { state, text, requestId, sourceMessageId } = {}) {
    if (!identifier(cardMessageId) || !identifier(sourceMessageId) || !requestIdValid(requestId) || !['running', 'sending', 'completed', 'failed', 'blocked', 'cancelled'].includes(state)) return Promise.reject(invalid('飞书卡片更新参数无效'));
    let cards; try { cards = buildCards({ state, text, assistant }); } catch { return Promise.reject(invalid('飞书卡片正文无效')); }
    return enqueue(async epoch => {
      await paced(epoch, `/open-apis/im/v1/messages/${cardMessageId}`, { method: 'PATCH', data: { content: JSON.stringify(cards[0]) } });
      for (let index = 1; index < cards.length; index++) receipt(await paced(epoch, `/open-apis/im/v1/messages/${sourceMessageId}/reply`, { method: 'POST', data: { msg_type: 'interactive', content: JSON.stringify(cards[index]), uuid: await transportUuid('feishu-card-continuation-v1', requestId, sourceMessageId, index, cryptoImpl) } }));
    });
  }
  function uploadImage({ buffer, mimeType } = {}) {
    let image; try { image = validateImage(buffer, mimeType); } catch (error) { return Promise.reject(error); }
    return enqueue(async epoch => {
      const form = new FormData(); form.append('image_type', 'message'); form.append('image', new Blob([image.buffer], { type: image.mimeType }), 'bridge.' + { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[image.mimeType]);
      const body = await paced(epoch, '/open-apis/im/v1/images', { method: 'POST', data: form });
      if (!identifier(body.data?.image_key)) throw new FeishuTransportError('飞书图片上传未返回有效 image_key');
      const digest = await cryptoImpl.subtle.digest('SHA-256', image.buffer);
      return { imageKey: body.data.image_key, mimeType: image.mimeType, bytes: image.bytes, sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
    });
  }
  function replyImage({ messageId, imageKey, requestId, index = 0 } = {}) {
    if (!identifier(messageId) || !identifier(imageKey) || !requestIdValid(requestId) || !Number.isInteger(index) || index < 0 || index > 10000) return Promise.reject(invalid('飞书图片回复标识无效'));
    return enqueue(async epoch => {
      const uuid = await transportUuid('feishu-image-reply-v1', requestId, messageId, index, cryptoImpl);
      return { ...receipt(await paced(epoch, `/open-apis/im/v1/messages/${messageId}/reply`, { method: 'POST', data: { msg_type: 'image', content: JSON.stringify({ image_key: imageKey }), uuid } })), imageKey, uuid };
    });
  }
  function downloadImage({ messageId, imageKey } = {}) {
    if (!identifier(messageId) || !identifier(imageKey) || !imageKey.startsWith('img_')) return Promise.reject(invalid('飞书图片来源标识无效'));
    return enqueue(async epoch => {
      const image = await paced(epoch, `/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`, { binary: true });
      if (!(image?.buffer instanceof Uint8Array)) throw new FeishuTransportError('飞书图片响应不完整');
      return { buffer: image.buffer, mimeType: image.mimeType };
    });
  }
  return { start, stop, reply, replyPost, createCard, updateCard, uploadImage, replyImage, downloadImage };
}
