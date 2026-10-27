// Loaded before the stylesheet so a saved theme applies before the first paint.
(() => {
  'use strict';
  const choices = ['system', 'light', 'dark'];
  const key = 'camunda85-theme';
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const saved = localStorage.getItem(key);
    if (choices.includes(saved)) preference = saved;
  } catch { /* Storage may be unavailable when the archive is opened from disk. */ }

  function apply() {
    document.documentElement.dataset.theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.dispatchEvent(new CustomEvent('themechange', { detail: preference }));
  }
  function setPreference(value) {
    if (!choices.includes(value)) return;
    preference = value;
    try { localStorage.setItem(key, preference); } catch { /* The current page still works. */ }
    apply();
  }
  window.CamundaTheme = { getPreference: () => preference, setPreference };
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = choices.includes(event.newValue) ? event.newValue : 'system';
      apply();
    }
  });
  apply();
})();
