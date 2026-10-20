'use strict';
// 面板前端：只与面板同源的 /api/* 通信，从不直连 CDP、从不接触口令以外的任何凭据。
const $ = id => document.getElementById(id);
const ASSISTANTS = ['chatgpt', 'claude', 'gemini', 'qwen', 'hark'];
const NAMES = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', qwen: 'Qwen', hark: 'Hark' };
const PLATFORMS = { qq: 'QQ', feishu: '飞书' };
const JOB_STATES = {
  queued: '排队中', leased: '等待网页', started: '网页生成中', running: '网页生成中', generating: '网页生成中',
  sending: '发送中', delivering: '发送中', completed: '网页已完成', failed: '已停止', cancelled: '已取消',
  result_pending: '等待回传', 'result-pending': '等待回传', pending: '等待中',
};
const CONN_STATES = { connected: '已连接', connecting: '连接中', reconnecting: '重连中', error: '连接异常', stopped: '未连接' };

let csrf = null;
let activeAssistant = 'chatgpt';
let activePlatform = 'qq';
let statuses = {};
let busy = false;
const drafts = new Map();
// 只有用户真正改过的字段才进草稿。否则切助手时会把刚渲染出来的空文本框
// 存成草稿，再切回来就把真实词表/AppID 覆盖成空。
const dirty = new Set();

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function api(path, body, { method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (csrf) headers['X-Panel-CSRF'] = csrf;
  const response = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error('面板返回了无法解析的响应'); }
  if (response.status === 401 && path !== '/api/login') { showLogin(); throw new Error('登录已过期，请重新登录'); }
  if (!data || data.ok !== true) throw Object.assign(new Error((data && data.error) || '请求失败'), { status: response.status });
  return data;
}

async function rpc(type, payload = {}) {
  const data = await api('/api/rpc', { type, ...payload });
  return data.data;
}

function feedback(text, isError = false) {
  const banner = $('feedback');
  banner.hidden = false;
  banner.className = 'feedback' + (isError ? ' error' : '');
  banner.textContent = text;
}

function showLogin() {
  csrf = null;
  $('app').hidden = true;
  $('login').hidden = false;
  $('token').focus();
}

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
}

async function login(event) {
  event.preventDefault();
  $('login-error').textContent = '';
  const token = $('token').value;
  try {
    const data = await api('/api/login', { token });
    csrf = data.csrf;
    $('token').value = '';
    showApp();
    await refresh();
  } catch (error) {
    $('login-error').textContent = error.message;
  }
}

async function logout() {
  try { await api('/api/logout', {}); } catch { /* 会话可能已失效，忽略 */ }
  showLogin();
}

function scope() { return { assistant: activeAssistant, platform: activePlatform }; }
function scopeLabel() { return NAMES[activeAssistant] + ' · ' + PLATFORMS[activePlatform]; }
function scopeKey() { return activeAssistant + ':' + activePlatform; }

function saveDraft() {
  const key = scopeKey();
  if (!statuses[activeAssistant] || !dirty.size) return;
  const previous = drafts.get(key) || {};
  const next = { ...previous };
  if (dirty.has('app-id')) next.appId = $('app-id').value;
  if (dirty.has('words')) next.words = $('words').value;
  if (dirty.has('group')) next.group = $('group').value;
  if (dirty.has('tab')) next.tab = $('tab').value;
  drafts.set(key, next);
  for (const field of ['app-id', 'words', 'group', 'tab']) dirty.delete(field);
}

function controls() {
  const status = statuses[activeAssistant];
  const channel = status && status.platforms ? status.platforms[activePlatform] : null;
  const disabled = busy || !status;
  for (const button of document.querySelectorAll('#app button, #app input, #app select, #app textarea')) {
    if (button.id === 'refresh' || button.id === 'logout') continue;
    button.disabled = disabled;
  }
  $('enabled-assistant').disabled = disabled;
  $('enabled-channel').disabled = disabled || !channel;
  for (const assistant of ASSISTANTS) {
    const card = $('card-' + assistant);
    if (!card) continue;
    card.classList.toggle('selected', assistant === activeAssistant);
    card.querySelector('button').disabled = busy || assistant === activeAssistant;
  }
  for (const platform of Object.keys(PLATFORMS)) {
    const tab = $('tab-' + platform);
    if (!tab) continue;
    tab.classList.toggle('active', platform === activePlatform);
    tab.disabled = busy || platform === activePlatform;
  }
}

function renderAssistants() {
  const container = $('assistants');
  container.replaceChildren();
  for (const assistant of ASSISTANTS) {
    const summary = statuses[assistant];
    const card = el('div', undefined, 'assistant');
    card.id = 'card-' + assistant;
    if (assistant === activeAssistant) card.classList.add('selected');

    const head = el('div', undefined, 'assistant-head');
    head.append(el('span', NAMES[assistant], 'assistant-name'));
    const enabled = el('span', summary && summary.enabled ? '已开启' : '已停用');
    enabled.style.fontSize = '11px';
    head.append(enabled);
    card.append(head);

    const parts = [];
    if (summary && summary.platforms) {
      for (const platform of Object.keys(PLATFORMS)) {
        const channel = summary.platforms[platform];
        parts.push(PLATFORMS[platform] + ' ' + (channel.enabled ? (channel.connection && CONN_STATES[channel.connection.state] || '已启用') : '已停用'));
      }
    }
    card.append(el('p', parts.join(' · ') || '状态尚未确认'));

    const button = el('button', assistant === activeAssistant ? '正在配置' : '配置 ' + NAMES[assistant]);
    button.type = 'button';
    button.addEventListener('click', () => selectAssistant(assistant));
    card.append(button);
    container.append(card);
  }
}

function renderPlatforms() {
  const container = $('platforms');
  const existing = [...container.querySelectorAll('button')];
  if (existing.length) {
    for (const button of existing) button.classList.toggle('active', button.dataset.platform === activePlatform);
    return;
  }
  for (const platform of Object.keys(PLATFORMS)) {
    const button = el('button', PLATFORMS[platform]);
    button.type = 'button';
    button.id = 'tab-' + platform;
    button.dataset.platform = platform;
    if (platform === activePlatform) button.classList.add('active');
    button.addEventListener('click', () => selectPlatform(platform));
    container.append(button);
  }
}

function renderScope(status) {
  const agentName = NAMES[activeAssistant];
  $('scope-title').textContent = scopeLabel();
  $('enabled-assistant').checked = Boolean(status.enabled);
  const channel = status.platforms && status.platforms[activePlatform];
  $('enabled-channel').checked = Boolean(channel && channel.enabled);
  $('enabled-channel').disabled = !channel;

  const draft = drafts.get(scopeKey()) || {};
  $('app-id').value = draft.appId ?? (status.appId || '');
  $('app-secret').value = '';
  // 词表与标签页不在 options:status 里，由 refresh() 单独取，挂在 status 上。
  $('words').value = draft.words ?? (Array.isArray(status.words) ? status.words.join('\n') : '');

  $('group').replaceChildren(new Option('选择群，或手动填写群标识', ''));
  for (const group of status.groups || []) {
    $('group').add(new Option((group.name || group.chatId) + (group.binding ? ' · 已绑定' : ''), group.chatId));
  }
  if (draft.group) $('group').value = draft.group;

  $('tab').replaceChildren(new Option('选择已打开的 ' + agentName + ' 对话', ''));
  for (const tab of status.tabs || []) {
    $('tab').add(new Option(tab.title + '（标签页 ' + tab.tabId + '）', String(tab.tabId)));
  }
  if (draft.tab) $('tab').value = draft.tab;

  const connection = (channel && channel.connection && channel.connection.state) || 'stopped';
  const bound = (status.groups || []).filter(group => group.binding).length;
  // 顶部状态条始终反映当前助手+平台，切换助手时也要跟着变。
  $('conn').textContent = scopeLabel() + ' · ' + (CONN_STATES[connection] || connection);
  $('conn').className = 'pill' + (connection === 'connected' ? ' ok' : connection === 'error' ? ' bad' : '');
  const line = $('state-line');
  if (!status.enabled) line.textContent = '助手已停用：可以保存凭据、词表和绑定，打开开关后才接群消息。';
  else if (!channel || !channel.enabled) line.textContent = '此通道已停用：打开通道开关后才会接收群提问。';
  else if (connection === 'connected') line.textContent = bound ? '已连接，已绑定 ' + bound + ' 个群。' : '已连接，下一步绑定群与对话。';
  else if (connection === 'error') line.textContent = '连接异常：' + ((channel.connection && channel.connection.error) || '请检查凭据与网络');
  else line.textContent = '连接状态：' + (CONN_STATES[connection] || connection);
}

function renderBindings(status) {
  const container = $('bindings');
  container.replaceChildren();
  const bound = (status.groups || []).filter(group => group.binding);
  for (const group of bound) {
    const item = el('div', undefined, 'item');
    const detail = el('div');
    detail.append(el('strong', group.name || group.chatId));
    detail.append(el('p', group.binding.conversationUrl));
    detail.append(el('small', '标签页 ' + group.binding.tabId + ' · ' + group.chatId));
    const actions = el('div', undefined, 'actions');
    const button = el('button', '解除绑定', 'danger');
    button.type = 'button';
    button.addEventListener('click', () => run(async () => {
      await rpc('options:unbind', { ...scope(), chatId: group.chatId });
      feedback('已解除 ' + scopeLabel() + ' 的群绑定。');
      await refresh();
    }));
    actions.append(button);
    item.append(detail, actions);
    container.append(item);
  }
  if (!container.childElementCount) container.append(el('p', '尚未绑定会话。', 'empty'));
}

function renderJobs(status) {
  const container = $('jobs');
  container.replaceChildren();
  const jobs = status.jobs || [];
  for (const job of jobs.slice(0, 15)) {
    const item = el('div', undefined, 'item');
    const detail = el('div');
    detail.append(el('strong', job.chatId));
    detail.append(el('p', job.error || ('任务 ' + job.id)));
    detail.append(el('small', new Date(job.createdAt).toLocaleString()));
    if (job.timing) {
      const timing = Object.entries({
        handoffMs: '收到→网页接手', inputPreparationMs: '输入准备', confirmationMs: '完成确认',
        imagePreparationMs: '图片准备', queueMs: '发送排队', deliveryMs: '平台回传',
      }).filter(([key]) => Number.isFinite(job.timing[key])).map(([key, label]) => label + ' ' + (job.timing[key] / 1000).toFixed(1) + 's');
      if (timing.length) detail.append(el('small', timing.join(' · ')));
    }
    const actions = el('div', undefined, 'actions');
    const state = el('span', JOB_STATES[job.state] || job.state, 'state' + (job.state === 'failed' ? ' failed' : ''));
    actions.append(state);
    if (job.state === 'queued') {
      const cancel = el('button', '取消', 'danger');
      cancel.type = 'button';
      cancel.addEventListener('click', () => run(async () => {
        cancel.textContent = '取消中…';
        await rpc('options:cancel-job', { ...scope(), jobId: job.id });
        feedback('已取消排队任务。');
        await refresh();
      }));
      actions.append(cancel);
    }
    item.append(detail, actions);
    container.append(item);
  }
  if (!container.childElementCount) container.append(el('p', '暂无任务。', 'empty'));
}

async function refresh() {
  if (busy) return;
  busy = true;
  controls();
  try {
    const results = await Promise.all(ASSISTANTS.map(assistant => rpc('options:status', { assistant }).catch(error => ({ __error: error.message }))));
    statuses = {};
    let failure = null;
    ASSISTANTS.forEach((assistant, index) => {
      const result = results[index];
      if (result && result.__error) { failure = failure || result.__error; return; }
      statuses[assistant] = result;
    });
    renderAssistants();
    renderPlatforms();
    const status = statuses[activeAssistant];
    if (!status) {
      feedback(failure || '无法读取 ' + NAMES[activeAssistant] + ' 的状态', true);
      $('conn').textContent = '扩展后台不可用';
      $('conn').className = 'pill bad';
      return;
    }
    await loadScope(activeAssistant, activePlatform);
    if (failure) feedback(failure, true);
    renderScope(status);
    renderBindings(status);
    renderJobs(status);
  } catch (error) {
    feedback(error.message, true);
  } finally {
    busy = false;
    controls();
  }
}

// 词表与已打开对话不在 options:status 里，必须按「助手 + 平台」单独取。
// 切换助手/平台时也要重新取，否则会拿着另一个 scope 的空值渲染。
async function loadScope(assistant, platform) {
  const target = statuses[assistant];
  if (!target) return;
  const [tabsResult, wordsResult] = await Promise.all([
    rpc('options:tabs', { assistant, platform }).catch(() => ({ tabs: [] })),
    rpc('options:moderation', { assistant, platform }).catch(() => null),
  ]);
  target.tabs = (tabsResult && Array.isArray(tabsResult.tabs)) ? tabsResult.tabs : [];
  target.words = (wordsResult && Array.isArray(wordsResult.words)) ? wordsResult.words : [];
}

async function run(task) {
  if (busy) return;
  busy = true;
  controls();
  let succeeded = false;
  try { await task(); succeeded = true; }
  catch (error) { feedback(error.message, true); }
  finally { busy = false; controls(); }
  // 任务里的 refresh() 会被 busy 挡住，所以成功后在锁外面统一重读状态。
  if (succeeded) await refresh();
}

async function selectScope() {
  controls();
  const status = statuses[activeAssistant];
  if (!status) return;
  renderScope(status);
  renderBindings(status);
  renderJobs(status);
  await loadScope(activeAssistant, activePlatform);
  renderScope(status);
  controls();
}

async function selectAssistant(assistant) {
  if (busy || assistant === activeAssistant) return;
  saveDraft();
  activeAssistant = assistant;
  renderAssistants();
  renderPlatforms();
  busy = true;
  try { await selectScope(); }
  catch (error) { feedback(error.message, true); }
  finally { busy = false; controls(); }
}

async function selectPlatform(platform) {
  if (busy || platform === activePlatform) return;
  saveDraft();
  activePlatform = platform;
  renderPlatforms();
  busy = true;
  try { await selectScope(); }
  catch (error) { feedback(error.message, true); }
  finally { busy = false; controls(); }
}

function wire() {
  for (const field of ['app-id', 'words', 'group', 'tab']) {
    const node = $(field);
    node.addEventListener('input', () => dirty.add(field));
    node.addEventListener('change', () => dirty.add(field));
  }
  $('login-form').addEventListener('submit', login);
  $('refresh').addEventListener('click', () => refresh());
  $('logout').addEventListener('click', logout);

  $('enabled-assistant').addEventListener('change', () => run(async () => {
    const enabled = $('enabled-assistant').checked;
    await rpc('options:assistant', { assistant: activeAssistant, enabled });
    feedback(NAMES[activeAssistant] + (enabled ? ' 已开启。' : ' 已停用。'));
    await refresh();
  }));

  $('enabled-channel').addEventListener('change', () => run(async () => {
    const enabled = $('enabled-channel').checked;
    await rpc('options:channel', { ...scope(), enabled });
    feedback(PLATFORMS[activePlatform] + ' 通道' + (enabled ? '已开启。' : '已停用。'));
    await refresh();
  }));

  $('save-app').addEventListener('click', () => run(async () => {
    const appId = $('app-id').value.trim();
    const appSecret = $('app-secret').value.trim();
    await rpc('options:config', { ...scope(), appId, appSecret });
    $('app-secret').value = '';
    feedback('凭据已保存。');
    await refresh();
  }));

  $('bind').addEventListener('click', () => run(async () => {
    const tabId = Number($('tab').value);
    const chatId = $('group').value;
    if (!chatId) throw new Error('请先选择一个群');
    const tabs = (statuses[activeAssistant] && statuses[activeAssistant].tabs) || [];
    const tab = tabs.find(item => item.tabId === tabId);
    if (!tab) throw new Error('请选择一个已打开的对话');
    await rpc('options:bind', { ...scope(), chatId, tabId, conversationUrl: tab.conversationUrl });
    feedback('已绑定。');
    await refresh();
  }));

  $('save-words').addEventListener('click', () => run(async () => {
    const words = $('words').value.split('\n').map(line => line.trim()).filter(Boolean);
    const data = await rpc('options:save-words', { ...scope(), words });
    feedback('词表已保存，共 ' + (data && data.count ? data.count : words.length) + ' 条。');
    await refresh();
  }));

  $('clear-history').addEventListener('click', () => run(async () => {
    await rpc('options:clear-history', { ...scope() });
    feedback('已清除记录。');
    await refresh();
  }));

  $('clear-notices').addEventListener('click', () => run(async () => {
    await rpc('options:clear-notices', { ...scope() });
    feedback('已清除历史提示。');
    await refresh();
  }));
}

async function boot() {
  wire();
  try {
    const session = await api('/api/session', undefined, { method: 'GET' });
    if (session.authenticated) { csrf = session.csrf; showApp(); await refresh(); }
    else showLogin();
  } catch { showLogin(); }
}

void boot();
