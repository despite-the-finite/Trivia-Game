/* Behaviour for the one-time setup page. External for the same reason as
   setup.css: the CSP allows scripts only from this origin, never inline. */
const $ = (id) => document.getElementById(id);
let category = 'geography';

function show(el, text, kind) {
  el.hidden = false;
  el.textContent = text;
  el.className = `out ${kind}`;
}

/** Every call carries the secret as a header — never as a query parameter. */
async function call(action, params = {}) {
  const secret = $('secret').value.trim();
  if (!secret) throw new Error('Paste your CRON_SECRET above first.');

  const url = new URL('/api/setup', window.location.origin);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status}).`);
  return body;
}

async function run(button, outId, fn) {
  const out = $(outId);
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'WORKING…';
  show(out, 'Working…', 'info');
  try {
    await fn(out);
  } catch (err) {
    show(out, err.message, 'bad');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

$('check').addEventListener('click', () =>
  run($('check'), 'out-check', async (out) => {
    const data = await call('status');
    const total = data.pools.reduce((sum, p) => sum + p.total, 0);
    show(
      out,
      data.schema.applied
        ? `Connected. Tables are in place and the bank holds ${total} question(s).` +
            (total ? ' Nothing left to do — go and play.' : ' Run step 2.')
        : `Connected to the database, but the tables do not exist yet (found ${data.schema.tablesFound} of 4). Run step 1.`,
      data.schema.applied && total ? 'ok' : 'info',
    );
    $('step-migrate').dataset.done = String(data.schema.applied);
    $('step-seed').dataset.done = String(total > 0);
  }),
);

$('migrate').addEventListener('click', () =>
  run($('migrate'), 'out-migrate', async (out) => {
    const data = await call('migrate');
    show(out, data.message, data.schema.applied ? 'ok' : 'bad');
    $('step-migrate').dataset.done = String(data.schema.applied);
  }),
);

for (const chip of document.querySelectorAll('#cats .chip')) {
  chip.addEventListener('click', () => {
    for (const other of document.querySelectorAll('#cats .chip')) {
      other.classList.toggle('is-selected', other === chip);
    }
    category = chip.dataset.category;
  });
}

$('seed').addEventListener('click', () =>
  run($('seed'), 'out-seed', async (out) => {
    const params = { category };
    if (document.getElementById('replace').checked) params.replace = '1';
    const data = await call('seed', params);
    const total = data.pools.reduce((sum, p) => sum + p.total, 0);
    const r = data.result ?? {};
    const retired = data.retired ? `Retired ${data.retired} old question(s). ` : '';
    const detail = r.skipped
      ? `Skipped (${r.reason}).`
      : `${retired}Accepted ${r.accepted} of ${r.generated} generated, ${r.rejected} rejected.`;
    show(
      out,
      `${detail} The bank now holds ${total} question(s) across all categories.` +
        (total ? '\n\nOpen the game — it is ready to play.' : ''),
      total ? 'ok' : 'bad',
    );
    $('step-seed').dataset.done = String(total > 0);
  }),
);
