'use strict';

/**
 * First-run wizard.
 *
 * Four steps, each of which checks the real thing rather than merely claiming
 * it: the client id is validated as you type, the extension step waits for an
 * actual connection, and the final step reports what the agent genuinely sees.
 * A wizard that says "done" without looking would be worse than none, because
 * it sends people off to debug a setup they were told was finished.
 */

const api = window.overtone;

const STEPS = 4;
const $ = (id) => document.getElementById(id);
const all = (selector) => Array.from(document.querySelectorAll(selector));

let step = 1;
let config = {};
let status = {};

init().catch((err) => console.error(err));

async function init() {
  config = await api.config.get();
  await T.init(() => {
    document.title = T.t('win.wizard');
    show(step);
    applyStatus(status);
  });
  document.title = T.t('win.wizard');
  document.documentElement.setAttribute('data-theme', resolveTheme(config.theme));

  $('ext-path').textContent = await api.actions.extensionPath();
  $('ext-port').textContent = String(config.port ?? 8787);

  bindSwitches();
  bindClientId();
  bindNavigation();
  bindActions();

  applyStatus(await api.status.get());
  api.status.onUpdate(applyStatus);

  show(1);
}

function resolveTheme(choice) {
  if (choice === 'sys' || !choice) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return choice;
}

// -------------------------------------------------------------------- steps

function show(next) {
  step = Math.min(STEPS, Math.max(1, next));

  for (let i = 1; i <= STEPS; i++) {
    $(`step-${i}`).hidden = i !== step;
  }

  for (const button of all('.step')) {
    const index = Number(button.dataset.step);
    button.dataset.state = index === step ? 'active' : index < step ? 'done' : 'open';
    button.querySelector('.circle').textContent = index < step ? '✓' : String(index);
  }

  $('wiz-progress').style.width = `${(step / STEPS) * 100}%`;
  $('wiz-note').textContent = T.t('wiz.step', { current: step, total: STEPS });
  $('wiz-back').disabled = step === 1;
  $('wiz-next').textContent = T.t(step === STEPS ? 'app.finish' : 'app.next');
  $('wiz-scroll').scrollTop = 0;
}

function bindNavigation() {
  for (const button of all('.step')) {
    button.addEventListener('click', () => show(Number(button.dataset.step)));
  }
  $('wiz-back').addEventListener('click', () => show(step - 1));
  $('wiz-next').addEventListener('click', () => {
    if (step === STEPS) api.wizard.finish();
    else show(step + 1);
  });
  $('wiz-later').addEventListener('click', () => api.wizard.finish());
  $('win-close').addEventListener('click', () => api.wizard.finish());
}

// ----------------------------------------------------------------- controls

function bindSwitches() {
  for (const row of all('[data-switch]')) {
    const key = row.dataset.switch;

    const knob = document.createElement('button');
    knob.type = 'button';
    knob.className = 'switch';
    knob.setAttribute('role', 'switch');
    knob.setAttribute('aria-checked', config[key] ? 'true' : 'false');
    knob.innerHTML = '<span class="knob"></span>';
    row.appendChild(knob);

    row.addEventListener('click', () => {
      config[key] = !config[key];
      knob.setAttribute('aria-checked', config[key] ? 'true' : 'false');
      api.config.set({ [key]: config[key] });
    });
  }
}

function bindClientId() {
  const field = $('clientId');
  field.value = config.clientId || '';

  const check = () => {
    const value = field.value.trim();
    const line = $('clientid-status');
    const dot = line.querySelector('.dot');
    const text = line.querySelector('span:last-child');

    if (!value) {
      dot.className = 'dot';
      text.textContent = T.t('wiz.s2.waiting');
    } else if (!/^\d{17,20}$/.test(value)) {
      // Caught here rather than at connect time: an ID that is obviously not an
      // ID produces a Discord error minutes later that explains nothing.
      dot.className = 'dot off';
      text.textContent = T.t('wiz.s2.invalid');
      return;
    } else {
      dot.className = 'dot on';
      text.textContent = T.t('wiz.s2.saved');
      config.clientId = value;
      api.config.set({ clientId: value });
    }
  };

  field.addEventListener('input', debounce(check, 350));
  field.addEventListener('blur', check);
  check();
}

function bindActions() {
  for (const element of all('[data-external]')) {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      api.actions.openExternal(element.dataset.external);
    });
  }
  $('btn-show-ext').addEventListener('click', () => api.actions.showExtensionFolder());
}

// ------------------------------------------------------------------- status

function applyStatus(next) {
  if (!next) return;
  status = next;

  const discord = Boolean(next.discordConnected);
  const tabs = next.browserClients || 0;

  // Step 3 waits for a real connection rather than assuming the click worked.
  $('ext-waiting').classList.toggle('hidden', tabs > 0);
  $('ext-connected').classList.toggle('hidden', tabs === 0);
  $('ext-tabs').textContent =
    tabs === 1 ? T.t('wiz.s3.oneTab') : T.t('wiz.s3.tabs', { count: tabs });

  const ready = discord && tabs > 0;
  $('test-good').classList.toggle('hidden', !ready);
  $('test-bad').classList.toggle('hidden', ready);

  if (!ready) {
    const missing = [];
    if (!discord) missing.push('Discord');
    if (!tabs) missing.push(T.t('wiz.s4.theExtension'));
    $('test-bad-title').textContent = T.t('wiz.s4.notReady', {
      what: missing.join(T.t('wiz.s4.and')),
    });
    $('test-bad-text').textContent = T.t(discord ? 'wiz.s4.hintExtension' : 'wiz.s4.hintDiscord');
  }

  const now = next.now;
  const lyric = next.lyrics?.line;
  fill('wiz-title', 'wiz-ph-title', 'wiz-tag-title', now?.title);
  fill('wiz-lyric', 'wiz-ph-lyric', 'wiz-tag-lyric', lyric);

  const cover = $('wiz-cover');
  const src = now?.thumbnail;
  if (src && /^https:\/\/(i\.ytimg\.com|lh3\.googleusercontent\.com)\//.test(src)) {
    if (cover.getAttribute('src') !== src) cover.setAttribute('src', src);
  } else {
    cover.removeAttribute('src');
  }
}

/** Placeholders stay until a real value exists — never invented sample data. */
function fill(textId, placeholderId, tagId, value) {
  const has = Boolean(value);
  $(textId).textContent = value || '';
  $(textId).classList.toggle('hidden', !has);
  $(placeholderId).classList.toggle('hidden', has);
  $(tagId).classList.toggle('hidden', has);
}

// ------------------------------------------------------------------ helpers

const pending = new Map();

function debounce(fn, delay) {
  return () => {
    clearTimeout(pending.get(fn));
    pending.set(
      fn,
      setTimeout(() => {
        pending.delete(fn);
        fn();
      }, delay),
    );
  };
}
