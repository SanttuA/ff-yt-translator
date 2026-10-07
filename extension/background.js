/* Background page: remembers YouTube's caption requests (they carry a
   one-time token that the content script reuses) and talks to the local
   AI server on behalf of the content script and popup. */
'use strict';

const EXT_ORIGIN = browser.runtime.getURL('');

/* ---- 1. Remember caption URLs per tab ---- */
const captionUrls = new Map(); // tabId -> [{url, at}]

browser.webRequest.onBeforeRequest.addListener(
  details => {
    if (details.tabId < 0) return;
    const list = captionUrls.get(details.tabId) || [];
    list.push({ url: details.url, at: Date.now() });
    while (list.length > 20) list.shift();
    captionUrls.set(details.tabId, list);
  },
  { urls: ['*://www.youtube.com/api/timedtext*'] }
);

browser.tabs.onRemoved.addListener(tabId => captionUrls.delete(tabId));

/* ---- 2. Let this add-on reach Ollama without extra setup ----
   Ollama rejects browser-extension origins unless OLLAMA_ORIGINS is set.
   For requests that come from this add-on only, drop the Origin header so
   the local server treats them like any other local app. Requests from
   websites are never touched. */
browser.webRequest.onBeforeSendHeaders.addListener(
  details => {
    const from = details.originUrl || details.documentUrl || '';
    if (!from.startsWith(EXT_ORIGIN)) return {};
    return {
      requestHeaders: details.requestHeaders.filter(h => h.name.toLowerCase() !== 'origin')
    };
  },
  { urls: ['http://localhost/*', 'http://127.0.0.1/*'] },
  ['blocking', 'requestHeaders']
);

/* ---- 3. Messages ---- */
async function getSettings() {
  const r = await browser.storage.local.get('settings');
  const s = YTTR.withDefaults(r.settings, browser.i18n.getUILanguage());
  if (!YTTR.isValidEndpoint(s.endpoint)) s.endpoint = YTTR.DEFAULTS.endpoint;
  return s;
}

// Server+model pairs that refused reasoning_effort; they get requests without it.
const noThinkRefused = new Set();

async function chat(messages, temperature) {
  const s = await getSettings();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240000);
  const pair = s.endpoint + '|' + s.model;
  try {
    const post = () => fetch(YTTR.chatUrl(s.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(YTTR.chatBody(s.model, messages, temperature, !noThinkRefused.has(pair))),
      signal: ctrl.signal
    });
    let res = await post();
    let bodyText = await res.text();
    let msg = bodyText;
    if (!res.ok) {
      try { msg = JSON.parse(bodyText).error.message || msg; } catch { /* plain text */ }
      if (!noThinkRefused.has(pair) && YTTR.isReasoningParamError(res.status, msg)) {
        noThinkRefused.add(pair);
        res = await post();
        bodyText = await res.text();
        msg = bodyText;
        if (!res.ok) {
          try { msg = JSON.parse(bodyText).error.message || msg; } catch { /* plain text */ }
        }
      }
    }
    if (!res.ok) {
      if (res.status === 404 && /model/i.test(msg)) {
        return { ok: false, kind: 'model', error: 'Model "' + s.model + '" is not installed. Run: ollama pull ' + s.model };
      }
      if (res.status === 403) {
        return { ok: false, kind: 'forbidden', error: 'The AI server refused the request (403). See "Troubleshooting" in the README.' };
      }
      return { ok: false, kind: 'server', error: 'AI server error ' + res.status + ': ' + String(msg).slice(0, 200) };
    }
    const data = JSON.parse(bodyText);
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content || '' : '';
    return { ok: true, text };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, kind: 'timeout', error: 'The AI model took too long to answer.' };
    return { ok: false, kind: 'offline', error: "Can't reach the AI server at " + s.endpoint + '. Is Ollama running?' };
  } finally {
    clearTimeout(timer);
  }
}

async function listModels(endpoint) {
  const s = await getSettings();
  const ep = endpoint || s.endpoint;
  if (!YTTR.isValidEndpoint(ep)) return { ok: false, error: 'Not a valid server address: ' + ep };
  try {
    const res = await fetch(YTTR.modelsUrl(ep));
    if (!res.ok) return { ok: false, error: 'Server answered ' + res.status };
    const data = await res.json();
    const models = (data.data || []).map(m => m.id).filter(Boolean).sort();
    return { ok: true, models };
  } catch {
    return { ok: false, error: "Can't reach " + ep };
  }
}

async function testTranslation() {
  const s = await getSettings();
  const fromJa = !YTTR.sameLang(s.target, 'ja');
  const lines = fromJa
    ? ['今日はいい天気ですね', 'ちょっと散歩に行こうかな']
    : ["It's really nice weather today.", 'Maybe I should go for a walk.'];
  const messages = YTTR.buildMessages(lines, [], '', fromJa ? 'Japanese' : 'English', YTTR.langName(s.target));
  const t0 = Date.now();
  const r = await chat(messages, 0.2);
  if (!r.ok) return r;
  const out = YTTR.parseNumbered(r.text, lines.length);
  return { ok: true, source: lines.join(' '), text: out.filter(Boolean).join(' ') || r.text, ms: Date.now() - t0 };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== browser.runtime.id || !msg) return undefined;
  const fromPopup = !sender.tab;
  switch (msg.type) {
    case 'captionUrls':
      return Promise.resolve((sender.tab && captionUrls.get(sender.tab.id)) || []);
    case 'chat':
      if (!Array.isArray(msg.messages)) return undefined;
      return chat(msg.messages, typeof msg.temperature === 'number' ? msg.temperature : null);
    case 'models':
      return fromPopup ? listModels(msg.endpoint) : undefined;
    case 'test':
      return fromPopup ? testTranslation() : undefined;
  }
  return undefined;
});
