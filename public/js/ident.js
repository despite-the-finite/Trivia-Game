/* =============================================================================
   ident.js — the opening idents.

   Two stings, played back to back full-screen the moment the page opens,
   before the player sees the game:
     1. The Entropic Labs studio logo — a video (the "E" dissolving into the
        red hot pixel), with its own sound.
     2. The Entropic Brainwaves game logo — 3 seconds of SVG + a few DOM nodes
        driven by requestAnimationFrame, with sound synthesized in Web Audio.
   The game keeps loading underneath, so the idents double as the load screen.

   Usage — load this as a plain (non-module) script tag, first thing in
   <body>, with the studio video's URL in a data-src attribute on that tag:
   src="path/to/ident.js" data-src="path/to/entropic-ident.mp4". Without
   data-src it goes straight to the game logo.

   Rules it keeps:
   - Sound first. Browsers refuse to start audio before the player has
     interacted with the page, so when they do, the ident shows a quiet
     "Tap to begin" and plays with sound on that tap. (The same tap unlocks
     both idents' sound and the game's own audio.)
   - Never blocks the game. If the video can't load or play, or stalls, it
     moves on to the game logo; without Web Audio that plays silently.
   - Once playing, a click/tap or Enter/Space/Escape skips the whole intro.
     Keys are swallowed while it is up so the game underneath never sees a
     stray "press any key".
   - Add ?noident to the URL to skip it (handy while developing or testing).

   window.EntropicIdent.done is a Promise that resolves once it has gone.
   ============================================================================= */
(function () {
  'use strict';

  var BG = '#0B0B0D';          // --ink-0, so edges vanish into the app behind
  var VIDEO_BG = '#000';       // the studio video's own background
  var FADE_MS = 450;
  var VIDEO_OUT_MS = 400;      // crossfade from the video into the game logo
  var STALL_MS = 4000;         // video makes no progress for this long -> move on
  var DURATION = 3.0;          // seconds of the game logo's authored timeline
  var AUDIO_PROBE_MS = 200;    // how long to wait for an un-gestured resume()

  var script = document.currentScript;
  var src = script && script.getAttribute('data-src');

  var resolveDone;
  var api = window.EntropicIdent = {
    done: new Promise(function (r) { resolveDone = r; })
  };

  if (/[?&]noident\b/.test(location.search)) {
    resolveDone();
    return;
  }

  // --- Timeline maths (ported from the design's intro-scene.jsx) -------------

  var PAL = ['#C8FF3D', '#8CF0A8', '#59C8FF'];
  var PAPER = '#F4F1EA';
  var GLYPHS = '01#%&*+-/<>=?@[]{}|~ABCDEFGHJKLMNPQRSTUVWXYZ';
  var TITLE = 'ENTROPIC BRAINWAVES';
  // Noise 0-0.6s, Resolve 0.6-1.5s, then Hold to DURATION (1.5s, so the
  // finished logo has time to land).
  var CUES = { Noise: 0, Resolve: 0.6, Hold: 1.5 };

  var Easing = {
    easeOutCubic: function (t) { return (--t) * t * t + 1; },
    easeOutExpo: function (t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    easeOutBack: function (t) {
      var c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
  };
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function animate(from, to, start, end, ease) {
    return function (t) {
      if (t <= start) return from;
      if (t >= end) return to;
      return from + (to - from) * ease((t - start) / (end - start));
    };
  }
  var enter = function (s, e) { return animate(0, 1, s, e, Easing.easeOutCubic); };
  var settle = function (s, e) { return animate(1, 0, s, e, Easing.easeOutExpo); };
  var pop = function (s, e) { return animate(0.86, 1, s, e, Easing.easeOutBack); };

  function hash(a, b) {
    var h = (a * 374761393 + b * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  // Squares stay put; the broken dashes travel along the perimeter
  // (stroke-dashoffset), each at its own pace/direction.
  var RINGS = [
    { x: 56, w: 48, r: 6, dash: null, per: 192, spin: 0 },
    { x: 36, w: 88, r: 8, dash: '44 10 30 8 20 14 36 12', per: 174, spin: -12 },
    { x: 16, w: 128, r: 10, dash: '22 18 12 24 8 30 14 22 6 34', per: 190, spin: 8 }
  ];
  var DOTS = [[3, 40, 6], [150, 22, 5], [149, 120, 6], [8, 118, 4], [70, 3, 5], [96, 151, 4]];

  var chaosAt = settle(CUES.Resolve - 0.1, CUES.Resolve + 0.7);
  var scaleAt = pop(CUES.Resolve, CUES.Resolve + 0.6);
  var markOpAt = enter(0, 0.25);
  var vignAt = enter(0, 0.4);
  var subAt = enter(CUES.Hold - 0.15, CUES.Hold + 0.3);
  var SCRAMBLE_START = CUES.Resolve - 0.05;
  var SCRAMBLE_SPAN = 0.75;

  // --- DOM -------------------------------------------------------------------

  var MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
  var style = document.createElement('style');
  style.textContent =
    '#entropic-ident{position:fixed;inset:0;z-index:2147483647;background:' + BG + ';overflow:hidden;' +
      'cursor:pointer;opacity:1;transition:opacity ' + FADE_MS + 'ms ease;-webkit-tap-highlight-color:transparent;' +
      'touch-action:none;user-select:none;-webkit-user-select:none;font-family:' + MONO + ';color:' + PAPER + '}' +
    '#entropic-ident.out{opacity:0}' +
    '#entropic-ident .eb-layer{position:absolute;inset:0;pointer-events:none}' +
    '#entropic-ident .eb-grid{background-image:radial-gradient(#1E1E24 1px,transparent 1.2px);background-size:24px 24px}' +
    '#entropic-ident .eb-glow{background:radial-gradient(ellipse 60% 60% at 50% 48%,rgba(200,255,61,0.07),transparent 70%)}' +
    '#entropic-ident .eb-flash{background:' + PAPER + ';mix-blend-mode:screen;opacity:0}' +
    '#entropic-ident .eb-stage{position:absolute;left:50%;top:50%;width:1920px;height:1080px;' +
      'transform-origin:0 0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:40px;pointer-events:none}' +
    '#entropic-ident .eb-mark{width:300px;height:300px;overflow:visible;filter:drop-shadow(0 0 28px rgba(200,255,61,0.25));opacity:0}' +
    '#entropic-ident .eb-words{display:flex;flex-direction:column;align-items:center;gap:14px}' +
    '#entropic-ident .eb-title{font-size:64px;font-weight:700;letter-spacing:0.18em;line-height:1;white-space:pre}' +
    '#entropic-ident .eb-title span{display:inline-block;width:1ch}' +
    '#entropic-ident .eb-sub{font-size:18px;letter-spacing:0.3em;color:#8E8E98;opacity:0}' +
    '#entropic-ident .eb-video{position:absolute;inset:0;background:' + VIDEO_BG + ';' +
      'transition:opacity ' + VIDEO_OUT_MS + 'ms ease}' +
    '#entropic-ident .eb-video.gone{opacity:0}' +
    '#entropic-ident video{width:100%;height:100%;object-fit:contain;pointer-events:none;background:' + VIDEO_BG + '}' +
    '#entropic-ident .skip{position:absolute;right:max(16px,env(safe-area-inset-right));' +
      'bottom:max(16px,env(safe-area-inset-bottom));font:600 11px/1 ' + MONO + ';' +
      'letter-spacing:.2em;text-transform:uppercase;color:' + PAPER + ';opacity:0;transition:opacity .6s ease}' +
    '#entropic-ident .skip.show{opacity:.35}' +
    '#entropic-ident .gate{position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
      'font:600 13px/1 ' + MONO + ';letter-spacing:.28em;text-transform:uppercase;color:' + PAPER + '}' +
    '#entropic-ident.gated .gate{display:flex}' +
    '#entropic-ident.gated :is(.eb-stage,video){visibility:hidden}' +
    '#entropic-ident .gate span{animation:entropic-ident-pulse 2.2s ease-in-out infinite}' +
    '@keyframes entropic-ident-pulse{0%,100%{opacity:.35}50%{opacity:.9}}';
  document.head.appendChild(style);

  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }
  function div(cls) {
    var node = document.createElement('div');
    node.className = cls;
    return node;
  }

  var root = document.createElement('div');
  root.id = 'entropic-ident';
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', 'The Entropic Labs presents Entropic Brainwaves');

  var grid = div('eb-layer eb-grid');
  var glow = div('eb-layer eb-glow');
  var flash = div('eb-layer eb-flash');
  var stage = div('eb-stage');

  // The mark.
  var mark = svgEl('svg', { viewBox: '0 0 160 160', class: 'eb-mark', 'aria-hidden': 'true' });
  var defs = svgEl('defs', {});
  var grad = svgEl('linearGradient', {
    id: 'eb-ident-iri', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 160, y2: 160
  });
  [0, 0.5, 1].forEach(function (offset, i) {
    grad.appendChild(svgEl('stop', { offset: offset, 'stop-color': PAL[i] }));
  });
  defs.appendChild(grad);
  mark.appendChild(defs);

  var fillIri = 'url(#eb-ident-iri)';
  var core = svgEl('rect', { x: 72, y: 72, width: 16, height: 16, rx: 3, fill: fillIri });
  core.style.transformOrigin = '80px 80px';
  mark.appendChild(core);

  var ringEls = RINGS.map(function (r) {
    var attrs = {
      x: r.x, y: r.x, width: r.w, height: r.w, rx: r.r,
      fill: 'none', stroke: fillIri, 'stroke-width': 8
    };
    if (r.dash) attrs['stroke-dasharray'] = r.dash;
    var node = svgEl('rect', attrs);
    mark.appendChild(node);
    return node;
  });
  var dotEls = DOTS.map(function (d) {
    var node = svgEl('rect', { x: d[0], y: d[1], width: d[2], height: d[2], rx: d[2] / 3, fill: fillIri });
    mark.appendChild(node);
    return node;
  });
  var hot = svgEl('rect', { x: 153, y: 64, width: 5, height: 5, rx: 1.5, fill: '#FF5B38' });
  mark.appendChild(hot);

  // The words.
  var words = div('eb-words');
  var title = div('eb-title');
  var letters = TITLE.split('').map(function () {
    var span = document.createElement('span');
    span.textContent = ' ';
    title.appendChild(span);
    return span;
  });
  var sub = div('eb-sub');
  sub.textContent = 'THE ENTROPIC LABS · GAMES';
  words.appendChild(title);
  words.appendChild(sub);

  stage.appendChild(mark);
  stage.appendChild(words);

  // The studio video sits on top of the game logo's scene and fades away
  // once it has played, revealing it.
  var videoLayer = div('eb-video');
  var video = null;
  if (src) {
    video = document.createElement('video');
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('disablepictureinpicture', '');
    video.src = src;
    videoLayer.appendChild(video);
  } else {
    videoLayer.classList.add('gone');
  }

  var gate = div('gate');
  gate.innerHTML = '<span>Tap to begin</span>';

  var hint = div('skip');
  hint.textContent = 'Tap to skip';

  [grid, glow, flash, stage, videoLayer, gate, hint].forEach(function (n) { root.appendChild(n); });
  (document.body || document.documentElement).appendChild(root);

  // Scale the 1920x1080 composition to fit the viewport.
  function fit() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = 'scale(' + s + ') translate(-50%, -50%)';
  }
  fit();
  window.addEventListener('resize', fit);

  // Every property is a pure function of T.
  function render(T) {
    var chaos = chaosAt(T);
    var seed = Math.floor(T * 24);
    var vign = vignAt(T);

    grid.style.opacity = vign * 0.9;
    glow.style.opacity = vign;
    flash.style.opacity = clamp(1 - Math.abs(T - CUES.Resolve) * 10, 0, 1) * 0.18;

    mark.style.opacity = markOpAt(T);
    mark.style.transform = 'scale(' + scaleAt(T) + ')';
    core.style.transform = 'scale(' + (1 + chaos * 0.6) + ')';

    RINGS.forEach(function (r, i) {
      // Dashes race around the square during the noise, then ease into a slow
      // permanent drift. The square itself never rotates.
      var travel = T * r.spin * (1 + 14 * chaos) + chaos * (hash(i, seed) - 0.5) * r.per;
      var jitter = chaos * (hash(i, seed) - 0.5) * 10;
      var node = ringEls[i];
      node.setAttribute('x', r.x + jitter);
      node.setAttribute('y', r.x - jitter);
      node.setAttribute('stroke-dashoffset', travel);
      node.style.opacity = 0.55 + 0.45 * (1 - chaos * hash(i, seed + 7));
    });

    DOTS.forEach(function (d, i) {
      var dx = chaos * (hash(i, seed) - 0.5) * 40;
      var dy = chaos * (hash(i + 9, seed) - 0.5) * 40;
      dotEls[i].setAttribute('x', d[0] + dx);
      dotEls[i].setAttribute('y', d[1] + dy);
    });

    hot.style.opacity = chaos > 0.5 ? seed % 2 : 1;

    var glyphSeed = Math.floor(T * 30);
    for (var i = 0; i < TITLE.length; i++) {
      var c = TITLE[i];
      var shown;
      if (c === ' ') shown = ' ';
      else if (T >= SCRAMBLE_START + SCRAMBLE_SPAN * (0.3 + 0.7 * hash(i, 3))) shown = c;
      else if (T < SCRAMBLE_START - 0.45 + hash(i, 5) * 0.3) shown = '';
      else shown = GLYPHS[Math.floor(hash(i, glyphSeed) * GLYPHS.length)];
      letters[i].textContent = shown || ' ';
      letters[i].style.color = shown === c ? PAPER : PAL[i % 3];
    }

    var s = subAt(T);
    sub.style.opacity = s;
    sub.style.transform = 'translateY(' + (1 - s) * 8 + 'px)';
  }
  render(0);

  // --- Sound (ported from the design's playIdentSound) ----------------------

  var AC = window.AudioContext || window.webkitAudioContext;
  var ac = null;
  try { if (AC) ac = window.__ebAC || (window.__ebAC = new AC()); } catch (e) { ac = null; }

  // Filtered noise burst + data blips + rising chirp + water-drop chime +
  // detuned pad. All synthesized, ~2s.
  function playIdentSound() {
    if (!ac) return;
    ac.resume();
    var t0 = ac.currentTime + 0.03, out = ac.createGain(); out.gain.value = 0.9; out.connect(ac.destination);
    var env = function (g, t, a, peak, d) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    };
    // white noise -> bandpass sweep (static resolving)
    var nb = ac.createBuffer(1, ac.sampleRate * 0.8, ac.sampleRate), nd = nb.getChannelData(0);
    for (var i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    var ns = ac.createBufferSource(); ns.buffer = nb;
    var bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(600, t0); bp.frequency.exponentialRampToValueAtTime(6000, t0 + 0.7);
    var ng = ac.createGain(); env(ng, t0, 0.02, 0.22, 0.65);
    ns.connect(bp).connect(ng).connect(out); ns.start(t0); ns.stop(t0 + 0.8);
    // computer blips (square, random pentatonic-ish)
    var blipF = [880, 1174, 1318, 1760, 2093, 2637];
    for (var b = 0; b < 9; b++) {
      var o = ac.createOscillator(), g = ac.createGain(); o.type = 'square';
      o.frequency.value = blipF[Math.floor(Math.random() * blipF.length)];
      var t = t0 + 0.05 + b * 0.065 + Math.random() * 0.02;
      env(g, t, 0.004, 0.06, 0.05); o.connect(g).connect(out); o.start(t); o.stop(t + 0.08);
    }
    // rising chirp into the resolve
    var ch = ac.createOscillator(), cg = ac.createGain(); ch.type = 'sine';
    ch.frequency.setValueAtTime(220, t0 + 0.35); ch.frequency.exponentialRampToValueAtTime(1760, t0 + 0.72);
    env(cg, t0 + 0.35, 0.05, 0.18, 0.4); ch.connect(cg).connect(out); ch.start(t0 + 0.35); ch.stop(t0 + 0.85);
    // water-drop chime at the resolve (fast pitch fall), then a 3-note detuned chime
    var drop = function (t, f) {
      var o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine';
      o.frequency.setValueAtTime(f * 2.2, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
      env(g, t, 0.005, 0.5, 0.9); o.connect(g).connect(out); o.start(t); o.stop(t + 1);
    };
    drop(t0 + 0.7, 1046.5);
    [[0.86, 1318.5], [0.98, 1568], [1.1, 2093]].forEach(function (note) {
      [-7, 7].forEach(function (det) {
        var o = ac.createOscillator(), g = ac.createGain(); o.type = 'triangle';
        o.frequency.value = note[1]; o.detune.value = det;
        env(g, t0 + note[0], 0.01, 0.16, 0.85); o.connect(g).connect(out);
        o.start(t0 + note[0]); o.stop(t0 + note[0] + 0.95);
      });
    });
    // soft pad bed under the hold
    [130.8, 196, 261.6].forEach(function (f, i) {
      var o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine';
      o.frequency.value = f; o.detune.value = (i - 1) * 5;
      // Held under the whole 1.5s hold, fading out with the logo.
      env(g, t0 + 0.75, 0.2, 0.09, 2.05); o.connect(g).connect(out);
      o.start(t0 + 0.75); o.stop(t0 + 3.05);
    });
  }

  // --- Playback --------------------------------------------------------------
  //
  // phase: 'waiting' (deciding whether sound may start) -> 'video' ->
  // 'logo' -> finished. 'gated' is a flag on top of 'waiting'.

  var phase = 'waiting';
  var finished = false;
  var gated = false;
  var raf = null;
  var timers = [];
  var watchdog = null;

  function later(fn, ms) { var id = setTimeout(fn, ms); timers.push(id); return id; }

  function stopVideo() {
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    if (!video) return;
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}
    video = null;
  }

  function finish(immediate) {
    if (finished) return;
    finished = true;
    timers.forEach(clearTimeout);
    if (raf) cancelAnimationFrame(raf);
    root.classList.add('out');
    // Keep swallowing input until the fade is over, so the tap that skipped
    // the ident can't land on a button underneath it.
    setTimeout(function () {
      ['keydown', 'keyup', 'keypress'].forEach(function (t) {
        window.removeEventListener(t, swallowKey, true);
      });
      window.removeEventListener('resize', fit);
      stopVideo();
      if (root.parentNode) root.parentNode.removeChild(root);
      if (style.parentNode) style.parentNode.removeChild(style);
      resolveDone();
    }, immediate ? 0 : FADE_MS);
  }

  function ungate() {
    gated = false;
    root.classList.remove('gated');
  }

  function showHint() {
    later(function () { hint.classList.add('show'); }, 1500);
  }

  // --- Part 1: the studio video ---

  function videoStarted() {
    if (finished || phase !== 'waiting') return;
    phase = 'video';
    ungate();
    showHint();

    // Watchdog: if playback stops advancing (slow network, decoder trouble),
    // don't leave the player staring at a black screen.
    var lastTime = -1;
    var lastMove = Date.now();
    watchdog = setInterval(function () {
      if (phase !== 'video') { clearInterval(watchdog); return; }
      if (document.hidden) { lastMove = Date.now(); return; }
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        lastMove = Date.now();
      } else if (Date.now() - lastMove > STALL_MS) {
        startLogo();
      }
    }, 500);
  }

  // Start the video; `fallback` runs if the browser says no.
  function tryPlay(muted, fallback) {
    if (!video) { fallback(); return; }
    video.muted = muted;
    var p;
    try { p = video.play(); } catch (e) { fallback(e); return; }
    if (p && p.then) p.then(videoStarted, function (err) { if (!finished && phase === 'waiting') fallback(err); });
    else videoStarted();
  }

  if (video) {
    video.addEventListener('ended', function () { if (phase === 'video') startLogo(); });
    video.addEventListener('error', function () { if (!finished && phase !== 'logo') startLogo(); });
  }

  // --- Part 2: the game logo ---

  function soundIfAllowed() {
    if (!ac) return;
    if (ac.state === 'running') { playIdentSound(); return; }
    // Sound was allowed for the video but the AudioContext was created before
    // that; give resume() a moment, and stay silent rather than play late.
    var asked = performance.now();
    try {
      ac.resume().then(function () {
        if (!finished && ac.state === 'running' && performance.now() - asked < 250) playIdentSound();
      }, function () {});
    } catch (e) {}
  }

  function startLogo() {
    if (finished || phase === 'logo') return;
    phase = 'logo';
    ungate();
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    videoLayer.classList.add('gone');
    later(stopVideo, VIDEO_OUT_MS);
    root.style.background = BG;
    try { soundIfAllowed(); } catch (e) { /* silent is fine */ }

    var startedAt = performance.now();
    var frame = function (now) {
      if (finished) return;
      var T = Math.max(0, (now - startedAt) / 1000);
      if (T >= DURATION) {
        render(DURATION);
        finish();
        return;
      }
      render(T);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  // --- Input ---

  // Inside a user gesture: sound is now allowed. Both unlocks must happen
  // synchronously here, for browsers that tie them to the gesture.
  function playFromGesture() {
    ungate();
    try { if (ac) ac.resume(); } catch (e) {}
    if (video) {
      giveUpIfNotPlaying();
      tryPlay(false, function () { tryPlay(true, startLogo); });
    } else {
      startLogo();
    }
  }

  // A play() that never settles (stalled download) must not hang the page.
  var giveUp = null;
  function giveUpIfNotPlaying() {
    clearTimeout(giveUp);
    giveUp = later(function () { if (phase === 'waiting' && !gated) startLogo(); }, 2 * STALL_MS);
  }

  function onInput() {
    if (finished) return;
    if (phase === 'waiting') playFromGesture();   // gated, or still probing
    else finish();
  }

  function swallowKey(e) {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.type !== 'keydown' || e.repeat) return;
    if (phase === 'waiting' || e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') onInput();
  }
  ['keydown', 'keyup', 'keypress'].forEach(function (t) {
    window.addEventListener(t, swallowKey, true);
  });

  root.addEventListener('click', onInput);

  function askForTap() {
    if (phase !== 'waiting' || finished) return;
    gated = true;
    root.classList.add('gated');
  }

  // First choice: play straight away with sound. Most browsers block that on
  // a first visit, so fall back to asking for one tap.
  if (video) {
    giveUpIfNotPlaying();
    tryPlay(false, function (err) {
      // Only the autoplay rule earns a "Tap to begin"; any other failure
      // (unsupported format, broken file) means the video can't play at all.
      if (err && err.name === 'NotAllowedError') { askForTap(); return; }
      stopVideo();
      probeAudioThenLogo();
    });
    // Sound is allowed for media: wake the AudioContext now so it's running
    // by the time the game logo needs it.
    try { if (ac && ac.state !== 'running') ac.resume().catch(function () {}); } catch (e) {}
  } else {
    probeAudioThenLogo();
  }

  // No video: the game logo alone decides whether to gate. No Web Audio at
  // all: play silently rather than gate.
  function probeAudioThenLogo() {
    if (!ac || ac.state === 'running') { startLogo(); return; }
    var p;
    try { p = ac.resume(); } catch (e) { p = null; }
    if (p && p.then) {
      p.then(function () { if (ac.state === 'running' && phase === 'waiting') startLogo(); }, function () {});
    }
    later(function () {
      if (phase !== 'waiting') return;
      if (ac.state === 'running') startLogo();
      else askForTap();
    }, AUDIO_PROBE_MS);
  }

  api.skip = function () { finish(); };
})();
