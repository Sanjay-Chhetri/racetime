/* Shared UI primitives.

   Replaces window.alert and window.confirm. Both of those block the whole
   page, look like a browser error, and on a phone they cover the thing you
   were just looking at. On race day an organiser is usually mid-task with a
   queue of people waiting, so feedback has to arrive without stopping them. */

const $ = id => document.getElementById(id);

export const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- toasts ---------- */

function toastHost() {
  let host = $('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.className = 'toasts noprint';
    // Announced politely: a volunteer using a screen reader should hear the
    // confirmation without it interrupting what they are doing.
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Show a transient message.
 * @param {string} message
 * @param {'ok'|'error'|'info'} tone
 */
export function toast(message, tone = 'info') {
  const host = toastHost();
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.innerHTML =
    `<span class="ic" aria-hidden="true">${tone === 'ok' ? '✓' : tone === 'error' ? '!' : 'i'}</span>` +
    `<span class="msg">${esc(message)}</span>` +
    '<button class="x" aria-label="Dismiss">×</button>';

  const close = () => {
    el.classList.add('out');
    // Leave time for the transition, but never depend on it firing -- a
    // background tab throttles transitionend and the toast would stick.
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.x').onclick = close;
  host.appendChild(el);

  // Errors stay longer: they usually need reading twice.
  setTimeout(close, tone === 'error' ? 7000 : 4000);
  return close;
}

export const ok = m => toast(m, 'ok');
export const fail = m => toast(m, 'error');

/* ---------- confirm dialog ---------- */

/**
 * Ask before something destructive. Resolves true/false.
 * @param {{title:string, body?:string, confirm?:string, cancel?:string, danger?:boolean}} opts
 */
export function confirmDialog(opts) {
  const { title, body = '', confirm = 'Confirm', cancel = 'Cancel', danger = true } = opts;

  return new Promise(resolve => {
    const prev = document.activeElement;
    const back = document.createElement('div');
    back.className = 'modal-back noprint';
    back.innerHTML =
      `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
         <h3 id="mt">${esc(title)}</h3>
         ${body ? `<p>${esc(body)}</p>` : ''}
         <div class="modal-acts">
           <button class="cancel">${esc(cancel)}</button>
           <button class="go ${danger ? 'danger-solid' : 'primary'}">${esc(confirm)}</button>
         </div>
       </div>`;

    const done = answer => {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      // Put focus back where it was, or the page silently loses it to <body>.
      if (prev && prev.focus) prev.focus();
      resolve(answer);
    };

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      if (e.key === 'Tab') {
        // Minimal focus trap: two buttons, so just cycle between them.
        const btns = [...back.querySelectorAll('button')];
        const i = btns.indexOf(document.activeElement);
        e.preventDefault();
        btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
      }
    }

    back.querySelector('.cancel').onclick = () => done(false);
    back.querySelector('.go').onclick = () => done(true);
    back.onclick = e => { if (e.target === back) done(false); };
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(back);
    back.querySelector('.go').focus();
  });
}

/* ---------- async button state ---------- */

/**
 * Run `fn` with the button disabled and showing a spinner, so a slow request
 * can never be fired twice by an impatient second tap.
 */
export async function withBusy(btn, fn) {
  if (!btn || btn.disabled) return;
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.innerHTML = label;
  }
}

/* ---------- skeleton rows ---------- */

/** Placeholder rows that hold the table's shape while the first load runs. */
export function skeletonRows(cols, rows = 5) {
  let out = '';
  for (let i = 0; i < rows; i++) {
    out += '<tr class="skel">' +
      Array.from({ length: cols }, () => '<td><span class="bar"></span></td>').join('') +
      '</tr>';
  }
  return out;
}

/** A centred empty state with an optional hint line. */
export function emptyState(cols, title, hint = '') {
  return `<tr><td colspan="${cols}"><div class="empty">
    <div class="t">${esc(title)}</div>
    ${hint ? `<div class="h">${esc(hint)}</div>` : ''}
  </div></td></tr>`;
}
