import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { snapshot, turns, findSubmittedUser, finalCandidate, markdownText, answerImageSource, readAnswerImage, decodeImagePayload, MAX_IMAGE_BYTES } from '../extension/dom.js';

const galleryFixture = await readFile(new URL('./fixtures/chatgpt-modern-generated-image.html', import.meta.url), 'utf8');

const imageUrl = 'https://files.oaiusercontent.com/generated.png?signature=private-synthetic-signature';
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const encodedPng = Buffer.from(png).toString('base64');
function turn(id, content, { plainImage = false, userImage = '' } = {}) {
  return `<div data-turn-key="${id}"><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="${id}:0:user" data-chatgpt-search-message-ids="${id}-user"><div data-user-message-bubble="true">Question ${id}</div>${userImage}</div><div data-chatgpt-search-unit-key="${id}:1:assistant" data-chatgpt-search-message-ids="${id}-assistant">${plainImage ? content : `<div data-markdown-text-style="assistant-message">${content}</div>`}</div><div class="turn-action-controls"><button aria-label="复制">Copy</button></div></div></div>`;
}
function loaded(doc) {
  for (const img of doc.querySelectorAll('img')) Object.defineProperties(img, { complete: { value: true, configurable: true }, naturalWidth: { value: 512, configurable: true }, naturalHeight: { value: 512, configurable: true } });
}
function page(history = '') { const doc = new JSDOM(`<main>${history}</main>`, { url: 'https://chatgpt.com/c/image-fixture' }).window.document; loaded(doc); return doc; }
function append(doc, html) { doc.querySelector('main').insertAdjacentHTML('beforeend', html); loaded(doc); }
// Matches the source badge observed in a real text answer about GLM.
function citationFavicon(domain = 'https://z.ai') {
  return `<span data-d-component="popover-trigger" role="button" aria-haspopup="dialog"><div data-d-component="badge"><div data-d-component="favicon" role="presentation"><img src="https://www.google.com/s2/favicons?domain=${domain}&amp;sz=32" width="32" height="32"></div></div></span>`;
}

test('observed generated gallery with stable message ID and copy-image control is a complete image-only answer', () => {
  const doc = page(); const baseline = snapshot(doc); append(doc, galleryFixture);
  const image = doc.querySelector('img');
  Object.defineProperties(image, { naturalWidth: { value: 1122 }, naturalHeight: { value: 1402 } });
  assert.equal(turns(doc, 'assistant').length, 1);
  const result = finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Generate a landscape'));
  assert.equal(result.text, '');
  assert.deepEqual(result.images, [{ src: image.src, width: 1122, height: 1402 }]);
});

test('current generated gallery waits for completion, copy-image control and actual loaded pixels', () => {
  for (const change of [
    doc => doc.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state', 'streaming'),
    doc => doc.querySelector('.turn-action-controls').remove(),
    doc => { doc.querySelector('.turn-action-controls button').hidden = true; },
    doc => Object.defineProperty(doc.querySelector('img'), 'complete', { value: false }),
  ]) {
    const doc = page(); const baseline = snapshot(doc); append(doc, galleryFixture); change(doc);
    assert.equal(finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Generate a landscape')), null);
  }
});

test('generated gallery inference rejects user, analysis, tool and unstable containers', () => {
  for (const change of [
    doc => { const gallery = doc.querySelector('[data-testid="generated-image-gallery"]'); doc.querySelector('[data-chatgpt-search-unit-key$=":user"]').append(gallery); },
    doc => doc.querySelector('[data-chatgpt-search-message-ids="fixture-generated-assistant"]').setAttribute('data-channel', 'analysis'),
    doc => doc.querySelector('[data-chatgpt-search-message-ids="fixture-generated-assistant"]').setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-5:1:tool'),
    doc => doc.querySelector('[data-chatgpt-search-message-ids="fixture-generated-assistant"]').removeAttribute('data-chatgpt-search-message-ids'),
    doc => doc.querySelector('[data-chatgpt-search-message-ids="fixture-generated-assistant"]').setAttribute('data-chatgpt-search-message-ids', 'fixture-generated-user'),
    doc => doc.querySelector('[data-testid="generated-image-gallery"]').removeAttribute('data-testid'),
  ]) {
    const doc = page(); const baseline = snapshot(doc); append(doc, galleryFixture); change(doc);
    assert.equal(turns(doc, 'assistant').length, 0);
    assert.equal(finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Generate a landscape')), null);
  }
});

test('completed current turn combines explicitly marked text and stable generated gallery while excluding history', () => {
  const history = galleryFixture.replaceAll('fixture-generated-', 'fixture-history-').replace('file-synthetic-generated', 'file-synthetic-history');
  const doc = page(history); const baseline = snapshot(doc); append(doc, galleryFixture);
  const galleryMessage = doc.querySelector('[data-chatgpt-search-message-ids="fixture-generated-assistant"]');
  galleryMessage.insertAdjacentHTML('beforebegin', '<div data-chatgpt-search-unit-key="fallback-turn-5:1:assistant" data-chatgpt-search-message-ids="fixture-text-assistant"><div data-markdown-text-style="assistant-message"><p>Here is the requested landscape.</p></div></div>');
  const result = finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Generate a landscape'));
  assert.equal(result.text, 'Here is the requested landscape.');
  assert.deepEqual(result.images.map(image => image.src), ['https://chatgpt.com/backend-api/estuary/content?id=file-synthetic-generated']);
});

test('text fragments and generated gallery with a shared stable message ID normalize once without changing the image-only layout', () => {
  const doc = page(); const baseline = snapshot(doc); append(doc, galleryFixture);
  const galleryMessage = doc.querySelector('[data-chatgpt-search-message-ids="fixture-generated-assistant"]');
  galleryMessage.insertAdjacentHTML('beforebegin', '<div data-chatgpt-search-unit-key="fallback-turn-5:1:assistant" data-chatgpt-search-message-ids="fixture-generated-assistant"><div data-markdown-text-style="assistant-message"><p>First paragraph.</p></div></div>');
  galleryMessage.insertAdjacentHTML('afterend', '<div data-chatgpt-search-unit-key="fallback-turn-5:2:assistant" data-chatgpt-search-message-ids="fixture-generated-followup"><div data-markdown-text-style="assistant-message"><p>Second paragraph.</p></div></div>');
  const result = finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Generate a landscape'));
  assert.equal(result.text, 'First paragraph.\n\nSecond paragraph.');
  assert.equal(result.images.length, 1);
});

test('a gallery nested inside an already marked assistant is not counted twice', () => {
  const doc = page(); const baseline = snapshot(doc); append(doc, galleryFixture);
  const galleryMessage = doc.querySelector('[data-chatgpt-search-message-ids="fixture-generated-assistant"]');
  const wrapper = doc.createElement('div');
  wrapper.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-5:1:assistant');
  wrapper.setAttribute('data-chatgpt-search-message-ids', 'fixture-generated-assistant');
  galleryMessage.replaceWith(wrapper); wrapper.append(galleryMessage);
  assert.equal(turns(doc, 'assistant').length, 1);
  assert.equal(finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Generate a landscape')).images.length, 1);
});

test('a current answer cannot borrow a completed gallery or copy-image control from another turn', () => {
  const doc = page(galleryFixture); const baseline = snapshot(doc);
  append(doc, '<div data-turn-key="new-text-only"><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="new:0:user" data-chatgpt-search-message-ids="new-user"><div data-user-message-bubble="true">Another image</div></div><div data-chatgpt-search-unit-key="new:1:assistant" data-chatgpt-search-message-ids="new-assistant"><div data-markdown-text-style="assistant-message">No gallery here.</div></div><div class="turn-action-controls"><button aria-label="复制图像">Copy</button></div></div></div>');
  assert.equal(finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Another image')), null);
});

test('separate generated galleries in one complete turn enforce the combined image limit', () => {
  const doc = page(); const baseline = snapshot(doc); append(doc, galleryFixture);
  const first = doc.querySelector('[data-chatgpt-search-message-ids="fixture-generated-assistant"]');
  for (let index = 1; index < 5; index += 1) {
    const next = first.cloneNode(true);
    next.setAttribute('data-chatgpt-search-message-ids', `fixture-generated-${index}`);
    next.querySelector('img').src = `https://chatgpt.com/backend-api/estuary/content?id=file-synthetic-${index}`;
    first.after(next);
  }
  loaded(doc);
  assert.throws(() => finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Generate a landscape')), /超过 4 张/);
});

function galleryImages(layout) {
  const doc = page(); const baseline = snapshot(doc); append(doc, galleryFixture);
  const first = doc.querySelector('[data-chatgpt-search-message-ids="fixture-generated-assistant"]');
  const template = first.cloneNode(true); let previous = first; let index = 0;
  const sources = [];
  for (const [group, count] of layout.entries()) {
    const message = group ? template.cloneNode(true) : first;
    message.setAttribute('data-chatgpt-search-message-ids', `fixture-gallery-${group}`);
    if (group) { previous.after(message); previous = message; }
    const gallery = message.querySelector('[data-testid="generated-image-gallery"]');
    const previewTemplate = gallery.querySelector('[data-image-transparency-backdrop-scope]').cloneNode(true);
    gallery.replaceChildren();
    for (let part = 0; part < count; part++) {
      const preview = previewTemplate.cloneNode(true);
      const src = `https://chatgpt.com/backend-api/estuary/content?id=file-multi-${index++}`;
      preview.querySelector('img').src = src; sources.push(src); gallery.append(preview);
    }
  }
  loaded(doc);
  return { doc, baseline, sources, user: findSubmittedUser(doc, baseline, 'Generate a landscape') };
}

test('two to four generated images survive a single gallery and multiple galleries in original order', () => {
  for (const layout of [[2], [3], [4], [1, 1], [2, 1], [2, 2], [1, 1, 1, 1]]) {
    const f = galleryImages(layout);
    const result = finalCandidate(f.doc, f.baseline, f.user);
    assert.equal(result.text, '');
    assert.deepEqual(result.images.map(image => image.src), f.sources, JSON.stringify(layout));
  }
});

test('duplicate loaded previews within and across galleries count once and do not consume the four-image limit', () => {
  const f = galleryImages([2, 2]);
  const galleries = [...f.doc.querySelectorAll('[data-testid="generated-image-gallery"]')];
  const repeated = galleries[0].querySelector('[data-image-transparency-backdrop-scope]').cloneNode(true);
  galleries[0].append(repeated); galleries[1].append(repeated.cloneNode(true)); loaded(f.doc);
  const result = finalCandidate(f.doc, f.baseline, f.user);
  assert.deepEqual(result.images.map(image => image.src), f.sources);
});

test('a loaded first picture never completes a gallery set while any other generated picture is still loading', () => {
  for (const layout of [[4], [2, 2], [1, 1, 1, 1]]) {
    const f = galleryImages(layout);
    const last = [...f.doc.querySelectorAll('img')].at(-1);
    Object.defineProperty(last, 'complete', { value: false, configurable: true });
    assert.equal(finalCandidate(f.doc, f.baseline, f.user), null);
    Object.defineProperty(last, 'complete', { value: true, configurable: true });
    assert.deepEqual(finalCandidate(f.doc, f.baseline, f.user).images.map(image => image.src), f.sources);
    Object.defineProperty(last, 'naturalWidth', { value: 0, configurable: true });
    assert.throws(() => finalCandidate(f.doc, f.baseline, f.user), /未正常加载/);
  }
});

test('image-only final answer can have no markdown body and remains bound to its submitted user turn', () => {
  const doc = page(turn('old', '<p>Old answer.</p>'));
  const baseline = snapshot(doc);
  append(doc, turn('new', `<div><img src="${imageUrl}" alt="Generated landscape"></div>`, { plainImage: true }));
  const user = findSubmittedUser(doc, baseline, 'Question new');
  const result = finalCandidate(doc, baseline, user);
  assert.equal(result.text, '');
  assert.deepEqual(result.images, [{ src: imageUrl, width: 512, height: 512 }]);
  doc.querySelector('[data-turn-key="new"] [data-talvt-turn-state]').setAttribute('data-talvt-turn-state', 'streaming');
  assert.equal(finalCandidate(doc, baseline, user), null);
});

test('answer images exclude history, user content, repeated URLs, hidden images and UI avatars/icons', () => {
  const oldSrc = 'https://files.oaiusercontent.com/historical.png';
  const doc = page(turn('old', `<img src="${oldSrc}">`));
  const baseline = snapshot(doc);
  append(doc, turn('new', `<p>New answer.</p><img src="${imageUrl}"><img src="${imageUrl}"><img src="${oldSrc}"><div hidden><img src="https://files.oaiusercontent.com/hidden.png"></div><div data-testid="avatar"><img alt="Avatar" src="https://files.oaiusercontent.com/avatar.png"></div><div data-testid="icon"><img width="24" height="24" src="https://files.oaiusercontent.com/icon.png"></div>`, { userImage: '<img src="https://files.oaiusercontent.com/user-upload.png">' }));
  const result = finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Question new'));
  assert.equal(result.text, 'New answer.');
  assert.deepEqual(result.images.map(image => image.src), [imageUrl]);
});

test('generated logos, descriptive avatar/icon text and small body images are never silently discarded', () => {
  const doc = page(); const baseline = snapshot(doc);
  append(doc, turn('new', '<p>Your images.</p><img alt="Generated company logo" src="https://files.oaiusercontent.com/logo.png"><img alt="Avatar 头像 illustration" width="24" height="24" src="https://files.oaiusercontent.com/small.png"><div data-testid="generated-icon"><img alt="icon 图标" width="1" height="1" src="https://files.oaiusercontent.com/tiny.png"></div>'));
  const images = doc.querySelectorAll('img');
  Object.defineProperties(images[1], { naturalWidth: { value: 24 }, naturalHeight: { value: 24 } });
  Object.defineProperties(images[2], { naturalWidth: { value: 1 }, naturalHeight: { value: 1 } });
  const result = finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Question new'));
  assert.equal(result.text, 'Your images.');
  assert.deepEqual(result.images, [
    { src: 'https://files.oaiusercontent.com/logo.png', width: 512, height: 512 },
    { src: 'https://files.oaiusercontent.com/small.png', width: 24, height: 24 },
    { src: 'https://files.oaiusercontent.com/tiny.png', width: 1, height: 1 },
  ]);
});

test('observed citation favicon component does not turn a complete text answer into an unsupported-image error', () => {
  const doc = page(); const baseline = snapshot(doc);
  append(doc, turn('new', '<p>GLM 的能力需要结合具体任务评价。</p>' + citationFavicon()));
  const result = finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Question new'));
  assert.equal(result.text, 'GLM 的能力需要结合具体任务评价。');
  assert.deepEqual(result.images, []);
});

test('unloaded or broken citation favicons cannot delay the completed text answer', () => {
  for (const complete of [false, true]) {
    const doc = page(); const baseline = snapshot(doc);
    append(doc, turn('new', '<p>已完成的评价。</p>' + citationFavicon()));
    const favicon = doc.querySelector('[data-d-component="favicon"] img');
    Object.defineProperties(favicon, { complete: { value: complete }, naturalWidth: { value: 0 }, naturalHeight: { value: 0 } });
    const result = finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Question new'));
    assert.equal(result.text, '已完成的评价。');
    assert.deepEqual(result.images, []);
  }
});

test('citation favicons do not consume the four-image limit and generated logos/icons remain included', () => {
  const doc = page(); const baseline = snapshot(doc);
  const sources = ['logo', 'icon', 'avatar', 'small'].map(name => `https://files.oaiusercontent.com/${name}.png`);
  append(doc, turn('new', '<p>生成的设计。</p>' + Array.from({ length: 6 }, (_, index) => citationFavicon(`https://source-${index}.example`)).join('') +
    sources.map((src, index) => `<img src="${src}" alt="${['Generated company logo', 'icon 图标', 'Avatar 头像 illustration', 'Small generated image'][index]}">`).join('')));
  const small = [...doc.querySelectorAll('img')].at(-1);
  Object.defineProperties(small, { naturalWidth: { value: 24 }, naturalHeight: { value: 24 } });
  const result = finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Question new'));
  assert.equal(result.text, '生成的设计。');
  assert.deepEqual(result.images.map(image => image.src), sources);
  assert.equal(result.images.at(-1).width, 24);
});

test('external images outside an observed favicon component are explicitly reported as omitted', () => {
  const doc = page(); const baseline = snapshot(doc);
  append(doc, turn('new', '<p>正文仍有未知配图。</p><img src="https://www.google.com/s2/favicons?domain=https://z.ai&amp;sz=32" alt="favicon">'));
  const result = finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Question new'));
  assert.equal(result.text, '正文仍有未知配图。\n\n提示：本次回复有 1 张外部来源图片未转发，请在 ChatGPT 网页查看。');
  assert.deepEqual(result.images, []);
});

test('external HTTP and HTTPS answer illustrations never wait for loading and preserve completed answer text', () => {
  for (const complete of [false, true]) {
    const doc = page(); const baseline = snapshot(doc);
    append(doc, turn('new', '<p>GLM 的能力评价。</p><img src="https://assets.st-note.com/production/uploads/images/fixture.png"><img src="http://news.example/thumbnail.jpg">'));
    for (const image of doc.querySelectorAll('img')) Object.defineProperties(image, { complete: { value: complete }, naturalWidth: { value: 0 }, naturalHeight: { value: 0 } });
    const result = finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Question new'));
    assert.equal(result.text, 'GLM 的能力评价。\n\n提示：本次回复有 2 张外部来源图片未转发，请在 ChatGPT 网页查看。');
    assert.deepEqual(result.images, []);
    assert.equal(markdownText(doc.querySelector('[data-markdown-text-style]')), 'GLM 的能力评价。');
  }
});

test('an external-image-only answer yields a notice only after its attributed turn is complete', () => {
  const doc = page(); const baseline = snapshot(doc);
  append(doc, turn('new', '<img src="https://note.com/fixture.png">', { plainImage: true }));
  const user = findSubmittedUser(doc, baseline, 'Question new');
  Object.defineProperty(doc.querySelector('img'), 'complete', { value: false });
  const state = doc.querySelector('[data-talvt-turn-state]');
  state.setAttribute('data-talvt-turn-state', 'streaming'); assert.equal(finalCandidate(doc, baseline, user), null);
  state.setAttribute('data-talvt-turn-state', 'complete');
  const copy = doc.querySelector('.turn-action-controls button'); copy.hidden = true;
  assert.equal(finalCandidate(doc, baseline, user), null); copy.hidden = false;
  assert.equal(finalCandidate(doc, baseline, user).text, '提示：本次回复有 1 张外部来源图片未转发，请在 ChatGPT 网页查看。');
  assert.deepEqual(finalCandidate(doc, baseline, user).images, []);
  append(doc, turn('manual', '<p>Another answer.</p>'));
  assert.throws(() => finalCandidate(doc, baseline, user), /其他消息/);
});

test('mixed supported and external images keep supported image limits and count duplicate external sources once', () => {
  const doc = page(); const baseline = snapshot(doc);
  const sources = Array.from({ length: 4 }, (_, index) => `https://files.oaiusercontent.com/generated-${index}.png`);
  const external = Array.from({ length: 6 }, (_, index) => `https://note.com/thumbnail-${index}.png`);
  append(doc, turn('new', '<p>Supported images and search illustrations.</p>' + sources.concat(external, external).map(src => `<img src="${src}">`).join('')));
  for (const image of doc.querySelectorAll('img[src^="https://note.com/"]')) Object.defineProperty(image, 'complete', { value: false });
  const user = findSubmittedUser(doc, baseline, 'Question new'); const result = finalCandidate(doc, baseline, user);
  assert.deepEqual(result.images.map(image => image.src), sources);
  assert.equal(result.text, 'Supported images and search illustrations.\n\n提示：本次回复有 6 张外部来源图片未转发，请在 ChatGPT 网页查看。');
  doc.querySelector('[data-markdown-text-style]').insertAdjacentHTML('beforeend', '<img src="https://files.oaiusercontent.com/extra.png">'); loaded(doc);
  assert.throws(() => finalCandidate(doc, baseline, user), /超过 4 张/);
});

test('external omissions deduplicate across galleries without losing a supported generated image', () => {
  const f = galleryImages([2, 1]); const images = [...f.doc.querySelectorAll('img')];
  for (const image of images.slice(1)) { image.src = 'https://note.com/repeated.png'; Object.defineProperty(image, 'complete', { value: false }); }
  const result = finalCandidate(f.doc, f.baseline, f.user);
  assert.deepEqual(result.images.map(image => image.src), [f.sources[0]]);
  assert.equal(result.text, '提示：本次回复有 1 张外部来源图片未转发，请在 ChatGPT 网页查看。');
});

test('external omission notices exclude history, user images, reasoning, hidden images and UI icons', () => {
  const old = 'https://note.com/old.png'; const doc = page(turn('old', `<img src="${old}">`)); const baseline = snapshot(doc);
  append(doc, turn('new', '<p>Current answer.</p>' + `<img src="${old}">` +
    '<details open><img src="https://note.com/reasoning.png"></details><span hidden><img src="https://note.com/hidden.png"></span>' +
    '<span data-testid="avatar"><img src="https://note.com/avatar.png"></span><span data-testid="icon"><img src="https://note.com/icon.png"></span>' + citationFavicon(),
    { userImage: '<img src="https://note.com/user.png">' }));
  for (const image of doc.querySelectorAll('img')) Object.defineProperty(image, 'complete', { value: false });
  const result = finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Question new'));
  assert.equal(result.text, 'Current answer.'); assert.deepEqual(result.images, []);
});

test('image extraction still waits for supported image load and rejects malformed, unsafe or excessive results', () => {
  for (const [content, pattern] of [
    ...['data:image/png;base64,AA==', 'blob:https://other.example/image', 'file:///private/example', 'https://user:secret@note.com/image', 'https://chatgpt.com:444/image', 'http://chatgpt.com/image', 'http://[malformed'].map(src => [`<img src="${src}">`, /来源不受支持/]),
    ['<canvas width="512" height="512"></canvas>', /画布图片/],
    [Array.from({ length: 5 }, (_, index) => `<img src="https://files.oaiusercontent.com/${index}.png">`).join(''), /超过 4 张/],
  ]) {
    const doc = page(); const baseline = snapshot(doc); append(doc, turn('new', content));
    assert.throws(() => finalCandidate(doc, baseline, findSubmittedUser(doc, baseline, 'Question new')), pattern);
  }
  const doc = page(); const baseline = snapshot(doc); append(doc, turn('new', `<img src="${imageUrl}">`));
  const user = findSubmittedUser(doc, baseline, 'Question new'); const img = doc.querySelector('img');
  Object.defineProperty(img, 'complete', { value: false, configurable: true });
  assert.equal(finalCandidate(doc, baseline, user), null);
  Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 0 } });
  assert.throws(() => finalCandidate(doc, baseline, user), /未正常加载/);
});

test('image URL allowlist accepts only the rendered ChatGPT and owned image CDN origins', () => {
  for (const source of [imageUrl, 'https://chatgpt.com/rendered-image?id=synthetic', 'blob:https://chatgpt.com/synthetic-id']) assert.equal(answerImageSource(source), source);
  for (const source of ['http://chatgpt.com/image', 'https://chatgpt.com.evil.example/image', 'https://files.oaiusercontent.com.evil.example/image', 'https://user:secret@chatgpt.com/image', 'https://chatgpt.com:444/image', 'blob:https://other.example/id', 'data:image/png;base64,AA==', 'file:///private/example']) assert.throws(() => answerImageSource(source), /来源不受支持/);
});

test('image download uses only the actual source and omits cross-origin credentials', async () => {
  for (const source of [imageUrl, 'https://chatgpt.com/rendered-image', 'blob:https://chatgpt.com/synthetic-id']) {
    let observed;
    const payload = await readAnswerImage({ src: source }, { fetchImpl: async (url, options) => { observed = { url, options }; return new Response(png, { headers: { 'content-type': 'image/png' } }); } });
    assert.equal(observed.url, source);
    assert.equal(observed.options.credentials, new URL(source).origin === 'https://chatgpt.com' ? 'same-origin' : 'omit');
    assert.equal(observed.options.redirect, 'error');
    assert.equal(observed.options.referrerPolicy, 'no-referrer');
    assert.deepEqual(payload, { mimeType: 'image/png', base64: encodedPng, byteLength: png.length });
    assert.deepEqual(decodeImagePayload(payload.mimeType, payload.base64), png);
  }
});

test('image download rejects oversized, disguised and interrupted responses without leaking signed source URLs', async () => {
  for (const [response, pattern] of [
    [new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) } }), /超过 10 MB/],
    [new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), { headers: { 'content-type': 'image/png' } }), /超过 10 MB/],
    [new Response(png, { headers: { 'content-type': 'image/svg+xml' } }), /格式不支持/],
    [new Response('<html>not an image</html>', { headers: { 'content-type': 'image/png' } }), /声明格式不一致/],
  ]) await assert.rejects(readAnswerImage({ src: imageUrl }, { fetchImpl: async () => response }), pattern);
  await assert.rejects(readAnswerImage({ src: imageUrl }, { fetchImpl: async () => { throw new Error(imageUrl); } }), error => /无法读取/.test(error.message) && !error.message.includes('private-synthetic-signature'));
  await assert.rejects(readAnswerImage({ src: imageUrl }, { fetchImpl: () => new Promise(() => {}), timeoutMs: 5 }), /超时/);
  assert.throws(() => decodeImagePayload('image/jpeg', encodedPng), /声明格式不一致/);
  assert.throws(() => decodeImagePayload('image/png', 'not-base64'), /数据无效/);
});

test('the exact 10 MB payload limit decodes successfully and a stuck stream cancel cannot defeat timeout', async () => {
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES); bytes.set(png);
  const decoded = decodeImagePayload('image/png', bytes.toString('base64'));
  assert.equal(decoded.length, MAX_IMAGE_BYTES);
  assert.deepEqual(decoded.subarray(0, png.length), png);
  const stuck = () => new Promise(() => {});
  await assert.rejects(readAnswerImage({ src: imageUrl }, { timeoutMs: 5, fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }), body: { getReader: () => ({ read: stuck, cancel: stuck }) } }) }), /超时/);
});
