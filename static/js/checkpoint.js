import { queue, makeSyncer, measureClockOffset, correctedNow, uuid } from '/js/store.js';
import { confirmDialog } from '/js/ui.js';

const $ = id => document.getElementById(id);

const SETTINGS = 'racetime.checkpoint';
// The camera decodes the same QR many times a second while it stays in frame.
// This window turns that burst into one sighting. It is a capture-level guard
// only -- the server still keeps every read it is sent, and timing takes the
// earliest per bib per checkpoint.
const REPEAT_WINDOW_MS = 8000;

let cfg = JSON.parse(localStorage.getItem(SETTINGS) || 'null');
let participants = new Map();
let lastSeen = new Map();
let syncer = null;
let scanner = null;
let scanned = 0;
let deviceId = localStorage.getItem('racetime.device') || uuid();
localStorage.setItem('racetime.device', deviceId);

/* ---------- setup ----------
   Picking from lists rather than typing a code: a volunteer standing at a
   junction in the cold should not have to spell an event code correctly, and
   a typo there is silent -- it just looks like the event does not exist. */

let loadedEvent = null;

/** Fill the race-day dropdown. Falls back to typing a code if the list cannot
 *  be fetched, so arriving with a flaky connection is not a dead end. */
async function loadEventList() {
  try {
    const events = await fetch('/api/events/public').then(r => r.json());
    if (!Array.isArray(events) || !events.length) throw new Error('none');
    $('event').innerHTML =
      (events.length > 1 ? '<option value="">Choose the race day…</option>' : '') +
      events.map(e => `<option value="${escAttr(e.code)}">${escText(e.name)}</option>`).join('');
    if (events.length === 1) await chooseEvent(events[0].code);
  } catch {
    $('event').parentElement.querySelector('label[for="event"]').hidden = true;
    $('event').hidden = true;
    $('manualEvent').hidden = false;
  }
}

const escText = t => String(t ?? '').replace(/[&<>]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = t => escText(t).replace(/"/g, '&quot;');

async function chooseEvent(code) {
  $('setupErr').textContent = '';
  $('pick').hidden = true;
  loadedEvent = null;
  if (!code) return;
  try {
    const ev = await (await fetch(`/api/events/${encodeURIComponent(code)}`)).json();
    if (ev.detail) throw new Error(ev.detail);
    if (!ev.checkpoints.length) {
      $('setupErr').textContent =
        'This race day has no checkpoints yet. Add them in Race admin first.';
      return;
    }
    loadedEvent = ev;

    // A race picker only earns its place when there is a choice to make.
    const races = ev.races || [];
    if (races.length > 1) {
      $('race').innerHTML =
        '<option value="">All races</option>' +
        races.map(r => `<option value="${r.id}">${escText(r.name)}` +
          `${r.distance_km ? ' — ' + r.distance_km + ' km' : ''}</option>`).join('');
      $('raceWrap').hidden = false;
    } else {
      $('raceWrap').hidden = true;
      $('race').innerHTML = '';
    }

    fillCheckpoints();
    $('pick').hidden = false;
  } catch {
    $('setupErr').textContent =
      'Could not load that race day. Check your connection and try again.';
  }
}

/** Show the checkpoints of the chosen race, or all of them. */
function fillCheckpoints() {
  if (!loadedEvent) return;
  const wanted = $('raceWrap').hidden ? '' : $('race').value;
  const named = new Map((loadedEvent.races || []).map(r => [r.id, r.name]));
  const many = (loadedEvent.races || []).length > 1;

  const list = loadedEvent.checkpoints.filter(
    c => !wanted || String(c.race_id) === wanted);

  const sel = $('cp');
  sel.innerHTML = list.map(c => {
    const race = many && named.get(c.race_id) ? ` · ${named.get(c.race_id)}` : '';
    return `<option value="${c.id}">${escText(c.name)} — ${c.distance_km} km${escText(race)}</option>`;
  }).join('');

  if (!list.length) {
    sel.innerHTML = '<option value="">No checkpoints in this race</option>';
  }
  $('go').disabled = !list.length;
}

$('event').onchange = e => chooseEvent(e.target.value);
$('race').onchange = fillCheckpoints;

$('go').onclick = () => {
  if (!loadedEvent) return;
  const cp = loadedEvent.checkpoints.find(c => String(c.id) === $('cp').value);
  if (cp) begin(loadedEvent, cp);
};

// The typed-code fallback, used only when the list could not be fetched.
$('load').onclick = () => chooseEvent($('code').value.trim());

loadEventList();

async function begin(ev, cp) {
  $('clockNote').textContent = 'Checking this phone against the race clock…';
  let offset = 0, rtt = 0;
  try {
    const m = await measureClockOffset();
    offset = m.offset; rtt = m.rtt;
  } catch (e) { /* offline setup: carry on with no correction */ }

  cfg = { code: ev.code, cpId: cp.id, cpName: cp.name, offset };
  localStorage.setItem(SETTINGS, JSON.stringify(cfg));
  await loadParticipants();
  startCapture();
  if (Math.abs(offset) > 2000) {
    flash('bad', '⏱', 'Clock corrected', `This phone was ${(offset / 1000).toFixed(1)}s out`);
  }
}

async function loadParticipants() {
  try {
    const list = await (await fetch(`/api/events/${cfg.code}/participants`)).json();
    participants = new Map(list.map(p => [p.bib, p.name]));
    localStorage.setItem('racetime.roster.' + cfg.code, JSON.stringify(list));
  } catch (e) {
    // Offline restart at the checkpoint: fall back to the roster cached at setup.
    const cached = localStorage.getItem('racetime.roster.' + cfg.code);
    if (cached) participants = new Map(JSON.parse(cached).map(p => [p.bib, p.name]));
  }
}

/* ---------- capture ---------- */

function startCapture() {
  $('setup').hidden = true;
  $('capture').hidden = false;
  $('cpName').textContent = cfg.cpName;

  syncer = makeSyncer(cfg.code, ({ state, pending }) => {
    const el = $('status');
    el.className = 'pill ' + state;
    el.textContent = state === 'synced' ? 'all sent'
      : state === 'offline' ? `offline · ${pending}`
      : `sending · ${pending}`;
  });

  scanner = new Html5Qrcode('reader', { verbose: false });
  scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 240, height: 240 } },
    text => record(parseBib(text), 'qr'),
    () => {}
  ).catch(() => {
    $('reader').innerHTML =
      '<div class="empty">No camera available. Type bib numbers below — ' +
      'they queue and sync exactly the same way.</div>';
  });
}

// Bibs are printed as RT|<event>|<bib>, but a plain number in the QR works too,
// so you can reuse bibs printed by anyone else.
function parseBib(text) {
  const t = String(text).trim();
  if (t.startsWith('RT|')) return t.split('|')[2] || '';
  return t;
}

$('manualAdd').onclick = submitManual;
$('manual').addEventListener('keydown', e => { if (e.key === 'Enter') submitManual(); });

function submitManual() {
  const bib = $('manual').value.trim();
  if (bib) record(bib, 'manual');
  $('manual').value = '';
}

async function record(bib, source) {
  if (!bib) return;
  const now = Date.now();
  if (source === 'qr' && now - (lastSeen.get(bib) || 0) < REPEAT_WINDOW_MS) {
    flash('dupe', bib, participants.get(bib) || '', 'already recorded');
    return;
  }
  lastSeen.set(bib, now);

  const observed = correctedNow(cfg.offset);
  await queue.put({
    read_id: uuid(),
    checkpoint_id: cfg.cpId,
    bib,
    observed_at: observed.toISOString(),
    device_time: new Date().toISOString(),
    clock_offset_ms: cfg.offset,
    source,
    device_id: deviceId,
  });

  const known = participants.has(bib);
  flash(known ? 'ok' : 'bad', bib,
        known ? participants.get(bib) : 'Not on the start list',
        known ? 'recorded' : 'recorded anyway — check afterwards');
  addRecent(bib, observed, known);
  if (navigator.vibrate) navigator.vibrate(known ? 40 : [40, 60, 40]);
  syncer && syncer.flush();
}

let flashTimer = null;
function flash(kind, bib, who, what) {
  const el = $('flash');
  el.className = 'flash' + (kind === 'ok' ? '' : ' ' + kind);
  $('flashBib').textContent = bib;
  $('flashWho').textContent = who || '';
  $('flashWhat').textContent = what || '';
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 900);
}

function addRecent(bib, at, known) {
  const li = document.createElement('li');
  li.innerHTML =
    `<span class="b">${bib}</span>` +
    `<span>${known ? (participants.get(bib) || '') : '<span class="tag stop">unknown</span>'}</span>` +
    `<span class="t">${at.toLocaleTimeString()}</span>`;
  $('recent').prepend(li);
  // The list is a receipt, not a log: it is capped so it can never grow into
  // the viewfinder, and the running count carries the total instead.
  while ($('recent').children.length > 40) $('recent').lastChild.remove();
  scanned += 1;
  $('scanCount').textContent = scanned;
}

/* ---------- switching checkpoint ----------
   The saved choice is what makes a locked phone, a closed tab or a dead zone
   cost nothing: reopening resumes scanning instead of asking again, and a
   volunteer cannot quietly re-pick the wrong checkpoint halfway through a
   race. But being unable to change it at all is its own trap -- one phone
   covering two points, or a checkpoint picked wrongly at setup. Hence an
   explicit, confirmed way out rather than clearing site data. */

$('changeCp').onclick = async () => {
  // queue.all() is the whole outbox for this device; it is only ever this
  // phone's own unsent scans.
  const pending = await queue.all().then(q => q.length).catch(() => 0);
  if (!await confirmDialog({
    title: 'Switch to a different checkpoint?',
    body: (pending
      ? `${pending} scan${pending === 1 ? '' : 's'} on this phone have not reached the server yet. `
        + 'They are safe -- each one already carries the checkpoint it was taken at, '
        + 'and they will still sync. '
      : '')
      + 'Scans taken from now on will be recorded against the new checkpoint.',
    confirm: 'Choose another',
    danger: false,
  })) return;

  // Release the camera before returning to setup, or the next start fails on
  // a device that allows only one active stream.
  if (scanner) {
    try { await scanner.stop(); } catch { /* it may already be stopped */ }
    try { scanner.clear(); } catch { /* nothing to clear */ }
    scanner = null;
  }

  localStorage.removeItem(SETTINGS);
  cfg = null;
  $('capture').hidden = true;
  $('setup').hidden = false;
  $('pick').hidden = true;
  $('setupErr').textContent = '';
};

/* Resume straight into capture if this phone was already set up -- a volunteer
   who accidentally closes the tab mid-race should not have to be talked through
   setup again over the phone. */
if (cfg) {
  loadParticipants().then(startCapture);
}
