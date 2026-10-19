import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as chatgpt from '../extension/dom.js';
import * as claude from '../extension/claude-dom.js';
import * as gemini from '../extension/gemini-dom.js';
import * as qwen from '../extension/qwen-dom.js';
import { page as qwenPage } from './helpers/qwen-fixture.js';

const geminiHTML = await readFile(new URL('./fixtures/gemini-conversation.html', import.meta.url), 'utf8');
const claudeHTML = await readFile(new URL('./fixtures/claude-conversation.html', import.meta.url), 'utf8');
const prompt = 'First line\nSecond line';
const modes = [
  { name: 'ChatGPT', adapter: chatgpt, finalInput: false, html: '<form><div id="prompt-textarea" contenteditable="true" role="textbox"></div><button data-testid="send-button">Send</button></form>', url: 'https://chatgpt.com/c/input-event-fixture' },
  { name: 'Claude', adapter: claude, finalInput: false, html: claudeHTML, url: 'https://claude.ai/chat/11111111-1111-4111-8111-111111111111' },
  { name: 'Gemini', adapter: gemini, finalInput: true, html: geminiHTML, url: 'https://gemini.google.com/app/1111111111111111' },
];
const qwenMode = { name: 'Qwen', adapter: qwen };
const allModes = [...modes, qwenMode];
const insert = (mode, doc, input) => mode.adapter.insertPrompt(doc, input, prompt);
function page(mode) {
  const window = mode === qwenMode ? qwenPage().window : new JSDOM(mode.html, { url: mode.url }).window;
  const doc = window.document, input = mode.adapter.composer(doc);
  return { window, doc, input };
}
function recordInputs(doc, input) {
  const nativeEvents = [], events = [];
  input.addEventListener('input', event => events.push({ event, text: chatgpt.composerText(input) }));
  return {
    nativeEvents, events,
    // JSDOM cannot create trusted input events. Retain the exact events emitted
    // by our execCommand model so the assertions distinguish them from any
    // notification subsequently emitted by the production insertion helper.
    emitNative(count) {
      const parts = count === 1 ? [{ inputType: 'insertText', data: prompt }] : [
        { inputType: 'insertText', data: 'First line' },
        { inputType: 'insertParagraph', data: null },
        { inputType: 'insertText', data: 'Second line' },
      ];
      for (const part of parts.slice(0, count)) {
        const event = new doc.defaultView.InputEvent('input', { bubbles: true, ...part });
        nativeEvents.push(event); input.dispatchEvent(event);
      }
    },
    extra() { return events.filter(item => !nativeEvents.includes(item.event)); },
  };
}
function writePrompt(doc, input, text = prompt) {
  input.replaceChildren(...text.split('\n').map(line => {
    const paragraph = doc.createElement('p'); paragraph.textContent = line; return paragraph;
  }));
}

for (const mode of modes) for (const nativeCount of [0, 1, 3]) {
  test(`${mode.name} preserves ${nativeCount} execCommand input events and emits only its required final notification`, () => {
    const { window, doc, input } = page(mode), recorded = recordInputs(doc, input);
    let commands = 0, clicks = 0;
    doc.querySelectorAll('button').forEach(button => button.addEventListener('click', () => clicks++));
    doc.execCommand = (command, showUI, value) => {
      commands++; assert.equal(command, 'insertText'); assert.equal(showUI, false); assert.equal(value, prompt);
      writePrompt(doc, input); recorded.emitNative(nativeCount); return true;
    };
    try {
      insert(mode, doc, input);
      assert.equal(commands, 1); assert.equal(clicks, 0);
      assert.equal(mode.adapter.composerText(input), prompt);
      recorded.nativeEvents.forEach((event, index) => assert.equal(recorded.events[index].event, event));
      const extra = recorded.extra(), expected = mode.finalInput || nativeCount === 0 ? 1 : 0;
      assert.equal(extra.length, expected);
      assert.equal(recorded.events.length, nativeCount + expected);
      if (expected) {
        const last = recorded.events.at(-1);
        assert.equal(last, extra[0]); assert.equal(last.text, prompt);
        assert.equal(last.event.inputType, 'insertText'); assert.equal(last.event.data, prompt);
        assert.equal(last.event.bubbles, true); assert.equal(last.event.target, input);
      }
    } finally { window.close(); }
  });
}

for (const mode of modes) for (const failure of ['returns-false', 'throws']) for (const nativeCount of [0, 1]) {
  test(`${mode.name} adds no final notification when execCommand ${failure}, after ${nativeCount} native event`, () => {
    const { window, doc, input } = page(mode), recorded = recordInputs(doc, input);
    doc.execCommand = () => {
      writePrompt(doc, input);
      recorded.emitNative(nativeCount);
      if (failure === 'throws') throw new Error('Synthetic edit failure');
      return failure !== 'returns-false';
    };
    try {
      assert.throws(() => insert(mode, doc, input));
      assert.equal(recorded.extra().length, 0, 'a failed edit must not announce the complete prompt');
      assert.deepEqual(recorded.events.map(item => item.event), recorded.nativeEvents);
    } finally { window.close(); }
  });
}

for (const mode of modes) for (const nativeCount of [0, 1]) {
  test(`${mode.name} still rejects mismatched final text after ${nativeCount} native event`, () => {
    const { window, doc, input } = page(mode), recorded = recordInputs(doc, input);
    let clicks = 0;
    doc.querySelectorAll('button').forEach(button => button.addEventListener('click', () => clicks++));
    doc.execCommand = () => { writePrompt(doc, input, 'Different text'); recorded.emitNative(nativeCount); return true; };
    try {
      assert.throws(() => insert(mode, doc, input), /网页输入内容与任务不同/);
      assert.equal(clicks, 0); assert.equal(mode.adapter.composerText(input), 'Different text');
      recorded.nativeEvents.forEach((event, index) => assert.equal(recorded.events[index].event, event));
    } finally { window.close(); }
  });
}

for (const mode of allModes) for (const blocked of ['existing-draft', 'aria-disabled', 'inert', 'detached', ...(mode === qwenMode ? [] : ['missing-exec-command'])]) {
  test(`${mode.name} leaves ${blocked} untouched without extra input notifications`, () => {
    const { window, doc, input } = page(mode), recorded = recordInputs(doc, input);
    let commands = 0;
    doc.execCommand = () => { commands++; return true; };
    if (blocked === 'existing-draft') {
      if (input.tagName === 'TEXTAREA') input.value = 'Existing synthetic draft';
      else input.textContent = 'Existing synthetic draft';
    }
    if (blocked === 'aria-disabled') input.setAttribute('aria-disabled', 'true');
    if (blocked === 'inert') input.parentElement.setAttribute('inert', '');
    if (blocked === 'detached') input.remove();
    if (blocked === 'missing-exec-command') delete doc.execCommand;
    const before = input.innerHTML, beforeText = mode.adapter.composerText(input);
    try {
      assert.throws(() => insert(mode, doc, input));
      assert.equal(commands, 0); assert.equal(recorded.events.length, 0); assert.equal(input.innerHTML, before);
      assert.equal(mode.adapter.composerText(input), beforeText);
    } finally { window.close(); }
  });
}

test('Gemini final input policy stays isolated when other providers insert in the same run', () => {
  for (const mode of [modes[2], modes[0], modes[1], qwenMode, modes[2], modes[0]]) {
    const { window, doc, input } = page(mode), recorded = recordInputs(doc, input);
    let commands = 0;
    doc.execCommand = () => { commands++; writePrompt(doc, input); recorded.emitNative(1); return true; };
    try {
      insert(mode, doc, input);
      assert.equal(recorded.events.length, mode.finalInput ? 2 : 1, mode.name);
      assert.equal(commands, mode === qwenMode ? 0 : 1, mode.name);
      assert.equal(mode.adapter.composerText(input), prompt);
    } finally { window.close(); }
  }
});

for (const mode of allModes) test(`${mode.name} textarea insertion emits one notification without invoking execCommand`, () => {
  const window = new JSDOM('<form><textarea id="prompt-textarea"></textarea></form>').window;
  const doc = window.document, input = doc.querySelector('textarea'), recorded = recordInputs(doc, input);
  let commands = 0;
  doc.execCommand = () => { commands++; return true; };
  try {
    insert(mode, doc, input);
    assert.equal(commands, 0);
    assert.equal(input.value, prompt); assert.equal(recorded.events.length, 1);
    assert.equal(recorded.events[0].event.data, prompt);
    assert.equal(recorded.events[0].event.inputType, 'insertText');
    assert.equal(recorded.events[0].event.bubbles, true);
    assert.equal(recorded.events[0].event.target, input);
  } finally { window.close(); }
});

for (const mode of allModes) test(`${mode.name} disabled and readonly textareas reject input before any edit`, () => {
  for (const disabled of ['fieldset', 'readonly']) {
    const window = new JSDOM('<fieldset><textarea id="prompt-textarea"></textarea></fieldset>').window;
    const doc = window.document, input = doc.querySelector('textarea'), recorded = recordInputs(doc, input);
    if (disabled === 'fieldset') doc.querySelector('fieldset').disabled = true;
    else input.readOnly = true;
    try {
      assert.throws(() => insert(mode, doc, input));
      assert.equal(input.value, ''); assert.equal(recorded.events.length, 0);
    } finally { window.close(); }
  }
});

test('Qwen rejects a contenteditable replacement without using another provider’s insertion policy', () => {
  const { window, doc, input } = page(qwenMode);
  const replacement = doc.createElement('div'); replacement.contentEditable = 'true';
  input.replaceWith(replacement);
  const recorded = recordInputs(doc, replacement);
  let commands = 0; doc.execCommand = () => { commands++; return true; };
  try {
    assert.throws(() => insert(qwenMode, doc, replacement), /Qwen 输入框结构已变化/);
    assert.equal(commands, 0); assert.equal(recorded.events.length, 0); assert.equal(replacement.textContent, '');
  } finally { window.close(); }
});

test('Qwen validates final textarea text after the framework handles its notification', () => {
  const { window, doc, input } = page(qwenMode), recorded = recordInputs(doc, input);
  let clicks = 0; doc.querySelectorAll('button').forEach(button => button.addEventListener('click', () => clicks++));
  input.addEventListener('input', () => { input.value = 'Different text'; });
  try {
    assert.throws(() => insert(qwenMode, doc, input), /网页输入内容与任务不同/);
    assert.equal(input.value, 'Different text'); assert.equal(recorded.events.length, 1); assert.equal(clicks, 0);
  } finally { window.close(); }
});
