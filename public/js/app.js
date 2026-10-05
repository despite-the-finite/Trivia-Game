import { api, ApiError } from './services/ApiClient.js';
import { playerService } from './services/PlayerService.js';
import { triviaService } from './services/TriviaService.js';
import { leaderboardService } from './services/LeaderboardService.js';
import { ShareService } from './services/ShareService.js';
import {
  $, $$, role, setText, show, el, clear,
  formatNumber, formatSeconds, toast, animateNumber, CATEGORY_LABELS,
} from './ui/dom.js';

/**
 * app.js — screen routing and the game loop.
 *
 * The client renders and times; the server decides. Every score, every verdict
 * and every leaderboard position in here came from an API response.
 */

const state = {
  screen: 'boot',
  /** The quick-play pick. Starts empty so the "pick a category" step is seen. */
  category: null,
  /** True while the play card's markers shatter on the way into a quiz. */
  dissolving: false,
  /** When today's game day ends (ISO string from the server), for the countdown. */
  resetsAt: null,
  lastSummary: null,
  timer: null,
  questionDeadline: 0,
  /** Pending reveal of the answers after the untimed reading hold. */
  holdTimer: null,
  resumeHold: false,
  awaitingNext: false,
};

// ---------------------------------------------------------------------------
// Screen management
// ---------------------------------------------------------------------------

function showScreen(name) {
  state.screen = name;
  // Lets the stylesheet theme individual screens (cover/home) from the body.
  document.body.dataset.view = name;
  for (const section of $$('[data-screen]')) {
    section.classList.toggle('is-active', section.dataset.screen === name);
  }
  window.scrollTo(0, 0);
}

// The backdrops' SVG (SMIL) motion isn't covered by the stylesheet's
// reduced-motion rule, so hold it still here.
if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  for (const svg of $$('.backdrop svg, .ambient svg, svg.pulse-mark')) svg.pauseAnimations?.();
}

/**
 * The app is online-only by design. Any network failure lands here rather than
 * degrading into a half-working state with stale content.
 */
function showOffline(message) {
  stopTimer();
  setText(
    'offline-message',
    message ?? 'Check your connection and try again.',
  );
  showScreen('offline');
}

/** Wraps an async action so network failures always surface as the offline screen. */
async function guarded(fn, { onError } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.isOffline) {
      showOffline('We could not reach the trivia server. Check your connection and try again.');
      return null;
    }
    if (err instanceof ApiError && err.isAuthError) {
      api.setToken(null);
      showScreen('onboarding');
      toast('Please set up your player again.');
      return null;
    }
    if (onError) {
      onError(err);
      return null;
    }
    toast(err.message ?? 'Something went wrong.');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  showScreen('boot');

  try {
    const health = await api.health();
    if (health.status === 'error') {
      showOffline('The trivia service is having trouble right now. Try again in a moment.');
      return;
    }
  } catch {
    showOffline('Trivia needs an internet connection. Check your connection and try again.');
    return;
  }

  const player = await guarded(() => playerService.restore());
  if (state.screen === 'offline') return;

  if (!player) {
    showScreen('cover');
    return;
  }

  await enterApp();
}

/** Post-sign-in routing: everything lands on home. */
async function enterApp() {
  await renderHome();
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

async function renderHome() {
  showScreen('home');
  const player = playerService.player;
  if (!player) return;

  setText('home-name', player.displayName);
  setDissolving(false);
  renderPlayCard();
  renderDateLabel(null);
  startResetCountdown();

  renderHomeStats(playerService.stats);

  // Refresh in the background; the cached copy is already on screen.
  guarded(async () => {
    const stats = await playerService.refreshStats();
    renderHomeStats(stats);
  });

  guarded(() => renderCategoryCompletion());

  guarded(() => renderHomeLeaderboard());
}

/** Quick-play categories — each has its own fixed daily quiz. */
const QUICK_PLAY_CATEGORIES = Object.keys(CATEGORY_LABELS);

/**
 * Ticks off each category chip whose quiz the player has already completed
 * today, and picks up the game day, its question count and when it resets.
 */
async function renderCategoryCompletion() {
  const statuses = await Promise.all(
    QUICK_PLAY_CATEGORIES.map((category) => triviaService.dailyStatus(category)),
  );
  const chips = role('category-chips');
  QUICK_PLAY_CATEGORIES.forEach((category, i) => {
    // Scoped to the chip grid: <body> also carries data-category after a game.
    const chip = chips && $(`[data-category="${category}"]`, chips);
    if (!chip) return;
    const { played, yourResult } = statuses[i];
    chip.classList.toggle('is-complete', Boolean(played));
    const done = role('chip-done', chip);
    if (done) {
      done.textContent = played && yourResult ? `✓ ${formatNumber(yourResult.score)}` : '✓';
      done.hidden = !played;
    }
  });

  const today = statuses[0];
  if (!today) return;
  renderDateLabel(today.day);
  if (today.questionCount) setText('question-count', String(today.questionCount));
  if (today.resetsAt) {
    state.resetsAt = today.resetsAt;
    renderResetCountdown();
  }
}

// --- Play card ----------------------------------------------------------------

/** Chip states and the play button's label both follow state.category. */
function renderPlayCard() {
  const chips = role('category-chips');
  selectWithin(chips, state.category ? $(`[data-category="${state.category}"]`, chips) : null);
  const label = state.category
    ? `PLAY ${(CATEGORY_LABELS[state.category] ?? state.category).toUpperCase()}`
    : 'PICK A CATEGORY TO PLAY';
  setText('play-label', label);
  $('[data-action="play-quick"]')?.setAttribute('aria-disabled', String(!state.category));
}

/** Deterministic noise, so the shatter looks the same every time. */
function shardHash(a, b) {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * Each 10px marker square is a 4×4 grid of shards. Their scatter vectors are
 * fixed up front as CSS variables; .is-dissolving on the card sends them out.
 */
function buildMarkers() {
  for (const marker of $$('[data-role="marker"]')) {
    const seed = Number(marker.dataset.seed) || 0;
    const shards = Array.from({ length: 16 }, (_, i) => {
      const cx = (i % 4) - 1.5;
      const cy = Math.floor(i / 4) - 1.5;
      const spread = 7 + shardHash(i, seed) * 9;
      const x = cx * spread + (shardHash(i, seed + 2) - 0.5) * 8;
      const y = cy * spread + (shardHash(i, seed + 3) - 0.5) * 8 - 4;
      const r = (shardHash(i, seed + 4) - 0.5) * 240;
      const shard = el('span', { class: 'marker__shard' });
      shard.style.setProperty('--x', `${x.toFixed(2)}px`);
      shard.style.setProperty('--y', `${y.toFixed(2)}px`);
      shard.style.setProperty('--r', `${r.toFixed(1)}deg`);
      return shard;
    });
    clear(marker).append(...shards);
  }
}

function setDissolving(on) {
  state.dissolving = on;
  role('playcard')?.classList.toggle('is-dissolving', on);
}

const DISSOLVE_MS = 600;
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Play from home: shatter the step markers, then start the picked quiz. */
async function playQuick() {
  if (!state.category || state.dissolving) return;
  setDissolving(true);
  if (!prefersReducedMotion()) await new Promise((r) => setTimeout(r, DISSOLVE_MS));
  // The player may have navigated away mid-shatter.
  if (state.screen !== 'home') return;
  await startCategoryQuiz();
}

// --- Day label and reset countdown --------------------------------------------

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "03 OCT" for the game day (YYYY-MM-DD), or the local date until it's known. */
function renderDateLabel(day) {
  let label;
  if (day) {
    const [, month, date] = day.split('-');
    label = `${date} ${MONTHS[Number(month) - 1]}`;
  } else {
    const now = new Date();
    label = `${String(now.getDate()).padStart(2, '0')} ${MONTHS[now.getMonth()]}`;
  }
  setText('home-date', label);
}

let countdownTimer = null;
/** The resetsAt already reloaded for, so a skewed clock can't loop the reload. */
let reloadedFor = null;

function startResetCountdown() {
  clearInterval(countdownTimer);
  renderResetCountdown();
  countdownTimer = setInterval(() => {
    if (state.screen !== 'home') {
      clearInterval(countdownTimer);
      countdownTimer = null;
      return;
    }
    renderResetCountdown();
  }, 15000);
}

/** HH:MM until the game day rolls over; at zero, reload home for the new day. */
function renderResetCountdown() {
  if (!state.resetsAt) return;
  const leftMs = new Date(state.resetsAt).getTime() - Date.now();
  if (leftMs <= 0) {
    setText('resets-in', '00:00');
    if (state.screen === 'home' && reloadedFor !== state.resetsAt) {
      reloadedFor = state.resetsAt;
      renderHome();
    }
    return;
  }
  const minutes = Math.ceil(leftMs / 60000);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  setText('resets-in', `${hh}:${mm}`);
}

function renderHomeStats(stats) {
  const container = role('home-stats');
  if (!container || !stats) return;
  clear(container).append(
    statTile(formatNumber(stats.gamesPlayed), 'Played'),
    statTile(formatNumber(stats.personalBests?.gameScore), 'Best'),
    statTile(`${stats.accuracy}%`, 'Accuracy'),
    statTile(formatNumber(stats.bestStreak), 'Streak'),
  );
}

const statTile = (value, label) =>
  el('div', { class: 'stat' }, [el('strong', { text: value }), el('span', { text: label })]);

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------

function cancelHold() {
  if (state.holdTimer) {
    clearTimeout(state.holdTimer);
    state.holdTimer = null;
  }
}

function stopTimer() {
  cancelHold();
  if (state.timer) {
    cancelAnimationFrame(state.timer);
    state.timer = null;
  }
}

function startTimer(limitMs) {
  stopTimer();
  const fill = role('timer-fill');
  state.questionDeadline = performance.now() + limitMs;

  const frame = () => {
    const remaining = state.questionDeadline - performance.now();
    const ratio = Math.max(remaining / limitMs, 0);
    if (fill) {
      fill.style.transform = `scaleX(${ratio})`;
      fill.classList.toggle('is-low', ratio < 0.3);
    }

    if (remaining <= 0) {
      state.timer = null;
      // Timing out is a real, scoreable outcome — submit a null answer.
      handleAnswer(null);
      return;
    }
    state.timer = requestAnimationFrame(frame);
  };
  state.timer = requestAnimationFrame(frame);
}

function renderQuestion() {
  const question = triviaService.current;
  if (!question) {
    finishGame();
    return;
  }

  state.awaitingNext = false;
  show(role('feedback'), false);

  const { current, total } = triviaService.progress;
  setText('progress-text', `Question ${current} of ${total}`);
  const fill = role('progress-fill');
  if (fill) fill.style.width = `${((current - 1) / total) * 100}%`;

  setText('game-score', formatNumber(triviaService.score));
  const streakBadge = role('streak-badge');
  if (streakBadge) {
    const showStreak = triviaService.streak >= 3;
    streakBadge.hidden = !showStreak;
    streakBadge.textContent = showStreak ? `🔥${triviaService.streak}` : '';
  }

  setText('q-category', CATEGORY_LABELS[question.category] ?? question.category);
  setText('q-text', question.question);

  clear(role('answers'));
  startReadingHold();
}

/**
 * Shows the question on its own for a few seconds before the answers appear.
 * The clock — and with it the speed bonus — only starts once they do, so a
 * slow reader is not penalised against a fast one.
 */
function startReadingHold() {
  stopTimer();
  const holdMs = triviaService.scoring?.readDelayMs ?? 3000;
  const fill = role('timer-fill');
  if (fill) {
    // The bar fills up during the hold, then drains once the clock runs.
    fill.classList.remove('is-low');
    fill.classList.add('is-holding');
    fill.style.transition = 'none';
    fill.style.transform = 'scaleX(0)';
    void fill.offsetWidth;
    fill.style.transition = `transform ${holdMs}ms linear`;
    fill.style.transform = 'scaleX(1)';
  }
  state.holdTimer = setTimeout(revealAnswers, holdMs);
}

function revealAnswers() {
  state.holdTimer = null;
  const question = triviaService.current;
  if (!question) return;

  const fill = role('timer-fill');
  if (fill) {
    fill.classList.remove('is-holding');
    fill.style.transition = '';
  }

  const answersNode = clear(role('answers'));
  question.answers.forEach((answer, index) => {
    answersNode.append(
      el(
        'button',
        {
          class: 'answer',
          type: 'button',
          'data-index': index,
          onClick: () => handleAnswer(index),
        },
        [
          el('span', { class: 'answer__key', text: 'ABCD'[index] ?? String(index + 1) }),
          el('span', { text: answer }),
        ],
      ),
    );
  });

  triviaService.markShown();
  startTimer(triviaService.scoring?.questionTimeLimitMs ?? 20000);
}

async function handleAnswer(selectedIndex) {
  if (state.awaitingNext) return;
  state.awaitingNext = true;
  stopTimer();

  const buttons = $$('.answer');
  for (const button of buttons) button.disabled = true;
  if (selectedIndex !== null && buttons[selectedIndex]) {
    buttons[selectedIndex].classList.add('is-selected');
  }

  const result = await guarded(() => triviaService.submitAnswer(selectedIndex), {
    onError: (err) => {
      // A duplicate or expired submission means our view of the run drifted;
      // move on rather than trapping the player.
      toast(err.message);
      state.awaitingNext = false;
      advance();
    },
  });
  if (!result) return;

  buttons.forEach((button, index) => {
    if (index === result.correctIndex) button.classList.add('is-correct');
    else if (index === selectedIndex) button.classList.add('is-wrong');
    else button.classList.add('is-dimmed');
  });

  const scorePill = $('.scorepill');
  setText('game-score', formatNumber(triviaService.score));
  if (result.pointsEarned > 0 && scorePill) {
    scorePill.classList.remove('is-bumped');
    void scorePill.offsetWidth;
    scorePill.classList.add('is-bumped');
  }

  renderFeedback(result, selectedIndex);
}

function renderFeedback(result, selectedIndex) {
  const verdict = role('feedback-verdict');
  if (verdict) {
    verdict.dataset.correct = String(result.correct);
    verdict.textContent = result.correct
      ? 'Correct'
      : selectedIndex === null
        ? "Time's up"
        : 'Not quite';
  }

  const parts = [];
  if (result.pointsEarned > 0) {
    parts.push(`+${formatNumber(result.pointsEarned)}`);
    parts.push(`${result.basePoints} base`);
    if (result.speedBonus > 0) parts.push(`+${result.speedBonus} speed`);
    if (result.streakLabel) parts.push(`${result.streakLabel} streak`);
  } else {
    parts.push('No points');
    if (!result.correct) parts.push('streak reset');
  }
  setText('feedback-points', parts.join(' · '));
  setText('feedback-explanation', result.explanation ?? '');

  const source = role('feedback-source');
  if (source) {
    if (result.sourceUrl) {
      source.href = result.sourceUrl;
      source.textContent = `Source: ${result.source}`;
      source.hidden = false;
    } else {
      source.hidden = true;
    }
  }

  show(role('feedback'), true);
}

function advance() {
  triviaService.advance();
  if (triviaService.isFinished) finishGame();
  else renderQuestion();
}

async function finishGame() {
  stopTimer();

  const summary = await guarded(() => triviaService.finish());
  if (!summary) return;

  state.lastSummary = summary;
  renderResults(summary);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function renderResults(summary) {
  showScreen('results');
  const { result, session } = summary;

  animateNumber(role('result-score'), result.score);
  setText('result-correct', `${result.correct} / ${result.total}`);
  setText('result-accuracy', `${result.accuracy}%`);
  setText('result-streak', formatNumber(result.bestStreak));
  setText('result-speed', formatSeconds(result.averageResponseMs));

  show(role('review'), false);
  clear(role('review'));

  // A daily result is worth surfacing on its own board.
  const shareBtn = $('[data-action="share-score"]');
  if (shareBtn) shareBtn.dataset.mode = session.mode;
}

async function renderReview() {
  const container = role('review');
  if (!container) return;
  if (!container.hidden) {
    show(container, false);
    return;
  }

  const questions = await guarded(() => triviaService.review(state.lastSummary?.session?.id));
  if (!questions) return;

  clear(container);
  for (const q of questions) {
    container.append(
      el('div', { class: 'review__item', 'data-correct': String(q.correct) }, [
        el('p', { class: 'review__q', text: q.question }),
        el('p', {
          class: 'review__a',
          text: q.correct
            ? `✓ ${q.correctAnswer}`
            : `✗ You said ${q.yourAnswer ?? 'nothing'} — the answer was ${q.correctAnswer}`,
        }),
        el('p', { class: 'review__a', text: q.explanation }),
        q.sourceUrl
          ? el('a', {
              class: 'review__src',
              href: q.sourceUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
              text: `Source: ${q.source}`,
            })
          : null,
      ]),
    );
  }
  show(container, true);
}

// ---------------------------------------------------------------------------
// Starting games
// ---------------------------------------------------------------------------

async function startCategoryQuiz() {
  showScreen('boot');
  const started = await guarded(() => triviaService.startCategoryQuiz(state.category), {
    onError: (err) => {
      toast(err.message);
      showScreen('home');
      setDissolving(false);
    },
  });
  if (!started) return;
  // Picks the category's scenery behind the game and results screens.
  document.body.dataset.category = state.category;
  if (started.session?.isPractice) {
    toast("Today's score is already locked in — this run is practice only.");
  }
  showScreen('game');
  renderQuestion();
}

// ---------------------------------------------------------------------------
// Inviting friends
// ---------------------------------------------------------------------------

/** No head-to-head matchmaking — just hand out a link to come play. */
async function inviteFriends() {
  const outcome = await ShareService.share({
    text: ShareService.inviteText(playerService.player?.displayName ?? 'A friend'),
    url: window.location.origin,
  });
  if (outcome === 'copied') toast('Link copied — send it to a friend.');
  if (outcome === 'failed') toast('Could not share on this device.');
}

// ---------------------------------------------------------------------------
// Leaderboard — permanently visible on home: today's top 10, broken out by
// category, plus the viewer's own row if they are not already in that top
// 10. A separate History screen browses the last few days the same way.
// ---------------------------------------------------------------------------

async function renderHomeLeaderboard() {
  const data = await guarded(() => leaderboardService.load({ limit: 10 }), {
    onError: () => renderLeaderboardTable('home-leaderboard-body', null),
  });
  renderLeaderboardTable('home-leaderboard-body', data);
}

function renderLeaderboardTable(bodyRole, data) {
  const body = clear(role(bodyRole));
  if (!data) {
    body.append(leaderboardMessageRow('Could not load the leaderboard.'));
    return;
  }
  if (!data.entries.length) {
    body.append(leaderboardMessageRow('No scores yet for this day.'));
    return;
  }
  for (const entry of data.entries) body.append(leaderboardRow(entry));
  if (data.viewerRow) body.append(leaderboardRow(data.viewerRow));
}

function leaderboardRow(entry) {
  return el('tr', { class: entry.isViewer ? 'is-you' : undefined }, [
    el('td', { class: 'lbmatrix__rank', text: String(entry.rank).padStart(2, '0') }),
    el('td', { class: 'lbmatrix__name', text: entry.displayName }),
    el('td', { class: 'lbmatrix__score', text: formatNumber(entry.totalScore) }),
    ...QUICK_PLAY_CATEGORIES.map((category) =>
      el('td', {
        class: 'lbmatrix__cat',
        // No score in a category yet reads as a dash, not a zero.
        text: entry.categoryScores[category] ? formatNumber(entry.categoryScores[category]) : '—',
      }),
    ),
  ]);
}

function leaderboardMessageRow(text) {
  return el('tr', {}, [
    el('td', { class: 'empty', colspan: String(3 + QUICK_PLAY_CATEGORIES.length), text }),
  ]);
}

// --- History --------------------------------------------------------------

const historyState = { day: null };

function dayChipLabel(day, index) {
  if (index === 0) return 'Today';
  if (index === 1) return 'Yesterday';
  const [, month, date] = day.split('-');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[Number(month) - 1]} ${Number(date)}`;
}

async function openLeaderboardHistory() {
  showScreen('leaderboard-history');
  const data = await guarded(() => leaderboardService.load({ limit: 10 }), {
    onError: () => renderLeaderboardTable('history-leaderboard-body', null),
  });
  if (!data) return;

  historyState.day = data.day;
  const chips = clear(role('history-days'));
  data.availableDays.forEach((day, index) => {
    chips.append(
      el('button', {
        class: `chip chip--small${day === data.day ? ' is-selected' : ''}`,
        'data-history-day': day,
        text: dayChipLabel(day, index),
      }),
    );
  });

  renderLeaderboardTable('history-leaderboard-body', data);
}

async function selectHistoryDay(day) {
  if (day === historyState.day) return;
  historyState.day = day;
  selectWithin(role('history-days'), $(`[data-history-day="${day}"]`));

  const data = await guarded(() => leaderboardService.load({ day, limit: 10 }), {
    onError: () => renderLeaderboardTable('history-leaderboard-body', null),
  });
  if (data) renderLeaderboardTable('history-leaderboard-body', data);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function openSettings() {
  showScreen('settings');
  const input = $('[data-role="rename-form"] input[name="displayName"]');
  if (input) input.value = playerService.player?.displayName ?? '';
  show(role('recovery-code'), false);
}

// ---------------------------------------------------------------------------
// Sharing the last result
// ---------------------------------------------------------------------------

async function shareScore() {
  const summary = state.lastSummary;
  if (!summary) return;

  const text =
    summary.session.mode === 'daily'
      ? ShareService.dailyText({
          score: summary.result.score,
          correct: summary.result.correct,
          total: summary.result.total,
        })
      : ShareService.scoreText({
          score: summary.result.score,
          correct: summary.result.correct,
          total: summary.result.total,
          mode: summary.session.mode,
        });

  const outcome = await ShareService.share({ text, url: window.location.origin });
  if (outcome === 'copied') toast('Copied — paste it anywhere.');
  if (outcome === 'failed') toast('Could not share on this device.');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents() {
  document.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action], .chip[data-category], [data-history-day]');
    if (!target) return;

    if (target.dataset.category) {
      if (state.dissolving) return;
      state.category = target.dataset.category;
      renderPlayCard();
      return;
    }
    if (target.dataset.historyDay) {
      await selectHistoryDay(target.dataset.historyDay);
      return;
    }

    switch (target.dataset.action) {
      case 'retry-connection':
        await boot();
        break;
      case 'get-started':
        showScreen('onboarding');
        break;
      case 'show-restore':
        show(role('restore-form'), true);
        target.hidden = true;
        break;
      case 'play-quick':
        await playQuick();
        break;
      case 'next-question':
        advance();
        break;
      case 'quit-game':
        stopTimer();
        if (triviaService.answers.length) await finishGame();
        else await renderHome();
        break;
      case 'play-again':
        await startCategoryQuiz();
        break;
      case 'invite-friend':
        await inviteFriends();
        break;
      case 'open-leaderboard-history':
        await openLeaderboardHistory();
        break;
      case 'open-settings':
        openSettings();
        break;
      case 'go-home':
        await renderHome();
        break;
      case 'share-score':
        await shareScore();
        break;
      case 'review-answers':
        await renderReview();
        break;
      case 'get-recovery-code': {
        const data = await guarded(() => playerService.requestRecoveryCode());
        if (!data) break;
        const node = role('recovery-code');
        if (node) {
          node.textContent = data.code;
          node.hidden = false;
        }
        toast(`Valid for ${data.expiresInMinutes} minutes.`);
        break;
      }
      default:
        break;
    }
  });

  // Onboarding
  role('onboarding-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = event.target.elements.displayName;
    const errorNode = role('onboarding-error');
    show(errorNode, false);

    const created = await guarded(() => playerService.createAccount(input.value), {
      onError: (err) => {
        errorNode.textContent = err.message;
        show(errorNode, true);
      },
    });
    if (created) await enterApp();
  });

  role('restore-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorNode = role('restore-error');
    show(errorNode, false);
    const restored = await guarded(
      () => playerService.restoreWithCode(event.target.elements.code.value),
      {
        onError: (err) => {
          errorNode.textContent = err.message;
          show(errorNode, true);
        },
      },
    );
    if (restored) await enterApp();
  });

  // Settings
  role('rename-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorNode = role('settings-error');
    show(errorNode, false);
    const updated = await guarded(
      () => playerService.rename(event.target.elements.displayName.value),
      {
        onError: (err) => {
          errorNode.textContent = err.message;
          show(errorNode, true);
        },
      },
    );
    if (updated) {
      toast('Name updated.');
      await renderHome();
    }
  });

  // Keyboard: 1-4 to answer, Enter to advance.
  document.addEventListener('keydown', (event) => {
    if (state.screen !== 'game') return;
    if (state.awaitingNext && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      advance();
      return;
    }
    const index = ['1', '2', '3', '4'].indexOf(event.key);
    if (index !== -1) {
      const button = $$('.answer')[index];
      if (button && !button.disabled) handleAnswer(index);
    }
  });

  // Pause the timer when the tab is hidden so backgrounding is not a penalty.
  document.addEventListener('visibilitychange', () => {
    const holding = Boolean(state.holdTimer);
    if (document.hidden && state.screen === 'game') {
      stopTimer();
      state.resumeHold = holding;
    } else if (!document.hidden && state.screen === 'game' && state.resumeHold) {
      // Hidden mid-hold: the answers never appeared, so just restart the hold.
      state.resumeHold = false;
      startReadingHold();
    } else if (!document.hidden && state.screen === 'game' && !state.awaitingNext) {
      const remaining = Math.max(state.questionDeadline - performance.now(), 1500);
      startTimer(remaining);
    }
  });

  window.addEventListener('popstate', () => {
    renderHome();
  });

  window.addEventListener('offline', () => {
    if (state.screen === 'game') {
      stopTimer();
      showOffline('You went offline mid-game. Reconnect to keep playing.');
    }
  });
}

function selectWithin(container, selected) {
  if (!container) return;
  for (const child of container.children) child.classList.toggle('is-selected', child === selected);
}

buildMarkers();
bindEvents();
boot();
