/* The offline layer. This is the part that decides whether the app survives a
   real race.

   A scan never touches the network. It writes to IndexedDB and returns. A
   separate loop drains the queue whenever a connection happens to exist. If you
   invert that -- POST on scan and show a spinner -- the app stops working at the
   first dead spot on the course and takes the timing data with it. */

const DB_NAME = 'racetime';
const STORE = 'queue';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'read_id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  }));
}

export const queue = {
  put: (rec) => tx(STORE, 'readwrite', s => s.put(rec)),
  all: () => tx(STORE, 'readonly', s => s.getAll()),
  remove: (ids) => tx(STORE, 'readwrite', s => { ids.forEach(id => s.delete(id)); }),
  count: () => tx(STORE, 'readonly', s => s.count()),
};

/* ---- clock offset -------------------------------------------------------

   Every volunteer phone has its own idea of the time, often several seconds
   off. That error lands straight in the split times and is invisible
   afterwards. So each device measures itself against the server once, at
   checkpoint setup, and corrects every scan by the difference.

   The round trip is halved on the assumption that the request and response legs
   take roughly equal time. Taking the best of several samples keeps one slow
   response from skewing the estimate. */

export async function measureClockOffset(samples = 5) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const res = await fetch('/api/time', { cache: 'no-store' });
    const t1 = Date.now();
    const { epoch_ms } = await res.json();
    const rtt = t1 - t0;
    const offset = epoch_ms + rtt / 2 - t1;  // add to device clock to get server time
    if (!best || rtt < best.rtt) best = { offset: Math.round(offset), rtt };
  }
  return best;
}

export function correctedNow(offsetMs) {
  return new Date(Date.now() + (offsetMs || 0));
}

/* ---- sync loop ---------------------------------------------------------- */

export function makeSyncer(eventCode, onStatus) {
  let running = false;

  async function flush() {
    if (running) return;
    running = true;
    try {
      const pending = await queue.all();
      if (!pending.length) {
        onStatus({ state: navigator.onLine ? 'synced' : 'offline', pending: 0 });
        return;
      }
      if (!navigator.onLine) {
        onStatus({ state: 'offline', pending: pending.length });
        return;
      }
      // Chunked so a large backlog after a long dead zone doesn't produce one
      // enormous request that times out and never drains.
      for (let i = 0; i < pending.length; i += 100) {
        const batch = pending.slice(i, i + 100);
        const res = await fetch(`/api/events/${eventCode}/reads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reads: batch.map(stripLocal) }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        // Only drop from the queue once the server has confirmed. Duplicates
        // are harmless -- read_id is the primary key server-side -- so resending
        // after an ambiguous failure is always the safe choice.
        await queue.remove(batch.map(r => r.read_id));
      }
      const left = await queue.count();
      onStatus({ state: left ? 'queued' : 'synced', pending: left });
    } catch (err) {
      const left = await queue.count();
      onStatus({ state: 'queued', pending: left, error: String(err) });
    } finally {
      running = false;
    }
  }

  function stripLocal(r) {
    const { _name, ...rest } = r;
    return rest;
  }

  setInterval(flush, 5000);
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) flush();
  });
  flush();
  return { flush };
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
