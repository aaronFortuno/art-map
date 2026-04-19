# TODO · Art Map

Estat al 2026-04-19. Les 101 fitxes tenen imatge + anàlisi desenvolupada + connexions; el mapa interactiu té cerca, filtres per tipus de connexió, fullscreen, deep linking, layout persistent, mode cronologia, exportació a PDF i blooming al clicar. Queda un conjunt de millores d'usabilitat, contingut i polish.

## Funcionalitats

### Interacció

- [ ] **Reintentar hover-bloom + separació horitzontal al mode cronologia**. Primer intent revertit (commit `047bde3`) per un conflicte entre `node.animate` i el tick de bombolles que feia invisibles els blooms i posava el node "sticky" al ratolí. L'enfocament alternatiu: animar el *bubble base* amb el propi rAF del tick (interpolació progressiva de `baseX`/`baseY`) enlloc d'usar `node.animate`. Sense cyre-escriptura cruada, sense `animatingNodes` set.

- [ ] **Durada de transicions a 400-500 ms**: actualment a 200 ms perquè els talls in-flight es notaven menys. Amb el *debounce* del hover (40/60 ms) probablement ja es pot pujar. Provar i ajustar.

- [ ] **Navegació per teclat**: Tab entre canòniques, Enter per fixar, fletxes per moure's entre veïns, `/` per focus a la cerca. Important per accessibilitat.

- [ ] **Filtres addicionals**: per període i per tema transversal (ara només per tipus de connexió). Implementar com a secció plegable al panell de controls amb *checkboxes*.

- [ ] **Hover a pastilla de període/tema**: ressaltar al graf els nodes corresponents, com un filtre temporal. Complementari al punt anterior.

### Feature gran

- [ ] **Hotspots sobre les imatges**. Marcar punts d'interès (coordenades relatives a la imatge) amb text associat per guiar l'atenció a detalls concrets (la mà pudorosa de Venus de Cnido, el mirall dels Arnolfini, la bombeta del Guernica, la criada Laure a l'Olímpia).
    - Requereix un mode "admin" a la interfície per dibuixar i editar els punts *in situ*
    - Extensió del JSON per node: `hotspots: [{ x, y, title, description, zoom? }]` (x,y entre 0 i 1)
    - Vista detall: clic al hotspot → zoom + text emergent
    - Mode fullscreen: hotspots sempre visibles com a punts clicables

- [ ] **Mode "presentació"**: pantalla projectada amb controls simplificats, fonts del graf més grans, navegació només per clic, bloom més marcat. Per a projector a classe.

## Contingut

- [ ] **Revisar les connexions** (177 arestes) pedagògicament. Primera versió mig automatitzada: revisar-les una per una. Són correctes? En falten? N'hi ha de discutibles? El professorat és qui pot validar-ho.

- [ ] **Revisar decisions editorials del clúster Venus** (flags de l'agent 2026-04-19):
    - Olímpia: lectura colonial de Laure (la criada negra) — mantenir / suavitzar / treure?
    - Dànae: *pluja d'or* com "literalment, diner" — mantenir / suavitzar?
    - Olímpia: espectador del Saló com "la posició del client" — mantenir / neutralitzar?
    - Sherman: vocabulari concret ("pròtesis, pits postissos, làtex") — mantenir / abstreure?

## Tècnic / polish

- [ ] **Tipografia del graf a mides diferents**: les etiquetes són actualment 8 px i es veuen bé en portàtil però poc llegibles en projector. Caldria una opció de "mode presentació" (ja llistat) o un slider de mida.

- [ ] **Favicon PNG fallback (192×192, 512×512) + webmanifest**: per tenir-ho *installable* com a PWA des del mòbil amb icona i tema.

- [ ] **Image download resiliency**: la política anti-bot de Wikimedia tira 429s periòdicament. El nostre script té *retry* bàsic. Si tornem a fer passades massives (afegir més nodes), seria bo un retry-amb-backoff més robust al `scripts/download_*.py`.

## Idees per al futur (no urgent)

- Mode colaboratiu (professorat contribueix a seed.json via PR o mini-API)
- Integració amb Google Classroom (enllaç de fitxa, quiz generat)
- Versions en altres llengües (castellà, anglès) — seed.json amb camps `title_es`, etc.
- Estadístiques d'ús (quines obres consulten més els alumnes)
