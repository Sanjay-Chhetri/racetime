/* Opening a runner account.

   The role is never sent. It is fixed on the server, because a public form
   that accepted one would be a public form for making super admins. */

import { withBusy } from '/js/ui.js';
import { mountPicker } from '/js/theme.js';

const $ = id => document.getElementById(id);
mountPicker($('wallpaper'));

function fail(message) {
  const el = $('err');
  el.textContent = message;
  el.hidden = false;
}

$('signupForm').onsubmit = e => {
  e.preventDefault();
  return withBusy($('submit'), async () => {
    $('err').hidden = true;
    const payload = {
      display_name: $('display_name').value.trim(),
      email: $('email').value.trim(),
      username: $('username').value.trim(),
      password: $('password').value,
      phone: $('phone').value.trim() || null,
      home_town: $('home_town').value.trim() || null,
    };
    if (payload.password.length < 8) {
      fail('Your password needs at least 8 characters.');
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

    // Signing up signs you in, so there is nothing to do but go.
    location.href = '/me.html';
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
