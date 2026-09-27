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
  // cancel: null renders an acknowledgement, with no way to decline.

  return new Promise(resolve => {
    const prev = document.activeElement;
    const back = document.createElement('div');
    back.className = 'modal-back noprint';
    back.innerHTML =
      `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
         <h3 id="mt">${esc(title)}</h3>
         ${body ? `<p>${esc(body)}</p>` : ''}
         <div class="modal-acts">
           ${cancel === null ? ''
             : `<button class="cancel">${esc(cancel)}</button>`}
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

    const cancelBtn = back.querySelector('.cancel');
    if (cancelBtn) cancelBtn.onclick = () => done(false);
    back.querySelector('.go').onclick = () => done(true);
    back.onclick = e => { if (e.target === back) done(false); };
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(back);
    back.querySelector('.go').focus();
  });
}

/**
 * Ask for a single value. Resolves the string, or null if cancelled.
 *
 * Same shape as confirmDialog rather than window.prompt, which blocks the page
 * and looks like a browser error.
 */
export function promptDialog(opts) {
  const { title, body = '', placeholder = '', confirm = 'OK', cancel = 'Cancel',
          password = false } = opts;

  return new Promise(resolve => {
    const prev = document.activeElement;
    const back = document.createElement('div');
    back.className = 'modal-back noprint';
    back.innerHTML =
      `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="pt">
         <h3 id="pt">${esc(title)}</h3>
         ${body ? `<p>${esc(body)}</p>` : ''}
         <input class="val" type="${password ? 'password' : 'text'}"
                placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
         <div class="modal-acts" style="margin-top:1rem">
           <button class="cancel">${esc(cancel)}</button>
           <button class="go primary">${esc(confirm)}</button>
         </div>
       </div>`;

    const input = back.querySelector('.val');
    const done = value => {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      if (prev && prev.focus) prev.focus();
      resolve(value);
    };

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      if (e.key === 'Enter' && document.activeElement === input) {
        e.preventDefault();
        done(input.value.trim());
      }
    }

    back.querySelector('.cancel').onclick = () => done(null);
    back.querySelector('.go').onclick = () => done(input.value.trim());
    back.onclick = e => { if (e.target === back) done(null); };
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(back);
    input.focus();
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

/* ---------- image uploads ----------

   Serverless hosting refuses a request body over about 4.5 MB, and it does so
   at the edge: the app never sees it, so the app's own "under 5 MB" message
   never gets a chance to appear. All the operator got back was a bare status
   code. A photo straight off a phone is routinely 6-12 MB, so this was not an
   edge case -- it was most of them.

   Rather than report the failure more politely, shrink the picture so it does
   not happen. Artwork is a background: the certificate renders it at
   1080x1350 and the bib is printed a few inches wide, so nothing above ~2000px
   survives to be seen. A file already small enough is passed through
   untouched, which keeps a carefully made PNG exactly as it was. */

const UPLOAD_LIMIT = 3.5 * 1024 * 1024;   // clear of the 4.5 MB platform ceiling
const MAX_EDGE = 2000;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image. PNG, JPEG or WebP.'));
    };
    img.src = url;
  });
}

const toBlob = (canvas, quality) =>
  new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));

/**
 * Return a file small enough to upload, re-encoding only when it has to.
 * `onNote` is called with a sentence to show if the picture was changed.
 */
export async function fitImageForUpload(file, onNote) {
  if (!file || file.size <= UPLOAD_LIMIT) return file;

  const img = await loadImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  let w = Math.round(img.naturalWidth * scale);
  let h = Math.round(img.naturalHeight * scale);

  // Drop the quality, then the size, until it fits. Artwork sits behind large
  // type, so it reaches the eye softened by the overlay well before the
  // compression shows.
  for (const [factor, quality] of [[1, 0.85], [1, 0.7], [0.75, 0.7], [0.55, 0.65]]) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * factor);
    canvas.height = Math.round(h * factor);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await toBlob(canvas, quality);
    if (blob && blob.size <= UPLOAD_LIMIT) {
      const mb = n => (n / (1024 * 1024)).toFixed(1);
      if (onNote) {
        onNote(`Your image was ${mb(file.size)} MB, larger than the server accepts, ` +
               `so it was resized to ${canvas.width}\u00d7${canvas.height} ` +
               `(${mb(blob.size)} MB) before uploading.`);
      }
      return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg',
                      { type: 'image/jpeg' });
    }
  }
  throw new Error('That image is too large to upload even after resizing. ' +
                  'Please save it smaller and try again.');
}
