#!/usr/bin/env node
// Hark (hark.com) DOM calibration probe - read-only.
//
// Connects to an already running Chromium over the DevTools Protocol (raw
// WebSocket, no puppeteer) and evaluates one self-contained probe function in
// the hark.com tab. The probe never types, clicks, navigates or reads
// credentials: it only enumerates live DOM structure so extension/hark-dom.js
// can be written against observed selectors instead of guesses.
//
//   node scripts/hark-dom-probe.js --port 9222 --out scripts/hark-probe-result.json
//
// Exit codes: 0 ok, 1 probe reported ok:false, 2 transport/usage failure.
import fs from 'node:fs';
import path from 'node:path';

const NL = String.fromCharCode(10);

class ProbeError extends Error {
  constructor(message, hint) { super(message); this.name = 'ProbeError'; this.hint = hint || ''; }
}

const USAGE = [
  'hark-dom-probe - 通过 CDP 只读探测 hark.com 页面的 DOM 结构',
  '',
  '用法:',
  '  node scripts/hark-dom-probe.js [选项]',
  '',
  '选项:',
  '  --port <n>           Chromium 远程调试端口（默认 9222）',
  '  --url-prefix <s>     按 URL 前缀匹配目标标签页（默认 hark.com）',
  '  --out <file>         JSON 结果写入文件（默认写 stdout）',
  '  --html <file>        额外保存页面 outerHTML 快照',
  '  --timeout <ms>       CDP 连接与求值总超时（默认 30000）',
  '  --settle <ms>        求值前等待输入框挂载的最长时间（默认 8000）',
  '  --list               只列出调试端口上的页面目标',
  '  -h, --help           显示本说明',
  '',
  '示例:',
  '  xvfb-run -a chromium --remote-debugging-port=9222 --remote-allow-origins=* https://hark.com/ &',
  '  node scripts/hark-dom-probe.js --port 9222 --out /tmp/hark.json --html /tmp/hark.html',
].join(NL);

function parseArgs(argv) {
  const options = { port: 9222, urlPrefix: 'hark.com', out: null, html: null, timeout: 30000, settle: 8000, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new ProbeError('参数 ' + flag + ' 缺少取值', '运行 --help 查看正确写法');
      return next;
    };
    switch (flag) {
      case '--port': options.port = Number.parseInt(value(), 10); break;
      case '--url-prefix': options.urlPrefix = value(); break;
      case '--out': options.out = value(); break;
      case '--html': options.html = value(); break;
      case '--timeout': options.timeout = Number.parseInt(value(), 10); break;
      case '--settle': options.settle = Number.parseInt(value(), 10); break;
      case '--list': options.list = true; break;
      case '-h': case '--help': options.help = true; break;
      default: throw new ProbeError('未知参数 ' + flag, '运行 --help 查看支持的参数');
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new ProbeError('--port 必须是 1..65535 的整数', '示例：--port 9222');
  if (!Number.isInteger(options.timeout) || options.timeout < 1000) throw new ProbeError('--timeout 必须 >= 1000 毫秒', '示例：--timeout 30000');
  if (!Number.isInteger(options.settle) || options.settle < 0) throw new ProbeError('--settle 必须是 >= 0 的毫秒数', '示例：--settle 8000');
  if (!options.urlPrefix) options.urlPrefix = 'hark.com';
  return options;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new ProbeError('调试端口返回 HTTP ' + response.status + '：' + url, '确认该端口确实是 Chromium 的 --remote-debugging-port');
    return await response.json();
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError('无法连接调试端口 ' + url, '请先以 --remote-debugging-port=' + new URL(url).port + ' 启动 Chromium（本脚本不会自行启动浏览器）');
  } finally {
    clearTimeout(timer);
  }
}

function openSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let socket;
    const timer = setTimeout(() => {
      try { socket?.close(); } catch {}
      reject(new ProbeError('调试 WebSocket 连接超时：' + url, '页面可能无响应，或该端口已被其他进程占用'));
    }, timeoutMs);
    try {
      socket = new WebSocket(url);
    } catch (error) {
      clearTimeout(timer);
      reject(new ProbeError('调试 WebSocket 地址无效：' + url, String((error && error.message) || error)));
      return;
    }
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(socket); }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new ProbeError('调试 WebSocket 握手失败：' + url, '新版 Chromium 需要以 --remote-allow-origins=* 启动，否则 CDP 会拒绝非浏览器来源的连接'));
    }, { once: true });
  });
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      if (!message || typeof message.id !== 'number') return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new ProbeError('CDP ' + entry.method + ' 失败：' + (message.error.message || 'unknown'), '页面可能已关闭或已被导航'));
      else entry.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new ProbeError('调试连接已关闭（' + entry.method + '）', '目标标签页可能已关闭或崩溃'));
      }
      this.pending.clear();
    });
  }

  send(method, params, timeoutMs) {
    const id = this.nextId++;
    const budget = timeoutMs || 30000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProbeError('CDP 调用超时：' + method, '页面主线程可能被阻塞；可放大 --timeout，或在网页处理遮罩/对话框后重试'));
      }, budget);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params: params || {} })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ProbeError('调试通道写入失败：' + method, String((error && error.message) || error)));
      }
    });
  }

  close() { try { this.socket.close(); } catch {} }
}

// Strip a scheme prefix without relying on regex escapes.
function stripScheme(value) {
  const text = String(value || '').toLowerCase();
  if (text.startsWith('https://')) return text.slice(8);
  if (text.startsWith('http://')) return text.slice(7);
  return text;
}

function matchTarget(tab, prefix) {
  const wanted = stripScheme(prefix);
  if (!wanted) return true;
  return stripScheme(tab.url).startsWith(wanted);
}

function listPageTargets(tabs, prefix) {
  return tabs.filter(tab => tab.type === 'page' && tab.webSocketDebuggerUrl).filter(tab => matchTarget(tab, prefix));
}

// ---------------------------------------------------------------------------
// Page-side probe. Runs inside the hark.com tab through Runtime.evaluate, so it
// must be fully self-contained: no imports, no outer-scope references, and no
// regex character-class escapes (they are rebuilt from char codes so the whole
// function survives being stringified into the page).
// ---------------------------------------------------------------------------
async function pageProbe(config) {
  const notes = [];
  const warnings = [];
  const CH = String.fromCharCode;
  const SPACE_CODES = new Set([9, 10, 13, 32, 160, 0x3000]);
  const AUTH_FIELD_HINT = /email|phone|password|username|sign in|log in|登录|邮箱|手机|密码/i;
  const truncate = (value, limit) => {
    const text = String(value == null ? '' : value);
    return text.length > limit ? text.slice(0, limit) + '...' : text;
  };
  const flatten = value => {
    const text = String(value == null ? '' : value);
    let out = '';
    let lastSpace = false;
    for (const character of text) {
      if (SPACE_CODES.has(character.charCodeAt(0))) {
        if (!lastSpace) { out += ' '; lastSpace = true; }
      } else { out += character; lastSpace = false; }
    }
    return out.trim();
  };
  const round = value => Math.round(value * 100) / 100;
  const isIdentChar = character => {
    const code = character.charCodeAt(0);
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45 || code === 95;
  };
  const isSimpleName = value => {
    if (!value || typeof value !== 'string') return false;
    const first = value.charCodeAt(0);
    const alpha = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
    if (!alpha) return false;
    for (const character of value) if (!isIdentChar(character)) return false;
    return true;
  };
  const isSimpleClass = value => Boolean(value) && typeof value === 'string' && [...value].every(isIdentChar);
  const hasQuoteOrBackslash = value => value.includes('"') || value.includes(CH(92));
  const deadline = Date.now() + (config.settleMs || 0);
  const rectOf = rect => ({ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });

  function visibility(node) {
    if (!node || node.nodeType !== 1 || !node.isConnected) return { visible: false, reason: 'detached' };
    const win = node.ownerDocument.defaultView;
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return { visible: false, reason: 'hidden-attr' };
      const style = win.getComputedStyle(current);
      if (style.display === 'none') return { visible: false, reason: 'display:none' };
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return { visible: false, reason: 'visibility:hidden' };
    }
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return { visible: false, reason: 'zero-size', rect: rectOf(rect) };
    return { visible: true, rect: rectOf(rect) };
  }

  function selectorOf(element) {
    const tag = element.tagName.toLowerCase();
    for (const attribute of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'aria-label', 'name', 'role']) {
      const value = element.getAttribute(attribute);
      if (value && value.length <= 60 && !hasQuoteOrBackslash(value)) return tag + '[' + attribute + '="' + value + '"]';
    }
    const classes = [...element.classList].filter(name => name.length <= 40 && isSimpleClass(name)).slice(0, 2);
    return classes.length ? tag + '.' + classes.join('.') : tag;
  }

  function cssPath(element) {
    if (!element || element.nodeType !== 1) return null;
    if (element === document.documentElement) return 'html';
    const id = element.id;
    if (id && isSimpleName(id)) {
      try { if (element.ownerDocument.querySelectorAll('#' + id).length === 1) return '#' + id; } catch {}
    }
    const parts = [];
    let current = element;
    let guard = 0;
    while (current && current.nodeType === 1 && current !== document.documentElement && guard++ < 14) {
      let segment = selectorOf(current);
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children];
        if (siblings.filter(child => child !== current && child.tagName === current.tagName).length) segment += ':nth-child(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(segment);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  const shadowHosts = [];
  const roots = [{ root: document, depth: 0, host: null }];
  function walkShadow(rootNode, depth) {
    if (depth > 5) return;
    for (const element of rootNode.querySelectorAll('*')) {
      if (!element.shadowRoot) continue;
      if (shadowHosts.length >= 40) return;
      const hostPath = cssPath(element);
      shadowHosts.push({ host: hostPath, depth: depth + 1, mode: 'open' });
      roots.push({ root: element.shadowRoot, depth: depth + 1, host: hostPath });
      walkShadow(element.shadowRoot, depth + 1);
    }
  }

  const COMPOSER_SELECTOR = 'textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], input[type="text"], input[type="search"]';
  const looksLikeComposer = node => {
    if (!node || node.nodeType !== 1) return false;
    if (node.tagName === 'TEXTAREA') return true;
    if (node.getAttribute('contenteditable') === 'true') return true;
    return node.getAttribute('role') === 'textbox';
  };

  let waited = 0;
  const settleLimit = config.settleMs || 0;
  while (waited < settleLimit) {
    if ([...document.querySelectorAll(COMPOSER_SELECTOR)].some(looksLikeComposer)) break;
    if (Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, 200));
    waited += 200;
  }
  if (settleLimit && waited >= settleLimit && ![...document.querySelectorAll(COMPOSER_SELECTOR)].some(looksLikeComposer)) {
    warnings.push('在 ' + settleLimit + 'ms 内未观察到任何输入框候选：SPA 可能仍在加载，或输入区位于跨域 iframe 内');
  }

  walkShadow(document, 0);

  // ---- attribute inventory: the raw material for stable selectors ---------
  const attributeInventory = {};
  for (const attribute of ['data-testid', 'data-test-id', 'data-qa', 'data-message-author-role', 'data-message-id', 'data-turn', 'data-role', 'data-author', 'data-composer-markdown', 'data-slot', 'data-state', 'aria-label', 'placeholder', 'contenteditable']) {
    const seen = new Map();
    for (const { root } of roots) {
      for (const element of root.querySelectorAll('[' + attribute + ']')) {
        const value = element.getAttribute(attribute) || '';
        if (value.length > 80) continue;
        const key = element.tagName.toLowerCase() + '|' + value;
        seen.set(key, (seen.get(key) || 0) + 1);
        if (seen.size > 400) break;
      }
      if (seen.size > 400) break;
    }
    const entries = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([key, count]) => ({
      where: key.slice(0, key.indexOf('|')),
      value: key.slice(key.indexOf('|') + 1),
      count,
    }));
    if (entries.length) attributeInventory[attribute] = entries;
  }

  // ---- composer candidates ------------------------------------------------
  const composers = [];
  const composerNodes = new Set();
  for (const { root, depth, host } of roots) {
    for (const element of root.querySelectorAll(COMPOSER_SELECTOR)) {
      if (composerNodes.has(element)) continue;
      composerNodes.add(element);
      const vis = visibility(element);
      const tag = element.tagName.toLowerCase();
      const classList = [...element.classList];
      const matched = [];
      try { if (element.matches('#prompt-textarea') || element.matches('[data-composer-markdown][contenteditable="true"][role="textbox"]')) matched.push('chatgpt-shared'); } catch {}
      try { if (element.matches('textarea.message-input-textarea')) matched.push('qwen'); } catch {}
      composers.push({
        tag,
        inputType: tag === 'input' ? (element.getAttribute('type') || 'text') : null,
        role: element.getAttribute('role'),
        contenteditable: element.getAttribute('contenteditable'),
        id: element.id || null,
        name: element.getAttribute('name'),
        ariaLabel: element.getAttribute('aria-label'),
        placeholder: element.getAttribute('placeholder'),
        dataTestId: element.getAttribute('data-testid'),
        autocomplete: element.getAttribute('autocomplete'),
        classList: classList.slice(0, 8).map(name => truncate(name, 60)),
        classNameLength: classList.length,
        likelyAuthField: isAuthField(element),
        visible: vis.visible,
        hiddenReason: vis.visible ? null : vis.reason,
        rect: vis.rect || null,
        disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
        readOnly: Boolean(element.readOnly || element.getAttribute('aria-readonly') === 'true'),
        maxLength: element.getAttribute('maxlength'),
        textLength: tag === 'textarea' || tag === 'input' ? (element.value || '').length : flatten(element.textContent).length,
        shadowHost: host,
        shadowDepth: depth,
        cssPath: cssPath(element),
        parentChain: (() => {
          const chain = [];
          for (let current = element.parentElement, i = 0; current && i < 4; current = current.parentElement, i++) chain.push(selectorOf(current));
          return chain;
        })(),
        closestForm: (() => { const form = element.closest('form'); return form ? cssPath(form) : null; })(),
        matchedExtensionSelectors: matched,
      });
    }
  }
  const visibleComposers = composers.filter(item => item.visible && item.inputType !== 'password');
  const chatComposers = visibleComposers.filter(item => !item.likelyAuthField);

  // A login input is never a chat composer. Detect it from evidence the auth
  // form itself exposes (name/autocomplete/type + the label around it).
  function isAuthField(element) {
    const name = (element.getAttribute('name') || '').toLowerCase();
    const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase();
    const type = (element.getAttribute('type') || '').toLowerCase();
    const hint = flatten((element.getAttribute('aria-label') || '') + ' ' + (element.getAttribute('placeholder') || '') + ' ' + name).toLowerCase();
    if (type === 'password' || type === 'email' || type === 'tel' || type === 'number') return true;
    if (autocomplete && autocomplete !== 'off') return true;
    if (element.closest('form') && element.closest('form').querySelector('input[type="password"]')) return true;
    return AUTH_FIELD_HINT.test(hint);
  }

  // ---- composer scope: nearest ancestor that owns the input and its buttons
  function scopeOf(element) {
    const form = element.closest('form');
    if (form) return { node: form, how: 'closest(form)' };
    for (let current = element.parentElement, i = 0; current && current !== document.body && i < 10; current = current.parentElement, i++) {
      const count = current.querySelectorAll('button, [role="button"]').length;
      if (count >= 1 && count <= 14) return { node: current, how: 'nearest-ancestor-with-buttons(depth ' + (i + 1) + ')' };
    }
    return { node: element.parentElement, how: 'parentElement-fallback' };
  }

  const scopeNodes = [];
  const composerScopes = [];
  for (const composerNode of composerNodes) {
    const scope = scopeOf(composerNode);
    if (!scope.node) continue;
    if (!scopeNodes.includes(scope.node)) {
      scopeNodes.push(scope.node);
      const rect = scope.node.getBoundingClientRect();
      composerScopes.push({
        how: scope.how,
        cssPath: cssPath(scope.node),
        tag: scope.node.tagName.toLowerCase(),
        classList: [...scope.node.classList].slice(0, 6).map(name => truncate(name, 60)),
        dataTestId: scope.node.getAttribute('data-testid'),
        role: scope.node.getAttribute('role'),
        buttonCount: scope.node.querySelectorAll('button, [role="button"]').length,
        composerCount: scope.node.querySelectorAll(COMPOSER_SELECTOR).length,
        rect: rect.width && rect.height ? rectOf(rect) : null,
      });
    }
  }

  // ---- buttons ------------------------------------------------------------
  const SEND_LABEL = /^(send|send message|send prompt|submit|发送|发送消息|提交)/i;
  const STOP_LABEL = /(stop|停止|中止)/i;
  const buttons = [];
  const seenButtons = new Set();
  for (const { root, depth, host } of roots) {
    for (const element of root.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')) {
      if (seenButtons.has(element)) continue;
      seenButtons.add(element);
      if (buttons.length >= 400) break;
      const vis = visibility(element);
      if (!vis.visible && buttons.filter(item => item.visible).length > 150) continue;
      const ariaLabel = element.getAttribute('aria-label') || '';
      const dataTestId = element.getAttribute('data-testid') || '';
      const text = flatten(element.innerText || element.textContent || element.value || '');
      const hints = [];
      if (SEND_LABEL.test(ariaLabel)) hints.push('aria-label-send');
      if (STOP_LABEL.test(ariaLabel) || STOP_LABEL.test(text)) hints.push('aria-label-stop');
      if (element.getAttribute('type') === 'submit') hints.push('type-submit');
      if (dataTestId && /send|submit/i.test(dataTestId)) hints.push('data-testid-send');
      if (/^(send|submit|发送|提交|→|➤|↑)$/i.test(text)) hints.push('text-send');
      const iconIds = [];
      for (const use of element.querySelectorAll('use')) {
        const values = [use.getAttribute('href'), use.getAttribute('xlink:href'), use.getAttributeNS('http://www.w3.org/1999/xlink', 'href')];
        for (const value of values) if (value && !iconIds.includes(value)) iconIds.push(truncate(value, 60));
      }
      const inScope = scopeNodes.find(scope => scope.contains(element)) || null;
      buttons.push({
        tag: element.tagName.toLowerCase(),
        ariaLabel,
        dataTestId,
        title: element.getAttribute('title'),
        type: element.getAttribute('type'),
        text: truncate(text, 80),
        visible: vis.visible,
        hiddenReason: vis.visible ? null : vis.reason,
        rect: vis.rect || null,
        disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
        classList: [...element.classList].slice(0, 6).map(name => truncate(name, 60)),
        hasSvg: Boolean(element.querySelector('svg')),
        iconIds,
        inComposerScope: Boolean(inScope),
        composerScope: inScope ? cssPath(inScope) : null,
        shadowHost: host,
        cssPath: cssPath(element),
        sendHints: hints,
      });
    }
    if (buttons.length >= 400) break;
  }
  const sendButtonCandidates = buttons
    .filter(button => button.visible && button.sendHints.length && !button.sendHints.includes('aria-label-stop'))
    .sort((a, b) => Number(b.inComposerScope) - Number(a.inComposerScope) || b.sendHints.length - a.sendHints.length);

  // ---- repeated-structure message container scoring -----------------------
  const MESSAGE_ATTRIBUTE = /^(data-message|data-role|data-author|data-turn|data-msg|data-sender|data-content-type|data-is-streaming|data-testid$)/;
  // Chat lists alternate user/assistant rows. Normalize the author marker and
  // the role-ish class tokens so both roles land in one bucket; otherwise every
  // bucket holds only half the messages and never reaches the >=3 threshold.
  const ROLE_TOKEN = /(user|assistant|bot|ai|human|sender|message-?(?:left|right)|own|other|self)/i;
  const ROLE_VALUE = /^(user|assistant|bot|ai|human|system)$/i;
  const roleOf = element => {
    for (const name of ['data-message-author-role', 'data-role', 'data-author', 'data-sender', 'data-message-role']) {
      const value = element.getAttribute(name);
      if (value) return value;
    }
    for (const token of element.classList) if (ROLE_TOKEN.test(token)) return token;
    return '';
  };
  const signatureOf = element => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute('role');
    const marked = [...element.attributes]
      .map(attribute => attribute.name)
      .filter(name => MESSAGE_ATTRIBUTE.test(name) && name !== 'data-testid')
      .sort();
    const classes = [...element.classList]
      .filter(token => !ROLE_TOKEN.test(token))
      .slice(0, 3);
    return tag +
      (role ? '[role=' + role + ']' : '') +
      (marked.length ? '[' + marked.join(',') + ']' : '') +
      (classes.length ? '.' + classes.join('.') : '');
  };
  const repeatedGroups = [];
  const groupKeys = new Set();
  let scannedParents = 0;
  const CHROME_TAGS = new Set(['HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE']);
  for (const { root, depth, host } of roots) {
    for (const parent of root.querySelectorAll('*')) {
      if (++scannedParents > 25000) break;
      if (CHROME_TAGS.has(parent.tagName) || parent.closest('head')) continue;
      const children = [...parent.children];
      if (children.length < 3 || children.length > 400) continue;
      const buckets = new Map();
      for (const child of children) {
        if (CHROME_TAGS.has(child.tagName)) continue;
        const key = signatureOf(child);
        const list = buckets.get(key) || [];
        list.push(child);
        buckets.set(key, list);
      }
      for (const [signature, list] of buckets) {
        if (list.length < 3) continue;
        const textBearing = list.filter(child => flatten(child.textContent).length > 0).length;
        const visibleChildren = list.filter(child => visibility(child).visible).length;
        // Conversation evidence: message-ish role/attribute names, alternating
        // author markers, and children that actually paint text. Raw child
        // count alone selects header/link/script groups.
        const named = list.filter(child => [...child.attributes].some(attribute => MESSAGE_ATTRIBUTE.test(attribute.name))).length;
        const roleMarked = list.filter(child => /message|chat|turn|bubble/i.test(child.getAttribute('class') || '') || /message|chat|turn|bubble/i.test(child.getAttribute('data-testid') || '')).length;
        const roles = new Set(list.map(roleOf).filter(Boolean));
        const bothRoles = roles.size >= 2;
        const painters = list.filter(child => flatten(child.textContent).length > 12).length;
        const score = round(
          (painters / list.length) * 3 +
          (visibleChildren / list.length) * 2 +
          (named / list.length) * 3 +
          (roleMarked / list.length) * 2 +
          (bothRoles ? 2 : 0) +
          Math.min(list.length, 40) / 20 +
          depth * 0.1
        );
        const parentPath = cssPath(parent);
        const key = parentPath + '||' + signature;
        if (groupKeys.has(key)) continue;
        groupKeys.add(key);
        repeatedGroups.push({
          signature,
          count: list.length,
          score,
          parentPath,
          parentTag: parent.tagName.toLowerCase(),
          parentClass: truncate(parent.getAttribute('class') || '', 120),
          parentRole: parent.getAttribute('role'),
          parentDataTestId: parent.getAttribute('data-testid'),
          depth,
          shadowHost: host,
          parentVisible: visibility(parent).visible,
          textBearingChildren: textBearing,
          hasMessageAttributes: named > 0,
          messageAttributeCount: named,
          conversationNamedCount: roleMarked,
          roleVariety: [...roles],
          visibleChildren,
          sampleTexts: list.slice(0, 3).map(child => truncate(flatten(child.textContent), 120)),
        });
      }
      if (scannedParents > 25000) break;
    }
  }
  repeatedGroups.sort((a, b) => b.score - a.score);
  const topGroups = repeatedGroups.slice(0, 20);

  const messageListHints = [];
  for (const { root } of roots) {
    for (const element of root.querySelectorAll('[role="log"], [data-message-list], [class*="message-list" i], [class*="conversation" i], [class*="transcript" i], [class*="thread" i], [class*="messages" i]')) {
      const vis = visibility(element);
      if (!vis.visible) continue;
      const elementPath = cssPath(element);
      if (messageListHints.some(item => item.cssPath === elementPath)) continue;
      messageListHints.push({
        cssPath: elementPath,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        classList: [...element.classList].slice(0, 5).map(name => truncate(name, 60)),
        ariaLive: element.getAttribute('aria-live'),
        childCount: element.childElementCount,
        textLength: flatten(element.textContent).length,
        rect: vis.rect,
      });
      if (messageListHints.length >= 25) break;
    }
    if (messageListHints.length >= 25) break;
  }

  // ---- iframes ------------------------------------------------------------
  const iframes = [];
  for (const frame of document.querySelectorAll('iframe, frame')) {
    const vis = visibility(frame);
    let sameOrigin = false;
    let composerInside = null;
    try {
      const inner = frame.contentDocument;
      sameOrigin = Boolean(inner && inner.documentElement);
      if (sameOrigin) composerInside = Boolean(inner.querySelector(COMPOSER_SELECTOR));
    } catch { sameOrigin = false; }
    iframes.push({
      src: truncate(frame.getAttribute('src') || frame.src || '', 200),
      name: frame.getAttribute('name') || null,
      title: frame.getAttribute('title') || null,
      visible: vis.visible,
      rect: vis.rect || null,
      sameOrigin,
      composerInside,
    });
  }
  const crossOriginFrames = iframes.filter(frame => !frame.sameOrigin);
  if (crossOriginFrames.length) warnings.push('页面存在 ' + crossOriginFrames.length + ' 个跨域 iframe：若输入区位于其中，扩展无法直接注入，必须换宿主页注入或 API 方案');
  if (shadowHosts.length) warnings.push('页面存在 ' + shadowHosts.length + ' 个 open shadow root：扩展的 querySelector 需要按 shadow 边界分别查询');

  // ---- login / auth signals (read-only) -----------------------------------
  const loginSignals = { passwordInputs: [], authLinks: [], authButtons: [], oauthMarkers: [], dialogs: [] };
  const AUTH_TEXT = /(continue with|sign in|sign up|log in|login|sso|google|apple|microsoft|使用.*登录|登录|登入)/i;
  const AUTH_HREF = /(log-?in|sign-?in|sign-?up|auth|oauth|sso)/i;
  for (const { root } of roots) {
    for (const field of root.querySelectorAll('input[type="password"]')) {
      loginSignals.passwordInputs.push({ cssPath: cssPath(field), placeholder: field.getAttribute('placeholder'), name: field.getAttribute('name'), visible: visibility(field).visible });
    }
    for (const link of root.querySelectorAll('a[href]')) {
      if (loginSignals.authLinks.length >= 25) break;
      const href = link.getAttribute('href') || '';
      if (!AUTH_HREF.test(href)) continue;
      const vis = visibility(link);
      if (!vis.visible) continue;
      loginSignals.authLinks.push({ href: truncate(href, 160), text: truncate(flatten(link.innerText || link.textContent), 80), cssPath: cssPath(link) });
    }
    for (const control of root.querySelectorAll('button, [role="button"], a')) {
      if (loginSignals.authButtons.length >= 25) break;
      const label = flatten((control.getAttribute('aria-label') || '') + ' ' + (control.innerText || control.textContent || ''));
      if (!label || !AUTH_TEXT.test(label)) continue;
      const vis = visibility(control);
      if (!vis.visible) continue;
      loginSignals.authButtons.push({ label: truncate(label, 100), tag: control.tagName.toLowerCase(), ariaLabel: control.getAttribute('aria-label'), dataTestId: control.getAttribute('data-testid'), cssPath: cssPath(control), rect: vis.rect });
    }
    for (const node of root.querySelectorAll('[class*="oauth" i], [data-provider], [data-oauth-provider], #credential_picker_container')) {
      if (loginSignals.oauthMarkers.length >= 15) break;
      loginSignals.oauthMarkers.push({ tag: node.tagName.toLowerCase(), className: truncate(node.getAttribute('class') || '', 100), dataProvider: node.getAttribute('data-provider'), cssPath: cssPath(node) });
    }
  }
  for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) {
    const vis = visibility(dialog);
    loginSignals.dialogs.push({
      cssPath: cssPath(dialog),
      visible: vis.visible,
      label: truncate(flatten(dialog.getAttribute('aria-label') || dialog.innerText || ''), 160),
      hasPassword: Boolean(dialog.querySelector('input[type="password"]')),
      hasComposer: Boolean(dialog.querySelector(COMPOSER_SELECTOR)),
    });
  }

  // ---- framework / meta ---------------------------------------------------
  const scriptSources = [...document.querySelectorAll('script[src]')].map(script => script.getAttribute('src') || '');
  const framework = {
    isNextJs: Boolean(document.getElementById('__next') || window.__NEXT_DATA__ || scriptSources.some(source => source.indexOf('/_next/') >= 0)),
    nextDataScript: Boolean(document.getElementById('__NEXT_DATA__')),
    nextAppRouter: Boolean(window.__next_f || [...document.querySelectorAll('script')].some(script => (script.textContent || '').indexOf('self.__next_f') >= 0)),
    nextStaticAssets: scriptSources.filter(source => source.indexOf('/_next/') >= 0).length,
    reactRoot: Boolean(document.querySelector('[data-reactroot], #__next, #root, #app')),
    bodyClassList: [...document.body.classList].slice(0, 8).map(name => truncate(name, 60)),
    metaTags: (() => {
      const result = {};
      for (const meta of document.querySelectorAll('meta[name], meta[property]')) {
        const key = meta.getAttribute('name') || meta.getAttribute('property');
        if (!key || !/generator|description|og:title|application-name|twitter:title/i.test(key)) continue;
        result[key] = truncate(meta.getAttribute('content') || '', 200);
      }
      return result;
    })(),
    scriptHosts: [...new Set(scriptSources.filter(Boolean).map(source => { try { return new URL(source, location.href).host; } catch { return null; } }).filter(Boolean))].slice(0, 15),
  };

  // ---- suggested selectors ------------------------------------------------
  const suggested = { composer: [], composerScope: [], sendButton: [], messageList: [], messageRow: [] };
  for (const composer of visibleComposers) {
    if (composer.cssPath) suggested.composer.push(composer.cssPath);
    if (composer.dataTestId) suggested.composer.push(composer.tag + '[data-testid="' + composer.dataTestId + '"]');
    if (composer.ariaLabel) suggested.composer.push(composer.tag + '[aria-label="' + composer.ariaLabel + '"]');
    if (composer.placeholder) suggested.composer.push(composer.tag + '[placeholder="' + composer.placeholder + '"]');
    if (composer.tag === 'textarea' && composer.classList.length) suggested.composer.push('textarea.' + composer.classList[0]);
    if (composer.contenteditable === 'true' && composer.classList.length) suggested.composer.push('[contenteditable="true"].' + composer.classList[0]);
  }
  for (const scope of composerScopes) {
    if (scope.cssPath) suggested.composerScope.push(scope.cssPath);
    if (scope.dataTestId) suggested.composerScope.push('[data-testid="' + scope.dataTestId + '"]');
  }
  for (const button of sendButtonCandidates.slice(0, 8)) {
    if (button.cssPath) suggested.sendButton.push(button.cssPath);
    if (button.dataTestId) suggested.sendButton.push('button[data-testid="' + button.dataTestId + '"]');
    if (button.ariaLabel) suggested.sendButton.push('button[aria-label="' + button.ariaLabel + '"]');
  }
  for (const group of topGroups.slice(0, 5)) {
    if (group.parentPath) suggested.messageList.push(group.parentPath);
    if (group.signature) suggested.messageRow.push(group.signature);
  }

  // ---- per-composer detail ------------------------------------------------
  const composerDetail = visibleComposers.map(composer => {
    const node = [...composerNodes].find(candidate => cssPath(candidate) === composer.cssPath);
    const scope = node ? scopeOf(node) : null;
    const scopeButtons = scope?.node ? [...scope.node.querySelectorAll('button, [role="button"]')].filter(button => visibility(button).visible).map(button => ({
      ariaLabel: button.getAttribute('aria-label'),
      dataTestId: button.getAttribute('data-testid'),
      text: truncate(flatten(button.innerText || button.textContent), 40),
      disabled: Boolean(button.disabled || button.getAttribute('aria-disabled') === 'true'),
      iconIds: [...button.querySelectorAll('use')].map(use => use.getAttribute('href') || use.getAttribute('xlink:href')).filter(Boolean).slice(0, 3),
      cssPath: cssPath(button),
    })) : [];
    return { cssPath: composer.cssPath, tag: composer.tag, scopePath: scope?.node ? cssPath(scope.node) : null, scopeHow: scope?.how || null, scopeButtons };
  });

  if (!visibleComposers.length) notes.push('未找到可见输入框：登录前的 hark.com 只展示入口页，输入框要登录后才会挂载');
  if (visibleComposers.length && !chatComposers.length) notes.push('只有登录/邮箱类输入框，没有对话输入框：当前是入口页（未登录），对话 composer 需要登录后标定');
  if (!sendButtonCandidates.length) notes.push('未找到发送按钮候选：与输入框相同，登录前的入口页没有可标定的发送控件');
  if (!topGroups.length) notes.push('未发现重复结构容器（>=3 个同构子节点）：当前页面没有消息列表，需要用登录后的会话页再跑一次');
  if (framework.isNextJs) notes.push('页面是 Next.js（' + (framework.nextAppRouter ? 'App Router / RSC' : 'Pages Router') + '），组件类名可能是构建哈希，选择器应优先用 role/aria-label/data-testid');

  return {
    ok: true,
    probedAt: new Date().toISOString(),
    meta: {
      url: location.href,
      origin: location.origin,
      title: document.title,
      lang: document.documentElement.lang || null,
      readyState: document.readyState,
      charset: document.characterSet,
      contentType: document.contentType,
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      settleWaitedMs: waited,
      bodyTextSample: truncate(flatten(document.body ? document.body.innerText : ''), 600),
    },
    framework,
    shadow: { hostCount: shadowHosts.length, hosts: shadowHosts, rootsScanned: roots.length },
    iframes,
    loginSignals,
    composers: visibleComposers.length ? visibleComposers : composers,
    chatComposers: chatComposers,
    composerScopes,
    composerDetail,
    buttons: buttons.slice(0, 120),
    sendButtonCandidates: sendButtonCandidates.slice(0, 20),
    messageListHints,
    repeatedGroups: topGroups,
    messageContainerCandidates: topGroups.filter(group => group.count >= 3).slice(0, 10),
    attributeInventory,
    suggested,
    notes,
    warnings,
    counts: {
      elements: document.querySelectorAll('*').length,
      composers: composers.length,
      visibleComposers: visibleComposers.length,
      chatComposers: chatComposers.length,
      buttons: buttons.length,
      visibleButtons: buttons.filter(button => button.visible).length,
      repeatedGroups: repeatedGroups.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A loading SPA replaces its execution context mid-probe. Those errors are
// transient, so retry instead of reporting a broken page.
const TRANSIENT_TOKENS = ['Execution context was destroyed', 'Cannot find context', 'Inspected target navigated', 'Target closed', 'Session closed', 'No resource with given'];
function contextLost(error) {
  const message = String((error && error.message) || error);
  return TRANSIENT_TOKENS.some(token => message.indexOf(token) >= 0);
}

async function evaluate(cdp, expression, budget, attempts) {
  const limit = attempts || 4;
  let lastError = null;
  for (let attempt = 1; attempt <= limit; attempt++) {
    try {
      return await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, budget);
    } catch (error) {
      lastError = error;
      if (!contextLost(error) || attempt === limit) throw error;
      await sleep(800);
      try { await cdp.send('Runtime.enable', {}, Math.min(budget, 8000)); } catch {}
    }
  }
  throw lastError;
}

async function waitForDocument(cdp, budget) {
  const until = Date.now() + budget;
  while (Date.now() < until) {
    try {
      const probe = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, Math.min(5000, Math.max(1000, until - Date.now())));
      if (probe && probe.result && probe.result.value === 'complete') return true;
    } catch (error) {
      if (!contextLost(error)) throw error;
    }
    await sleep(400);
  }
  return false;
}

async function main() {
  const startedAt = Date.now();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(USAGE + NL); return 0; }

  const base = 'http://127.0.0.1:' + options.port;
  const version = await fetchJson(base + '/json/version', Math.min(options.timeout, 10000));
  const tabs = await fetchJson(base + '/json/list', Math.min(options.timeout, 10000));
  const pages = tabs.filter(tab => tab.type === 'page' && tab.webSocketDebuggerUrl);

  if (options.list) {
    process.stdout.write(JSON.stringify({ browser: version.Browser, targets: pages.map(tab => ({ title: tab.title, url: tab.url, id: tab.id, debugging: tab.webSocketDebuggerUrl })) }, null, 2) + NL);
    return 0;
  }

  const matched = listPageTargets(tabs, options.urlPrefix);
  if (!matched.length) {
    throw new ProbeError(
      '没有匹配 --url-prefix "' + options.urlPrefix + '" 的标签页',
      '当前可用页面：' + (pages.length ? pages.map(tab => tab.url).join(' | ') : '（空）') + '；请先在浏览器里打开目标页面再重试'
    );
  }
  const target = matched[0];
  const connectBudget = Math.max(3000, Math.min(options.timeout, 15000));
  const socket = await openSocket(target.webSocketDebuggerUrl, connectBudget);
  const cdp = new Cdp(socket);
  let result;
  let html = null;
  try {
    await cdp.send('Runtime.enable', {}, connectBudget);
    const readyBudget = Math.min(20000, Math.max(4000, Math.floor(options.timeout / 3)));
    const documentReady = await waitForDocument(cdp, readyBudget);
    if (!documentReady) process.stderr.write('[hark-dom-probe] 提示：document 在 ' + readyBudget + 'ms 内未达到 readyState=complete，仍按当前 DOM 探测' + NL);
    const probeScript = '(() => { const probe = ' + pageProbe.toString() + '; return probe(' + JSON.stringify({ settleMs: options.settle }) + '); })()';
    const evaluateBudget = Math.max(5000, options.timeout - (Date.now() - startedAt));
    const evaluation = await evaluate(cdp, probeScript, evaluateBudget, 4);
    if (evaluation && evaluation.exceptionDetails) {
      const description = (evaluation.exceptionDetails.exception && evaluation.exceptionDetails.exception.description) || evaluation.exceptionDetails.text || '未知异常';
      throw new ProbeError('页面内探测函数抛出异常：' + String(description).split(NL)[0], '页面可能刚被导航；稍后重试');
    }
    result = evaluation && evaluation.result ? evaluation.result.value : null;
    if (!result || typeof result !== 'object') throw new ProbeError('页面内探测没有返回结构化结果', '页面可能被导航，或 Runtime.evaluate 被页面 CSP 拦截');
    if (options.html) {
      const snapshotBudget = Math.max(5000, options.timeout - (Date.now() - startedAt));
      const snapshot = await evaluate(cdp, 'document.documentElement.outerHTML', snapshotBudget, 3);
      html = snapshot && snapshot.result ? snapshot.result.value : null;
    }
  } finally {
    cdp.close();
  }

  const envelope = {
    tool: 'hark-dom-probe',
    version: 1,
    browser: version.Browser || null,
    protocol: version['Protocol-Version'] || null,
    target: { id: target.id, title: target.title, url: target.url },
    otherMatches: matched.slice(1).map(tab => tab.url),
    elapsedMs: Date.now() - startedAt,
    result,
  };
  const json = JSON.stringify(envelope, null, 2);

  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, json + NL);
    if (options.html && html) {
      fs.writeFileSync(options.html, html);
      process.stderr.write('[hark-dom-probe] HTML 快照已写入 ' + options.html + '（' + html.length + ' 字节）' + NL);
    }
    process.stderr.write('[hark-dom-probe] JSON 已写入 ' + options.out + NL);
    process.stderr.write('[hark-dom-probe] 对话输入框 ' + result.counts.chatComposers + '（可见输入框合计 ' + result.counts.visibleComposers + '） / 发送按钮候选 ' + result.sendButtonCandidates.length + ' / 重复容器 ' + result.counts.repeatedGroups + ' / Next.js=' + result.framework.isNextJs + NL);
  } else {
    process.stdout.write(json + NL);
    if (options.html && html) fs.writeFileSync(options.html, html);
  }
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  if (error instanceof ProbeError) {
    process.stderr.write('[hark-dom-probe] 错误：' + error.message + NL);
    if (error.hint) process.stderr.write('[hark-dom-probe] 提示：' + error.hint + NL);
  } else {
    process.stderr.write('[hark-dom-probe] 未预期错误：' + ((error && error.stack) || error) + NL);
  }
  process.exitCode = 2;
});
