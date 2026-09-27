/* The wallpaper, and the control that changes it.

   Applying the choice is not done here -- a module is deferred, so by the time
   this ran the page would already have painted in the wrong colours and then
   jumped. Each page that wants a wallpaper sets it from a two-line inline
   script in <head>. This file only owns the picker. */

export const WALLPAPERS = [
  { id: 'dawn', name: 'Kanchenjunga dawn' },
  { id: 'pine', name: 'Cloud forest' },
  { id: 'monsoon', name: 'Monsoon' },
  { id: 'night', name: 'Clear night' },
  { id: 'plain', name: 'Plain dark' },
];

const KEY = 'racetime.wallpaper';
export const DEFAULT_WALLPAPER = 'dawn';

export function current() {
  try {
    const v = localStorage.getItem(KEY);
    return WALLPAPERS.some(w => w.id === v) ? v : DEFAULT_WALLPAPER;
  } catch {
    return DEFAULT_WALLPAPER;      // private window, or storage blocked
  }
}

export function apply(id) {
  const chosen = WALLPAPERS.some(w => w.id === id) ? id : DEFAULT_WALLPAPER;
  document.documentElement.dataset.wallpaper = chosen;
  try { localStorage.setItem(KEY, chosen); } catch { /* not worth failing over */ }
  return chosen;
}

/**
 * Render the swatches into `host`. Five dots rather than a dropdown: the
 * choice is visual, so showing the colours is quicker than naming them.
 */
export function mountPicker(host) {
  if (!host) return;
  host.className = 'wallpicker';
  host.innerHTML =
    '<span class="swatches" role="group" aria-label="Wallpaper">' +
    WALLPAPERS.map(w =>
      `<button class="wallswatch" data-w="${w.id}" title="${w.name}"
               aria-label="${w.name}" aria-pressed="false"></button>`).join('') +
    '</span>';

  const sync = id => host.querySelectorAll('.wallswatch').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset.w === id ? 'true' : 'false');
  });

  host.querySelectorAll('.wallswatch').forEach(b => {
    b.onclick = () => sync(apply(b.dataset.w));
  });
  sync(current());
}
