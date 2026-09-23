/* Finisher certificate.
   Deliberately built from the same results the public table is built from, so
   a certificate can never claim a time the results page disagrees with.

   The entry point is the runner's name, not the bib. Anyone coming back for a
   certificate weeks after the race has thrown the bib away. */
import QRCode from '/vendor/qrcode.esm.js';

const $ = id => document.getElementById(id);

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
let data = null;   // results payload for the selected race
let ev = null;     // the event, with its branding

/* ---------- race picker ---------- */

async function loadEvents() {
  let events;
  try {
    events = await fetch('/api/events').then(r => r.json());
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

/* ---------- certificate ---------- */

function show(r) {
  location.hash = `${ev.code}/${r.bib}`;
  render(r);
  $('finder').hidden = true;
  window.scrollTo(0, 0);
}

function backToFinder() {
  $('sheet').hidden = true;
  $('actions').hidden = true;
  $('finder').hidden = false;
  location.hash = ev ? ev.code : '';
}

async function render(r) {
  // Everything distance-related has to come from the runner's own race. On a
  // combined 5K/10K event the event's first finish line belongs to whichever
  // race happens to sort first, which is not necessarily theirs.
  const myRace = (data.races || []).find(x => x.id === r.race_id);
  const finishCp = data.checkpoints.find(
    c => c.kind === 'finish' && (r.race_id == null || c.race_id === r.race_id));

  const km = (myRace && myRace.distance_km) || (finishCp && finishCp.distance_km) || 0;
  const distance = km
    ? (Number.isInteger(km) ? km : km.toFixed(1)) + ' KM'
    : null;

  // Average pace over the full distance, which is the stat runners quote.
  let pace = null;
  if (km && r.finish_seconds) {
    const secPerKm = r.finish_seconds / km;
    pace = `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, '0')}/km`;
  }

  const stats = [
    ordinal(r.position) && { k: `Overall${r.race ? ' · ' + r.race : ''}`, v: ordinal(r.position) },
    // The category placing is the one most runners are proudest of, so it
    // earns a slot of its own rather than just naming the category.
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
  if (ev.artwork_url) cert.style.setProperty('--art', `url("${ev.artwork_url}")`);

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
  $('actions').hidden = false;
  $('hint').textContent = 'Choose "Save as PDF" in the print dialog for a framing-quality copy.';

  try {
    await QRCode.toCanvas(
      cert.querySelector('.qr').appendChild(document.createElement('canvas')),
      `${location.origin}/results.html#${ev.code}`,
      { width: 62, margin: 1 });
  } catch {
    // A missing QR should not cost the runner their certificate.
    cert.querySelector('.qr').remove();
  }
}

/* ---------- wiring ---------- */

$('event').onchange = e => selectEvent(e.target.value);
$('find').oninput = renderList;
$('back').onclick = backToFinder;
$('print').onclick = () => window.print();

loadEvents();
