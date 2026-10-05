/* Opening a runner account.

   The role is never sent. It is fixed on the server, because a public form
   that accepted one would be a public form for making super admins. */

import { withBusy } from '/js/ui.js';
import { mountPicker } from '/js/theme.js';

const $ = id => document.getElementById(id);
mountPicker($('wallpaper'));

/** Where to go once the account exists. Same-origin paths only: `next` comes
 *  from the address bar, and following it anywhere else is an open redirect.
 *  The same rule and the same reason as login.js. */
function destination() {
  const wanted = new URLSearchParams(location.search).get('next') || '';
  if (wanted.startsWith('/') && !wanted.startsWith('//')) return wanted;
  return '/me.html';
}

function fail(message) {
  const el = $('err');
  el.textContent = message;
  el.hidden = false;
}

$('signupForm').onsubmit = e => {
  e.preventDefault();
  return withBusy($('submit'), async () => {
    $('err').hidden = true;
    const year = parseInt($('birth_year').value.trim(), 10);
    const payload = {
      display_name: $('display_name').value.trim(),
      email: $('email').value.trim(),
      username: $('username').value.trim(),
      password: $('password').value,
      phone: $('phone').value.trim() || null,
      home_town: $('home_town').value.trim() || null,
      birth_year: Number.isFinite(year) ? year : null,
      consent: $('consent').checked,
    };
    if (payload.password.length < 8) {
      fail('Your password needs at least 8 characters.');
      return;
    }
    const thisYear = new Date().getFullYear();
    if (!payload.birth_year || payload.birth_year < 1900 || payload.birth_year > thisYear) {
      fail('Please give the year you were born, as four digits.');
      $('birth_year').focus();
      return;
    }
    if (!payload.consent) {
      fail('Please tick the box to say how your details may be used.');
      return;
    }

    let res;
    try {
      res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      fail('Could not reach the server. Check your connection and try again.');
      return;
    }

    if (!res.ok) {
      let detail = 'That did not work. Please check the form and try again.';
      try {
        const body = await res.json();
        if (typeof body.detail === 'string') detail = body.detail;
        else if (Array.isArray(body.detail)) {
          detail = body.detail.map(d => d.msg || d).join('; ');
        }
      } catch { /* not our JSON */ }
      fail(detail);
      return;
    }

    // Signing up signs you in, so there is nothing to do but go -- back to
     // whatever they were trying to do, which is usually entering a race they
     // had already chosen. Landing them on their own empty page meant finding
     // that race again, and some of them will not.
    location.href = destination();
  });
};

// Suggest a username from the name, until they touch the field themselves.
let usernameTouched = false;
$('username').addEventListener('input', () => { usernameTouched = true; });
$('display_name').addEventListener('input', () => {
  if (usernameTouched) return;
  $('username').value = $('display_name').value
    .trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9._-]/g, '');
});

$('display_name').focus();
