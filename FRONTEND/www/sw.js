// Echo PWA Service Worker
const CACHE_NAME = 'neighborly-v19';
const URLS_TO_CACHE = [
  '/',
  '/Neighborly.html',
  '/login.html',
  '/register.html',
  '/forgot-password.html',
  '/update-password.html',
  '/css/main.css',
  '/css/auth.css',
  '/css/chat.css',
  '/css/artificium-theme.css?v=12',
  '/js/neighborly-loader.js',
  '/js/app.js',
  '/js/auth.js',
  '/js/chat.js',
  '/js/login.js',
  '/js/socket.js',
  '/js/supabase.js',
  '/js/firebase.js',
  '/js/webrtcClient.js'
];

// Install Service Worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(URLS_TO_CACHE).catch(err => {
          console.log('Some assets failed to cache:', err);
        });
      })
  );
  self.skipWaiting();
});

// Activate Service Worker
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event - Network first, fallback to cache
self.addEventListener('fetch', (event) => {
  // Never intercept non-GET, Socket.io, or API traffic.
  if (event.request.method !== 'GET') {
    return;
  }
  try {
    const requestUrl = new URL(event.request.url);
    if (requestUrl.pathname.startsWith('/socket.io/') || requestUrl.pathname.startsWith('/api/')) {
      return;
    }
  } catch (error) {
    return;
  }
  // Skip cross-origin requests
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // Fallback to cache when offline
        return caches.match(event.request)
          .then((response) => {
            return response || new Response('Offline - feature not available');
          });
      })
  );
});

// Background Sync for offline messages
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-messages') {
    event.waitUntil(syncMessages());
  }
});

async function syncMessages() {
  // This would sync pending messages when connection returns
  try {
    const cache = await caches.open(CACHE_NAME);
    // Implement message sync logic here
  } catch (error) {
    console.log('Sync failed:', error);
  }
}
