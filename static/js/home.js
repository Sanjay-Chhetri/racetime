/* The landing page.

   Almost everyone who opens RaceTime is a runner or someone watching one, and
   they want one of two things: the live board, or their certificate. The page
   used to offer five identical panels in the order the screens were built, with
   "Race admin" above both. The organiser tools are behind a sign-in now -- they
   are a handful of people, once per event, and they know where they are going. */

import { esc, ok } from '/js/ui.js';
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
  if (!who || !who.signed_in) return;

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
initAuth();
