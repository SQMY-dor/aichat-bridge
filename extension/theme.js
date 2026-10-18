// Settings-only preference: never touches bot credentials or connection state.
(() => {
  const key = 'aichat.settings.theme';
  const choices = new Set(['system', 'light', 'dark']);
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system'; let storage;
  try {
    storage = window.localStorage;
    const saved = storage.getItem(key);
    if (choices.has(saved)) preference = saved;
  } catch { /* The page still works if preference storage is unavailable. */ }
  function apply() {
    document.documentElement.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    const control = document.getElementById('theme');
    if (control) control.value = preference;
  }
  apply();
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (!storage || event.storageArea !== storage || (event.key !== key && event.key !== null)) return;
    preference = choices.has(event.newValue) ? event.newValue : 'system'; apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('theme').addEventListener('change', event => {
      preference = choices.has(event.target.value) ? event.target.value : 'system';
      try { storage?.setItem(key, preference); } catch { /* Apply for this tab even if saving fails. */ }
      apply();
    });
  }, { once: true });
})();
