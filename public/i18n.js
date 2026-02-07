// public/i18n.js
// Lightweight client-side i18n for tablets
// - defaults to English
// - remembers language selection in localStorage
// - supports {{placeholders}} replacement

const I18N = (() => {
  const DEFAULT_LANG = "en";
  const STORAGE_KEY = "cherneassist_lang";

  let lang = localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG;
  let dict = {};

  function getLang() {
    return lang;
  }

  async function load(nextLang = lang) {
    lang = nextLang || DEFAULT_LANG;
    localStorage.setItem(STORAGE_KEY, lang);

    try {
      const r = await fetch(`/i18n/${encodeURIComponent(lang)}.json`, { cache: "no-store" });
      dict = await r.json();
    } catch {
      // fallback to English if selected file fails
      lang = DEFAULT_LANG;
      localStorage.setItem(STORAGE_KEY, lang);
      try {
        const r = await fetch(`/i18n/${encodeURIComponent(lang)}.json`, { cache: "no-store" });
        dict = await r.json();
      } catch {
        dict = {};
      }
    }
    return dict;
  }

  function t(key, vars = {}) {
    let s = dict?.[key];
    if (s == null) s = key;

    s = String(s);

    // replace {{placeholders}}
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{{${k}}}`, String(v));
    }

    return s;
  }

  return { load, t, getLang, DEFAULT_LANG };
})();