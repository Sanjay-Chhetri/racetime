/* The landing page.

   Almost everyone who opens RaceTime is a runner or someone watching one, and
   they want one of two things: the live board, or their certificate. The page
   used to offer five identical panels in the order the screens were built, with
   "Race admin" above both. The organiser tools are behind a sign-in now -- they
   are a handful of people, once per event, and they know where they are going. */

import { esc, ok, withBusy } from '/js/ui.js';
import { mountPicker } from '/js/theme.js';

const $ = id => document.getElementById(id);

/* ---------- races ---------- */

let races = [];

async function loadRaces() {
  const sel = $('racePick');
  try {
    // Code and name only, and unauthenticated, so this fills whether or not
    // the server is holding an admin token.
    races = await fetch('/api/events/public').then(r => r.json());
  } catch {
    sel.innerHTML = '<option value="">Could not reach the timing server</option>';
    $('pickNote').textContent = 'Check your connection and reload.';
    return;
  }
  if (!Array.isArray(races) || !races.length) {
    sel.innerHTML = '<option value="">No races yet</option>';
    $('pickNote').textContent = 'Nothing has been set up on this server yet.';
    return;
  }
  sel.innerHTML = '<option value="">Choose a race…</option>' +
    races.map(r => `<option value="${esc(r.code)}">${esc(r.name)}</option>`).join('');

  // One race on the server means there is nothing to choose.
  if (races.length === 1) {
    sel.value = races[0].code;
    syncButtons();
  }
}

function syncButtons() {
  const chosen = !!$('racePick').value;
  $('goResults').disabled = !chosen;
  $('goCert').disabled = !chosen;
  $('pickNote').textContent = chosen ? '' : 'Pick a race to continue.';
}

$('racePick').onchange = syncButtons;

$('goResults').onclick = () => go('/results.html#');
$('goCert').onclick = () => go('/certificate.html#');

function go(prefix) {
  const code = $('racePick').value;
  if (!code) return;
  remember(code);
  location.href = prefix + encodeURIComponent(code);
}

/* ---------- recently opened ----------
   A spectator checks back all morning. This is a per-browser convenience, so
   it lives in localStorage and the page must work without it. */

const RECENT_KEY = 'racetime.recent';

function readRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.slice(0, 3) : [];
  } catch { return []; }
}

function remember(code) {
  try {
    const next = [code, ...readRecent().filter(c => c !== code)].slice(0, 3);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* private window, or storage is full -- not worth failing over */ }
}

function renderRecent() {
  const codes = readRecent().filter(c => races.some(r => r.code === c));
  if (!codes.length) return;
  $('recentList').innerHTML = codes.map(c => {
    const r = races.find(x => x.code === c);
    return `<a class="recentcard" href="/results.html#${encodeURIComponent(c)}">
        <span class="rn">${esc(r.name)}</span>
        <span class="rc">Live results</span>
      </a>`;
  }).join('');
  $('recent').hidden = false;
}

/* ---------- upcoming races ----------

   The list is public, so a spectator or a prospective entrant sees what is
   coming without an account. Entering needs one, and the button leads there
   rather than letting somebody fill in a form that will be refused. */

let me = null;          // null when signed out
let upcoming = [];

const fmtDate = iso => iso
  ? new Date(iso).toLocaleDateString(undefined,
      { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
  : 'Date to be announced';

const ENTRY_LABEL = {
  pending: 'Entry sent',
  confirmed: 'You are in',
  withdrawn: 'Withdrawn',
  rejected: 'Not accepted',
};

async function loadUpcoming() {
  try {
    upcoming = await fetch('/api/events/upcoming').then(r => r.json());
  } catch {
    $('upcomingNote').textContent = 'Could not load the race list.';
    return;
  }
  if (!Array.isArray(upcoming) || !upcoming.length) {
    $('eventCards').innerHTML =
      '<div class="empty"><div class="t">Nothing announced yet</div>'
      + '<div class="h">Races appear here as soon as an organiser publishes '
      + 'them.</div></div>';
    return;
  }
  $('upcomingNote').textContent =
    `${upcoming.length} race${upcoming.length === 1 ? '' : 's'} announced`;

  $('eventCards').innerHTML = upcoming.map(e => {
    const races = e.races.map(r =>
      `<span class="tag">${esc(r.name)}${r.distance_km ? ' \u00b7 ' + r.distance_km + ' km' : ''}</span>`
    ).join('');
    const mine = e.my_status ? ENTRY_LABEL[e.my_status] : null;
    const action = mine
      ? `<span class="tag ${e.my_status === 'confirmed' ? 'go' : 'wait'}">${esc(mine)}</span>`
      : e.registration_open
        ? `<button class="primary" data-enter="${esc(e.code)}">Enter this race</button>`
        : '<span class="tag">Entries not open</span>';
    return `<article class="eventcard">
      <div class="evwhen">${esc(fmtDate(e.starts_at))}</div>
      <h3>${esc(e.name)}</h3>
      ${e.location ? `<p class="evwhere">${esc(e.location)}</p>` : ''}
      ${e.description ? `<p class="note">${esc(e.description)}</p>` : ''}
      <div class="evraces">${races}</div>
      ${e.entry_note ? `<p class="note tight">${esc(e.entry_note)}</p>` : ''}
      <div class="evacts">
        ${action}
        <a href="/results.html#${encodeURIComponent(e.code)}">Results</a>
      </div>
      <p class="note tight">${e.entrants} entered so far</p>
    </article>`;
  }).join('');

  $('eventCards').querySelectorAll('[data-enter]').forEach(b => {
    b.onclick = () => openEntry(b.dataset.enter);
  });
}

function openEntry(code) {
  // Entering needs an account. Sending them to sign up, with a way back, beats
  // letting them fill in a form that is going to be refused.
  if (!me) {
    location.href = '/signup.html';
    return;
  }
  const ev = upcoming.find(e => e.code === code);
  if (!ev) return;
  $('entryTitle').textContent = `Enter ${ev.name}`;
  $('entryWhen').textContent =
    [fmtDate(ev.starts_at), ev.location].filter(Boolean).join(' \u00b7 ');
  $('enRace').innerHTML = ev.races.map(r =>
    `<option value="${r.id}">${esc(r.name)}${r.distance_km ? ' \u2014 ' + r.distance_km + ' km' : ''}</option>`
  ).join('') || '<option value="">The organiser will decide</option>';
  $('enErr').hidden = true;
  $('entryDialog').dataset.code = code;
  $('entryDialog').showModal();
}

$('enSend').onclick = async e => {
  e.preventDefault();
  const dlg = $('entryDialog');
  const code = dlg.dataset.code;
  $('enErr').hidden = true;
  const body = {
    race_id: Number($('enRace').value) || null,
    category: $('enCategory').value.trim() || null,
    gender: $('enGender').value.trim() || null,
    emergency_contact: $('enEmergency').value.trim() || null,
    note: $('enNote').value.trim() || null,
  };
  try {
    const res = await fetch(`/api/events/${encodeURIComponent(code)}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      $('enErr').textContent = typeof err.detail === 'string'
        ? err.detail : 'That entry could not be sent.';
      $('enErr').hidden = false;
      return;
    }
    dlg.close();
    ok('Entry sent. The organiser will confirm it and give you a bib.');
    loadUpcoming();
  } catch {
    $('enErr').textContent = 'Could not reach the server.';
    $('enErr').hidden = false;
  }
};

/* ---------- contact ---------- */

$('contactForm').onsubmit = e => {
  e.preventDefault();
  return withBusy($('cSend'), async () => {
    $('cErr').hidden = true;
    const body = {
      name: $('cName').value.trim(),
      email: $('cEmail').value.trim(),
      subject: $('cSubject').value.trim(),
      body: $('cBody').value.trim(),
    };
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        $('cErr').textContent = typeof out.detail === 'string'
          ? out.detail : 'That message could not be sent.';
        $('cErr').hidden = false;
        return;
      }
      // The message is kept either way; only the email copy may not have gone,
      // which is the organiser's problem to fix, not the sender's to worry at.
      ok('Thank you \u2014 your message has reached the organiser.');
      ['cSubject', 'cBody'].forEach(id => { $(id).value = ''; });
    } catch {
      $('cErr').textContent = 'Could not reach the server. Try again shortly.';
      $('cErr').hidden = false;
    }
  });
};

/* ---------- organiser ----------

   The page asks the server who this is. It does not decide anything itself:
   what an account may do is the server's answer, and every endpoint behind
   these links checks again. Hiding a link is tidiness, not security. */

async function initAuth() {
  let who = null;
  try {
    who = await fetch('/api/admin/check').then(r => r.json());
  } catch {
    return;                      // offline: leave the runner's page alone
  }
  me = (who && who.signed_in) ? who : null;
  if (!me) return;

  // Signed in, whatever the role: the ways in are replaced by the way to your
  // own page.
  $('signIn').hidden = true;
  $('signUp').hidden = true;
  $('mine').hidden = false;
  $('mine').textContent = who.display_name || 'My running';
  if (!$('cName').value) $('cName').value = who.display_name || '';

  // A runner holds an account but runs nothing, so the organiser section stays
  // shut for them. Every endpoint behind it is refused by the server anyway.
  if (!who.is_operator) return;

  $('orgWho').textContent = who.role === 'super_admin' ? 'a super admin' : 'an admin';
  $('adminCardText').textContent = who.can_create_events
    ? 'Create races, set checkpoints, load the start list, upload artwork and print bibs.'
    : 'Set checkpoints, load the start list, upload artwork and print bibs.';

  if (who.must_change_password) {
    const note = $('orgNote');
    note.hidden = false;
    note.textContent = 'Your account is still using the password it was created '
      + 'with. Change it under Your account in Race admin.';
  }

  $('organiser').hidden = false;
  $('signIn').hidden = true;
}

$('signOut').onclick = async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* going anyway */ }
  $('organiser').hidden = true;
  $('signIn').hidden = false;
  ok('Signed out.');
};

/* ---------- go ---------- */

mountPicker($('wallpaper'));

loadRaces().then(() => {
  syncButtons();
  renderRecent();
});
// Identity first: it decides whether "Enter this race" opens a form or leads
// to sign-up, so the race list waits on it.
initAuth().then(loadUpcoming);
