(async function () {
  const [data, imagesData] = await Promise.all([
    fetch('data/seed.json').then(r => r.json()),
    fetch('data/images.json').then(r => r.json())
  ]);

  const typeById   = Object.fromEntries(data.connectionTypes.map(t => [t.id, t]));
  const themeById  = Object.fromEntries(data.themes.map(t => [t.id, t]));
  const periodById = Object.fromEntries(data.periods.map(p => [p.id, p]));

  // Index images by canonical number
  const imageByIndex = {};
  imagesData.works.forEach(w => {
    if (!w.image_missing && w.image_url) imageByIndex[w.canonicalIndex] = w;
  });

  // Enrich nodes with image URLs. Prefer locally-downloaded copies; fall back
  // to Wikimedia Special:FilePath (avoids the direct /thumb/ 429 rejections).
  data.nodes.forEach(n => {
    if (n.canonicalIndex && imageByIndex[n.canonicalIndex]) {
      const img = imageByIndex[n.canonicalIndex];
      if (img.local_url) {
        n.imageThumb = img.local_url;   // same-origin, no CORS, no Wikimedia policy concerns
        n.imageLarge = img.local_url;
      } else {
        n.imageThumb = ensureDirectThumb(img.image_url, 800);
        n.imageLarge = wikimediaResize(img.image_url, 1600);
      }
      n.imageCredit   = img.credit;
      n.imageLicense  = img.license;
      n.imageWikiPage = img.wikimedia_file_page;
      n.imageStrategy = img.image_strategy || null;
      n.imageCaveat   = img.image_caveat || null;
    }
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

  // Build Cytoscape elements
  const elements = [];
  data.nodes.forEach(n => {
    const d = { id: n.id, label: n.title };
    if (n.canonical)  d.canonical = true;
    if (n.imageThumb) d.thumbUrl = n.imageThumb;
    elements.push({ group: 'nodes', data: d });
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

  function loadSavedPositions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function clearSavedPositions() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }

  const savedPositions = loadSavedPositions();
  // Only use saved positions if every current node has a saved entry —
  // otherwise fall back to cose (e.g., after new nodes were added to seed.json).
  const usingSavedLayout = !!savedPositions && data.nodes.every(n => savedPositions[n.id]);

  const cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    layout: usingSavedLayout
      ? { name: 'preset', positions: (node) => savedPositions[node.id()] || { x: 0, y: 0 }, fit: true, padding: 50 }
      : buildLayout(false),
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
        selector: 'node[canonical]',
        style: {
          'background-color': '#1c1917',
          'border-color': '#b8860b',
          'border-width': 2,
          'width': 46,
          'height': 46,
          'font-weight': 'bold',
          'font-size': 9,
          'opacity': 1,
          'text-opacity': 1
        }
      },
      // Canonical with image: larger, image as background
      {
        selector: 'node[thumbUrl]',
        style: {
          'background-image': 'data(thumbUrl)',
          'background-image-crossorigin': 'anonymous',
          'background-fit': 'cover',
          'background-image-opacity': 1,
          'background-clip': 'node',
          'background-color': '#1c1917',
          'width': 62,
          'height': 62,
          'border-width': 3,
          'border-color': '#b8860b',
          'opacity': 1,
          'text-opacity': 1
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
      // Secondary node highlighted: grows from 20 → 32, gets color
      {
        selector: 'node.highlighted:not([canonical])',
        style: {
          'background-color': '#6b6458',
          'width': 32,
          'height': 32,
          'border-width': 1.5,
          'border-color': '#4a4639'
        }
      },
      // Canonical (no image) highlighted: grows from 46 → 56
      {
        selector: 'node.highlighted[canonical]',
        style: {
          'width': 56,
          'height': 56,
          'border-width': 3
        }
      },
      // Canonical WITH image highlighted: grows from 62 → 76 (overrides [canonical])
      {
        selector: 'node.highlighted[thumbUrl]',
        style: {
          'width': 76,
          'height': 76,
          'border-width': 4
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

  // Persist the positions (base, not oscillating) from bubbleState
  function savePositions() {
    try {
      const pos = {};
      bubbleState.forEach((s, id) => { pos[id] = { x: s.baseX, y: s.baseY }; });
      if (Object.keys(pos).length > 0) localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
    } catch {}
  }
  savePositions();

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
      const isSecondary = !node.data('canonical');
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

  // Hover: transient preview (no detail panel change)
  cy.on('mouseover', 'node', evt => {
    if (pinned || searchActive) return;
    applyFocus(evt.target.closedNeighborhood());
  });
  cy.on('mouseout', 'node', () => {
    if (pinned || searchActive) return;
    clearFocus();
  });

  cy.on('mouseover', 'edge', evt => {
    if (pinned || searchActive) return;
    const edge = evt.target;
    applyFocus(edge.union(edge.connectedNodes()));
  });
  cy.on('mouseout', 'edge', () => {
    if (pinned || searchActive) return;
    clearFocus();
  });

  // Click: pin focus + populate detail panel + reflect state in URL
  cy.on('tap', 'node', evt => {
    const node = evt.target;
    pinned = true;
    pinnedNodeId = node.id();
    applyFocus(node.closedNeighborhood());
    renderNodeDetail(nodeById[node.id()]);
    setHashFor(node.id());
  });

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
    const node = cy.getElementById(id);
    if (node.empty()) return;
    pinned = true;
    pinnedNodeId = id;
    applyFocus(node.closedNeighborhood());
    renderNodeDetail(nodeById[id]);
    try {
      cy.animate({ center: { eles: node } }, { duration: 400, easing: 'ease-in-out' });
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
  document.getElementById('relayout-btn').addEventListener('click', () => {
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
  }

  function renderEdgeDetail({ type, note, color, src, tgt }) {
    const t = typeById[type];
    const srcImg = src.imageThumb
      ? `<img class="edge-thumb" src="${escapeHtml(src.imageThumb)}" alt="${escapeHtml(src.title)}" loading="lazy">`
      : '';
    const tgtImg = tgt.imageThumb
      ? `<img class="edge-thumb" src="${escapeHtml(tgt.imageThumb)}" alt="${escapeHtml(tgt.title)}" loading="lazy">`
      : '';

    document.getElementById('detail').innerHTML = `
      <div class="edge-header">
        <div class="edge-work">
          ${srcImg}
          <div><strong>${escapeHtml(src.title)}</strong><br><span class="small">${escapeHtml(src.author || '')} · ${escapeHtml(src.yearLabel || src.year)}</span></div>
        </div>
        <div class="edge-arrow" style="color:${color}">→</div>
        <div class="edge-work">
          ${tgtImg}
          <div><strong>${escapeHtml(tgt.title)}</strong><br><span class="small">${escapeHtml(tgt.author || '')} · ${escapeHtml(tgt.yearLabel || tgt.year)}</span></div>
        </div>
      </div>
      <div class="author" style="margin-top: 0.8rem;">Connexió: <strong>${escapeHtml(t.label)}</strong></div>
      <div class="meta" style="font-size: 0.85rem; font-style: italic;">${escapeHtml(t.description)}</div>
      <div class="edge-note" style="border-left-color:${color}">${escapeHtml(note)}</div>
    `;
  }
})();
