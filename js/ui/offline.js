// Registers the service worker and reports when a new build is ready.
//
// The registration is the whole of the offline feature on this side: sw.js does
// the caching, and the only thing the page contributes is a decision the page
// is the only one able to make - WHEN to switch versions.
//
// It never switches on its own. An update installs quietly and waits; the
// status bar offers it, and `activate()` runs only if someone clicks. Two
// reasons, and both are things that would otherwise happen without warning:
// the editor holds unsaved edits that a reload discards, and a running page
// dynamic-imports its tool cards with ?v=APP_VERSION, so activating underneath
// it would hand a v0.5.2 page a v0.5.3 module.
//
// Service workers need a secure context, so this is inert on plain http to a
// LAN address - see server/README.md. Nothing else in the app depends on it,
// which is why every failure here is a console warning and not an error.

export function initOffline({ onUpdateReady = () => {} } = {}) {
  if (!('serviceWorker' in navigator)) return null;

  let registration = null;
  // Set only by activate(). The first install also fires controllerchange -
  // clients.claim() - and reloading the page out from under a user who just
  // opened the app would be a strange way to introduce yourself.
  let switching = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (switching) location.reload();
  });

  const announce = (worker) => {
    // "installed" while a controller already exists means this is a second
    // build, not the first visit.
    if (worker && worker.state === 'installed' && navigator.serviceWorker.controller) onUpdateReady();
  };

  const ready = navigator.serviceWorker
    .register('sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      registration = reg;
      announce(reg.waiting); // already waiting from a previous visit
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (worker) worker.addEventListener('statechange', () => announce(worker));
      });
      return reg;
    })
    .catch((err) => {
      console.warn('offline support unavailable:', err);
      return null;
    });

  return {
    ready,
    // Ask the browser to look for a new build now, rather than waiting for it
    // to check on its own schedule.
    update: async () => (await ready) && registration.update(),
    activate() {
      if (!registration || !registration.waiting) {
        location.reload();
        return;
      }
      switching = true;
      registration.waiting.postMessage({ type: 'skip-waiting' });
    },
    // Escape hatch for the console: a worker that is somehow serving something
    // broken should not need devtools archaeology to remove.
    async unregister() {
      const reg = await ready;
      if (reg) await reg.unregister();
      for (const name of await caches.keys()) {
        if (name.startsWith('chipseq-')) await caches.delete(name);
      }
    },
  };
}
