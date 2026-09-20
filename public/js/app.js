import { api, ApiError } from './services/ApiClient.js';
import { playerService } from './services/PlayerService.js';
import { triviaService } from './services/TriviaService.js';
import { leaderboardService } from './services/LeaderboardService.js';
import { ShareService } from './services/ShareService.js';
import {
  $, $$, role, setText, show, el, clear,
  formatNumber, formatSeconds, initials, toast, animateNumber, CATEGORY_LABELS,
} from './ui/dom.js';

/**
 * app.js — screen routing and the game loop.
 *
 * The client renders and times; the server decides. Every score, every verdict
 * and every leaderboard position in here came from an API response.
 */

const state = {
  screen: 'boot',
  category: 'current-events',
  lastSummary: null,
  timer: null,
  questionDeadline: 0,
  awaitingNext: false,
};

// ---------------------------------------------------------------------------
// Screen management
// ---------------------------------------------------------------------------

function showScreen(name) {
  state.screen = name;
  for (const section of $$('[data-screen]')) {
    section.classList.toggle('is-active', section.dataset.screen === name);
  }
  window.scrollTo(0, 0);
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

/** Post-sign-in routing: honour a direct link to the daily quiz, otherwise go home. */
async function enterApp() {
  if (window.location.pathname === '/daily') {
    await renderHome();
    await startDaily();
    return;
  }

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
  const avatar = role('home-avatar');
  if (avatar) avatar.textContent = initials(player.displayName);

  renderHomeStats(playerService.stats);

  // Refresh in the background; the cached copy is already on screen.
  guarded(async () => {
    const stats = await playerService.refreshStats();
    renderHomeStats(stats);
  });

  guarded(async () => {
    const daily = await triviaService.dailyStatus();
    renderDailyCard(daily);
  });

  guarded(() => renderCategoryCompletion());

  guarded(() => renderHomeLeaderboard());
}

/** Quick-play categories (everything except the combined 'mixed' Daily Challenge). */
const QUICK_PLAY_CATEGORIES = Object.keys(CATEGORY_LABELS).filter((c) => c !== 'mixed');

/** Ticks off each category chip whose quiz the player has already completed today. */
async function renderCategoryCompletion() {
  const statuses = await Promise.all(
    QUICK_PLAY_CATEGORIES.map((category) => triviaService.dailyStatus(category)),
  );
  QUICK_PLAY_CATEGORIES.forEach((category, i) => {
    const chip = $(`[data-category="${category}"]`);
    if (chip) chip.classList.toggle('is-complete', Boolean(statuses[i].played));
  });
}

function renderHomeStats(stats) {
  const container = role('home-stats');
  if (!container || !stats) return;
  clear(container).append(
    statTile(formatNumber(stats.weeklyScore), 'This week'),
    statTile(formatNumber(stats.allTimeScore), 'All time'),
    statTile(`${stats.accuracy}%`, 'Accuracy'),
    statTile(formatNumber(stats.bestStreak), 'Best streak'),
  );
}

const statTile = (value, label) =>
  el('div', { class: 'stat' }, [el('strong', { text: value }), el('span', { text: label })]);

function renderDailyCard(daily) {
  const card = $('[data-action="play-daily"]');
  if (!card) return;

  if (daily.played) {
    card.classList.add('is-done');
    setText('daily-title', `You scored ${formatNumber(daily.yourResult.score)}`);
    setText(
      'daily-meta',
      `${daily.yourResult.correct}/${daily.yourResult.total} correct · tap to see the board`,
    );
    card.dataset.state = 'played';
  } else if (daily.inProgress) {
    card.classList.remove('is-done');
    setText('daily-title', 'Finish today’s challenge');
    setText('daily-meta', `${daily.questionCount} questions · already started`);
    card.dataset.state = 'resume';
  } else {
    card.classList.remove('is-done');
    setText('daily-title', `Today's ${daily.questionCount} questions`);
    const played = daily.globalStats.playersCompleted;
    setText(
      'daily-meta',
      played
        ? `${formatNumber(played)} played · average ${formatNumber(daily.globalStats.averageScore)}`
        : 'Everyone plays the same set',
    );
    card.dataset.state = 'new';
  }
}

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------

function stopTimer() {
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
    },
  });
  if (!started) return;
  if (started.session?.isPractice) {
    toast("Today's score is already locked in — this run is practice only.");
  }
  showScreen('game');
  renderQuestion();
}

async function startDaily() {
  const status = await guarded(() => triviaService.dailyStatus());
  if (!status) return;

  if (status.played) {
    await openDailyBoard(status);
    return;
  }

  showScreen('boot');
  const started = await guarded(() => triviaService.startDailyChallenge(), {
    onError: (err) => {
      toast(err.message);
      showScreen('home');
    },
  });
  if (!started) return;
  showScreen('game');
  renderQuestion();
}

async function openDailyBoard(status) {
  const data = await guarded(() => triviaService.dailyLeaderboard());
  if (!data) return;

  showScreen('daily-board');
  const panel = clear(role('daily-board-panel'));
  panel.append(
    el('h2', { class: 'panel__title', text: `Daily Challenge · ${status.day}` }),
    el('p', {
      class: 'panel__body',
      text: `You scored ${formatNumber(status.yourResult.score)} — ${status.yourResult.correct}/${status.yourResult.total} correct.`,
    }),
    el('button', {
      class: 'btn btn--primary btn--block',
      text: 'SHARE MY SCORE',
      onClick: () => shareDaily(status),
    }),
  );

  const list = el('ol', { class: 'board' });
  for (const entry of data.entries.slice(0, 25)) {
    list.append(
      el('li', { class: `board__row${entry.isViewer ? ' is-you' : ''}` }, [
        el('span', { class: 'board__rank', text: `${entry.rank}` }),
        el('span', { class: 'board__name' }, [
          el('div', { text: entry.displayName }),
          el('div', {
            class: 'board__meta',
            text: `${entry.accuracy}% · ${formatSeconds(entry.completionMs)}`,
          }),
        ]),
        el('span', { class: 'board__value', text: formatNumber(entry.score) }),
      ]),
    );
  }
  if (!data.entries.length) {
    list.append(el('li', { class: 'empty', text: 'Nobody has finished today yet.' }));
  }
  panel.append(el('h3', { class: 'section__title', text: "Today's board" }), list);
}

async function shareDaily(status) {
  const text = ShareService.dailyText({
    score: status.yourResult.score,
    correct: status.yourResult.correct,
    total: status.yourResult.total,
  });
  const outcome = await ShareService.share({ text, url: status.shareUrl || window.location.origin });
  if (outcome === 'copied') toast('Copied — paste it anywhere.');
  if (outcome === 'failed') toast('Could not share on this device.');
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
    el('td', { class: 'lbmatrix__rank', text: `#${entry.rank}` }),
    el('td', { class: 'lbmatrix__name', text: entry.displayName }),
    el('td', { class: 'lbmatrix__score', text: formatNumber(entry.totalScore) }),
    ...QUICK_PLAY_CATEGORIES.map((category) =>
      el('td', {
        class: 'lbmatrix__cat',
        text: formatNumber(entry.categoryScores[category] ?? 0),
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
    const target = event.target.closest('[data-action], [data-category], [data-history-day]');
    if (!target) return;

    if (target.dataset.category) {
      state.category = target.dataset.category;
      selectWithin(role('category-chips'), target);
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
        await startCategoryQuiz();
        break;
      case 'play-daily':
        await startDaily();
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
    if (document.hidden && state.screen === 'game') stopTimer();
    else if (!document.hidden && state.screen === 'game' && !state.awaitingNext) {
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

bindEvents();
boot();
