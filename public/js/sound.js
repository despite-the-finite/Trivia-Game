/**
 * Sound effects, synthesised with the Web Audio API.
 *
 * No audio files to load, so nothing delays the first question. The context is
 * created lazily on the first user gesture, which is what mobile browsers
 * require. Muting is remembered.
 */

const STORAGE_KEY = 'live-trivia.sound';

class SoundEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    try {
      this.enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch {
      /* storage unavailable */
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
    } catch {
      /* storage unavailable */
    }
  }

  /** Must be called from inside a user gesture the first time. */
  unlock() {
    if (this.ctx || !this.enabled) return;
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return;
    try {
      this.ctx = new Ctx();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  #tone({ freq, duration = 0.12, type = 'sine', gain = 0.14, delay = 0, sweepTo = null }) {
    if (!this.enabled) return;
    this.unlock();
    if (!this.ctx) return;

    const start = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, start + duration);

    // Short attack, exponential release — reads as a "tick" rather than a beep.
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(amp).connect(this.ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  tap() {
    this.#tone({ freq: 420, duration: 0.06, type: 'triangle', gain: 0.07 });
  }

  correct() {
    this.#tone({ freq: 587.33, duration: 0.12, type: 'sine', gain: 0.12 });
    this.#tone({ freq: 880, duration: 0.18, type: 'sine', gain: 0.1, delay: 0.09 });
  }

  wrong() {
    this.#tone({ freq: 220, duration: 0.22, type: 'sawtooth', gain: 0.08, sweepTo: 130 });
  }

  streak() {
    [659.25, 783.99, 1046.5].forEach((freq, i) => {
      this.#tone({ freq, duration: 0.11, type: 'sine', gain: 0.09, delay: i * 0.07 });
    });
  }

  tick() {
    this.#tone({ freq: 1200, duration: 0.03, type: 'square', gain: 0.035 });
  }

  finish() {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      this.#tone({ freq, duration: 0.22, type: 'triangle', gain: 0.1, delay: i * 0.1 });
    });
  }
}

export const sound = new SoundEngine();
