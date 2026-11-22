// UI: hash router + three views (home, deck editor, study session).
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
let viewCleanup = null;

// ---------- shared helpers ----------
const RANK_LABEL = r => r ? r.charAt(0).toUpperCase() + r.slice(1) : '';

/** Scientific name with iNat-style formatting (italic at genus and below). */
function sciHtml(t) {
  const lvl = t.rankLevel ?? t.rank_level ?? 10;
  const name = lvl <= 20 ? `<i>${esc(t.name)}</i>` : esc(t.name);
  return t.rank && t.rank !== 'species' ? `${RANK_LABEL(t.rank)} ${name}` : name;
}

function nameHtml(t) {
  const common = t.commonName ?? t.preferred_common_name;
  return common
    ? `<span class="common">${esc(common)}</span> <span class="sci">${sciHtml(t)}</span>`
    : `<span class="sci only">${sciHtml(t)}</span>`;
}

/** Make sure deck taxa are cached, with ancestry (older caches lack it). Returns how many were fetched. */
async function ensureTaxa(ids, opts) {
  const missing = ids.filter(id => { const t = Store.getTaxon(id); return !t || !t.ancestors; });
  if (missing.length) Store.putTaxa(await INat.fetchTaxa(missing, opts));
  return missing.length;
}

/** Returns { added, conflicts } (conflicts: taxa already in the deck with different filters). */
async function addTaxaToDeck(deckId, ids, filters = null) {
  await ensureTaxa(ids);
  return Store.addCards(deckId, ids, filters);
}

// Names of taxa that aren't cards (an observation's species under a genus card, say), used to
// accept more-specific typed answers. Kept in the local cache, not the synced data.
const NameCache = {
  get: id => Store.getTaxon(id) || Store.getCache('tn.' + id),
  async ensure(ids) {
    const miss = ids.filter(id => !NameCache.get(id));
    if (!miss.length) return;
    for (const t of await INat.fetchTaxa(miss, { priority: false })) {
      Store.setCache('tn.' + t.id, { id: t.id, name: t.name, commonName: t.commonName, names: t.names, sciNames: t.sciNames });
    }
  },
};

const labelOf = t => t.commonName || t.name;
const groupOf = t => ({
  names: t.names || [t.name, t.commonName], sciNames: t.sciNames || [t.name], label: labelOf(t),
});

/** Input for Match.check: the card's taxon plus more-specific, excluded and broader taxa. */
function answerGroups(taxon, photo, excluded) {
  const specific = [];
  if (photo.taxon && photo.taxon.id !== taxon.id) {
    for (const id of [...(photo.between || []), photo.taxon.id]) {
      const t = NameCache.get(id) || (id === photo.taxon.id ? photo.taxon : null);
      if (t) specific.push(groupOf(t));
    }
  }
  return {
    card: groupOf(taxon),
    specific,
    excluded: excluded.map(id => Store.getTaxon(id)).filter(Boolean).map(groupOf),
    broader: (taxon.ancestors || []).map(groupOf),
  };
}

/**
 * Photo-filter editor (place, annotations, months, dates), used for deck defaults, per-card
 * filters and the "add taxa" filters. Calls onChange(cleanFilters) on every edit.
 *   taxon: restrict annotation choices to ones that apply to it (null → all)
 *   deckFilters: when editing a card, the deck's filters (enables the "ignore deck …" options)
 */
function filterEditor(el, initial, { taxon = null, deckFilters = undefined, onChange = () => {} } = {}) {
  const f = JSON.parse(JSON.stringify(Filters.clean(initial) || {}));
  f.annos = f.annos || [];
  const deckF = deckFilters === undefined ? null : (Filters.clean(deckFilters) || {});
  const forCard = deckFilters !== undefined;
  const monthOpts = sel => `<option value="">Any</option>` +
    Filters.MONTHS.map((m, i) => `<option value="${i + 1}" ${sel === i + 1 ? 'selected' : ''}>${m}</option>`).join('');
  const deckOther = deckF && Filters.parts(Object.assign({}, deckF, { place: null }));

  el.innerHTML = `
    <div class="fe">
      <div class="fe-row"><span class="fe-lbl">Place</span>
        <div class="fe-ctl"><div class="ac"><input data-f="place" placeholder="${forCard && deckF.place ? `Deck: ${esc(deckF.place.name)}. Type to use another place` : 'Anywhere. Type to choose a place'}" autocomplete="off"></div>
        <span class="chosen" data-f="placeSel"></span>
        ${forCard && deckF.place ? `<label class="small"><input type="checkbox" data-f="noDeckPlace" ${f.noDeckPlace ? 'checked' : ''}> Ignore the deck's place (${esc(deckF.place.name)})</label>` : ''}</div></div>
      <div class="fe-row"><span class="fe-lbl">Annotations</span>
        <div class="fe-ctl"><div data-f="annos"></div>
        <button type="button" class="small" data-act="addAnno">+ Add annotation</button></div></div>
      <div class="fe-row"><span class="fe-lbl">Months</span>
        <div class="fe-ctl row tight"><select data-f="mfrom">${monthOpts(f.months && f.months.from)}</select> to
          <select data-f="mto">${monthOpts(f.months && f.months.to)}</select></div></div>
      <div class="fe-row"><span class="fe-lbl">Dates</span>
        <div class="fe-ctl row tight"><input type="date" data-f="d1" value="${esc(f.d1 || '')}"> to
          <input type="date" data-f="d2" value="${esc(f.d2 || '')}"></div></div>
      ${forCard && deckOther.length ? `<label class="small"><input type="checkbox" data-f="noDeckFilters" ${f.noDeckFilters ? 'checked' : ''}>
        Ignore the deck's other filters (${esc(deckOther.join(' · '))})</label>` : ''}
      <p class="muted small">Tip: “is not” keeps observations nobody annotated, while “is” only keeps annotated ones, which can
        cut the number of photos a lot. For example, “Alive or Dead is not Dead” loses far fewer photos than “is Alive”.</p>
    </div>`;
  const q = s => el.querySelector(`[data-f="${s}"]`);
  const emit = () => onChange(Filters.clean(f));

  const showPlace = () => {
    const sel = q('placeSel');
    sel.innerHTML = f.place ? `${esc(f.place.name)} <button type="button" class="link" title="Clear">✕</button>` : '';
    if (f.place) sel.querySelector('button').onclick = () => { f.place = null; showPlace(); emit(); };
  };
  autocomplete(q('place'), {
    fetch: INat.autocompletePlaces, render: p => esc(p.display_name),
    onPick: p => { f.place = { id: p.id, name: p.display_name }; q('place').value = ''; showPlace(); emit(); },
  });
  showPlace();

  let termList = null;
  const ancestry = taxon ? [taxon.id, ...(taxon.ancestors || []).map(a => a.id)] : null;
  function renderAnnos() {
    const box = q('annos');
    const terms = termList ? Filters.applicable(termList, ancestry) : [];
    box.innerHTML = f.annos.map((a, i) => {
      const term = terms.find(t => t.id === a.term);
      const termOpts = terms.map(t => `<option value="${t.id}" ${t.id === a.term ? 'selected' : ''}>${esc(t.label)}</option>`).join('')
        || `<option value="${a.term}">${esc((a.label || '').split(': ')[0] || 'Annotation')}</option>`;
      const vals = term ? term.values : [{ id: a.value, label: (a.label || '').split(': ')[1] || a.value }];
      return `<div class="row tight fe-anno" data-i="${i}">
        <select data-a="term">${termOpts}</select>
        <select data-a="not"><option value="">is</option><option value="1" ${a.not ? 'selected' : ''}>is not</option></select>
        <select data-a="value">${vals.map(v => `<option value="${v.id}" ${v.id === a.value ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
        <button type="button" class="link" data-a="del" title="Remove">✕</button></div>`;
    }).join('');
  }
  const labelFor = (termId, valueId) => {
    const t = termList && termList.find(x => x.id === termId);
    const v = t && t.values.find(x => x.id === valueId);
    return t && v ? `${t.label}: ${v.label}` : '';
  };
  Filters.terms().then(list => { termList = list; if (el.isConnected) renderAnnos(); })
    .catch(() => { if (el.isConnected) q('annos').innerHTML = '<span class="muted small">Couldn’t load annotation types from iNaturalist.</span>'; });
  renderAnnos();

  el.querySelector('[data-act=addAnno]').onclick = () => {
    if (!termList) return;
    const terms = Filters.applicable(termList, ancestry);
    if (!terms.length) return;
    const t = terms[0], v = t.values[0];
    f.annos.push({ term: t.id, value: v.id, not: false, label: labelFor(t.id, v.id) });
    renderAnnos(); emit();
  };
  q('annos').addEventListener('change', e => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const a = f.annos[+row.dataset.i];
    const k = e.target.dataset.a;
    if (k === 'term') {
      a.term = +e.target.value;
      const t = Filters.applicable(termList || [], ancestry).find(x => x.id === a.term);
      a.value = t ? t.values[0].id : a.value;
    } else if (k === 'value') a.value = +e.target.value;
    else if (k === 'not') a.not = !!e.target.value;
    a.label = labelFor(a.term, a.value) || a.label;
    renderAnnos(); emit();
  });
  q('annos').addEventListener('click', e => {
    if (e.target.dataset.a !== 'del') return;
    f.annos.splice(+e.target.closest('[data-i]').dataset.i, 1);
    renderAnnos(); emit();
  });

  const months = () => {
    const from = +q('mfrom').value || 0, to = +q('mto').value || 0;
    f.months = from || to ? { from: from || to, to: to || from } : null;
    emit();
  };
  q('mfrom').onchange = months;
  q('mto').onchange = months;
  q('d1').onchange = e => { f.d1 = e.target.value || null; emit(); };
  q('d2').onchange = e => { f.d2 = e.target.value || null; emit(); };
  if (q('noDeckPlace')) q('noDeckPlace').onchange = e => { f.noDeckPlace = e.target.checked; emit(); };
  if (q('noDeckFilters')) q('noDeckFilters').onchange = e => { f.noDeckFilters = e.target.checked; emit(); };

  return { get: () => Filters.clean(f) };
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Generic autocomplete dropdown attached to an input. */
function autocomplete(input, { fetch, render, onPick }) {
  const list = document.createElement('div');
  list.className = 'ac-list';
  list.hidden = true;
  input.parentNode.appendChild(list);
  let seq = 0, items = [];
  const run = debounce(async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (q.length < 2) { list.hidden = true; return; }
    try {
      const res = await fetch(q);
      if (my !== seq) return;
      items = res;
      list.innerHTML = res.length
        ? res.map((r, i) => `<button type="button" class="ac-item" data-i="${i}">${render(r)}</button>`).join('')
        : '<div class="ac-empty">No matches</div>';
      list.hidden = false;
    } catch (e) {
      list.innerHTML = `<div class="ac-empty">${esc(e.message)}</div>`;
      list.hidden = false;
    }
  }, 350);
  input.addEventListener('input', run);
  input.addEventListener('keydown', e => { if (e.key === 'Escape') list.hidden = true; });
  list.addEventListener('click', e => {
    const b = e.target.closest('.ac-item');
    if (!b) return;
    list.hidden = true;
    onPick(items[+b.dataset.i]);
  });
  document.addEventListener('click', e => { if (!list.contains(e.target) && e.target !== input) list.hidden = true; });
}

const taxonAcRender = t => `
  ${t.default_photo ? `<img src="${esc(t.default_photo.square_url)}" alt="">` : '<span class="noimg"></span>'}
  <span>${nameHtml(t)}<small class="muted"> · ${(t.observations_count || 0).toLocaleString()} obs</small></span>`;

/** Card filters that drop both the card's own and the deck's filters. */
const NO_FILTERS = { noDeckPlace: true, noDeckFilters: true };

// ---------- router ----------
function route() {
  if (viewCleanup) { viewCleanup(); viewCleanup = null; }
  const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (parts[0] === 'deck' && parts[1]) return viewDeck(parts[1]);
  if (parts[0] === 'study' && parts[1]) return viewStudy(parts[1]);
  viewHome();
}
window.addEventListener('hashchange', route);

// =====================================================================
// HOME
// =====================================================================
function viewHome() {
  const decks = Store.listDecks();
  const rows = decks.map(d => {
    const s = Scheduler.summary(d.id);
    const n = s.due.length + s.newLeft;
    return `<tr>
      <td><a href="#/deck/${d.id}">${esc(d.name)}</a></td>
      <td class="num due">${s.due.length}</td><td class="num new">${s.newLeft}</td><td class="num">${s.total}</td>
      <td class="right nowrap">${n ? `<a class="button primary" href="#/study/${d.id}">Study</a>` : '<span class="muted">Done</span>'}
        <button class="small" data-delete="${d.id}" title="Delete this deck">Delete</button></td>
    </tr>`;
  }).join('');

  app.innerHTML = `
    <header class="top"><h1>iNat Spaced Repetition</h1>
      <p class="muted">Learn to identify taxa from a fresh iNaturalist photo every review.</p></header>
    <section class="panel">
      <h2>Decks</h2>
      ${decks.length ? `<table class="list"><thead><tr><th>Deck</th><th class="num">Due</th><th class="num">New</th><th class="num">Cards</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="muted">No decks yet. Create one to get started.</p>'}
      <form id="newDeck" class="row">
        <input name="name" placeholder="New deck name, e.g. “Bay Area oaks”" required>
        <button class="primary">Create deck</button>
      </form>
    </section>
    <section class="panel" id="syncPanel">${syncPanelHtml()}</section>
    <section class="panel">
      <h2>Data &amp; settings</h2>
      <p class="muted">Decks and review history are stored in this browser. Export to back up or to move to another
        device. Importing <em>merges</em> with what's here, so it never loses reviews from either side.</p>
      <div class="row">
        <button id="export">Export…</button>
        <label class="button">Import / merge…<input type="file" id="import" accept=".json,application/json" hidden></label>
        <span id="dataMsg" class="muted"></span>
      </div>
      <div class="row">
        <label>Common-name language
          <input id="locale" size="5" value="${esc(Store.getSettings().locale)}" title="iNaturalist locale code, e.g. en, es, fr, de"></label>
        <span class="muted small">Applies to taxa added from now on.</span>
      </div>
    </section>
    <footer class="muted small">Photos come from research-grade iNaturalist observations licensed CC0, CC BY, or CC BY-NC, credited on every card.</footer>`;

  app.querySelectorAll('[data-delete]').forEach(b => b.onclick = () => {
    const d = Store.getDeck(b.dataset.delete);
    if (!d) return;
    const n = Store.deckCards(d.id).length;
    if (!confirm(`Delete the deck “${d.name}” (${n} card${n === 1 ? '' : 's'})?`)) return;
    Store.deleteDeck(d.id);
    viewHome();
  });
  $('#newDeck').onsubmit = e => {
    e.preventDefault();
    const d = Store.createDeck(e.target.name.value.trim());
    location.hash = `#/deck/${d.id}`;
  };
  $('#export').onclick = () => {
    const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `inat-srs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#import').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const st = Store.mergeJSON(await f.text());
      viewHome();
      $('#dataMsg').textContent = `Merged: ${st.decks} new deck(s), ${st.reviews} new review(s).`;
    } catch (err) { $('#dataMsg').textContent = 'Import failed: ' + err.message; }
  };
  $('#locale').onchange = e => Store.updateSettings({ locale: e.target.value.trim() || 'en' });
  bindSyncPanel();
}

// ---------- sync panel (home) ----------
const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=iNat%20SRS%20sync';

function agoText(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function syncPanelHtml() {
  const st = Sync.status();
  if (!Sync.isConnected()) {
    return `<h2>Sync between devices</h2>
      <p class="muted">Keeps decks and reviews in sync between your devices, using a private GitHub Gist
        as storage. <a href="${TOKEN_URL}" target="_blank" rel="noopener">Create a token</a> with only the
        <b>gist</b> scope, then paste it here. Use the same token on each device.</p>
      <form id="syncConnect" class="row">
        <input name="token" type="password" placeholder="GitHub token (ghp_…)" autocomplete="off" required>
        <button class="primary">Connect</button>
      </form>`;
  }
  const line = st.state === 'syncing' ? 'Syncing…'
    : st.state === 'error' ? `<span class="error">Sync failed: ${esc(st.msg)}</span>`
    : `Last synced ${agoText(Sync.lastSync())}.`;
  const gist = Sync.gistUrl();
  return `<h2>Sync between devices</h2>
    <p class="muted">Syncs automatically when you open the app, return to it, or about 20 s after a change.</p>
    <div class="row">
      <button id="syncNow" ${st.state === 'syncing' ? 'disabled' : ''}>Sync now</button>
      <span class="muted small">${line}${gist ? ` · <a href="${gist}" target="_blank" rel="noopener">gist</a>` : ''}</span>
      <button id="syncOff" class="small">Disconnect</button>
    </div>`;
}

function bindSyncPanel() {
  const panel = $('#syncPanel');
  if (!panel) return;
  const form = $('#syncConnect', panel);
  if (form) form.onsubmit = e => { e.preventDefault(); Sync.connect(e.target.token.value); };
  const now = $('#syncNow', panel);
  if (now) now.onclick = () => Sync.syncNow();
  const off = $('#syncOff', panel);
  if (off) off.onclick = () => {
    if (confirm('Stop syncing on this device? Your data stays here and in the gist.')) Sync.disconnect();
  };
}

Sync.onStatus(st => {
  if (!$('#syncPanel')) return;
  // A finished sync may have brought in decks or reviews from the other device:
  // redraw the whole home view (due counts) unless the user is typing in it.
  const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (st.state === 'idle' && !typing) return viewHome();
  $('#syncPanel').innerHTML = syncPanelHtml();
  bindSyncPanel();
});

// =====================================================================
// DECK EDITOR
// =====================================================================
function viewDeck(deckId) {
  const deck = Store.getDeck(deckId);
  if (!deck) { location.hash = '#/'; return; }

  app.innerHTML = `
    <header class="top">
      <a href="#/" class="back">← Decks</a>
      <input class="title-input" id="deckName" value="${esc(deck.name)}" aria-label="Deck name">
    </header>

    <section class="panel">
      <h2>Settings</h2>
      <div class="row">
        <label>Review mode
          <select id="mode">${ReviewModes.list().map(m =>
            `<option value="${m.id}" ${m.id === deck.mode ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
        <label>New cards / day <input id="newPerDay" type="number" min="0" max="999" value="${deck.newPerDay}"></label>
        <label>Card order
          <select id="order">
            <option value="random" ${deck.order !== 'added' ? 'selected' : ''}>Random</option>
            <option value="added" ${deck.order === 'added' ? 'selected' : ''}>As added</option>
          </select></label>
      </div>
      <div class="row">
        <label><input type="checkbox" id="showMap" ${deck.showMap !== false ? 'checked' : ''}>
          Show where the photo was taken (map) before revealing the answer</label>
      </div>
      <h3>Photo filters for every card <span id="deckFSum" class="muted small"></span></h3>
      <p class="muted small">Limits which observations all cards in this deck draw photos from. Individual cards can add
        their own filters on top (their place, months and dates replace these; annotations from both apply).</p>
      <div id="deckFE"></div>
    </section>

    <section class="panel">
      <h2>Add taxa</h2>
      <details class="addfilters"><summary>Extra photo filters for cards added below: <span id="addFSum"></span></summary>
        <div id="addFE"></div></details>
      <div class="tabs" role="tablist">
        <button class="tab active" data-tab="search">Search</button>
        <button class="tab" data-tab="paste">Paste a list</button>
        <button class="tab" data-tab="generate">Generate from iNat</button>
      </div>

      <div class="tabpane" data-pane="search">
        <div class="ac"><input id="taxonSearch" placeholder="Any taxon: species, subspecies, genus, family…" autocomplete="off"></div>
        <p class="muted small">Click a result to add it. Higher-rank cards (e.g. a genus) show photos of any member of that taxon.</p>
      </div>

      <div class="tabpane" data-pane="paste" hidden>
        <textarea id="pasteList" rows="6" placeholder="One name per line (scientific or common)"></textarea>
        <div class="row"><button id="resolveBtn" class="primary">Look up names</button><span id="resolveMsg" class="muted"></span></div>
        <div id="resolveOut"></div>
      </div>

      <div class="tabpane" data-pane="generate" hidden>
        <p class="muted small">The most-observed species (research grade) within a taxon. Counts use the photo filters
          (the deck's plus the extra ones above), so a place or months filter gives you the commonest species there and then.</p>
        <label>Within taxon<div class="ac"><input id="genTaxon" placeholder="e.g. Quercus, Aves, Asteraceae" autocomplete="off"></div>
          <span id="genTaxonSel" class="chosen"></span></label>
        <p class="muted small" id="genFSum"></p>
        <div class="row">
          <label>How many <input id="genCount" type="number" min="1" max="500" value="50"></label>
          <button id="genBtn" class="primary" disabled>Preview</button><span id="genMsg" class="muted"></span>
        </div>
        <div id="genOut"></div>
      </div>
      <div id="addMsg" class="muted"></div>
      <div id="addConflict"></div>
    </section>

    <section class="panel">
      <div class="row spread"><h2>Cards <span id="cardCount" class="muted"></span></h2>
        <div class="row"><button id="checkPhotos" title="Fetch a sample of observations for each card to see how many eligible photos exist">Check photo supply</button></div></div>
      <div id="lowNote"></div>
      <div id="cards"></div>
    </section>

    <section class="panel bottom-actions">
      <a class="button primary" id="studyBtn" href="#/study/${deck.id}">Study</a>
    </section>`;

  // --- settings ---
  $('#deckName').onchange = e => Store.updateDeck(deckId, { name: e.target.value.trim() || deck.name });
  $('#mode').onchange = e => Store.updateDeck(deckId, { mode: e.target.value });
  $('#order').onchange = e => Store.updateDeck(deckId, { order: e.target.value });
  $('#showMap').onchange = e => Store.updateDeck(deckId, { showMap: e.target.checked });
  $('#newPerDay').onchange = e => Store.updateDeck(deckId, { newPerDay: Math.max(0, parseInt(e.target.value, 10) || 0) });

  // --- photo filters ---
  let addF = null;
  const filterSums = () => {
    const deckF = Store.getDeck(deckId).filters;
    const sm = Filters.summary(deckF);
    $('#deckFSum').textContent = sm ? `(${sm})` : '(none)';
    $('#addFSum').textContent = Filters.summary(addF) || 'none';
    const eff = Filters.summary(Filters.combine(deckF, addF));
    $('#genFSum').textContent = eff ? `Filters in use: ${eff}` : '';
  };
  filterEditor($('#deckFE'), deck.filters, {
    onChange: f => { Store.updateDeck(deckId, { filters: f }); filterSums(); renderCards(); },
  });
  // Rebuilt each time it's opened, so its "ignore the deck's …" options match the current deck filters.
  const openAddEditor = () => filterEditor($('#addFE'), addF, {
    deckFilters: Store.getDeck(deckId).filters, onChange: f => { addF = f; filterSums(); },
  });
  openAddEditor();
  $('.addfilters').addEventListener('toggle', e => { if (e.target.open) openAddEditor(); });
  filterSums();

  // --- tabs ---
  $$('.tab').forEach(b => b.onclick = () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === b));
    $$('.tabpane').forEach(p => p.hidden = p.dataset.pane !== b.dataset.tab);
  });

  const addMsg = t => { $('#addMsg').textContent = t; };
  const add = async ids => {
    addMsg(ids.length > 1 ? `Adding ${ids.length}…` : 'Adding…');
    $('#addConflict').innerHTML = '';
    const { added, conflicts } = await addTaxaToDeck(deckId, ids, addF);
    addMsg(added ? `Added ${added} card${added > 1 ? 's' : ''}.` : conflicts.length ? '' : 'Already in deck.');
    renderCards();
    if (conflicts.length) showConflicts(conflicts, addF);
    return added;
  };
  function showConflicts(ids, filters) {
    const names = ids.map(Filters.taxonLabel).map(esc).join(', ');
    const want = Filters.summary(filters) || 'no extra filters';
    $('#addConflict').innerHTML = `<div class="warn">${ids.length === 1 ? 'This taxon is' : `${ids.length} taxa are`} already in the deck
      with different photo filters: ${names}.<br>Change ${ids.length === 1 ? 'its' : 'their'} filters to <b>${esc(want)}</b>, or keep the current ones?
      <div class="row"><button class="primary" data-act="cupdate">Change filters</button><button data-act="ckeep">Keep current</button></div></div>`;
    $('#addConflict [data-act=cupdate]').onclick = () => {
      for (const id of ids) Store.updateCard(deckId, id, { filters: Filters.clean(filters) });
      $('#addConflict').innerHTML = '';
      addMsg(`Changed filters on ${ids.length} card${ids.length > 1 ? 's' : ''}.`);
      renderCards();
    };
    $('#addConflict [data-act=ckeep]').onclick = () => { $('#addConflict').innerHTML = ''; };
  }

  // --- search tab ---
  autocomplete($('#taxonSearch'), {
    fetch: INat.autocompleteTaxa, render: taxonAcRender,
    onPick: async t => {
      try { await add([t.id]); } catch (e) { addMsg(e.message); }
      $('#taxonSearch').value = '';
      $('#taxonSearch').focus();
    },
  });

  // --- paste tab ---
  // Names already in the local taxa cache (e.g. from other decks) resolve without a request.
  // The rest are looked up one per request (iNat's rate limit), and each row appears as soon
  // as its answer arrives, so you can review matches while later ones load.
  let resolveRun = 0;
  $('#resolveBtn').onclick = async () => {
    const lines = [...new Set($('#pasteList').value.split('\n').map(s => s.trim()).filter(Boolean))];
    if (!lines.length) return;
    const run = ++resolveRun;
    const out = $('#resolveOut');
    const local = new Map();
    for (const t of Store.allTaxa()) {
      for (const n of [t.name, t.commonName, ...(t.names || [])]) {
        if (!n) continue;
        const k = Match.normalize(n);
        if (!local.has(k)) local.set(k, t);
      }
    }
    const rows = lines.map(line => ({ line, results: null }));
    out.innerHTML = `
      <table class="list"><thead><tr><th></th><th>You wrote</th><th>Matched taxon</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr data-i="${i}"><td></td><td>${esc(r.line)}</td><td class="muted">Waiting…</td></tr>`).join('')}
      </tbody></table>
      <div class="row"><button id="addResolved" class="primary">Add checked</button></div>`;
    const renderRow = i => {
      const r = rows[i];
      const tr = $(`tr[data-i="${i}"]`, out);
      tr.className = r.exact ? '' : 'fuzzy';
      tr.innerHTML = `
        <td><input type="checkbox" data-i="${i}" ${r.exact ? 'checked' : ''} ${r.results.length ? '' : 'disabled'}></td>
        <td>${esc(r.line)}</td>
        <td>${r.results.length ? `<select data-i="${i}">${r.results.map((t, j) =>
            `<option value="${t.id}" ${j === r.sel ? 'selected' : ''}>${esc(t.name)}${t.preferred_common_name ? ' (' + esc(t.preferred_common_name) + ')' : ''} — ${esc(t.rank)}</option>`).join('')}</select>
            ${r.exact ? '' : '<span class="warn-inline">check this</span>'}`
          : '<span class="warn-inline">no match</span>'}</td>`;
    };
    $('#addResolved').onclick = async () => {
      const boxes = $$('input[type=checkbox][data-i]', out).filter(c => c.checked);
      const ids = boxes.map(c => +$(`select[data-i="${c.dataset.i}"]`, out).value);
      if (!ids.length) return;
      const stillLooking = rows.some(r => !r.results);
      try {
        await add(ids);
        if (stillLooking) boxes.forEach(c => { c.checked = false; c.disabled = true; }); // keep going with the rest
        else { resolveRun++; out.innerHTML = ''; $('#pasteList').value = ''; }
      } catch (e) { addMsg(e.message); }
    };
    // Local matches first (instant), then network lookups in order.
    const todo = [];
    rows.forEach((r, i) => {
      const t = local.get(Match.normalize(r.line));
      if (t) {
        Object.assign(r, { results: [{ id: t.id, name: t.name, preferred_common_name: t.commonName, rank: t.rank }], exact: true, sel: 0 });
        renderRow(i);
      } else todo.push(i);
    });
    for (let k = 0; k < todo.length; k++) {
      if (run !== resolveRun || !out.isConnected) return;
      const i = todo[k];
      const found = rows.length - todo.length;
      $('#resolveMsg').textContent = `Looking up ${k + 1} of ${todo.length}${found ? ` (${found} already known)` : ''}…`;
      $(`tr[data-i="${i}"] td:last-child`, out).textContent = 'Looking up…';
      let results = [];
      try { results = await INat.searchTaxa(rows[i].line); } catch (e) { /* leave empty */ }
      if (run !== resolveRun || !out.isConnected) return;
      const n = Match.normalize(rows[i].line);
      const exactIdx = results.findIndex(r => [r.name, r.preferred_common_name, r.matched_term]
        .some(x => x && Match.normalize(x) === n));
      Object.assign(rows[i], { results, exact: exactIdx >= 0, sel: Math.max(0, exactIdx) });
      renderRow(i);
    }
    if (run === resolveRun) $('#resolveMsg').textContent = '';
  };

  // --- generate tab ---
  const gen = { taxon: null };
  const genReady = () => { $('#genBtn').disabled = !gen.taxon; };
  const chosen = (el, html, clear) => {
    el.innerHTML = html ? `${html} <button type="button" class="link">✕</button>` : '';
    if (html) $('button', el).onclick = clear;
  };
  autocomplete($('#genTaxon'), {
    fetch: INat.autocompleteTaxa, render: taxonAcRender,
    onPick: t => {
      gen.taxon = t; $('#genTaxon').value = '';
      chosen($('#genTaxonSel'), nameHtml(t), () => { gen.taxon = null; chosen($('#genTaxonSel')); genReady(); });
      genReady();
    },
  });
  $('#genBtn').onclick = async () => {
    const count = Math.min(500, Math.max(1, parseInt($('#genCount').value, 10) || 50));
    $('#genMsg').textContent = 'Fetching…';
    let res;
    const { params } = Filters.query(Filters.combine(Store.getDeck(deckId).filters, addF));
    try { res = await INat.speciesCounts({ taxonId: gen.taxon.id, count, params }); }
    catch (e) { $('#genMsg').textContent = e.message; return; }
    $('#genMsg').textContent = `${res.length} species`;
    const inDeck = new Set(Store.deckCards(deckId).map(c => c.taxonId));
    const out = $('#genOut');
    out.innerHTML = `
      <div class="row"><label><input type="checkbox" id="genAll" checked> Select all</label></div>
      <div class="genlist">${res.map(r => `
        <label class="genitem ${inDeck.has(r.taxon.id) ? 'muted' : ''}">
          <input type="checkbox" value="${r.taxon.id}" ${inDeck.has(r.taxon.id) ? 'disabled' : 'checked'}>
          ${r.taxon.default_photo ? `<img src="${esc(r.taxon.default_photo.square_url)}" alt="">` : '<span class="noimg"></span>'}
          <span>${nameHtml(r.taxon)}<small class="muted"> · ${r.count.toLocaleString()} obs${inDeck.has(r.taxon.id) ? ' · in deck' : ''}</small></span>
        </label>`).join('')}</div>
      <div class="row"><button id="genAdd" class="primary">Add checked</button></div>`;
    $('#genAll').onchange = e => $$('.genitem input:not(:disabled)', out).forEach(c => { c.checked = e.target.checked; });
    $('#genAdd').onclick = async () => {
      const ids = $$('.genitem input:checked:not(:disabled)', out).map(c => +c.value);
      try { await add(ids); out.innerHTML = ''; $('#genMsg').textContent = ''; }
      catch (e) { addMsg(e.message); }
    };
  };

  // --- card list ---
  const cardSpec = c => Filters.spec(deckId, c);

  /** Filter + exclusion lines shown under a card's name (here and on the answer side). */
  function cardFilterHtml(c, spec = cardSpec(c)) {
    const lines = [];
    const sm = Filters.summary(spec.eff);
    if (sm) lines.push(`<div class="small fsum">Photos: ${esc(sm)}</div>`);
    if (spec.excluded.length) lines.push(`<div class="small fsum">Excluding ${spec.excluded.map(Filters.taxonLabel).map(esc).join(', ')}</div>`);
    return lines.join('');
  }

  function renderCards() {
    const cards = Store.deckCards(deckId).sort((a, b) => a.addedAt - b.addedAt);
    const states = Scheduler.states(deckId);
    const now = Date.now();
    $('#cardCount').textContent = `(${cards.length})`;
    let lowCount = 0;
    const rows = cards.map(c => {
      const t = Store.getTaxon(c.taxonId) || { id: c.taxonId, name: `Taxon ${c.taxonId}` };
      const st = states.get(c.taxonId);
      const status = !st ? '<span class="new">New</span>'
        : st.due <= now ? '<span class="due">Due</span>'
        : `<span class="muted">in ${FSRS.formatDelay(st.due, now)}</span>`;
      const spec = cardSpec(c);
      const info = Photos.cachedInfo(spec);
      const low = info && info.low;
      if (low) lowCount++;
      const photos = !info ? '<span class="muted">—</span>'
        : `<span class="${low ? 'warn-inline' : ''}" title="${info.complete ? 'exact count' : 'estimated from a sample'}">${low ? '⚠ ' : ''}${info.complete ? '' : '~'}${info.estimate.toLocaleString()}</span>`;
      const own = Filters.clean(c.filters);
      return `<tr data-id="${c.taxonId}">
        <td class="thumb">${t.thumb ? `<img src="${esc(t.thumb)}" alt="">` : ''}</td>
        <td>${nameHtml(t)}${t.family ? `<div class="muted small">${esc(t.family)}</div>` : ''}${cardFilterHtml(c, spec)}</td>
        <td>${status}</td>
        <td class="num">${photos}</td>
        <td><label class="small" title="Also use observations with more than one photo (first eligible photo is shown)">
          <input type="checkbox" data-act="multi" ${c.allowMultiPhoto ? 'checked' : ''}> multi-photo obs</label>
          <button class="small" data-act="filters" title="Photo filters for this card">Filters${own ? ' ●' : ''}</button></td>
        <td class="right"><a class="button small" target="_blank" rel="noopener" href="https://www.inaturalist.org/taxa/${c.taxonId}">iNat ↗</a>
          <button class="small" data-act="remove" title="Remove from deck">✕</button></td>
      </tr>`;
    }).join('');
    $('#cards').innerHTML = cards.length
      ? `<table class="list cards"><thead><tr><th></th><th>Taxon</th><th>Status</th><th class="num">Eligible photos</th><th>Photos</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted">No cards yet. Add some taxa above.</p>';
    $('#lowNote').innerHTML = lowCount ? `<div class="warn">${lowCount} card${lowCount > 1 ? 's have' : ' has'} fewer than
      ${Photos.LOW_THRESHOLD} eligible observations, so you'll see repeats. Including multi-photo observations or
      loosening a card's filters helps.
      <button id="broadenAll">Include multi-photo observations where it helps</button></div>` : '';
    if (lowCount) $('#broadenAll').onclick = () => {
      for (const c of Store.deckCards(deckId)) {
        const info = Photos.cachedInfo(cardSpec(c));
        if (info && info.low && !c.allowMultiPhoto) Store.updateCard(deckId, c.taxonId, { allowMultiPhoto: true });
      }
      renderCards();
    };
    const s = Scheduler.summary(deckId);
    const n = s.due.length + s.newLeft;
    $('#studyBtn').textContent = n ? `Study (${s.due.length} due, ${s.newLeft} new)` : 'Study';
  }

  function openCardFilters(row, id) {
    const open = row.nextElementSibling;
    if (open && open.classList.contains('fe-tr')) { open.remove(); return; }
    $$('.fe-tr', $('#cards')).forEach(r => r.remove());
    const card = Store.deckCards(deckId).find(c => c.taxonId === id);
    const tr = document.createElement('tr');
    tr.className = 'fe-tr';
    tr.innerHTML = `<td colspan="6"><div class="fe-host"></div>
      <div class="row"><button class="primary" data-act="fsave">Save filters</button>
        <button data-act="fclear">Clear this card's filters</button><button data-act="fcancel">Cancel</button></div></td>`;
    row.after(tr);
    const ed = filterEditor($('.fe-host', tr), card.filters, {
      taxon: Store.getTaxon(id), deckFilters: Store.getDeck(deckId).filters,
    });
    tr.addEventListener('click', e => {
      const act = e.target.dataset.act;
      if (act === 'fsave') { Store.updateCard(deckId, id, { filters: ed.get() }); renderCards(); }
      else if (act === 'fclear') { Store.updateCard(deckId, id, { filters: null }); renderCards(); }
      else if (act === 'fcancel') tr.remove();
    });
  }

  $('#cards').addEventListener('click', e => {
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    const id = +row.dataset.id;
    if (e.target.dataset.act === 'remove') { Store.removeCard(deckId, id); renderCards(); }
    else if (e.target.dataset.act === 'filters') openCardFilters(row, id);
  });
  $('#cards').addEventListener('change', e => {
    const row = e.target.closest('tr[data-id]');
    if (row && e.target.dataset.act === 'multi') {
      Store.updateCard(deckId, +row.dataset.id, { allowMultiPhoto: e.target.checked });
      renderCards();
    }
  });

  let checking = false;
  $('#checkPhotos').onclick = async () => {
    if (checking) return;
    checking = true;
    const btn = $('#checkPhotos');
    const todo = Store.deckCards(deckId).filter(c => !Photos.cachedInfo(cardSpec(c)));
    for (let i = 0; i < todo.length; i++) {
      if (!document.body.contains(btn)) break; // navigated away
      btn.textContent = `Checking ${i + 1} / ${todo.length}…`;
      try { await Photos.warm(cardSpec(todo[i])); } catch (e) { /* skip */ }
      renderCards();
    }
    btn.textContent = 'Check photo supply';
    checking = false;
  };

  renderCards();
  // Older cached taxa lack ancestry, which exclusions need: fetch it quietly, then redraw.
  ensureTaxa(Store.deckCards(deckId).map(c => c.taxonId), { priority: false })
    .then(n => { if (n && $('#cards') && !$('.fe-tr')) renderCards(); }).catch(() => {});
}

// =====================================================================
// STUDY SESSION
// =====================================================================
function viewStudy(deckId) {
  const deck = Store.getDeck(deckId);
  if (!deck) { location.hash = '#/'; return; }
  const mode = ReviewModes.get(deck.mode);
  const showMap = deck.showMap !== false;
  const skip = new Set();
  let cur = null;      // { card, taxon, photo, info, repeat, sameAsMissed, revealed, revealedAt, suggested }
  let pending = null;  // { taxonId, promise } — the likely next card, prepared in the background
  let token = 0;       // guards against stale async loads
  let reviewed = 0;
  let mapCleanups = [];

  app.innerHTML = `
    <div class="study">
      <header class="studybar">
        <a href="#/deck/${deckId}" class="back">← ${esc(deck.name)}</a>
        <span id="counts" class="muted"></span>
      </header>
      <div id="stage"></div>
    </div>`;
  const stage = $('#stage');
  const LOADING = '<div class="loading">Finding a photo…</div>';

  function clearMaps() {
    for (const f of mapCleanups) { try { f(); } catch { /* ignore */ } }
    mapCleanups = [];
  }

  function updateCounts() {
    const s = Scheduler.summary(deckId);
    $('#counts').innerHTML = `<span class="due">${s.due.length} due</span> · <span class="new">${s.newLeft} new</span>` +
      (s.soon.length ? ` · ${s.soon.length} learning` : '') + ` · ${reviewed} done`;
  }

  const freshCard = c => Store.deckCards(deckId).find(x => x.taxonId === c.taxonId) || c;

  /**
   * Everything needed to show a card: taxon, a photo (download started), and map data.
   * If the last review of this card was "Again", the same photo is shown again.
   */
  async function prepare(card) {
    await ensureTaxa([card.taxonId]);
    const taxon = Store.getTaxon(card.taxonId);
    const spec = Filters.spec(deckId, card);
    let photo = null, info = null, repeat = false, sameAsMissed = false;
    const last = Scheduler.lastReview(deckId, card.taxonId);
    if (last && last.grade === 1 && last.obsId) {
      try { photo = await Photos.byObs(spec, last.obsId); } catch { photo = null; }
      if (photo) { sameAsMissed = true; info = Photos.cachedInfo(spec); }
    }
    if (!photo) ({ photo, info, repeat } = await Photos.next(spec));
    if (photo) {
      Photos.preload(photo.url);
      Maps.prefetch(card.taxonId, photo, showMap); // fire and forget
      // Typed mode accepts more-specific answers (the species of a subspecies, etc.): get their names.
      if (mode.id === 'typed' && photo.taxon && photo.taxon.id !== card.taxonId) {
        await NameCache.ensure([...photo.between, photo.taxon.id]).catch(() => {});
      }
    }
    return { card, taxon, spec, photo, info, repeat, sameAsMissed };
  }

  /** Predict the next card and prepare it while the user looks at the current one. */
  function prepareNext() {
    if (!cur) return;
    const next = Scheduler.nextCard(deckId, { avoid: cur.card.taxonId, skip });
    if (!next || next.taxonId === cur.card.taxonId) { pending = null; return; }
    const promise = prepare(next).catch(() => null);
    pending = { taxonId: next.taxonId, promise };
    // Then warm the photo pool of the card after that, so it's quick too.
    promise.then(() => {
      const s = Scheduler.summary(deckId);
      const after = [...s.due, ...s.fresh.slice(0, s.newLeft)]
        .find(c => c.taxonId !== next.taxonId && c.taxonId !== cur?.card.taxonId && !skip.has(c.taxonId));
      if (after) ensureTaxa([after.taxonId]).then(() => Photos.warm(Filters.spec(deckId, after))).catch(() => {});
    });
  }

  async function loadNext(avoid = null) {
    const my = ++token;
    clearMaps();
    updateCounts();
    stage.onclick = null;
    let prepared = null;
    const p = pending;
    pending = null;
    if (p && p.taxonId !== avoid && Scheduler.isAvailable(deckId, p.taxonId, { skip })) {
      stage.innerHTML = LOADING; // only visible if preparation hasn't finished yet
      prepared = await p.promise;
      if (my !== token) return;
    }
    if (!prepared) {
      const card = Scheduler.nextCard(deckId, { avoid, skip });
      if (!card) return renderDone();
      stage.innerHTML = LOADING;
      try { prepared = await prepare(card); }
      catch (e) {
        if (my !== token) return;
        stage.innerHTML = `<div class="panel"><p>Couldn't load from iNaturalist: ${esc(e.message)}</p>
          <button class="primary" id="retry">Retry</button></div>`;
        $('#retry').onclick = () => loadNext(avoid);
        return;
      }
      if (my !== token) return;
    }
    prepared.card = freshCard(prepared.card);
    if (!prepared.photo) return renderNoPhoto(prepared.card, prepared.taxon, prepared.info);
    cur = Object.assign(prepared, { revealed: false });
    renderCard();
    prepareNext();
  }

  function renderCard() {
    clearMaps();
    stage.onclick = null;
    const { photo, info, card, spec } = cur;
    const withMap = showMap && photo.lat != null && Maps.available();
    const warnings = [];
    const filtered = !!Filters.clean(spec.eff);
    if (info && info.low && (!card.allowMultiPhoto || filtered)) {
      warnings.push(`<div class="warn" id="lowWarn">Only ${info.complete ? '' : 'about '}${info.estimate} eligible
        observation${info.estimate === 1 ? '' : 's'} ${filtered ? 'match this card’s photo filters' : 'exist for this taxon'}, so you'll see repeats.
        ${card.allowMultiPhoto ? '' : '<button data-act="broaden">Include multi-photo observations</button>'}
        ${filtered ? '<button data-act="unfilter">Remove photo filters for this card</button>' : ''}</div>`);
    }
    if (cur.sameAsMissed) warnings.push(`<div class="note">Same photo as last time, since you missed it.</div>`);
    else if (cur.repeat) warnings.push(`<div class="note">You've seen every available photo of this taxon; this one is a repeat.</div>`);

    stage.innerHTML = `
      <figure class="photo">
        <div class="photo-box"><img id="photo" alt="Photo to identify"></div>
        <figcaption class="attrib">Photo ${esc(photo.attribution)} · via iNaturalist</figcaption>
      </figure>
      ${warnings.join('')}
      <div class="qrow ${withMap ? 'with-map' : ''}">
        ${withMap ? '<div class="qmap-wrap"><div id="qmap" class="qmap"></div><div class="map-caption muted small"></div></div>' : ''}
        <div id="prompt" class="prompt"></div>
      </div>
      <div id="answer" class="answer" hidden></div>
      <div class="tools">
        <button class="small" data-act="badphoto" title="Hide this observation forever (e.g. photo is unclear, shows a label, wrong subject)">Bad photo, never show again</button>
        <button class="small" data-act="skipcard">Skip this card for now</button>
      </div>`;

    const img = $('#photo');
    img.onerror = () => { Store.blockObservation(photo.obsId); loadSameCard(); };
    if (Photos.isLoaded(photo.url)) {
      img.src = photo.url;
    } else {
      // Not downloaded yet: show the smaller version immediately, swap in the large one when ready.
      img.src = photo.url.replace('/large.', '/medium.');
      Photos.preload(photo.url).then(ok => { if (ok && img.isConnected) img.src = photo.url; });
    }

    if (withMap) mapCleanups.push(Maps.questionMap($('#qmap'), photo));
    mode.mount($('#prompt'), modeCtx());
  }

  function modeCtx() {
    return { taxon: cur.taxon, photo: cur.photo, deckId, escape: esc, reveal,
      answerGroups: answerGroups(cur.taxon, cur.photo, cur.spec.excluded) };
  }

  function loadSameCard() {
    // Fetch a different photo for the current card (e.g. after flagging a bad one).
    const card = cur.card;
    const my = ++token;
    clearMaps();
    stage.innerHTML = '<div class="loading">Finding another photo…</div>';
    Photos.next(cur.spec, { exclude: new Set([cur.photo.obsId]) })
      .then(res => {
        if (my !== token) return;
        if (!res.photo) return renderNoPhoto(card, cur.taxon, res.info);
        Photos.preload(res.photo.url);
        Object.assign(cur, { photo: res.photo, info: res.info, repeat: res.repeat, sameAsMissed: false, revealed: false });
        renderCard();
      })
      .catch(e => { if (my === token) stage.innerHTML = `<div class="panel">${esc(e.message)}</div>`; });
  }

  function reveal({ suggested = null, feedbackHtml = '' } = {}) {
    if (cur.revealed) return;
    cur.revealed = true;
    cur.revealedAt = Date.now();
    cur.suggested = suggested;
    const { taxon: t, photo } = cur;
    const obsT = photo.taxon && photo.taxon.id !== t.id ? photo.taxon : null;
    const previews = Scheduler.preview(deckId, t.id);
    const labels = ['Again', 'Hard', 'Good', 'Easy'];
    $('#prompt').querySelectorAll('button').forEach(b => { b.disabled = true; });
    if (!feedbackHtml) $('#prompt').hidden = true;
    const ans = $('#answer');
    ans.hidden = false;
    ans.innerHTML = `
      ${feedbackHtml}
      <div class="reveal-name">${nameHtml(t)}</div>
      <div class="muted small">${[t.order, t.family].filter(Boolean).map(esc).join(' › ')}</div>
      ${cur.spec.excluded.length ? `<div class="small fsum">Excluding ${cur.spec.excluded.map(Filters.taxonLabel).map(esc).join(', ')}
        (${cur.spec.excluded.length === 1 ? 'it has its' : 'they have their'} own card${cur.spec.excluded.length === 1 ? '' : 's'})</div>` : ''}
      ${Filters.summary(cur.spec.eff) ? `<div class="small fsum">Photos: ${esc(Filters.summary(cur.spec.eff))}</div>` : ''}
      ${obsT ? `<div class="small">This observation: ${nameHtml({ name: obsT.name, commonName: obsT.commonName })}</div>` : ''}
      <div class="links small">
        <a target="_blank" rel="noopener" href="https://www.inaturalist.org/observations/${photo.obsId}">Observation ↗</a>
        <a target="_blank" rel="noopener" href="https://www.inaturalist.org/taxa/${t.id}">Taxon page ↗</a>
        ${photo.observedOn ? `<span class="muted">Observed ${esc(photo.observedOn)}</span>` : ''}
      </div>
      <div class="grades">${labels.map((l, i) => `
        <button class="grade g${i + 1} ${suggested === i + 1 ? 'suggested' : ''}" data-grade="${i + 1}">
          <span>${l}</span><small>${previews[i]}</small><kbd>${i + 1}</kbd></button>`).join('')}</div>
      ${Maps.available() ? `<div class="amap-wrap"><div id="amap" class="amap"></div>
        <div class="map-legend small muted"></div></div>` : ''}`;
    if (Maps.available()) mapCleanups.push(Maps.answerMap($('#amap'), t, photo));
    const focusBtn = $(`.grade[data-grade="${suggested || 3}"]`, ans);
    if (focusBtn) focusBtn.focus({ preventScroll: true });
    $('.grades', ans).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function grade(g) {
    if (!cur || !cur.revealed) return;
    Store.addReview({ deckId, taxonId: cur.card.taxonId, grade: g, obsId: cur.photo.obsId, mode: mode.id });
    reviewed++;
    const prev = cur.card.taxonId;
    cur = null;
    loadNext(prev);
  }

  function renderNoPhoto(card, taxon, info) {
    cur = null;
    clearMaps();
    const filtered = !!Filters.clean(Filters.spec(deckId, card).eff);
    stage.innerHTML = `<div class="panel">
      <p>No eligible photos found for ${taxon ? nameHtml(taxon) : 'this taxon'}
        ${card.allowMultiPhoto ? '' : 'among research-grade, single-photo observations with a CC0/CC BY/CC BY-NC license'}${filtered ? ' that match its photo filters' : ''}.</p>
      <div class="row">
        ${card.allowMultiPhoto ? '' : '<button class="primary" data-act="broaden-now">Include multi-photo observations</button>'}
        ${filtered ? '<button class="primary" data-act="unfilter-now">Remove photo filters for this card</button>' : ''}
        <button data-act="skip-now">Skip for this session</button>
        <button data-act="remove-now">Remove from deck</button>
      </div></div>`;
    stage.onclick = e => {
      const act = e.target.dataset.act;
      if (act === 'broaden-now') Store.updateCard(deckId, card.taxonId, { allowMultiPhoto: true });
      else if (act === 'unfilter-now') Store.updateCard(deckId, card.taxonId, { filters: NO_FILTERS });
      else if (act === 'skip-now') skip.add(card.taxonId);
      else if (act === 'remove-now') Store.removeCard(deckId, card.taxonId);
      else return;
      stage.onclick = null;
      loadNext();
    };
  }

  function renderDone() {
    cur = null;
    clearMaps();
    const st = Scheduler.states(deckId);
    const s = Scheduler.summary(deckId);
    let nextDue = Infinity;
    for (const c of Store.deckCards(deckId)) { const x = st.get(c.taxonId); if (x && x.due < nextDue) nextDue = x.due; }
    const more = s.fresh.length - s.newLeft;
    stage.innerHTML = `<div class="panel done">
      <h2>All done for now 🎉</h2>
      <p>${reviewed} review${reviewed === 1 ? '' : 's'} this session.</p>
      ${nextDue < Infinity ? `<p class="muted">Next card is due in ${FSRS.formatDelay(nextDue, Date.now())}.</p>` : ''}
      ${more > 0 ? `<p class="muted">${more} new card${more === 1 ? '' : 's'} waiting (daily limit reached).
        <button data-act="morenew">Study ${Math.min(10, more)} more new</button></p>` : ''}
      ${skip.size ? `<p class="muted">${skip.size} card(s) skipped this session.</p>` : ''}
      <a class="button primary" href="#/deck/${deckId}">Back to deck</a></div>`;
    const b = $('[data-act=morenew]', stage);
    if (b) b.onclick = () => {
      Store.updateDeck(deckId, { newPerDay: Store.getDeck(deckId).newPerDay + Math.min(10, more) });
      loadNext();
    };
  }

  // --- event wiring ---
  stage.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn || !cur) return;
    if (btn.dataset.grade) return grade(+btn.dataset.grade);
    switch (btn.dataset.act) {
      case 'broaden':
        Store.updateCard(deckId, cur.card.taxonId, { allowMultiPhoto: true });
        cur.card.allowMultiPhoto = true;
        $('#lowWarn').innerHTML = 'Done. Multi-photo observations will be included from the next review of this card.';
        break;
      case 'unfilter':
        Store.updateCard(deckId, cur.card.taxonId, { filters: NO_FILTERS });
        $('#lowWarn').innerHTML = 'Done. This card ignores photo filters from its next review (it still excludes taxa that have their own cards).';
        break;
      case 'badphoto':
        Store.blockObservation(cur.photo.obsId);
        loadSameCard();
        break;
      case 'skipcard':
        skip.add(cur.card.taxonId);
        loadNext(cur.card.taxonId);
        break;
    }
  });

  function onKey(e) {
    if (!cur || e.ctrlKey || e.metaKey || e.altKey) return;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (!cur.revealed) {
      if (!inField && mode.onKey && mode.onKey(e, modeCtx())) e.preventDefault();
      return;
    }
    if (Date.now() - cur.revealedAt < 250) return; // avoid double-Enter accidents
    if (/^[1-4]$/.test(e.key)) { e.preventDefault(); grade(+e.key); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); grade(cur.suggested || 3); }
  }
  document.addEventListener('keydown', onKey);
  viewCleanup = () => { document.removeEventListener('keydown', onKey); token++; clearMaps(); };

  // Exclusions need every card's ancestry; older cached taxa lack it (fetched once, then synced).
  const startToken = token;
  stage.innerHTML = LOADING;
  ensureTaxa(Store.deckCards(deckId).map(c => c.taxonId)).catch(() => {})
    .then(() => { if (token === startToken) loadNext(); });
}

route();
