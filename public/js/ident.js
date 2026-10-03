/* =============================================================================
   ident.js — The Entropic Labs opening ident.

   Plays the studio logo, with its sound, full-screen the moment the page
   opens, before the player sees the game. The game keeps loading underneath,
   so the ident doubles as the load screen.

   Usage — load this as a plain (non-module) script tag, first thing in
   <body>, with the video's URL in a data-src attribute on that tag:
   src="path/to/ident.js" data-src="path/to/entropic-ident.mp4".

   Rules it keeps:
   - Sound first. Browsers refuse to start audio before the player has
     interacted with the page, so when they do, the ident shows a quiet
     "Tap to begin" and plays with sound on that tap. (The same tap also
     unlocks the game's own audio.)
   - Never blocks the game. If the video can't load or play, or stalls, it
     gets out of the way.
   - Once playing, a click/tap or Enter/Space/Escape skips it. Keys are
     swallowed while it is up so the game underneath never sees a stray
     "press any key".
   - Add ?noident to the URL to skip it (handy while developing or testing).

   window.EntropicIdent.done is a Promise that resolves once it has gone.
   ============================================================================= */
(function () {
  'use strict';

  var BG = '#000';             // the ident's own background, so edges vanish
  var FADE_MS = 450;
  var STALL_MS = 4000;         // no progress for this long -> give up

  var script = document.currentScript;
  var src = script && script.getAttribute('data-src');

  var resolveDone;
  var api = window.EntropicIdent = {
    done: new Promise(function (r) { resolveDone = r; })
  };

  if (!src || /[?&]noident\b/.test(location.search)) {
    resolveDone();
    return;
  }

  var style = document.createElement('style');
  style.textContent =
    '#entropic-ident{position:fixed;inset:0;z-index:2147483647;background:' + BG + ';' +
      'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
      'opacity:1;transition:opacity ' + FADE_MS + 'ms ease;-webkit-tap-highlight-color:transparent;' +
      'touch-action:none;user-select:none;-webkit-user-select:none}' +
    '#entropic-ident.out{opacity:0}' +
    '#entropic-ident video{width:100%;height:100%;object-fit:contain;pointer-events:none;background:' + BG + '}' +
    '#entropic-ident .gate{position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
      'font:600 15px/1 system-ui,-apple-system,sans-serif;letter-spacing:.28em;text-transform:uppercase;color:#fff}' +
    '#entropic-ident.gated .gate{display:flex}' +
    '#entropic-ident.gated video{visibility:hidden}' +
    '#entropic-ident .gate span{animation:entropic-ident-pulse 2.2s ease-in-out infinite}' +
    '@keyframes entropic-ident-pulse{0%,100%{opacity:.35}50%{opacity:.9}}' +
    '#entropic-ident .skip{position:absolute;right:max(16px,env(safe-area-inset-right));' +
      'bottom:max(16px,env(safe-area-inset-bottom));font:600 13px/1 system-ui,-apple-system,sans-serif;' +
      'letter-spacing:.12em;text-transform:uppercase;color:#fff;opacity:0;transition:opacity .6s ease}' +
    '#entropic-ident .skip.show{opacity:.35}';
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.id = 'entropic-ident';
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', 'The Entropic Labs');

  var video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.setAttribute('disablepictureinpicture', '');
  video.src = src;

  var gate = document.createElement('div');
  gate.className = 'gate';
  gate.innerHTML = '<span>Tap to begin</span>';

  var hint = document.createElement('div');
  hint.className = 'skip';
  hint.textContent = 'Tap to skip';

  root.appendChild(video);
  root.appendChild(gate);
  root.appendChild(hint);
  (document.body || document.documentElement).appendChild(root);

  var finished = false;
  var playing = false;
  var gated = false;
  var timers = [];
  var watchdog = null;

  function finish(immediate) {
    if (finished) return;
    finished = true;
    timers.forEach(clearTimeout);
    if (watchdog) clearInterval(watchdog);
    root.classList.add('out');
    // Keep swallowing input until the fade is over, so the tap that skipped
    // the ident can't land on a button underneath it.
    setTimeout(function () {
      ['keydown', 'keyup', 'keypress'].forEach(function (t) {
        window.removeEventListener(t, swallowKey, true);
      });
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}
      if (root.parentNode) root.parentNode.removeChild(root);
      if (style.parentNode) style.parentNode.removeChild(style);
      resolveDone();
    }, immediate ? 0 : FADE_MS);
  }

  function started() {
    if (playing || finished) return;
    playing = true;
    gated = false;
    root.classList.remove('gated');
    timers.push(setTimeout(function () { hint.classList.add('show'); }, 1500));

    // Watchdog: if playback stops advancing (slow network, decoder trouble),
    // don't leave the player staring at a black screen.
    var lastTime = -1;
    var lastMove = Date.now();
    watchdog = setInterval(function () {
      if (finished) { clearInterval(watchdog); return; }
      if (document.hidden) { lastMove = Date.now(); return; }
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        lastMove = Date.now();
      } else if (Date.now() - lastMove > STALL_MS) {
        finish();
      }
    }, 500);
  }

  // Start playback; `fallback` runs if the browser says no.
  function tryPlay(muted, fallback) {
    video.muted = muted;
    var p;
    try { p = video.play(); } catch (e) { fallback(); return; }
    if (p && p.then) p.then(started, function (err) { if (!finished) fallback(err); });
    else started();
  }

  // Inside a user gesture: sound should now be allowed. If even that fails,
  // try silent, and if that fails too, just go to the game.
  function playFromGesture() {
    gated = false;
    root.classList.remove('gated');
    giveUpIfNotPlaying();
    tryPlay(false, function () { tryPlay(true, function () { finish(true); }); });
  }

  // A play() that never settles (stalled download) must not hang the page.
  var giveUp = null;
  function giveUpIfNotPlaying() {
    clearTimeout(giveUp);
    giveUp = setTimeout(function () { if (!playing && !gated) finish(); }, 2 * STALL_MS);
    timers.push(giveUp);
  }

  function onInput() {
    if (finished) return;
    if (gated) playFromGesture();
    else if (playing) finish();
  }

  function swallowKey(e) {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.type !== 'keydown' || e.repeat) return;
    if (gated || e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') onInput();
  }
  ['keydown', 'keyup', 'keypress'].forEach(function (t) {
    window.addEventListener(t, swallowKey, true);
  });

  root.addEventListener('click', onInput);

  video.addEventListener('ended', function () { finish(); });
  video.addEventListener('error', function () { finish(true); });

  // First choice: play straight away with sound. Most browsers block that on
  // a first visit, so fall back to asking for one tap.
  giveUpIfNotPlaying();
  tryPlay(false, function (err) {
    // Only the autoplay rule earns a "Tap to begin"; any other failure
    // (unsupported format, broken file) means the video can't play at all.
    if (!err || err.name !== 'NotAllowedError') { finish(true); return; }
    gated = true;
    root.classList.add('gated');
  });

  api.skip = function () { finish(); };
})();
