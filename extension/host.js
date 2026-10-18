// The offscreen document owns a dedicated Worker; closing settings does not
// close the selected platform WebSocket or interrupt durable image transfers.
const engine = new Worker(new URL('./engine.js', import.meta.url), { type: 'module' });
const pending = new Map();
let failed = false;
engine.addEventListener('message', event => {
  if (event.data?.type === 'bridge:work-available') {
    // A wake carries no task data and must never consume an RPC response.
    if (!failed && !Array.isArray(event.data) && Object.keys(event.data).length === 1) {
      Promise.resolve().then(() => chrome.runtime.sendMessage({ type: 'bridge:work-available' })).catch(() => {});
    }
    return;
  }
  const request = pending.get(event.data?.id);
  if (!request) return;
  clearTimeout(request.timer); pending.delete(event.data.id); request.resolve(event.data);
});
engine.addEventListener('error', () => {
  failed = true;
  for (const request of pending.values()) { clearTimeout(request.timer); request.resolve({ ok: false, status: 503, error: '扩展后台已中断，请重新加载扩展' }); }
  pending.clear();
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'bridge-host') return false;
  const workerUrl = chrome.runtime.getURL('worker.js');
  if (sender.id !== chrome.runtime.id || sender.tab || (sender.url && sender.url !== workerUrl)) {
    respond({ ok: false, status: 403, error: '拒绝非扩展后台请求' }); return false;
  }
  if (failed) { respond({ ok: false, status: 503, error: '扩展后台已中断，请重新加载扩展' }); return false; }
  const id = crypto.randomUUID();
  const timer = setTimeout(() => { pending.delete(id); respond({ ok: false, status: 503, error: '扩展后台响应超时，任务不会重新提交' }); }, 25000);
  pending.set(id, { timer, resolve: respond });
  try { engine.postMessage({ id, route: message.route, body: message.body }); }
  catch { clearTimeout(timer); pending.delete(id); respond({ ok: false, status: 503, error: '扩展后台暂时无法处理请求' }); }
  return true;
});
