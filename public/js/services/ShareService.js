/**
 * ShareService — native sharing where it exists, clipboard everywhere else.
 *
 * `navigator.share` gives the OS sheet on mobile (Messages, WhatsApp, Mail,
 * AirDrop…). On desktop it usually is not available, so we fall back to copying
 * the text and telling the user we did.
 */
export class ShareService {
  static get canShareNatively() {
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  }

  /**
   * @returns {Promise<'shared'|'copied'|'cancelled'|'failed'>}
   */
  static async share({ title = 'Live Trivia', text, url }) {
    if (ShareService.canShareNatively) {
      try {
        await navigator.share({ title, text, url });
        return 'shared';
      } catch (err) {
        // AbortError means the user dismissed the sheet — not a failure.
        if (err?.name === 'AbortError') return 'cancelled';
        // Anything else (permission, unsupported payload): fall through to copy.
      }
    }
    return ShareService.copy([text, url].filter(Boolean).join('\n'));
  }

  static async copy(value) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return 'copied';
      }
    } catch {
      /* fall through to the execCommand path */
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok ? 'copied' : 'failed';
    } catch {
      return 'failed';
    }
  }

  // --- Message builders ---------------------------------------------------

  static scoreText({ score, correct, total, mode }) {
    const label = mode === 'daily' ? 'the Daily Trivia Challenge' : 'Live Trivia';
    return `I scored ${score.toLocaleString('en-US')} points with ${correct}/${total} correct in ${label}. Think you can beat me?`;
  }

  static dailyText({ score, correct, total }) {
    return `I scored ${score.toLocaleString('en-US')} on today's Daily Trivia Challenge (${correct}/${total} correct). Can you beat me?`;
  }

  static challengeInviteText(displayName) {
    return `${displayName} challenged you to a round of Live Trivia — same questions, same order. Think you can win?`;
  }

  static friendCodeText(displayName, friendCode) {
    return `Add me on Live Trivia — I'm ${displayName}, friend code ${friendCode}.`;
  }
}

export const shareService = ShareService;
