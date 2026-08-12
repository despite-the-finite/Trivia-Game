/** Small DOM helpers shared by the screens. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Elements are addressed by `data-role`, which keeps CSS classes free to change. */
export const role = (name, root = document) => root.querySelector(`[data-role="${name}"]`);

export function setText(name, value, root = document) {
  const el = role(name, root);
  if (el) el.textContent = value;
  return el;
}

export function show(el, visible = true) {
  if (el) el.hidden = !visible;
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function clear(node) {
  if (node) node.replaceChildren();
  return node;
}

export const formatNumber = (n) => Number(n ?? 0).toLocaleString('en-US');

export const formatSeconds = (ms) => `${(Number(ms ?? 0) / 1000).toFixed(1)} sec`;

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const CATEGORY_LABELS = {
  'current-events': 'Current Events',
  science: 'Science',
  geography: 'Geography',
  mixed: 'Mixed',
};

let toastTimer;

export function toast(message, duration = 2400) {
  const node = role('toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  // Force a reflow so the transition runs when toasts fire back to back.
  void node.offsetWidth;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove('is-visible');
    setTimeout(() => {
      node.hidden = true;
    }, 250);
  }, duration);
}

/** Counts a number up, for the end-of-game score reveal. */
export function animateNumber(node, to, duration = 700) {
  if (!node) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || to === 0) {
    node.textContent = formatNumber(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - (1 - t) ** 3;
    node.textContent = formatNumber(Math.round(to * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
