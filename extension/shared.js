/* Shared helpers for YouTube Subtitle Translator. Loaded in the background
   page, the content script and the popup. Pure functions only, so they can
   be unit-tested outside the browser. */
(function (root) {
  'use strict';

  const DEFAULTS = {
    endpoint: 'http://localhost:11434', // Ollama (LM Studio: http://localhost:1234)
    model: 'gemma4:e4b',
    target: '',            // language to translate into; '' = browser language
    showOriginal: true,    // show the original line above the translation
    size: 'm',             // subtitle size: s / m / l
    timing: 'normal'       // how long lines stay on screen: quick / normal / relaxed
  };

  const BATCH = 16;          // subtitle lines per request to the model
  const CONTEXT_LINES = 6;   // earlier lines sent along for context
  const LOOKAHEAD_SEC = 600; // translate at most this far ahead of playback
  const CACHE_VIDEOS = 100;  // saved translations kept (oldest dropped first)

  /* ---------- settings / languages ---------- */

  function baseLang(code) {
    return String(code || '').trim().toLowerCase().split(/[-_]/)[0];
  }

  function sameLang(a, b) {
    const x = baseLang(a);
    return !!x && x === baseLang(b);
  }

  // Stored settings merged over the defaults. An empty target means "the
  // browser's language".
  function withDefaults(stored, uiLang) {
    const s = Object.assign({}, DEFAULTS, stored || {});
    if (!s.target) s.target = baseLang(uiLang) || 'en';
    return s;
  }

  let displayNames = null;
  // English name of a language code ("ja" → "Japanese"); the code itself if unknown.
  function langName(code) {
    if (!code) return '';
    try {
      displayNames = displayNames || new Intl.DisplayNames(['en'], { type: 'language' });
      return displayNames.of(code) || code;
    } catch {
      return code;
    }
  }

  /* ---------- captions ---------- */

  const isAsr = t => !!t && t.kind === 'asr';

  // Choose which of YouTube's caption tracks to translate.
  //  1. the track the player is showing right now ("translate what I see")
  //  2. hand-made captions in the spoken language (= the ASR track's language)
  //  3. the auto-generated (ASR) track
  //  4. any other hand-made track
  // Tracks already in the target language are skipped; null if none is left.
  function pickSourceTrack(tracks, current, target) {
    const usable = (tracks || []).filter(t => t && t.languageCode && !sameLang(t.languageCode, target));
    if (!usable.length) return null;
    if (current && current.languageCode) {
      const hit = usable.find(t => t.languageCode === current.languageCode && isAsr(t) === isAsr(current));
      if (hit) return hit;
    }
    const asr = usable.find(isAsr);
    if (asr) return usable.find(t => !isAsr(t) && sameLang(t.languageCode, asr.languageCode)) || asr;
    return usable[0];
  }

  const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

  // Turn YouTube's json3 caption format into [{s, e, text}] (seconds).
  // Auto-generated (ASR) captions arrive as single words with timings, so
  // they are regrouped into phrase-sized lines that are easier to translate.
  function parseJson3(json, asr) {
    const events = (json && json.events) || [];
    if (!asr) {
      const cues = [];
      for (const ev of events) {
        if (!ev.segs) continue;
        const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const s = (ev.tStartMs || 0) / 1000;
        const e = s + (ev.dDurationMs || 2000) / 1000;
        cues.push({ s, e, text });
      }
      cues.sort((a, b) => a.s - b.s);
      return cues;
    }

    const words = [];
    for (const ev of events) {
      if (!ev.segs) continue;
      for (const seg of ev.segs) {
        const w = (seg.utf8 || '').replace(/\n/g, '');
        if (!w.trim()) continue;
        words.push({ t: ((ev.tStartMs || 0) + (seg.tOffsetMs || 0)) / 1000, w });
      }
    }
    words.sort((a, b) => a.t - b.t);

    // Japanese/Chinese/Korean pack far more meaning into each character.
    const cjk = CJK.test(words.slice(0, 200).map(x => x.w).join(''));
    const maxLen = cjk ? 32 : 84;
    const softLen = cjk ? 18 : 48;
    const sentenceEnd = cjk ? /[。？！?!]$/ : /[.?!。？！]$/;

    const groups = [];
    let cur = null;
    for (const wd of words) {
      if (cur) {
        const gap = wd.t - cur.last;
        const len = cur.text.trim().length;
        const brk =
          gap > 1.2 ||
          len >= maxLen ||
          wd.t - cur.s > 7 ||
          (len >= softLen && gap > 0.5) ||
          sentenceEnd.test(cur.text.trimEnd());
        if (brk) { groups.push(cur); cur = null; }
      }
      if (!cur) cur = { s: wd.t, last: wd.t, text: '' };
      cur.text += wd.w;
      cur.last = wd.t;
    }
    if (cur) groups.push(cur);

    return groups.map((g, i) => {
      const next = groups[i + 1];
      let e = g.last + 1.6;
      if (next && next.s - g.last < 2) e = next.s;
      if (next) e = Math.min(e, next.s);
      e = Math.max(e, g.s + 1);
      return { s: g.s, e, text: g.text.replace(/\s+/g, ' ').trim() };
    }).filter(c => c.text);
  }

  /* ---------- readable timing ---------- */

  const MIN_CUE_SEC = 2.5;    // lines shorter than this are merged with the next one...
  const MERGE_GAP_SEC = 1;    // ...when it follows within this gap
  const NO_SPACE = /[぀-ヿ㐀-鿿豈-﫿]/; // scripts written without spaces

  // Merge lines that would flash by too fast to read into the following
  // line, as long as the result stays a reasonable subtitle length.
  function mergeShortCues(cues) {
    const out = [];
    for (const c of cues) {
      const prev = out[out.length - 1];
      if (prev && prev.e - prev.s < MIN_CUE_SEC && c.s - prev.e <= MERGE_GAP_SEC) {
        const joinTight = NO_SPACE.test(prev.text.slice(-1)) && NO_SPACE.test(c.text[0]);
        const text = prev.text + (joinTight ? '' : ' ') + c.text;
        if (text.length <= (CJK.test(text) ? 40 : 110) && c.e - prev.s <= 8) {
          out[out.length - 1] = { s: prev.s, e: Math.max(prev.e, c.e), text };
          continue;
        }
      }
      out.push({ s: c.s, e: c.e, text: c.text });
    }
    return out;
  }

  // How long lines stay on screen (the "timing" setting). cps: reading speed
  // in characters per second (CJK is read at about half that); min / max:
  // limits for the reading time; hold: extra time after the caption's own
  // end; bridge: pauses shorter than this keep the line up until the next one.
  const TIMING = {
    quick:   { cps: 15, min: 1.5, max: 6, hold: 0,   bridge: 1 },
    normal:  { cps: 12, min: 2,   max: 7, hold: 0.8, bridge: 1.5 },
    relaxed: { cps: 9,  min: 2.5, max: 8, hold: 1.5, bridge: 2.5 }
  };
  const timingOf = name => TIMING[name] || TIMING.normal;

  // Seconds a line needs on screen to be read comfortably.
  function readingTime(text, timing = TIMING.normal) {
    const t = String(text || '');
    const charsPerSec = timing.cps * (CJK.test(t) ? 7 / 15 : 1);
    return Math.min(timing.max, Math.max(timing.min, t.length / charsPerSec));
  }

  // When cue i should leave the screen. A line stays up a little past its
  // caption, long enough to read `text` (what is actually shown, usually the
  // translation) and through short pauses, but always gives way to the next
  // line the moment it starts.
  function cueDisplayEnd(cues, i, text, timing = TIMING.normal) {
    const c = cues[i], next = cues[i + 1];
    let end = Math.max(c.e + timing.hold, c.s + readingTime(text == null ? c.text : text, timing));
    if (next && next.s - end < timing.bridge) end = next.s;
    return end;
  }

  // Index of the cue to show at time t, or -1. textOf(i) gives the text
  // shown for cue i (see cueDisplayEnd).
  function cueToShow(cues, t, textOf, timing = TIMING.normal) {
    const i = cueIndexAt(cues, t);
    if (i < 0) return -1;
    return t < cueDisplayEnd(cues, i, textOf ? textOf(i) : null, timing) ? i : -1;
  }

  // Text for a native WebVTT cue: Firefox parses it as WebVTT markup, so
  // characters that start tags or entities are escaped.
  function vttEscape(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Index of the last cue starting at or before t (binary search), or -1.
  function cueIndexAt(cues, t) {
    let lo = 0, hi = cues.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].s <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /* ---------- wait estimate ---------- */

  // Running average of request times, weighted toward recent ones.
  const nextAvg = (avg, ms) => (avg ? Math.round(avg * 0.7 + ms * 0.3) : Math.round(ms));

  // Milliseconds until the line at the playhead is translated: what is left
  // of the request in flight, plus one more request when that one is for
  // other lines. null while no request time has been measured.
  function waitEstimate(avgMs, elapsedMs, sameBatch) {
    if (!avgMs) return null;
    return Math.max(0, avgMs - elapsedMs) + (sameBatch ? 0 : avgMs);
  }

  // Status text while the line at the playhead waits for its translation.
  function waitStatus(ms) {
    if (ms == null) return 'Translating…';
    const s = Math.ceil(ms / 1000);
    if (s <= 1) return 'Translating… almost ready';
    if (s < 60) return 'Translating… ready in ~' + s + ' s';
    return 'Translating… ready in ~' + Math.ceil(s / 60) + ' min';
  }

  /* ---------- translation prompt ---------- */

  function systemPrompt(src, tgt) {
    return [
      'You are a professional subtitle translator. Translate ' + src + ' subtitles into ' + tgt + '.',
      'You receive numbered subtitle lines from a YouTube video. They often come from speech recognition, so sentences may be split across lines, punctuation may be missing and some words may be misheard.',
      'Rules:',
      '- Translate into natural, conversational ' + tgt + ' that a native speaker would actually say.',
      '- Use the surrounding lines to understand the meaning. Infer subjects and references the original leaves out.',
      '- When one sentence is split over several lines, you may move words between those adjacent lines so each translated line reads naturally in order.',
      '- Keep names as names; romanize names written in another script when ' + tgt + ' uses the Latin alphabet.',
      '- Translate sound tags such as [Music] or [Applause] into ' + tgt + ', keeping the brackets.',
      '- Filler lines (um, uh, えー, あの) become short ' + tgt + ' equivalents.',
      '- Output exactly one line per input line, written as "N: translation", with the same numbers in the same order. Output nothing else.',
      '',
      'Format example (Japanese to English; the format is what matters):',
      'Input:',
      '1: 今日はですね',
      '2: 新しいカメラを買ったので',
      '3: 紹介したいと思います',
      'Output:',
      '1: So today,',
      '2: I bought a new camera,',
      "3: and I'd like to show it to you."
    ].join('\n');
  }

  // lines: strings to translate. context: [{text, tr}] lines just before them.
  // src / tgt: language names such as "Japanese" and "English".
  function buildMessages(lines, context, title, src, tgt) {
    let user = '';
    if (title) user += 'Video title: ' + title + '\n\n';
    if (context && context.length) {
      user += 'Earlier lines (context only, do not translate):\n';
      for (const c of context) user += c.text + (c.tr ? '  =>  ' + c.tr : '') + '\n';
      user += '\n';
    }
    user += 'Translate these lines into ' + tgt + ':\n';
    lines.forEach((l, i) => { user += (i + 1) + ': ' + l + '\n'; });
    return [
      { role: 'system', content: systemPrompt(src, tgt) },
      { role: 'user', content: user.trim() }
    ];
  }

  // Read "N: text" lines back into an array of length n (null = missing).
  function parseNumbered(text, n) {
    const out = new Array(n).fill(null);
    if (!text) return out;
    const clean = String(text)
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^[\s\S]*<\/think>/i, '')
      .replace(/```[a-z]*\n?/gi, '');
    const lineRe = /^\s*(?:[-*]\s*)?(?:\*\*)?\[?(\d{1,3})\]?(?:\*\*)?\s*[:：.)\]|-]\s*(.*)$/;
    const unnumbered = [];
    for (const raw of clean.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(lineRe);
      if (m) {
        const idx = parseInt(m[1], 10) - 1;
        let val = m[2].trim().replace(/^\*\*|\*\*$/g, '').trim();
        if (/^".*"$/.test(val) || /^“.*”$/.test(val)) val = val.slice(1, -1).trim();
        if (idx >= 0 && idx < n && out[idx] === null && val) out[idx] = val;
      } else {
        unnumbered.push(line);
      }
    }
    // Model ignored the numbering but gave the right number of lines.
    if (out.every(v => v === null) && unnumbered.length === n) return unnumbered.slice();
    return out;
  }

  /* ---------- misc ---------- */

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  function cuesSignature(cues) {
    return cues.length + '-' + hash(cues.map(c => c.text).join('|'));
  }

  // Only YouTube's own caption endpoint is ever fetched for caption files.
  function isCaptionUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && u.hostname === 'www.youtube.com' && u.pathname === '/api/timedtext';
    } catch {
      return false;
    }
  }

  // A usable AI server address: a plain http(s) URL without credentials.
  function isValidEndpoint(endpoint) {
    try {
      const u = new URL(String(endpoint).trim());
      return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
    } catch {
      return false;
    }
  }

  // Storage key for a video's saved translation.
  function cacheKey(vid, track, target) {
    return 'tr:' + vid + ':' + track.languageCode + (isAsr(track) ? '.asr' : '') + ':' + target;
  }

  function apiBase(endpoint) {
    return String(endpoint).trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  }
  const chatUrl = endpoint => apiBase(endpoint) + '/v1/chat/completions';
  const modelsUrl = endpoint => apiBase(endpoint) + '/v1/models';

  // Request body for /v1/chat/completions. Thinking models (Qwen 3.5 etc.)
  // reason at length before answering by default, which makes subtitles lag
  // far behind, so thinking is switched off unless the server rejects that.
  function chatBody(model, messages, temperature, allowNoThink) {
    const body = { model, messages, temperature: temperature == null ? 0.2 : temperature, stream: false };
    if (allowNoThink) body.reasoning_effort = 'none';
    return body;
  }

  // True when a failed request looks like the server refusing reasoning_effort.
  function isReasoningParamError(status, message) {
    return status === 400 && /reason|think/i.test(String(message || ''));
  }

  const api = {
    DEFAULTS, BATCH, CONTEXT_LINES, LOOKAHEAD_SEC, CACHE_VIDEOS,
    baseLang, sameLang, withDefaults, langName, pickSourceTrack,
    TIMING, timingOf, parseJson3, mergeShortCues, readingTime, cueDisplayEnd, cueToShow, vttEscape, cueIndexAt,
    nextAvg, waitEstimate, waitStatus, systemPrompt, buildMessages, parseNumbered,
    hash, cuesSignature, isCaptionUrl, isValidEndpoint, cacheKey, chatUrl, modelsUrl, chatBody, isReasoningParamError
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YTTR = api;
})(globalThis);
