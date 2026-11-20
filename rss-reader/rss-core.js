// rss-core.js — Shared RSS extension utilities
// Exposed as window.RSSCore

(() => {
  const STORAGE_KEYS = {
    SOURCES: 'clairvoyance-rss-extension:sources-v1',
    CACHE: 'clairvoyance-rss-extension:cache-v1',
    READ: 'clairvoyance-rss-extension:read-v1',
    ACTIVE: 'clairvoyance-rss-extension:active-v1',
    FILTER: 'clairvoyance-rss-extension:filter-v1',
  };

  // --- Extension API ---

  let api = window.clairvoyance || null;
  let readyResolve = null;
  let readyPromise = api ? Promise.resolve(api) : null;

  function resolveAPI() {
    api = window.clairvoyance || null;
    if (api && readyResolve) {
      readyResolve(api);
      readyResolve = null;
      readyPromise = Promise.resolve(api);
    }
  }

  function waitForAPI() {
    if (api) return Promise.resolve(api);
    if (!readyPromise) {
      readyPromise = new Promise((resolve) => {
        readyResolve = resolve;
        setTimeout(() => {
          if (readyResolve) {
            readyResolve(window.clairvoyance || null);
            readyResolve = null;
          }
        }, 8000);
      });
    }
    return readyPromise;
  }

  resolveAPI();
  window.addEventListener('clairvoyance-ready', resolveAPI);
  window.addEventListener('message', (e) => {
    if (e?.data?.type === 'clairvoyance-ready') resolveAPI();
  });

  function getAPI() { return api; }

  function showToast(msg, type) {
    api?.ui?.showToast?.(msg, type);
  }

  // --- Cross-frame sync ---
  // BroadcastChannel fails at null origin (sandboxed iframes).
  // The platform now dispatches 'clairvoyance-storage-changed' events
  // to all sibling extension iframes after storage writes.

  let channel = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('clairvoyance-rss-extension-events');
    }
  } catch { /* sandboxed environment */ }

  function broadcast() {
    // Storage writes already trigger cross-frame events via the platform.
    // BroadcastChannel is kept as a bonus for non-sandboxed environments.
    channel?.postMessage({ type: 'rss-extension-update', at: Date.now() });
  }

  function onBroadcast(fn) {
    // Listen for platform cross-frame storage events (primary)
    window.addEventListener('clairvoyance-storage-changed', () => fn());

    // BroadcastChannel fallback (works only outside sandbox)
    if (channel) {
      channel.onmessage = (e) => {
        if (e.data?.type === 'rss-extension-update') fn();
      };
    }
  }

  // --- Storage ---

  const cache = new Map();
  let storageReady = false;
  let storagePromise = null;
  let writeBlocked = false;
  let warned = false;

  async function initStorage() {
    if (storageReady) return;
    if (storagePromise) return storagePromise;

    storagePromise = (async () => {
      await waitForAPI();
      const storage = api?.storage;
      if (!storage || typeof storage.get !== 'function') {
        storageReady = true;
        return;
      }
      try {
        const keys = Object.values(STORAGE_KEYS);
        const entries = await Promise.all(
          keys.map(async (key) => {
            try { return [key, await storage.get(key)]; }
            catch { return [key, undefined]; }
          })
        );
        for (const [key, value] of entries) {
          if (value !== undefined) cache.set(key, value);
        }
      } catch { /* storage unavailable */ }
      storageReady = true;
      storagePromise = null;
    })();

    return storagePromise;
  }

  function readKey(key, fallback) {
    return cache.has(key) ? (cache.get(key) ?? fallback) : fallback;
  }

  async function writeKey(key, value) {
    cache.set(key, value);
    if (writeBlocked) return;

    const storage = api?.storage;
    if (!storage || typeof storage.set !== 'function') {
      if (!warned) {
        warned = true;
        showToast('RSS storage unavailable — changes are session-only.', 'warning');
      }
      return;
    }

    try {
      await storage.set(key, value);
    } catch (err) {
      writeBlocked = true;
      if (!warned) {
        warned = true;
        showToast('RSS storage unavailable — changes are session-only.', 'warning');
      }
      console.error('[RSS] Storage write failed:', err);
    }
  }

  async function writeKeys(entries) {
    for (const [key, value] of Object.entries(entries)) {
      cache.set(key, value);
    }
    if (writeBlocked) return;

    const storage = api?.storage;
    if (!storage) {
      if (!warned) {
        warned = true;
        showToast('RSS storage unavailable — changes are session-only.', 'warning');
      }
      return;
    }

    try {
      if (typeof storage.batch === 'function') {
        await storage.batch(entries);
      } else {
        for (const [key, value] of Object.entries(entries)) {
          await storage.set(key, value);
        }
      }
    } catch (err) {
      writeBlocked = true;
      if (!warned) {
        warned = true;
        showToast('RSS storage unavailable — changes are session-only.', 'warning');
      }
      console.error('[RSS] Storage write failed:', err);
    }
  }

  async function refreshStorage() {
    const storage = api?.storage;
    if (!storage || typeof storage.get !== 'function') return;
    try {
      const keys = Object.values(STORAGE_KEYS);
      const entries = await Promise.all(
        keys.map(async (key) => {
          try { return [key, await storage.get(key)]; }
          catch { return [key, undefined]; }
        })
      );
      for (const [key, value] of entries) {
        if (value !== undefined) cache.set(key, value);
      }
    } catch { /* storage unavailable */ }
  }

  function isStorageAvailable() {
    return storageReady && !writeBlocked;
  }

  // --- Utilities ---

  function hash(input) {
    let h = 2166136261;
    const str = String(input || '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(16);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function toDateText(ts) {
    if (!ts) return 'No date';
    return new Date(ts).toLocaleString();
  }

  function uuid(prefix = 's') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // --- URL Helpers ---

  function normalizeUrl(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  function canonicalizeUrl(raw) {
    const withProtocol = normalizeUrl(raw);
    if (!withProtocol) return '';
    try {
      const u = new URL(withProtocol);
      if (!['http:', 'https:'].includes(u.protocol)) return '';
      const port = u.port ? `:${u.port}` : '';
      return `${u.protocol}//${u.hostname.toLowerCase()}${port}${u.pathname || '/'}${u.search}`;
    } catch {
      return '';
    }
  }

  // --- Feed Fetching ---

  async function fetchFeedText(feedUrl) {
    const errors = [];

    // 1) Prefer Clairvoyance net.fetch (CORS-free via Electron main process)
    if (api?.net?.fetch) {
      try {
        const res = await api.net.fetch(feedUrl, {
          headers: { Accept: 'application/xml, application/rss+xml, text/xml, */*' },
        });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        if (!text?.trim()) throw new Error('Empty response');
        return text;
      } catch (err) {
        errors.push(`net.fetch → ${err?.message || 'failed'}`);
      }
    }

    // 2) Direct fetch (works for feeds with CORS headers)
    try {
      const res = await fetch(feedUrl, {
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
        headers: { Accept: 'application/xml, application/rss+xml, text/xml, */*' },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      const text = await res.text();
      if (!text?.trim()) throw new Error('Empty response');
      return text;
    } catch (err) {
      errors.push(`fetch → ${err?.message || 'failed'}`);
    }

    // 3) Public CORS proxy fallback
    try {
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(feedUrl)}`;
      const res = await fetch(proxyUrl, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      const text = await res.text();
      if (!text?.trim()) throw new Error('Empty response');
      return text;
    } catch (err) {
      errors.push(`proxy → ${err?.message || 'failed'}`);
    }

    throw new Error(`Unable to fetch feed. ${errors[0] || ''}`);
  }

  // --- Feed Parsing ---

  function firstText(parent, names) {
    for (const name of names) {
      const node = parent.getElementsByTagName(name)[0];
      if (node?.textContent?.trim()) return node.textContent.trim();

      const local = name.split(':').pop();
      if (local !== name) {
        const localNode = parent.getElementsByTagName(local)[0];
        if (localNode?.textContent?.trim()) return localNode.textContent.trim();
      }
    }
    return '';
  }

  function parseFeed(xmlText, sourceUrl) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Feed is not valid XML.');

    const items = [...doc.querySelectorAll('item, entry')];
    if (!items.length) throw new Error('No feed entries found.');

    return items.map((item) => {
      const title = firstText(item, ['title']) || 'Untitled';

      let link = firstText(item, ['link']);
      if (!link) {
        const el = item.querySelector('link[rel="alternate"]') || item.querySelector('link');
        link = el?.getAttribute('href') || el?.textContent?.trim() || '';
      }
      if (!link) {
        link = item.querySelector('enclosure')?.getAttribute('url') || '';
      }

      const guid = firstText(item, ['guid', 'id']) || link || title;
      const dateStr = firstText(item, ['pubDate', 'published', 'updated', 'dc:date']);
      const publishedAt = dateStr ? Date.parse(dateStr) : 0;
      const summary = firstText(item, ['description', 'summary']) || '';
      const content = firstText(item, ['content:encoded', 'content']) || summary;

      return {
        id: `${sourceUrl}|${guid}|${hash(guid + link)}`,
        sourceUrl, title, link, publishedAt, summary, content,
      };
    });
  }

  // --- Source List ---

  function cleanLabel(raw) {
    const text = String(raw || '').trim();
    return text ? text.replace(/\s+/g, ' ').slice(0, 120) : '';
  }

  function normalizeSourceList(rawSources) {
    const sources = Array.isArray(rawSources) ? rawSources : [];
    const byUrl = new Map();
    const result = [];

    for (const s of sources) {
      if (!s || typeof s !== 'object') continue;
      const url = canonicalizeUrl(s.url);
      if (!url) continue;

      const entry = {
        id: s.id || uuid('source'),
        title: cleanLabel(s.title) || url.replace(/^https?:\/\//, '').split('/')[0],
        url,
        createdAt: Number.isFinite(Number(s.createdAt)) ? Number(s.createdAt) : Date.now(),
        lastRefreshed: Number.isFinite(Number(s.lastRefreshed)) ? Number(s.lastRefreshed) : 0,
        lastError: s.lastError || null,
      };

      const existing = byUrl.get(url);
      if (!existing) {
        byUrl.set(url, entry);
        result.push(entry);
      } else if (entry.lastRefreshed > (existing.lastRefreshed || 0)) {
        const idx = result.indexOf(existing);
        if (idx >= 0) result[idx] = entry;
        byUrl.set(url, entry);
      }
    }

    return result;
  }

  // --- Badge ---

  function setUnreadBadge(count) {
    if (api?.ui?.setBadge) {
      if (count > 0) {
        api.ui.setBadge(count, '#ef4444');
      } else {
        api.ui.clearBadge();
      }
    }
  }

  // --- Image fetching (CORS-free) ---

  async function fetchImageBlob(src) {
    // 1) Prefer net.fetch with base64 response
    if (api?.net?.fetch) {
      try {
        const res = await api.net.fetch(src, { responseType: 'base64' });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        const contentType = res.headers?.['content-type'] || 'image/png';
        const byteString = atob(res.body);
        const ab = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) ab[i] = byteString.charCodeAt(i);
        return new Blob([ab], { type: contentType });
      } catch { /* fall through */ }
    }

    // 2) Direct fetch
    try {
      const res = await fetch(src, { credentials: 'omit' });
      if (!res.ok) throw new Error(res.status);
      return await res.blob();
    } catch { /* fall through */ }

    // 3) CORS proxy fallback
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(src)}`;
    const res = await fetch(proxyUrl, { credentials: 'omit' });
    if (!res.ok) throw new Error(res.status);
    return await res.blob();
  }

  // --- Export ---

  window.RSSCore = {
    STORAGE_KEYS,
    getAPI, waitForAPI, showToast,
    broadcast, onBroadcast,
    initStorage, refreshStorage, readKey, writeKey, writeKeys, isStorageAvailable,
    hash, escapeHtml, toDateText, uuid,
    normalizeUrl, canonicalizeUrl,
    fetchFeedText, parseFeed, fetchImageBlob,
    normalizeSourceList, cleanLabel,
    setUnreadBadge,
  };
})();
