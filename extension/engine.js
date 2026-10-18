import { BridgeStore as QQStore } from './qq-store.js';
import { BridgeStore as FeishuStore } from './feishu-store.js';
import { ExtensionEngine as QQEngine } from './qq-runtime.js';
import { ExtensionEngine as FeishuEngine } from './feishu-runtime.js';
import { createBrowserQQAdapter } from './qq-client.js';
import { createBrowserFeishuAdapter } from './feishu-client.js';
import { IndexedDBStorage } from './storage.js';
import { createWordFilter } from './moderation.js';
import { upgradeWordConfig } from './word-presets.js';
import { createWorkPump } from './work-pump.js';
import { PlatformRouter } from './platform-router.js';
import { AssistantRouter } from './assistant-router.js';
import { ASSISTANTS } from './shared.js';

function settingsDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('chatgpt-bot-bridge-settings', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('扩展配置存储无法打开'));
  });
}
const ready = (async () => {
  const defaults = await (await fetch(new URL('./default-blocked-words.json', import.meta.url))).json();
  const database = await settingsDatabase();
  const access = (key, write = false, value) => new Promise((resolve, reject) => {
    const tx = database.transaction('settings', write ? 'readwrite' : 'readonly');
    const table = tx.objectStore('settings');
    const request = write ? table.put(value, key) : table.get(key);
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(new Error('扩展配置未能保存，请检查浏览器存储空间'));
  });
  const pumps = {}; const routers = {};
  // A hint contains no job or account data. The service worker resolves the
  // current platform and binding, and the page still acquires a normal lease.
  const notifyPages = () => { try { self.postMessage({ type: 'bridge:work-available' }); } catch {} };
  for (const assistant of ASSISTANTS) {
    const prefix = assistant === 'chatgpt' ? '' : `assistant.${assistant}.`;
    const wake = () => { for (const platform of ['qq', 'feishu']) pumps[`${assistant}:${platform}`]?.wake(); notifyPages(); };
    const engines = {};
    for (const [platform, Store, Engine, adapterFactory] of [
      ['qq', QQStore, QQEngine, createBrowserQQAdapter],
      ['feishu', FeishuStore, FeishuEngine, createBrowserFeishuAdapter],
    ]) {
      let filter = createWordFilter(defaults.words);
      const name = assistant === 'chatgpt' ? `chatgpt-bot-bridge-${platform}` : `chatgpt-bot-bridge-${assistant}-${platform}`;
      const storage = await IndexedDBStorage.open(name);
      const store = await Store.open({ storage, assistant, moderate: prompt => filter(prompt) });
      engines[platform] = new Engine({ store,
        readConfig: async () => {
          const key = `${prefix}config.${platform}`; const saved = await access(key);
          const upgraded = upgradeWordConfig(saved, defaults);
          if (upgraded !== saved) await access(key, true, upgraded);
          return upgraded;
        }, writeConfig: value => access(`${prefix}config.${platform}`, true, value),
        adapterFactory: options => adapterFactory({ ...options, assistant }), defaultWords: defaults.words, setWords: words => { filter = createWordFilter(words); },
        onWork: () => { pumps[`${assistant}:${platform}`]?.wake(); notifyPages(); },
      });
      pumps[`${assistant}:${platform}`] = createWorkPump({ step: async () => {
        const worked = await routers[assistant].tick(platform);
        if (worked) notifyPages();
        return worked;
      } });
    }
    routers[assistant] = new PlatformRouter({ engines,
      readSelection: () => access(`${prefix}active-platform`), writeSelection: value => access(`${prefix}active-platform`, true, value),
      readChannels: () => access(`${prefix}enabled-channels`), writeChannels: value => access(`${prefix}enabled-channels`, true, value),
      onWork: wake,
    });
  }
  const router = new AssistantRouter({ routers,
    readEnabled: assistant => access(`assistant.${assistant}.enabled`),
    writeEnabled: (assistant, value) => access(`assistant.${assistant}.enabled`, true, value),
  });
  await router.init();
  for (const pump of Object.values(pumps)) pump.start();
  return router;
})();
self.addEventListener('message', event => {
  const { id, route, body } = event.data ?? {};
  if (typeof id !== 'string' || typeof route !== 'string') return;
  ready.then(router => router.request(route, body)).then(
    data => self.postMessage({ id, ok: true, data }),
    error => self.postMessage({ id, ok: false, status: error?.status || 500, error: error?.status ? error.message : '扩展操作未完成，请检查平台配置、词表和浏览器存储。' }),
  );
});
ready.catch(() => {});
