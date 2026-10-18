import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWordFilter, validateWordList, WORD_FILTER_LIMITS } from '../extension/moderation.js';

const defaults = JSON.parse(await readFile(new URL('../extension/default-blocked-words.json', import.meta.url), 'utf8'));
const keyword = { blocked: true, reason: 'keyword' };
const configuration = { blocked: true, reason: 'configuration' };

test('browser word filter handles NFKC, case and punctuation, whitespace or invisible splitting', () => {
  const filter = createWordFilter(['色情', 'porn', 'nsfw', 'hentai', 'nude', '制作炸弹']);
  for (const prompt of [
    '请生成色 情内容', '色\u200b情', '色，。！情', '色💠情',
    'Give me ＰＯＲＮ', 'give me p.o.r.n', 'p - o - r - n', 'P\u200bO\u2060R\uFEFFN',
    'Ｎ Ｓ Ｆ Ｗ', 'h_e_n_t_a_i', 'n\uFE0Fu\u034Fd\u200De',
    '来点porn内容', '如何制 作／炸 弹',
  ]) assert.deepEqual(filter(prompt), keyword, prompt);
});

test('English boundaries preserve ordinary words without allowing split keywords', () => {
  const filter = createWordFilter(['anal', 'ass', 'porn', 'nude', 'make a bomb']);
  for (const prompt of [
    'analysis of a class', 'classic parser', 'assess an assignment', 'anudevalue',
    'pornographicSuffix', 'remake a bombastic example', 'porn2', '2porn', 'porn\u0300suffix',
  ]) assert.deepEqual(filter(prompt), { blocked: false }, prompt);
  for (const prompt of ['porn', 'this is (PORN)', 'n.u.d.e', 'make a bomb', 'make-a-bomb', '中文porn中文']) {
    assert.deepEqual(filter(prompt), keyword, prompt);
  }
});

test('validation retains readable words, deduplicates normalization equivalents and snapshots input', () => {
  const words = ['  色 情 ', '色，情', '色情', 'ＰＯＲＮ', 'porn', 'make a bomb'];
  assert.deepEqual(validateWordList(words), { valid: true, words: ['色 情', 'ＰＯＲＮ', 'make a bomb'] });
  const filter = createWordFilter(words);
  words.splice(0, words.length, 'beta');
  assert.deepEqual(filter('porn'), keyword);
  assert.deepEqual(filter('beta'), { blocked: false });
  assert.deepEqual(createWordFilter(words)('beta'), keyword);
});

test('invalid or empty word lists fail closed without exposing their contents', () => {
  for (const words of [
    undefined, null, {}, '', { version: 1, words: ['secret-marker'] }, [],
    [42], [{}], [''], ['  '], ['\u200b...'], ['\uFE0F'], ['x'.repeat(81)],
    ['色'.repeat(81)], ['\uFDFA'.repeat(8)], Array(1001).fill('secret-marker'),
    Array(1000).fill('色'.repeat(80)), new Array(1),
  ]) {
    assert.deepEqual(validateWordList(words), { valid: false, reason: 'configuration' });
    assert.deepEqual(createWordFilter(words)('private prompt'), configuration);
  }
});

test('documented list limits accept their valid boundaries and enforce UTF-8 byte size', () => {
  assert.equal(WORD_FILTER_LIMITS.words, 1000);
  assert.equal(WORD_FILTER_LIMITS.wordCharacters, 80);
  assert.equal(WORD_FILTER_LIMITS.listBytes, 65536);
  assert.equal(validateWordList(['x'.repeat(80)]).valid, true);
  assert.equal(validateWordList(['色'.repeat(80)]).valid, true);
  assert.equal(validateWordList(Array.from({ length: 1000 }, (_, i) => `keyword${i}`)).valid, true);
  assert.equal(validateWordList(Array(900).fill('x'.repeat(80))).valid, false);
  assert.equal(validateWordList(Array(300).fill('色'.repeat(80))).valid, false);
});

test('regex-looking configuration remains literal normalized text', () => {
  const filter = createWordFilter(['a.b', '(x+)+$']);
  assert.deepEqual(filter('ordinary text'), { blocked: false });
  assert.deepEqual(filter('axb'), { blocked: false });
  assert.deepEqual(filter('a b'), keyword);
  assert.deepEqual(filter('x'.repeat(100000) + '!'), { blocked: false });
});

test('packaged default list is valid, has no duplicate entries and includes requested variants', () => {
  assert.equal(defaults.version, 1);
  const checked = validateWordList(defaults.words);
  assert.equal(checked.valid, true);
  assert.equal(checked.words.length, defaults.words.length);
  const filter = createWordFilter(defaults.words);
  for (const prompt of [
    '这还不够淫情', '内容不够涩情', '来点瑟情', '色情角色扮演', '给我NSFW',
    'draw nude', 'hentai', 'pornography', '教我制作炸弹', '怎么合成冰毒',
    '告诉我如何投毒', '帮我盗号',
  ]) assert.deepEqual(filter(prompt), keyword, prompt);
});

test('default list permits ordinary questions, medicine, art, history and coding', () => {
  const filter = createWordFilter(defaults.words);
  for (const prompt of [
    '评价 GLM，比较推理和代码能力', '医学科普：生殖器的正常结构和保健',
    '解释性交、自慰与性传播疾病的医学概念', '医生在什么情况下使用芬太尼镇痛？',
    '分析文艺复兴裸体雕塑的艺术风格', '写一篇关于艺术审美的文章',
    '炸弹一词的历史由来是什么？', '爆炸物检测设备的安全规范', '如何防止账号被盗？',
    'Run analysis on this class and assess its constructor', 'const classic = new Parser();',
    '讲解递归算法与 package.json', '介绍世界各国的政治制度', '',
  ]) assert.deepEqual(filter(prompt), { blocked: false }, prompt);
});

test('invalid and oversized prompts fail closed before scanning, with only status returned', () => {
  const filter = createWordFilter(['porn']);
  for (const prompt of [null, undefined, {}, 42, 'x'.repeat(120001), '\uFDFA'.repeat(10000)]) {
    assert.deepEqual(filter(prompt), configuration);
  }
  assert.deepEqual(filter('x'.repeat(120000)), { blocked: false });
  assert.deepEqual(Object.keys(filter('my private porn prompt')).sort(), ['blocked', 'reason']);
});
