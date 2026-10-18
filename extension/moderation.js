// Pure browser module: callers own persistence and rebuild the filter whenever
// the stored word list changes. Entries are literal strings, never regexes.
export const WORD_FILTER_LIMITS = Object.freeze({
  words: 1000,
  wordCharacters: 80,
  listBytes: 64 * 1024,
  textCodeUnits: 120_000,
});

const INVISIBLE = /[\p{Cf}\u034f\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
const CONTENT = /[\p{L}\p{N}\p{M}]/u;
const LATIN_WORD = /^[\p{Script=Latin}\p{N}\p{M}]+$/u;
const LATIN_NEIGHBOR = /[\p{Script=Latin}\p{N}\p{M}]/u;
const blocked = reason => ({ blocked: true, reason });
const invalid = () => ({ valid: false, reason: 'configuration' });

function fold(value) {
  return value.normalize('NFKC').toLowerCase().replace(INVISIBLE, '');
}

function compact(value, positions = false) {
  let text = '';
  const points = Array.from(value);
  const indices = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!CONTENT.test(point)) continue;
    text += point;
    if (positions) for (let unit = 0; unit < point.length; unit += 1) indices.push(index);
  }
  return { text, points, indices };
}

/**
 * Validate an editable array, preserving its readable spelling while removing
 * equivalent duplicates. Invalid/empty lists are rejected as a whole. The byte
 * limit applies to the UTF-8 JSON representation of the supplied word array.
 * Failures contain no configured words or exception details.
 */
export function validateWordList(input) {
  try {
    if (!Array.isArray(input) || !input.length || input.length > WORD_FILTER_LIMITS.words) return invalid();
    const words = [];
    const seen = new Set();
    for (const entry of input) {
      if (typeof entry !== 'string' || entry.length > WORD_FILTER_LIMITS.wordCharacters * 2 ||
          Array.from(entry).length > WORD_FILTER_LIMITS.wordCharacters || !entry.trim()) return invalid();
      const normalized = compact(fold(entry)).text;
      if (!normalized || Array.from(normalized).length > WORD_FILTER_LIMITS.wordCharacters) return invalid();
      if (!seen.has(normalized)) { words.push(entry.trim()); seen.add(normalized); }
    }
    if (new TextEncoder().encode(JSON.stringify(input)).length > WORD_FILTER_LIMITS.listBytes) return invalid();
    return { valid: true, words };
  } catch {
    return invalid();
  }
}

// Merge validated lists before applying the total limit, so equivalent user
// spellings do not consume extra slots. Never truncate custom entries.
export function mergeWordLists(...lists) {
  const result = []; const seen = new Set();
  for (const list of lists) {
    const checked = validateWordList(list);
    if (!checked.valid) return checked;
    for (const word of checked.words) {
      const key = compact(fold(word)).text;
      if (!seen.has(key)) { seen.add(key); result.push(word); }
    }
  }
  return validateWordList(result);
}

/**
 * Compile a snapshot of a validated word list. This is a literal keyword gate,
 * not semantic moderation. Invalid configuration/input fails closed; results
 * never include the prompt, matched word, or exception. No I/O is performed.
 */
export function createWordFilter(input) {
  const validation = validateWordList(input);
  if (!validation.valid) return () => blocked('configuration');
  const words = validation.words.map(entry => {
    const value = compact(fold(entry)).text;
    return { value, latin: LATIN_WORD.test(value) };
  });
  return input => {
    try {
      if (typeof input !== 'string' || input.length > WORD_FILTER_LIMITS.textCodeUnits) return blocked('configuration');
      const normalized = fold(input);
      if (normalized.length > WORD_FILTER_LIMITS.textCodeUnits) return blocked('configuration');
      const text = compact(normalized, true);
      for (const word of words) {
        let offset = text.text.indexOf(word.value);
        while (offset !== -1) {
          if (!word.latin) return blocked('keyword');
          // Internal punctuation/spacing may be obfuscation. Original adjacent
          // Latin letters/digits/marks still protect ordinary word boundaries.
          // Chinese text can directly surround an English keyword.
          const before = text.points[text.indices[offset] - 1] ?? '';
          const after = text.points[text.indices[offset + word.value.length - 1] + 1] ?? '';
          if (!LATIN_NEIGHBOR.test(before) && !LATIN_NEIGHBOR.test(after)) return blocked('keyword');
          offset = text.text.indexOf(word.value, offset + 1);
        }
      }
      return { blocked: false };
    } catch {
      return blocked('configuration');
    }
  };
}
