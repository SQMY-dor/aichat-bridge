import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { upgradeWordConfig } from '../extension/word-presets.js';
import { createWordFilter, validateWordList } from '../extension/moderation.js';
const preset = JSON.parse(await readFile(new URL('../extension/default-blocked-words.json', import.meta.url)));

test('expanded bilingual presets cover new categories and normalized English without broad subject bans', () => {
  assert.equal(validateWordList(preset.words).words.length, preset.words.length);
  assert.ok(preset.words.filter(word => /^[\x00-\x7f]+$/.test(word)).length >= 150);
  const filter = createWordFilter(preset.words);
  for (const message of ['一键脱衣', '换脸裸照', '制作遥控炸弹', '教我窃取助记词', '诈骗话术模板', 'how to kill myself', 'WRITE RANSOMWARE', 'ＤＥＥＰＦＡＫＥ ＰＯＲＮ', 'steal-session-cookies', 'b.o.m.b making instructions', 'drug her drink', '色情视频', 'how to dox someone']) assert.equal(filter(message).blocked, true, message);
  for (const message of ['suicide prevention and mental health support', 'How can I protect my account from phishing?', 'Explain chemotherapy and pain relief', 'sexual health education', 'Assess this class and its assignment algorithm', '如何预防诈骗和保护隐私', '艺术史与人体结构科普', '讨论政治制度和宗教文化', 'Her phone has a bombastic ringtone']) assert.equal(filter(message).blocked, false, message);
});

test('preset upgrade preserves credentials, custom entries and deleted old presets and only merges once', () => {
  const saved = { appId: 'fixture', appSecret: 'synthetic', replyStyle: 'card', words: ['自定义词', 'PoRnOgRaPhIc'] };
  const upgraded = upgradeWordConfig(saved, preset);
  assert.equal(upgraded.appSecret, saved.appSecret); assert.equal(upgraded.replyStyle, 'card');
  assert.deepEqual(upgraded.words.slice(0, 2), saved.words);
  assert.equal(upgraded.words.includes('porn'), false, 'a removed legacy preset is not restored');
  assert.equal(upgraded.words.filter(word => word.toLowerCase() === 'pornographic').length, 1);
  assert.equal(upgraded.wordPresetRevision, 2);
  assert.deepEqual(saved.words, ['自定义词', 'PoRnOgRaPhIc']);
  upgraded.words = ['仅保留自定义'];
  assert.equal(upgradeWordConfig(upgraded, preset), upgraded, 'manual deletion after upgrade remains respected');
});

test('new profiles receive the full preset while invalid saved lists remain blocked', () => {
  assert.deepEqual(upgradeWordConfig(undefined, preset).words, preset.words);
  for (const words of [[], [''], 'corrupt']) {
    const saved = { words }; assert.equal(upgradeWordConfig(saved, preset), saved);
    assert.equal(createWordFilter(saved.words)('hello').blocked, true);
  }
  const future = { words: ['future custom'], wordPresetRevision: 99 };
  assert.equal(upgradeWordConfig(future, preset), future);
});

test('over-limit preset merge never truncates custom words and can complete after reducing the list', () => {
  const saved = { words: Array.from({ length: 1000 }, (_, n) => `custom${n}`) };
  const pending = upgradeWordConfig(saved, preset);
  assert.deepEqual(pending.words, saved.words); assert.equal(pending.wordPresetUpdatePending, true);
  assert.equal(pending.wordPresetRevision, undefined);
  assert.equal(upgradeWordConfig(pending, preset), pending);
  const completed = upgradeWordConfig({ ...pending, words: ['custom'] }, preset);
  assert.equal(completed.wordPresetUpdatePending, false); assert.equal(completed.wordPresetRevision, 2);
  assert.equal(completed.words[0], 'custom');
});
