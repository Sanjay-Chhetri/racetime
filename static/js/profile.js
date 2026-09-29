/* Somebody else's runner profile.

   Reached at /r/<slug>. The server decides whether it may be seen at all and
   answers 404 when it may not -- including for a profile that exists but is
   private, because a 403 would confirm the account, which is itself something
   the owner did not agree to publish. So there is only one failure state here,
   and it says the same thing either way. */

import { esc } from '/js/ui.js';
import { mountPicker } from '/js/theme.js';

const $ = id => document.getElementById(id);

// /r/tenzing-bhutia, or /profile.html#tenzing-bhutia as a fallback.
const slug = decodeURIComponent(
  location.pathname.startsWith('/r/')
    ? location.pathname.slice(3)
    : location.hash.slice(1)).replace(/\/+$/, '');

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

async function load() {
  if (!slug) { $('missing').hidden = false; return; }

  let p;
  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(slug)}`);
    if (!res.ok) { $('missing').hidden = false; return; }
    p = await res.json();
  } catch {
    $('missing').hidden = false;
    return;
  }

  document.title = `${p.display_name} · RaceTime`;
  $('name').textContent = p.display_name;
  $('where').textContent = [
    p.home_town,
    p.running_since ? `Running since ${p.running_since}` : null,
    p.preferred_distances,
  ].filter(Boolean).join(' · ');
  $('bio').textContent = p.bio || '';
  $('bio').hidden = !p.bio;

  if (p.avatar_url) {
    $('avatar').src = p.avatar_url;
    $('avatarWrap').hidden = false;
  }

  $('links').innerHTML = p.strava_url
    // rel=noopener because the link is user-supplied: without it the page it
    // opens can reach back through window.opener.
    ? `<a href="${esc(p.strava_url)}" target="_blank" rel="noopener noreferrer">Strava</a>`
    : '';

  $('totals').innerHTML = [
    { v: p.points, k: 'points' },
    { v: p.stats.finishes, k: p.stats.finishes === 1 ? 'race' : 'races' },
    { v: p.stats.km, k: 'km raced' },
    { v: p.stats.podiums, k: p.stats.podiums === 1 ? 'podium' : 'podiums' },
  ].map(c => `<div class="score"><span class="v">${esc(String(c.v))}</span>` +
             `<span class="k">${esc(c.k)}</span></div>`).join('');

  if (p.badges.length) {
    $('badges').innerHTML = p.badges.map(b =>
      `<div class="badge-card earned">
         <div class="bt">${esc(b.name)}</div>
         <div class="bd">${esc(b.detail)}</div>
       </div>`).join('');
    $('badgePanel').hidden = false;
  }

  $('runs').innerHTML = p.runs.length
    ? p.runs.map(r => `
        <article class="runcard">
          <div class="runhead">
            <div>
              <h3>${esc(r.event_name)}</h3>
              <p class="note">${esc([when(r.date), r.race,
                r.distance_km ? r.distance_km + ' km' : null]
                .filter(Boolean).join(' · '))}</p>
            </div>
            ${r.position
              ? `<span class="tag">${esc(ordinal(r.position))} of ${r.field_size}</span>`
              : ''}
          </div>
          <div class="runbody">
            <div class="runtime">${r.status === 'finished'
              ? esc(dur(r.finish_seconds)) : '<span class="tag">did not finish</span>'}</div>
          </div>
          <div class="runacts">
            <a href="/results.html#${encodeURIComponent(r.event_code)}">Full results</a>
          </div>
        </article>`).join('')
    : '<div class="empty"><div class="t">No races yet</div></div>';

  $('profile').hidden = false;
}

mountPicker($('wallpaper'));
load();
