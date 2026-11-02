// Maps (Leaflet): a state-level "where was this observed" map for the question side, and an
// iNat observation-grid + range-map view of the whole taxon for the answer side.
// Degrades gracefully (no maps) if Leaflet failed to load, e.g. offline.
'use strict';

const Maps = (() => {
  const available = () => typeof L !== 'undefined';
  const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
  const API = 'https://api.inaturalist.org/v1';

  // Esri's gray canvas: keyless, muted, with borders — good under colored overlays.
  function basemap() {
    const base = dark() ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base';
    const ref = dark() ? 'World_Dark_Gray_Reference' : 'World_Light_Gray_Reference';
    const url = n => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${n}/MapServer/tile/{z}/{y}/{x}`;
    return L.layerGroup([
      L.tileLayer(url(base), { maxZoom: 16, attribution: '&copy; Esri, HERE, Garmin, OpenStreetMap' }),
      L.tileLayer(url(ref), { maxZoom: 16, pane: 'shadowPane' }),
    ]);
  }

  // ---------- place (state / country) lookup, cached ----------
  const PLACE_KEY = 'places.admin';
  const placeCache = () => Store.getCache(PLACE_KEY) || {};

  /** The state/province containing an observation (or its country as fallback). Null if unknown. */
  async function regionFor(placeIds) {
    if (!placeIds || !placeIds.length) return null;
    const cache = placeCache();
    for (const level of [10, 0]) {
      const hit = placeIds.map(id => cache[id]).find(p => p && p.level === level);
      if (hit) return hit;
    }
    for (const level of [10, 0]) {
      const found = await INat.placesAtLevel(placeIds, level);
      if (found.length) {
        const p = found[0];
        const rec = { id: p.id, name: p.display_name || p.name, level,
          // Country outlines can be huge; keep just their bounding box.
          geometry: (level === 10 && p.geometry_geojson) || p.bounding_box_geojson || null };
        const c = placeCache();
        c[p.id] = rec;
        Store.setCache(PLACE_KEY, c);
        return rec;
      }
    }
    return null;
  }

  // ---------- taxon bounds & range-map detection, cached ----------
  async function boundsFor(taxonId) {
    const k = `bounds.${taxonId}`;
    const c = Store.getCache(k);
    if (c && Date.now() - c.ts < 30 * 86400000) return c.b;
    const b = await INat.taxonBounds(taxonId);
    Store.setCache(k, { ts: Date.now(), b });
    return b;
  }

  /** Does iNat have a range map for this taxon? Checks the world tile for any drawn pixels. */
  function hasRange(taxonId) {
    const k = `range.${taxonId}`;
    const c = Store.getCache(k);
    if (c && Date.now() - c.ts < 30 * 86400000) return Promise.resolve(c.v);
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const done = v => { if (v !== null) Store.setCache(k, { ts: Date.now(), v }); resolve(v); };
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = cv.height = 256;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const px = ctx.getImageData(0, 0, 256, 256).data;
          for (let i = 3; i < px.length; i += 4) if (px[i] > 0) return done(true);
          done(false);
        } catch { done(null); }
      };
      img.onerror = () => done(false);
      img.src = `${API}/taxon_ranges/${taxonId}/0/0/0.png`;
    });
  }

  /** Warm the caches the maps need (called while preparing upcoming cards). */
  function prefetch(taxonId, photo, wantQuestionMap) {
    const jobs = [boundsFor(taxonId), hasRange(taxonId)];
    if (wantQuestionMap) jobs.push(regionFor(photo.placeIds));
    return Promise.all(jobs.map(p => p.catch(() => null)));
  }

  function locationLayer(photo, { forAnswer = false } = {}) {
    if (photo.lat == null) return null;
    const css = getComputedStyle(document.documentElement);
    const color = css.getPropertyValue(forAnswer ? '--due' : '--bad').trim() || '#d33';
    const ll = [photo.lat, photo.lng];
    const fuzzy = photo.obscured || (photo.accuracy && photo.accuracy > 2000);
    const g = L.featureGroup();
    if (fuzzy && photo.accuracy) {
      L.circle(ll, { radius: photo.accuracy, color, weight: 2, fillOpacity: 0.15, dashArray: photo.obscured ? '4 4' : null }).addTo(g);
    }
    if (!photo.obscured) {
      L.circleMarker(ll, { radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).addTo(g);
    }
    return g;
  }

  /** Question side: observation location within its state/province. Returns a cleanup fn. */
  function questionMap(el, photo) {
    if (!available() || photo.lat == null) { el.hidden = true; return () => {}; }
    const map = L.map(el, { zoomControl: true, scrollWheelZoom: false, attributionControl: true });
    let alive = true;
    (async () => {
    basemap().addTo(map);
    const loc = locationLayer(photo).addTo(map);
    map.setView([photo.lat, photo.lng], 6);
    let region = null;
    try { region = await regionFor(photo.placeIds); } catch { /* map still useful without outline */ }
    if (!alive) return;
    if (region && region.geometry) {
      const outline = L.geoJSON(region.geometry, {
        style: { color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
          weight: 2, fillOpacity: 0.06 },
        interactive: false,
      }).addTo(map);
      map.fitBounds(outline.getBounds().extend(loc.getBounds()), { padding: [8, 8] });
    } else {
      map.setView([photo.lat, photo.lng], photo.obscured ? 7 : 6);
    }
    const cap = el.parentNode.querySelector('.map-caption');
    if (cap) cap.textContent = (region ? `Observed in ${region.name}` : 'Observation location') +
      (photo.obscured ? ' (location obscured)' : '');
    })();
    return () => { alive = false; map.remove(); };
  }

  /** Answer side: the taxon's whole known distribution. Returns a cleanup fn. */
  function answerMap(el, taxon, photo) {
    if (!available()) { el.hidden = true; return () => {}; }
    const map = L.map(el, { scrollWheelZoom: false, worldCopyJump: true });
    basemap().addTo(map);
    map.setView([20, 0], 1);
    let alive = true;
    (async () => {
    const [bounds, range] = await Promise.all([
      boundsFor(taxon.id).catch(() => null), hasRange(taxon.id),
    ]);
    if (!alive) return;
    if (range) {
      L.tileLayer(`${API}/taxon_ranges/${taxon.id}/{z}/{x}/{y}.png`, { opacity: 0.6, maxNativeZoom: 10 }).addTo(map);
    }
    L.tileLayer(`${API}/grid/{z}/{x}/{y}.png?taxon_id=${taxon.id}&verifiable=true`, { opacity: 0.9, maxNativeZoom: 18 }).addTo(map);
    const loc = locationLayer(photo, { forAnswer: true });
    if (loc) loc.addTo(map);
    if (bounds) {
      map.fitBounds([[bounds.swlat, bounds.swlng], [bounds.nelat, bounds.nelng]], { padding: [10, 10], maxZoom: 8 });
    }
    const legend = el.parentNode.querySelector('.map-legend');
    if (legend) {
      legend.innerHTML = `<span class="key grid"></span> iNat observations` +
        (range ? ` <span class="key range"></span> range map` : ' <span class="muted">(no range map on iNat)</span>') +
        (loc ? ` <span class="key here"></span> this photo` : '');
    }
    })();
    return () => { alive = false; map.remove(); };
  }

  return { available, questionMap, answerMap, prefetch };
})();
