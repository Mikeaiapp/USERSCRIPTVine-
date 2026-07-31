// ==UserScript==
// @name         Amazon Vine Explorer Master Suite
// @namespace    https://github.com/mikeaiapp/USERSCRIPTVine
// @version      0.10.9.6
// @description  Ultimate Amazon Vine toolkit: IndexedDB database, preloaded ETV badges, $0.01-$25 junk filtering, live Discord alerts, infinite scroll, and CSV export.
// @author       mikeaiapp
// @match        *://www.amazon.com/vine/*
// @match        *://www.amazon.co.uk/vine/*
// @match        *://www.amazon.de/vine/*
// @match        *://www.amazon.ca/vine/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mikeaiapp/USERSCRIPTVine/main/VineExplorer.user.js
// @downloadURL  https://raw.githubusercontent.com/mikeaiapp/USERSCRIPTVine/main/VineExplorer.user.js
// ==/UserScript==

(function () {
 'use strict';

 // =========================================================
 // 1. CONFIGURATION & STATE ENGINE
 // =========================================================
 var DEFAULT_DISCORD_WEBHOOK = 'ADD DISCORD WEBHOOK';

 var CONFIG = {
   dbName: 'AVE_Database_v5',
   dbVersion: 1,
   dbStore: 'products',
   selectors: {
     grid: '#vvp-items-grid',
     tile: '.vvp-item-tile',
     title: '.a-truncate-full, .vvp-item-product-title-container a, .a-text-normal',
     detailsBtn: '.vvp-details-btn input',
     link: 'a[href*="/dp/"]',
     img: '.vvp-item-tile-content img, .vvp-item-product-title-container img'
   },
   etvRegex: /\$?\s*(\d+(?:\.\d{1,2})?)/,
   debounceMs: 350,
   pageLoadDelay: 800,
   bands: { excludeMin: 0.01, excludeMax: 25.00 },
   colors: {
     free: '#10b981',      // Green
     keep: '#3b82f6',      // Blue
     excluded: '#ef4444',  // Red
     unknown: '#6b7280'   // Gray
   }
 };

 var STATE = {
   db: null,
   processedTiles: 0,
   failedTiles: 0,
   isHalted: false,
   currentFetchPage: 1,
   maxFetchPage: 125,
   isFetching: false,
   lastFetchTime: 0,
   alertedAsins: {}
 };

 // =========================================================
 // 2. DEFENSIVE HELPERS (Self-Correcting Parsing Layer)
 // =========================================================
 function safeQuery(root, selector) {
   try { return root ? root.querySelector(selector) : null; }
   catch (e) { return null; }
 }

 function safeQueryAll(root, selector) {
   try { return root ? Array.from(root.querySelectorAll(selector)) : []; }
   catch (e) { return []; }
 }

 function safeText(el, fallback) {
   var fb = (fallback === undefined) ? 'UNKNOWN' : fallback;
   try {
     if (!el) return fb;
     var txt = (el.textContent || el.innerText || '').trim();
     return txt.length > 0 ? txt : fb;
   } catch (e) { return fb; }
 }

 function safeAttr(el, attr, fallback) {
   var fb = (fallback === undefined) ? '' : fallback;
   try {
     if (!el || typeof el.getAttribute !== 'function') return fb;
     var val = el.getAttribute(attr);
     return val != null ? val : fb;
   } catch (e) { return fb; }
 }

 function parseEtv(tile) {
   try {
     var raw = safeText(tile, '');
     var match = raw.match(CONFIG.etvRegex);
     if (match && match[1] !== undefined) {
       var num = parseFloat(match[1]);
       return Number.isFinite(num) ? num : null;
     }
     return null;
   } catch (e) { return null; }
 }

 function classifyEtv(etv) {
   if (etv === null) return 'UNKNOWN';
   if (etv === 0) return 'FREE';
   if (etv >= CONFIG.bands.excludeMin && etv <= CONFIG.bands.excludeMax) return 'EXCLUDED';
   return 'KEEP';
 }

 // =========================================================
 // 3. INLINED INDEXEDDB LOCAL DATABASE ENGINE
 // =========================================================
 function initDatabase(callback) {
   try {
     var request = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);
     request.onupgradeneeded = function (event) {
       var db = event.target.result;
       if (!db.objectStoreNames.contains(CONFIG.dbStore)) {
         var store = db.createObjectStore(CONFIG.dbStore, { keyPath: 'asin' });
         store.createIndex('isFav', 'isFav', { unique: false });
         store.createIndex('isNew', 'isNew', { unique: false });
         store.createIndex('lastSeen', 'lastSeen', { unique: false });
       }
     };
     request.onsuccess = function (event) {
       STATE.db = event.target.result;
       if (typeof callback === 'function') callback(STATE.db);
     };
     request.onerror = function () {
       console.warn('[AVE Master] IndexedDB initialization failed. Running in memory mode.');
       if (typeof callback === 'function') callback(null);
     };
   } catch (e) {
     if (typeof callback === 'function') callback(null);
   }
 }

 function saveProductToDB(prod, callback) {
   if (!STATE.db) return;
   try {
     var tx = STATE.db.transaction([CONFIG.dbStore], 'readwrite');
     var store = tx.objectStore(CONFIG.dbStore);
     store.put(prod);
     if (typeof callback === 'function') tx.oncomplete = callback;
   } catch (e) {}
 }

 function getProductFromDB(asin, callback) {
   if (!STATE.db) { callback(null); return; }
   try {
     var tx = STATE.db.transaction([CONFIG.dbStore], 'readonly');
     var store = tx.objectStore(CONFIG.dbStore);
     var req = store.get(asin);
     req.onsuccess = function () { callback(req.result || null); };
     req.onerror = function () { callback(null); };
   } catch (e) { callback(null); }
 }

 // =========================================================
 // 4. DISCORD WEBHOOK REAL-TIME ALERTER
 // =========================================================
 function sendDiscordAlert(data) {
   var webhookUrl = typeof GM_getValue === 'function' ? GM_getValue('vine_discord_webhook', DEFAULT_DISCORD_WEBHOOK) : DEFAULT_DISCORD_WEBHOOK;
   if (!webhookUrl || webhookUrl.indexOf('http') !== 0) return;
   if (STATE.alertedAsins[data.asin]) return;

   STATE.alertedAsins[data.asin] = true;

   var queueName = (new URLSearchParams(window.location.search).get('queue') || 'POTLUCK').toUpperCase();
   var colorCode = data.band === 'FREE' ? 65280 : 3887350;
   var etvDisplay = data.etv === 0 ? 'FREE ($0.00)' : (data.etv !== null ? '$' + data.etv.toFixed(2) : 'Unknown ETV');

   var payload = {
     content: '🚨 **New Item in ' + queueName + '!** [' + data.band + ']',
     embeds: [{
       title: data.title.length > 250 ? data.title.substring(0, 247) + '...' : data.title,
       url: data.url,
       color: colorCode,
       thumbnail: data.imgUrl !== 'N/A' ? { url: data.imgUrl } : undefined,
       fields: [
         { name: 'ETV Value', value: etvDisplay, inline: true },
         { name: 'ASIN', value: data.asin, inline: true }
       ],
       timestamp: new Date().toISOString()
     }]
   };

   var jsonString = JSON.stringify(payload);

   if (typeof GM_xmlhttpRequest === 'function') {
     GM_xmlhttpRequest({
       method: 'POST',
       url: webhookUrl,
       headers: { 'Content-Type': 'application/json' },
       data: jsonString
     });
   } else if (typeof fetch === 'function') {
     fetch(webhookUrl, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: jsonString
     }).catch(function () {});
   }
 }

 // =========================================================
 // 5. STYLES & TOOLBAR UI INJECTION
 // =========================================================
 function injectStyles() {
   if (document.getElementById('ave-master-styles')) return;
   var css = '#vvp-items-grid { display: grid !important; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)) !important; gap: 12px !important; }\n' +
     '#ave-top-bar { position: sticky; top: 0; z-index: 99999; background: #232f3e; color: #fff; padding: 8px 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-family: sans-serif; font-size: 12px; border-bottom: 3px solid #ff9900; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }\n' +
     '#ave-top-bar input[type="number"], #ave-top-bar input[type="search"], #ave-top-bar input[type="text"] { border: 1px solid #ccc; border-radius: 4px; padding: 4px 6px; font-size: 12px; background: #fff; color: #111; }\n' +
     '#ave-top-bar button { background: #ff9900; color: #111; border: none; border-radius: 4px; padding: 5px 10px; font-weight: bold; cursor: pointer; transition: background 0.2s; }\n' +
     '#ave-top-bar button:hover { background: #e68a00; }\n' +
     '#ave-top-bar button.btn-green { background: #10b981; color: #fff; }\n' +
     '#ave-top-bar button.btn-green:hover { background: #059669; }\n' +
     '.ave-etv-badge { display: block !important; padding: 4px 8px !important; margin: 4px 0 !important; border-radius: 4px !important; font-weight: bold !important; font-size: 12px !important; color: #fff !important; text-align: center !important; letter-spacing: 0.3px !important; min-width: 70px !important; }\n' +
     '.ave-fav-star { position: absolute; top: 6px; right: 10px; font-size: 20px; cursor: pointer; color: #ccc; z-index: 10; user-select: none; transition: color 0.2s; }\n' +
     '.ave-fav-star.is-fav { color: #f59e0b !important; text-shadow: 0 0 3px rgba(0,0,0,0.5); }\n' +
     '.vvp-details-btn input { background: #ffa41c !important; border-color: #ff8f00 !important; border-radius: 6px !important; font-weight: bold !important; cursor: pointer !important; width: 100% !important; height: 36px !important; }\n' +
     '.vinepro-dimmed { opacity: 0.35 !important; filter: grayscale(100%) !important; transition: opacity 0.2s, filter 0.2s; }\n' +
     '.vinepro-dimmed:hover { opacity: 1 !important; filter: grayscale(0%) !important; }';

   var style = document.createElement('style');
   style.id = 'ave-master-styles';
   style.textContent = css;
   document.head.appendChild(style);
 }

 function injectTopBar() {
   if (document.getElementById('ave-top-bar')) return;
   var savedWebhook = typeof GM_getValue === 'function' ? GM_getValue('vine_discord_webhook', DEFAULT_DISCORD_WEBHOOK) : DEFAULT_DISCORD_WEBHOOK;

   var bar = document.createElement('div');
   bar.id = 'ave-top-bar';
   bar.innerHTML = '<b style="color:#ff9900; font-size:13px;">Vine Master Suite</b> ' +
     '<input type="number" id="etv-min" placeholder="Min $" value="0" style="width:55px;"> ' +
     '<input type="number" id="etv-max" placeholder="Max $" value="9999" style="width:60px;"> ' +
     '<input type="search" id="search-input" placeholder="Search..." style="width:100px;"> ' +
     '<label style="display:flex; align-items:center; gap:3px; cursor:pointer;"><input type="checkbox" id="hide-junk-check" checked> Hide $0.01-$25</label> ' +
     '<input type="text" id="discord-url" placeholder="Discord Webhook URL" value="' + savedWebhook + '" style="width:130px;"> ' +
     '<button id="btn-save-webhook">Save Discord</button> ' +
     '<button id="btn-filter">Filter</button> ' +
     '<button id="btn-export" class="btn-green">Export CSV</button> ' +
     '<span id="master-status" style="margin-left:auto; color:#ccc; font-family:monospace;">Active</span>';
   document.body.prepend(bar);

   document.getElementById('btn-filter').addEventListener('click', applyFilters);
   document.getElementById('btn-export').addEventListener('click', downloadCSV);
   document.getElementById('search-input').addEventListener('input', applyFilters);
   document.getElementById('hide-junk-check').addEventListener('change', applyFilters);

   document.getElementById('btn-save-webhook').addEventListener('click', function () {
     var url = document.getElementById('discord-url').value.trim();
     if (typeof GM_setValue === 'function') {
       GM_setValue('vine_discord_webhook', url);
       alert('Discord Webhook Saved Successfully!');
     }
   });
 }

 // =========================================================
 // 6. TILE EXTRACTION & BADGING ENGINE
 // =========================================================
 function extractTileData(tile) {
   try {
     var titleEl = safeQuery(tile, CONFIG.selectors.title);
     var btnEl = safeQuery(tile, CONFIG.selectors.detailsBtn);
     var linkEl = safeQuery(tile, CONFIG.selectors.link);
     var imgEl = safeQuery(tile, CONFIG.selectors.img);

     var asin = btnEl ? safeAttr(btnEl, 'data-asin', 'N/A') : 'N/A';
     if (asin === 'N/A' && linkEl) {
       var href = safeAttr(linkEl, 'href', '');
       var match = href.match(/\/dp\/([A-Z0-9]{10})/i);
       if (match) asin = match[1].toUpperCase();
     }

     var recId = btnEl ? safeAttr(btnEl, 'data-recommendation-id', 'N/A') : 'N/A';
     var title = safeText(titleEl, 'UNKNOWN_TITLE');
     var etv = parseEtv(tile);
     var band = classifyEtv(etv);
     var url = linkEl ? window.location.origin + safeAttr(linkEl, 'href', '') : 'N/A';
     var imgUrl = imgEl ? safeAttr(imgEl, 'src', 'N/A') : 'N/A';

     return {
       asin: asin,
       recId: recId,
       title: title,
       etv: etv,
       band: band,
       url: url,
       imgUrl: imgUrl,
       isValid: !!(title !== 'UNKNOWN_TITLE' && asin !== 'N/A')
     };
   } catch (e) {
     return { isValid: false };
   }
 }

 function processTile(tile) {
   if (tile.dataset.vpProcessed === 'true') return;

   var data = extractTileData(tile);
   if (!data.isValid) {
     STATE.failedTiles++;
     return;
   }

   var badge = tile.querySelector('.ave-etv-badge');
   if (!badge) {
     badge = document.createElement('div');
     badge.className = 'ave-etv-badge';
     var titleContainer = safeQuery(tile, '.vvp-item-product-title-container') || tile.firstChild;
     if (titleContainer && titleContainer.parentNode) {
       titleContainer.parentNode.insertBefore(badge, titleContainer);
     } else {
       tile.prepend(badge);
     }
   }

   var bgColor = CONFIG.colors.unknown;
   var badgeText = 'ETV: Unknown';

   if (data.band === 'FREE') {
     bgColor = CONFIG.colors.free;
     badgeText = 'FREE ($0.00)';
   } else if (data.band === 'KEEP') {
     bgColor = CONFIG.colors.keep;
     badgeText = 'ETV: $' + data.etv.toFixed(2);
   } else if (data.band === 'EXCLUDED') {
     bgColor = CONFIG.colors.excluded;
     badgeText = 'EXCLUDED ($' + data.etv.toFixed(2) + ')';
     tile.classList.add('vinepro-dimmed');
   }

   badge.style.backgroundColor = bgColor;
   badge.textContent = badgeText;
   badge.setAttribute('data-etv', data.etv !== null ? data.etv : '');

   var favStar = tile.querySelector('.ave-fav-star');
   if (!favStar) {
     favStar = document.createElement('div');
     favStar.className = 'ave-fav-star';
     favStar.textContent = '★';
     tile.style.position = 'relative';
     tile.appendChild(favStar);

     getProductFromDB(data.asin, function (dbProd) {
       if (dbProd && dbProd.isFav) {
         favStar.classList.add('is-fav');
       }
     });

     favStar.addEventListener('click', function (e) {
       e.stopPropagation();
       favStar.classList.toggle('is-fav');
       var isFav = favStar.classList.contains('is-fav');
       saveProductToDB({
         asin: data.asin,
         recId: data.recId,
         title: data.title,
         etv: data.etv,
         isFav: isFav,
         lastSeen: Date.now()
       });
     });
   }

   saveProductToDB({
     asin: data.asin,
     recId: data.recId,
     title: data.title,
     etv: data.etv,
     lastSeen: Date.now()
   });

   if (data.band === 'FREE' || data.band === 'KEEP') {
     sendDiscordAlert(data);
   }

   tile.dataset.vpProcessed = 'true';
   STATE.processedTiles++;
 }

 function processGrid() {
   if (STATE.isHalted) return;
   var tiles = safeQueryAll(document, CONFIG.selectors.tile);
   if (!tiles.length) return;

   tiles.forEach(processTile);
   applyFilters();

   var totalAttempted = STATE.processedTiles + STATE.failedTiles;
   if (totalAttempted > 10 && (STATE.failedTiles / totalAttempted) > 0.30) {
     STATE.isHalted = true;
     var statusEl = document.getElementById('master-status');
     if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">⚠️ DOM Renamed. Halted.</span>';
     return;
   }

   var statusEl = document.getElementById('master-status');
   if (statusEl) statusEl.textContent = 'Tiles: ' + STATE.processedTiles + ' | Failures: ' + STATE.failedTiles;
 }

 // =========================================================
 // 7. FILTERS & CSV EXPORT
 // =========================================================
 function applyFilters() {
   var minInput = document.getElementById('etv-min');
   var maxInput = document.getElementById('etv-max');
   var searchInput = document.getElementById('search-input');
   var hideJunkCheck = document.getElementById('hide-junk-check');

   var min = minInput ? (parseFloat(minInput.value) || 0) : 0;
   var max = maxInput ? (parseFloat(maxInput.value) || 9999) : 9999;
   var search = searchInput ? searchInput.value.toLowerCase().trim() : '';
   var hideJunk = hideJunkCheck ? hideJunkCheck.checked : true;

   safeQueryAll(document, CONFIG.selectors.tile).forEach(function (tile) {
     var badge = tile.querySelector('.ave-etv-badge');
     var etvAttr = badge ? badge.getAttribute('data-etv') : null;
     var etv = (etvAttr !== null && etvAttr !== '') ? parseFloat(etvAttr) : null;

     var titleEl = safeQuery(tile, CONFIG.selectors.title);
     var titleText = titleEl ? safeText(titleEl, '').toLowerCase() : '';

     var isJunk = (etv !== null && etv >= CONFIG.bands.excludeMin && etv <= CONFIG.bands.excludeMax);
     var etvPass = (etv === 0) || (etv !== null && etv >= min && etv <= max) || etv === null;
     var junkPass = !hideJunk || !isJunk;
     var searchPass = !search || titleText.indexOf(search) !== -1;

     if (etvPass && junkPass && searchPass) {
       tile.style.display = '';
     } else {
       tile.style.display = 'none';
     }
   });
 }

 function downloadCSV() {
   var rows = [['ASIN', 'RecID', 'Title', 'ETV', 'Band', 'URL', 'ImageURL', 'Timestamp']];
   safeQueryAll(document, CONFIG.selectors.tile).forEach(function (tile) {
     if (tile.style.display === 'none') return;
     var d = extractTileData(tile);
     if (d.isValid && d.band !== 'EXCLUDED') {
       rows.push([
         d.asin,
         d.recId,
         '"' + d.title.replace(/"/g, '""') + '"',
         d.etv !== null ? d.etv : '?',
         d.band,
         d.url,
         d.imgUrl,
         new Date().toISOString()
       ]);
     }
   });

   if (rows.length <= 1) {
     alert('No active visible items found to export.');
     return;
   }

   var csvContent = rows.map(function (r) { return r.join(','); }).join('\n');
   var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
   var url = URL.createObjectURL(blob);
   var a = document.createElement('a');
   a.href = url;
   a.download = 'Vine_Master_Export_' + new Date().toISOString().slice(0, 10) + '.csv';
   document.body.appendChild(a);
   a.click();
   document.body.removeChild(a);
   URL.revokeObjectURL(url);
 }

 // =========================================================
 // 8. INFINITE SCROLL ENGINE
 // =========================================================
 function handleScroll() {
   var scrollBottom = window.scrollY + window.innerHeight;
   var pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
   if (scrollBottom >= pageHeight - (window.innerHeight * 1.5)) {
     loadMoreTiles();
   }
 }

 function loadMoreTiles() {
   if (STATE.isFetching || STATE.currentFetchPage >= STATE.maxFetchPage) return;
   var now = Date.now();
   if (now - STATE.lastFetchTime < CONFIG.pageLoadDelay) return;

   STATE.isFetching = true;
   STATE.lastFetchTime = now;
   STATE.currentFetchPage++;

   var baseUrl = window.location.href.replace(/[?#].*$/, '');
   var queue = new URLSearchParams(window.location.search).get('queue') || 'encore';
   var fetchUrl = baseUrl + '?queue=' + queue + '&page=' + STATE.currentFetchPage;

   fetch(fetchUrl)
     .then(function (r) { return r.text(); })
     .then(function (html) {
       var parser = new DOMParser();
       var doc = parser.parseFromString(html, 'text/html');
       var newTiles = safeQueryAll(doc, CONFIG.selectors.tile);
       var grid = safeQuery(document, CONFIG.selectors.grid);

       if (grid && newTiles.length > 0) {
         newTiles.forEach(function (tile) {
           var clone = tile.cloneNode(true);
           grid.appendChild(clone);
         });
         processGrid();
         applyFilters();
       } else {
         STATE.currentFetchPage = STATE.maxFetchPage; // Stop on empty page
       }
       STATE.isFetching = false;
     })
     .catch(function () { STATE.isFetching = false; });
 }

 // =========================================================
 // 9. OBSERVER & BOOT SEQUENCE
 // =========================================================
 function boot() {
   initDatabase(function () {
     injectStyles();
     injectTopBar();
     processGrid();

     var debounceTimer;
     var observer = new MutationObserver(function () {
       clearTimeout(debounceTimer);
       debounceTimer = setTimeout(processGrid, CONFIG.debounceMs);
     });
     observer.observe(document.body, { childList: true, subtree: true });

     window.addEventListener('scroll', handleScroll, { passive: true });
   });
 }

 if (document.readyState === 'loading') {
   document.addEventListener('DOMContentLoaded', boot);
 } else {
   boot();
 }
})();
