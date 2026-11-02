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

async function ensureTaxa(ids) {
  const missing = ids.filter(id => !Store.getTaxon(id));
  if (missing.length) Store.putTaxa(await INat.fetchTaxa(missing));
}

async function addTaxaToDeck(deckId, ids) {
  await ensureTaxa(ids);
  return Store.addCards(deckId, ids);
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
      <td class="right">${n ? `<a class="button primary" href="#/study/${d.id}">Study</a>` : '<span class="muted">Done</span>'}</td>
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
}

// =====================================================================
// DECK EDITOR
// =====================================================================
function viewDeck(deckId) {
  const deck = Store.getDeck(deckId);
  if (!deck) { location.hash = '#/'; return; }

  app.innerHTML = `
    <header class="top">
      <a href="#/" class="back">← Decks</a>
      <div class="row spread">
        <input class="title-input" id="deckName" value="${esc(deck.name)}" aria-label="Deck name">
        <a class="button primary" id="studyBtn" href="#/study/${deck.id}">Study</a>
      </div>
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
    </section>

    <section class="panel">
      <h2>Add taxa</h2>
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
        <p class="muted small">The most-observed species (research grade) within a taxon, optionally limited to a place.</p>
        <div class="grid2">
          <label>Within taxon<div class="ac"><input id="genTaxon" placeholder="e.g. Quercus, Aves, Asteraceae" autocomplete="off"></div>
            <span id="genTaxonSel" class="chosen"></span></label>
          <label>Place (optional)<div class="ac"><input id="genPlace" placeholder="e.g. California" autocomplete="off"></div>
            <span id="genPlaceSel" class="chosen"></span></label>
        </div>
        <div class="row">
          <label>How many <input id="genCount" type="number" min="1" max="500" value="50"></label>
          <button id="genBtn" class="primary" disabled>Preview</button><span id="genMsg" class="muted"></span>
        </div>
        <div id="genOut"></div>
      </div>
      <div id="addMsg" class="muted"></div>
    </section>

    <section class="panel">
      <div class="row spread"><h2>Cards <span id="cardCount" class="muted"></span></h2>
        <div class="row"><button id="checkPhotos" title="Fetch a sample of observations for each card to see how many eligible photos exist">Check photo supply</button></div></div>
      <div id="lowNote"></div>
      <div id="cards"></div>
    </section>

    <section class="panel danger">
      <button id="deleteDeck">Delete deck</button>
    </section>`;

  // --- settings ---
  $('#deckName').onchange = e => Store.updateDeck(deckId, { name: e.target.value.trim() || deck.name });
  $('#mode').onchange = e => Store.updateDeck(deckId, { mode: e.target.value });
  $('#order').onchange = e => Store.updateDeck(deckId, { order: e.target.value });
  $('#showMap').onchange = e => Store.updateDeck(deckId, { showMap: e.target.checked });
  $('#newPerDay').onchange = e => Store.updateDeck(deckId, { newPerDay: Math.max(0, parseInt(e.target.value, 10) || 0) });
  $('#deleteDeck').onclick = e => {
    if (e.target.dataset.armed) { Store.deleteDeck(deckId); location.hash = '#/'; return; }
    e.target.dataset.armed = '1';
    e.target.textContent = 'Click again to delete this deck';
    e.target.classList.add('primary');
  };

  // --- tabs ---
  $$('.tab').forEach(b => b.onclick = () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === b));
    $$('.tabpane').forEach(p => p.hidden = p.dataset.pane !== b.dataset.tab);
  });

  const addMsg = t => { $('#addMsg').textContent = t; };
  const afterAdd = n => { addMsg(n ? `Added ${n} card${n > 1 ? 's' : ''}.` : 'Already in deck.'); renderCards(); };

  // --- search tab ---
  autocomplete($('#taxonSearch'), {
    fetch: INat.autocompleteTaxa, render: taxonAcRender,
    onPick: async t => {
      addMsg('Adding…');
      try { afterAdd(await addTaxaToDeck(deckId, [t.id])); } catch (e) { addMsg(e.message); }
      $('#taxonSearch').value = '';
      $('#taxonSearch').focus();
    },
  });

  // --- paste tab ---
  $('#resolveBtn').onclick = async () => {
    const lines = [...new Set($('#pasteList').value.split('\n').map(s => s.trim()).filter(Boolean))];
    if (!lines.length) return;
    const out = $('#resolveOut');
    out.innerHTML = '';
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      $('#resolveMsg').textContent = `Looking up ${i + 1} of ${lines.length}…`;
      let results = [];
      try { results = await INat.searchTaxa(lines[i]); } catch (e) { /* leave empty */ }
      const n = Match.normalize(lines[i]);
      const exactIdx = results.findIndex(r => [r.name, r.preferred_common_name, r.matched_term]
        .some(x => x && Match.normalize(x) === n));
      rows.push({ line: lines[i], results, exact: exactIdx >= 0, sel: Math.max(0, exactIdx) });
    }
    $('#resolveMsg').textContent = '';
    out.innerHTML = `
      <table class="list"><thead><tr><th></th><th>You wrote</th><th>Matched taxon</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${r.exact ? '' : 'fuzzy'}">
        <td><input type="checkbox" data-i="${i}" ${r.exact ? 'checked' : ''} ${r.results.length ? '' : 'disabled'}></td>
        <td>${esc(r.line)}</td>
        <td>${r.results.length ? `<select data-i="${i}">${r.results.map((t, j) =>
            `<option value="${t.id}" ${j === r.sel ? 'selected' : ''}>${esc(t.name)}${t.preferred_common_name ? ' (' + esc(t.preferred_common_name) + ')' : ''} — ${esc(t.rank)}</option>`).join('')}</select>
            ${r.exact ? '' : '<span class="warn-inline">check this</span>'}`
          : '<span class="warn-inline">no match</span>'}</td></tr>`).join('')}
      </tbody></table>
      <div class="row"><button id="addResolved" class="primary">Add checked</button></div>`;
    $('#addResolved').onclick = async () => {
      const ids = $$('input[type=checkbox][data-i]', out).filter(c => c.checked)
        .map(c => +$(`select[data-i="${c.dataset.i}"]`, out).value);
      addMsg('Adding…');
      try { afterAdd(await addTaxaToDeck(deckId, ids)); out.innerHTML = ''; $('#pasteList').value = ''; }
      catch (e) { addMsg(e.message); }
    };
  };

  // --- generate tab ---
  const gen = { taxon: null, place: null };
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
  autocomplete($('#genPlace'), {
    fetch: INat.autocompletePlaces, render: p => esc(p.display_name),
    onPick: p => {
      gen.place = p; $('#genPlace').value = '';
      chosen($('#genPlaceSel'), esc(p.display_name), () => { gen.place = null; chosen($('#genPlaceSel')); });
    },
  });
  $('#genBtn').onclick = async () => {
    const count = Math.min(500, Math.max(1, parseInt($('#genCount').value, 10) || 50));
    $('#genMsg').textContent = 'Fetching…';
    let res;
    try { res = await INat.speciesCounts({ taxonId: gen.taxon.id, placeId: gen.place?.id, count }); }
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
      addMsg(`Adding ${ids.length}…`);
      try { afterAdd(await addTaxaToDeck(deckId, ids)); out.innerHTML = ''; $('#genMsg').textContent = ''; }
      catch (e) { addMsg(e.message); }
    };
  };

  // --- card list ---
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
      const info = Photos.cachedInfo(c.taxonId, !!c.allowMultiPhoto);
      const low = info && info.low && !c.allowMultiPhoto;
      if (low) lowCount++;
      const photos = !info ? '<span class="muted">—</span>'
        : `<span class="${low ? 'warn-inline' : ''}" title="${info.complete ? 'exact count' : 'estimated from a sample'}">${low ? '⚠ ' : ''}${info.complete ? '' : '~'}${info.estimate.toLocaleString()}</span>`;
      return `<tr data-id="${c.taxonId}">
        <td class="thumb">${t.thumb ? `<img src="${esc(t.thumb)}" alt="">` : ''}</td>
        <td>${nameHtml(t)}${t.family ? `<div class="muted small">${esc(t.family)}</div>` : ''}</td>
        <td>${status}</td>
        <td class="num">${photos}</td>
        <td><label class="small" title="Also use observations with more than one photo (first eligible photo is shown)">
          <input type="checkbox" data-act="multi" ${c.allowMultiPhoto ? 'checked' : ''}> multi-photo obs</label></td>
        <td class="right"><a class="button small" target="_blank" rel="noopener" href="https://www.inaturalist.org/taxa/${c.taxonId}">iNat ↗</a>
          <button class="small" data-act="remove" title="Remove from deck">✕</button></td>
      </tr>`;
    }).join('');
    $('#cards').innerHTML = cards.length
      ? `<table class="list cards"><thead><tr><th></th><th>Taxon</th><th>Status</th><th class="num">Eligible photos</th><th>Broaden</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted">No cards yet. Add some taxa above.</p>';
    $('#lowNote').innerHTML = lowCount ? `<div class="warn">${lowCount} card${lowCount > 1 ? 's have' : ' has'} fewer than
      ${Photos.LOW_THRESHOLD} eligible single-photo observations, so you'll see repeats.
      <button id="broadenAll">Include multi-photo observations for ${lowCount > 1 ? 'all of them' : 'it'}</button></div>` : '';
    if (lowCount) $('#broadenAll').onclick = () => {
      for (const c of Store.deckCards(deckId)) {
        const info = Photos.cachedInfo(c.taxonId, false);
        if (info && info.low && !c.allowMultiPhoto) Store.updateCard(deckId, c.taxonId, { allowMultiPhoto: true });
      }
      renderCards();
    };
    const s = Scheduler.summary(deckId);
    const n = s.due.length + s.newLeft;
    $('#studyBtn').textContent = n ? `Study (${s.due.length} due, ${s.newLeft} new)` : 'Study';
  }

  $('#cards').addEventListener('click', e => {
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    const id = +row.dataset.id;
    if (e.target.dataset.act === 'remove') { Store.removeCard(deckId, id); renderCards(); }
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
    const todo = Store.deckCards(deckId).filter(c => !Photos.cachedInfo(c.taxonId, !!c.allowMultiPhoto));
    for (let i = 0; i < todo.length; i++) {
      if (!document.body.contains(btn)) break; // navigated away
      btn.textContent = `Checking ${i + 1} / ${todo.length}…`;
      try { await Photos.warm(todo[i].taxonId, !!todo[i].allowMultiPhoto); } catch (e) { /* skip */ }
      renderCards();
    }
    btn.textContent = 'Check photo supply';
    checking = false;
  };

  renderCards();
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
    let photo = null, info = null, repeat = false, sameAsMissed = false;
    const last = Scheduler.lastReview(deckId, card.taxonId);
    if (last && last.grade === 1 && last.obsId) {
      try { photo = await Photos.byObs(card.taxonId, last.obsId); } catch { photo = null; }
      if (photo) { sameAsMissed = true; info = Photos.cachedInfo(card.taxonId, !!card.allowMultiPhoto); }
    }
    if (!photo) ({ photo, info, repeat } = await Photos.next(card.taxonId, { multi: !!card.allowMultiPhoto }));
    if (photo) {
      Photos.preload(photo.url);
      Maps.prefetch(card.taxonId, photo, showMap); // fire and forget
    }
    return { card, taxon, photo, info, repeat, sameAsMissed };
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
      if (after) ensureTaxa([after.taxonId]).then(() => Photos.warm(after.taxonId, !!after.allowMultiPhoto)).catch(() => {});
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
    const { photo, info, card } = cur;
    const withMap = showMap && photo.lat != null && Maps.available();
    const warnings = [];
    if (info && info.low && !card.allowMultiPhoto) {
      warnings.push(`<div class="warn" id="lowWarn">Only ${info.complete ? '' : 'about '}${info.estimate} eligible
        single-photo observation${info.estimate === 1 ? '' : 's'} exist for this taxon, so you'll see repeats.
        <button data-act="broaden">Include multi-photo observations</button></div>`);
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
    return { taxon: cur.taxon, photo: cur.photo, deckId, escape: esc, reveal };
  }

  function loadSameCard() {
    // Fetch a different photo for the current card (e.g. after flagging a bad one).
    const card = cur.card;
    const my = ++token;
    clearMaps();
    stage.innerHTML = '<div class="loading">Finding another photo…</div>';
    Photos.next(card.taxonId, { multi: !!card.allowMultiPhoto, exclude: new Set([cur.photo.obsId]) })
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
    stage.innerHTML = `<div class="panel">
      <p>No eligible photos found for ${taxon ? nameHtml(taxon) : 'this taxon'}
        ${card.allowMultiPhoto ? '' : 'among research-grade, single-photo observations with a CC0/CC BY/CC BY-NC license'}.</p>
      <div class="row">
        ${card.allowMultiPhoto ? '' : '<button class="primary" data-act="broaden-now">Include multi-photo observations</button>'}
        <button data-act="skip-now">Skip for this session</button>
        <button data-act="remove-now">Remove from deck</button>
      </div></div>`;
    stage.onclick = e => {
      const act = e.target.dataset.act;
      if (act === 'broaden-now') Store.updateCard(deckId, card.taxonId, { allowMultiPhoto: true });
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

  loadNext();
}

route();
