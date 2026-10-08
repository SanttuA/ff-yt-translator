'use strict';
const S = require('../extension/shared.js');

describe('languages and settings', () => {
  test('baseLang / sameLang compare the primary subtag', () => {
    expect(S.baseLang('en-GB')).toBe('en');
    expect(S.baseLang('pt_BR')).toBe('pt');
    expect(S.sameLang('en-US', 'EN')).toBe(true);
    expect(S.sameLang('ja', 'en')).toBe(false);
    expect(S.sameLang('', '')).toBe(false);
  });

  test('withDefaults fills the target from the browser language', () => {
    expect(S.withDefaults(null, 'fi-FI').target).toBe('fi');
    expect(S.withDefaults({ target: 'de' }, 'fi').target).toBe('de');
    expect(S.withDefaults({}, '').target).toBe('en');
    expect(S.withDefaults({ model: 'x' }, 'en').model).toBe('x');
    expect(S.withDefaults(null, 'en').endpoint).toBe(S.DEFAULTS.endpoint);
  });

  test('langName gives English names and falls back to the code', () => {
    expect(S.langName('ja')).toBe('Japanese');
    expect(S.langName('pt-BR')).toBe('Brazilian Portuguese');
    expect(S.langName('')).toBe('');
    expect(S.langName('not a code')).toBe('not a code');
  });
});

describe('pickSourceTrack', () => {
  const jaAsr = { languageCode: 'ja', kind: 'asr' };
  const ja = { languageCode: 'ja', kind: '' };
  const en = { languageCode: 'en', kind: '' };
  const ko = { languageCode: 'ko', kind: '' };

  test('prefers the track YouTube is showing', () => {
    expect(S.pickSourceTrack([ja, jaAsr, ko], { languageCode: 'ko', kind: '' }, 'en')).toBe(ko);
    expect(S.pickSourceTrack([ja, jaAsr], { languageCode: 'ja', kind: 'asr' }, 'en')).toBe(jaAsr);
  });

  test('ignores a shown track that is already in the target language', () => {
    expect(S.pickSourceTrack([en, jaAsr], { languageCode: 'en', kind: '' }, 'en')).toBe(jaAsr);
  });

  test('prefers hand-made captions in the spoken language over ASR', () => {
    expect(S.pickSourceTrack([ko, jaAsr, ja], null, 'en')).toBe(ja);
  });

  test('falls back to ASR, then to any hand-made track', () => {
    expect(S.pickSourceTrack([ko, jaAsr], null, 'en')).toBe(jaAsr);
    expect(S.pickSourceTrack([en, ko], null, 'en')).toBe(ko);
  });

  test('returns null when everything is already in the target language', () => {
    expect(S.pickSourceTrack([en, { languageCode: 'en', kind: 'asr' }], null, 'en-US')).toBeNull();
    expect(S.pickSourceTrack([], null, 'en')).toBeNull();
    expect(S.pickSourceTrack(undefined, null, 'en')).toBeNull();
  });
});

describe('parseJson3', () => {
  test('hand-made captions: one cue per event, sorted', () => {
    const json = {
      events: [
        { tStartMs: 3000, dDurationMs: 1500, segs: [{ utf8: 'second\nline' }] },
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'first ' }, { utf8: 'line' }] },
        { tStartMs: 5000, segs: [{ utf8: '  ' }] },
        { tStartMs: 6000 }
      ]
    };
    expect(S.parseJson3(json, false)).toEqual([
      { s: 1, e: 3, text: 'first line' },
      { s: 3, e: 4.5, text: 'second line' }
    ]);
  });

  test('Japanese ASR words are regrouped and split at a pause', () => {
    const json = {
      events: [
        { tStartMs: 0, segs: [{ utf8: '今日は' }, { utf8: 'いい', tOffsetMs: 300 }, { utf8: '天気', tOffsetMs: 600 }] },
        { tStartMs: 900, segs: [{ utf8: '\n' }] },
        { tStartMs: 3000, segs: [{ utf8: 'ですね' }] }
      ]
    };
    const cues = S.parseJson3(json, true);
    expect(cues.map(c => c.text)).toEqual(['今日はいい天気', 'ですね']);
    expect(cues[0].s).toBe(0);
    expect(cues[0].e).toBeLessThanOrEqual(3);
    expect(cues[1].e).toBeGreaterThan(cues[1].s);
  });

  test('English ASR keeps spaces, allows longer lines and splits after a full stop', () => {
    const words = 'so today we are going to look at the new camera that I bought last week.'.split(' ');
    const segs = words.map((w, i) => ({ utf8: (i ? ' ' : '') + w, tOffsetMs: i * 250 }));
    const json = { events: [{ tStartMs: 0, segs }, { tStartMs: 4000, segs: [{ utf8: 'Next' }] }] };
    const cues = S.parseJson3(json, true);
    expect(cues.map(c => c.text)).toEqual([words.join(' '), 'Next']);
  });

  test('handles empty input', () => {
    expect(S.parseJson3(null, true)).toEqual([]);
    expect(S.parseJson3({}, false)).toEqual([]);
  });
});

describe('readable timing', () => {
  const Q = S.TIMING.quick; // the original timing; the exact numbers below assume it

  test('mergeShortCues joins a short line with the one right after it', () => {
    const cues = [
      { s: 0, e: 0.8, text: 'Yeah.' },
      { s: 1, e: 3, text: 'So today we cook.' },
      { s: 3.2, e: 6.5, text: 'First the rice.' }
    ];
    expect(S.mergeShortCues(cues)).toEqual([
      { s: 0, e: 3, text: 'Yeah. So today we cook.' },
      { s: 3.2, e: 6.5, text: 'First the rice.' }
    ]);
  });

  test('mergeShortCues keeps lines apart across a long pause or when too long', () => {
    const pause = [{ s: 0, e: 1, text: 'Hi.' }, { s: 3, e: 5, text: 'Welcome back.' }];
    expect(S.mergeShortCues(pause)).toEqual(pause);
    const long = [{ s: 0, e: 1, text: 'a'.repeat(80) }, { s: 1, e: 2, text: 'b'.repeat(40) }];
    expect(S.mergeShortCues(long)).toHaveLength(2);
    const slow = [{ s: 0, e: 2, text: 'x' }, { s: 2, e: 8, text: 'y' }];
    expect(S.mergeShortCues(slow)).toHaveLength(1);
    const tooSlow = [{ s: 0, e: 2, text: 'x' }, { s: 2, e: 8.5, text: 'y' }]; // over 8 s merged
    expect(S.mergeShortCues(tooSlow)).toHaveLength(2);
  });

  test('mergeShortCues joins Japanese without a space and Korean with one', () => {
    expect(S.mergeShortCues([{ s: 0, e: 1, text: 'はい' }, { s: 1, e: 3, text: '今日は' }])[0].text).toBe('はい今日は');
    expect(S.mergeShortCues([{ s: 0, e: 1, text: '네' }, { s: 1, e: 3, text: '오늘은' }])[0].text).toBe('네 오늘은');
  });

  test('mergeShortCues does not modify its input', () => {
    const cues = [{ s: 0, e: 1, text: 'a' }, { s: 1, e: 3, text: 'b' }];
    S.mergeShortCues(cues);
    expect(cues).toEqual([{ s: 0, e: 1, text: 'a' }, { s: 1, e: 3, text: 'b' }]);
    expect(S.mergeShortCues([])).toEqual([]);
  });

  test('readingTime grows with length, within the preset limits', () => {
    expect(S.readingTime('Hi', Q)).toBe(1.5);
    expect(S.readingTime('x'.repeat(45), Q)).toBe(3);
    expect(S.readingTime('あ'.repeat(14), Q)).toBe(2);
    expect(S.readingTime('x'.repeat(500), Q)).toBe(6);
    expect(S.readingTime(null, Q)).toBe(1.5);
  });

  test('cueToShow keeps a line up long enough to read it', () => {
    const cues = [{ s: 0, e: 0.5, text: 'x'.repeat(45) }, { s: 10, e: 12, text: 'next' }];
    expect(S.cueToShow(cues, 2.9, null, Q)).toBe(0); // 45 chars ≈ 3 s of reading
    expect(S.cueToShow(cues, 3.1, null, Q)).toBe(-1);
    expect(S.cueToShow(cues, -1, null, Q)).toBe(-1);
  });

  test('cueToShow measures the shown text (the translation)', () => {
    const cues = [{ s: 0, e: 0.5, text: 'はい' }];
    expect(S.cueToShow(cues, 2.5, () => 'x'.repeat(45), Q)).toBe(0);
    expect(S.cueToShow(cues, 2.5, null, Q)).toBe(-1);
  });

  test('cueToShow bridges short pauses but never delays the next line', () => {
    const cues = [{ s: 0, e: 2, text: 'one' }, { s: 2.8, e: 4, text: 'two' }, { s: 9, e: 10, text: 'three' }];
    expect(S.cueToShow(cues, 2.5, null, Q)).toBe(0);  // 0.8 s pause: no blink
    expect(S.cueToShow(cues, 2.8, null, Q)).toBe(1);  // next line takes over on time
    expect(S.cueToShow(cues, 6, null, Q)).toBe(-1);   // long pause: box hides
  });

  test('cueDisplayEnd matches what cueToShow shows', () => {
    const cues = [{ s: 0, e: 0.5, text: 'x'.repeat(45) }, { s: 3.5, e: 5, text: 'b' }, { s: 20, e: 21, text: 'c' }];
    expect(S.cueDisplayEnd(cues, 0, null, Q)).toBe(3.5);              // read time 3 s, then bridged to the next line
    expect(S.cueDisplayEnd(cues, 1, 'x'.repeat(30), Q)).toBe(5.5); // 30 chars ≈ 2 s of reading
    expect(S.cueDisplayEnd(cues, 2, 'x'.repeat(90), Q)).toBe(26);  // 6 s cap, last line
    expect(S.cueToShow(cues, 3.4, null, Q)).toBe(0);
    expect(S.cueToShow(cues, 3.5, null, Q)).toBe(1);
    expect(S.cueToShow(cues, 4.9, null, Q)).toBe(1);
    expect(S.cueToShow(cues, 5.1, null, Q)).toBe(-1); // 'b' needs only the 1.5 s minimum
  });

  test('timingOf falls back to normal, which is the default setting', () => {
    expect(S.timingOf('relaxed')).toBe(S.TIMING.relaxed);
    expect(S.timingOf('bogus')).toBe(S.TIMING.normal);
    expect(S.timingOf(undefined)).toBe(S.TIMING.normal);
    expect(S.withDefaults(null, 'en').timing).toBe('normal');
    expect(S.readingTime('Hi')).toBe(S.readingTime('Hi', S.TIMING.normal));
  });

  test('longer presets hold a line past the end of its caption', () => {
    const cues = [{ s: 0, e: 2, text: 'one' }];
    expect(S.cueDisplayEnd(cues, 0, null, S.TIMING.quick)).toBe(2);
    expect(S.cueDisplayEnd(cues, 0, null, S.TIMING.normal)).toBeCloseTo(2.8);
    expect(S.cueDisplayEnd(cues, 0, null, S.TIMING.relaxed)).toBeCloseTo(3.5);
  });

  test('longer presets bridge longer pauses', () => {
    const cues = [{ s: 0, e: 2, text: 'one' }, { s: 4.5, e: 6, text: 'two' }];
    expect(S.cueToShow(cues, 4, null, S.TIMING.quick)).toBe(-1);
    expect(S.cueToShow(cues, 4, null, S.TIMING.normal)).toBe(-1);
    expect(S.cueToShow(cues, 4, null, S.TIMING.relaxed)).toBe(0);
  });

  test('no preset ever delays the next line', () => {
    const cues = [{ s: 0, e: 0.5, text: 'x'.repeat(100) }, { s: 1, e: 2, text: 'y' }];
    for (const timing of Object.values(S.TIMING)) {
      expect(S.cueToShow(cues, 0.99, null, timing)).toBe(0);
      expect(S.cueToShow(cues, 1, null, timing)).toBe(1);
    }
  });

  test('presets order from shortest to longest', () => {
    const cues = [{ s: 0, e: 1, text: 'x'.repeat(40) }, { s: 30, e: 31, text: 'y' }];
    const end = name => S.cueDisplayEnd(cues, 0, null, S.TIMING[name]);
    expect(end('quick')).toBeLessThan(end('normal'));
    expect(end('normal')).toBeLessThan(end('relaxed'));
  });

  test('vttEscape keeps cue text from being read as WebVTT markup', () => {
    expect(S.vttEscape('<b>a</b> & <c.x>')).toBe('&lt;b&gt;a&lt;/b&gt; &amp; &lt;c.x&gt;');
    expect(S.vttEscape('plain\nline')).toBe('plain\nline');
  });

  test('fast Japanese speech: every line stays up at least ~2 s', () => {
    // Auto-captions for rapid speech: a word every 0.3 s, a sentence end
    // every third word, so the raw phrases last only about 0.9 s each.
    const events = [];
    for (let i = 0; i < 60; i++) {
      events.push({ tStartMs: i * 300, segs: [{ utf8: i % 3 === 2 ? 'です。' : 'ですね' }] });
    }
    const raw = S.parseJson3({ events }, true);
    const cues = S.mergeShortCues(raw);
    const shownFor = (i, timing) => {
      let t = cues[i].s, n = 0;
      while (S.cueToShow(cues, t, null, timing) === i) { t += 0.05; n++; }
      return n * 0.05;
    };
    expect(Math.min(...raw.map(c => c.e - c.s))).toBeLessThan(1);
    for (const timing of Object.values(S.TIMING)) {
      for (let i = 0; i < cues.length - 1; i++) expect(shownFor(i, timing)).toBeGreaterThanOrEqual(1.95);
    }
  });
});

test('cueIndexAt finds the last cue starting at or before t', () => {
  const cues = [{ s: 1 }, { s: 3 }, { s: 7 }];
  expect(S.cueIndexAt(cues, 0)).toBe(-1);
  expect(S.cueIndexAt(cues, 1)).toBe(0);
  expect(S.cueIndexAt(cues, 5)).toBe(1);
  expect(S.cueIndexAt(cues, 99)).toBe(2);
  expect(S.cueIndexAt([], 5)).toBe(-1);
});

describe('buildMessages', () => {
  test('includes languages, title, context and numbered lines', () => {
    const [sys, user] = S.buildMessages(
      ['一行目', '二行目'],
      [{ text: '前の行', tr: 'previous line' }, { text: '未訳', tr: '' }],
      'My video', 'Japanese', 'Finnish'
    );
    expect(sys.role).toBe('system');
    expect(sys.content).toContain('Translate Japanese subtitles into Finnish');
    expect(user.role).toBe('user');
    expect(user.content).toContain('Video title: My video');
    expect(user.content).toContain('前の行  =>  previous line');
    expect(user.content).toContain('未訳\n');
    expect(user.content).toMatch(/Translate these lines into Finnish:\n1: 一行目\n2: 二行目$/);
  });

  test('omits title and context when absent', () => {
    const [, user] = S.buildMessages(['a'], [], '', 'English', 'German');
    expect(user.content).toBe('Translate these lines into German:\n1: a');
  });
});

describe('parseNumbered', () => {
  test('reads numbered lines in several styles', () => {
    const text = '1: Hello\n**2.** "Quoted"\n- 3) dash\n[4] bracket';
    expect(S.parseNumbered(text, 4)).toEqual(['Hello', 'Quoted', 'dash', 'bracket']);
  });

  test('strips think blocks and code fences', () => {
    const text = '<think>1: wrong</think>\n```\n1: right\n2: also right\n```';
    expect(S.parseNumbered(text, 2)).toEqual(['right', 'also right']);
  });

  test('leaves missing or out-of-range lines as null and keeps the first answer', () => {
    expect(S.parseNumbered('1: a\n1: dup\n3: c\n9: out', 3)).toEqual(['a', null, 'c']);
  });

  test('accepts unnumbered output with the right line count', () => {
    expect(S.parseNumbered('one\ntwo', 2)).toEqual(['one', 'two']);
    expect(S.parseNumbered('one\ntwo', 3)).toEqual([null, null, null]);
  });

  test('handles empty text', () => {
    expect(S.parseNumbered('', 2)).toEqual([null, null]);
  });
});

describe('misc', () => {
  test('cuesSignature changes with the text', () => {
    const a = S.cuesSignature([{ text: 'x' }, { text: 'y' }]);
    expect(a).toMatch(/^2-/);
    expect(S.cuesSignature([{ text: 'x' }, { text: 'z' }])).not.toBe(a);
  });

  test('cacheKey separates ASR and target language', () => {
    expect(S.cacheKey('abc', { languageCode: 'ja', kind: 'asr' }, 'en')).toBe('tr:abc:ja.asr:en');
    expect(S.cacheKey('abc', { languageCode: 'ja', kind: '' }, 'fi')).toBe('tr:abc:ja:fi');
  });

  test('chatBody switches thinking off unless told not to', () => {
    const msgs = [{ role: 'user', content: 'x' }];
    expect(S.chatBody('m', msgs, undefined, true)).toEqual({
      model: 'm', messages: msgs, temperature: 0.2, stream: false, reasoning_effort: 'none'
    });
    const plain = S.chatBody('m', msgs, 0, false);
    expect(plain.temperature).toBe(0);
    expect(plain).not.toHaveProperty('reasoning_effort');
  });

  test('isReasoningParamError only matches 400s about thinking/reasoning', () => {
    expect(S.isReasoningParamError(400, '"gemma3:4b" does not support thinking')).toBe(true);
    expect(S.isReasoningParamError(400, 'invalid reasoning_effort')).toBe(true);
    expect(S.isReasoningParamError(400, 'bad request')).toBe(false);
    expect(S.isReasoningParamError(404, 'model "x" not found, try pulling it first')).toBe(false);
    expect(S.isReasoningParamError(400, undefined)).toBe(false);
  });

  test('isCaptionUrl only accepts YouTube caption requests over https', () => {
    expect(S.isCaptionUrl('https://www.youtube.com/api/timedtext?v=abc&lang=ja')).toBe(true);
    expect(S.isCaptionUrl('http://www.youtube.com/api/timedtext?v=abc')).toBe(false);
    expect(S.isCaptionUrl('https://evil.example/api/timedtext?v=abc')).toBe(false);
    expect(S.isCaptionUrl('https://www.youtube.com.evil.example/api/timedtext')).toBe(false);
    expect(S.isCaptionUrl('https://www.youtube.com/redirect?q=/api/timedtext')).toBe(false);
    expect(S.isCaptionUrl('not a url')).toBe(false);
  });

  test('isValidEndpoint accepts plain http(s) addresses only', () => {
    expect(S.isValidEndpoint('http://localhost:11434')).toBe(true);
    expect(S.isValidEndpoint(' https://192.168.1.5:1234/v1 ')).toBe(true);
    expect(S.isValidEndpoint('javascript:alert(1)')).toBe(false);
    expect(S.isValidEndpoint('file:///etc/passwd')).toBe(false);
    expect(S.isValidEndpoint('http://user:pw@localhost:11434')).toBe(false);
    expect(S.isValidEndpoint('localhost:11434')).toBe(false);
  });

  test('chatUrl / modelsUrl normalise the endpoint', () => {
    expect(S.chatUrl('http://localhost:11434')).toBe('http://localhost:11434/v1/chat/completions');
    expect(S.chatUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1/chat/completions');
    expect(S.modelsUrl(' http://127.0.0.1:11434/ ')).toBe('http://127.0.0.1:11434/v1/models');
  });
});
