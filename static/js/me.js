/* A runner's own page: their races, their points, what they have earned.

   Everything here is computed from reads on the server when asked for, the
   same as the leaderboard. Nothing is cached and nothing is stored, so a
   corrected scan changes a total the next time this loads rather than leaving
   a points table quietly disagreeing with the results it came from. */

import { esc, ok, fail, withBusy, fitImageForUpload, money } from '/js/ui.js';
import { mountPicker } from '/js/theme.js';

const $ = id => document.getElementById(id);

const api = async (path, opts) => {
  let res;
  try {
    res = await fetch('/api' + path, opts);
  } catch {
    throw new Error('Could not reach the server. Check your connection.');
  }
  if (res.status === 401) {
    location.href = '/login.html?next=' + encodeURIComponent('/me.html');
    throw new Error('Signing in…');
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const d = body && body.detail;
    throw new Error(typeof d === 'string' ? d
      : Array.isArray(d) ? d.map(x => x.msg || x).join('; ')
      : `The server returned ${res.status}.`);
  }
  return body;
};

const json = (method, body) => ({
  method, headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const dur = s => {
  if (s == null) return '—';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

const ordinal = n => {
  if (n == null) return '';
  const t = n % 100;
  return n + ((t >= 11 && t <= 13) ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
};

const when = iso => iso
  ? new Date(iso).toLocaleDateString(undefined,
      { day: 'numeric', month: 'short', year: 'numeric' })
  : '';

/* ---------- tabs ---------- */

const TABS = ['runs', 'badges', 'entries', 'workshops', 'profile'];
let tab = 'runs';

function showTab(name) {
  if (!TABS.includes(name)) name = 'runs';
  tab = name;
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.tabpanel').forEach(p => {
    p.hidden = p.dataset.tab !== name;
  });
  location.hash = name;
  if (name === 'entries') loadEntries();
  if (name === 'workshops') loadWorkshops();
}

document.querySelectorAll('.tab').forEach(b => {
  b.onclick = () => showTab(b.dataset.tab);
});

// Changing only the hash is a same-document navigation: the module does not
// re-run, so without this a link or a bookmark to /me.html#profile from
// /me.html#runs left the wrong panel open, and back and forward did nothing.
window.addEventListener('hashchange', () => {
  const wanted = location.hash.slice(1);
  if (wanted && wanted !== tab) showTab(wanted);
});

/* ---------- the record ---------- */

const STATUS = {
  finished: ['go', 'finished'],
  on_course: ['wait', 'still running'],
  dnf: ['stop', 'did not finish'],
  not_started: ['', 'no sightings'],
};

async function loadRecord() {
  let r;
  try {
    r = await api('/me/record');
  } catch (e) {
    $('runList').innerHTML = `<p class="note">${esc(e.message)}</p>`;
    return;
  }

  $('totals').innerHTML = [
    { v: r.points, k: 'points' },
    { v: r.stats.finishes, k: r.stats.finishes === 1 ? 'race finished' : 'races finished' },
    { v: r.stats.km, k: 'km raced' },
    { v: r.stats.podiums, k: r.stats.podiums === 1 ? 'podium' : 'podiums' },
  ].map(c => `<div class="score"><span class="v">${esc(String(c.v))}</span>` +
             `<span class="k">${esc(c.k)}</span></div>`).join('');

  $('nRuns').textContent = r.runs.length || '';
  const earned = r.badges.filter(b => b.earned).length;
  $('nBadges').textContent = earned ? `${earned}/${r.badges.length}` : '';

  if (!r.runs.length) {
    $('runList').innerHTML =
      `<div class="empty"><div class="t">No races yet</div>
       <div class="h">Enter one from the <a href="/#upcoming">home page</a>.
       Once you have run it, your time and certificate appear here.</div></div>`;
  } else {
    $('runList').innerHTML = r.runs.map(run => {
      const [tone, label] = STATUS[run.status] || ['', run.status];
      const place = run.position
        ? `${ordinal(run.position)} of ${run.field_size}` : '';
      return `<article class="runcard">
        <div class="runhead">
          <div>
            <h3>${esc(run.event_name)}</h3>
            <p class="note">${esc([when(run.date), run.race,
              run.distance_km ? run.distance_km + ' km' : null]
              .filter(Boolean).join(' · '))}</p>
          </div>
          <div class="runpts"><span class="v">${run.points}</span>
            <span class="k">points</span></div>
        </div>
        <div class="runbody">
          <div class="runtime">${run.status === 'finished'
            ? esc(dur(run.finish_seconds))
            : `<span class="tag ${tone}">${esc(label)}</span>`}</div>
          <div class="runmeta">
            ${place ? `<span class="tag">${esc(place)}</span>` : ''}
            ${run.category_position && run.category
              ? `<span class="tag">${esc(ordinal(run.category_position))} in ${esc(run.category)}</span>`
              : ''}
            <span class="tag">Bib ${esc(run.bib)}</span>
          </div>
        </div>
        <div class="runacts">
          ${run.certificate
            ? `<a href="${esc(run.certificate)}">Finisher certificate</a>` : ''}
          <a href="/results.html#${encodeURIComponent(run.event_code)}">Full results</a>
        </div>
        ${run.points_why.length
          ? `<p class="note why">${esc(run.points_why.join(' · '))}</p>` : ''}
      </article>`;
    }).join('');
  }

  $('badgeList').innerHTML = r.badges.map(b => `
    <div class="badge-card ${b.earned ? 'earned' : ''}">
      <div class="bt">${esc(b.name)}</div>
      <div class="bd">${esc(b.detail)}</div>
      ${b.earned ? '<div class="bm">Earned</div>' : ''}
    </div>`).join('');

  const s = r.scoring;
  $('scoring').innerHTML =
    `Finishing a race earns ${s.finish} points, plus ${s.per_km} a kilometre. ` +
    `Winning adds ${s.overall['1']}, second ${s.overall['2']}, third ` +
    `${s.overall['3']} — but only in a field big enough for the placing to ` +
    `mean something, the same rule the finisher card uses. Winning your ` +
    `category adds ${s.category_win}, and being first of your gender ` +
    `${s.gender_win}.`;
}

/* ---------- entries ---------- */

const ENTRY_TONE = {
  pending: ['wait', 'waiting for the organiser'],
  confirmed: ['go', 'confirmed'],
  withdrawn: ['', 'withdrawn'],
  rejected: ['stop', 'not accepted'],
};

async function loadEntries() {
  let rows;
  try {
    rows = await api('/me/registrations');
  } catch (e) {
    $('entryList').innerHTML = `<p class="note">${esc(e.message)}</p>`;
    return;
  }
  $('nEntries').textContent =
    rows.filter(r => r.status === 'pending' || r.status === 'confirmed').length || '';

  if (!rows.length) {
    $('entryList').innerHTML =
      '<div class="empty"><div class="t">No entries yet</div></div>';
    return;
  }

  $('entryList').innerHTML = rows.map(r => {
    const [tone, label] = ENTRY_TONE[r.status] || ['', r.status];
    // A virtual entry is not waiting for an organiser to do anything -- it is
    // waiting for the runner to go out and run -- so the card shows how far
    // they have got and leads to the page where they log it.
    const live = r.status === 'pending' || r.status === 'confirmed';
    const pct = r.target_km
      ? Math.min(100, (r.done_km / r.target_km) * 100) : 0;
    const owes = (r.amount_paise || 0) > 0
      && !['paid', 'waived'].includes(r.payment_status);
    return `<article class="runcard">
      <div class="runhead">
        <div>
          <h3>${esc(r.event_name)}</h3>
          <p class="note">${esc([r.race, r.category].filter(Boolean).join(' · '))}</p>
        </div>
        ${r.is_virtual && live
          ? `<span class="tag ${r.complete ? 'go' : 'virtual'}">${
              r.complete ? 'Distance done' : 'Virtual race'}</span>`
          : `<span class="tag ${tone}">${esc(label)}</span>`}
      </div>
      ${r.is_virtual && live ? `
        <div class="bar"><div class="bar-fill${r.complete ? ' full' : ''}"
             style="width:${pct.toFixed(1)}%"></div></div>
        <p class="note tight">${r.done_km.toFixed(2)} of ${r.target_km} km${
          owes ? ' \u00b7 ' + money(r.amount_paise) + ' to pay' : ''}${
          r.certificate_ready ? ' \u00b7 certificate ready' : ''}</p>` : ''}
      <div class="runacts">
        ${r.bib ? `<span class="tag">Bib ${esc(r.bib)}</span>` : ''}
        ${r.is_virtual && live
          ? `<a class="button primary"
                href="/virtual.html#${encodeURIComponent(r.event_code)}">${
               r.certificate_ready ? 'Get your certificate' : 'Log a run'}</a>`
          : ''}
        ${live
          ? `<button class="quiet danger" data-withdraw="${r.id}">Withdraw</button>` : ''}
      </div>
    </article>`;
  }).join('');

  $('entryList').querySelectorAll('[data-withdraw]').forEach(b => {
    b.onclick = () => withBusy(b, async () => {
      try {
        await api(`/registrations/${b.dataset.withdraw}/withdraw`, { method: 'POST' });
        ok('Entry withdrawn.');
        loadEntries();
        loadRecord();
      } catch (e) { fail(e.message); }
    });
  });
}

/* ---------- workshops ---------- */

const WS_TONE = {
  registered: ['go', 'You have a place'],
  waitlisted: ['wait', 'On the waitlist'],
  attended: ['go', 'You attended'],
  cancelled: ['', 'Cancelled'],
  no_show: ['stop', 'Marked absent'],
};

async function loadWorkshops() {
  let rows;
  try {
    rows = await api('/me/workshops');
  } catch (e) {
    $('wsList').innerHTML = `<p class="note">${esc(e.message)}</p>`;
    return;
  }
  const live = rows.filter(r => ['registered', 'waitlisted'].includes(r.status));
  $('nWorkshops').textContent = live.length || '';

  if (!rows.length) {
    $('wsList').innerHTML =
      '<div class="empty"><div class="t">No workshops yet</div>'
      + '<div class="h">They are free. Take a place from the home page.</div></div>';
    return;
  }

  $('wsList').innerHTML = rows.map(r => {
    const [tone, label] = WS_TONE[r.status] || ['', r.status];
    return `<article class="runcard">
      <div class="runhead">
        <div>
          <h3>${esc(r.workshop_title)}</h3>
          <p class="note">${esc(r.starts_at
            ? new Date(r.starts_at).toLocaleString() : 'Date to be announced')}</p>
        </div>
        <span class="tag ${tone}">${esc(label)}</span>
      </div>
      <div class="runacts">
        ${r.status === 'attended'
          ? `<a href="/attended.html#${encodeURIComponent(r.workshop_slug)}">
               Participation certificate</a>` : ''}
        ${['registered', 'waitlisted'].includes(r.status)
          ? `<button class="quiet danger" data-drop="${r.id}">Give up my place</button>` : ''}
      </div>
    </article>`;
  }).join('');

  $('wsList').querySelectorAll('[data-drop]').forEach(b => {
    b.onclick = () => withBusy(b, async () => {
      try {
        await api(`/workshop-registrations/${b.dataset.drop}/cancel`,
                  { method: 'POST' });
        ok('Place given up. Somebody on the waitlist takes it.');
        loadWorkshops();
      } catch (e) { fail(e.message); }
    });
  });
}

/* ---------- profile ---------- */

let minor = false;

async function loadProfile() {
  const me = await api('/auth/me');
  const u = me.user;
  $('whoName').textContent = u.display_name || u.username;
  $('hello').textContent = `${(u.display_name || u.username).split(' ')[0]}'s running`;
  $('pfName').value = u.display_name || '';
  $('pfEmail').value = u.email || '';
  $('pfPhone').value = u.phone || '';
  $('pfTown').value = u.home_town || '';
  $('pfSince').value = u.running_since || '';
  $('pfDistances').value = u.preferred_distances || '';
  $('pfStrava').value = u.strava_url || '';
  $('pfBio').value = u.bio || '';
  $('pfVisibility').value = u.visibility || 'private';
  $('pfAnnounce').checked = Boolean(u.announcements_opt_in);

  $('pfAvatarWrap').hidden = !u.avatar_url;
  $('pfAvatarClear').hidden = !u.avatar_url;
  if (u.avatar_url) $('pfAvatarImg').src = u.avatar_url;

  const link = u.slug ? `${location.origin}/r/${u.slug}` : '';
  $('pfLink').value = link;

  // The server refuses a public profile for an under-18 account; the form
  // should not offer what will be refused.
  const year = new Date().getFullYear();
  minor = Boolean(u.birth_year) && (year - u.birth_year) < 18;
  $('pfMinorNote').hidden = !minor;
  [...$('pfVisibility').options].forEach(o => {
    o.disabled = minor && o.value !== 'private';
  });
  if (minor) $('pfVisibility').value = 'private';

  // An operator who lands here has an admin screen to be at instead.
  if (u.role !== 'runner') {
    document.querySelector('.sitenav').insertAdjacentHTML('afterbegin',
      '<a href="/admin.html">Race admin</a>');
  }
}

$('pfSave').onclick = e => withBusy(e.currentTarget, async () => {
  $('pfErr').hidden = true;
  try {
    if ($('pfAvatar').files[0]) {
      const fd = new FormData();
      fd.append('file', await fitImageForUpload($('pfAvatar').files[0], m => {
        $('pfErr').textContent = m;
        $('pfErr').hidden = false;
        $('pfErr').classList.add('plain');
      }));
      await api('/me/avatar', { method: 'POST', body: fd });
      $('pfAvatar').value = '';
    }
    const since = parseInt($('pfSince').value.trim(), 10);
    await api('/me/profile', json('PATCH', {
      display_name: $('pfName').value.trim(),
      email: $('pfEmail').value.trim(),
      phone: $('pfPhone').value.trim(),
      home_town: $('pfTown').value.trim(),
      bio: $('pfBio').value.trim(),
      running_since: Number.isFinite(since) ? since : null,
      preferred_distances: $('pfDistances').value.trim(),
      strava_url: $('pfStrava').value.trim(),
      visibility: $('pfVisibility').value,
      announcements_opt_in: $('pfAnnounce').checked,
    }));
    $('pfErr').classList.remove('plain');
    ok('Saved.');
    loadProfile();
  } catch (err) {
    $('pfErr').classList.remove('plain');
    $('pfErr').textContent = err.message;
    $('pfErr').hidden = false;
  }
});

$('pfAvatarClear').onclick = async () => {
  try {
    await api('/me/avatar', { method: 'DELETE' });
    ok('Photo removed.');
    loadProfile();
  } catch (err) { fail(err.message); }
};

$('pfCopy').onclick = async () => {
  const link = $('pfLink').value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    ok('Link copied.');
  } catch {
    // Clipboard access can be refused; selecting it is the fallback that
    // always works.
    $('pfLink').select();
    ok('Press Ctrl+C to copy.');
  }
};

$('pwSave').onclick = e => withBusy(e.currentTarget, async () => {
  $('pwErr').hidden = true;
  try {
    await api('/auth/password', json('POST', {
      current_password: $('pwCurrent').value,
      new_password: $('pwNew').value,
    }));
    ok('Password changed. Any other browser you were signed in on is signed out.');
    $('pwCurrent').value = '';
    $('pwNew').value = '';
  } catch (err) {
    $('pwErr').textContent = err.message;
    $('pwErr').hidden = false;
  }
});

$('signOut').onclick = async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* going anyway */ }
  location.href = '/';
};

/* ---------- go ---------- */

mountPicker($('wallpaper'));
showTab(location.hash.slice(1) || 'runs');
loadProfile().then(loadRecord).catch(() => { /* api() has redirected */ });
