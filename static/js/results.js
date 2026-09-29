/* Public leaderboard.
   The page most people actually land on, usually on a phone, often while the
   race is still running. Everything filters client-side off the one results
   payload -- it is a few hundred rows at most, and doing it locally keeps the
   typing instant and survives a flaky connection. */

import { esc, ok, fail, emptyState } from '/js/ui.js';

const $ = id => document.getElementById(id);
const code = location.hash.slice(1) || new URLSearchParams(location.search).get('event');

let data = null;
let open = new Set();
let sort = { key: 'position', dir: 'asc' };
let status = 'all';
let category = 'all';
let gender = 'all';
let race = 'all';
let offline = false;

const dur = s => {
  if (s == null) return '—';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

const STATUS = {
  finished: ['go', 'finished'],
  on_course: ['wait', 'on course'],
  dnf: ['stop', 'did not finish'],
  not_started: ['', 'not seen yet'],
};

const ordinal = n => {
  if (n == null) return null;
  const t = n % 100;
  const suffix = (t >= 11 && t <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return n + suffix;
};

// Highlight why a row matched, the same way the certificate finder does.
function mark(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) +
    '</mark>' + esc(text.slice(i + q.length));
}

async function poll() {
  if (!code) {
    $('rows').innerHTML = emptyState(5, 'No race chosen',
      'Add an event code to the address, like /results.html#siliguri10k');
    return;
  }
  try {
    const res = await fetch(`/api/events/${code}/results`, { cache: 'no-store' });
    data = await res.json();
    if (data.detail) throw new Error(data.detail);
    $('title').textContent = data.event.name;
    document.title = `${data.event.name} · Results`;
    renderHead();
    renderChips();
    render();
    offline = false;
  } catch (e) {
    // Only shout on the first failure. Once results are on screen a dropped
    // poll is a network blip, and blanking the table would be worse than
    // showing times that are ten seconds stale.
    if (!data) {
      $('rows').innerHTML = emptyState(5, `Could not load “${code}”`,
        'Check the event code, or try again in a moment.');
    } else if (!offline) {
      offline = true;
      fail('Lost contact with the timing server. Showing the last known results.');
    }
  }
}

/* ---------- the header ----------

   Somebody who opens this from a WhatsApp link has no idea whether the race
   finished an hour ago or is still on the road. The name alone does not say,
   and the ticking clock beside it says even less. */

function renderHead() {
  // The race photo across the top. This is the page people share, so it is
  // worth looking like the race rather than like a spreadsheet.
  const banner = $('raceBanner');
  if (data.event.photo_url) {
    banner.innerHTML =
      `<img src="${esc(data.event.photo_url)}" alt="" loading="lazy">` +
      (data.event.photo_credit
        ? `<span class="credit">${esc(data.event.photo_credit)}</span>` : '');
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  const all = data.results;
  const n = st => all.filter(r => r.status === st).length;
  const running = n('on_course');
  const done = n('finished');
  const started = !!data.event.start_time;

  // A race is only final once every entrant has reached a terminal state.
  // Testing "nobody on course" is not the same thing: a runner with no
  // sightings at all counts as not_started, so a race whose gun has fired but
  // whose first checkpoint has not scanned anyone yet read as "Final".
  const settled = done + n('dnf');
  const pill = $('livePill');
  if (!started) {
    pill.className = 'livepill soon';
    pill.textContent = 'Not started';
  } else if (settled < all.length) {
    pill.className = 'livepill live';
    pill.textContent = 'Live';
  } else {
    pill.className = 'livepill done';
    pill.textContent = 'Final';
  }

  $('raceDate').textContent = started
    ? new Date(data.event.start_time).toLocaleDateString(undefined,
        { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  // Only the numbers that mean something right now: "0 on course" during a
  // race is news, after it is just noise.
  const waiting = n('not_started');
  const cells = [
    { v: done, k: done === 1 ? 'finisher' : 'finishers' },
    running ? { v: running, k: 'still running' } : null,
    // Worth stating only while the race is on: afterwards, anyone never seen
    // is already covered by the finisher and DNF counts.
    (waiting && settled < all.length) ? { v: waiting, k: 'not seen yet' } : null,
    n('dnf') ? { v: n('dnf'), k: 'did not finish' } : null,
    { v: all.length, k: 'entered' },
  ].filter(Boolean);

  $('scoreboard').innerHTML = cells.map(c =>
    `<div class="score"><span class="v">${c.v}</span><span class="k">${esc(c.k)}</span></div>`
  ).join('');
  $('racehead').hidden = false;
}

/* ---------- filters ---------- */

function categories() {
  return [...new Set(data.results.map(r => r.category).filter(Boolean))].sort();
}

function chip(label, value, active, count) {
  return `<button class="chip" data-v="${esc(value)}" aria-pressed="${active}">` +
    `${esc(label)}<span class="n">${count}</span></button>`;
}

function renderChips() {
  // Races come first: picking one narrows everything below it, and a placing
  // only means anything inside a single race.
  const races = data.races || [];
  if (races.length > 1) {
    const n = id => data.results.filter(r => r.race_id === id).length;
    $('raceChips').innerHTML =
      chip('All races', 'all', race === 'all', data.results.length) +
      races.map(r => chip(
        r.distance_km ? `${r.name} · ${r.distance_km}km` : r.name,
        String(r.id), race === String(r.id), n(r.id))).join('');
    $('raceChips').hidden = false;
  } else {
    $('raceChips').innerHTML = '';
    $('raceChips').hidden = true;
  }

  const inRace = r => race === 'all' || String(r.race_id) === race;
  const scoped = data.results.filter(inRace);

  const counts = { all: scoped.length };
  for (const r of scoped) counts[r.status] = (counts[r.status] || 0) + 1;

  // Only offer a status filter for statuses that actually occur, so a race
  // with no DNFs does not show a permanently empty "did not finish" chip.
  const statuses = ['finished', 'on_course', 'dnf', 'not_started'].filter(s => counts[s]);
  $('statusChips').innerHTML =
    chip('Everyone', 'all', status === 'all', counts.all) +
    statuses.map(s => chip(STATUS[s][1], s, status === s, counts[s])).join('');

  const cats = [...new Set(scoped.map(r => r.category).filter(Boolean))].sort();
  if (cats.length > 1) {
    const catCount = c => scoped.filter(r => r.category === c).length;
    $('catChips').innerHTML =
      chip('All categories', 'all', category === 'all', counts.all) +
      cats.map(c => chip(c, c, category === c, catCount(c))).join('');
    $('catChips').hidden = false;
  } else {
    $('catChips').innerHTML = '';
    $('catChips').hidden = true;
  }
  // Gender is ranked in the payload and quoted as often as the category --
  // "first woman home" is the line that goes in the local paper.
  const gens = [...new Set(scoped.map(r => r.gender).filter(Boolean))].sort();
  if (gens.length > 1) {
    const genCount = g => scoped.filter(r => r.gender === g).length;
    $('genChips').innerHTML =
      chip('All', 'all', gender === 'all', counts.all) +
      gens.map(g => chip(g, g, gender === g, genCount(g))).join('');
    $('genChips').hidden = false;
  } else {
    $('genChips').innerHTML = '';
    $('genChips').hidden = true;
  }

  $('filters').hidden = false;
}

$('raceChips').onclick = e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  race = b.dataset.v;
  // A category or gender from the previous race may not exist in this one.
  category = 'all';
  gender = 'all';
  renderChips(); render();
};

$('statusChips').onclick = e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  status = b.dataset.v;
  renderChips(); render();
};

$('catChips').onclick = e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  category = b.dataset.v;
  renderChips(); render();
};

$('genChips').onclick = e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  gender = b.dataset.v;
  renderChips(); render();
};

/* ---------- sorting ---------- */

$('head').onclick = e => {
  const th = e.target.closest('.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  sort = { key, dir: sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc' };
  render();
};

function sorted(rows) {
  const dir = sort.dir === 'asc' ? 1 : -1;
  // Runners with no time always sink to the bottom regardless of direction --
  // an unfinished runner is not "fastest" just because the sort flipped.
  const val = r => {
    if (sort.key === 'name') return r.name.toLowerCase();
    if (sort.key === 'bib') return Number(r.bib) || r.bib;
    return r.finish_seconds ?? r.position ?? null;
  };
  return [...rows].sort((a, b) => {
    const av = val(a), bv = val(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
  });
}

/* ---------- table ---------- */

function render() {
  if (!data) return;
  leaderCache = new Map();
  const q = $('find').value.trim().toLowerCase();

  const rows = sorted(data.results.filter(r =>
    (race === 'all' || String(r.race_id) === race) &&
    (status === 'all' || r.status === status) &&
    (category === 'all' || r.category === category) &&
    (gender === 'all' || r.gender === gender) &&
    (!q || r.name.toLowerCase().includes(q) || String(r.bib).toLowerCase().includes(q))));

  for (const th of document.querySelectorAll('.sortable')) {
    if (th.dataset.sort === sort.key) th.dataset.dir = sort.dir;
    else th.removeAttribute('data-dir');
  }

  const total = data.results.length;
  $('tally').textContent = rows.length === total
    ? `${total} runners.`
    : `${rows.length} of ${total} runners.`;

  const manyRaces = (data.races || []).length > 1;
  const tb = $('rows');
  tb.innerHTML = '';

  if (!rows.length) {
    const filtered = q || race !== 'all' || status !== 'all'
      || category !== 'all' || gender !== 'all';
    tb.innerHTML = filtered
      ? emptyState(5, 'No runners match', 'Try clearing a filter or searching for less.')
      : emptyState(5, 'Nobody is entered yet', 'Runners appear here once the start list is loaded.');
    return;
  }

  // With every race on screen the rank column restarts at 1 for each one,
  // which is correct -- a 5K winner and a 10K winner are both first -- but
  // reads as a fault until you see where one field ends and the next begins.
  const showDividers = manyRaces && race === 'all' && sort.key === 'position';
  let lastRace = null;

  rows.forEach(r => {
    if (showDividers && r.race_id !== lastRace) {
      lastRace = r.race_id;
      const info = (data.races || []).find(x => x.id === r.race_id);
      const n = rows.filter(x => x.race_id === r.race_id).length;
      const head = document.createElement('tr');
      head.className = 'racedivider';
      head.innerHTML =
        `<td colspan="5"><span class="nm">${esc(info ? info.name : 'Other')}</span>` +
        `${info && info.distance_km ? `<span class="km">${info.distance_km} km</span>` : ''}` +
        `<span class="n">${n} runner${n === 1 ? '' : 's'}</span></td>`;
      tb.appendChild(head);
    }
    const [tone, label] = STATUS[r.status];
    const tr = document.createElement('tr');
    tr.className = `runner-row ${r.status}` +
      (r.position && r.position <= 3 ? ` podium p${r.position}` : '') +
      (open.has(r.bib) ? ' open' : '');
    const progress = progressCell(r, tone, label);
    // data-c drives the phone layout, where the table becomes stacked cards.
    tr.innerHTML =
      `<td class="num pos" data-c="pos">${r.position ?? ''}</td>` +
      `<td class="num" data-c="bib">${mark(String(r.bib), q)}</td>` +
      `<td data-c="name">${mark(r.name, q)}${r.category ? ` <span class="tag">${esc(r.category)}</span>` : ''}` +
      // Only worth showing which race someone ran when the event actually has
      // more than one -- otherwise it is the same tag on every row.
      `${manyRaces && race === 'all' && r.race ? ` <span class="tag">${esc(r.race)}</span>` : ''}</td>` +
      `<td class="num" data-c="time">${dur(r.finish_seconds)}</td>` +
      `<td data-c="prog">${progress}</td>`;
    tr.onclick = () => { open.has(r.bib) ? open.delete(r.bib) : open.add(r.bib); render(); };
    tb.appendChild(tr);

    if (open.has(r.bib)) tb.appendChild(detailRow(r));
  });
}

/* The last column used to print the name of the last checkpoint passed, which
   for a finished race is the word "Finish" on every single row. For someone
   who has finished, the number that means something is how far back they were
   -- the gap is the first thing anyone asks after their own time. */
function progressCell(r, tone, label) {
  if (r.status === 'finished') {
    const lead = leaderTime(r.race_id);
    if (lead == null || r.finish_seconds == null) return '';
    const gap = Math.round(r.finish_seconds - lead);
    if (gap <= 0) return '<span class="tag go">winner</span>';
    const m = Math.floor(gap / 60), sec = gap % 60;
    return `<span class="gap">+${m}:${String(sec).padStart(2, '0')}</span>`;
  }
  if (r.splits.length) return esc(r.splits[r.splits.length - 1].checkpoint);
  return `<span class="tag ${tone}">${label}</span>`;
}

// Cached per render: this is called once per row and would otherwise scan the
// whole field each time.
let leaderCache = new Map();
function leaderTime(raceId) {
  if (!leaderCache.has(raceId)) {
    const times = data.results
      .filter(r => r.race_id === raceId && r.finish_seconds != null)
      .map(r => r.finish_seconds);
    leaderCache.set(raceId, times.length ? Math.min(...times) : null);
  }
  return leaderCache.get(raceId);
}

// "3rd of 12 in Veteran" -- the placing people actually quote, and the one
// that is invisible on a combined leaderboard.
function placings(r) {
  if (r.status !== 'finished') return '';
  const bits = [];
  if (r.position) bits.push({ v: ordinal(r.position), k: `of ${r.field_size} overall${r.race ? ' in the ' + r.race : ''}` });
  if (r.category_position) bits.push({ v: ordinal(r.category_position), k: `of ${r.category_size} in ${r.category}` });
  if (r.gender_position) bits.push({ v: ordinal(r.gender_position), k: `of ${r.gender_size} ${r.gender}` });
  if (!bits.length) return '';
  return `<div class="placings">${bits.map(b =>
    `<div class="pl"><span class="v">${esc(b.v)}</span><span class="k">${esc(b.k)}</span></div>`).join('')}</div>`;
}

function detailRow(r) {
  const det = document.createElement('tr');
  det.className = 'detailrow';
  const splits = r.splits.length
    ? r.splits.map(s =>
        `<div class="sp">
           <span class="cp">${esc(s.checkpoint)}</span>
           <span class="n">${s.distance_km} km</span>
           <span class="n">${dur(s.elapsed_seconds)}</span>
           <span class="pace">${esc(s.pace_per_km || '')}</span>
         </div>`).join('')
    : '<div class="note">No sightings recorded for this runner yet.</div>';

  const link = `/certificate.html#${encodeURIComponent(data.event.code)}/${encodeURIComponent(r.bib)}`;
  const acts = r.status === 'finished'
    ? `<div class="acts">
         <a href="${link}">Finisher certificate</a>
         <button data-share="${esc(r.bib)}">Share result</button>
       </div>`
    : '';

  det.innerHTML = `<td colspan="5" style="background:var(--ink-2)">
      <div class="detail">${placings(r)}${splits}${acts}</div></td>`;

  const btn = det.querySelector('[data-share]');
  if (btn) btn.onclick = e => { e.stopPropagation(); share(r); };
  // Clicking inside the panel should not collapse the row it belongs to.
  det.querySelector('.detail').onclick = e => e.stopPropagation();
  return det;
}

async function share(r) {
  const url = `${location.origin}/certificate.html#${data.event.code}/${r.bib}`;
  const text = `${r.name} finished ${data.event.name} in ${dur(r.finish_seconds)}` +
    (r.position ? ` — ${ordinal(r.position)} overall` : '');
  try {
    // The native sheet on a phone is what people actually use; the clipboard
    // is the desktop fallback.
    if (navigator.share) await navigator.share({ title: data.event.name, text, url });
    else { await navigator.clipboard.writeText(`${text}\n${url}`); ok('Result copied to clipboard.'); }
  } catch (e) {
    // AbortError just means the share sheet was dismissed, which is not a fault.
    if (e && e.name !== 'AbortError') fail('Could not share that result.');
  }
}

$('find').oninput = () => data && render();

setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString(); }, 1000);
// Polling every 10 seconds. Websockets would be more elegant and would buy
// nothing here: results change slowly, and a poll survives a flaky connection
// without any reconnection logic.
setInterval(poll, 10000);
poll();
