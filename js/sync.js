// Cross-device sync through a private GitHub Gist.
//
// Each sync is: download the gist → Store.mergeJSON(remote) → upload the merged result.
// Because the merge is idempotent (reviews union by id, decks/cards last-write-wins), a sync
// can never lose data, even if two devices sync at once. The worst case is one device's
// upload being overwritten. That device still has its data locally and re-uploads on its
// next sync.
//
// The token and gist id live under their own localStorage key, so they are never part of
// an export file or of the gist itself.
'use strict';

const Sync = (() => {
  const KEY = 'inatsr.sync.v1';
  const FILE = 'inat-srs-sync.json';
  const API = 'https://api.github.com';
  const AUTO_DELAY = 20000;   // upload this long after the last local change
  const listeners = new Set();

  let cfg = loadCfg();        // { token, gistId, lastSync }
  let running = null;         // in-flight sync promise, so calls coalesce
  let applyingRemote = false; // suppresses the change listener while we merge
  let status = { state: cfg.token ? 'idle' : 'off', msg: '' };

  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  }
  function saveCfg() {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
  }
  function setStatus(state, msg = '') {
    status = { state, msg };
    listeners.forEach(fn => fn(status));
  }

  async function gh(path, opts = {}) {
    const res = await fetch(API + path, Object.assign({}, opts, {
      headers: Object.assign({
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + cfg.token,
      }, opts.body ? { 'Content-Type': 'application/json' } : {}),
    }));
    if (res.status === 401) throw new Error('GitHub rejected the token. Is it expired or missing the "gist" scope?');
    if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
    return res.json();
  }

  /** Find our gist among the user's gists, so a second device connects to the same one. */
  async function findGist() {
    for (let page = 1; page <= 10; page++) {
      const list = await gh(`/gists?per_page=100&page=${page}`);
      const hit = list.find(g => g.files && g.files[FILE]);
      if (hit) return hit.id;
      if (list.length < 100) return null;
    }
    return null;
  }

  /** Returns the remote file's text, or null if the gist is gone. */
  async function download() {
    let gist;
    try { gist = await gh(`/gists/${cfg.gistId}`); }
    catch (e) { if (/ 404$/.test(e.message)) return null; throw e; }
    const f = gist.files[FILE];
    if (!f) return null;
    // The API inlines at most ~1 MB of content; larger files must be fetched from raw_url.
    if (!f.truncated) return f.content;
    const res = await fetch(f.raw_url);
    if (!res.ok) throw new Error(`Couldn't download sync file (${res.status})`);
    return res.text();
  }

  const files = text => JSON.stringify({ files: { [FILE]: { content: text } } });

  async function doSync() {
    setStatus('syncing');
    if (!cfg.gistId) {
      cfg.gistId = await findGist();
      saveCfg();
    }
    let remote = cfg.gistId ? await download() : null;

    if (remote) {
      applyingRemote = true;
      try { Store.mergeJSON(remote); } finally { applyingRemote = false; }
    }

    // Upload only if the merged result differs from what's already there.
    const local = Store.exportJSON();
    const strip = s => s.replace(/^\{\s*"exportedAt":\s*"[^"]*",?/, '{');
    if (!remote || strip(remote) !== strip(local)) {
      if (cfg.gistId && remote !== null) {
        await gh(`/gists/${cfg.gistId}`, { method: 'PATCH', body: files(local) });
      } else {
        const g = await gh('/gists', { method: 'POST', body: JSON.stringify({
          description: 'iNat Spaced Repetition sync data (managed by the app)',
          public: false,
          files: { [FILE]: { content: local } },
        }) });
        cfg.gistId = g.id;
      }
    }
    cfg.lastSync = Date.now();
    saveCfg();
    setStatus('idle');
  }

  /** Run a sync now. Concurrent calls share one run. Never throws; errors go to status. */
  function syncNow() {
    if (!cfg.token) return Promise.resolve();
    if (running) return running;
    running = doSync()
      .catch(e => { console.error('Sync failed', e); setStatus('error', e.message); })
      .finally(() => { running = null; });
    return running;
  }

  let timer = null;
  function scheduleSync() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; syncNow(); }, AUTO_DELAY);
  }

  async function connect(token) {
    cfg = { token: token.trim() };
    saveCfg();
    await syncNow();
    return status;
  }

  function disconnect() {
    clearTimeout(timer);
    timer = null;
    cfg = {};
    saveCfg();
    setStatus('off');
  }

  // ---------- automatic triggers ----------
  Store.onChange(() => { if (!applyingRemote && cfg.token) scheduleSync(); });
  document.addEventListener('visibilitychange', () => {
    if (!cfg.token) return;
    // Coming back to the tab: pick up the other device's reviews. Leaving it: push
    // any change still waiting on the timer, since the page may be killed (likely on phones).
    if (document.visibilityState === 'visible' || timer) { clearTimeout(timer); timer = null; syncNow(); }
  });
  if (cfg.token) setTimeout(syncNow, 0);

  return {
    connect, disconnect, syncNow,
    isConnected: () => !!cfg.token,
    lastSync: () => cfg.lastSync || 0,
    gistUrl: () => cfg.gistId ? `https://gist.github.com/${cfg.gistId}` : null,
    status: () => status,
    onStatus: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
