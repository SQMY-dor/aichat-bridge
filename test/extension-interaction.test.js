import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptsComposer } from '../extension/shared.js';

test('screenshot, copy, selection and navigation keys do not look like composer edits', () => {
  for (const submissionClicked of [false, true]) {
    for (const key of ['Meta', 'Shift', 'Control', 'Alt', 'PrintScreen', 'Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
      assert.equal(interruptsComposer({ type: 'keydown', key }, submissionClicked), false, key);
    }
    for (const event of [
      { key: '4', metaKey: true, shiftKey: true },
      { key: 's', metaKey: true, shiftKey: true },
      { key: 'c', metaKey: true }, { key: 'c', ctrlKey: true },
      { key: 'a', metaKey: true },
    ]) assert.equal(interruptsComposer({ type: 'keydown', ...event }, submissionClicked), false);
  }
});

test('typing, deleting, submitting, IME and real clipboard mutations still stop the task', () => {
  for (const submissionClicked of [false, true]) {
    for (const key of ['a', ' ', '中', 'Enter', 'Backspace', 'Delete']) {
      assert.equal(interruptsComposer({ type: 'keydown', key }, submissionClicked), true, key);
    }
    assert.equal(interruptsComposer({ type: 'keydown', key: 'Process', isComposing: true }, submissionClicked), true);
    for (const type of ['beforeinput', 'input', 'paste']) assert.equal(interruptsComposer({ type }, submissionClicked), true);
  }
});

test('a focus click only interrupts while bridge inputs are still being prepared', () => {
  assert.equal(interruptsComposer({ type: 'pointerdown' }, false), true);
  assert.equal(interruptsComposer({ type: 'pointerdown' }, true), false);
  assert.equal(interruptsComposer({ type: 'focus' }, true), false);
});
