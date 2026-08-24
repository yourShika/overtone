'use strict';

/**
 * Translation for the windows.
 *
 * Loaded before the other scripts, so each of them can simply call `T.t(...)`.
 * The dictionary comes from the agent in one piece rather than being fetched
 * per string: the renderer is sandboxed and every crossing costs a round trip.
 *
 * Markup carries `data-i18n="key"` on an element whose text is the whole
 * string, and `data-i18n-placeholder="key"` on inputs. Elements are left empty
 * in the HTML on purpose — a literal fallback would flash in the wrong language
 * for a frame before being replaced, which reads as a glitch.
 */

window.T = (() => {
  let dictionary = {};
  let languages = [];
  let locale = 'en';

  /**
   * Look up a key and substitute `{name}` placeholders.
   *
   * Returns the key itself when it is unknown: silence looks like a layout bug,
   * whereas the identifier says what is missing.
   */
  function t(key, vars) {
    const template = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key;
    if (!vars) return template;
    return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
    );
  }

  /** Fill every element that declares a key. */
  function apply(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.dataset.i18n);
    }
    for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
      el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
    }
    for (const el of root.querySelectorAll('[data-i18n-title]')) {
      el.setAttribute('title', t(el.dataset.i18nTitle));
    }
    // Window buttons carry an icon and nothing else, so the accessible name is
    // the only name they have — it must not stay in one fixed language.
    for (const el of root.querySelectorAll('[data-i18n-label]')) {
      el.setAttribute('aria-label', t(el.dataset.i18nLabel));
    }
  }

  /**
   * Fetch the dictionary and paint the window with it.
   * @param {(dictionary: object) => void} [onChange] called again on a change
   */
  async function init(onChange) {
    const payload = await window.overtone.i18n.get();
    dictionary = payload.dictionary || {};
    languages = payload.languages || [];
    locale = payload.locale || 'en';
    apply();

    window.overtone.i18n.onChange((next) => {
      // The locale travels with the dictionary: a window that only swapped its
      // strings kept formatting numbers by the language it started in, so a
      // German comma turned up in the English window.
      dictionary = next?.dictionary || {};
      locale = next?.locale || locale;
      apply();
      if (onChange) onChange(dictionary);
    });
  }

  return {
    t,
    apply,
    init,
    get languages() {
      return languages;
    },
    get locale() {
      return locale;
    },
  };
})();
