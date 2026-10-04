/* The certificate for turning up to a workshop.

   Built on the same card and the same export path as the finisher card, and
   deliberately not the same shape of thing: there is no time and no placing,
   because a workshop has neither, and a certificate that left blank spaces
   where those would be would look like a race card somebody had failed. */

import html2canvas from '/vendor/html2canvas.esm.js';
import { esc, ok, fail, withBusy } from '/js/ui.js';
import { renderCardPng, downloadBlob, shareOrDownload, cardFileName }
  from '/js/cardexport.js';

const $ = id => document.getElementById(id);
const CARD_W = 1080;
const CARD_H = 1350;

const slug = decodeURIComponent(location.hash.slice(1));
let workshop = null;
let who = '';

function fail_(message) {
  $('err').textContent = message;
  $('err').hidden = false;
}

const when = iso => iso
  ? new Date(iso).toLocaleDateString(undefined,
      { day: 'numeric', month: 'long', year: 'numeric' })
  : '';

function build() {
  const card = document.createElement('div');
  // Without a cover image the accent-behind-a-scrim fallback looks like a
  // fault, so the plain case gets a ground designed for it.
  card.className = 'share-card' + (workshop.cover_url ? '' : ' plain');
  card.style.setProperty('--card-h', CARD_H);
  if (workshop.cover_url) {
    card.style.setProperty('--art', `url("${workshop.cover_url}")`);
  }

  card.innerHTML =
    `<div class="body">
       <div class="badge">Attended</div>
       <div class="name">${esc(who)}</div>
       <div class="session">${esc(workshop.title)}</div>
       <div class="meta">${esc([when(workshop.starts_at),
         workshop.host_name ? 'with ' + workshop.host_name : null,
       ].filter(Boolean).join(' · '))}</div>
     </div>
     <div class="foot"><div class="who">RaceTime</div></div>`;

  const frame = $('cardFrame');
  frame.innerHTML = '';
  frame.appendChild(card);
  $('cardFrame').style.setProperty('--card-h', CARD_H);
  $('actions').hidden = false;
  fit();
}

function fit() {
  const frame = $('cardFrame');
  const card = frame && frame.querySelector('.share-card');
  if (!card || !frame.clientWidth) return;
  card.style.transform = `scale(${frame.clientWidth / CARD_W})`;
}
addEventListener('resize', fit);

const render = () => renderCardPng(
  $('cardFrame').querySelector('.share-card'), html2canvas, CARD_W, CARD_H);
const name = () => cardFileName(workshop.slug, who, 'attended');

$('download').onclick = e => withBusy(e.currentTarget, async () => {
  try {
    const blob = await render();
    if (!blob) throw new Error('Could not render the certificate.');
    downloadBlob(blob, name());
    ok('Certificate saved to your device.');
  } catch (err) { fail(err.message); }
});

$('save').onclick = e => withBusy(e.currentTarget, async () => {
  try {
    const blob = await render();
    if (!blob) throw new Error('Could not render the certificate.');
    await shareOrDownload(blob, name(), workshop.title);
  } catch (err) { fail(err.message); }
});

(async () => {
  if (!slug) { fail_('No workshop in the address.'); return; }
  let me;
  try {
    me = await fetch('/api/auth/me').then(r => r.ok ? r.json() : null);
  } catch { me = null; }
  if (!me) {
    location.href = '/login.html?next=' +
      encodeURIComponent('/attended.html#' + slug);
    return;
  }
  who = me.user.display_name || me.user.username;

  try {
    const mine = await fetch('/api/me/workshops').then(r => r.json());
    const row = mine.find(r => r.workshop_slug === slug);
    if (!row || row.status !== 'attended') {
      // Not a refusal to be worked around: the certificate says somebody was
      // there, so it exists only once an organiser has said they were.
      fail_('This certificate appears once an organiser has marked you present '
            + 'at the session.');
      return;
    }
    workshop = await fetch(`/api/workshops/${encodeURIComponent(slug)}`)
      .then(r => r.json());
  } catch {
    fail_('Could not load that workshop.');
    return;
  }
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  build();
})();
