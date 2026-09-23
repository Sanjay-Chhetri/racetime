import QRCode from '/vendor/qrcode.esm.js';

const $ = id => document.getElementById(id);
let ev = null;

const api = async (path, opts) => {
  const res = await fetch('/api' + path, opts);
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error((body && body.detail) || ('HTTP ' + res.status));
  return body;
};

const fmtTime = iso => iso ? new Date(iso).toLocaleString() : 'not started';

// Runner names and race names reach the bib and the certificate as markup, and
// they arrive from a pasted list or an uploaded CSV, so they get escaped.
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- open / create ---------- */

$('open').onclick = () => load($('code').value.trim());

$('create').onclick = async () => {
  $('err').textContent = '';
  try {
    const created = await api('/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('newCode').value.trim(), name: $('newName').value.trim() }),
    });
    load(created.code);
  } catch (e) { $('err').textContent = e.message; }
};

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

$('startNow').onclick = async () => {
  if (ev.start_time && !confirm('This race already has a start time. Replace it?')) return;
  ev = await api(`/events/${ev.code}/start`, { method: 'POST' });
  $('startTime').textContent = fmtTime(ev.start_time);
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
        if (!confirm('Remove this race? Its checkpoints go with it.')) return;
        try {
          await api('/races/' + b.dataset.race, { method: 'DELETE' });
          load(ev.code);
        } catch (e) { alert(e.message); }
      };
    });
  }

  // Both pickers offer the same list, so a checkpoint and a start list can
  // never drift onto different races by accident.
  const opts = ev.races.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  for (const id of ['cpRace', 'pasteRace']) {
    const sel = $(id);
    const keep = sel.value;
    sel.innerHTML = opts || '<option value="">Add a race first</option>';
    if (keep) sel.value = keep;
  }
}

$('rcAdd').onclick = async () => {
  const name = $('rcName').value.trim();
  if (!name) { alert('Give the race a name, like 10K.'); return; }
  try {
    await api(`/events/${ev.code}/races`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        distance_km: parseFloat($('rcKm').value) || 0,
        sequence: parseInt($('rcSeq').value) || 0,
      }),
    });
    $('rcName').value = '';
    load(ev.code);
  } catch (e) { alert(e.message); }
};

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
      if (!confirm('Remove this checkpoint? Reads taken there stop counting.')) return;
      await api('/checkpoints/' + b.dataset.cp, { method: 'DELETE' });
      load(ev.code);
    };
  });
}

$('cpAdd').onclick = async () => {
  try {
    await api(`/events/${ev.code}/checkpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('cpName').value.trim(),
        distance_km: parseFloat($('cpKm').value) || 0,
        sequence: parseInt($('cpSeq').value) || 0,
        kind: $('cpKind').value,
        race_id: Number($('cpRace').value) || null,
      }),
    });
    $('cpName').value = '';
    load(ev.code);
  } catch (e) { alert(e.message); }
};

/* ---------- roster ---------- */

let roster = [];

async function loadRoster() {
  roster = await api(`/events/${ev.code}/participants`);
  $('rosterCount').textContent = roster.length
    ? `${roster.length} runners registered.`
    : 'No runners yet.';

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

$('pasteAdd').onclick = async () => {
  const raceId = Number($('pasteRace').value) || null;
  if (!raceId && (ev.races || []).length > 1) {
    alert('Choose which race these runners are entering.');
    return;
  }
  const rows = $('paste').value.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const [bib, name, category, gender] = line.split(',').map(s => (s || '').trim());
    return {
      bib, name: name || ('Bib ' + bib),
      category: category || null, gender: gender || null, race_id: raceId,
    };
  }).filter(r => r.bib);
  if (!rows.length) return;
  try {
    await api(`/events/${ev.code}/participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
    });
    $('paste').value = '';
    loadRoster();
  } catch (e) { alert(e.message); }
};

$('csv').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    await api(`/events/${ev.code}/participants/csv`, { method: 'POST', body: fd });
    loadRoster();
  } catch (err) { alert(err.message); }
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

$('saveBrand').onclick = async () => {
  $('brandMsg').textContent = '';
  try {
    if ($('artFile').files[0]) {
      const fd = new FormData();
      fd.append('file', $('artFile').files[0]);
      ev = await api(`/events/${ev.code}/artwork`, { method: 'POST', body: fd });
      $('artFile').value = '';
    }
    ev = await api(`/events/${ev.code}/branding`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accent_color: $('accent').value,
        tagline: $('tagline').value.trim(),
        bib_style: $('bibStyle').value,
      }),
    });
    $('brandMsg').textContent = 'Saved.';
    renderPreview();
  } catch (e) { $('brandMsg').textContent = e.message; }
};

$('clearArt').onclick = async () => {
  if (!ev.artwork_url) { $('brandMsg').textContent = 'No artwork to remove.'; return; }
  if (!confirm('Remove the uploaded artwork from this race?')) return;
  try {
    ev = await api(`/events/${ev.code}/artwork`, { method: 'DELETE' });
    $('brandMsg').textContent = 'Artwork removed.';
    renderPreview();
  } catch (e) { $('brandMsg').textContent = e.message; }
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

$('printBibs').onclick = async () => {
  if (!roster.length) { alert('Add runners first.'); return; }
  const wrap = $('bibs');
  wrap.innerHTML = '';
  try {
    for (const p of roster) wrap.appendChild(await bibCard(p));
  } catch (err) {
    // Without this the whole handler dies as an unhandled rejection and the
    // button just looks inert.
    wrap.innerHTML = '';
    alert('Could not draw the bib QR codes: ' + err.message);
    return;
  }
  $('bibSheet').hidden = false;
  window.print();
};

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
