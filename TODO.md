# TODO · Art Map

## Pendent

### Funcionalitats

- [x] ~~**Interpolació de transicions in-flight**~~ Mitigat 2026-04-19 amb *debounce* del hover: `mouseover` i `mouseout` esperen 40 ms (entrada) i 60 ms (sortida) abans d'aplicar/esborrar el focus. Els desplaçaments llargs ja no acumulen 8-10 salts; només aplica focus quan el cursor s'atura sobre un node. No és una interpolació real (Cytoscape segueix "saltant" en canvis de classe mid-animation) però elimina el cas patològic. Si es torna a detectar el salt en patrons d'ús específic, caldrà migrar la capa de ghost/highlight a un overlay CSS fora de Cytoscape.

- [ ] **Durada de transicions a 400-500 ms**: pendent de verificar si amb el *debounce* anterior es pot pujar ja sense que es notin els talls. Provar i ajustar.

- [x] ~~**Favicon + metadades d'app**~~ Fet 2026-04-19: `favicon.svg` amb el glifo de xarxa (dos nodes canònics + un secundari units per arestes) a l'arrel. `theme-color`, descripció, Open Graph i Twitter Card al `<head>`. Pendent: versions PNG 192×192 i 512×512 i un webmanifest si es vol "installable" com a PWA.

- [x] ~~**Centrar la vista al node seleccionat**~~ Fet 2026-04-19: `centerOnNode()` s'invoca tant en clic com en deep link. Calcula pan mitjançant `cy.pan()/zoom()` per deixar el node al centre del viewport (desktop) o al 18% superior (mòbil, amb el bottom sheet ocupant el 70% inferior). Animació de 400 ms ease-in-out.

- [ ] **Hotspots sobre les imatges**. Marcar punts d'interès (coordenades H-V relatives a la imatge) amb text associat per guiar l'atenció dels alumnes a detalls concrets (p. ex., la mà pudorosa de la Venus de Cnido, el mirall dels Arnolfini, la bombeta del Guernica, la criada negra de l'Olímpia).
    - Requerirà un mode "admin" a la interfície per dibuixar i editar els punts in situ
    - Extensió del JSON per node: `hotspots: [{ x, y, title, description, zoom? }]` (x,y entre 0 i 1 respecte a la imatge)
    - Vista detall: clic sobre un hotspot → zoom + panell lateral amb la descripció
    - Mode fullscreen: hotspots sempre visibles com a punts petits, clicables

- [ ] **Ampliar el graf de nodes secundaris** (nodes pont). Ara només n'hi ha 4. Objectiu: 30-50 obres pont ben triades que enriqueixin el relat entre les canòniques.
    - Definir 8-10 eixos temàtics (cos clàssic, arquitectura sacra, narrativa política, ruptures XIX-XX, mística, retrat i poder, etc.)
    - Per cada eix, identificar els ponts que falten (obres que expliquen transicions o que emmarquen canòniques isolades)
    - Decidir metodologia: proposta manual pedagògica vs. agent automatitzat vs. híbrid

- [ ] **Exportació de fitxa de repàs per node** (PDF imprimible). Per a l'última setmana abans de les PAU.

- [x] ~~**Descàrrega local de les imatges** a `img/` per independitzar-nos de Wikimedia i funcionar offline.~~ Fet el 2026-04-19 via `scripts/download_images.py`: 50 obres descarregades a 1280px (20 MB totals). `data/images.json` apunta a `local_url`; l'app.js cau a Wikimedia només si el fitxer local no hi és.

- [x] ~~**Cerca de nodes** en calent per títol, autor, període i tema.~~ Implementada 2026-04-19: barra de cerca al panell de controls; cada pulsació destaca els nodes coincidents i les arestes entre ells, fa fade de la resta. Esc esborra la cerca.

- [ ] **Filtres addicionals**: per període i per tema transversal (ara només per tipus de connexió).

- [x] ~~**Persistència del layout**~~ Implementada 2026-04-19 via `localStorage` (`artmap.positions.v2`). Les posicions base es desen després del layout inicial, després de cada drag, i després de *Reordena*. El botó *Reordena* neteja la memòria i genera una nova disposició que també es desa.

- [x] ~~**Deep linking per URL**~~ Implementat 2026-04-19. Format `#node/<id>` (p. ex., `https://aaronfortuno.github.io/art-map/#node/venus-botticelli`). Obre la fitxa, fixa el node i hi centra la vista amb animació. `history.replaceState` evita contaminar l'historial; `hashchange` gestiona navegació back/forward. El hash es neteja en clicar al fons o en seleccionar una aresta.

- [x] ~~**Responsive / mode tableta**~~ Primera iteració feta 2026-04-19: breakpoint a 1200 px (columnes més estretes) i a 900 px (graf a pantalla completa; controls com a drawer esquerre via botó hamburguesa; detall com a bottom sheet que s'obre auto en clicar node/aresta; *backdrop* semitransparent amb clic per tancar). Fullscreen modal també s'apila verticalment en pantalles petites. Falta testar a iPad/Chromebook reals i polir detalls (possiblement mida de fonts al graf).

- [ ] **Navegació per teclat**: Tab entre nodes canònics, Enter per fixar, fletxes per moure's entre veïns.

- [ ] **Export de fitxa PDF per node**: Ctrl+P dins un mode de impressió que renderitzi només la fitxa seleccionada.

- [ ] **Mode "presentació"**: pantalla projectada amb controls simplificats, fonts grans, navegació només per clic sense arrossegar.

### Contingut

- [ ] **Afegir imatges als 42 nodes secundaris** (ara es veuen com a bombolles grises sense imatge). Podem reutilitzar el script `scripts/download_images.py` adaptat, o delegar-ho a un agent com vam fer amb els 50 canònics.

- [x] ~~**Integrar les alternatives d'imatge per a les 5 sota copyright**~~ Fet el 2026-04-19 via `scripts/download_copyright_alternatives.py`: 4 amb llicència lliure (Guernica mural ceràmic CC BY, Pollock in-situ a NGA CC BY-SA, Kahlo retrat PD, Abramović CC BY) + Viola amb retrat contextual. Cada node canònic afectat té `image_strategy` i `image_caveat` visibles al panell i al fullscreen.

- [ ] **Enriquir l'anàlisi** (context, formal, significat, funció) per a cada una de les 55 obres. Ara la majoria tenen només resum breu; el clúster Venus té l'anàlisi completa com a plantilla.

- [ ] **Revisar les connexions**. La primera versió té ~84 arestes fetes de memòria/raonament. Revisar-les pedagògicament: són correctes? En falten? N'hi ha de discutibles?

- [ ] **Afegir preguntes contrafactuals** més elaborades per obra, també com a material d'avaluació.

### Tècnic

- [ ] **Layout "per cronologia"**: toggle que passi de `cose` (força-dirigit) a un preset amb X per any. Útil per visualitzar l'eix temporal.

- [ ] **Sort/highlight per període o tema**: en hover a una pastilla de període/tema, ressaltar els nodes corresponents al graf.

- [ ] **Millorar tipografia del graf** a mides diferents (mida projectada en classe vs. portàtil).
