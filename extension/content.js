/* Content script for youtube.com: a translate button in the player that
   shows the video's captions translated by a local AI model. It never
   touches playback, seeking or resume; YouTube's own caption setting is put
   back the way it was after the caption file has been read. */
(() => {
  'use strict';
  const S = globalThis.YTTR;
  const UI_LANG = browser.i18n.getUILanguage();

  let settings = S.withDefaults(null, UI_LANG);
  let state = null;        // the current video: {vid, title, tracks, cues, run, ...}
  let currentVid = null;
  // model -> average time of one translation request, measured on this page.
  // A model's first request isn't counted: it may include loading the model.
  const batchMs = {};
  const warmModels = new Set();

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ================= settings ================= */

  async function loadSettings() {
    try {
      const r = await browser.storage.local.get('settings');
      settings = S.withDefaults(r.settings, UI_LANG);
    } catch { /* keep defaults */ }
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const old = settings;
    settings = S.withDefaults(changes.settings.newValue, UI_LANG);
    const st = state;
    if (!st) return;
    applyOverlaySettings();
    if (old.timing !== settings.timing && st.run) syncPipCues(st.run);
    if (old.target !== settings.target || old.model !== settings.model) {
      if (st.wanted) {
        stopTranslation(st);
        startTranslation(st);
      }
    }
    ensureButton(st);
  });

  /* ================= page / player helpers ================= */

  function getVideoId() {
    try {
      const u = new URL(location.href);
      return u.pathname === '/watch' ? u.searchParams.get('v') : null;
    } catch { return null; }
  }
  const playerEl = () => document.getElementById('movie_player');
  const videoEl = () => {
    const p = playerEl();
    return p ? p.querySelector('video.html5-main-video') || p.querySelector('video') : null;
  };
  const pageApi = () => {
    const p = playerEl();
    return p && p.wrappedJSObject ? p.wrappedJSObject : null;
  };
  const isAd = () => {
    const p = playerEl();
    return !!(p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
  };
  const ccButton = () => document.querySelector('#movie_player .ytp-subtitles-button');
  const ccIsOn = () => {
    const b = ccButton();
    return !!(b && b.getAttribute('aria-pressed') === 'true');
  };

  // YouTube's own data about the current video (title, caption tracks...).
  function getPlayerResponse() {
    try {
      const api = pageApi();
      if (!api || typeof api.getPlayerResponse !== 'function') return null;
      const pr = api.getPlayerResponse();
      if (!pr) return null;
      return JSON.parse(window.wrappedJSObject.JSON.stringify(pr));
    } catch { return null; }
  }

  async function waitForPlayerResponse(vid, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (vid !== currentVid) return null;
      const pr = getPlayerResponse();
      if (pr && pr.videoDetails && pr.videoDetails.videoId === vid) return pr;
      await sleep(400);
    }
    return null;
  }

  function captionTracks(pr) {
    const list = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return list
      .filter(t => t && t.languageCode)
      .map(t => ({ languageCode: String(t.languageCode), kind: t.kind || '', baseUrl: t.baseUrl || '' }));
  }

  // The caption track YouTube is showing right now, or null.
  function shownTrack() {
    if (!ccIsOn()) return null;
    try {
      const t = pageApi().getOption('captions', 'track');
      return t && t.languageCode ? { languageCode: String(t.languageCode), kind: String(t.kind || '') } : null;
    } catch { return null; }
  }

  /* ================= caption loading ================= */

  async function captionUrlCandidates(vid) {
    const urls = [];
    try {
      const fromBg = await browser.runtime.sendMessage({ type: 'captionUrls' });
      for (const x of fromBg || []) urls.push({ url: x.url, at: x.at });
    } catch { /* ignore */ }
    try {
      const entries = window.wrappedJSObject.performance.getEntriesByType('resource');
      for (let i = 0; i < entries.length; i++) {
        const name = String(entries[i].name);
        if (name.includes('/api/timedtext')) urls.push({ url: name, at: 0 });
      }
    } catch { /* ignore */ }
    return urls
      .filter(x => S.isCaptionUrl(x.url) && new URL(x.url).searchParams.get('v') === vid)
      .sort((a, b) => b.at - a.at)
      .map(x => x.url);
  }

  function urlIsTrack(url, track) {
    try {
      const p = new URL(url).searchParams;
      return p.get('lang') === track.languageCode && (p.get('kind') === 'asr') === (track.kind === 'asr');
    } catch { return false; }
  }

  // Switch the player to the source track so that YouTube itself requests
  // the caption file (its request carries the token we need). Returns a
  // function that puts the player's captions back the way they were.
  async function requestTrackFromPlayer(track) {
    const api = pageApi();
    const wasOn = ccIsOn();
    let prev = null;
    let switched = false;
    try {
      if (api) {
        try { api.loadModule('captions'); } catch { /* already loaded */ }
        await sleep(400);
        if (wasOn) prev = api.getOption('captions', 'track');
        const list = api.getOption('captions', 'tracklist') || [];
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          if (String(t.languageCode) === track.languageCode &&
              (String(t.kind || '') === 'asr') === (track.kind === 'asr')) {
            api.setOption('captions', 'track', t);
            switched = true;
            break;
          }
        }
      }
    } catch { /* fall back to the CC button */ }
    if (!switched && !wasOn && ccButton()) ccButton().click();

    return () => {
      try {
        if (wasOn && prev && prev.languageCode) api.setOption('captions', 'track', prev);
        else if (!wasOn && ccIsOn()) ccButton().click();
      } catch { /* leave as is */ }
    };
  }

  async function fetchJson(url) {
    // content.fetch sends the request as the page itself (cookies, origin).
    const f = (typeof content !== 'undefined' && content.fetch) ? content.fetch.bind(content) : fetch;
    const res = await f(url, { credentials: 'include' });
    if (!res.ok) return null;
    const txt = await res.text();
    if (!txt || !txt.trim()) return null;
    try { return JSON.parse(txt); } catch { return null; }
  }

  async function loadCues(st, track) {
    const find = async () => (await captionUrlCandidates(st.vid)).find(u => urlIsTrack(u, track)) || null;
    let url = await find();
    if (!url) {
      const restore = await requestTrackFromPlayer(track);
      try {
        const end = Date.now() + 10000;
        while (!url && Date.now() < end && st === state) {
          await sleep(400);
          url = await find();
        }
      } finally {
        restore();
      }
    }

    const attempts = [];
    const base = url || (await captionUrlCandidates(st.vid))[0];
    if (base) {
      const u = new URL(base);
      u.searchParams.delete('tlang');
      u.searchParams.set('fmt', 'json3');
      if (!url) {
        // Another track's request: reuse its token, ask for our track.
        u.searchParams.set('lang', track.languageCode);
        u.searchParams.delete('name');
        if (track.kind === 'asr') u.searchParams.set('kind', 'asr'); else u.searchParams.delete('kind');
      }
      attempts.push(u.toString());
    }
    if (track.baseUrl) {
      const b = new URL(track.baseUrl, location.origin);
      b.searchParams.set('fmt', 'json3');
      if (S.isCaptionUrl(b.toString())) attempts.push(b.toString());
    }

    for (const a of attempts) {
      const json = await fetchJson(a).catch(() => null);
      if (json && json.events && json.events.length) {
        const cues = S.mergeShortCues(S.parseJson3(json, track.kind === 'asr'));
        if (cues.length) return cues;
      }
    }
    throw new Error(base
      ? 'YouTube returned empty captions for this video.'
      : 'Could not get the caption file from YouTube. Turn on CC once (press c), then try again.');
  }

  /* ================= translation ================= */

  // A "run" is one translation of the current video's cues into one
  // language with one model. Changing either starts a new run.
  const isLive = run => !!state && state.run === run;

  async function loadCache(run) {
    try {
      const r = await browser.storage.local.get(run.key);
      const c = r[run.key];
      if (c && c.sig === run.sig && c.model === run.model && Array.isArray(c.tr)) {
        for (let i = 0; i < run.cues.length; i++) {
          if (typeof c.tr[i] === 'string') run.tr[i] = c.tr[i];
        }
      }
    } catch { /* start fresh */ }
  }

  function scheduleCacheSave(run) {
    clearTimeout(run.saveTimer);
    run.saveTimer = setTimeout(async () => {
      try {
        const tr = Array.from(run.tr, x => (typeof x === 'string' ? x : null));
        await browser.storage.local.set({ [run.key]: { sig: run.sig, model: run.model, tr, u: Date.now() } });
        const r = await browser.storage.local.get('trIndex');
        let idx = (r.trIndex || []).filter(k => k !== run.key);
        idx.push(run.key);
        if (idx.length > S.CACHE_VIDEOS) {
          await browser.storage.local.remove(idx.slice(0, idx.length - S.CACHE_VIDEOS));
          idx = idx.slice(-S.CACHE_VIDEOS);
        }
        await browser.storage.local.set({ trIndex: idx });
      } catch { /* ignore */ }
    }, 1500);
  }

  const batchCount = run => Math.ceil(run.cues.length / S.BATCH);
  const batchDone = (run, k) => {
    for (let i = k * S.BATCH; i < Math.min(run.cues.length, (k + 1) * S.BATCH); i++) {
      if (run.tr[i] === undefined) return false;
    }
    return true;
  };

  function nextBatch(run) {
    const v = videoEl();
    const t = v ? v.currentTime : 0;
    const ci = Math.max(0, S.cueIndexAt(run.cues, t));
    for (let k = Math.floor(ci / S.BATCH); k < batchCount(run); k++) {
      if (batchDone(run, k)) continue;
      if (run.cues[k * S.BATCH].s > t + S.LOOKAHEAD_SEC) return null; // far enough ahead
      return k;
    }
    return null;
  }

  async function translateBatch(run, k) {
    const i0 = k * S.BATCH, i1 = Math.min(run.cues.length, i0 + S.BATCH);
    const lines = run.cues.slice(i0, i1).map(c => c.text);
    const ctx = [];
    for (let j = Math.max(0, i0 - S.CONTEXT_LINES); j < i0; j++) {
      ctx.push({ text: run.cues[j].text, tr: typeof run.tr[j] === 'string' ? run.tr[j] : '' });
    }
    const messages = S.buildMessages(lines, ctx, run.title, run.srcName, run.tgtName);
    let parsed = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await browser.runtime.sendMessage({ type: 'chat', messages, temperature: attempt ? 0 : 0.2 });
      if (!res || !res.ok) throw Object.assign(new Error(res ? res.error : 'No answer from the add-on.'), { kind: res && res.kind });
      const p = S.parseNumbered(res.text, lines.length);
      if (!parsed) parsed = p;
      else p.forEach((x, i) => { if (parsed[i] == null && x != null) parsed[i] = x; });
      if (parsed.every(x => x != null) || !isLive(run)) break;
    }
    if (!isLive(run)) return;
    // false = the model gave nothing usable; the original line is shown instead.
    for (let i = 0; i < lines.length; i++) run.tr[i0 + i] = parsed[i] != null ? parsed[i] : false;
    scheduleCacheSave(run);
    syncPipCues(run, i0, i1);
  }

  // Translates batch k, timing the request for the wait estimate and
  // updating the status every second while it runs.
  async function timedBatch(run, k) {
    const t0 = Date.now();
    run.busy = { k, t0 };
    updateProgress(run);
    const timer = setInterval(() => updateProgress(run), 1000);
    try {
      await translateBatch(run, k);
      if (!isLive(run)) return;
      if (warmModels.has(run.model)) batchMs[run.model] = S.nextAvg(batchMs[run.model], Date.now() - t0);
      else warmModels.add(run.model);
    } finally {
      clearInterval(timer);
      run.busy = null;
    }
  }

  async function worker(run) {
    while (isLive(run)) {
      const k = nextBatch(run);
      if (k == null) { updateProgress(run); await sleep(2000); continue; }
      try {
        await timedBatch(run, k);
        if (run.error) { run.error = null; setStatus(''); }
      } catch (e) {
        if (!isLive(run)) break;
        run.error = e.message;
        setStatus(e.message, true);
        await sleep(e.kind === 'model' ? 15000 : 8000);
      }
    }
  }

  function updateProgress(run) {
    if (run.error || !isLive(run)) return;
    const v = videoEl();
    // Before the first line, wait for that line.
    const ci = Math.max(0, S.cueIndexAt(run.cues, v ? v.currentTime : 0));
    const waiting = run.busy && ci < run.cues.length && run.tr[ci] === undefined;
    if (waiting) {
      const sameBatch = run.busy.k === Math.floor(ci / S.BATCH);
      setStatus(S.waitStatus(S.waitEstimate(batchMs[run.model], Date.now() - run.busy.t0, sameBatch)));
    } else {
      setStatus('');
    }
    const total = run.cues.length;
    const pct = Math.round(100 * run.tr.filter(x => x !== undefined).length / Math.max(1, total));
    if (state.button) {
      state.button.title = 'Translated subtitles: on (' + run.srcName + ' → ' + run.tgtName + ', ' +
        pct + '% done). Click to turn off.';
    }
  }

  /* ================= Picture-in-Picture ================= */

  // Firefox's Picture-in-Picture window shows only the <video>, not the
  // overlay. It does show a native subtitle track that is in "showing" mode,
  // so the translated lines are mirrored into one. In the page itself that
  // track is invisible (content.css), because the overlay already shows it.
  const PIP_LABEL = 'Translated subtitles';

  // The text shown for cue i: its translation, or the original line.
  const shownText = (run, i) => (typeof run.tr[i] === 'string' ? run.tr[i] : run.cues[i].text);

  // Tracks can't be removed from a <video>, and YouTube keeps the same
  // element from video to video, so one track is created and reused.
  function pipTrack(create) {
    const v = videoEl();
    if (!v) return null;
    const list = v.textTracks;
    for (let i = 0; i < list.length; i++) {
      if (list[i].label === PIP_LABEL) return list[i];
    }
    return create ? v.addTextTrack('subtitles', PIP_LABEL, settings.target) : null;
  }

  // Only the translation: the PiP window draws every cue line at the same
  // (large) size, so the original would crowd it out. The original is shown
  // only while a line has no translation.
  function pipCueText(run, i) {
    const orig = run.cues[i].text, tr = run.tr[i];
    if (tr === undefined) return orig + '\n…';
    return typeof tr === 'string' ? tr : orig;
  }

  // (Re)create the native cues for lines i0..i1-1 of a run.
  function syncPipCues(run, i0 = 0, i1 = run.cues.length) {
    if (!isLive(run)) return;
    try {
      const track = pipTrack(true);
      if (!track) return;
      if (track.mode !== 'showing' && !isAd()) track.mode = 'showing';
      run.vtt = run.vtt || [];
      const timing = S.timingOf(settings.timing);
      for (let i = i0; i < i1; i++) {
        if (run.vtt[i]) track.removeCue(run.vtt[i]);
        const end = S.cueDisplayEnd(run.cues, i, shownText(run, i), timing);
        run.vtt[i] = new VTTCue(run.cues[i].s, end, S.vttEscape(pipCueText(run, i)));
        track.addCue(run.vtt[i]);
      }
    } catch { /* PiP subtitles are a nice-to-have */ }
  }

  // Remove every cue and switch the track off; PiP then falls back to
  // YouTube's own captions.
  function clearPip() {
    try {
      const track = pipTrack(false);
      if (!track) return;
      // A disabled track (e.g. during an ad) hides its cue list as null.
      if (track.mode === 'disabled') track.mode = 'hidden';
      const cues = track.cues;
      while (cues && cues.length) track.removeCue(cues[0]);
      track.mode = 'disabled';
    } catch { /* ignore */ }
  }

  // Ads play in the same <video> with their own timeline, so the track is
  // paused while one is showing.
  function updatePipForAds(run) {
    try {
      const track = run.vtt && pipTrack(false);
      const mode = isAd() ? 'disabled' : 'showing';
      if (track && track.mode !== mode) track.mode = mode;
    } catch { /* ignore */ }
  }

  /* ================= UI: overlay, status, button ================= */

  function ensureOverlay(st) {
    const p = playerEl();
    if (!p) return;
    if (!st.overlay || !st.overlay.isConnected) {
      const o = document.createElement('div');
      o.className = 'yttr-overlay';
      const box = document.createElement('div');
      box.className = 'yttr-box';
      const orig = document.createElement('div'); orig.className = 'yttr-orig';
      const tr = document.createElement('div'); tr.className = 'yttr-tr';
      box.append(orig, tr);
      o.append(box);
      p.append(o);
      st.overlay = o; st.origEl = orig; st.trEl = tr; st.boxEl = box;
      if (!st.ro) {
        st.ro = new ResizeObserver(() => applyOverlaySettings());
        st.ro.observe(p);
      }
      applyOverlaySettings();
    }
  }

  function applyOverlaySettings() {
    const st = state, p = playerEl();
    if (!st || !st.overlay || !p) return;
    const factor = { s: 0.034, m: 0.043, l: 0.054 }[settings.size] || 0.043;
    const fs = Math.max(13, Math.min(46, p.clientHeight * factor));
    st.overlay.style.setProperty('--yttr-fs', fs + 'px');
    st.overlay.classList.toggle('yttr-hide-orig', !settings.showOriginal);
    st.shown = null;
  }

  function renderTick() {
    const st = state;
    const run = st && st.run;
    if (!run) return;
    ensureOverlay(st);
    updatePipForAds(run);
    const v = videoEl();
    if (!v || !st.overlay) return;
    let orig = '', tr = '', pending = false;
    if (!isAd()) {
      const t = v.currentTime;
      const i = S.cueToShow(run.cues, t, j => shownText(run, j), S.timingOf(settings.timing));
      if (i >= 0) {
        orig = run.cues[i].text;
        const x = run.tr[i];
        if (x === undefined) pending = true;
        else if (typeof x === 'string') tr = x;
      }
    }
    const key = orig + '\u0000' + tr + pending;
    if (key === st.shown) return;
    st.shown = key;
    st.origEl.textContent = orig;
    st.trEl.textContent = pending ? '…' : tr;
    st.overlay.classList.toggle('yttr-pending', pending);
    // With the original line hidden, still show it when there is no translation.
    st.overlay.classList.toggle('yttr-force-orig', !pending && !tr && !!orig);
    st.boxEl.style.display = orig || tr ? '' : 'none';
  }

  function setStatus(text, isError) {
    const p = playerEl();
    if (!p) return;
    let el = p.querySelector('.yttr-status');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'yttr-status';
      const span = document.createElement('span');
      const close = document.createElement('button');
      close.textContent = '×';
      close.title = 'Hide';
      close.addEventListener('click', e => { e.stopPropagation(); el.remove(); });
      el.append(span, close);
      p.append(el);
    }
    el.classList.toggle('yttr-error', !!isError);
    el.firstChild.textContent = text;
  }

  // 文/A icon drawn on a 24px grid. The new player uses 24px icons; the old one
  // uses 36px icons scaled to the button, so pad the grid to match whichever
  // the CC button has.
  function makeIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const ccSvg = ccButton() && ccButton().querySelector('svg');
    const ccGrid = ccSvg && ccSvg.viewBox && ccSvg.viewBox.baseVal ? ccSvg.viewBox.baseVal.width : 0;
    if (ccGrid === 24) {
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '24');
      svg.setAttribute('height', '24');
    } else {
      svg.setAttribute('viewBox', '-6 -6 36 36');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
    }
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d',
      'M7.5 2v2.5M2.5 4.5h10M4.5 6.5l7 6.5M10.5 6.5l-7.5 6.5' + // 文
      'M13.5 21.5l4-10.5 4 10.5M15 17.5h5');                    // A
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#fff');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  function ensureButton(st) {
    const controls = document.querySelector('#movie_player .ytp-right-controls');
    if (!controls) return;
    let b = controls.querySelector('.yttr-btn');
    if (!S.pickSourceTrack(st.tracks, null, settings.target)) {
      if (b) b.remove();
      st.button = null;
      return;
    }
    if (!b) {
      b = document.createElement('button');
      b.className = 'ytp-button yttr-btn';
      b.append(makeIcon());
      b.addEventListener('click', e => {
        e.stopPropagation();
        if (!state) return;
        if (state.wanted) stopTranslation(state);
        else startTranslation(state);
      });
    }
    // Sit right before the CC button, inside its group in the new player.
    const cc = ccButton();
    if (cc && cc.parentNode) {
      if (b.nextElementSibling !== cc) cc.before(b);
    } else if (!b.parentNode) {
      controls.prepend(b);
    }
    st.button = b;
    b.setAttribute('aria-pressed', st.wanted ? 'true' : 'false');
    if (!st.wanted) b.title = 'Translate captions into ' + S.langName(settings.target) + '. Click to turn on.';
  }

  /* ================= start / stop ================= */

  async function startTranslation(st) {
    st.wanted = true;
    ensureButton(st);
    document.documentElement.classList.add('yttr-active');
    if (st.starting || st.run) return;
    st.starting = true;
    try {
      const track = S.pickSourceTrack(st.tracks, shownTrack(), settings.target);
      if (!track) throw new Error('This video has no captions to translate.');
      const trackId = track.languageCode + ':' + track.kind;
      if (st.cuesTrack !== trackId) {
        setStatus('Loading captions…');
        st.cues = await loadCues(st, track);
        st.cuesTrack = trackId;
        setStatus('');
      }
      if (st !== state || !st.wanted) return;
      const run = {
        cues: st.cues,
        tr: new Array(st.cues.length),
        title: st.title,
        srcName: S.langName(track.languageCode),
        tgtName: S.langName(settings.target),
        model: settings.model,
        sig: S.cuesSignature(st.cues),
        key: S.cacheKey(st.vid, track, settings.target)
      };
      await loadCache(run);
      if (st !== state || !st.wanted) return;
      st.run = run;
      ensureOverlay(st);
      clearInterval(st.renderTimer);
      st.renderTimer = setInterval(renderTick, 100);
      syncPipCues(run);
      worker(run);
    } catch (e) {
      if (st === state) {
        stopTranslation(st);
        setStatus(e.message || 'Could not load captions.', true);
      }
    } finally {
      st.starting = false;
    }
  }

  function stopTranslation(st) {
    st.wanted = false;
    st.run = null;
    clearInterval(st.renderTimer);
    if (st.overlay) { st.overlay.remove(); st.overlay = null; }
    if (st.ro) { st.ro.disconnect(); st.ro = null; }
    clearPip();
    setStatus('');
    document.documentElement.classList.remove('yttr-active');
    ensureButton(st);
  }

  /* ================= video lifecycle ================= */

  async function switchVideo(vid) {
    const old = state;
    if (old) {
      stopTranslation(old);
      if (old.button) old.button.remove();
    }
    state = null;
    currentVid = vid;
    clearPip(); // also empties a track left behind by an earlier copy of this script
    if (!vid) return;

    const st = { vid, title: '', tracks: [], wanted: false };
    state = st;
    const pr = await waitForPlayerResponse(vid, 20000);
    if (st !== state || !pr) return;
    st.title = pr.videoDetails.title || '';
    st.tracks = captionTracks(pr);
    ensureButton(st);
  }

  function tick() {
    const vid = getVideoId();
    if (vid !== currentVid) { switchVideo(vid); return; }
    // YouTube sometimes rebuilds the player controls.
    if (state) ensureButton(state);
  }

  document.addEventListener('yt-navigate-finish', () => setTimeout(tick, 50));

  loadSettings().then(() => {
    tick();
    setInterval(tick, 1000);
  });
})();
