import QRCode from '/vendor/qrcode.esm.js';
// Runner names and race names reach the bib and the certificate as markup, and
// they arrive from a pasted list or an uploaded CSV, so `esc` is shared.
import { esc, ok, fail, confirmDialog, withBusy, fitImageForUpload,
         skeletonRows, emptyState } from '/js/ui.js';
import { mountPicker } from '/js/theme.js';

const $ = id => document.getElementById(id);
let ev = null;

/* ---------- who is signed in ----------

   There is no token in this file any more. The session is an HttpOnly cookie:
   the browser attaches it to every same-origin request on its own, and this
   script cannot read it, so an injected script cannot steal it either. What
   the old shared token bought -- one secret, pasted into localStorage, giving
   whoever held it every power in the system -- was never worth it. */

let me = null;                    // { user, can_create_events, can_manage_users }
const isSuper = () => Boolean(me && me.can_manage_users);

function toLogin() {
  const next = encodeURIComponent(location.pathname + location.hash);
  location.href = `/login.html?next=${next}`;
}

const api = async (path, opts) => {
  opts = { ...(opts || {}) };
  opts.headers = { ...(opts.headers || {}) };

  let res;
  try {
    res = await fetch('/api' + path, opts);
  } catch {
    throw new Error('Could not reach the server. Check your connection.');
  }

  // 401 is "your session has gone" -- expired, signed out in another tab, or
  // the account was disabled while this page was open. There is nothing to
  // retry, so send them to sign in rather than failing the action silently.
  if (res.status === 401) {
    toLogin();
    throw new Error('Your session has ended. Signing in again…');
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
    // 413 is usually the host rejecting the body at the edge, before the app
    // sees it, so it answers in plain text and there is no detail to show.
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

/* ---------- the account bar ---------- */

function renderAccount() {
  if (!me) return;
  const u = me.user;
  $('whoName').textContent = u.display_name || u.username;
  $('whoRole').textContent = u.role === 'super_admin' ? 'Super admin' : 'Admin';
  $('whoRole').className = 'rolepill ' + (u.role === 'super_admin' ? 'super' : '');
  $('account').hidden = false;

  // Creating a race belongs to super admins, so an admin is not shown a form
  // the server is going to refuse. The check that counts is on the server;
  // this only stops the interface offering a dead end.
  $('createWrap').hidden = !me.can_create_events;
  SUPER_TABS.forEach(t => { $('tab-' + t).hidden = !me.can_manage_users; });

  $('pwNag').hidden = !u.must_change_password;
}

$('signOut').onclick = async () => {
  if (!await confirmDialog({
    title: 'Sign out?',
    body: 'You will need your username and password to get back in.',
    confirm: 'Sign out',
  })) return;
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* going anyway */ }
  location.href = '/login.html';
};

/* ---------- your own password ---------- */

$('pwSave').onclick = e => withBusy(e.currentTarget, async () => {
  $('pwErr').hidden = true;
  const current = $('pwCurrent').value;
  const next = $('pwNew').value;
  const again = $('pwAgain').value;
  if (next !== again) {
    $('pwErr').textContent = 'The two new passwords do not match.';
    $('pwErr').hidden = false;
    return;
  }
  try {
    await api('/auth/password', json('POST', {
      current_password: current, new_password: next,
    }));
    ok('Password changed. Any other browser you were signed in on has been signed out.');
    ['pwCurrent', 'pwNew', 'pwAgain'].forEach(id => { $(id).value = ''; });
    me = await api('/auth/me');
    renderAccount();
    // They arrived here before choosing a race; hand the app back.
    if (location.hash === '#!password') {
      location.hash = '';
      $('chooser').hidden = false;
      loadEventPicker('');
    }
  } catch (err) {
    $('pwErr').textContent = err.message;
    $('pwErr').hidden = false;
  }
});

['pwCurrent', 'pwNew', 'pwAgain'].forEach(id => {
  $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('pwSave').click(); }
  });
});

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

let myCodes = null;        // the races this operator may run, or null if unknown

async function loadEventPicker(selected) {
  const sel = $('pickEvent');
  try {
    // Deliberately the scoped listing, not /api/events/public: an admin who
    // runs two of five races should be offered two. A race they cannot open
    // is not information, it is a locked door with their name on it.
    const events = await api('/events');
    myCodes = new Set(events.map(e => e.code));
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

/* ---------- who runs this race ---------- */

let crew = null;

const crewError = m => {
  $('crewErr').textContent = m || '';
  $('crewErr').hidden = !m;
};

async function loadCrew() {
  if (!ev || !isSuper()) { $('crewPanel').hidden = true; return; }
  crewError('');
  try {
    crew = await api(`/events/${ev.code}/operators`);
  } catch (e) { crewError(e.message); return; }

  const all = [...crew.assigned, ...crew.available]
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  const on = new Set(crew.assigned.map(m => m.id));

  // An empty column of boxes does not say which way round the rule is, so the
  // state is spelled out rather than left to be inferred from it.
  $('crewState').textContent = crew.open_to_all
    ? 'Nobody is assigned, so only super admins can run this race. Tick the '
      + 'people who should run it.'
    : `${crew.assigned.length} of ${all.length} admins can run this race. `
      + 'The others cannot open it at all.';

  $('crewList').innerHTML = all.length
    ? all.map(m => `<label class="check">
        <input type="checkbox" data-crew="${m.id}"${on.has(m.id) ? ' checked' : ''}>
        ${esc(m.display_name)} <span class="note">${esc(m.username)}</span></label>`).join('')
    : '<p class="note">There are no admin accounts yet. Add one under '
      + 'Members, then come back.</p>';
  $('crewPanel').hidden = false;
}

async function saveCrew(ids) {
  crewError('');
  try {
    crew = await api(`/events/${ev.code}/operators`,
                     json('PUT', { user_ids: ids }));
    ok(crew.open_to_all
      ? 'Nobody assigned. Only super admins can run this race now.'
      : `${crew.assigned.length} admin${crew.assigned.length === 1 ? '' : 's'} `
        + 'can run this race.');
    loadCrew();
  } catch (e) { crewError(e.message); }
}

$('crewSave').onclick = e => withBusy(e.currentTarget, async () => {
  const ids = [...document.querySelectorAll('[data-crew]:checked')]
    .map(b => Number(b.dataset.crew));
  if (await crewWarnIfEmpty(ids)) await saveCrew(ids);
});

/* Unticking everybody and saving leaves the race to the super admins, which is
   where a new race starts. It is worth a word of warning on the way, because
   the person doing it may be removing themselves from their own help. */
const crewWarnIfEmpty = async ids => (ids.length ? true : await confirmDialog({
  title: 'Leave this race to the super admins?',
  body: 'With nobody ticked, no admin will be able to open this race. You and '
      + 'the other super admins still can.',
  confirm: 'Save anyway',
}));

$('pickEvent').onchange = e => { if (e.target.value) load(e.target.value); };

$('create').onclick = e => withBusy(e.currentTarget, async () => {
  $('err').textContent = '';
  try {
    const created = await api('/events', json('POST', {
      code: $('newCode').value.trim(), name: $('newName').value.trim(),
    }));
    ok(`Created “${created.name}”.`);
    await loadEventPicker(created.code);
    // Open it on Runners rather than wherever the operator happened to be.
    // Creating a race from the account screen used to leave you on the account
    // screen, which reads as if nothing happened.
    load(created.code, 'runners');
  } catch (err) { $('err').textContent = err.message; }
});

/* ---------- tabs ----------

   Everything used to be one page: six panels, 16,000px of scroll, with Runners
   -- the thing touched most -- below three sections that are set once and
   forgotten. One panel shows at a time now, and the open tab lives in the
   address bar after the code (#siliguri10k/runners) so a reload comes back to
   where you were and a link can point at a section. */

// Tabs that need a race open, and tabs that belong to the operator.
const RACE_TABS = ['runners', 'entries', 'races', 'checkpoints',
                   'artwork', 'virtual', 'reads'];
const OPS_TABS = ['members', 'workshops', 'analytics', 'messages', 'account'];
// Screens that belong to the whole site rather than to one race. Sanjay's
// call: the one shared inbox stays open to every admin, while the workshops
// and the visitor numbers sit with the super admins -- an admin brought in to
// run one race does not inherit the site with it.
const SUPER_TABS = ['members', 'workshops', 'analytics'];
const TABS = [...RACE_TABS, ...OPS_TABS];
let tab = 'runners';

function showTab(name, { push = true } = {}) {
  if (!TABS.includes(name)) name = ev ? RACE_TABS[0] : 'account';
  // Typing #code/members must not open a screen the account cannot use. The
  // server refuses its endpoints anyway; this stops the empty shell appearing.
  if (SUPER_TABS.includes(name) && !isSuper()) name = ev ? RACE_TABS[0] : 'account';
  // A race tab with no race open would be five empty panels.
  if (RACE_TABS.includes(name) && !ev) name = 'account';
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

  // The race tabs only make sense with a race open, so they appear with one
  // and go away without one, rather than sitting there doing nothing.
  const onRace = Boolean(ev);
  RACE_TABS.forEach(t => { $('tab-' + t).hidden = !onRace; });
  $('schedulePanel').hidden = !(onRace && RACE_TABS.includes(name));
  $('crewPanel').hidden = !(onRace && isSuper() && RACE_TABS.includes(name));
  $('event').hidden = !(onRace && RACE_TABS.includes(name));
  $('chooser').hidden = onRace;

  if (push && ev && RACE_TABS.includes(name)) location.hash = `${ev.code}/${name}`;
  else if (push && OPS_TABS.includes(name)) location.hash = '!' + name;

  // Reads are fetched only when asked for. Loading a few thousand rows on
  // every open made the page slow to appear for something rarely looked at.
  if (name === 'reads' && !readsLoaded) loadReads();
  if (name === 'members') loadMembers();
  if (name === 'analytics') loadAnalytics();
  if (name === 'messages') loadMessages();
  if (name === 'workshops') loadWorkshops();
  if (name === 'entries') loadEntries();
  if (name === 'virtual') loadVirtual();
  if (name === 'checkpoints') loadDeviceKey();
  if (onRace && isSuper() && RACE_TABS.includes(name) && !crew) loadCrew();
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

/** "siliguri10k/runners" -> { code, tab }; "!members" -> { tab } */
function parseHash() {
  const raw = location.hash.slice(1);
  if (raw.startsWith('!')) {
    const wanted = raw.slice(1);
    return { code: null, tab: OPS_TABS.includes(wanted) ? wanted : null };
  }
  const [code, wanted] = raw.split('/');
  return { code, tab: TABS.includes(wanted) ? wanted : null };
}

$('switchEvent').onclick = () => {
  ev = null;
  location.hash = '';
  $('pickEvent').value = '';
  showTab('account', { push: false });
  $('pickEvent').focus();
};

async function load(code, wantTab) {
  if (!code) return;
  $('err').textContent = '';
  // The event's own details are public, so this would succeed for a race this
  // admin cannot run -- and then every panel on the screen would refuse them
  // one request at a time. Say it once, here, instead.
  //
  // The list has to be in hand first. Opening #somerace/runners straight from
  // the address bar calls this while the picker is still loading, and a guard
  // that is skipped because the answer has not arrived yet is not a guard.
  if (myCodes === null) await loadEventPicker(code);
  if (myCodes && !myCodes.has(code)) {
    ev = null;
    crew = null;
    $('err').textContent = `You are not one of the people running '${code}'. `
      + 'Ask a super admin to add you to it.';
    showTab('account');
    return;
  }
  try {
    ev = await api('/events/' + code);
  } catch (e) { $('err').textContent = e.message; return; }
  crew = null;              // a different race has a different crew
  if ($('pickEvent').options.length > 1) $('pickEvent').value = code;
  $('code').value = code;
  // Which containers are visible is showTab's job now, since the operator
  // screens stay reachable whether or not a race is open.
  $('evName').textContent = ev.name;
  $('startTime').textContent = fmtTime(ev.start_time);
  $('accent').value = ev.accent_color || '#f2c500';
  $('tagline').value = ev.tagline || '';
  $('bibStyle').value = ev.bib_style || 'full';
  $('badgeMode').value = ev.badge_mode || 'placing';
  $('badgeText').value = ev.badge_text || '';
  $('certFit').value = ev.cert_fit || 'cover';
  fillSchedule();
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

/* ---------- members (super admin only) ---------- */

const ROLE_LABEL = { super_admin: 'Super admin', admin: 'Admin' };

function memberError(msg) {
  const el = $('muErr');
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function loadMembers() {
  const tb = $('memberList');
  tb.innerHTML = skeletonRows(6, 4);
  let users;
  try {
    users = await api('/users');
  } catch (e) {
    tb.innerHTML = emptyState(6, 'Could not load the member list', e.message);
    return;
  }
  $('nMembers').textContent = users.length || '';
  tb.innerHTML = '';

  users.forEach(u => {
    const isSelf = me && me.user && u.id === me.user.id;
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><strong>${esc(u.username)}</strong>${isSelf ? ' <span class="tag">you</span>' : ''}</td>` +
      `<td>${esc(u.display_name || '')}</td>` +
      `<td><span class="rolepill ${u.role === 'super_admin' ? 'super' : ''}">` +
        `${esc(ROLE_LABEL[u.role] || u.role)}</span></td>` +
      `<td>${u.is_active
        ? (u.must_change_password
            ? '<span class="tag wait">must set password</span>'
            : '<span class="tag go">active</span>')
        : '<span class="tag stop">disabled</span>'}</td>` +
      `<td class="num">${u.last_login_at
        ? new Date(u.last_login_at).toLocaleDateString() : '—'}</td>` +
      `<td class="num">
         <button class="quiet" data-reset="${u.id}">Reset password</button>
         ${isSelf ? '' :
           `<button class="quiet" data-role="${u.id}" data-to="${
              u.role === 'super_admin' ? 'admin' : 'super_admin'}">${
              u.role === 'super_admin' ? 'Make admin' : 'Make super'}</button>
            <button class="quiet danger" data-active="${u.id}" data-to="${
              u.is_active ? 'false' : 'true'}">${u.is_active ? 'Disable' : 'Enable'}</button>`}
       </td>`;
    tb.appendChild(tr);
  });

  tb.querySelectorAll('button[data-reset]').forEach(b => {
    b.onclick = () => resetPassword(b.dataset.reset,
      users.find(u => String(u.id) === b.dataset.reset));
  });
  tb.querySelectorAll('button[data-role]').forEach(b => {
    b.onclick = () => changeRole(b.dataset.role, b.dataset.to,
      users.find(u => String(u.id) === b.dataset.role));
  });
  tb.querySelectorAll('button[data-active]').forEach(b => {
    b.onclick = () => setActive(b.dataset.active, b.dataset.to === 'true',
      users.find(u => String(u.id) === b.dataset.active));
  });
}

async function resetPassword(id, u) {
  const next = await confirmDialog({
    title: `Reset ${u.username}'s password?`,
    body: 'They will be signed out everywhere and given a new starting ' +
          'password, which they must change when they next sign in.',
    confirm: 'Reset it',
  });
  if (!next) return;
  // Generated here rather than typed, so a reset never quietly becomes
  // "password123" because someone was in a hurry.
  const fresh = 'rt-' + Math.random().toString(36).slice(2, 8) +
                '-' + Math.random().toString(36).slice(2, 6);
  try {
    await api(`/users/${id}`, json('PATCH', { password: fresh }));
    await confirmDialog({
      title: 'New password',
      body: `${u.username} can sign in with:\n\n${fresh}\n\n` +
            'Give it to them in person. It is not shown again.',
      confirm: 'Done',
      cancel: null,
    });
    loadMembers();
  } catch (e) { memberError(e.message); }
}

async function changeRole(id, to, u) {
  const label = ROLE_LABEL[to];
  if (!await confirmDialog({
    title: `Make ${u.username} a ${label.toLowerCase()}?`,
    body: to === 'super_admin'
      ? 'They will be able to create races and manage this member list.'
      : 'They will keep full control of races but lose event creation and ' +
        'member management.',
    confirm: `Make ${label.toLowerCase()}`,
  })) return;
  try {
    await api(`/users/${id}`, json('PATCH', { role: to }));
    ok(`${u.username} is now a ${label.toLowerCase()}.`);
    loadMembers();
  } catch (e) { memberError(e.message); }
}

async function setActive(id, active, u) {
  if (!active && !await confirmDialog({
    title: `Disable ${u.username}?`,
    body: 'They are signed out immediately and cannot sign back in. Nothing ' +
          'they have already recorded is affected.',
    confirm: 'Disable',
    danger: true,
  })) return;
  try {
    await api(`/users/${id}`, json('PATCH', { is_active: active }));
    ok(active ? `${u.username} can sign in again.` : `${u.username} is disabled.`);
    loadMembers();
  } catch (e) { memberError(e.message); }
}

$('muAdd').onclick = e => withBusy(e.currentTarget, async () => {
  memberError('');
  const username = $('muName').value.trim();
  const password = $('muPass').value;
  if (!username || !password) {
    memberError('A username and a starting password are both needed.');
    return;
  }
  try {
    const made = await api('/users', json('POST', {
      username,
      password,
      display_name: $('muDisplay').value.trim() || null,
      role: $('muRole').value,
    }));
    ok(`Added ${made.username}.`);
    ['muName', 'muDisplay', 'muPass'].forEach(id => { $(id).value = ''; });
    loadMembers();
  } catch (err) { memberError(err.message); }
});

['muName', 'muDisplay', 'muPass'].forEach(id => {
  $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('muAdd').click(); }
  });
});

/* ---------- when and where ---------- */

/** An ISO instant to what <input type="datetime-local"> wants, in the
 *  organiser's own timezone -- the value is naive local time, so converting in
 *  UTC would show a race starting five and a half hours early. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fillSchedule() {
  $('schCredit').value = ev.photo_credit || '';
  $('schPhotoPreview').hidden = !ev.photo_url;
  if (ev.photo_url) $('schPhotoImg').src = ev.photo_url;
  $('schPhotoClear').hidden = !ev.photo_url;
  $('schWhen').value = toLocalInput(ev.starts_at);
  $('schWhere').value = ev.location || '';
  $('schAbout').value = ev.description || '';
  $('schEntry').value = ev.entry_note || '';
  $('schPublished').checked = Boolean(ev.is_published);
  $('schOpen').checked = Boolean(ev.registration_open);
}

function photoError(msg, plain = false) {
  const el = $('photoErr');
  el.textContent = msg || '';
  el.hidden = !msg;
  el.classList.toggle('plain', plain);
}

$('savePhoto').onclick = e => withBusy(e.currentTarget, async () => {
  photoError('');
  try {
    if ($('schPhoto').files[0]) {
      const fd = new FormData();
      fd.append('file', await fitImageForUpload($('schPhoto').files[0],
                                                m => photoError(m, true)));
      ev = await api(`/events/${ev.code}/photo`, { method: 'POST', body: fd });
      $('schPhoto').value = '';
    }
    // The credit rides on the schedule endpoint, which is where the field
    // lives; sending it separately keeps one source of truth for the event.
    ev = await api(`/events/${ev.code}/schedule`, json('PATCH', {
      photo_credit: $('schCredit').value.trim() || null,
    }));
    fillSchedule();
    ok('Race photo saved.');
  } catch (err) { photoError(err.message); }
});

$('schPhotoClear').onclick = async () => {
  if (!await confirmDialog({
    title: 'Remove the race photo?',
    body: 'The listing falls back to a plain card until another is uploaded.',
    confirm: 'Remove',
  })) return;
  try {
    ev = await api(`/events/${ev.code}/photo`, { method: 'DELETE' });
    fillSchedule();
    photoError('');
    ok('Photo removed.');
  } catch (err) { photoError(err.message); }
};

$('schSave').onclick = e => withBusy(e.currentTarget, async () => {
  $('schErr').hidden = true;
  $('schErr').classList.remove('plain');
  if ($('schOpen').checked && !$('schPublished').checked) {
    $('schErr').textContent =
      'Entries cannot open on a race nobody can see. Tick "Show on the home page" too.';
    $('schErr').hidden = false;
    return;
  }
  try {
    // The input gives naive local time; new Date reads it as local and
    // toISOString converts, so the stored instant is right wherever it is read.
    const when = $('schWhen').value;
    ev = await api(`/events/${ev.code}/schedule`, json('PATCH', {
      starts_at: when ? new Date(when).toISOString() : null,
      location: $('schWhere').value.trim() || null,
      description: $('schAbout').value.trim() || null,
      entry_note: $('schEntry').value.trim() || null,
      is_published: $('schPublished').checked,
      registration_open: $('schOpen').checked,
    }));
    fillSchedule();
    ok($('schPublished').checked
      ? 'Saved. The race is on the home page.'
      : 'Saved. The race is not shown publicly yet.');
  } catch (err) {
    $('schErr').textContent = err.message;
    $('schErr').hidden = false;
  }
});

/* ---------- entries ---------- */

const ENTRY_TONE = {
  pending: ['wait', 'waiting'],
  confirmed: ['go', 'confirmed'],
  withdrawn: ['', 'withdrawn'],
  rejected: ['stop', 'not accepted'],
};

function entryError(msg) {
  const el = $('entryErr');
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function loadEntries() {
  if (!ev) return;
  const tb = $('entryList');
  tb.innerHTML = skeletonRows(7, 4);
  let rows;
  try {
    rows = await api(`/events/${ev.code}/registrations`);
  } catch (e) {
    tb.innerHTML = emptyState(7, 'Could not load the entries', e.message);
    return;
  }

  const live = rows.filter(r => r.status === 'pending' || r.status === 'confirmed');
  $('nEntries').textContent = live.length || '';

  if (!rows.length) {
    tb.innerHTML = emptyState(7, 'Nobody has entered through the website yet',
      'Open entries under "When and where", then share the home page.');
    return;
  }

  tb.innerHTML = rows.map(r => {
    const [tone, label] = ENTRY_TONE[r.status] || ['', r.status];
    const bibField = `<input class="num bibin" data-bibfor="${r.id}"
        value="${esc(r.bib || '')}" placeholder="bib" inputmode="numeric">`;
    // A virtual entry has no bib and no start list; what an organiser needs to
    // see instead is how far they have got and whether they have paid. Both
    // ride in the cells that are already there rather than widening a table
    // that an ordinary race would then carry two empty columns of.
    const owes = (r.amount_paise || 0) > 0;
    const PAY_TONE = {
      unpaid: ['stop', 'Not paid'],
      claimed: ['wait', 'Says paid'],
      paid: ['go', 'Paid'],
      waived: ['go', 'Waived'],
    };
    const [payTone, payLabel] = PAY_TONE[r.payment_status] || ['', r.payment_status];
    return `<tr>
      <td><strong>${esc(r.runner || r.username || '')}</strong>
        <div class="note tight">${esc(r.username || '')}</div>
        ${r.is_virtual && r.ship_address
          ? `<div class="note tight">${esc(r.ship_address)}${
              r.ship_phone ? ' \u00b7 ' + esc(r.ship_phone) : ''}</div>` : ''}</td>
      <td>${esc(r.race || '—')}
        ${r.is_virtual ? `<div class="note tight">${
          r.done_km.toFixed(2)} / ${r.target_km} km${
          r.runs_flagged ? ' \u00b7 ' + r.runs_flagged + ' queried' : ''}${
          r.certificate_ready ? ' \u00b7 finished' : ''}</div>` : ''}</td>
      <td>${esc([r.category, r.gender].filter(Boolean).join(' · ') || '—')}</td>
      <td class="note tight">${esc(r.email || '')}<br>${esc(r.phone || '')}
        ${r.emergency_contact
          ? `<br><span class="tag">ICE: ${esc(r.emergency_contact)}</span>` : ''}</td>
      <td><span class="tag ${tone}">${esc(label)}</span>
        ${r.is_virtual && owes
          ? `<div><span class="tag ${payTone}">${esc(payLabel)}</span></div>
             ${r.payment_ref
               ? `<div class="note tight">ref ${esc(r.payment_ref)}</div>` : ''}`
          : r.is_virtual ? '<div class="note tight">free entry</div>' : ''}</td>
      <td class="num">${r.is_virtual
        ? '<span class="note tight">—</span>'
        : (r.status === 'confirmed' ? esc(r.bib || '') : bibField)}</td>
      <td class="num">
        ${r.is_virtual && owes && !['paid', 'waived'].includes(r.payment_status)
          ? `<button class="quiet" data-paid="${r.id}">Mark paid</button>
             <button class="quiet" data-waive="${r.id}">Waive</button>` : ''}
        ${r.status !== 'confirmed'
          ? `<button class="quiet" data-confirm="${r.id}">Confirm</button>` : ''}
        ${r.status === 'pending'
          ? `<button class="quiet danger" data-reject="${r.id}">Reject</button>` : ''}
        ${r.status === 'confirmed'
          ? `<button class="quiet danger" data-remove="${r.id}">Remove</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  const decide = async (id, body) => {
    entryError('');
    try {
      await api(`/registrations/${id}`, json('PATCH', body));
      loadEntries();
      loadRoster();       // a confirmed entry is a new name on the start list
    } catch (e) { entryError(e.message); }
  };

  tb.querySelectorAll('[data-confirm]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.confirm;
      const field = tb.querySelector(`[data-bibfor="${id}"]`);
      const bib = field ? field.value.trim() : '';
      // A virtual race has no start line to identify anybody at, so there is
      // no bib to insist on.
      if (!field) { decide(id, { status: 'confirmed' }); return; }
      if (!bib) {
        entryError('Type a bib number next to them first — confirming is what '
          + 'puts them on the start list.');
        if (field) field.focus();
        return;
      }
      decide(id, { status: 'confirmed', bib });
    };
  });
  const settle = async (id, payment_status) => {
    entryError('');
    try {
      await api(`/registrations/${id}/payment`, json('PATCH', { payment_status }));
      ok(payment_status === 'waived' ? 'Entry fee waived.' : 'Marked paid.');
      loadEntries();
    } catch (e) { entryError(e.message); }
  };
  tb.querySelectorAll('[data-paid]').forEach(b => {
    b.onclick = () => settle(b.dataset.paid, 'paid');
  });
  tb.querySelectorAll('[data-waive]').forEach(b => {
    b.onclick = async () => {
      if (!await confirmDialog({
        title: 'Waive this entry fee?',
        body: 'They owe nothing and can have their certificate as soon as they '
            + 'finish the distance.',
        confirm: 'Waive',
      })) return;
      settle(b.dataset.waive, 'waived');
    };
  });
  tb.querySelectorAll('[data-reject]').forEach(b => {
    b.onclick = () => decide(b.dataset.reject, { status: 'rejected' });
  });
  tb.querySelectorAll('[data-remove]').forEach(b => {
    b.onclick = async () => {
      if (!await confirmDialog({
        title: 'Take them off the start list?',
        body: 'Their bib is released and the entry goes back to waiting. '
            + 'Anything they have already been scanned for is kept.',
        confirm: 'Remove',
      })) return;
      decide(b.dataset.remove, { status: 'pending' });
    };
  });
}

/* ---------- workshops ---------- */

const WS_STATUS = {
  registered: ['go', 'has a place'],
  waitlisted: ['wait', 'waiting'],
  attended: ['go', 'attended'],
  cancelled: ['', 'cancelled'],
  no_show: ['stop', 'did not come'],
};

function wsError(msg) {
  const el = $('wsErr');
  el.textContent = msg || '';
  el.hidden = !msg;
}

$('wsMode').onchange = () => {
  const online = $('wsMode').value === 'online';
  $('wsLinkWrap').hidden = !online;
  $('wsVenueWrap').hidden = online;
};

async function loadWorkshops() {
  const host = $('wsList');
  host.innerHTML = '<p class="note">Loading…</p>';
  let rows;
  try {
    rows = await api('/workshops');
  } catch (e) {
    host.innerHTML = `<p class="note">${esc(e.message)}</p>`;
    return;
  }
  $('nWorkshops').textContent = rows.length || '';

  if (!rows.length) {
    host.innerHTML = '<div class="empty"><div class="t">No workshops yet</div>'
      + '<div class="h">Add one below. A free session is the easiest way to '
      + 'turn a runner into a member.</div></div>';
    return;
  }

  host.innerHTML = rows.map(w => `
    <article class="runcard" data-ws="${esc(w.slug)}">
      <div class="runhead">
        <div>
          <h3>${esc(w.title)}</h3>
          <p class="note">${esc([
            w.starts_at ? new Date(w.starts_at).toLocaleString() : 'No date yet',
            w.mode === 'online' ? 'Online' : (w.venue || 'In person'),
            w.host_name,
          ].filter(Boolean).join(' · '))}</p>
        </div>
        <span class="tag ${w.is_published ? 'go' : ''}">${
          w.is_published ? 'published' : 'draft'}</span>
      </div>
      <div class="runbody">
        <div class="runmeta">
          <span class="tag">${w.places_taken} signed up</span>
          ${w.capacity ? `<span class="tag">${w.places_left} of ${w.capacity} left</span>` : ''}
          ${w.waitlisted ? `<span class="tag wait">${w.waitlisted} waiting</span>` : ''}
        </div>
      </div>
      <div class="runacts">
        <button class="quiet" data-people="${esc(w.slug)}">Who is coming</button>
        <button class="quiet" data-pub="${esc(w.slug)}" data-to="${!w.is_published}">
          ${w.is_published ? 'Unpublish' : 'Publish'}</button>
        <button class="quiet" data-open="${esc(w.slug)}" data-to="${!w.registration_open}">
          ${w.registration_open ? 'Close registration' : 'Reopen registration'}</button>
        <button class="quiet danger" data-del="${esc(w.slug)}">Delete</button>
      </div>
      <div class="wspeople" data-list="${esc(w.slug)}" hidden></div>
    </article>`).join('');

  const patch = async (slug, body) => {
    wsError('');
    try {
      await api(`/workshops/${encodeURIComponent(slug)}`, json('PATCH', body));
      loadWorkshops();
    } catch (e) { wsError(e.message); }
  };

  host.querySelectorAll('[data-pub]').forEach(b => {
    b.onclick = () => patch(b.dataset.pub, { is_published: b.dataset.to === 'true' });
  });
  host.querySelectorAll('[data-open]').forEach(b => {
    b.onclick = () => patch(b.dataset.open, { registration_open: b.dataset.to === 'true' });
  });
  host.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      if (!await confirmDialog({
        title: 'Delete this workshop?',
        body: 'It disappears for everyone. A workshop somebody has already '
            + 'attended cannot be deleted — unpublish it instead.',
        confirm: 'Delete',
      })) return;
      wsError('');
      try {
        await api(`/workshops/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
        loadWorkshops();
      } catch (e) { wsError(e.message); }
    };
  });
  host.querySelectorAll('[data-people]').forEach(b => {
    b.onclick = () => showWorkshopPeople(b.dataset.people);
  });
}

async function showWorkshopPeople(slug) {
  const box = document.querySelector(`[data-list="${CSS.escape(slug)}"]`);
  if (!box) return;
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '<p class="note">Loading…</p>';

  let rows;
  try {
    rows = await api(`/workshops/${encodeURIComponent(slug)}/registrations`);
  } catch (e) {
    box.innerHTML = `<p class="note">${esc(e.message)}</p>`;
    return;
  }
  if (!rows.length) {
    box.innerHTML = '<p class="note">Nobody has signed up yet.</p>';
    return;
  }

  box.innerHTML = `<p class="note tight">Tick people off as they arrive. That is
    what gives them their participation certificate.</p>
    <table class="roster"><tbody>` + rows.map(r => {
    const [tone, label] = WS_STATUS[r.status] || ['', r.status];
    return `<tr>
      <td><strong>${esc(r.runner || r.username || '')}</strong>
        <div class="note tight">${esc(r.email || '')}</div></td>
      <td><span class="tag ${tone}">${esc(label)}</span></td>
      <td class="num">
        ${r.status !== 'attended'
          ? `<button class="quiet" data-att="${r.id}" data-slug="${esc(slug)}">Came</button>` : ''}
        ${r.status === 'attended'
          ? `<button class="quiet" data-att="${r.id}" data-slug="${esc(slug)}"
                data-back="1">Undo</button>` : ''}
        ${!['cancelled', 'no_show'].includes(r.status)
          ? `<button class="quiet danger" data-miss="${r.id}" data-slug="${esc(slug)}">Absent</button>` : ''}
      </td>
    </tr>`;
  }).join('') + '</tbody></table>';

  const mark = async (id, status, slugAgain) => {
    try {
      await api(`/workshop-registrations/${id}`, json('PATCH', { status }));
      box.hidden = true;
      await loadWorkshops();
      showWorkshopPeople(slugAgain);
    } catch (e) { wsError(e.message); }
  };
  box.querySelectorAll('[data-att]').forEach(b => {
    b.onclick = () => mark(b.dataset.att,
      b.dataset.back ? 'registered' : 'attended', b.dataset.slug);
  });
  box.querySelectorAll('[data-miss]').forEach(b => {
    b.onclick = () => mark(b.dataset.miss, 'no_show', b.dataset.slug);
  });
}

$('wsAdd').onclick = e => withBusy(e.currentTarget, async () => {
  wsError('');
  const title = $('wsTitle').value.trim();
  if (!title) { wsError('Give the workshop a title.'); return; }
  const when = $('wsWhen').value;
  const cap = parseInt($('wsCap').value.trim(), 10);
  const mins = parseInt($('wsMins').value.trim(), 10);
  try {
    await api('/workshops', json('POST', {
      title,
      description: $('wsDesc').value.trim() || null,
      starts_at: when ? new Date(when).toISOString() : null,
      duration_minutes: Number.isFinite(mins) ? mins : null,
      mode: $('wsMode').value,
      venue: $('wsMode').value === 'in_person'
        ? ($('wsVenue').value.trim() || null) : null,
      meeting_link: $('wsMode').value === 'online'
        ? ($('wsLink').value.trim() || null) : null,
      host_name: $('wsHost').value.trim() || null,
      capacity: Number.isFinite(cap) ? cap : null,
      is_published: false,
    }));
    ['wsTitle', 'wsDesc', 'wsWhen', 'wsVenue', 'wsLink', 'wsHost', 'wsCap']
      .forEach(id => { $(id).value = ''; });
    ok('Created as a draft. Publish it when you are ready.');
    $('wsNewWrap').open = false;
    loadWorkshops();
  } catch (err) { wsError(err.message); }
});

/* ---------- messages ---------- */

async function loadMessages() {
  const host = $('messageList');
  host.innerHTML = '<p class="note">Loading…</p>';

  try {
    const mailState = await api('/mail/status');
    const el = $('mailState');
    // Keeping messages in the app rather than forwarding them is the chosen
    // arrangement here, not a gap. The banner should not read like a warning.
    if (mailState.configured) {
      el.hidden = false;
      el.textContent = `Messages arrive here, and a copy is emailed to `
        + `${mailState.to}. Runners are emailed too, when you confirm an `
        + `entry, mark a payment received, reject a run, or they finish a `
        + `distance.`;
    } else {
      el.hidden = false;
      // An organiser who thinks entrants are being told things that nobody is
      // telling them will not chase people who are waiting to hear.
      el.textContent = 'Messages arrive here. Email is not set up, so '
        + 'nothing is sent out either — runners are not told when you '
        + 'confirm their entry, mark a payment received, reject a run or they '
        + 'finish a distance. The app always shows them the truth; they have '
        + 'to come and look. Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD to '
        + 'change that.';
    }
  } catch { /* the list matters more than the banner */ }

  let rows;
  try {
    rows = await api('/messages');
  } catch (e) {
    host.innerHTML = `<p class="note">${esc(e.message)}</p>`;
    return;
  }

  const open = rows.filter(m => !m.handled).length;
  $('nMessages').textContent = open || '';

  if (!rows.length) {
    host.innerHTML = '<div class="empty"><div class="t">No messages</div>'
      + '<div class="h">The form on the home page arrives here.</div></div>';
    return;
  }

  host.innerHTML = rows.map(m => `
    <article class="runcard ${m.handled ? 'done' : ''}">
      <div class="runhead">
        <div>
          <h3>${esc(m.subject)}</h3>
          <p class="note">${esc(m.name)} &lt;${esc(m.email)}&gt;
            ${m.username ? `<span class="tag">${esc(m.username)}</span>` : ''}
            · ${esc(new Date(m.created_at).toLocaleString())}</p>
        </div>
        <span class="tag ${m.emailed ? 'go' : ''}">${m.emailed ? 'emailed' : 'stored'}</span>
      </div>
      <p style="white-space:pre-wrap;margin:.8rem 0 0">${esc(m.body)}</p>
      <div class="runacts">
        <a href="mailto:${esc(m.email)}?subject=${encodeURIComponent('Re: ' + m.subject)}">Reply</a>
        <button class="quiet" data-handled="${m.id}" data-to="${m.handled ? 'false' : 'true'}">
          ${m.handled ? 'Mark unread' : 'Mark done'}</button>
      </div>
    </article>`).join('');

  host.querySelectorAll('[data-handled]').forEach(b => {
    b.onclick = async () => {
      try {
        await api(`/messages/${b.dataset.handled}?handled=${b.dataset.to}`,
                  { method: 'PATCH' });
        loadMessages();
      } catch (e) { fail(e.message); }
    };
  });
}

/* ---------- visitors ---------- */

const pct = (n, max) => (max ? Math.max(2, Math.round((n / max) * 100)) : 0);

function rows(tbody, items, label, value, empty) {
  const tb = $(tbody);
  if (!items.length) {
    tb.innerHTML = `<tr><td class="note">${esc(empty)}</td></tr>`;
    return;
  }
  const max = items[0][value];
  tb.innerHTML = items.map(i => `
    <tr>
      <td>${esc(String(i[label]))}</td>
      <td class="num">${i[value]}</td>
      <td class="barcell"><span style="width:${pct(i[value], max)}%"></span></td>
    </tr>`).join('');
}

async function loadAnalytics() {
  const days = $('anDays').value;
  $('anTotals').innerHTML = '';
  let a;
  try {
    a = await api(`/analytics?days=${days}`);
  } catch (e) {
    $('anTotals').innerHTML = `<div class="score"><span class="k">${esc(e.message)}</span></div>`;
    return;
  }

  const perDay = a.days ? (a.views / a.days) : 0;
  $('anTotals').innerHTML = [
    { v: a.views, k: a.views === 1 ? 'visit' : 'visits' },
    { v: a.visitors, k: a.visitors === 1 ? 'person' : 'people' },
    { v: perDay.toFixed(perDay < 10 ? 1 : 0), k: 'visits a day' },
  ].map(c => `<div class="score"><span class="v">${esc(String(c.v))}</span>` +
             `<span class="k">${esc(c.k)}</span></div>`).join('');

  // Days
  const maxDay = Math.max(1, ...a.daily.map(d => d.views));
  $('anDaily').innerHTML = a.daily.map(d => {
    const when = new Date(d.date + 'T00:00:00');
    return `<div class="bar" title="${esc(d.date)}: ${d.views} visits, ${d.visitors} people">
        <span class="fill" style="height:${pct(d.views, maxDay)}%"></span>
        <span class="lab">${when.getDate()}</span>
      </div>`;
  }).join('');

  // Hours. The server counts in UTC; shift into whatever this browser is in,
  // because "busiest at 03:00" is meaningless when the race was at 09:00.
  const shift = -new Date().getTimezoneOffset() / 60;
  const local = new Array(24).fill(0);
  a.hours.forEach((n, h) => {
    local[((h + Math.round(shift)) % 24 + 24) % 24] += n;
  });
  const maxHour = Math.max(1, ...local);
  $('anHours').innerHTML = local.map((n, h) => `
      <div class="bar" title="${String(h).padStart(2, '0')}:00 — ${n} visits">
        <span class="fill" style="height:${pct(n, maxHour)}%"></span>
        <span class="lab">${h % 6 === 0 ? String(h).padStart(2, '0') : ''}</span>
      </div>`).join('');

  rows('anRaces', a.races, 'code', 'views',
       'No race pages opened yet in this period.');
  rows('anPages', a.pages, 'path', 'views', 'Nothing yet.');
  rows('anRefs', a.referrers, 'host', 'views',
       'Everyone arrived directly — typed in, or from a WhatsApp link, which sends no referrer.');
  rows('anDevices', a.devices, 'device', 'views', 'Nothing yet.');
  $('anRetention').textContent = a.retention_days;
}

$('anDays').onchange = loadAnalytics;
$('anReload').onclick = e => withBusy(e.currentTarget, loadAnalytics);

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

/* ---------- start ----------

   Identity first. Everything else -- which tabs exist, whether the create-race
   form is offered -- depends on who this is, and asking afterwards would show
   an admin a super admin's screen for a moment before taking it away. */

mountPicker($('wallpaper'));

(async () => {
  try {
    me = await api('/auth/me');
  } catch {
    return;            // api() has already redirected to the sign-in page
  }
  renderAccount();
  $('ops').hidden = false;

  // A fresh account is sent straight here by the sign-in page.
  if (location.hash === '#!password') {
    showTab('account', { push: false });
    $('chooser').hidden = true;
    $('pwCurrent').focus();
    // Fill the picker anyway. Returning here left it on "Loading…" for anyone
    // who then moved to another screen without reloading the page.
    loadEventPicker('');
    return;
  }

  const at = parseHash();
  loadEventPicker(at.code);
  if (at.code) load(at.code, at.tab);
  else showTab(at.tab || 'account', { push: false });
})();

// Back and forward should move between tabs, not silently do nothing.
window.addEventListener('hashchange', () => {
  const now = parseHash();
  // "#!members", "#!analytics", "#!account" carry no race. Bailing out when
  // there was no code made those three unreachable by URL, and broke back and
  // forward between them.
  if (!now.code) {
    if (now.tab && now.tab !== tab) showTab(now.tab, { push: false });
    return;
  }
  if (!ev || ev.code !== now.code) { load(now.code, now.tab); return; }
  if (now.tab && now.tab !== tab) showTab(now.tab, { push: false });
});


/* ---------- virtual races ----------

   An event with a flag, not a second kind of thing. The settings live here
   because they are about how the race is run and paid for; the distances and
   their prices are the races already added under Races. */

let vrSetup = null;
let vrRuns = [];

const vrError = (m, quiet = false) => {
  $('vrErr').textContent = m || '';
  $('vrErr').hidden = !m;
  $('vrErr').classList.toggle('note', quiet);
};

/* The window uses the same `toLocalInput` the schedule panel does: a
   datetime-local box speaks local wall time with no zone and the API speaks
   UTC, and a second copy of that conversion is a second place to get it
   wrong. Declaring one here shadowed nothing -- it was a duplicate `const` in
   the same module scope, which is a SyntaxError, and it took the entire admin
   screen down until the browser suite caught it. */

const RUN_FLAG_WORDS = {
  'no-evidence': 'no screenshot',
  'fast': 'pace nobody holds',
  'long': 'longer than the whole race',
  'duplicate': 'same run twice?',
};

async function loadVirtual() {
  if (!ev) return;
  vrError('');
  try {
    vrSetup = await api(`/events/${ev.code}/virtual`);
  } catch (e) { vrError(e.message); return; }

  $('vrOn').checked = !!vrSetup.is_virtual;
  $('vrBody').hidden = !vrSetup.is_virtual;
  $('nVirtual').textContent = vrSetup.is_virtual ? '\u2713' : '';
  $('vrEnds').value = toLocalInput(vrSetup.ends_at);
  $('vrOpens').textContent = vrSetup.starts_at
    ? 'It opens on ' + new Date(vrSetup.starts_at).toLocaleString()
      + ', which is the date under "When and where".'
    : 'Set the opening date under "When and where" first \u2014 runs before it '
      + 'are refused, and with no date nothing is.';
  $('vrUpi').value = vrSetup.upi_id || '';
  $('vrUpiName').value = vrSetup.upi_name || '';
  $('vrNote').value = vrSetup.payment_note || '';
  $('vrQrPreview').hidden = !vrSetup.payment_qr_url;
  if (vrSetup.payment_qr_url) $('vrQrImg').src = vrSetup.payment_qr_url;

  $('vrPrices').innerHTML = (vrSetup.races || []).length
    ? vrSetup.races.map(r => `<tr>
        <td>${esc(r.name)}</td>
        <td class="num">${r.distance_km}</td>
        <td class="num"><input class="num" data-price="${r.id}" type="number"
            min="0" step="1" inputmode="numeric"
            value="${(r.price_paise || 0) / 100}"></td>
      </tr>`).join('')
    : '<tr><td class="empty">Add the distances under Races first.</td></tr>';

  await loadVirtualRuns();
}

async function loadVirtualRuns() {
  const all = $('vrAllRuns').checked;
  try {
    vrRuns = await api(`/events/${ev.code}/runs`
      + (all ? '' : '?status=flagged'));
  } catch (e) { vrError(e.message); return; }
  $('nFlagged').textContent =
    (all ? vrRuns.filter(r => r.status === 'flagged') : vrRuns).length || '';

  if (!vrRuns.length) {
    $('vrRuns').innerHTML =
      '<div class="empty"><div class="t">'
      + (all ? 'No runs logged yet' : 'Nothing to look at')
      + '</div><div class="h">'
      + (all ? 'They appear as people send them in.'
             : 'Every run so far looked fine.')
      + '</div></div>';
    return;
  }

  $('vrRuns').innerHTML = vrRuns.map(r => {
    const why = (r.flags || []).map(f => RUN_FLAG_WORDS[f] || f).join(', ');
    const tag = r.status === 'rejected'
      ? '<span class="tag no">Rejected</span>'
      : r.status === 'flagged'
        ? '<span class="tag wait">Queried</span>'
        : '<span class="tag go">Counted</span>';
    return `<article class="runrow">
      <div class="runmain">
        <div class="runkm">${r.distance_km} km</div>
        <div>
          <div class="runwhen">${esc(r.runner || '')}</div>
          <div class="note tight">${esc(r.ran_on)}${
            r.duration_seconds ? ' \u00b7 ' + Math.round(r.duration_seconds / 60)
              + ' min' : ' \u00b7 no time'}${
            r.note ? ' \u00b7 ' + r.note : ''}</div>
          ${why ? `<div class="note tight">Queried: ${esc(why)}</div>` : ''}
        </div>
      </div>
      <div class="runacts">
        ${tag}
        ${r.evidence_url
          ? `<a href="${esc(r.evidence_url)}" target="_blank"
                rel="noopener noreferrer">Screenshot</a>`
          : '<span class="note tight">no screenshot</span>'}
        ${r.status !== 'accepted'
          ? `<button class="quiet" data-ok="${r.id}">Count it</button>` : ''}
        ${r.status !== 'rejected'
          ? `<button class="quiet danger" data-no="${r.id}">Reject</button>` : ''}
      </div>
    </article>`;
  }).join('');

  const decide = async (id, status) => {
    vrError('');
    try {
      await api(`/runs/${id}`, json('PATCH', { status }));
      ok(status === 'rejected'
        ? 'Rejected. It comes off their total.'
        : 'Counted.');
      await loadVirtualRuns();
      if (tab === 'entries') loadEntries();
    } catch (e) { vrError(e.message); }
  };
  $('vrRuns').querySelectorAll('[data-ok]').forEach(b => {
    b.onclick = () => decide(b.dataset.ok, 'accepted');
  });
  $('vrRuns').querySelectorAll('[data-no]').forEach(b => {
    b.onclick = async () => {
      if (!await confirmDialog({
        title: 'Reject this run?',
        body: 'The distance comes off their total. The submission is kept, so '
            + 'you can count it later if they explain it.',
        confirm: 'Reject',
      })) return;
      decide(b.dataset.no, 'rejected');
    };
  });
}

$('vrAllRuns').onchange = () => loadVirtualRuns();

$('vrOn').onchange = async () => {
  vrError('');
  try {
    vrSetup = await api(`/events/${ev.code}/virtual`,
                        json('PATCH', { is_virtual: $('vrOn').checked }));
    ok($('vrOn').checked
      ? 'This is a virtual race now. Set the window and the prices.'
      : 'Back to an ordinary race.');
    loadVirtual();
  } catch (e) {
    // The server refuses to un-virtual a race people have entered, so put the
    // tick back where it was rather than leaving the screen lying.
    $('vrOn').checked = !!(vrSetup && vrSetup.is_virtual);
    vrError(e.message);
  }
};

$('vrSave').onclick = e => withBusy(e.currentTarget, async () => {
  vrError('');
  try {
    if ($('vrQr').files[0]) {
      const fd = new FormData();
      fd.append('file', await fitImageForUpload($('vrQr').files[0],
                                                m => vrError(m, true)));
      await api(`/events/${ev.code}/payment-qr`, { method: 'POST', body: fd });
      $('vrQr').value = '';
    }
    // Prices belong to the races, so they are saved as races -- and only the
    // ones that actually changed, so a stray enter does not rewrite them all.
    for (const input of document.querySelectorAll('[data-price]')) {
      const race = (vrSetup.races || [])
        .find(r => String(r.id) === input.dataset.price);
      const paise = Math.round(Number(input.value || 0) * 100);
      if (!race || paise === (race.price_paise || 0)) continue;
      if (paise < 0) { vrError('A price cannot be negative.'); return; }
      await api(`/races/${race.id}`, json('PATCH', { price_paise: paise }));
    }
    vrSetup = await api(`/events/${ev.code}/virtual`, json('PATCH', {
      ends_at: $('vrEnds').value
        ? new Date($('vrEnds').value).toISOString() : null,
      upi_id: $('vrUpi').value.trim() || null,
      upi_name: $('vrUpiName').value.trim() || null,
      payment_note: $('vrNote').value.trim() || null,
    }));
    await load(ev.code);        // the races carry new prices now
    showTab('virtual', { push: false });
    ok('Virtual settings saved.');
  } catch (err) { vrError(err.message); }
});

$('vrQrClear').onclick = async () => {
  if (!await confirmDialog({
    title: 'Remove the payment QR?',
    body: 'Entrants will see your UPI id but have nothing to scan.',
    confirm: 'Remove',
  })) return;
  try {
    await api(`/events/${ev.code}/payment-qr`, { method: 'DELETE' });
    ok('QR removed.');
    loadVirtual();
  } catch (e) { vrError(e.message); }
};

$('vrCsv').onclick = e => withBusy(e.currentTarget, async () => {
  vrError('');
  try {
    const res = await fetch(`/api/events/${ev.code}/shipping.csv`);
    if (!res.ok) throw new Error('That list could not be downloaded.');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${ev.code}-shipping.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    ok('Downloaded.');
  } catch (err) { vrError(err.message); }
});


/* ---------- the checkpoint code ----------

   Off unless an organiser turns it on. A stranger's fake scan is noise voided
   from the Reads tab in seconds; a volunteer at a junction who cannot send is
   a race with no results. So the open path stays, and this is the door for
   anybody who wants it shut. */

const keyError = m => {
  $('keyErr').textContent = m || '';
  $('keyErr').hidden = !m;
};

async function loadDeviceKey() {
  if (!ev) return;
  keyError('');
  let info;
  try {
    info = await api(`/events/${ev.code}/device-key`);
  } catch (e) { keyError(e.message); return; }

  $('keyState').textContent = info.required
    ? 'Only phones that have been given the code can send scans to this race.'
    : 'Any phone with the capture link can send scans to this race. That is '
      + 'usually what you want on race day \u2014 turn a code on if you would '
      + 'rather only your own volunteers could.';
  $('keyShow').hidden = !info.required;
  $('keyValue').textContent = info.key || '';
  $('keyOn').hidden = info.required;
  $('keyRoll').hidden = !info.required;
  $('keyOff').hidden = !info.required;
}

$('keyOn').onclick = e => withBusy(e.currentTarget, async () => {
  keyError('');
  try {
    const info = await api(`/events/${ev.code}/device-key`, { method: 'POST' });
    ok(`The code is ${info.key}. Volunteers type it once on the capture screen.`);
    loadDeviceKey();
  } catch (err) { keyError(err.message); }
});

$('keyRoll').onclick = async () => {
  if (!await confirmDialog({
    title: 'Give this race a new code?',
    body: 'Every phone already scanning stops being able to send until the new '
        + 'code is typed in. Their scans are kept and go up afterwards. Do this '
        + 'if the old code has got out, not in the middle of a race.',
    confirm: 'New code',
  })) return;
  try {
    const info = await api(`/events/${ev.code}/device-key`, { method: 'POST' });
    ok(`The new code is ${info.key}.`);
    loadDeviceKey();
  } catch (err) { keyError(err.message); }
};

$('keyOff').onclick = async () => {
  if (!await confirmDialog({
    title: 'Let any phone send scans again?',
    body: 'Anybody with the capture link and this race code will be able to '
        + 'post scans. They are all visible in Reads and any of them can be '
        + 'voided, but nothing will stop them arriving.',
    confirm: 'Stop requiring it',
  })) return;
  try {
    await api(`/events/${ev.code}/device-key`, { method: 'DELETE' });
    ok('Open scanning again.');
    loadDeviceKey();
  } catch (err) { keyError(err.message); }
};
