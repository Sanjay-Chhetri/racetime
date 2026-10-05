/* A runner's own virtual race: how far they have got, how to pay, and the
   runs they have logged.

   Progress is never held here. It is read back from the server after every
   change, because the server sums it from the submissions and this page
   keeping its own running total is how a screen ends up disagreeing with the
   thing it is showing. */

import html2canvas from '/vendor/html2canvas.esm.js';
import { esc, ok, fail, withBusy, money, fitImageForUpload, confirmDialog }
  from '/js/ui.js';
import { renderCardPng, downloadBlob, shareOrDownload, cardFileName }
  from '/js/cardexport.js';

const $ = id => document.getElementById(id);
const CARD_W = 1080;
const CARD_H = 1350;

const code = decodeURIComponent(location.hash.slice(1));
let me = null;
let event_ = null;        // the public event
let entry = null;         // this runner's registration, with progress
let runs = [];

const FLAG_WORDS = {
  'no-evidence': 'no screenshot',
  'fast': 'unusually quick',
  'long': 'longer than the whole race',
  'duplicate': 'looks like the same run twice',
};

const day = iso => iso
  ? new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''))
      .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  : '';

function problem(message) {
  $('err').textContent = message;
  $('err').hidden = false;
}

/* "58:30" and "1:12:40" are what people write. Seconds are what the API
   takes, and an empty box means they did not time it, which is allowed. */
function toSeconds(text) {
  const s = (text || '').trim();
  if (!s) return null;
  if (!/^\d{1,2}(:[0-5]\d){1,2}$/.test(s)) return NaN;
  const parts = s.split(':').map(Number);
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

const pace = r => {
  if (!r.duration_seconds || !r.distance_km) return '';
  const secPerKm = r.duration_seconds / r.distance_km;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')} / km`;
};

/* ---------- loading ---------- */

async function load() {
  const list = await fetch('/api/me/registrations').then(r => r.json());
  entry = (Array.isArray(list) ? list : []).find(r => r.event_code === code);
  if (!entry) {
    problem('You have not entered this race. Open the home page to enter it.');
    return false;
  }
  if (!entry.is_virtual) {
    // Sending them somewhere useful beats telling them they are in the wrong
    // place and leaving them there.
    location.href = '/me.html#entries';
    return false;
  }
  runs = await fetch(`/api/registrations/${entry.id}/runs`)
    .then(r => r.ok ? r.json() : []);
  return true;
}

/* ---------- progress ---------- */

function drawProgress() {
  const done = entry.done_km || 0;
  const target = entry.target_km || 0;
  const pct = target ? Math.min(100, (done / target) * 100) : 0;
  $('progressTitle').textContent = entry.race
    ? `${entry.race} — your progress` : 'Your progress';
  $('barFill').style.width = pct.toFixed(1) + '%';
  $('barFill').classList.toggle('full', entry.complete);
  const left = Math.max(0, target - done);
  $('progressNote').textContent = target
    ? `${done.toFixed(2)} of ${target} km done`
      + (entry.complete ? ' — that is the lot.'
                        : ` · ${left.toFixed(2)} km to go`)
      + (entry.runs_flagged
          ? ` · ${entry.runs_flagged} run${entry.runs_flagged === 1 ? '' : 's'}`
            + ' waiting to be looked at'
          : '')
    : 'The organiser has not set a distance for this entry yet.';

  if (event_ && event_.ends_at) {
    const closes = new Date(event_.ends_at);
    const days = Math.ceil((closes - new Date()) / 86400000);
    $('windowTag').textContent = days > 0
      ? `${days} day${days === 1 ? '' : 's'} left`
      : 'The window has closed';
    $('windowTag').classList.toggle('wait', days > 0 && days <= 3);
  } else {
    $('windowTag').hidden = true;
  }
  $('progressPanel').hidden = false;

  // The certificate appears when the distance is done and the entry is paid
  // for. Both conditions come from the server; this only reflects them.
  $('doneBox').hidden = !entry.complete;
  if (entry.complete) {
    $('doneNote').textContent = entry.certificate_ready
      ? 'You have finished. Your certificate is below.'
      : 'You have finished the distance. The certificate appears once your '
        + 'entry is paid for.';
    $('certLink').hidden = !entry.certificate_ready;
    $('certLink').href = '#certPanel';
  }
}

/* ---------- paying ---------- */

async function drawPayment() {
  const owes = (entry.amount_paise || 0) > 0;
  const settled = ['paid', 'waived'].includes(entry.payment_status);
  if (!owes) { $('payPanel').hidden = true; return; }

  let pay = {};
  try {
    pay = await fetch(`/api/registrations/${entry.id}/payment`)
      .then(r => r.ok ? r.json() : {});
  } catch { pay = {}; }

  const STATE = {
    unpaid: `${money(entry.amount_paise)} to pay.`,
    claimed: `You have told the organiser you sent ${money(entry.amount_paise)}`
             + ` (reference ${entry.payment_ref || ''}). They will confirm it.`,
    paid: `Paid — ${money(entry.amount_paise)} received.`,
    waived: 'The organiser has waived your entry fee.',
  };
  $('payState').textContent = STATE[entry.payment_status] || STATE.unpaid;

  if (settled) {
    // Nothing to do, so nothing to fill in. Leaving a live payment form on a
    // settled entry invites somebody to pay twice.
    $('qrBox').hidden = true;
    $('payApp').hidden = $('payCopy').hidden = $('payHow').hidden = true;
    $('payTo').textContent = '';
    $('payNote').textContent = '';
    $('payRef').hidden = $('paySend').hidden = true;
    document.querySelector('label[for="payRef"]').hidden = true;
    $('payPanel').hidden = false;
    return;
  }

  if (pay.qr_url) {
    $('qrImg').src = pay.qr_url;
    $('qrBox').hidden = false;
  }

  /* Three ways to pay, offered in the order that actually works on one phone.
     A QR image was the only way until somebody pointed out that you cannot
     scan a code on the screen you are holding -- which is every runner here,
     on the one phone they own. */
  if (pay.upi_id) {
    // A UPI intent link. Android hands it to whichever UPI app is installed;
    // on a desktop, and on iOS where the scheme is not always claimed,
    // nothing opens -- which is why copying the id and the QR both stay.
    const rupees = ((entry.amount_paise || 0) / 100).toFixed(2);
    const who = me.user.display_name || me.user.username;
    const params = new URLSearchParams({
      pa: pay.upi_id,
      pn: pay.upi_name || 'RaceTime',
      am: rupees,
      cu: 'INR',
      // Fill in the note for them. Organisers ask for a name in it so they can
      // find the payment, and somebody typing it themselves will forget.
      tn: `${who} ${code}`.slice(0, 50),
    });
    $('payApp').href = `upi://pay?${params.toString()}`;
    $('payApp').hidden = false;
    $('payCopy').hidden = false;
    $('payHow').textContent = 'The button opens your UPI app with the amount '
      + 'and the note already filled in. If nothing opens, copy the id and '
      + 'paste it into your app by hand.';
    $('payHow').hidden = false;
  } else {
    $('payApp').hidden = $('payCopy').hidden = $('payHow').hidden = true;
  }
  $('payCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(pay.upi_id);
      ok('UPI id copied.');
    } catch {
      // Clipboard access is refused in some browsers and over plain http.
      // Selecting it for them is the next best thing to copying it.
      const r = document.createRange();
      r.selectNodeContents($('payTo'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      ok('Copy the highlighted id.');
    }
  };
  $('payTo').innerHTML = pay.upi_id
    ? `Pay <strong>${money(entry.amount_paise)}</strong> to `
      + `<strong>${esc(pay.upi_id)}</strong>`
      + (pay.upi_name ? ` (${esc(pay.upi_name)})` : '')
    : `<strong>${money(entry.amount_paise)}</strong> to pay. The organiser has `
      + 'not added payment details yet — ask them before sending anything.';
  $('payNote').textContent = pay.payment_note || '';
  $('payRef').value = entry.payment_ref || '';
  $('payPanel').hidden = false;
}

$('paySend').onclick = e => withBusy(e.currentTarget, async () => {
  $('payErr').hidden = true;
  const ref = $('payRef').value.trim();
  if (ref.length < 3) {
    $('payErr').textContent = 'Put in the reference number your payment app gave you.';
    $('payErr').hidden = false;
    return;
  }
  const res = await fetch(`/api/registrations/${entry.id}/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment_ref: ref }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    $('payErr').textContent = typeof err.detail === 'string'
      ? err.detail : 'That could not be sent.';
    $('payErr').hidden = false;
    return;
  }
  entry = await res.json();
  ok('Thank you. The organiser will confirm it against their account.');
  await drawPayment();
  drawProgress();
});

/* ---------- logging a run ---------- */

let evidence = null;

$('runFile').onchange = async () => {
  const file = $('runFile').files[0];
  if (!file) { evidence = null; $('runFileNote').hidden = true; return; }
  // The same resize the other uploads use: a modern phone photo is bigger
  // than the host will accept at the edge, and the error it returns is not
  // one this app can rewrite.
  evidence = await fitImageForUpload(file, note => {
    $('runFileNote').textContent = note;
    $('runFileNote').hidden = false;
  });
};

$('runSend').onclick = e => withBusy(e.currentTarget, async () => {
  $('runErr').hidden = true;
  const km = Number($('runKm').value);
  const when = $('runDate').value;
  const secs = toSeconds($('runTime').value);
  if (!km || km <= 0) {
    $('runErr').textContent = 'How far did you go?';
    $('runErr').hidden = false; return;
  }
  if (!when) {
    $('runErr').textContent = 'Which day was this?';
    $('runErr').hidden = false; return;
  }
  if (Number.isNaN(secs)) {
    $('runErr').textContent = 'Write the time as 58:30, or 1:12:40 for over an hour.';
    $('runErr').hidden = false; return;
  }

  const form = new FormData();
  form.append('distance_km', String(km));
  form.append('ran_on', when);
  if (secs) form.append('duration_seconds', String(secs));
  form.append('source', $('runSource').value);
  if ($('runNote').value.trim()) form.append('note', $('runNote').value.trim());
  if (evidence) form.append('file', evidence, 'run.jpg');

  const res = await fetch(`/api/registrations/${entry.id}/runs`, {
    method: 'POST', body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    $('runErr').textContent = typeof err.detail === 'string'
      ? err.detail : 'That run could not be logged.';
    $('runErr').hidden = false;
    return;
  }
  const run = await res.json();
  $('runKm').value = $('runTime').value = $('runNote').value = '';
  $('runFile').value = '';
  evidence = null;
  $('runFileNote').hidden = true;
  ok(run.status === 'flagged'
    ? 'Logged. It counts, and the organiser will take a look at it.'
    : 'Logged. Well run.');
  await refresh();
});

/* ---------- the runs they have logged ---------- */

function drawRuns() {
  $('nRuns').textContent = runs.length || '';
  if (!runs.length) {
    $('runList').innerHTML =
      '<div class="empty"><div class="t">No runs yet</div>'
      + '<div class="h">Log the first one above. You can do the distance over '
      + 'as many runs as you like.</div></div>';
    $('runsPanel').hidden = false;
    return;
  }
  $('runList').innerHTML = runs.map(r => {
    const tag = r.status === 'rejected'
      ? '<span class="tag no">Not counted</span>'
      : r.status === 'flagged'
        ? '<span class="tag wait">Being looked at</span>'
        : '<span class="tag go">Counted</span>';
    const why = (r.flags || []).map(f => FLAG_WORDS[f] || f).join(', ');
    return `<article class="runrow">
      <div class="runmain">
        <div class="runkm">${r.distance_km} km</div>
        <div>
          <div class="runwhen">${esc(day(r.ran_on))}</div>
          <div class="note tight">${esc([
            r.duration_seconds ? pace(r) : 'no time given',
            r.source === 'treadmill' ? 'treadmill'
              : r.source === 'watch' ? 'watch' : null,
            r.note || null,
          ].filter(Boolean).join(' · '))}</div>
          ${why ? `<div class="note tight">Queried: ${esc(why)}</div>` : ''}
        </div>
      </div>
      <div class="runacts">
        ${tag}
        ${r.evidence_url
          ? `<a href="${esc(r.evidence_url)}" target="_blank"
                rel="noopener noreferrer">Screenshot</a>` : ''}
        <button class="danger" data-drop="${r.id}">Remove</button>
      </div>
    </article>`;
  }).join('');

  $('runList').querySelectorAll('[data-drop]').forEach(b => {
    b.onclick = async () => {
      const yes = await confirmDialog({
        title: 'Remove this run?',
        body: 'It comes off your total. You can log it again afterwards.',
        confirm: 'Remove',
      });
      if (!yes) return;
      const res = await fetch(`/api/runs/${b.dataset.drop}`, { method: 'DELETE' });
      if (!res.ok) { fail('That run could not be removed.'); return; }
      ok('Removed.');
      await refresh();
    };
  });
  $('runsPanel').hidden = false;
}

/* ---------- the certificate ---------- */

function buildCard() {
  const card = document.createElement('div');
  card.className = 'share-card' + (event_ && event_.photo_url ? '' : ' plain');
  card.style.setProperty('--card-h', CARD_H);
  if (event_ && event_.photo_url) {
    card.style.setProperty('--art', `url("${event_.photo_url}")`);
  }
  const window_ = [event_ && event_.starts_at, event_ && event_.ends_at]
    .filter(Boolean)
    .map(iso => new Date(iso).toLocaleDateString(undefined,
      { day: 'numeric', month: 'long' }))
    .join(' – ');

  card.innerHTML =
    `<div class="body">
       <div class="badge">Virtual race</div>
       <div class="name">${esc(me.user.display_name || me.user.username)}</div>
       <div class="session">${esc(event_ ? event_.name : '')}</div>
       <div class="big">${esc(String(entry.target_km))} km</div>
       <div class="meta">${esc([entry.race, window_].filter(Boolean)
         .join(' · '))}</div>
     </div>
     <div class="foot"><div class="who">RaceTime</div></div>`;

  const frame = $('cardFrame');
  frame.innerHTML = '';
  frame.style.setProperty('--card-h', CARD_H);
  frame.appendChild(card);
  $('certPanel').hidden = false;
  fit();
}

function fit() {
  const frame = $('cardFrame');
  const card = frame && frame.querySelector('.share-card');
  if (!card || !frame.clientWidth) return;
  card.style.transform = `scale(${frame.clientWidth / CARD_W})`;
}
addEventListener('resize', fit);

const render = () => renderCardPng(
  $('cardFrame').querySelector('.share-card'), html2canvas, CARD_W, CARD_H);
const fileName = () => cardFileName(
  code, me.user.display_name || me.user.username, 'virtual');

$('download').onclick = e => withBusy(e.currentTarget, async () => {
  try {
    const blob = await render();
    if (!blob) throw new Error('Could not render the certificate.');
    downloadBlob(blob, fileName());
    ok('Certificate saved to your device.');
  } catch (err) { fail(err.message); }
});

$('share').onclick = e => withBusy(e.currentTarget, async () => {
  try {
    const blob = await render();
    if (!blob) throw new Error('Could not render the certificate.');
    await shareOrDownload(blob, fileName(), event_ ? event_.name : 'RaceTime');
  } catch (err) { fail(err.message); }
});

/* ---------- putting it together ---------- */

async function refresh() {
  if (!await load()) return;
  drawProgress();
  drawRuns();
  await drawPayment();
  if (entry.certificate_ready) {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    buildCard();
  } else {
    $('certPanel').hidden = true;
  }
}

(async () => {
  if (!code) { problem('No race in the address.'); return; }
  try {
    me = await fetch('/api/auth/me').then(r => r.ok ? r.json() : null);
  } catch { me = null; }
  if (!me) {
    location.href = '/login.html?next='
      + encodeURIComponent('/virtual.html#' + code);
    return;
  }

  try {
    const all = await fetch('/api/events/upcoming').then(r => r.json());
    event_ = (Array.isArray(all) ? all : []).find(e => e.code === code) || null;
    if (!event_) {
      // A race whose window has closed drops off the upcoming list, and the
      // runner still needs their own page and their certificate.
      event_ = await fetch(`/api/events/${encodeURIComponent(code)}`)
        .then(r => r.ok ? r.json() : null);
    }
  } catch { event_ = null; }

  if (event_) {
    $('raceName').textContent = event_.name;
    document.title = event_.name + ' · RaceTime';
  }

  // Default the date to today: most runs are logged the day they happen, and
  // an empty date field on a phone is four taps.
  $('runDate').value = new Date().toISOString().slice(0, 10);
  $('runDate').max = new Date().toISOString().slice(0, 10);
  $('howPanel').hidden = false;

  await refresh();
  $('logPanel').hidden = !!(event_ && event_.ends_at
    && new Date(event_.ends_at) < new Date());
})();
