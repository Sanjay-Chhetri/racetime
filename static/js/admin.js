import QRCode from '/vendor/qrcode.esm.js';
// Runner names and race names reach the bib and the certificate as markup, and
// they arrive from a pasted list or an uploaded CSV, so `esc` is shared.
import { esc, ok, fail, confirmDialog, withBusy } from '/js/ui.js';

const $ = id => document.getElementById(id);
let ev = null;

const api = async (path, opts) => {
  const res = await fetch('/api' + path, opts);
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

/* ---------- open / create ---------- */

$('open').onclick = () => load($('code').value.trim());

$('create').onclick = e => withBusy(e.currentTarget, async () => {
  $('err').textContent = '';
  try {
    const created = await api('/events', json('POST', {
      code: $('newCode').value.trim(), name: $('newName').value.trim(),
    }));
    ok(`Created “${created.name}”.`);
    load(created.code);
  } catch (err) { $('err').textContent = err.message; }
});

async function load(code) {
  if (!code) return;
  $('err').textContent = '';
  try {
    ev = await api('/events/' + code);
  } catch (e) { $('err').textContent = e.message; return; }
  location.hash = code;
  $('code').value = code;
  $('event').hidden = false;
  $('evName').textContent = ev.name;
  $('startTime').textContent = fmtTime(ev.start_time);
  $('accent').value = ev.accent_color || '#f2c500';
  $('tagline').value = ev.tagline || '';
  $('bibStyle').value = ev.bib_style || 'full';
  renderRaces();
  renderCheckpoints();
  loadRoster();
  loadReads();
  renderPreview();
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
        `<td class="num"><button data-race="${r.id}" class="danger">Remove</button></td>`;
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
      `<td class="num"><button data-cp="${c.id}" class="danger">Remove</button></td>`;
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
      `<td class="num"><button data-del="${p.id}" class="danger">Remove</button></td>`;
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
      fd.append('file', $('artFile').files[0]);
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

/* ---------- audit ---------- */

async function loadReads() {
  const reads = await api(`/events/${ev.code}/reads?limit=200`);
  const tb = $('readList');
  tb.innerHTML = '';
  if (!reads.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">Nothing recorded yet.</td></tr>';
    return;
  }
  reads.forEach(r => {
    const tr = document.createElement('tr');
    const drift = Math.abs(r.clock_offset_ms) > 2000
      ? `<span class="tag wait">${(r.clock_offset_ms / 1000).toFixed(1)}s</span>` : '';
    tr.innerHTML =
      `<td class="num">${r.bib}</td><td>${r.checkpoint}</td>` +
      `<td class="num">${new Date(r.observed_at).toLocaleTimeString()}</td>` +
      `<td><span class="tag">${r.source}</span></td><td>${drift}</td>` +
      `<td class="num">${r.voided
        ? '<span class="tag stop">voided</span>'
        : `<button data-void="${r.read_id}" class="danger">Void</button>`}</td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('button[data-void]').forEach(b => {
    b.onclick = async () => {
      await api(`/reads/${b.dataset.void}/void`, { method: 'POST' });
      loadReads();
    };
  });
}

$('refreshReads').onclick = loadReads;

if (location.hash.slice(1)) load(location.hash.slice(1));
