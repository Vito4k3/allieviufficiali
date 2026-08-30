// ============================================================
//  Portale Allievi Ufficiali — Service Worker (motore dell'app)
//
//  ⚠️ PER PUBBLICARE UN AGGIORNAMENTO DELL'APP:
//  cambia SOLO il numero di versione qui sotto (es. '1.0.1')
//  e pubblica il sito. Le app installate rileveranno la nuova
//  versione e chiederanno all'utente di aggiornare.
// ============================================================
const APP_VERSION = '1.5.4';

const CACHE_NAME = 'portale-au-v' + APP_VERSION;

// File essenziali dell'app, salvati per l'uso offline
const PRECACHE = [
  '/',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// ── INSTALLAZIONE: scarica la nuova versione ──────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  // NB: NON chiamiamo skipWaiting() qui: la nuova versione resta
  // "in attesa" finché l'utente non preme "Aggiorna" nel banner.
});

// ── ATTIVAZIONE: elimina le versioni vecchie ──────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// L'utente ha premuto "Aggiorna": attiva subito la nuova versione
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ── RICHIESTE ─────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Le API non vengono mai messe in cache: sempre dati freschi dal server
  if (url.pathname.startsWith('/api/')) return;

  if (url.origin === self.location.origin) {
    // File del sito: prima la rete (così gli aggiornamenti arrivano subito),
    // cache di riserva se si è offline
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : undefined))
        )
    );
  } else {
    // Risorse esterne (font, Chart.js): prima la cache, poi la rete
    event.respondWith(
      caches.match(req).then((hit) =>
        hit ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
      )
    );
  }
});
