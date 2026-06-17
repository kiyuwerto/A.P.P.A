const CACHE_NAME = 'appa-cache-v9';
// Nota: los archivos de ffmpeg (ffmpeg.js, 814.ffmpeg.js, ffmpeg-core.js, ffmpeg-core.wasm)
// NO se precachean aquí a propósito: el .wasm pesa ~32MB y si su descarga falla durante
// la instalación, todo el service worker fallaría y la app dejaría de funcionar offline.
// Se cachean de forma perezosa (on-demand) la primera vez que el usuario exporta video.
const ASSETS = ['./', './index.html', './app.js', './soundtouch.js', './lamejs.js', './manifest.json', './icon-192.png', './icon-512.png'];

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
