/* Finisher certificate.
   Deliberately built from the same results the public table is built from, so
   a certificate can never claim a time the results page disagrees with.

   The entry point is the runner's name, not the bib. Anyone coming back for a
   certificate weeks after the race has thrown the bib away.

   The primary output is a 1080x1350 share card, because this ends up in an
   Instagram story or a WhatsApp thread rather than a frame. The A4 sheet is
   still generated for anyone who wants to print it, but only the printer
   ever sees it. */
import QRCode from '/vendor/qrcode.esm.js';
import html2canvas from '/vendor/html2canvas.esm.js';
import { esc, ok, fail, withBusy } from '/js/ui.js';

const $ = id => document.getElementById(id);

const dur = s => {
  if (s == null) return '—';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

const ordinal = n => {
  if (n == null) return null;
  const t = n % 100;
  const suffix = (t >= 11 && t <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return n + suffix;
};

const MAX_ROWS = 40;
const CARD_W = 1080;
const CARD_H = 1350;

let data = null;      // results payload for the selected race
let ev = null;        // the event, with its branding
let current = null;   // the runner being shown
let photoUrl = null;  // a FileReader data URL, never sent anywhere

/* ---------- race picker ---------- */

async function loadEvents() {
  let events;
  try {
    // The full listing is admin-only; this page only needs names.
    events = await fetch('/api/events/public').then(r => r.json());
  } catch {
    $('event').innerHTML = '<option value="">Could not load races</option>';
    return;
  }
  if (!events.length) {
    $('event').innerHTML = '<option value="">No races yet</option>';
    return;
  }
  $('event').innerHTML =
    (events.length > 1 ? '<option value="">Choose a race…</option>' : '') +
    events.map(e => `<option value="${esc(e.code)}">${esc(e.name)}</option>`).join('');

  // Deep links win; otherwise a single race selects itself rather than making
  // someone pick from a list of one.
  const wanted = fromHash().code || (events.length === 1 ? events[0].code : '');
  if (wanted) {
    $('event').value = wanted;
    await selectEvent(wanted);
  }
}

async function selectEvent(code) {
  $('err').textContent = '';
  data = ev = null;
  $('list').innerHTML = '';
  $('count').textContent = '';
  if (!code) return;
  try {
    [ev, data] = await Promise.all([
      fetch(`/api/events/${encodeURIComponent(code)}`).then(r => r.json()),
      fetch(`/api/events/${encodeURIComponent(code)}/results`, { cache: 'no-store' }).then(r => r.json()),
    ]);
    if (ev.detail) throw new Error(ev.detail);
    if (data.detail) throw new Error(data.detail);
  } catch (e) {
    $('err').textContent = `Could not load that race (${e.message}).`;
    fail('Could not load that race.');
    data = ev = null;
    return;
  }
  renderList();

  // A deep link carrying a bib goes straight to the certificate.
  const { bib } = fromHash();
  if (bib) {
    const r = data.results.find(x => String(x.bib) === String(bib));
    if (r && r.status === 'finished') show(r);
  }
}

/* ---------- search ---------- */

function fromHash() {
  const [code, bib] = decodeURIComponent(location.hash.slice(1)).split('/');
  return { code: code || '', bib: bib || '' };
}

// Highlight the matched run of characters so it is obvious why a row matched.
function mark(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) +
    '</mark>' + esc(text.slice(i + q.length));
}

function renderList() {
  if (!data) return;
  const q = $('find').value.trim().toLowerCase();
  const matches = data.results.filter(r =>
    !q || r.name.toLowerCase().includes(q) || String(r.bib).toLowerCase().includes(q));

  const ul = $('list');
  ul.innerHTML = '';

  if (!matches.length) {
    $('count').textContent = '';
    ul.innerHTML = `<li><div class="empty">Nobody matches “${esc($('find').value.trim())}”.</div></li>`;
    return;
  }

  const shown = matches.slice(0, MAX_ROWS);
  $('count').textContent = matches.length > shown.length
    ? `${matches.length} runners match — showing the first ${shown.length}. Keep typing to narrow it down.`
    : `${matches.length} runner${matches.length === 1 ? '' : 's'}.`;

  const WHY = {
    on_course: 'still running',
    dnf: 'did not finish',
    not_started: 'no sightings',
  };

  for (const r of shown) {
    const li = document.createElement('li');
    const done = r.status === 'finished';
    const btn = document.createElement('button');
    btn.disabled = !done;
    // A non-finisher stays visible with the reason attached, so searching your
    // own name never just comes back empty and unexplained.
    btn.title = done ? 'Open certificate' : `No certificate: ${WHY[r.status] || 'no finish time'}`;
    btn.innerHTML =
      `<span class="b num">${mark(String(r.bib), q)}</span>` +
      `<span class="nm">${mark(r.name, q)}</span>` +
      (done
        ? `<span class="t">${dur(r.finish_seconds)}</span><span class="p">${ordinal(r.position) || ''}</span>`
        : `<span class="t" style="color:var(--muted)">${WHY[r.status] || '—'}</span><span class="p"></span>`);
    if (done) btn.onclick = () => show(r);
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

/* ---------- shared helpers ---------- */

function raceDistance(r) {
  // Everything distance-related has to come from the runner's own race. On a
  // combined 5K/10K event the event's first finish line belongs to whichever
  // race happens to sort first, which is not necessarily theirs.
  const myRace = (data.races || []).find(x => x.id === r.race_id);
  const finishCp = data.checkpoints.find(
    c => c.kind === 'finish' && (r.race_id == null || c.race_id === r.race_id));
  return (myRace && myRace.distance_km) || (finishCp && finishCp.distance_km) || 0;
}

function avgPace(r, km) {
  if (!km || !r.finish_seconds) return null;
  const s = r.finish_seconds / km;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} /km`;
}

function raceDate() {
  // The gun time is the real date. The tagline is only a fallback, since an
  // organiser may have written anything in it.
  if (ev.start_time) {
    return new Date(ev.start_time).toLocaleDateString(undefined, {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  }
  return ev.tagline || null;
}

/**
 * A placing only earns space on something someone will actually share.
 *
 * Top three, and never in the bottom half of the field -- "3rd of 4" is
 * technically a podium and obviously not an achievement. Everything else shows
 * nothing at all. The results page still carries the full placing for anyone
 * who wants to look it up.
 */
function rankBadge(r) {
  const mode = ev.badge_mode || 'placing';

  // Not every event is a competition. A school walk wants everyone to get the
  // same word, and some events want no badge at all.
  if (mode === 'none') return null;
  if (mode === 'text') return (ev.badge_text || '').trim() || null;

  const earned = (place, size) => place && place <= 3 && size && place <= size / 2;
  if (earned(r.position, r.field_size)) return `${ordinal(r.position)} overall`;
  if (earned(r.category_position, r.category_size) && r.category) {
    return `${ordinal(r.category_position)} in ${r.category}`;
  }
  return null;
}

/* ---------- the share card ---------- */

async function buildCard(r) {
  const km = raceDistance(r);
  const distance = km ? (Number.isInteger(km) ? km : km.toFixed(1)) + ' km' : null;
  const badge = rankBadge(r);
  const pace = avgPace(r, km);
  const line2 = [distance, raceDate()].filter(Boolean).join(' · ');

  const card = document.createElement('div');
  card.className = 'share-card';
  card.style.setProperty('--accent', ev.accent_color || '#f2c500');
  // Its own portrait artwork when there is one; otherwise the bib's, which is
  // what every event used before the two were separated.
  const art = ev.cert_artwork_url || ev.artwork_url;
  if (art) card.style.setProperty('--art', `url("${art}")`);

  card.innerHTML =
    `<div class="body">
       ${photoUrl ? `<div class="photo"><img src="${photoUrl}" alt=""></div>` : ''}
       ${badge ? `<div class="badge">${esc(badge)}</div>` : ''}
       <div class="name">${esc(r.name)}</div>
       <div class="time">${dur(r.finish_seconds)}</div>
       <div class="event">${esc(ev.name)}</div>
       ${line2 ? `<div class="meta">${esc(line2)}</div>` : ''}
     </div>
     <div class="foot">
       <div class="qr"></div>
       <div class="support">Bib ${esc(r.bib)}${pace ? `<br>${esc(pace)}` : ''}</div>
     </div>`;

  const frame = $('cardFrame');
  frame.innerHTML = '';
  frame.appendChild(card);
  fitCard();

  try {
    await QRCode.toCanvas(
      card.querySelector('.qr').appendChild(document.createElement('canvas')),
      `${location.origin}/results.html#${ev.code}`,
      { width: 104, margin: 1 });
  } catch {
    // A missing QR should not cost the runner their card.
    card.querySelector('.qr').remove();
  }
  return card;
}

/** Scale the 1080px card down to whatever width the frame actually has. */
function fitCard() {
  const frame = $('cardFrame');
  const card = frame && frame.querySelector('.share-card');
  if (!card || !frame.clientWidth) return;
  card.style.transform = `scale(${frame.clientWidth / CARD_W})`;
}
window.addEventListener('resize', fitCard);

// The frame has no width until its panel is shown, and buildCard runs before
// that. Watching the frame means the card is scaled the moment it has a size
// to be scaled against, instead of rendering at full 1080px and being clipped.
if (window.ResizeObserver) {
  new ResizeObserver(fitCard).observe($('cardFrame'));
}

/* ---------- runner photo, client-side only ---------- */

$('photo').onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { fail('That file is not an image.'); return; }
  const reader = new FileReader();
  // FileReader only. The bytes never leave the browser, and there is
  // deliberately no endpoint, column or table for them.
  reader.onload = () => {
    photoUrl = reader.result;
    $('removePhoto').hidden = false;
    $('photoLabel').textContent = 'Change photo';
    if (current) buildCard(current);
  };
  reader.onerror = () => fail('Could not read that image.');
  reader.readAsDataURL(file);
  e.target.value = '';
};

$('removePhoto').onclick = () => {
  photoUrl = null;
  $('removePhoto').hidden = true;
  $('photoLabel').textContent = 'Add your photo';
  if (current) buildCard(current);
};

/* ---------- export ---------- */

async function renderPng() {
  const card = $('cardFrame').querySelector('.share-card');
  if (!card) throw new Error('There is no card to save.');

  // Without this the capture can start before the webfonts have loaded, and
  // the type silently falls back to a default face.
  if (document.fonts && document.fonts.ready) await document.fonts.ready;

  // Capture at true size, then put the preview scaling back.
  const scaled = card.style.transform;
  card.style.transform = 'none';
  try {
    const canvas = await html2canvas(card, {
      width: CARD_W, height: CARD_H,
      windowWidth: CARD_W, windowHeight: CARD_H,
      scale: 1, backgroundColor: null, useCORS: true, logging: false,
    });
    return await new Promise(res => canvas.toBlob(res, 'image/png'));
  } finally {
    card.style.transform = scaled;
  }
}

function fileName() {
  return `${ev.code}-${current.bib}-${current.name}`
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.png';
}

async function saveImage() {
  const blob = await renderPng();
  if (!blob) throw new Error('Could not render the image.');
  const file = new File([blob], fileName(), { type: 'image/png' });

  // The share sheet is what people actually use on a phone; the download is
  // the desktop path.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: ev.name });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // they closed the sheet
      // Anything else falls through to a download.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
  ok('Image saved.');
}

$('save').onclick = e => withBusy(e.currentTarget, async () => {
  try { await saveImage(); } catch (err) { fail(err.message); }
});

/* ---------- open / close ---------- */

function show(r) {
  current = r;
  location.hash = `${ev.code}/${r.bib}`;
  // Unhide first: the card frame has no measurable width while its panel is
  // hidden, and the card has to be scaled against that width.
  $('finder').hidden = true;
  $('actions').hidden = false;
  buildCard(r);
  renderA4(r);            // still generated, but only the printer sees it
  window.scrollTo(0, 0);
}

function backToFinder() {
  current = null;
  photoUrl = null;
  $('removePhoto').hidden = true;
  $('photoLabel').textContent = 'Add your photo';
  $('cardFrame').innerHTML = '';
  $('sheet').hidden = true;
  $('actions').hidden = true;
  $('finder').hidden = false;
  location.hash = ev ? ev.code : '';
}

/* ---------- A4 certificate, print only ---------- */

async function renderA4(r) {
  const km = raceDistance(r);
  const finishCp = data.checkpoints.find(
    c => c.kind === 'finish' && (r.race_id == null || c.race_id === r.race_id));
  const distance = km ? (Number.isInteger(km) ? km : km.toFixed(1)) + ' KM' : null;
  const pace = avgPace(r, km);

  const stats = [
    ordinal(r.position) && { k: `Overall${r.race ? ' · ' + r.race : ''}`, v: ordinal(r.position) },
    r.category_position
      ? { k: r.category, v: `${ordinal(r.category_position)} of ${r.category_size}` }
      : (r.category && { k: 'Category', v: r.category }),
    r.gender_position && { k: r.gender, v: `${ordinal(r.gender_position)} of ${r.gender_size}` },
    distance && { k: 'Distance', v: distance },
    pace && { k: 'Avg pace', v: pace },
  ].filter(Boolean);

  const splits = r.splits.filter(s => s.checkpoint_id !== (finishCp && finishCp.id));

  const cert = document.createElement('div');
  cert.className = 'cert';
  cert.style.setProperty('--accent', ev.accent_color || '#f2c500');
  const a4Art = ev.cert_artwork_url || ev.artwork_url;
  if (a4Art) cert.style.setProperty('--art', `url("${a4Art}")`);

  cert.innerHTML =
    `<div class="inner">
       <div class="eyebrow">Finisher</div>
       <div class="race">${esc(ev.name)}</div>
       ${ev.tagline ? `<div class="tagline">${esc(ev.tagline)}</div>` : ''}
       <div class="rule"></div>
       <div class="runner">${esc(r.name)}</div>
       <div class="cat">Bib ${esc(r.bib)}${r.category ? ' · ' + esc(r.category) : ''}</div>

       <div class="timelabel" style="margin-top:auto">Finish time</div>
       <div class="time" style="margin-top:0">${dur(r.finish_seconds)}</div>

       <div class="stats">
         ${stats.map(s => `<div class="stat"><div class="v">${esc(s.v)}</div><div class="k">${esc(s.k)}</div></div>`).join('')}
       </div>

       ${splits.length ? `<div class="splits">${splits.map(s =>
         `<div class="r"><span class="cp">${esc(s.checkpoint)}</span>` +
         `<span class="n">${s.distance_km} km</span>` +
         `<span class="n">${dur(s.elapsed_seconds)}</span></div>`).join('')}</div>` : ''}
     </div>
     <div class="foot">
       <div class="qr"></div>
       <div>Verify this result at<br>${esc(location.host)}/results.html#${esc(ev.code)}</div>
     </div>`;

  const sheet = $('sheet');
  sheet.innerHTML = '';
  sheet.appendChild(cert);
  sheet.hidden = false;

  try {
    await QRCode.toCanvas(
      cert.querySelector('.qr').appendChild(document.createElement('canvas')),
      `${location.origin}/results.html#${ev.code}`,
      { width: 62, margin: 1 });
  } catch {
    cert.querySelector('.qr').remove();
  }
}

/* ---------- wiring ---------- */

$('event').onchange = e => selectEvent(e.target.value);
$('find').oninput = renderList;
$('back').onclick = backToFinder;
$('print').onclick = () => window.print();

loadEvents();
