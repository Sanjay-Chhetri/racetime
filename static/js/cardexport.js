/* Turning a card on screen into a file somebody keeps.

   Shared by the finisher certificate and the workshop certificate. It was
   extracted rather than copied because the two would drift: the last change
   here fixed a real fault -- dismissing the share sheet left the holder with
   nothing at all -- and a second copy would still have it. */

import { ok } from '/js/ui.js';

/**
 * Render an element to a PNG blob at its true size.
 *
 * The element is drawn at whatever `width` and `height` say, with any preview
 * scaling removed first and put back afterwards, so the exported file is the
 * full-size card and not the thumbnail the page happens to be showing.
 */
export async function renderCardPng(card, html2canvas, width, height) {
  if (!card) throw new Error('There is no card to save.');

  // Without this the capture can start before the webfonts have loaded, and
  // the type silently falls back to a default face.
  if (document.fonts && document.fonts.ready) await document.fonts.ready;

  const scaled = card.style.transform;
  card.style.transform = 'none';
  try {
    const canvas = await html2canvas(card, {
      width, height, windowWidth: width, windowHeight: height,
      scale: 1, backgroundColor: null, useCORS: true, logging: false,
    });
    return await new Promise(res => canvas.toBlob(res, 'image/png'));
  } finally {
    card.style.transform = scaled;
  }
}

/** Put a blob on the device as a file. Always works; never asks anyone. */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);      // Firefox needs it in the document
  a.click();
  a.remove();
  // Revoking immediately can cancel the download on some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Offer the share sheet, and fall back to a download.
 *
 * The sheet is offered, never relied on. Somebody who dismisses it used to be
 * left with nothing, and a certificate should not be lost to a stray tap --
 * which is why there is a separate Download button as well as this.
 */
export async function shareOrDownload(blob, name, title) {
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') {
        ok('Not shared. Use Download to keep a copy.');
        return 'cancelled';
      }
      // Any other failure falls through, so the card still reaches the device.
    }
  }
  downloadBlob(blob, name);
  ok('Saved to your device.');
  return 'downloaded';
}

/** A filename made from words, not ids: it lands in a downloads folder. */
export function cardFileName(...parts) {
  const slug = parts.filter(Boolean).join('-')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (slug || 'racetime') + '.png';
}
