/* =============================================================================
   ident.js — The Entropic Labs opening ident.

   Plays the studio logo full-screen the moment the page opens, before the
   player sees the game. The game keeps loading underneath, so the ident
   doubles as the load screen.

   Usage — load this as a plain (non-module) script tag, first thing in
   <body>, with the video's URL in a data-src attribute on that tag:
   src="path/to/ident.js" data-src="path/to/entropic-ident.mp4".

   Rules it keeps:
   - Never blocks the game. If the video can't load, can't autoplay (e.g. iOS
     Low Power Mode) or stalls, it gets out of the way immediately.
   - A click/tap or Enter/Space/Escape skips it. Keys are swallowed while it is
     up so the game underneath never sees a stray "press any key".
   - Add ?noident to the URL to skip it (handy while developing or testing).

   window.EntropicIdent.done is a Promise that resolves once it has gone.
   ============================================================================= */
(function () {
  'use strict';

  var BG = '#0a0b0d';          // the ident's own background, so edges vanish
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
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.preload = 'auto';
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.setAttribute('disablepictureinpicture', '');
  video.src = src;

  var hint = document.createElement('div');
  hint.className = 'skip';
  hint.textContent = 'Tap to skip';

  root.appendChild(video);
  root.appendChild(hint);
  (document.body || document.documentElement).appendChild(root);

  var finished = false;
  var timers = [];

  function finish(immediate) {
    if (finished) return;
    finished = true;
    timers.forEach(clearTimeout);
    clearInterval(watchdog);
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

  function swallowKey(e) {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.type === 'keydown' && (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape')) finish();
  }
  ['keydown', 'keyup', 'keypress'].forEach(function (t) {
    window.addEventListener(t, swallowKey, true);
  });

  root.addEventListener('click', function () { finish(); });

  video.addEventListener('ended', function () { finish(); });
  video.addEventListener('error', function () { finish(true); });

  var p;
  try { p = video.play(); } catch (e) { finish(true); }
  if (p && p.catch) p.catch(function () { finish(true); });

  timers.push(setTimeout(function () { hint.classList.add('show'); }, 1500));

  // Watchdog: if playback stops advancing (slow network, decoder trouble),
  // don't leave the player staring at a black screen.
  var lastTime = -1;
  var lastMove = Date.now();
  var watchdog = setInterval(function () {
    if (finished) { clearInterval(watchdog); return; }
    if (document.hidden) { lastMove = Date.now(); return; }
    if (video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      lastMove = Date.now();
    } else if (Date.now() - lastMove > STALL_MS) {
      finish();
    }
  }, 500);

  api.skip = function () { finish(); };
})();
