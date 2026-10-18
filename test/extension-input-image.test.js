import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { assertReady, composer, hasAttachments, inputAttachmentState, pasteInputImage, validateInputImages, markdownText } from '../extension/dom.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const payload = { mimeType: 'image/png', base64: png.toString('base64') };
const name = 'bridge-synthetic-unique-1.png';
const metadata = { id: '1'.repeat(64), mimeType: 'image/png', name: 'from-qq.png', bytes: png.length };
function page(body = '') {
  return new JSDOM(`<div data-composer-body><div data-composer-attachments>${body}</div><div data-composer-markdown contenteditable="true" role="textbox"></div><button type="submit" aria-label="发送"></button></div>`, { url: 'https://chatgpt.com/c/synthetic-images' }).window.document;
}
function chip(filename, extra = '') { return `<div data-testid="file-chip"><span title="${filename}">${filename}</span>${extra}<button aria-label="Remove attachment"></button></div>`; }
const modernFixture = readFileSync(new URL('./fixtures/chatgpt-modern-attachment.html', import.meta.url), 'utf8');
function realAttachmentPage() {
  const doc = new JSDOM(modernFixture, { url: 'https://chatgpt.com/c/synthetic-images' }).window.document;
  Object.defineProperties(doc.querySelector('img'), { complete: { value: true, configurable: true }, naturalWidth: { value: 1024, configurable: true }, naturalHeight: { value: 1536, configurable: true } });
  return doc;
}

test('input metadata is bounded and reduces server data to identifiers only', () => {
  assert.deepEqual(validateInputImages([{ ...metadata, base64: payload.base64, signedUrl: 'private' }]), [metadata]);
  assert.deepEqual(validateInputImages(), []);
  for (const images of [null, [metadata, metadata], Array(5).fill(metadata), [{ ...metadata, bytes: 10000001 }], [{ ...metadata, bytes: 1.5 }], [{ ...metadata, mimeType: 'image/svg+xml' }], [{ ...metadata, name: '../file.png' }], [{ ...metadata, name: 'bad\nname.png' }], [{ ...metadata, id: 'invalid' }]]) assert.throws(() => validateInputImages(images), /输入图片/);
  assert.throws(() => validateInputImages(Array.from({ length: 4 }, (_, index) => ({ ...metadata, id: String(index).repeat(64), bytes: 10000000 }))), /30 MB/);
});

test('only this run’s complete, named and removable attachment set is accepted', () => {
  const doc = page(); const input = assertReady(doc);
  assert.equal(inputAttachmentState(input, []).ready, true);
  assert.equal(inputAttachmentState(input, [name]).ready, false);
  doc.querySelector('[data-composer-attachments]').innerHTML = chip(name);
  assert.equal(hasAttachments(input), true);
  assert.throws(() => assertReady(doc), /附件/);
  assert.equal(inputAttachmentState(input, [name]).ready, true);
  assert.equal(inputAttachmentState(input, ['unrelated.png']).ready, false);
  assert.equal(inputAttachmentState(input, []).ready, false);
  const second = 'bridge-second.png';
  doc.querySelector('[data-composer-attachments]').insertAdjacentHTML('beforeend', chip(second));
  assert.equal(inputAttachmentState(input, [name]).ready, false);
  assert.equal(inputAttachmentState(input, [name, second]).ready, true);
  doc.querySelector('[data-composer-attachments]').insertAdjacentHTML('beforeend', '<div>unknown-file.pdf</div>');
  assert.equal(inputAttachmentState(input, [name, second]).ready, false);
});

test('uploading, failed, hidden, duplicate and unknown preview structures never allow submission', () => {
  for (const content of [chip(name, '<div role="progressbar"></div>'), chip(name, '<div aria-busy="true"></div>'), chip(name).replace('title=', 'hidden title='), chip(name) + chip(name), '<div>' + name + '</div>', chip('prefix-' + name)]) {
    const doc = page(content);
    assert.equal(inputAttachmentState(composer(doc), [name]).ready, false);
  }
  const errorDoc = page(chip(name, '<div role="alert">Upload failed</div>'));
  assert.throws(() => inputAttachmentState(composer(errorDoc), [name]), /上传失败/);
  const doc = page(chip(name, `<img alt="${name}" src="blob:https://chatgpt.com/synthetic">`));
  assert.equal(inputAttachmentState(composer(doc), [name]).ready, false);
  Object.defineProperties(doc.querySelector('img'), { complete: { value: true }, naturalWidth: { value: 512 }, naturalHeight: { value: 512 } });
  assert.equal(inputAttachmentState(composer(doc), [name]).ready, true);
  doc.querySelector('[data-composer-attachments]').insertAdjacentHTML('beforeend', '<img src="https://example.com/extra.png">');
  assert.equal(inputAttachmentState(composer(doc), [name]).ready, false);
});

test('captured modern attachment recognizes its exact named remove control after upload completes', () => {
  const doc = realAttachmentPage(); const input = composer(doc); const filename = 'bridge-fixture-1.png';
  assert.equal(inputAttachmentState(input, [filename]).ready, true);
  assert.equal(inputAttachmentState(input, []).ready, false);
  assert.throws(() => assertReady(doc), /附件/);
  const remover = doc.querySelector('.composer-attachment-surface > button');
  for (const label of [`移除“${filename}”`, `移除"${filename}"`, `Remove “${filename}”`, `Remove "${filename}"`]) {
    remover.setAttribute('aria-label', label);
    assert.equal(inputAttachmentState(input, [filename]).ready, true);
  }
  for (const label of ['移除', '移除“other.png”', `移除“prefix-${filename}”`, 'Remove "other.png"', 'Remove']) {
    remover.setAttribute('aria-label', label);
    assert.equal(inputAttachmentState(input, [filename]).ready, false);
  }
  remover.setAttribute('aria-label', `移除“${filename}”`);
  doc.querySelector('.composer-attachment-surface').setAttribute('aria-busy', 'true');
  assert.equal(inputAttachmentState(input, [filename]).ready, false);
  doc.querySelector('.composer-attachment-surface').removeAttribute('aria-busy');
  Object.defineProperty(doc.querySelector('img'), 'complete', { value: false });
  assert.equal(inputAttachmentState(input, [filename]).ready, false);
});

test('an unrelated attachment in the real modern layout cannot accompany the expected picture', () => {
  for (const extraIsImage of [true, false]) {
    const doc = realAttachmentPage(); const input = composer(doc);
    const extra = doc.querySelector('.composer-attachment-surface[role="button"]').cloneNode(true);
    extra.setAttribute('aria-label', 'unrelated-file.png');
    extra.querySelector('button').setAttribute('aria-label', '移除“unrelated-file.png”');
    if (extraIsImage) {
      extra.querySelector('img').setAttribute('alt', 'unrelated-file.png');
      Object.defineProperties(extra.querySelector('img'), { complete: { value: true }, naturalWidth: { value: 1024 }, naturalHeight: { value: 1536 } });
    } else {
      extra.querySelector('img').replaceWith(doc.createTextNode('unrelated-file.pdf'));
    }
    doc.querySelector('[data-composer-attachments] > div').append(extra);
    assert.equal(inputAttachmentState(input, ['bridge-fixture-1.png']).ready, false);
  }
});

test('image input dispatches one normal file paste only to the confirmed composer', () => {
  const doc = page(); const win = doc.defaultView; const input = assertReady(doc);
  win.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  win.ClipboardEvent = class extends win.Event { constructor(type, options) { super(type, options); this.clipboardData = options.clipboardData; } };
  const events = [];
  input.addEventListener('paste', event => events.push(event));
  pasteInputImage(doc, input, payload, name);
  assert.equal(events.length, 1);
  assert.equal(events[0].isTrusted, false);
  assert.equal(events[0].clipboardData.files.length, 1);
  const file = events[0].clipboardData.files[0];
  assert.equal(file.name, name); assert.equal(file.type, payload.mimeType); assert.equal(file.size, png.length);
  assert.equal(doc.activeElement, input);
  assert.equal(inputAttachmentState(input, [name]).ready, false); // Dispatch alone is never an upload acknowledgement.
  assert.throws(() => pasteInputImage(doc, input, payload, '../unsafe.png'), /输入目标/);
  assert.throws(() => pasteInputImage(doc, input, { ...payload, mimeType: 'image/jpeg' }, name), /声明格式不一致/);
  assert.equal(events.length, 1);
});

test('unsupported normal-paste UI fails without clicking a file picker or send button', () => {
  const doc = page(); const input = assertReady(doc); let clicks = 0;
  doc.addEventListener('click', () => { clicks++; });
  assert.throws(() => pasteInputImage(doc, input, payload, name), /不支持正常图片粘贴/);
  assert.equal(clicks, 0);
});

test('standard HTML tables include Markdown header separators and preserve escaped cell content', () => {
  const doc = new JSDOM('<div><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>A | B</td><td><strong>1</strong><br>2</td></tr></tbody></table></div>').window.document;
  assert.equal(markdownText(doc.querySelector('div')), '| Name | Value |\n| --- | --- |\n| A \\| B | **1**<br>2 |');
  doc.querySelector('div').innerHTML = '<table><tr><td>A</td><td>B</td></tr><tr hidden><td>hidden</td></tr></table>';
  assert.equal(markdownText(doc.querySelector('div')), '|  |  |\n| --- | --- |\n| A | B |');
});
