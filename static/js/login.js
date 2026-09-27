/* Sign-in.

   There is no token to store and nothing to remember: the server answers with
   an HttpOnly cookie, which this script cannot read and therefore cannot leak.
   That is the point of it. The previous scheme kept a shared admin token in
   localStorage, where any injected script on any page could have taken it. */

import { esc, withBusy } from '/js/ui.js';
import { mountPicker } from '/js/theme.js';

const $ = id => document.getElementById(id);

mountPicker($('wallpaper'));

/** Where to go after signing in. Same-origin paths only: `next` comes from the
 *  address bar, and following it anywhere else is an open redirect -- a link
 *  that looks like ours and lands on someone else's login form. */
function destination() {
  const wanted = new URLSearchParams(location.search).get('next') || '';
  if (wanted.startsWith('/') && !wanted.startsWith('//')) return wanted;
  return '/admin.html';
}

function fail(message) {
  const el = $('err');
  el.textContent = message;
  el.hidden = false;
}

$('signinForm').onsubmit = e => {
  e.preventDefault();
  return withBusy($('submit'), async () => {
    $('err').hidden = true;
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!username || !password) {
      fail('Enter your username and password.');
      return;
    }

    let res;
    try {
      res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch {
      fail('Could not reach the server. Check your connection and try again.');
      return;
    }

    if (!res.ok) {
      let detail = 'That username and password do not match.';
      try {
        const body = await res.json();
        if (typeof body.detail === 'string') detail = body.detail;
      } catch { /* a proxy error page, not our JSON */ }
      fail(detail);
      $('password').value = '';
      $('password').focus();
      return;
    }

    const me = await res.json();
    // Straight to the password screen when the account is still on whatever it
    // was created with. It is a nudge, not a lock -- the admin page shows the
    // same prompt until it is dealt with.
    if (me.user && me.user.must_change_password) {
      location.href = '/admin.html#!password';
      return;
    }
    location.href = destination();
  });
};

// Already signed in? Do not make them type it again.
fetch('/api/auth/me').then(r => {
  if (r.ok) location.replace(destination());
}).catch(() => { /* offline: let them try the form */ });

$('username').focus();
