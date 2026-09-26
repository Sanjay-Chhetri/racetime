import QRCode from '/vendor/qrcode.esm.js';
// Runner names and race names reach the bib and the certificate as markup, and
// they arrive from a pasted list or an uploaded CSV, so `esc` is shared.
import { esc, ok, fail, confirmDialog, promptDialog, withBusy, fitImageForUpload,
         skeletonRows, emptyState } from '/js/ui.js';

const $ = id => document.getElementById(id);
let ev = null;

/* ---------- admin token ----------
   A shared secret, held in localStorage and sent on every write. The server
   decides whether it is needed; if ADMIN_TOKEN is unset there the app simply
   never sees a 401 and never asks. */

const TOKEN_KEY = 'racetime.adminToken';
let adminToken = localStorage.getItem(TOKEN_KEY) || '';

function setToken(t) {
  adminToken = t || '';
  if (adminToken) localStorage.setItem(TOKEN_KEY, adminToken);
  else localStorage.removeItem(TOKEN_KEY);
  renderLock();
}

async function tokenWorks(t) {
  const res = await fetch('/api/admin/check', { headers: { 'X-Admin-Token': t } });
  return res.ok;
}

/** Ask for the token, checking it before storing so a typo is caught here
 *  rather than on whatever the operator tries to do next. */
async function askForToken(reason) {
  for (;;) {
    const entered = await promptDialog({
      title: 'Admin token',
      body: reason || 'This server is protected. Enter the admin token to make changes.',
      placeholder: 'paste the token',
      confirm: 'Unlock',
    });
    if (entered === null) return false;          // cancelled
    if (await tokenWorks(entered)) { setToken(entered); ok('Unlocked.'); return true; }
    reason = 'That token was not accepted. Try again.';
  }
}

const api = async (path, opts) => {
  opts = { ...(opts || {}) };
  opts.headers = { ...(opts.headers || {}) };
  if (adminToken) opts.headers['X-Admin-Token'] = adminToken;

  let res = await fetch('/api' + path, opts);

  // A 401 means the token is missing, wrong, or was rotated on the server.
  // Clear it and ask once, then replay the request so the operator does not
  // lose what they were doing.
  if (res.status === 401) {
    setToken('');
    const unlocked = await askForToken('This server needs an admin token.');
    if (!unlocked) throw new Error('Admin token required.');
    opts.headers['X-Admin-Token'] = adminToken;
    res = await fetch('/api' + path, opts);
  }

  if (res.status === 204) return null;

  // A failing request does not always answer in JSON -- a crash, a proxy or a
  // gateway timeout replies in plain text or HTML. Parsing blindly turned
  // those into "Unexpected token 'I'", which told the operator nothing about
  // what had actually gone wrong.
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

  if (!res.ok) {
    const detail = body && body.detail;
    // A 413 is usually the host rejecting the body at the edge, before the app
    // sees it, so it answers in plain text and there is no detail to show.
    // "The server returned 413" told the operator nothing they could act on.
    if (res.status === 413 && !detail) {
      throw new Error('That file is too large to upload. Save it at a smaller ' +
                      'size, or pick a smaller image.');
    }
    throw new Error(
      typeof detail === 'string' ? detail
      : Array.isArray(detail) ? detail.map(d => d.msg || d).join('; ')
      : `The server returned ${res.status}${res.statusText ? ' ' + res.statusText : ''}.`);
  }
  return body;
};

const json = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const fmtTime = iso => iso ? new Date(iso).toLocaleString() : 'not started';

/* ---------- lock indicator ---------- */

let serverProtected = false;

function renderLock() {
  const b = $('lock');
  if (!serverProtected) { b.hidden = true; return; }
  b.hidden = false;
  const unlocked = Boolean(adminToken);
  b.className = 'lockbtn ' + (unlocked ? 'open' : 'shut');
  b.textContent = unlocked ? 'unlocked' : 'locked';
  b.title = unlocked
    ? 'This browser can make changes. Click to lock it again.'
    : 'Read-only. Click to enter the admin token.';
}

$('lock').onclick = async () => {
  if (adminToken) { setToken(''); ok('Locked. This browser can no longer make changes.'); }
  else await askForToken();
};

/** Ask the server whether it is protected at all, so a laptop running with no
 *  ADMIN_TOKEN never sees a lock it does not need. */
(async () => {
  try {
    const res = await fetch('/api/admin/check',
      adminToken ? { headers: { 'X-Admin-Token': adminToken } } : undefined);
    if (res.status === 401) { serverProtected = true; setToken(''); }
    else {
      const body = await res.json().catch(() => ({}));
      serverProtected = Boolean(body.protected);
    }
  } catch { /* offline: leave the lock hidden rather than guess */ }
  renderLock();
})();

/* ---------- open / create ---------- */

$('open').onclick = () => load($('code').value.trim());

// Enter should open the race. Every other field in this app submits on Enter;
// this one did not, so the only way through was to reach for the mouse.
$('code').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); load($('code').value.trim()); }
});

/* ---------- race picker ----------
   Typing a code from memory is fine once. By the third event of the season
   nobody remembers whether it was kpg10k or kpg-10k, and a wrong code just
   reports that the event does not exist. */

async function loadEventPicker(selected) {
  const sel = $('pickEvent');
  try {
    // The full listing is admin-only; a picker only needs codes and names, so
    // this works whether or not the browser is unlocked.
    const events = await fetch('/api/events/public').then(r => r.json());
    if (!Array.isArray(events) || !events.length) {
      sel.innerHTML = '<option value="">No races yet — create one below</option>';
      return;
    }
    sel.innerHTML = '<option value="">Choose a race…</option>' +
      events.map(e =>
        `<option value="${esc(e.code)}">${esc(e.name)} — ${esc(e.code)}</option>`).join('');
    if (selected) sel.value = selected;
  } catch {
    sel.innerHTML = '<option value="">Could not load the list</option>';
  }
}

$('pickEvent').onchange = e => { if (e.target.value) load(e.target.value); };

$('create').onclick = e => withBusy(e.currentTarget, async () => {
  $('err').textContent = '';
  try {
    const created = await api('/events', json('POST', {
      code: $('newCode').value.trim(), name: $('newName').value.trim(),
    }));
    ok(`Created “${created.name}”.`);
    await loadEventPicker(created.code);
    load(created.code);
  } catch (err) { $('err').textContent = err.message; }
});

/* ---------- tabs ----------

   Everything used to be one page: six panels, 16,000px of scroll, with Runners
   -- the thing touched most -- below three sections that are set once and
   forgotten. One panel shows at a time now, and the open tab lives in the
   address bar after the code (#siliguri10k/runners) so a reload comes back to
   where you were and a link can point at a section. */

const TABS = ['runners', 'races', 'checkpoints', 'artwork', 'reads'];
let tab = 'runners';

function showTab(name, { push = true } = {}) {
  if (!TABS.includes(name)) name = TABS[0];
  tab = name;
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;       // one stop in the tab order, arrows do the rest
  });
  document.querySelectorAll('.tabpanel').forEach(s => {
    s.hidden = s.dataset.tab !== name;
  });
  if (push && ev) location.hash = `${ev.code}/${name}`;

  // Reads are fetched only when asked for. Loading a few thousand rows on
  // every open made the page slow to appear for something rarely looked at.
  if (name === 'reads' && !readsLoaded) loadReads();
  // The bib preview measures its container, which is zero-wide while hidden.
  if (name === 'artwork') renderPreview();
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.onclick = () => showTab(btn.dataset.tab);
});

$('tabs').addEventListener('keydown', e => {
  const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
  if (!(e.key in keys)) return;
  e.preventDefault();
  const step = keys[e.key];
  const i = TABS.indexOf(tab);
  const next = step === 'first' ? 0
    : step === 'last' ? TABS.length - 1
    : (i + step + TABS.length) % TABS.length;
  showTab(TABS[next]);
  $('tab-' + TABS[next]).focus();
});

/** "siliguri10k/runners" -> { code, tab } */
function parseHash() {
  const [code, wanted] = location.hash.slice(1).split('/');
  return { code, tab: TABS.includes(wanted) ? wanted : null };
}

$('switchEvent').onclick = () => {
  ev = null;
  $('event').hidden = true;
  $('chooser').hidden = false;
  location.hash = '';
  $('pickEvent').value = '';
  $('pickEvent').focus();
};

async function load(code, wantTab) {
  if (!code) return;
  $('err').textContent = '';
  try {
    ev = await api('/events/' + code);
  } catch (e) { $('err').textContent = e.message; return; }
  if ($('pickEvent').options.length > 1) $('pickEvent').value = code;
  $('code').value = code;
  // With a race open the chooser is just a lid on the page; "switch race" in
  // the event bar brings it back.
  $('chooser').hidden = true;
  $('event').hidden = false;
  $('evName').textContent = ev.name;
  $('startTime').textContent = fmtTime(ev.start_time);
  $('accent').value = ev.accent_color || '#f2c500';
  $('tagline').value = ev.tagline || '';
  $('bibStyle').value = ev.bib_style || 'full';
  $('badgeMode').value = ev.badge_mode || 'placing';
  $('badgeText').value = ev.badge_text || '';
  $('certFit').value = ev.cert_fit || 'cover';
  syncBadgeFields();
  renderRaces();
  renderCheckpoints();
  loadRoster();
  readsLoaded = false;
  $('nReads').textContent = '';
  showTab(wantTab || tab);
}

/* ---------- start ---------- */

$('startNow').onclick = async e => {
  if (ev.start_time && !await confirmDialog({
    title: 'Replace the start time?',
    body: `This race was already started at ${fmtTime(ev.start_time)}. `
      + 'Replacing it re-times every runner against the new gun.',
    confirm: 'Replace it',
  })) return;
  await withBusy(e.currentTarget, async () => {
    try {
      ev = await api(`/events/${ev.code}/start`, { method: 'POST' });
      $('startTime').textContent = fmtTime(ev.start_time);
      ok('Gun fired. Timing has started.');
    } catch (err) { fail(err.message); }
  });
};

$('openResults').onclick = () => open('/results.html#' + ev.code, '_blank');

/* ---------- races ---------- */

const raceName = id => {
  const r = (ev.races || []).find(x => x.id === id);
  return r ? r.name : null;
};

function renderRaces() {
  $('nRaces').textContent = ev.races.length || '';
  const tb = $('raceList');
  tb.innerHTML = '';
  if (!ev.races.length) {
    tb.innerHTML = '<tr><td class="empty">No races yet. Add one before checkpoints or runners.</td></tr>';
  } else {
    ev.races.forEach(r => {
      const tr = document.createElement('tr');
      const entered = 0; // filled in by loadRoster once the start list is known
      tr.innerHTML =
        `<td class="num">${r.sequence}</td><td>${esc(r.name)}</td>` +
        `<td class="num">${r.distance_km} km</td>` +
        `<td class="note">${r.start_time ? 'starts ' + fmtTime(r.start_time) : 'event gun'}</td>` +
        `<td class="num" data-count="${r.id}">${entered || ''}</td>` +
        `<td class="num"><button data-race="${r.id}" class="quiet danger">Remove</button></td>`;
      tb.appendChild(tr);
    });
    tb.querySelectorAll('button[data-race]').forEach(b => {
      b.onclick = async () => {
        const r = ev.races.find(x => String(x.id) === b.dataset.race);
        if (!await confirmDialog({
          title: `Remove the ${r ? r.name : ''} race?`,
          body: 'Its checkpoints are deleted with it. Reads already taken are kept.',
          confirm: 'Remove race',
        })) return;
        try {
          await api('/races/' + b.dataset.race, { method: 'DELETE' });
          ok('Race removed.');
          load(ev.code);
        } catch (e) { fail(e.message); }
      };
    });
  }

  // Both pickers offer the same list, so a checkpoint and a start list can
  // never drift onto different races by accident.
  const opts = ev.races.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  for (const id of ['cpRace', 'pasteRace', 'pRace']) {
    const sel = $(id);
    const keep = sel.value;
    sel.innerHTML = opts || '<option value="">Add a race first</option>';
    if (keep) sel.value = keep;
  }
}

$('rcAdd').onclick = e => withBusy(e.currentTarget, async () => {
  const name = $('rcName').value.trim();
  if (!name) { fail('Give the race a name, like 10K.'); $('rcName').focus(); return; }
  try {
    await api(`/events/${ev.code}/races`, json('POST', {
      name,
      distance_km: parseFloat($('rcKm').value) || 0,
      sequence: parseInt($('rcSeq').value) || 0,
    }));
    $('rcName').value = '';
    ok(`Added the ${name} race.`);
    load(ev.code);
  } catch (err) { fail(err.message); }
});

/* ---------- checkpoints ---------- */

function renderCheckpoints() {
  $('nCheckpoints').textContent = ev.checkpoints.length || '';
  const tb = $('cpList');
  tb.innerHTML = '';
  if (!ev.checkpoints.length) {
    tb.innerHTML = '<tr><td class="empty">No checkpoints yet. Add the finish line first.</td></tr>';
    return;
  }
  const many = ev.races.length > 1;
  ev.checkpoints.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="num">${c.sequence}</td><td>${esc(c.name)}` +
      `${many && raceName(c.race_id) ? ` <span class="tag">${esc(raceName(c.race_id))}</span>` : ''}</td>` +
      `<td class="num">${c.distance_km} km</td>` +
      `<td><span class="tag ${c.kind === 'finish' ? 'go' : ''}">${c.kind}</span></td>` +
      `<td class="num"><button data-cp="${c.id}" class="quiet danger">Remove</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('button[data-cp]').forEach(b => {
    b.onclick = async () => {
      const c = ev.checkpoints.find(x => String(x.id) === b.dataset.cp);
      if (!await confirmDialog({
        title: `Remove “${c ? c.name : 'this checkpoint'}”?`,
        body: 'Reads taken there stop counting towards splits and finishes. '
          + 'The reads themselves are kept.',
        confirm: 'Remove checkpoint',
      })) return;
      try {
        await api('/checkpoints/' + b.dataset.cp, { method: 'DELETE' });
        ok('Checkpoint removed.');
        load(ev.code);
      } catch (e) { fail(e.message); }
    };
  });
}

// Validation belongs next to the fields that caused it, not in a toast that
// floats away from the form you are still looking at.
function cpError(msg) {
  const el = $('cpErr');
  el.textContent = msg || '';
  el.hidden = !msg;
}

$('cpAdd').onclick = e => withBusy(e.currentTarget, async () => {
  cpError('');
  const name = $('cpName').value.trim();
  if (!name) { cpError('Give the checkpoint a name.'); $('cpName').focus(); return; }
  try {
    await api(`/events/${ev.code}/checkpoints`, json('POST', {
      name,
      distance_km: parseFloat($('cpKm').value) || 0,
      sequence: parseInt($('cpSeq').value) || 0,
      kind: $('cpKind').value,
      race_id: Number($('cpRace').value) || null,
    }));
    $('cpName').value = '';
    ok(`Added “${name}”.`);
    load(ev.code);
  } catch (err) {
    cpError(err.message);
    $('cpSeq').focus();
    $('cpSeq').select();
  }
});

// Clear the message as soon as the operator changes the thing it complained
// about, so a stale error never sits under a form that is now valid.
for (const id of ['cpSeq', 'cpRace', 'cpName']) {
  $(id).addEventListener('input', () => cpError(''));
}

/* ---------- roster ---------- */

let roster = [];

async function loadRoster() {
  roster = await api(`/events/${ev.code}/participants`);
  $('nRunners').textContent = roster.length || '';
  $('rosterCount').textContent = roster.length
    ? `${roster.length} runner${roster.length === 1 ? '' : 's'} entered.`
    : 'No runners yet.';

  renderRoster();
  suggestNextBib();

  // Offer back whatever has already been typed, so "Veteran" does not quietly
  // become "Vetran" and split a category into two divisions.
  fillDatalist('catList', roster.map(p => p.category));
  fillDatalist('genList', ['Men', 'Women', ...roster.map(p => p.gender)]);

  // Per-race entry counts, so it is obvious at a glance if a whole distance
  // was imported against the wrong race.
  for (const r of ev.races || []) {
    const cell = document.querySelector(`[data-count="${r.id}"]`);
    const n = roster.filter(p => p.race_id === r.id).length;
    if (cell) cell.textContent = n ? `${n} entered` : '';
  }

  // Once real runners exist the preview should show one of them, not the
  // placeholder it fell back to while the roster was still loading.
  renderPreview();
}

function fillDatalist(id, values) {
  const seen = [...new Set(values.filter(Boolean).map(v => v.trim()))].sort();
  $(id).innerHTML = seen.map(v => `<option value="${esc(v)}">`).join('');
}

// The start list is the one place a typo hides until race day, so it is shown
// in full rather than summarised as a count.
function renderRoster() {
  const tb = $('rosterList');
  tb.innerHTML = '';
  if (!roster.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">'
      + '<div class="t">No runners yet</div>'
      + '<div class="h">Add them one at a time above, or paste a list.</div></td></tr>';
    return;
  }
  const many = (ev.races || []).length > 1;
  for (const p of roster) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="num">${esc(p.bib)}</td>` +
      `<td>${esc(p.name)}</td>` +
      `<td>${p.category ? esc(p.category) : '<span class="note">—</span>'}</td>` +
      `<td>${p.gender ? esc(p.gender) : '<span class="note">—</span>'}</td>` +
      `<td>${many ? esc(raceName(p.race_id) || '—') : '<span class="note">—</span>'}</td>` +
      `<td class="num"><button data-del="${p.id}" class="quiet danger">Remove</button></td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('button[data-del]').forEach(b => {
    b.onclick = async () => {
      const p = roster.find(x => String(x.id) === b.dataset.del);
      if (!await confirmDialog({
        title: `Remove ${p ? p.name : 'this runner'}?`,
        body: 'Any scans already recorded for that bib are kept, and will '
          + 'reappear if the bib is added again.',
        confirm: 'Remove runner',
      })) return;
      try {
        await api('/participants/' + b.dataset.del, { method: 'DELETE' });
        ok('Runner removed.');
        loadRoster();
      } catch (e) { fail(e.message); }
    };
  });
}

// Bibs are usually sequential, so offering the next one removes the commonest
// piece of typing and the commonest duplicate.
function suggestNextBib() {
  const nums = roster.map(p => parseInt(p.bib, 10)).filter(n => !Number.isNaN(n));
  $('pBib').value = nums.length ? String(Math.max(...nums) + 1) : '1';
}

function pError(msg) {
  const el = $('pErr');
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function addOneRunner() {
  pError('');
  const bib = $('pBib').value.trim();
  const name = $('pName').value.trim();
  if (!bib) { pError('Give the runner a bib number.'); $('pBib').focus(); return; }
  if (!name) { pError('Give the runner a name.'); $('pName').focus(); return; }
  if (roster.some(p => p.bib === bib)) {
    pError(`Bib ${bib} is already taken by ${roster.find(p => p.bib === bib).name}.`);
    $('pBib').focus(); $('pBib').select();
    return;
  }
  const raceId = Number($('pRace').value) || null;
  if (!raceId && (ev.races || []).length > 1) {
    pError('Choose which race this runner is entering.');
    $('pRace').focus();
    return;
  }
  try {
    await api(`/events/${ev.code}/participants`, json('POST', [{
      bib, name,
      category: $('pCat').value.trim() || null,
      gender: $('pGen').value.trim() || null,
      race_id: raceId,
    }]));
    // Name clears, category and gender stay: a start list is usually entered
    // in runs of the same division, and the race should not reset either.
    $('pName').value = '';
    await loadRoster();
    $('pBib').focus();
  } catch (e) { pError(e.message); }
}

$('pAdd').onclick = e => withBusy(e.currentTarget, addOneRunner);

// Enter anywhere in the row adds the runner, so a whole start list can be
// typed without reaching for the mouse.
for (const id of ['pBib', 'pName', 'pCat', 'pGen']) {
  $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addOneRunner(); }
  });
  $(id).addEventListener('input', () => pError(''));
}

$('csv').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const added = await api(`/events/${ev.code}/participants/csv`, { method: 'POST', body: fd });
    ok(`Imported ${added.length} runner${added.length === 1 ? '' : 's'} from ${file.name}.`);
    loadRoster();
  } catch (err) { fail(err.message); }
  e.target.value = '';
};

/* ---------- branding ---------- */

// The distance printed on the bib is whatever the finish checkpoint says, so
// nobody has to type "10K" a second time and get it out of step.
function raceDistance() {
  const fin = (ev.checkpoints || []).find(c => c.kind === 'finish');
  if (!fin || !fin.distance_km) return '';
  const km = Number(fin.distance_km);
  return (Number.isInteger(km) ? km : km.toFixed(1)) + 'K';
}

$('saveBrand').onclick = e => withBusy(e.currentTarget, async () => {
  $('brandMsg').textContent = '';
  try {
    if ($('artFile').files[0]) {
      const fd = new FormData();
      fd.append('file', await fitImageForUpload($('artFile').files[0],
                                                n => { $('brandMsg').textContent = n; }));
      ev = await api(`/events/${ev.code}/artwork`, { method: 'POST', body: fd });
      $('artFile').value = '';
    }
    ev = await api(`/events/${ev.code}/branding`, json('PATCH', {
      accent_color: $('accent').value,
      tagline: $('tagline').value.trim(),
      bib_style: $('bibStyle').value,
    }));
    ok('Branding saved.');
    renderPreview();
  } catch (err) {
    $('brandMsg').textContent = err.message;
    fail(err.message);
  }
});

/* ---------- certificate settings ---------- */

// The word only matters when the mode asks for one.
function syncBadgeFields() {
  $('badgeTextWrap').hidden = $('badgeMode').value !== 'text';
}
$('badgeMode').onchange = syncBadgeFields;

/* Nobody uploads a poster expecting it to be cropped, and the crop is only
   visible after saving and opening a certificate. So when the picture is much
   taller than the card, say so at the moment it is chosen and pre-select the
   fit that keeps all of it. It is a suggestion, not a rule -- the dropdown is
   right there and the operator can put it back. */
$('certFile').onchange = () => {
  const file = $('certFile').files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const ratio = img.naturalHeight / img.naturalWidth;
    if (ratio > 1.45 && $('certFit').value === 'cover') {   // 4:5 is 1.25
      $('certFit').value = 'contain';
      certNote(`That image is ${img.naturalWidth}×${img.naturalHeight}, ` +
               `much taller than the card. Filling the card would crop its top ` +
               `and bottom, so “Show the whole image” has been selected for you.`);
    }
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
};

// Resizing is worth mentioning, but it is not a failure, so it does not use
// the red error line.
function certNote(msg) {
  const el = $('certErr');
  el.hidden = !msg;
  el.textContent = msg;
  el.classList.toggle('plain', !!msg);
}

function certError(msg) {
  const el = $('certErr');
  el.textContent = msg || '';
  el.hidden = !msg;
  el.classList.remove('plain');   // an error after a notice must still read as one
}

$('saveCert').onclick = e => withBusy(e.currentTarget, async () => {
  certError('');
  const mode = $('badgeMode').value;
  const text = $('badgeText').value.trim();
  if (mode === 'text' && !text) {
    certError('Type the word you want every finisher to see.');
    $('badgeText').focus();
    return;
  }
  try {
    if ($('certFile').files[0]) {
      const fd = new FormData();
      fd.append('file', await fitImageForUpload($('certFile').files[0], certNote));
      ev = await api(`/events/${ev.code}/certificate-artwork`, { method: 'POST', body: fd });
      $('certFile').value = '';
    }
    ev = await api(`/events/${ev.code}/branding`, json('PATCH', {
      badge_mode: mode,
      badge_text: mode === 'text' ? text : null,
      cert_fit: $('certFit').value,
    }));
    ok('Certificate settings saved.');
  } catch (err) { certError(err.message); }
});

$('clearCert').onclick = async () => {
  if (!ev.cert_artwork_url) {
    certError('There is no certificate image to remove — the bib artwork is being used.');
    return;
  }
  if (!await confirmDialog({
    title: 'Remove the certificate image?',
    body: 'Certificates fall back to the bib artwork until you upload another.',
    confirm: 'Remove image',
  })) return;
  try {
    ev = await api(`/events/${ev.code}/certificate-artwork`, { method: 'DELETE' });
    ok('Certificate image removed.');
  } catch (e) { certError(e.message); }
};

$('clearArt').onclick = async () => {
  if (!ev.artwork_url) { fail('There is no artwork to remove.'); return; }
  if (!await confirmDialog({
    title: 'Remove the artwork?',
    body: 'Bibs and certificates fall back to the plain layout until you upload a new image.',
    confirm: 'Remove artwork',
  })) return;
  try {
    ev = await api(`/events/${ev.code}/artwork`, { method: 'DELETE' });
    ok('Artwork removed.');
    renderPreview();
  } catch (e) { fail(e.message); }
};

// Show the change on a real bib rather than as a colour swatch -- the whole
// point is what comes out of the printer.
async function renderPreview() {
  if (!ev) return;
  const host = $('previewCard');
  if (!host) return;
  const sample = roster[0] || { bib: '26', name: 'Tenzing Bhutia', category: 'Open' };
  const card = await bibCard(sample);
  card.id = 'previewCard';
  host.replaceWith(card);
  $('artPreview').hidden = false;
}

/* ---------- printable bibs ---------- */

async function bibCard(p) {
  const card = document.createElement('div');
  // With no artwork uploaded there is nothing to run full-bleed, so the band
  // layout is the only one that renders as a designed bib rather than a wash
  // of flat accent colour.
  const style = (ev.bib_style || 'full') === 'full' && ev.artwork_url ? 'full' : 'band';
  card.className = 'bibcard ' + style;
  card.style.setProperty('--accent', ev.accent_color || '#f2c500');
  if (ev.artwork_url) card.style.setProperty('--art', `url("${ev.artwork_url}")`);

  const meta = [p.category, raceDistance(), ev.tagline].filter(Boolean).join(' · ');
  card.innerHTML =
    `<div class="band"><div class="race">${esc(ev.name)}</div></div>` +
    `<div class="digits">${esc(p.bib)}</div>` +
    `<div class="foot">
       <div class="who">
         <div class="nm">${esc(p.name)}</div>
         <div class="meta">${esc(meta)}</div>
       </div>
       <div class="qr"></div>
     </div>`;

  const canvas = document.createElement('canvas');
  card.querySelector('.qr').appendChild(canvas);
  // The QR carries the event too, so a bib from last month's race cannot be
  // scanned into this one by mistake.
  await QRCode.toCanvas(canvas, `RT|${ev.code}|${p.bib}`, { width: 108, margin: 1 });
  return card;
}

$('printBibs').onclick = e => withBusy(e.currentTarget, async () => {
  if (!roster.length) { fail('Add runners to the start list first.'); return; }
  const wrap = $('bibs');
  wrap.innerHTML = '';
  try {
    for (const p of roster) wrap.appendChild(await bibCard(p));
  } catch (err) {
    // Without this the whole handler dies as an unhandled rejection and the
    // button just looks inert.
    wrap.innerHTML = '';
    fail('Could not draw the bib QR codes: ' + err.message);
    return;
  }
  $('bibSheet').hidden = false;
  window.print();
});

/* ---------- audit ----------

   Two hundred rows rendered at once was 11,000px of table -- most of the old
   page's height, for a screen that is only opened when something looks wrong.
   The rows are fetched once per race and drawn a page at a time. */

const READ_PAGE = 50;
let readRows = [];
let readsShown = 0;
let readsLoaded = false;

async function loadReads() {
  const tb = $('readList');
  tb.innerHTML = skeletonRows(6, 6);
  $('moreReads').hidden = true;
  try {
    readRows = await api(`/events/${ev.code}/reads?limit=500`);
  } catch (e) {
    tb.innerHTML = emptyState(6, 'Could not load the reads', e.message);
    return;
  }
  readsLoaded = true;
  $('nReads').textContent = readRows.length >= 500 ? '500+' : readRows.length;
  drawReads();
}

function visibleReads() {
  const wanted = $('readFilter').value.trim();
  return wanted ? readRows.filter(r => String(r.bib) === wanted) : readRows;
}

function drawReads(reset = true) {
  const rows = visibleReads();
  if (reset) readsShown = 0;
  readsShown = Math.min(rows.length, readsShown + READ_PAGE);

  const tb = $('readList');
  if (reset) tb.innerHTML = '';
  if (!rows.length) {
    tb.innerHTML = $('readFilter').value.trim()
      ? emptyState(6, 'No sightings for that bib',
                   'This covers the newest 500 reads of the race.')
      : emptyState(6, 'Nothing recorded yet',
                   'Scans from the checkpoint screens appear here.');
    $('readCount').textContent = '';
    $('moreReads').hidden = true;
    return;
  }

  const frag = document.createDocumentFragment();
  rows.slice(reset ? 0 : readsShown - READ_PAGE, readsShown).forEach(r => {
    const tr = document.createElement('tr');
    const drift = Math.abs(r.clock_offset_ms) > 2000
      ? `<span class="tag wait">${(r.clock_offset_ms / 1000).toFixed(1)}s</span>` : '';
    tr.innerHTML =
      `<td class="num">${esc(r.bib)}</td><td>${esc(r.checkpoint)}</td>` +
      `<td class="num">${new Date(r.observed_at).toLocaleTimeString()}</td>` +
      `<td><span class="tag">${esc(r.source)}</span></td><td>${drift}</td>` +
      `<td class="num">${r.voided
        ? '<span class="tag stop">voided</span>'
        : `<button data-void="${esc(r.read_id)}" class="quiet danger">Void</button>`}</td>`;
    frag.appendChild(tr);
  });
  tb.appendChild(frag);

  $('readCount').textContent =
    `Showing ${readsShown} of ${rows.length}` +
    (readRows.length >= 500 ? ' (newest 500 of the race)' : '');
  $('moreReads').hidden = readsShown >= rows.length;

  // Bind only the rows just added -- "Show more" appends rather than redraws.
  tb.querySelectorAll('button[data-void]:not([data-bound])').forEach(b => {
    b.dataset.bound = '1';
    b.onclick = async () => {
      await api(`/reads/${b.dataset.void}/void`, { method: 'POST' });
      loadReads();
    };
  });
}

$('moreReads').onclick = () => drawReads(false);
$('readFilter').addEventListener('input', () => drawReads());
$('refreshReads').onclick = e => withBusy(e.currentTarget, loadReads);

// Fill the picker on arrival, and open whatever the address bar names.
const at = parseHash();
loadEventPicker(at.code);
if (at.code) load(at.code, at.tab);

// Back and forward should move between tabs, not silently do nothing.
window.addEventListener('hashchange', () => {
  const now = parseHash();
  if (!now.code) return;
  if (!ev || ev.code !== now.code) { load(now.code, now.tab); return; }
  if (now.tab && now.tab !== tab) showTab(now.tab, { push: false });
});
