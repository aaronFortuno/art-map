// Register the service worker so the site works offline once visited.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .catch(err => console.warn('SW registration failed:', err));
  });
}

(async function () {
  const [data, imagesData, secondaryImagesData] = await Promise.all([
    fetch('data/seed.json').then(r => r.json()),
    fetch('data/images.json').then(r => r.json()),
    fetch('data/secondary-images.json').then(r => r.json()).catch(() => ({ images: [] }))
  ]);

  const typeById   = Object.fromEntries(data.connectionTypes.map(t => [t.id, t]));
  const themeById  = Object.fromEntries(data.themes.map(t => [t.id, t]));
  const periodById = Object.fromEntries(data.periods.map(p => [p.id, p]));

  // Canonical images (by index 1..55) and secondary images (by node id)
  const imageByIndex = {};
  imagesData.works.forEach(w => {
    if (w.local_url || (!w.image_missing && w.image_url)) imageByIndex[w.canonicalIndex] = w;
  });

  const imageByNodeId = {};
  (secondaryImagesData.images || []).forEach(i => {
    if (i.local_url) imageByNodeId[i.node_id] = i;
  });

  // Enrich nodes with image URLs. Prefer locally-downloaded copies; fall back
  // to Wikimedia Special:FilePath (avoids the direct /thumb/ 429 rejections).
  data.nodes.forEach(n => {
    let img = null;
    if (n.canonicalIndex && imageByIndex[n.canonicalIndex]) {
      img = imageByIndex[n.canonicalIndex];
    } else if (imageByNodeId[n.id]) {
      img = imageByNodeId[n.id];
    }
    if (!img) return;

    if (img.local_url) {
      n.imageThumb = img.local_url;   // same-origin, no CORS
      n.imageLarge = img.local_url;
    } else if (img.image_url) {
      n.imageThumb = ensureDirectThumb(img.image_url, 800);
      n.imageLarge = wikimediaResize(img.image_url, 1600);
    }
    n.imageCredit   = img.credit;
    n.imageLicense  = img.license;
    n.imageWikiPage = img.wikimedia_file_page;
    n.imageStrategy = img.image_strategy || null;
    n.imageCaveat   = img.image_caveat || null;
  });

  const nodeById = Object.fromEntries(data.nodes.map(n => [n.id, n]));

  // Bubble motion state — declared early so startBubbleMotion() can run
  // before the grab/free handlers are wired below.
  let bubbleState = new Map();
  let bubbleRaf = null;
  let grabbedId = null;

  // Stats
  const canonCount = data.nodes.filter(n => n.canonical).length;
  const imageCount = data.nodes.filter(n => n.imageThumb).length;
  document.getElementById('stats').textContent =
    `${data.nodes.length} nodes (${canonCount} canònics, ${imageCount} amb imatge) · ${data.edges.length} connexions`;

  // Filter UI (connection types)
  const filtersEl = document.getElementById('connection-filters');
  data.connectionTypes.forEach(t => {
    const label = document.createElement('label');
    label.innerHTML =
      `<input type="checkbox" data-type="${t.id}" checked>` +
      `<span class="color-swatch" style="background:${t.color}"></span>` +
      `${t.label}`;
    label.title = t.description;
    filtersEl.appendChild(label);
  });

  // Filter UI (periods + themes)
  const periodFiltersEl = document.getElementById('period-filters');
  const themeFiltersEl  = document.getElementById('theme-filters');
  // Sort periods chronologically so the list reads naturally
  const periodsSorted = [...data.periods].sort((a, b) => (a.start || 0) - (b.start || 0));
  periodsSorted.forEach(p => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" data-period-id="${p.id}" checked> ${escapeHtmlEarly(p.label)}`;
    periodFiltersEl.appendChild(label);
  });
  const themesSorted = [...data.themes].sort((a, b) => a.label.localeCompare(b.label, 'ca'));
  themesSorted.forEach(t => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" data-theme-id="${t.id}" checked> ${escapeHtmlEarly(t.label)}`;
    themeFiltersEl.appendChild(label);
  });
  // (escapeHtml is defined later in the IIFE; we need a local copy for early use)
  function escapeHtmlEarly(s) {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  }

  // Build Cytoscape elements. Canonical-vs-secondary distinction is two
  // explicit classes ('canonical' or 'secondary') rather than
  // `.canonical` + `.secondary`. Cytoscape 3.30.2 rejects
  // `:not(.class)` as an invalid selector (it accepts `:not([attr])` but
  // not the class form), which silently breaks the whole stylesheet and
  // falls everything back to the default 30 px node.
  const elements = [];
  data.nodes.forEach(n => {
    const d = { id: n.id, label: n.title };
    if (n.imageThumb) d.thumbUrl = n.imageThumb;
    elements.push({
      group: 'nodes',
      data: d,
      classes: n.canonical ? 'canonical' : 'secondary'
    });
  });
  data.edges.forEach((e, i) => {
    elements.push({
      group: 'edges',
      data: {
        id: 'e' + i,
        source: e.source,
        target: e.target,
        type: e.type,
        note: e.note,
        color: typeById[e.type].color
      }
    });
  });

  // --- Layout persistence (localStorage) ---
  // Store the "base" positions (without bubble-motion offset) so the graph
  // keeps the same spatial memory across reloads. Versioned to allow schema
  // changes to invalidate older caches.
  const STORAGE_KEY = 'artmap.positions.v2';
  const LAYOUT_MODE_KEY = 'artmap.layoutMode.v1';

  let layoutMode = localStorage.getItem(LAYOUT_MODE_KEY) || 'network';

  function loadSavedPositions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function clearSavedPositions() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }

  // Chronological layout: X by year (linear), Y by "lane" to avoid overlap.
  // Produces a deterministic result — not saved to localStorage.
  function computeTimelinePositions(nodes) {
    const sorted = [...nodes].sort((a, b) => (a.year || 0) - (b.year || 0));
    const years = sorted.map(n => n.year || 0);
    const minYr = Math.min(...years);
    const maxYr = Math.max(...years);
    const range = Math.max(1, maxYr - minYr);

    const width = 2400;
    const leftPad = 100;
    const laneH = 95;
    const minDx = 85;  // horizontal breathing room between neighbours

    const lanes = [];                 // tracks last x in each lane
    const rawPositions = {};
    sorted.forEach(n => {
      const x = leftPad + ((n.year || 0) - minYr) / range * width;
      let laneIdx = -1;
      for (let i = 0; i < lanes.length; i++) {
        if (x - lanes[i] > minDx) { laneIdx = i; break; }
      }
      if (laneIdx === -1) { laneIdx = lanes.length; lanes.push(x); }
      else { lanes[laneIdx] = x; }
      rawPositions[n.id] = { x, y: laneIdx * laneH };
    });
    // Centre vertically around 0
    const laneCount = lanes.length;
    const yOffset = -(laneCount - 1) * laneH / 2;
    Object.values(rawPositions).forEach(p => { p.y += yOffset; });
    return rawPositions;
  }

  const savedPositions = loadSavedPositions();
  // Only use saved positions if we're in network mode AND every current node
  // has a saved entry — otherwise fall back to cose.
  const usingSavedLayout = layoutMode === 'network'
    && !!savedPositions
    && data.nodes.every(n => savedPositions[n.id]);

  let initialLayout;
  if (layoutMode === 'timeline') {
    const tp = computeTimelinePositions(data.nodes);
    initialLayout = { name: 'preset', positions: (node) => tp[node.id()] || { x: 0, y: 0 }, fit: true, padding: 80 };
  } else if (usingSavedLayout) {
    initialLayout = { name: 'preset', positions: (node) => savedPositions[node.id()] || { x: 0, y: 0 }, fit: true, padding: 50 };
  } else {
    initialLayout = buildLayout(false);
  }

  // Stylesheet as a function of the current zoom. Border widths, font sizes,
  // text margins and edge widths are divided by zoom so they keep a constant
  // *screen* size regardless of how zoomed in/out we are. Node widths and
  // heights (i.e. the image area) do scale with zoom, so the images grow and
  // shrink naturally while the UI ornamentation stays readable.
  function buildStylesheet(zoom, theme = 'light') {
    const inv = 1 / zoom;
    // Partial compensation for node width/height: half of the zoom effect
    // is cancelled so images grow ~50 % as much as they would otherwise.
    //   zoom=1  → sizeF = 1    (unchanged)
    //   zoom=2  → sizeF = 0.75 (screen goes from 20 to 30, not 40)
    //   zoom=3  → sizeF = 0.67 (screen 40, not 60)
    //   zoom=0.5→ sizeF = 1.5  (screen 15, not 10 — nodes shrink less too)
    const sizeF = 0.5 + 0.5 * inv;
    const labelColor = theme === 'dark' ? '#e5e0d5' : '#2a2a2a';
    return [
      {
        selector: 'node',
        style: {
          'label': 'data(label)',
          'text-wrap': 'wrap',
          'text-max-width': 140 * inv,
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 6 * inv,
          'font-size': 10 * inv,
          'font-family': 'Georgia, serif',
          'color': labelColor,
          'background-color': '#c4bdae',
          'border-width': 0,
          'width': 20 * sizeF,
          'height': 20 * sizeF,
          'opacity': 0.5,
          'text-opacity': 0,
          'transition-property': 'background-color border-color border-width opacity text-opacity width height background-image-opacity',
          'transition-duration': '0.45s',
          'transition-timing-function': 'ease-in-out'
        }
      },
      {
        selector: 'node.canonical',
        style: {
          'background-color': '#1c1917',
          'border-color': '#d4a743',
          'border-width': 3 * inv,
          'width': 50 * sizeF,
          'height': 50 * sizeF,
          'font-weight': 'bold',
          'font-size': 12 * inv,
          'opacity': 1,
          'text-opacity': 1
        }
      },
      {
        selector: 'node[thumbUrl]',
        style: {
          'background-image': 'data(thumbUrl)',
          'background-image-crossorigin': 'anonymous',
          'background-fit': 'cover',
          'background-image-opacity': 1,
          'background-clip': 'node',
          'background-color': '#1c1917'
        }
      },
      {
        selector: 'node[thumbUrl].canonical',
        style: {
          'width': 66 * sizeF,
          'height': 66 * sizeF,
          'border-width': 4 * inv,
          'border-color': '#d4a743',
          'opacity': 1,
          'text-opacity': 1
        }
      },
      {
        selector: 'node[thumbUrl].secondary',
        style: {
          'width': 30 * sizeF,
          'height': 30 * sizeF,
          'border-width': 1 * inv,
          'border-color': '#a39d92',
          'opacity': 0.8,
          'text-opacity': 0
        }
      },
      {
        selector: 'edge',
        style: {
          'curve-style': 'bezier',
          'line-color': 'data(color)',
          'target-arrow-color': 'data(color)',
          'target-arrow-shape': 'none',
          'arrow-scale': 1.1,
          'width': 0.9 * inv,
          'opacity': 0.22,
          'transition-property': 'opacity width line-color',
          'transition-duration': '0.45s',
          'transition-timing-function': 'ease-in-out'
        }
      },
      {
        selector: 'node.highlighted',
        style: {
          'opacity': 1,
          'text-opacity': 1
        }
      },
      {
        selector: 'node.highlighted.secondary',
        style: {
          'background-color': '#6b6458',
          'width': 30 * sizeF,
          'height': 30 * sizeF,
          'border-width': 1.5 * inv,
          'border-color': '#4a4639'
        }
      },
      {
        selector: 'node.highlighted.canonical',
        style: {
          'width': 58 * sizeF,
          'height': 58 * sizeF,
          'border-width': 4 * inv,
          'border-color': '#e6bb58'
        }
      },
      {
        selector: 'node.highlighted[thumbUrl].canonical',
        style: {
          'width': 80 * sizeF,
          'height': 80 * sizeF,
          'border-width': 5 * inv,
          'border-color': '#e6bb58'
        }
      },
      {
        selector: 'node.highlighted[thumbUrl].secondary',
        style: {
          'width': 46 * sizeF,
          'height': 46 * sizeF,
          'border-width': 1.5 * inv,
          'border-color': '#4a4639'
        }
      },
      {
        selector: 'edge.highlighted',
        style: {
          'opacity': 0.9,
          'width': 2.6 * inv,
          'target-arrow-shape': 'triangle',
          'z-index': 20
        }
      },
      {
        selector: 'node.ghosted',
        style: {
          'opacity': 0.08,
          'text-opacity': 0,
          'background-image-opacity': 0.35
        }
      },
      {
        selector: 'edge.ghosted',
        style: {
          'opacity': 0.04,
          'width': 0.5 * inv
        }
      },
      {
        selector: 'node:selected',
        style: {
          'border-color': '#dc2626',
          'border-width': 4 * inv
        }
      },
      {
        selector: 'edge:selected',
        style: { 'width': 4 * inv, 'opacity': 1 }
      },
      {
        selector: 'node.kb-focus',
        style: {
          'border-color': '#3d82b8',
          'border-width': 5 * inv,
          'border-style': 'double'
        }
      },
      {
        selector: '.hidden',
        style: { 'display': 'none' }
      }
    ];
  }

  // Theme: 'light' (default) or 'dark'. Restored from localStorage, or
  // follow the OS preference on first visit.
  const THEME_KEY = 'artmap.theme.v1';
  let currentTheme = localStorage.getItem(THEME_KEY);
  if (!currentTheme) {
    currentTheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.body.classList.toggle('dark-mode', currentTheme === 'dark');

  const cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    layout: initialLayout,
    minZoom: 0.2,
    maxZoom: 3,
    wheelSensitivity: 0.25,
    pixelRatio: 'auto',
    textureOnViewport: false,
    motionBlur: false,
    hideEdgesOnViewport: false,
    userZoomingEnabled: false,  // we handle wheel ourselves for smooth, animated zoom
    style: buildStylesheet(1, currentTheme)
  });

  cy.fit(undefined, 50);
  // Initial layout with animate:false runs synchronously; start bubble motion now
  startBubbleMotion();

  // --- Zoom-invariant UI + smooth wheel zoom ---
  // Rebuild the stylesheet when zoom changes so borders/text/edges stay
  // the same *screen* size regardless of magnification (only the image
  // area scales). Throttled to one rebuild per animation frame so smooth
  // zoom animations stay fluid.
  let pendingStyleRefresh = false;
  function scheduleStyleRefresh() {
    if (pendingStyleRefresh) return;
    pendingStyleRefresh = true;
    requestAnimationFrame(() => {
      pendingStyleRefresh = false;
      cy.style(buildStylesheet(cy.zoom(), currentTheme));
    });
  }
  cy.on('zoom', scheduleStyleRefresh);
  scheduleStyleRefresh(); // apply the zoom=1 baseline cleanly after init

  // --- Decorative background: sparse network of faint dots + lines ---
  // Purely cosmetic. Generated once per theme change. Very low opacity so
  // the real graph stays visually dominant. Mouse parallax gives a subtle
  // 'depth' cue without being distracting.
  function generateDecor(theme) {
    const W = 1600, H = 1100, N = 110;
    const color = theme === 'dark' ? '#d4c4a0' : '#3a342d';
    const pts = [];
    for (let i = 0; i < N; i++) {
      pts.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: 0.5 + Math.random() * 1.6
      });
    }
    const lines = [];
    pts.forEach((p, i) => {
      const neighbours = pts
        .map((q, j) => ({ q, j, d: Math.hypot(p.x - q.x, p.y - q.y) }))
        .filter(x => x.j !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 1 + Math.floor(Math.random() * 2));
      neighbours.forEach(n => {
        if (n.d < 180) lines.push({ a: p, b: n.q });
      });
    });
    const pathsSVG = lines.map(l =>
      `<line x1="${l.a.x.toFixed(1)}" y1="${l.a.y.toFixed(1)}" x2="${l.b.x.toFixed(1)}" y2="${l.b.y.toFixed(1)}"/>`
    ).join('');
    const pointsSVG = pts.map(p =>
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.r.toFixed(2)}"/>`
    ).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
      <g stroke="${color}" stroke-width="0.4" opacity="0.22" fill="none">${pathsSVG}</g>
      <g fill="${color}" opacity="0.35">${pointsSVG}</g>
    </svg>`;
  }

  const decorEl = document.getElementById('bg-decor');
  function applyDecor(theme) {
    decorEl.innerHTML = generateDecor(theme);
  }
  applyDecor(currentTheme);

  // Subtle parallax: SVG drifts a few pixels counter to mouse position.
  // Throttled to one update per animation frame.
  let decorTx = 0, decorTy = 0;
  let decorParallaxPending = false;
  document.addEventListener('mousemove', evt => {
    // Parallax range: ±32 px horizontal, ±22 px vertical (~1 cm on a typical
    // monitor). Small enough to feel incidental, large enough to be seen.
    decorTx = -((evt.clientX / window.innerWidth - 0.5) * 32);
    decorTy = -((evt.clientY / window.innerHeight - 0.5) * 22);
    if (decorParallaxPending) return;
    decorParallaxPending = true;
    requestAnimationFrame(() => {
      decorEl.style.transform = `translate(${decorTx.toFixed(1)}px, ${decorTy.toFixed(1)}px)`;
      decorParallaxPending = false;
    });
  });

  // Theme toggle
  function setTheme(next) {
    currentTheme = next;
    localStorage.setItem(THEME_KEY, next);
    document.body.classList.toggle('dark-mode', next === 'dark');
    const btn = document.getElementById('theme-toggle');
    btn.textContent = next === 'dark' ? '☀' : '🌙';
    btn.title = next === 'dark' ? 'Canviar a mode clar' : 'Canviar a mode fosc';
    scheduleStyleRefresh();
    applyDecor(next);
  }
  setTheme(currentTheme);  // sync the button label at init
  document.getElementById('theme-toggle').addEventListener('click', () => {
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });

  // Smooth wheel zoom: instead of snapping to the new zoom instantly (the
  // Cytoscape default), animate the zoom + pan so the transition is gentle.
  // We also recentre around the mouse pointer so zooming feels natural.
  cy.container().addEventListener('wheel', evt => {
    evt.preventDefault();
    const rect = cy.container().getBoundingClientRect();
    const rp = { x: evt.clientX - rect.left, y: evt.clientY - rect.top };

    const currentZoom = cy.zoom();
    // deltaY sign: wheel up (scroll toward user) = deltaY > 0 → zoom out
    const factor = Math.exp(-evt.deltaY * 0.0015);
    const newZoom = Math.min(Math.max(currentZoom * factor, cy.minZoom()), cy.maxZoom());
    if (Math.abs(newZoom - currentZoom) < 1e-4) return;

    // Pan so the graph point under the cursor stays under the cursor
    const currentPan = cy.pan();
    const graphX = (rp.x - currentPan.x) / currentZoom;
    const graphY = (rp.y - currentPan.y) / currentZoom;

    cy.animate({
      zoom: newZoom,
      pan: { x: rp.x - graphX * newZoom, y: rp.y - graphY * newZoom }
    }, {
      duration: 180,
      easing: 'ease-out',
      queue: false
    });
  }, { passive: false });

  // Expose for debugging from the browser console (e.g. cy.nodes('.canonical').length)
  window.cy = cy;
  window.artmap = { cy, data, nodeById };

  // Persist the positions (base, not oscillating) from bubbleState.
  // Only active in network mode — timeline positions are deterministic and
  // recomputed each session.
  function savePositions() {
    if (layoutMode !== 'network') return;
    try {
      const pos = {};
      bubbleState.forEach((s, id) => { pos[id] = { x: s.baseX, y: s.baseY }; });
      if (Object.keys(pos).length > 0) localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
    } catch {}
  }
  savePositions();

  // --- Layout mode toggle ---
  function applyTimelineLayout() {
    stopBubbleMotion();
    const positions = computeTimelinePositions(data.nodes);
    cy.nodes().forEach(n => {
      const p = positions[n.id()];
      if (p) n.animate({ position: p }, { duration: 500, easing: 'ease-in-out' });
    });
    setTimeout(() => {
      cy.fit(undefined, 50);
      startBubbleMotion();
    }, 540);
  }

  function applyNetworkLayout() {
    stopBubbleMotion();
    const saved = loadSavedPositions();
    if (saved && data.nodes.every(n => saved[n.id])) {
      cy.nodes().forEach(n => {
        const p = saved[n.id()];
        if (p) n.animate({ position: p }, { duration: 500, easing: 'ease-in-out' });
      });
      setTimeout(() => {
        cy.fit(undefined, 50);
        startBubbleMotion();
      }, 540);
    } else {
      const layout = cy.layout(buildLayout(true));
      layout.on('layoutstop', () => {
        startBubbleMotion();
        savePositions();
      });
      layout.run();
    }
  }

  // Initialize radio state to current mode + wire up change handler
  document.querySelectorAll('input[name="layout-mode"]').forEach(radio => {
    radio.checked = (radio.value === layoutMode);
    radio.addEventListener('change', evt => {
      // A pending expansion's saved bases refer to old layout positions;
      // reset without animating so the new layout takes over cleanly.
      collapseExpansion(false);
      layoutMode = evt.target.value;
      localStorage.setItem(LAYOUT_MODE_KEY, layoutMode);
      if (layoutMode === 'timeline') applyTimelineLayout();
      else applyNetworkLayout();
    });
  });

  // Filter wiring
  filtersEl.querySelectorAll('input').forEach(cb =>
    cb.addEventListener('change', updateVisibility)
  );
  periodFiltersEl.querySelectorAll('input').forEach(cb =>
    cb.addEventListener('change', updateVisibility)
  );
  themeFiltersEl.querySelectorAll('input').forEach(cb =>
    cb.addEventListener('change', updateVisibility)
  );
  document.getElementById('toggle-secondary').addEventListener('change', updateVisibility);

  // 'Tots' / 'Cap' quick buttons for periods and themes
  function bulkSet(container, checked) {
    container.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = checked; });
    updateVisibility();
  }
  document.getElementById('periods-all').addEventListener('click', () => bulkSet(periodFiltersEl, true));
  document.getElementById('periods-none').addEventListener('click', () => bulkSet(periodFiltersEl, false));
  document.getElementById('themes-all').addEventListener('click',  () => bulkSet(themeFiltersEl, true));
  document.getElementById('themes-none').addEventListener('click', () => bulkSet(themeFiltersEl, false));

  // Initialise summary counts
  updateVisibility();

  function updateVisibility() {
    const activeTypes = new Set(
      [...filtersEl.querySelectorAll('input:checked')].map(cb => cb.dataset.type)
    );
    const showSecondary = document.getElementById('toggle-secondary').checked;
    const activePeriods = new Set(
      [...periodFiltersEl.querySelectorAll('input:checked')].map(cb => cb.dataset.periodId)
    );
    const activeThemes = new Set(
      [...themeFiltersEl.querySelectorAll('input:checked')].map(cb => cb.dataset.themeId)
    );

    // Update summary counts
    document.getElementById('period-count').textContent = `(${activePeriods.size}/${data.periods.length})`;
    document.getElementById('theme-count').textContent  = `(${activeThemes.size}/${data.themes.length})`;

    // 1. Node visibility
    const hiddenNodes = new Set();
    cy.nodes().forEach(node => {
      const n = nodeById[node.id()];
      if (!n) return;
      const isSecondary = !node.hasClass('canonical');
      let hide = false;
      if (!showSecondary && isSecondary) hide = true;
      if (!activePeriods.has(n.period)) hide = true;
      const nodeThemes = n.themes || [];
      if (nodeThemes.length > 0 && !nodeThemes.some(t => activeThemes.has(t))) hide = true;
      node.toggleClass('hidden', hide);
      if (hide) hiddenNodes.add(node.id());
    });

    // 2. Edge visibility: wrong type OR either endpoint hidden
    cy.edges().forEach(edge => {
      const wrongType = !activeTypes.has(edge.data('type'));
      const orphan = hiddenNodes.has(edge.data('source')) || hiddenNodes.has(edge.data('target'));
      edge.toggleClass('hidden', wrongType || orphan);
    });
  }

  // --- Focus system: hover previews + click-to-pin + search ---
  let pinned = false;        // true while a node/edge is click-selected
  let pinnedNodeId = null;   // id of the pinned node (null if pin is on edge / nothing)
  let searchActive = false;  // true while search input has text

  function applyFocus(scope) {
    // NOTE: not wrapped in cy.batch() — batching suppresses the per-element
    // transitions that Cytoscape applies on class changes. Without batch,
    // each addClass/removeClass gets its own animated transition.
    cy.elements().not(scope).addClass('ghosted').removeClass('highlighted');
    scope.addClass('highlighted').removeClass('ghosted');
  }

  function clearFocus() {
    cy.elements().removeClass('ghosted highlighted');
  }

  // Hover: transient preview (no detail panel change).
  // Debounced (~40 ms on enter, ~60 ms on leave) so that rapid mouse moves
  // across many nodes don't thrash Cytoscape's style engine. Without this,
  // each in-flight transition gets cut short and the graph looks jumpy.
  let hoverTimer = null;
  let lastHoveredId = null;

  function scheduleHover(fn, delay) {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(fn, delay);
  }

  cy.on('mouseover', 'node', evt => {
    if (pinned || searchActive) return;
    const id = evt.target.id();
    lastHoveredId = id;
    scheduleHover(() => {
      if (lastHoveredId !== id) return;
      const node = cy.getElementById(id);
      if (!node.empty()) applyFocus(node.closedNeighborhood());
    }, 40);
  });
  cy.on('mouseout', 'node', () => {
    if (pinned || searchActive) return;
    lastHoveredId = null;
    scheduleHover(() => {
      if (lastHoveredId === null) clearFocus();
    }, 60);
  });

  cy.on('mouseover', 'edge', evt => {
    if (pinned || searchActive) return;
    const id = 'edge:' + evt.target.id();
    lastHoveredId = id;
    scheduleHover(() => {
      if (lastHoveredId !== id) return;
      const edge = cy.getElementById(evt.target.id());
      if (!edge.empty()) applyFocus(edge.union(edge.connectedNodes()));
    }, 40);
  });
  cy.on('mouseout', 'edge', () => {
    if (pinned || searchActive) return;
    lastHoveredId = null;
    scheduleHover(() => {
      if (lastHoveredId === null) clearFocus();
    }, 60);
  });

  // Unified node-selection: used by graph taps, hash deep-links, and
  // "travel" clicks from the edge detail panel thumbnails.
  function selectNodeById(nodeId) {
    const node = cy.getElementById(nodeId);
    if (!node || node.empty()) return;
    selectNode(node);
  }

  function selectNode(node) {
    // Idempotent: clicking the same pinned node is a no-op
    if (pinnedNodeId === node.id()) return;
    pinned = true;
    pinnedNodeId = node.id();
    applyFocus(node.closedNeighborhood());
    renderNodeDetail(nodeById[node.id()]);
    setHashFor(node.id());
    openDetailIfMobile();
    closeControlsIfMobile();
    const targets = expandNeighbourhood(node);
    centerOnNode(node, targets);
  }

  // --- Temporary "blooming" expansion of the selected node's neighbourhood ---
  // Pushes direct neighbours out into a circle around the selected node so they
  // don't overlap. Restores them when the user deselects (taps the background)
  // or selects another node.
  let expansionState = null; // { centerId, savedBases: Map<id, {x,y}>, targets: Map<id, {x,y}> }

  // Expand the selected node's neighbourhood gently, preserving the original
  // spatial story as much as possible. Two variants depending on the layout:
  //
  //   · Network mode: keep each neighbour's direction from the centre, only
  //     nudge it outward if it's too close (< minDistance) or pull it inward
  //     if it's very far (> maxDistance). No equidistant circle.
  //
  //   · Timeline mode: preserve X (chronology is the point), but compress the
  //     vertical spread toward the centre's Y so the 20th-century stack
  //     becomes legible.
  function expandNeighbourhood(centerNode) {
    const centerId = centerNode.id();

    if (expansionState && expansionState.centerId !== centerId) {
      collapseExpansion(/*animate*/ false);
    }
    if (expansionState && expansionState.centerId === centerId) {
      return expansionState.targets;
    }

    const neighbours = centerNode.closedNeighborhood().nodes().filter(n => n.id() !== centerId);
    if (neighbours.length === 0) return null;

    const centerBase = bubbleState.get(centerId);
    const cx = centerBase?.baseX ?? centerNode.position('x');
    const cy = centerBase?.baseY ?? centerNode.position('y');

    const savedBases = new Map();
    const targets = new Map();
    targets.set(centerId, { x: cx, y: cy });

    const onTimeline = layoutMode === 'timeline';
    const minDistance = 140;   // network mode: don't let neighbours cluster closer than this
    const maxDistance = 320;   // network mode: don't let them be way off-screen either
    const maxVOffset  = 110;   // timeline mode: max vertical offset of any neighbour

    neighbours.forEach(node => {
      const s = bubbleState.get(node.id());
      if (!s) return;
      savedBases.set(node.id(), { x: s.baseX, y: s.baseY });

      let nx = s.baseX, ny = s.baseY;

      if (onTimeline) {
        // Keep X (year); compress Y toward centre's Y.
        const dy = s.baseY - cy;
        if (Math.abs(dy) > maxVOffset) {
          ny = cy + Math.sign(dy) * maxVOffset;
        }
      } else {
        // Keep direction; clamp distance to [minDistance, maxDistance].
        const dx = s.baseX - cx;
        const dy = s.baseY - cy;
        const dist = Math.hypot(dx, dy);
        let targetDist = dist;
        if (dist === 0)            targetDist = minDistance;
        else if (dist < minDistance) targetDist = minDistance;
        else if (dist > maxDistance) targetDist = maxDistance;
        if (targetDist !== dist) {
          const scale = targetDist / (dist || 1);
          nx = cx + (dist === 0 ? minDistance : dx * scale);
          ny = cy + (dist === 0 ? 0           : dy * scale);
        }
      }

      const changed = (nx !== s.baseX || ny !== s.baseY);
      s.baseX = nx;
      s.baseY = ny;
      targets.set(node.id(), { x: nx, y: ny });
      if (changed) {
        node.stop();
        node.animate({ position: { x: nx, y: ny } }, { duration: 480, easing: 'ease-in-out' });
      }
    });

    expansionState = { centerId, savedBases, targets };
    return targets;
  }

  function collapseExpansion(animate = true) {
    if (!expansionState) return;
    expansionState.savedBases.forEach((pos, nodeId) => {
      const s = bubbleState.get(nodeId);
      if (s) { s.baseX = pos.x; s.baseY = pos.y; }
      const node = cy.getElementById(nodeId);
      if (!node || node.empty()) return;
      node.stop();
      if (animate) {
        node.animate({ position: pos }, { duration: 480, easing: 'ease-in-out' });
      } else {
        node.position(pos);
      }
    });
    expansionState = null;
  }

  // Click: pin focus + populate detail panel + reflect state in URL
  cy.on('tap', 'node', evt => selectNode(evt.target));

  cy.on('tap', 'edge', evt => {
    const edge = evt.target;
    pinned = true;
    pinnedNodeId = null;  // edge pin doesn't have a node anchor
    applyFocus(edge.union(edge.connectedNodes()));
    const e = edge.data();
    renderEdgeDetail({
      ...e,
      src: nodeById[e.source],
      tgt: nodeById[e.target]
    });
    clearHash();
    openDetailIfMobile();
    closeControlsIfMobile();
  });

  cy.on('tap', evt => {
    if (evt.target === cy) {
      pinned = false;
      pinnedNodeId = null;
      collapseExpansion();
      if (!searchActive) clearFocus();
      else runSearch(document.getElementById('search-input').value);
      document.getElementById('detail').innerHTML =
        '<p class="placeholder">Passa el ratolí per sobre un node per previsualitzar el seu veïnat. Fes clic per fixar-lo i veure\'n la fitxa.</p>';
      clearHash();
      closeDetailDrawer();
      closeControlsIfMobile();
    }
  });

  // --- Responsive drawer behaviour (<900px) ---
  const controlsEl = document.querySelector('.controls');
  const detailEl   = document.querySelector('.detail');
  const backdropEl = document.getElementById('panel-backdrop');
  const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

  function syncBackdrop() {
    const anyOpen = controlsEl.classList.contains('panel-open')
                 || detailEl.classList.contains('panel-open');
    backdropEl.classList.toggle('visible', anyOpen && isMobile());
  }

  function openDetailIfMobile() {
    if (isMobile()) detailEl.classList.add('panel-open');
    syncBackdrop();
  }
  function closeDetailDrawer() {
    detailEl.classList.remove('panel-open');
    syncBackdrop();
  }
  function closeControlsIfMobile() {
    if (isMobile()) controlsEl.classList.remove('panel-open');
    syncBackdrop();
  }

  document.getElementById('controls-toggle').addEventListener('click', () => {
    controlsEl.classList.toggle('panel-open');
    syncBackdrop();
  });
  backdropEl.addEventListener('click', () => {
    controlsEl.classList.remove('panel-open');
    detailEl.classList.remove('panel-open');
    syncBackdrop();
  });

  // Drawers that become panels on viewport resize should lose their transforms
  window.addEventListener('resize', () => {
    if (!isMobile()) {
      controlsEl.classList.remove('panel-open');
      detailEl.classList.remove('panel-open');
      backdropEl.classList.remove('visible');
    }
  });

  // --- Deep linking (#node/<id>) ---
  function setHashFor(nodeId) {
    const newHash = `#node/${encodeURIComponent(nodeId)}`;
    if (location.hash !== newHash) {
      history.replaceState(null, '', location.pathname + location.search + newHash);
    }
  }
  function clearHash() {
    if (location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }
  function openNodeByHash() {
    const match = /^#node\/(.+)$/.exec(location.hash);
    if (!match) return;
    const id = decodeURIComponent(match[1]);
    selectNodeById(id);
  }

  // Pan so that `node` sits at the centre of the visible graph area. On mobile,
  // the bottom sheet covers ~70% of the screen — we shift the target up so the
  // Fit the node AND its closed neighbourhood into the visible viewport, so
  // the user always sees the selected work together with its connections.
  // Zoom is recomputed from the neighbourhood bounding box and capped to
  // avoid extreme zoom-in (isolated nodes) or zoom-out (hub nodes).
  // On mobile the bottom sheet covers ~70% of the viewport, so the "visible"
  // area is just the top ~30% — the target centre shifts up accordingly.
  function centerOnNode(node, overrideTargets = null) {
    if (!node || node.empty()) return;

    // If expansion supplied target positions, fit to the "bloomed" bbox rather
    // than the current (mid-animation) one. Otherwise use the live neighbourhood.
    let bbox;
    if (overrideTargets && overrideTargets.size > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      overrideTargets.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      });
      const radius = 42; // approximate max node radius (canonical+image hover)
      bbox = {
        x1: minX - radius, y1: minY - radius,
        x2: maxX + radius, y2: maxY + radius,
        w:  (maxX - minX) + 2 * radius,
        h:  (maxY - minY) + 2 * radius
      };
    } else {
      bbox = node.closedNeighborhood().boundingBox();
    }

    const onMobile = isMobile();
    const viewW = cy.width();
    const viewH = cy.height();

    // Usable height: top 30% on mobile, full height on desktop.
    const visibleH = onMobile ? viewH * 0.30 : viewH;
    const centerX  = viewW / 2;
    const centerY  = onMobile ? viewH * 0.15 : viewH / 2;

    // Target zoom so the whole neighbourhood fits with padding; clamped.
    const padding = 70;
    const fitZoomX = (viewW    - padding * 2) / Math.max(bbox.w, 1);
    const fitZoomY = (visibleH - padding * 2) / Math.max(bbox.h, 1);
    const targetZoom = Math.min(Math.max(Math.min(fitZoomX, fitZoomY), 0.45), 1.6);

    // Target pan so the bbox centre lands at (centerX, centerY).
    const bboxCx = bbox.x1 + bbox.w / 2;
    const bboxCy = bbox.y1 + bbox.h / 2;

    try {
      cy.animate({
        pan:  { x: centerX - bboxCx * targetZoom, y: centerY - bboxCy * targetZoom },
        zoom: targetZoom
      }, {
        duration: 500,
        easing: 'ease-in-out'
      });
    } catch {}
  }
  window.addEventListener('hashchange', openNodeByHash);
  openNodeByHash();

  // --- Live search ---
  const searchInput = document.getElementById('search-input');
  const searchCount = document.getElementById('search-count');

  function runSearch(raw) {
    const q = (raw || '').trim().toLowerCase();
    if (!q) {
      searchActive = false;
      searchCount.textContent = '';
      // If a node is still pinned (e.g. via deep link), restore its focus;
      // otherwise clear everything.
      if (pinnedNodeId) {
        const node = cy.getElementById(pinnedNodeId);
        if (!node.empty()) {
          applyFocus(node.closedNeighborhood());
          return;
        }
      }
      if (!pinned) clearFocus();
      return;
    }
    searchActive = true;
    const matches = cy.nodes().filter(el => {
      const n = nodeById[el.id()];
      if (!n) return false;
      const themes = (n.themes || []).map(id => themeById[id]?.label || '').join(' ');
      const period = periodById[n.period]?.label || '';
      const hay = [
        n.title, n.author, n.yearLabel, String(n.year || ''),
        period, themes, (n.notes || '')
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
    const internalEdges = matches.edgesWith(matches);
    applyFocus(matches.union(internalEdges));
    searchCount.textContent =
      matches.length === 0
        ? 'Sense coincidències'
        : `${matches.length} ${matches.length === 1 ? 'coincidència' : 'coincidències'}`;
  }

  searchInput.addEventListener('input', evt => runSearch(evt.target.value));
  searchInput.addEventListener('keydown', evt => {
    if (evt.key === 'Escape') {
      searchInput.value = '';
      runSearch('');
      searchInput.blur();
      evt.preventDefault();
    }
  });

  // --- Keyboard navigation ---
  // Tab / Shift+Tab: cycle through canonical works (blue 'kb-focus' border,
  //                  independent from the red selection border)
  // Enter:           select/pin the currently focused canonical
  // /:               move focus into the search input
  // Escape:          peel back one layer (search → kb-focus → pin)
  const canonicalOrdered = data.nodes
    .filter(n => n.canonical)
    .sort((a, b) => (a.canonicalIndex || 0) - (b.canonicalIndex || 0));
  let kbFocusId = null;

  function moveKbFocus(delta) {
    const idx = kbFocusId ? canonicalOrdered.findIndex(n => n.id === kbFocusId) : -1;
    let next = (idx + delta) % canonicalOrdered.length;
    if (next < 0) next += canonicalOrdered.length;
    if (kbFocusId) {
      const prev = cy.getElementById(kbFocusId);
      if (prev && !prev.empty()) prev.removeClass('kb-focus');
    }
    kbFocusId = canonicalOrdered[next].id;
    const node = cy.getElementById(kbFocusId);
    node.addClass('kb-focus');
    try {
      cy.animate({ center: { eles: node } }, { duration: 320, easing: 'ease-in-out' });
    } catch {}
  }

  function clearKbFocus() {
    if (kbFocusId) {
      const node = cy.getElementById(kbFocusId);
      if (node && !node.empty()) node.removeClass('kb-focus');
      kbFocusId = null;
    }
  }

  function clearPin() {
    if (!pinnedNodeId && !pinned) return;
    pinned = false;
    pinnedNodeId = null;
    collapseExpansion();
    if (!searchActive) clearFocus();
    clearHash();
    document.getElementById('detail').innerHTML =
      '<p class="placeholder">Passa el ratolí per sobre un node per previsualitzar el seu veïnat. Fes clic per fixar-lo i veure\'n la fitxa.</p>';
  }

  document.addEventListener('keydown', evt => {
    // If the user is typing in the search box, only Escape is relevant here —
    // and that's handled on the input itself.
    if (document.activeElement === searchInput) return;

    // Don't hijack keys while inside other inputs either
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

    switch (evt.key) {
      case 'Tab':
        evt.preventDefault();
        moveKbFocus(evt.shiftKey ? -1 : 1);
        break;
      case 'Enter':
        if (kbFocusId) {
          evt.preventDefault();
          const node = cy.getElementById(kbFocusId);
          if (node && !node.empty()) selectNode(node);
        }
        break;
      case '/':
        evt.preventDefault();
        searchInput.focus();
        searchInput.select();
        break;
      case 'Escape':
        // Peel back one layer
        if (searchActive) {
          searchInput.value = '';
          runSearch('');
        } else if (kbFocusId) {
          clearKbFocus();
        } else if (pinnedNodeId || pinned) {
          clearPin();
        }
        break;
    }
  });

  // Buttons
  document.getElementById('fit-btn').addEventListener('click', () => cy.fit(undefined, 50));

  document.getElementById('print-all-btn').addEventListener('click', evt =>
    runPrint(
      () => true,
      { lead: 'Fitxes de les 101 obres del mapa (55 canòniques PAU + 46 nodes pont)' },
      evt.currentTarget
    )
  );
  document.getElementById('print-pau-btn').addEventListener('click', evt =>
    runPrint(
      n => !!n.canonical,
      { lead: "Fitxes de les 55 obres d'Història de l'Art · PAU 2026 (Catalunya)" },
      evt.currentTarget
    )
  );
  document.getElementById('relayout-btn').addEventListener('click', () => {
    if (layoutMode === 'timeline') {
      applyTimelineLayout();
      return;
    }
    stopBubbleMotion();
    clearSavedPositions();                   // user explicitly wants a fresh arrangement
    const layout = cy.layout(buildLayout(true));
    layout.on('layoutstop', () => {
      startBubbleMotion();
      savePositions();                       // persist the new arrangement
    });
    layout.run();
  });

  // Fullscreen modal
  const fs = document.getElementById('fullscreen');
  const fsImg = document.getElementById('fs-img');
  const fsCaption = document.getElementById('fs-caption');
  const fsDetail = document.getElementById('fs-detail');
  document.querySelector('.fs-close').addEventListener('click', closeFullscreen);
  fs.addEventListener('click', evt => {
    if (evt.target === fs) closeFullscreen(); // click on backdrop
  });
  document.addEventListener('keydown', evt => {
    if (evt.key === 'Escape' && !fs.classList.contains('fs-hidden')) closeFullscreen();
  });

  function openFullscreen(n) {
    if (!n.imageLarge) return;
    fsImg.src = n.imageLarge;
    fsImg.alt = n.title;
    fsCaption.innerHTML = [
      escapeHtml(n.imageCredit || ''),
      n.imageLicense ? escapeHtml(n.imageLicense) : '',
      n.imageWikiPage ? `<a href="${escapeHtml(n.imageWikiPage)}" target="_blank" rel="noopener">Commons</a>` : ''
    ].filter(Boolean).join(' · ');
    fsDetail.innerHTML = buildDetailHtml(n, /*includeImage*/false);
    fs.classList.remove('fs-hidden');
    fs.setAttribute('aria-hidden', 'false');
  }

  function closeFullscreen() {
    fs.classList.add('fs-hidden');
    fs.setAttribute('aria-hidden', 'true');
  }

  // Layout factory
  function buildLayout(animate) {
    return {
      name: 'cose',
      animate,
      animationDuration: 600,
      randomize: animate,
      nodeRepulsion: 24000,
      idealEdgeLength: 240,
      gravity: 0.08,
      edgeElasticity: 120,
      nestingFactor: 1.2,
      padding: 80,
      numIter: 2500,
      componentSpacing: 220
    };
  }

  // --- Bubble motion: subtle drifting for all non-grabbed nodes ---
  // (state declared above to avoid TDZ when startBubbleMotion runs)

  cy.on('grab',  'node', evt => { grabbedId = evt.target.id(); });
  cy.on('free',  'node', evt => {
    const s = bubbleState.get(evt.target.id());
    if (s) {
      const p = evt.target.position();
      s.baseX = p.x; s.baseY = p.y;
    }
    grabbedId = null;
    savePositions();
  });

  function startBubbleMotion() {
    captureBubbleBases();
    if (!bubbleRaf) bubbleTick();
  }

  function stopBubbleMotion() {
    if (bubbleRaf) cancelAnimationFrame(bubbleRaf);
    bubbleRaf = null;
  }

  function captureBubbleBases() {
    bubbleState = new Map();
    cy.nodes().forEach(n => {
      const p = n.position();
      bubbleState.set(n.id(), {
        baseX: p.x,
        baseY: p.y,
        phaseX: Math.random() * 2 * Math.PI,
        phaseY: Math.random() * 2 * Math.PI,
        speedX: 0.0005 + Math.random() * 0.00035,
        speedY: 0.0005 + Math.random() * 0.00035,
        ampX: 1.6 + Math.random() * 1.4,
        ampY: 1.6 + Math.random() * 1.4
      });
    });
  }

  function bubbleTick() {
    const t = performance.now();
    cy.batch(() => {
      bubbleState.forEach((s, id) => {
        if (id === grabbedId) return;
        const n = cy.getElementById(id);
        if (!n || n.empty()) return;
        const dx = Math.sin(t * s.speedX + s.phaseX) * s.ampX;
        const dy = Math.cos(t * s.speedY + s.phaseY) * s.ampY;
        // Sub-pixel positions: relying on pixelRatio:'auto' + devicePixelRatio
        // for antialiased render quality instead of pixel-snapping, so motion
        // stays smooth instead of stepping tac-tac.
        n.position({ x: s.baseX + dx, y: s.baseY + dy });
      });
    });
    bubbleRaf = requestAnimationFrame(bubbleTick);
  }

  // --- Wikimedia URL helpers ---

  // Extract the filename (URL-encoded form) from any Wikimedia Commons URL.
  function extractWikimediaFilename(url) {
    if (!url) return null;
    const thumbMatch = url.match(/\/commons\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/([^/]+?)\/\d+px-/);
    if (thumbMatch) return thumbMatch[1];
    const directMatch = url.match(/\/commons\/[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)$/);
    if (directMatch) return directMatch[1];
    return null;
  }

  // Special:FilePath?width=N → redirects to the nearest pre-generated step.
  // Use for <img> tags (no CORS requirement); does NOT work for canvas
  // background-image because the redirect strips CORS headers.
  function wikimediaResize(url, width) {
    const filename = extractWikimediaFilename(url);
    if (!filename) return url;
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${filename}?width=${width}`;
  }

  // Ensure the URL is a direct /thumb/ URL on upload.wikimedia.org.
  // Required for Cytoscape canvas rendering (needs CORS, which
  // upload.wikimedia.org sends but Special:FilePath redirects drop).
  function ensureDirectThumb(url, preferredWidth) {
    if (!url) return null;
    if (url.includes('/thumb/')) return url; // agent-picked size, keep it
    const m = url.match(/^(https?:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/)([0-9a-f])\/([0-9a-f]{2})\/([^/?#]+)$/);
    if (m) {
      const [, base, a, ab, filename] = m;
      return `${base}thumb/${a}/${ab}/${filename}/${preferredWidth}px-${filename}`;
    }
    return url;
  }

  // --- Rendering ---

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function buildImageBlock(n) {
    if (!n.imageLarge) {
      if (n.canonical) {
        return `<div class="image-missing">Sense imatge lliure disponible<br>(obra amb drets d'autor vigents).</div>`;
      }
      return '';
    }
    const caveat = n.imageCaveat
      ? `<div class="image-caveat"><strong>Nota:</strong> ${escapeHtml(n.imageCaveat)}</div>`
      : '';
    const strategy = n.imageStrategy
      ? `<div class="image-strategy">${escapeHtml(n.imageStrategy)}</div>`
      : '';
    return `<figure class="node-image">
       <button class="fs-button" data-node-id="${escapeHtml(n.id)}" title="Pantalla completa">Ampliar</button>
       <img src="${escapeHtml(n.imageThumb)}" alt="${escapeHtml(n.title)}" loading="lazy" data-fs="${escapeHtml(n.id)}">
       <figcaption>
         ${strategy}
         ${escapeHtml(n.imageCredit || '')}
         ${n.imageLicense ? ` · ${escapeHtml(n.imageLicense)}` : ''}
         ${n.imageWikiPage ? ` · <a href="${escapeHtml(n.imageWikiPage)}" target="_blank" rel="noopener">Commons</a>` : ''}
       </figcaption>
       ${caveat}
     </figure>`;
  }

  function buildDetailHtml(n, includeImage) {
    const period  = periodById[n.period];
    const themes  = (n.themes || []).map(id => themeById[id]?.label).filter(Boolean);
    const badge   = n.canonical
      ? `<span class="canonical-badge">PAU #${n.canonicalIndex}</span>`
      : '';

    return `
      ${includeImage ? buildImageBlock(n) : ''}
      <h2>${escapeHtml(n.title)}${badge}</h2>
      <div class="author">${escapeHtml(n.author || '')}</div>
      <div class="meta">
        <div><strong>Any:</strong> ${escapeHtml(n.yearLabel || n.year)}</div>
        <div><strong>Període:</strong> ${escapeHtml(period?.label || n.period)}</div>
        <div><strong>Tècnica:</strong> ${escapeHtml(n.technique || '—')}</div>
        <div><strong>Ubicació:</strong> ${escapeHtml(n.location || '—')}</div>
      </div>
      <div class="fitxa-toolbar">
        <button class="node-action btn-copy-link" data-node-id="${escapeHtml(n.id)}" title="Copia un enllaç directe a aquesta fitxa">🔗 Copiar enllaç</button>
        <button class="node-action btn-print-single" data-node-id="${escapeHtml(n.id)}" title="Genera un PDF només amb aquesta fitxa">📄 Exportar fitxa (PDF)</button>
        <button class="node-action btn-add-to-pres pres-prep-only" data-node-id="${escapeHtml(n.id)}" title="Afegir aquesta obra a la seqüència de presentació">+ Afegir a la presentació</button>
      </div>
      ${themes.length
        ? `<div class="themes">${themes.map(t => `<span class="theme-tag">${escapeHtml(t)}</span>`).join('')}</div>`
        : ''}
      ${n.analysis?.context ? `<h4>Context</h4><p>${escapeHtml(n.analysis.context)}</p>` : ''}
      ${n.analysis?.formal  ? `<h4>Anàlisi formal</h4><p>${escapeHtml(n.analysis.formal)}</p>`  : ''}
      ${n.analysis?.meaning ? `<h4>Significat</h4><p>${escapeHtml(n.analysis.meaning)}</p>`     : ''}
      ${n.analysis?.function? `<h4>Funció</h4><p>${escapeHtml(n.analysis.function)}</p>`        : ''}
      ${(n.counterfactuals || []).length
        ? `<h4>Preguntes contrafactuals</h4><ul>${n.counterfactuals.map(q => `<li>${escapeHtml(q)}</li>`).join('')}</ul>`
        : ''}
      ${n.notes ? `<h4>Notes</h4><p>${escapeHtml(n.notes)}</p>` : ''}
    `;
  }

  function renderNodeDetail(n) {
    const detail = document.getElementById('detail');
    detail.innerHTML = buildDetailHtml(n, /*includeImage*/true);
    // Wire up the fullscreen button + image click
    const fsBtn = detail.querySelector('.fs-button');
    if (fsBtn) fsBtn.addEventListener('click', () => openFullscreen(n));
    const img = detail.querySelector('.node-image img');
    if (img) img.addEventListener('click', () => openFullscreen(n));
    // Wire up the single-node PDF export
    const printBtn = detail.querySelector('.btn-print-single');
    if (printBtn) printBtn.addEventListener('click', () => printSingleNode(n.id, printBtn));
  }

  // =======================================================================
  // Print export: build one fitxa per node in a hidden container, then ask
  // the browser to print. User saves as PDF from the native print dialog.
  //
  // Three entry points share the same core:
  //   · "Totes les fitxes (101)"   — from controls panel
  //   · "Només PAU (55)"           — from controls panel
  //   · "Exportar aquesta fitxa"   — from the detail panel, per node
  // They differ only in the filter + optional cover page.
  // =======================================================================

  async function runPrint(filter, cover, triggerBtn) {
    const originalText = triggerBtn?.textContent;
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = 'Preparant...';
    }
    try {
      buildPrintContent(filter, cover);
      await waitForPrintImages();
      window.print();
    } finally {
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.textContent = originalText;
      }
    }
  }

  function printSingleNode(nodeId, triggerBtn) {
    runPrint(n => n.id === nodeId, null, triggerBtn);
  }

  function waitForPrintImages() {
    const imgs = document.querySelectorAll('#print-container img');
    return Promise.all([...imgs].map(img => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 6000); // hard timeout per image
      });
    }));
  }

  function buildPrintContent(filter, cover) {
    const container = document.getElementById('print-container');
    container.innerHTML = '';

    // Build per-node edge index (both directions) once
    const connectionsByNode = {};
    data.edges.forEach(e => {
      (connectionsByNode[e.source] ||= []).push({ type: e.type, other: e.target, role: 'out', note: e.note });
      (connectionsByNode[e.target] ||= []).push({ type: e.type, other: e.source, role: 'in',  note: e.note });
    });

    const filtered = data.nodes.filter(filter);
    const sorted = [...filtered].sort((a, b) => {
      if (a.canonical && !b.canonical) return -1;
      if (!a.canonical && b.canonical) return 1;
      if (a.canonical && b.canonical) return (a.canonicalIndex || 0) - (b.canonicalIndex || 0);
      return (a.title || '').localeCompare(b.title || '', 'ca');
    });

    // Cover page only when printing multiple works
    if (cover && sorted.length > 1) {
      container.insertAdjacentHTML('beforeend', `
        <section class="print-cover">
          <h1>Art Map</h1>
          <p class="lead">${escapeHtml(cover.lead)}</p>
          <p class="meta">
            ${sorted.length} obres · ${new Date().toLocaleDateString('ca-ES', { day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </section>
      `);
    }

    sorted.forEach(n => {
      container.insertAdjacentHTML('beforeend', renderPrintFitxa(n, connectionsByNode[n.id] || []));
    });
  }

  function renderPrintFitxa(n, conns) {
    const period = periodById[n.period];
    const themes = (n.themes || []).map(id => themeById[id]?.label).filter(Boolean);
    const badge = n.canonical ? `<span class="badge">PAU #${n.canonicalIndex}</span>` : '';

    const imgHtml = n.imageLarge
      ? `<div class="img-wrap">
           <img src="${escapeHtml(n.imageLarge)}" alt="">
           ${n.imageStrategy ? `<div class="img-caption">${escapeHtml(n.imageStrategy)}${n.imageCredit ? ` · ${escapeHtml(n.imageCredit)}` : ''}</div>` : n.imageCredit ? `<div class="img-caption">${escapeHtml(n.imageCredit)}</div>` : ''}
         </div>`
      : '';

    const caveatHtml = n.imageCaveat
      ? `<div class="caveat-box"><strong>Nota:</strong> ${escapeHtml(n.imageCaveat)}</div>`
      : '';

    const themesHtml = themes.length
      ? `<div class="themes-line"><strong>Temes:</strong> ${themes.map(escapeHtml).join(' · ')}</div>`
      : '';

    const cfHtml = (n.counterfactuals || []).length
      ? `<h3>Preguntes contrafactuals</h3><ul>${n.counterfactuals.map(q => `<li>${escapeHtml(q)}</li>`).join('')}</ul>`
      : '';

    const connsHtml = conns.length
      ? `<h3>Connexions (${conns.length})</h3>
         <ul class="conn-list">${conns.map(c => {
           const other = nodeById[c.other] || {};
           const typeLabel = typeById[c.type]?.label || c.type;
           const arrow = c.role === 'out' ? '→' : '←';
           const meta = [other.author, other.yearLabel || other.year].filter(Boolean).map(escapeHtml).join(', ');
           return `<li>
             <span class="conn-type">${escapeHtml(typeLabel)}</span>
             <span class="conn-arrow">${arrow}</span>
             <strong>${escapeHtml(other.title || c.other)}</strong>${meta ? ` (${meta})` : ''}
             <span class="conn-note">${escapeHtml(c.note || '')}</span>
           </li>`;
         }).join('')}</ul>`
      : '';

    return `
      <article class="print-fitxa">
        <header class="fitxa-head">
          <h1>${escapeHtml(n.title)}${badge}</h1>
          <p class="author">${escapeHtml(n.author || '—')}</p>
        </header>
        ${imgHtml}
        ${caveatHtml}
        <div class="meta-grid">
          <div><span class="k">Any:</span>${escapeHtml(n.yearLabel || n.year || '—')}</div>
          <div><span class="k">Tècnica:</span>${escapeHtml(n.technique || '—')}</div>
          <div><span class="k">Període:</span>${escapeHtml(period?.label || n.period || '—')}</div>
          <div><span class="k">Ubicació:</span>${escapeHtml(n.location || '—')}</div>
        </div>
        ${themesHtml}
        ${n.analysis?.context ? `<h3>Context</h3><p>${escapeHtml(n.analysis.context)}</p>` : ''}
        ${n.analysis?.formal  ? `<h3>Anàlisi formal</h3><p>${escapeHtml(n.analysis.formal)}</p>`  : ''}
        ${n.analysis?.meaning ? `<h3>Significat</h3><p>${escapeHtml(n.analysis.meaning)}</p>`     : ''}
        ${n.analysis?.function? `<h3>Funció</h3><p>${escapeHtml(n.analysis.function)}</p>`        : ''}
        ${cfHtml}
        ${connsHtml}
      </article>
    `;
  }

  function renderEdgeDetail({ type, note, color, src, tgt }) {
    const t = typeById[type];
    const srcImg = src.imageThumb
      ? `<img class="edge-thumb" src="${escapeHtml(src.imageThumb)}" alt="${escapeHtml(src.title)}" loading="lazy">`
      : '';
    const tgtImg = tgt.imageThumb
      ? `<img class="edge-thumb" src="${escapeHtml(tgt.imageThumb)}" alt="${escapeHtml(tgt.title)}" loading="lazy">`
      : '';

    const detail = document.getElementById('detail');
    detail.innerHTML = `
      <div class="edge-header">
        <button class="edge-work clickable" data-node-id="${escapeHtml(src.id)}" title="Viatja cap a aquesta obra">
          ${srcImg}
          <div><strong>${escapeHtml(src.title)}</strong><br><span class="small">${escapeHtml(src.author || '')} · ${escapeHtml(src.yearLabel || src.year)}</span></div>
        </button>
        <div class="edge-arrow" style="color:${color}">→</div>
        <button class="edge-work clickable" data-node-id="${escapeHtml(tgt.id)}" title="Viatja cap a aquesta obra">
          ${tgtImg}
          <div><strong>${escapeHtml(tgt.title)}</strong><br><span class="small">${escapeHtml(tgt.author || '')} · ${escapeHtml(tgt.yearLabel || tgt.year)}</span></div>
        </button>
      </div>
      <div class="author" style="margin-top: 0.8rem;">Connexió: <strong>${escapeHtml(t.label)}</strong></div>
      <div class="meta" style="font-size: 0.85rem; font-style: italic;">${escapeHtml(t.description)}</div>
      <div class="edge-note" style="border-left-color:${color}">${escapeHtml(note)}</div>
    `;

    detail.querySelectorAll('.edge-work.clickable').forEach(btn => {
      btn.addEventListener('click', () => selectNodeById(btn.dataset.nodeId));
    });
  }

  // =======================================================================
  // PRESENTATION MODE — teacher prepares a slide sequence and plays it back
  //
  // Three modes:
  //   off   = normal interactive exploration (default)
  //   prep  = regular map + a "Diapositives" strip at the bottom.
  //           Each node's detail panel shows a "+ Afegir" button; the strip
  //           lists all added nodes, lets you remove/reorder (drag), and
  //           import/export the sequence as a JSON file.
  //   play  = full-screen dark viewer showing one slide at a time. Navigate
  //           with ← / → / Space / click arrows; Esc returns to prep.
  //
  // The sequence is persisted to localStorage so it survives reloads.
  // =======================================================================

  const PRES_KEY = 'artmap.presentation.v1';
  let presentationMode = 'off';
  let presSequence = loadPresSequence();
  let presCurrentIdx = 0;

  function loadPresSequence() {
    try {
      const raw = localStorage.getItem(PRES_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(id => nodeById[id]) : [];
    } catch { return []; }
  }

  function persistPresSequence() {
    try { localStorage.setItem(PRES_KEY, JSON.stringify(presSequence)); } catch {}
  }

  function setPresentationMode(mode) {
    presentationMode = mode;
    document.body.classList.toggle('presentation-prep', mode === 'prep');
    document.body.classList.toggle('presentation-play', mode === 'play');
    document.getElementById('presentation-strip').classList.toggle('pres-hidden', mode !== 'prep');
    document.getElementById('presentation-view').classList.toggle('pres-hidden', mode !== 'play');
    document.getElementById('presentation-toggle').textContent =
      mode === 'off' ? 'Mode presentació' : 'Tornar al mapa';
    // Give Cytoscape a moment to adjust its container size when we grow/shrink it
    if (mode !== 'play') setTimeout(() => cy.resize(), 50);
  }

  function togglePresentationMode() {
    if (presentationMode === 'off') {
      setPresentationMode('prep');
      renderSlides();
    } else {
      setPresentationMode('off');
    }
  }

  function addToSequence(nodeId) {
    if (!nodeId || !nodeById[nodeId]) return;
    if (presSequence.includes(nodeId)) {
      // Visual nudge for a duplicate add: briefly flash the existing slide
      flashSlide(nodeId);
      return;
    }
    presSequence.push(nodeId);
    persistPresSequence();
    renderSlides();
    flashSlide(nodeId);
  }

  function removeFromSequence(nodeId) {
    presSequence = presSequence.filter(id => id !== nodeId);
    persistPresSequence();
    renderSlides();
  }

  function clearSequence() {
    if (presSequence.length === 0) return;
    if (!confirm(`Vols buidar la seqüència de ${presSequence.length} obres?`)) return;
    presSequence = [];
    persistPresSequence();
    renderSlides();
  }

  function flashSlide(nodeId) {
    const el = document.querySelector(`#strip-slides .slide[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    el.style.transition = 'background 0.2s ease';
    el.style.background = '#b8860b';
    setTimeout(() => { el.style.background = ''; }, 300);
  }

  function renderSlides() {
    const container = document.getElementById('strip-slides');
    document.getElementById('strip-count').textContent = presSequence.length;
    document.getElementById('start-presentation').disabled = presSequence.length === 0;
    document.getElementById('export-session').disabled = presSequence.length === 0;
    document.getElementById('clear-session').disabled = presSequence.length === 0;

    if (presSequence.length === 0) {
      container.innerHTML = '<div class="strip-empty">Obre una obra al mapa i prem el botó <strong>+ Afegir a la presentació</strong> per començar.</div>';
      return;
    }

    container.innerHTML = presSequence.map((id, i) => {
      const n = nodeById[id];
      if (!n) return '';
      const thumb = n.imageThumb || '';
      const imgHtml = thumb
        ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy">`
        : '<div class="slide-noimg"></div>';
      return `
        <div class="slide" draggable="true" data-node-id="${escapeHtml(id)}" data-idx="${i}" title="${escapeHtml(n.title)}">
          <div class="slide-num">${i + 1}</div>
          <button class="slide-remove" data-remove-id="${escapeHtml(id)}" aria-label="Treure de la seqüència">×</button>
          <div class="slide-thumb">${imgHtml}</div>
          <div class="slide-title">${escapeHtml(n.title)}</div>
        </div>
      `;
    }).join('');

    // Wire up per-slide click (jumps to the node on the map)
    container.querySelectorAll('.slide').forEach(slideEl => {
      slideEl.addEventListener('click', evt => {
        if (evt.target.closest('.slide-remove')) return;
        selectNodeById(slideEl.dataset.nodeId);
      });
    });
    container.querySelectorAll('.slide-remove').forEach(btn => {
      btn.addEventListener('click', evt => {
        evt.stopPropagation();
        removeFromSequence(btn.dataset.removeId);
      });
    });

    // Drag-and-drop reordering
    let dragIdx = null;
    container.querySelectorAll('.slide').forEach(slideEl => {
      slideEl.addEventListener('dragstart', evt => {
        dragIdx = +slideEl.dataset.idx;
        slideEl.classList.add('slide-dragging');
        evt.dataTransfer.effectAllowed = 'move';
      });
      slideEl.addEventListener('dragend', () => {
        slideEl.classList.remove('slide-dragging');
      });
      slideEl.addEventListener('dragover', evt => {
        evt.preventDefault();
        evt.dataTransfer.dropEffect = 'move';
      });
      slideEl.addEventListener('drop', evt => {
        evt.preventDefault();
        if (dragIdx === null) return;
        const targetIdx = +slideEl.dataset.idx;
        if (targetIdx === dragIdx) return;
        const [moved] = presSequence.splice(dragIdx, 1);
        presSequence.splice(targetIdx, 0, moved);
        persistPresSequence();
        renderSlides();
        dragIdx = null;
      });
    });
  }

  // ----- Play mode -----
  function startPresentation() {
    if (presSequence.length === 0) return;
    presCurrentIdx = 0;
    setPresentationMode('play');
    showSlide(0);
  }

  function showSlide(idx) {
    const id = presSequence[idx];
    const n = nodeById[id];
    if (!n) return;

    const imgEl = document.getElementById('pres-img');
    const captionEl = document.getElementById('pres-caption');
    const detailsEl = document.getElementById('pres-details');
    const counterEl = document.getElementById('pres-counter');

    counterEl.textContent = `${idx + 1} / ${presSequence.length}`;

    if (n.imageLarge) {
      imgEl.src = n.imageLarge;
      imgEl.alt = n.title;
      imgEl.style.display = '';
    } else {
      imgEl.style.display = 'none';
    }

    captionEl.innerHTML = [
      escapeHtml(n.imageStrategy || ''),
      escapeHtml(n.imageCredit || ''),
      n.imageLicense ? escapeHtml(n.imageLicense) : '',
      n.imageWikiPage ? `<a href="${escapeHtml(n.imageWikiPage)}" target="_blank" rel="noopener">Commons</a>` : ''
    ].filter(Boolean).join(' · ');

    detailsEl.innerHTML = buildDetailHtml(n, /*includeImage*/false);

    document.getElementById('pres-prev').disabled = (idx === 0);
    document.getElementById('pres-next').disabled = (idx === presSequence.length - 1);
  }

  function navSlide(delta) {
    const next = presCurrentIdx + delta;
    if (next < 0 || next >= presSequence.length) return;
    presCurrentIdx = next;
    showSlide(presCurrentIdx);
  }

  function exitPlay() {
    setPresentationMode('prep');
  }

  // ----- Import / Export -----
  function exportSession() {
    if (presSequence.length === 0) return;
    const data = {
      version: '1.0',
      app: 'Art Map',
      created: new Date().toISOString(),
      description: `Seqüència de presentació amb ${presSequence.length} obres`,
      sequence: presSequence.map(id => {
        const n = nodeById[id] || {};
        return { id, title: n.title || null, author: n.author || null };
      })
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `artmap-session-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importSession() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!Array.isArray(data.sequence)) throw new Error('JSON sense camp sequence');
        const ids = data.sequence
          .map(entry => typeof entry === 'string' ? entry : entry?.id)
          .filter(id => id && nodeById[id]);
        if (ids.length === 0) {
          alert('El fitxer no conté cap obra que coincideixi amb els ids actuals del mapa.');
          return;
        }
        const dropped = data.sequence.length - ids.length;
        presSequence = ids;
        presCurrentIdx = 0;
        persistPresSequence();
        renderSlides();
        const msg = dropped > 0
          ? `Carregades ${ids.length} obres (${dropped} entrades ignorades per ids desconeguts).`
          : `Carregades ${ids.length} obres.`;
        alert(msg);
      } catch (e) {
        alert(`Error llegint el fitxer: ${e.message}`);
      }
    });
    input.click();
  }

  // ----- Wire up buttons -----
  document.getElementById('presentation-toggle').addEventListener('click', togglePresentationMode);
  document.getElementById('exit-prep').addEventListener('click', () => setPresentationMode('off'));
  document.getElementById('start-presentation').addEventListener('click', startPresentation);
  document.getElementById('clear-session').addEventListener('click', clearSequence);
  document.getElementById('export-session').addEventListener('click', exportSession);
  document.getElementById('import-session').addEventListener('click', importSession);
  document.getElementById('pres-exit').addEventListener('click', exitPlay);
  document.getElementById('pres-prev').addEventListener('click', () => navSlide(-1));
  document.getElementById('pres-next').addEventListener('click', () => navSlide(1));

  // "+ Afegir" button inside renderNodeDetail: event delegation covers dynamic buttons
  document.addEventListener('click', evt => {
    const btn = evt.target.closest('.btn-add-to-pres');
    if (btn && btn.dataset.nodeId) {
      addToSequence(btn.dataset.nodeId);
    }
  });

  // "🔗 Copiar enllaç" button: puts the deep-link URL on the clipboard
  document.addEventListener('click', async evt => {
    const btn = evt.target.closest('.btn-copy-link');
    if (!btn || !btn.dataset.nodeId) return;
    const url = `${location.origin}${location.pathname}#node/${encodeURIComponent(btn.dataset.nodeId)}`;
    try {
      await navigator.clipboard.writeText(url);
      const original = btn.textContent;
      btn.textContent = '✓ Copiat';
      btn.classList.add('copy-ok');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('copy-ok');
      }, 1400);
    } catch {
      // Fallback: prompt the user to copy manually
      prompt('Copia aquest enllaç:', url);
    }
  });

  // --- Help modal ---
  const helpModal = document.getElementById('help-modal');
  function openHelp() {
    helpModal.classList.remove('help-hidden');
    helpModal.setAttribute('aria-hidden', 'false');
  }
  function closeHelp() {
    helpModal.classList.add('help-hidden');
    helpModal.setAttribute('aria-hidden', 'true');
  }
  document.getElementById('help-toggle').addEventListener('click', openHelp);
  document.getElementById('help-close').addEventListener('click', closeHelp);
  helpModal.addEventListener('click', evt => {
    if (evt.target === helpModal) closeHelp();  // backdrop click
  });
  document.addEventListener('keydown', evt => {
    if (evt.key === 'Escape' && !helpModal.classList.contains('help-hidden')) {
      evt.preventDefault();
      closeHelp();
    }
  });

  // --- Lightning tip: copy + lazy QR ---
  const tipCopyBtn = document.getElementById('tip-copy');
  const tipAddrEl  = document.getElementById('tip-addr');
  if (tipCopyBtn && tipAddrEl) {
    tipCopyBtn.addEventListener('click', async () => {
      const addr = tipAddrEl.textContent.trim();
      try {
        await navigator.clipboard.writeText(addr);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = addr;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
      }
      tipCopyBtn.textContent = 'Copiat!';
      tipCopyBtn.classList.add('is-copied');
      setTimeout(() => {
        tipCopyBtn.textContent = 'Copiar';
        tipCopyBtn.classList.remove('is-copied');
      }, 2000);
    });
  }

  const tipQrDetails = document.getElementById('tip-qr');
  const tipQrCanvas  = document.getElementById('tip-qr-canvas');
  let tipQrRendered = false;
  function renderTipQR() {
    if (tipQrRendered || !tipQrCanvas || !tipAddrEl) return;
    const addr = tipAddrEl.textContent.trim();
    const doRender = () => {
      if (typeof window.QRCode === 'undefined') {
        tipQrCanvas.innerHTML = '<span class="tip-box__qr-msg">No s\'ha pogut carregar el QR</span>';
        return;
      }
      tipQrCanvas.innerHTML = '';
      try {
        new window.QRCode(tipQrCanvas, {
          text: 'lightning:' + addr,
          width: 168, height: 168,
          colorDark: '#000', colorLight: '#fff',
          correctLevel: window.QRCode.CorrectLevel.M,
        });
        tipQrRendered = true;
      } catch {
        tipQrCanvas.innerHTML = '<span class="tip-box__qr-msg">Error generant el QR</span>';
      }
    };
    if (typeof window.QRCode !== 'undefined') { doRender(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload  = doRender;
    s.onerror = () => {
      tipQrCanvas.innerHTML = '<span class="tip-box__qr-msg">No s\'ha pogut carregar el QR</span>';
    };
    document.head.appendChild(s);
  }
  if (tipQrDetails) {
    tipQrDetails.addEventListener('toggle', () => {
      if (tipQrDetails.open) renderTipQR();
    });
  }

  // Play-mode keyboard navigation
  document.addEventListener('keydown', evt => {
    if (presentationMode !== 'play') return;
    if (evt.key === 'ArrowLeft') { evt.preventDefault(); navSlide(-1); }
    else if (evt.key === 'ArrowRight' || evt.key === ' ') { evt.preventDefault(); navSlide(1); }
    else if (evt.key === 'Escape') { evt.preventDefault(); exitPlay(); }
    else if (evt.key === 'Home') { evt.preventDefault(); presCurrentIdx = 0; showSlide(0); }
    else if (evt.key === 'End')  { evt.preventDefault(); presCurrentIdx = presSequence.length - 1; showSlide(presCurrentIdx); }
  });
})();
