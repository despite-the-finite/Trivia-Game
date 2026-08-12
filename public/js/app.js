import { api, ApiError } from './services/ApiClient.js';
import { playerService } from './services/PlayerService.js';
import { triviaService } from './services/TriviaService.js';
import { leaderboardService } from './services/LeaderboardService.js';
import { challengeService, ChallengeService } from './services/ChallengeService.js';
import { ShareService } from './services/ShareService.js';
import { sound } from './sound.js';
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
  category: 'mixed',
  difficulty: 'any',
  pendingChallengeSlug: null,
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
  state.pendingChallengeSlug = ChallengeService.slugFromLocation();

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
    showScreen('onboarding');
    return;
  }

  await enterApp();
}

/** Post-sign-in routing: honour a challenge link, otherwise go home. */
async function enterApp() {
  if (state.pendingChallengeSlug) {
    const slug = state.pendingChallengeSlug;
    state.pendingChallengeSlug = null;
    await openChallenge(slug);
    return;
  }

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
  setText('home-code', player.friendCode);
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
  let lastTickSecond = Math.ceil(limitMs / 1000);

  const frame = () => {
    const remaining = state.questionDeadline - performance.now();
    const ratio = Math.max(remaining / limitMs, 0);
    if (fill) {
      fill.style.transform = `scaleX(${ratio})`;
      fill.classList.toggle('is-low', ratio < 0.3);
    }

    const second = Math.ceil(remaining / 1000);
    if (second !== lastTickSecond && second <= 5 && second > 0) {
      lastTickSecond = second;
      sound.tick();
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
  const diff = role('q-difficulty');
  if (diff) {
    diff.textContent = question.difficulty;
    diff.dataset.level = question.difficulty;
  }
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
  sound.tap();

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

  if (result.correct) {
    if (result.streak >= 3) sound.streak();
    else sound.correct();
  } else {
    sound.wrong();
  }

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
  sound.finish();

  const summary = await guarded(() => triviaService.finish());
  if (!summary) return;

  state.lastSummary = summary;
  renderResults(summary);
  leaderboardService.invalidate();
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

  const comparison = role('result-comparison');
  if (comparison) {
    if (summary.comparison) {
      const { rank, of, playerAhead } = summary.comparison;
      const lines = [`#${rank} of ${of} among your friends this week`];
      if (playerAhead && playerAhead.gap > 0) {
        lines.push(
          `${playerAhead.displayName} is ${formatNumber(playerAhead.gap)} points ahead of you`,
        );
      }
      comparison.textContent = lines.join(' · ');
      comparison.hidden = false;
    } else {
      comparison.hidden = true;
    }
  }

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

async function startQuickGame() {
  sound.unlock();
  showScreen('boot');
  const started = await guarded(
    () =>
      triviaService.startQuickGame({
        category: state.category,
        difficulty: state.difficulty,
      }),
    {
      onError: (err) => {
        toast(err.message);
        showScreen('home');
      },
    },
  );
  if (!started) return;
  showScreen('game');
  renderQuestion();
}

async function startDaily() {
  sound.unlock();
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
  const data = await guarded(() => triviaService.dailyLeaderboard('global'));
  if (!data) return;

  showScreen('challenge');
  const panel = clear(role('challenge-panel'));
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
// Challenges
// ---------------------------------------------------------------------------

async function openChallenge(slug) {
  const data = await guarded(() => challengeService.results(slug));
  if (!data) return;

  showScreen('challenge');
  const panel = clear(role('challenge-panel'));
  const you = data.participants.find((p) => p.isViewer);

  panel.append(
    el('h2', { class: 'panel__title', text: 'Head-to-head' }),
    el('p', {
      class: 'panel__body',
      text: `${data.challenge.questionCount} questions · ${CATEGORY_LABELS[data.challenge.category] ?? data.challenge.category}. Both players get the same set in the same order.`,
    }),
  );

  if (data.participants.some((p) => p.completed)) {
    if (data.outcome?.headline) {
      panel.append(el('p', { class: 'vs__verdict', text: data.outcome.headline }));
    }
    const rows = el('div', { class: 'vs' });
    for (const p of data.participants) {
      rows.append(
        el(
          'div',
          {
            class: `vs__row${data.outcome?.winnerId === p.playerId ? ' is-winner' : ''}${
              p.completed ? '' : ' is-pending'
            }`,
          },
          [
            el('span', { class: 'vs__name' }, [
              document.createTextNode(p.displayName + (p.isViewer ? ' (you)' : '')),
              el('span', {
                class: 'vs__meta',
                text: p.completed
                  ? `${p.correct}/${p.total} correct · ${p.accuracy}% · ${formatSeconds(p.totalResponseMs)} total`
                  : 'Has not played yet',
              }),
            ]),
            el('span', { class: 'vs__score', text: p.completed ? formatNumber(p.score) : '—' }),
          ],
        ),
      );
    }
    panel.append(rows);
  }

  if (!you || !you.completed) {
    panel.append(
      el('button', {
        class: 'btn btn--primary btn--block',
        text: you ? 'CONTINUE THE CHALLENGE' : 'ACCEPT THE CHALLENGE',
        onClick: () => playChallenge(slug),
      }),
    );
  }

  panel.append(
    el('button', {
      class: 'btn btn--secondary btn--block',
      text: 'SHARE THIS CHALLENGE',
      onClick: async () => {
        const outcome = await ShareService.share({
          text: data.shareText ?? ShareService.challengeInviteText(playerService.player?.displayName ?? 'A friend'),
          url: data.challenge.url,
        });
        if (outcome === 'copied') toast('Link copied.');
      },
    }),
    el('button', {
      class: 'btn btn--ghost btn--block',
      text: 'BACK TO HOME',
      onClick: () => {
        history.pushState({}, '', '/');
        renderHome();
      },
    }),
  );
}

async function playChallenge(slug) {
  sound.unlock();
  showScreen('boot');
  const started = await guarded(() => triviaService.startChallenge(slug), {
    onError: (err) => {
      toast(err.message);
      openChallenge(slug);
    },
  });
  if (!started) return;
  showScreen('game');
  renderQuestion();
}

async function createChallenge() {
  const created = await guarded(() =>
    challengeService.create({ category: state.category, difficulty: state.difficulty }),
  );
  if (!created) return;

  const outcome = await ShareService.share({
    text: created.shareText,
    url: created.url,
  });
  if (outcome === 'copied') toast('Challenge link copied — send it to a friend.');
  else if (outcome === 'failed') toast(created.url);

  await openChallenge(created.challenge.slug);
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

async function openLeaderboard() {
  showScreen('leaderboard');
  await renderLeaderboard();
}

async function renderLeaderboard() {
  const list = clear(role('lb-list'));
  list.append(el('li', { class: 'empty', text: 'Loading…' }));

  const data = await guarded(() => leaderboardService.load(), {
    onError: (err) => {
      clear(list).append(el('li', { class: 'empty', text: err.message }));
    },
  });
  if (!data) return;

  clear(list);
  if (!data.entries.length) {
    list.append(
      el('li', {
        class: 'empty',
        text:
          data.scope === 'friends'
            ? 'Add a friend to see how you compare.'
            : 'No scores in this period yet — be the first.',
      }),
    );
    return;
  }

  const unitSuffix = data.unit === 'percent' ? '%' : '';
  for (const entry of data.entries) {
    list.append(
      el('li', { class: `board__row${entry.isViewer ? ' is-you' : ''}` }, [
        el('span', { class: 'board__rank', text: `${entry.rank}` }),
        el('span', { class: 'board__name' }, [
          el('div', { text: entry.displayName }),
          entry.questionsAnswered
            ? el('div', {
                class: 'board__meta',
                text:
                  data.unit === 'points'
                    ? `${entry.accuracy}% accuracy · ${formatNumber(entry.questionsAnswered)} answered`
                    : `${formatNumber(entry.questionsAnswered)} answered`,
              })
            : null,
        ]),
        el('span', { class: 'board__value', text: `${formatNumber(entry.value)}${unitSuffix}` }),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------

async function openFriends() {
  showScreen('friends');
  setText('friends-own-code', playerService.player?.friendCode ?? '');
  await renderFriends();
}

async function renderFriends() {
  const list = clear(role('friends-list'));
  const friends = await guarded(() => playerService.listFriends());
  if (!friends) return;

  if (!friends.length) {
    list.append(
      el('li', {
        class: 'empty',
        text: 'No friends yet. Share your code, or add someone by theirs.',
      }),
    );
    return;
  }

  for (const friend of friends) {
    list.append(
      el('li', { class: 'friend' }, [
        el('span', { class: 'friend__name', text: friend.displayName }),
        el('button', {
          class: 'linkbtn',
          text: 'remove',
          onClick: async () => {
            await guarded(() => playerService.removeFriend(friend.id));
            await renderFriends();
            leaderboardService.invalidate();
          },
        }),
        el('span', { class: 'friend__stats' }, [
          el('span', {}, [document.createTextNode('Week '), el('b', { text: formatNumber(friend.weeklyScore) })]),
          el('span', {}, [document.createTextNode('All time '), el('b', { text: formatNumber(friend.allTimeScore) })]),
          el('span', {}, [document.createTextNode('Accuracy '), el('b', { text: `${friend.accuracy}%` })]),
          el('span', {}, [document.createTextNode('Best streak '), el('b', { text: formatNumber(friend.bestStreak) })]),
        ]),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function openSettings() {
  showScreen('settings');
  const input = $('[data-role="rename-form"] input[name="displayName"]');
  if (input) input.value = playerService.player?.displayName ?? '';
  const toggle = $('[data-action="toggle-sound"]');
  if (toggle) toggle.checked = sound.enabled;
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

  const url = summary.session.challengeId
    ? `${window.location.origin}/challenge/${summary.session.challengeId}`
    : window.location.origin;

  const outcome = await ShareService.share({ text, url });
  if (outcome === 'copied') toast('Copied — paste it anywhere.');
  if (outcome === 'failed') toast('Could not share on this device.');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents() {
  // Unlock audio on the first gesture anywhere.
  document.addEventListener('pointerdown', () => sound.unlock(), { once: true });

  document.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action], [data-category], [data-difficulty], [data-scope], [data-period], [data-board]');
    if (!target) return;

    // Filter chips / segmented controls
    if (target.dataset.category) {
      state.category = target.dataset.category;
      selectWithin(role('category-chips'), target);
      return;
    }
    if (target.dataset.difficulty) {
      state.difficulty = target.dataset.difficulty;
      selectWithin(role('difficulty-chips'), target);
      return;
    }
    if (target.dataset.scope) {
      leaderboardService.setFilter('scope', target.dataset.scope);
      selectWithin(role('lb-scope'), target);
      await renderLeaderboard();
      return;
    }
    if (target.dataset.period) {
      leaderboardService.setFilter('period', target.dataset.period);
      selectWithin(role('lb-period'), target);
      await renderLeaderboard();
      return;
    }
    if (target.dataset.board) {
      leaderboardService.setFilter('board', target.dataset.board);
      selectWithin(role('lb-board'), target);
      await renderLeaderboard();
      return;
    }

    switch (target.dataset.action) {
      case 'retry-connection':
        await boot();
        break;
      case 'show-restore':
        show(role('restore-form'), true);
        target.hidden = true;
        break;
      case 'play-quick':
        await startQuickGame();
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
        await startQuickGame();
        break;
      case 'challenge-friend':
        await createChallenge();
        break;
      case 'create-challenge':
        await createChallenge();
        break;
      case 'open-leaderboard':
        await openLeaderboard();
        break;
      case 'open-friends':
        await openFriends();
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
      case 'copy-friend-code': {
        const outcome = await ShareService.copy(playerService.player?.friendCode ?? '');
        toast(outcome === 'copied' ? 'Friend code copied.' : 'Could not copy.');
        break;
      }
      case 'share-friend-code': {
        const player = playerService.player;
        const outcome = await ShareService.share({
          text: ShareService.friendCodeText(player.displayName, player.friendCode),
          url: window.location.origin,
        });
        if (outcome === 'copied') toast('Copied — send it to a friend.');
        break;
      }
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

  document.addEventListener('change', (event) => {
    if (event.target.matches('[data-action="toggle-sound"]')) {
      sound.setEnabled(event.target.checked);
      if (event.target.checked) sound.correct();
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

  // Friends
  role('add-friend-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorNode = role('friends-error');
    show(errorNode, false);
    const added = await guarded(
      () => playerService.addFriend(event.target.elements.friendCode.value),
      {
        onError: (err) => {
          errorNode.textContent = err.message;
          show(errorNode, true);
        },
      },
    );
    if (added) {
      event.target.reset();
      toast(`${added.added.displayName} added.`);
      leaderboardService.invalidate();
      await renderFriends();
    }
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
    const slug = ChallengeService.slugFromLocation();
    if (slug) openChallenge(slug);
    else renderHome();
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
