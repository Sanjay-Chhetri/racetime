import { queue, makeSyncer, measureClockOffset, correctedNow, uuid } from '/js/store.js';

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
let deviceId = localStorage.getItem('racetime.device') || uuid();
localStorage.setItem('racetime.device', deviceId);

/* ---------- setup ---------- */

$('load').onclick = async () => {
  const code = $('code').value.trim();
  $('setupErr').textContent = '';
  if (!code) return;
  try {
    const ev = await (await fetch(`/api/events/${code}`)).json();
    if (ev.detail) throw new Error(ev.detail);
    const sel = $('cp');
    sel.innerHTML = '';
    ev.checkpoints.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.name} — ${c.distance_km} km`;
      sel.appendChild(o);
    });
    if (!ev.checkpoints.length) {
      $('setupErr').textContent = 'This event has no checkpoints yet. Add them in the race admin first.';
      return;
    }
    $('pick').hidden = false;
    $('go').onclick = () => begin(ev, ev.checkpoints.find(c => c.id == sel.value));
  } catch (e) {
    $('setupErr').textContent = 'Could not load that event. Check the code and your connection.';
  }
};

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

  const scanner = new Html5Qrcode('reader', { verbose: false });
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
  while ($('recent').children.length > 40) $('recent').lastChild.remove();
}

/* Resume straight into capture if this phone was already set up -- a volunteer
   who accidentally closes the tab mid-race should not have to be talked through
   setup again over the phone. */
if (cfg) {
  loadParticipants().then(startCapture);
}
