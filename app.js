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

  // Filter UI
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

  const cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    layout: initialLayout,
    minZoom: 0.2,
    maxZoom: 3,
    wheelSensitivity: 0.25,
    pixelRatio: 'auto',         // match devicePixelRatio → no blur on high-DPI / retina
    textureOnViewport: false,   // don't rasterize during pan/zoom; keeps text crisp when moving
    motionBlur: false,
    hideEdgesOnViewport: false,
    style: [
      // Base: used by secondary nodes at rest (dim, small, label hidden)
      {
        selector: 'node',
        style: {
          'label': 'data(label)',
          'text-wrap': 'wrap',
          'text-max-width': 110,
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 5,
          'font-size': 8,
          'font-family': 'Georgia, serif',
          'color': '#2a2a2a',
          'background-color': '#c4bdae',
          'border-width': 0,
          'width': 20,
          'height': 20,
          'opacity': 0.5,
          'text-opacity': 0,
          'transition-property': 'background-color border-color border-width opacity text-opacity width height background-image-opacity',
          'transition-duration': '0.2s',
          'transition-timing-function': 'ease-in-out'
        }
      },
      // Canonical without image (5 copyright cases): full weight, black+gold
      {
        selector: 'node.canonical',
        style: {
          'background-color': '#1c1917',
          'border-color': '#d4a743',
          'border-width': 3,
          'width': 50,
          'height': 50,
          'font-weight': 'bold',
          'font-size': 9,
          'opacity': 1,
          'text-opacity': 1
        }
      },
      // Any node with image: common background settings
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
      // Canonical with image: dominant — big, bright gold border
      {
        selector: 'node[thumbUrl].canonical',
        style: {
          'width': 66,
          'height': 66,
          'border-width': 4,
          'border-color': '#d4a743',
          'opacity': 1,
          'text-opacity': 1
        }
      },
      // Secondary with image: clearly smaller, thin muted border, translucent
      {
        selector: 'node[thumbUrl].secondary',
        style: {
          'width': 30,
          'height': 30,
          'border-width': 1,
          'border-color': '#a39d92',
          'opacity': 0.8,
          'text-opacity': 0
        }
      },
      // Edges at rest: very subtle, no arrowhead — don't fight for attention
      {
        selector: 'edge',
        style: {
          'curve-style': 'bezier',
          'line-color': 'data(color)',
          'target-arrow-color': 'data(color)',
          'target-arrow-shape': 'none',
          'arrow-scale': 1.1,
          'width': 0.9,
          'opacity': 0.22,
          'transition-property': 'opacity width line-color',
          'transition-duration': '0.2s',
          'transition-timing-function': 'ease-in-out'
        }
      },
      // Focused (hovered/pinned) node: full weight + grows slightly
      {
        selector: 'node.highlighted',
        style: {
          'opacity': 1,
          'text-opacity': 1
        }
      },
      // Secondary node highlighted: grows from 20 → 30, gets color
      {
        selector: 'node.highlighted.secondary',
        style: {
          'background-color': '#6b6458',
          'width': 30,
          'height': 30,
          'border-width': 1.5,
          'border-color': '#4a4639'
        }
      },
      // Canonical (no image) highlighted: grows from 50 → 58, brighter gold
      {
        selector: 'node.highlighted.canonical',
        style: {
          'width': 58,
          'height': 58,
          'border-width': 4,
          'border-color': '#e6bb58'
        }
      },
      // Canonical WITH image highlighted: grows from 66 → 80, bold gold border
      {
        selector: 'node.highlighted[thumbUrl].canonical',
        style: {
          'width': 80,
          'height': 80,
          'border-width': 5,
          'border-color': '#e6bb58'
        }
      },
      // Secondary WITH image highlighted: grows from 30 → 46, darker border
      {
        selector: 'node.highlighted[thumbUrl].secondary',
        style: {
          'width': 46,
          'height': 46,
          'border-width': 1.5,
          'border-color': '#4a4639'
        }
      },
      // Focused edge: fully visible, arrow on, wider, on top
      {
        selector: 'edge.highlighted',
        style: {
          'opacity': 0.9,
          'width': 2.6,
          'target-arrow-shape': 'triangle',
          'z-index': 20
        }
      },
      // Ghosted (everything not in focus)
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
          'width': 0.5
        }
      },
      {
        selector: 'node:selected',
        style: {
          'border-color': '#dc2626',
          'border-width': 4
        }
      },
      {
        selector: 'edge:selected',
        style: { 'width': 4, 'opacity': 1 }
      },
      {
        selector: '.hidden',
        style: { 'display': 'none' }
      }
    ]
  });

  cy.fit(undefined, 50);
  // Initial layout with animate:false runs synchronously; start bubble motion now
  startBubbleMotion();

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
  document.getElementById('toggle-secondary').addEventListener('change', updateVisibility);

  function updateVisibility() {
    const activeTypes = new Set(
      [...filtersEl.querySelectorAll('input:checked')].map(cb => cb.dataset.type)
    );
    const showSecondary = document.getElementById('toggle-secondary').checked;

    cy.edges().forEach(edge => {
      edge.toggleClass('hidden', !activeTypes.has(edge.data('type')));
    });
    cy.nodes().forEach(node => {
      const isSecondary = !node.hasClass('canonical');
      node.toggleClass('hidden', !showSecondary && isSecondary);
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
    pinned = true;
    pinnedNodeId = node.id();
    applyFocus(node.closedNeighborhood());
    renderNodeDetail(nodeById[node.id()]);
    setHashFor(node.id());
    openDetailIfMobile();
    closeControlsIfMobile();
    centerOnNode(node);
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
  function centerOnNode(node) {
    if (!node || node.empty()) return;
    const hood = node.closedNeighborhood();
    const bbox = hood.boundingBox();

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
    const targetZoom = Math.min(Math.max(Math.min(fitZoomX, fitZoomY), 0.55), 1.6);

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
        <button class="node-action btn-print-single" data-node-id="${escapeHtml(n.id)}" title="Genera un PDF només amb aquesta fitxa">📄 Exportar fitxa (PDF)</button>
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
})();
