'use strict';
const S = globalThis.YTTR;
const $ = id => document.getElementById(id);
const UI_LANG = browser.i18n.getUILanguage();
let settings = S.withDefaults(null, UI_LANG);

const COMMON_LANGS = [
  'ar', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'hu', 'id', 'it', 'ja',
  'ko', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr', 'uk', 'vi', 'zh'
];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function saveSettings(patch) {
  settings = Object.assign({}, settings, patch);
  await browser.storage.local.set({ settings });
}

/* ---------- target language ---------- */
function canonicalLang(code) {
  try { return Intl.getCanonicalLocales(code.trim())[0] || null; } catch { return null; }
}

function renderTargets() {
  const sel = $('target');
  sel.textContent = '';
  const codes = COMMON_LANGS.slice().sort((a, b) => S.langName(a).localeCompare(S.langName(b)));
  const known = codes.includes(settings.target);
  for (const c of codes) {
    const o = el('option', null, S.langName(c));
    o.value = c;
    o.selected = c === settings.target;
    sel.append(o);
  }
  const other = el('option', null, known ? 'Other…' : 'Other: ' + S.langName(settings.target));
  other.value = '';
  other.selected = !known;
  sel.append(other);
  $('targetOtherWrap').hidden = known;
  $('targetOther').value = known ? '' : settings.target;
}

/* ---------- AI server ---------- */
function showServerMessage(kind, text) {
  const b = $('serverMsg');
  b.textContent = '';
  if (!kind) { b.hidden = true; return; }
  b.hidden = false;
  if (kind === 'offline') {
    b.append("Can't reach the AI server. Make sure Ollama is installed and running, then press ↻. ");
    b.append('Install a model with ');
    b.append(el('code', null, 'ollama pull ' + S.DEFAULTS.model));
  } else if (kind === 'nomodels') {
    b.append('Ollama is running but has no models yet. Open a terminal and run ');
    b.append(el('code', null, 'ollama pull ' + S.DEFAULTS.model));
    b.append(', then press ↻.');
  } else {
    b.append(text || '');
  }
}

async function loadModels() {
  const sel = $('model');
  const dot = $('dot');
  const r = await browser.runtime.sendMessage({ type: 'models', endpoint: settings.endpoint });
  sel.textContent = '';
  let models = r.ok ? r.models : [];
  dot.className = 'dot ' + (r.ok ? 'ok' : 'bad');
  dot.title = r.ok ? 'AI server connected' : 'AI server not reachable';
  if (!r.ok) showServerMessage('offline');
  else if (!models.length) showServerMessage('nomodels');
  else if (!models.includes(settings.model)) {
    showServerMessage('custom', 'The selected model "' + settings.model + '" isn\'t installed. Pick one below or run: ollama pull ' + settings.model);
  } else showServerMessage(null);

  if (!models.includes(settings.model)) models = [settings.model].concat(models);
  for (const m of models) {
    const o = el('option', null, m);
    o.value = m;
    o.selected = m === settings.model;
    sel.append(o);
  }
}

async function cacheInfo() {
  const r = await browser.storage.local.get('trIndex');
  const n = (r.trIndex || []).length;
  $('cacheInfo').textContent = n ? n + ' video' + (n === 1 ? '' : 's') + ' saved' : 'Nothing saved';
}

async function init() {
  const r = await browser.storage.local.get('settings');
  settings = S.withDefaults(r.settings, UI_LANG);

  renderTargets();
  $('target').addEventListener('change', async () => {
    const v = $('target').value;
    if (!v) { $('targetOtherWrap').hidden = false; $('targetOther').focus(); return; }
    await saveSettings({ target: v });
    renderTargets();
  });
  $('targetOther').addEventListener('change', async () => {
    const v = canonicalLang($('targetOther').value);
    if (!v) { $('targetOther').value = ''; return; }
    await saveSettings({ target: v });
    renderTargets();
  });

  $('showOriginal').checked = !!settings.showOriginal;
  $('showOriginal').addEventListener('change', () => saveSettings({ showOriginal: $('showOriginal').checked }));

  const segButtons = document.querySelectorAll('#size button');
  const paintSize = () => segButtons.forEach(b => b.classList.toggle('on', b.dataset.v === settings.size));
  segButtons.forEach(b => b.addEventListener('click', async () => { await saveSettings({ size: b.dataset.v }); paintSize(); }));
  paintSize();

  $('endpoint').value = settings.endpoint;
  $('endpoint').addEventListener('change', async () => {
    const v = $('endpoint').value.trim() || S.DEFAULTS.endpoint;
    if (!S.isValidEndpoint(v)) {
      showServerMessage('custom', 'Not a valid server address: "' + v + '". Use something like ' + S.DEFAULTS.endpoint);
      $('endpoint').value = settings.endpoint;
      return;
    }
    $('endpoint').value = v;
    await saveSettings({ endpoint: v });
    loadModels();
  });
  $('model').addEventListener('change', () => { saveSettings({ model: $('model').value }); showServerMessage(null); });
  $('refresh').addEventListener('click', loadModels);

  $('test').addEventListener('click', async () => {
    const btn = $('test'), out = $('testOut');
    btn.disabled = true;
    out.textContent = 'Translating…';
    const res = await browser.runtime.sendMessage({ type: 'test' });
    btn.disabled = false;
    out.textContent = res.ok
      ? '“' + res.source + '” → “' + res.text + '” (' + (res.ms / 1000).toFixed(1) + ' s)'
      : res.error;
  });

  $('clearCache').addEventListener('click', async () => {
    // Every saved translation, also any the index lost track of.
    const all = await browser.storage.local.get(null);
    await browser.storage.local.remove(Object.keys(all).filter(k => k.startsWith('tr:')).concat('trIndex'));
    cacheInfo();
  });

  loadModels();
  cacheInfo();
}

init();
