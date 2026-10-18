import { validateWordList, mergeWordLists } from './moderation.js';

// Apply only newly introduced presets once per assistant/platform. A user's
// removals from older presets and all custom words remain intact.
export function upgradeWordConfig(saved, preset) {
  if (preset?.version !== 1 || !Number.isSafeInteger(preset.revision) || preset.revision < 1 || !validateWordList(preset.words).valid) throw new Error('预设词表无效');
  const config = saved ?? {};
  if (!Object.hasOwn(config, 'words')) return { ...config, words: [...preset.words], wordPresetRevision: preset.revision, wordPresetUpdatePending: false };
  if (!validateWordList(config.words).valid) return config;
  const previous = Number.isSafeInteger(config.wordPresetRevision) ? config.wordPresetRevision : 1;
  if (previous >= preset.revision) return config;
  const additions = (preset.updates || []).filter(update => update.revision > previous && update.revision <= preset.revision).map(update => update.words);
  const merged = mergeWordLists(config.words, ...additions);
  if (!merged.valid) return config.wordPresetUpdatePending ? config : { ...config, wordPresetUpdatePending: true };
  return { ...config, words: merged.words, wordPresetRevision: preset.revision, wordPresetUpdatePending: false };
}
