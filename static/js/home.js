/* The landing page.

   Almost everyone who opens RaceTime is a runner or someone watching one, and
   they want one of two things: the live board, or their certificate. The page
   used to offer five identical panels in the order the screens were built, with
   "Race admin" above both. The organiser tools are behind a sign-in now -- they
   are a handful of people, once per event, and they know where they are going. */

import { esc, ok, fail, promptDialog, withBusy } from '/js/ui.js';

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

/* ---------- organiser sign-in ----------

   The same token the admin screens use, so signing in here carries over to
   them. The server decides whether it is needed: when ADMIN_TOKEN is unset
   there is nothing to check, and saying so plainly is better than implying a
   lock that is not there. */

const TOKEN_KEY = 'racetime.adminToken';
let serverProtected = false;

const storedToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
};

function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable; the session still works in memory */ }
}

async function tokenWorks(t) {
  const res = await fetch('/api/admin/check', { headers: { 'X-Admin-Token': t } });
  return res.ok;
}

function showOrganiser(on) {
  $('organiser').hidden = !on;
  $('signIn').hidden = on;
  const note = $('orgNote');
  if (on && !serverProtected) {
    note.hidden = false;
    note.textContent = 'This server has no admin token set, so these screens are ' +
      'open to anyone who knows their address. Set ADMIN_TOKEN to close them.';
  } else {
    note.hidden = true;
  }
  if (on) $('organiser').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('signIn').onclick = e => withBusy(e.currentTarget, async () => {
  if (!serverProtected) {
    // Nothing to verify. Hiding the tools is still worth doing -- it keeps the
    // page aimed at runners -- but it is a tidy-up, not a lock, and it says so.
    showOrganiser(true);
    return;
  }
  let reason = 'Enter the admin token to reach the organiser screens.';
  for (;;) {
    const entered = await promptDialog({
      title: 'Organiser sign-in',
      body: reason,
      placeholder: 'paste the token',
      confirm: 'Sign in',
    });
    if (entered === null) return;
    if (await tokenWorks(entered)) {
      setToken(entered);
      ok('Signed in.');
      showOrganiser(true);
      return;
    }
    reason = 'That token was not accepted. Try again.';
  }
});

$('signOut').onclick = () => {
  setToken('');
  showOrganiser(false);
  ok('Signed out.');
};

async function initAuth() {
  let check = null;
  try {
    check = await fetch('/api/admin/check').then(r => r.json().catch(() => null));
  } catch { /* offline: leave the tools hidden rather than guess */ }

  // A 401 body has no `protected` flag, so an unauthenticated check that comes
  // back without one means the server is gated.
  serverProtected = !check || check.protected !== false;

  if (!serverProtected) {
    // Nothing is gated, so a previous sign-in cannot be verified either way.
    // Stay hidden until asked; the runner's page is the point.
    return;
  }
  const t = storedToken();
  if (t && await tokenWorks(t)) showOrganiser(true);
}

/* ---------- go ---------- */

loadRaces().then(() => {
  syncButtons();
  renderRecent();
});
initAuth();
