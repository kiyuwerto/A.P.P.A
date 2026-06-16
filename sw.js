const CACHE_NAME = 'appa-cache-v1';
const ASSETS = ['./', './index.html', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event)=>{
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event)=>{
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k!==CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event)=>{
  event.respondWith(
    caches.match(event.request).then(cached => {
      if(cached) return cached;
      return fetch(event.request).then(resp=>{
        return caches.open(CACHE_NAME).then(cache=>{
          try{ cache.put(event.request, resp.clone()); }catch(e){}
          return resp;
        });
      }).catch(()=> cached);
    })
  );
});
