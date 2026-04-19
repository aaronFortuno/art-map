# TODO · Art Map

## Pendent

### Funcionalitats

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

- [ ] **Persistència del layout**: guardar posicions de nodes a localStorage perquè carregades successives mantinguin la mateixa disposició (ara el `cose` re-ordena cada cop, confonent la memòria espacial dels alumnes).

- [ ] **Deep linking per URL**: `#node/venus-botticelli` obri la fitxa de Venus Botticelli automàticament. Útil per compartir enllaços a una obra concreta.

- [ ] **Responsive / mode tableta**: el layout actual de 3 columnes no funciona per sota de ~1100 px. Pensar com col·lapsar el panell de controls i fer el detall com a drawer.

- [ ] **Navegació per teclat**: Tab entre nodes canònics, Enter per fixar, fletxes per moure's entre veïns.

- [ ] **Export de fitxa PDF per node**: Ctrl+P dins un mode de impressió que renderitzi només la fitxa seleccionada.

- [ ] **Mode "presentació"**: pantalla projectada amb controls simplificats, fonts grans, navegació només per clic sense arrossegar.

### Contingut

- [ ] **Afegir imatges als 42 nodes secundaris** (ara es veuen com a bombolles grises sense imatge). Podem reutilitzar el script `scripts/download_images.py` adaptat, o delegar-ho a un agent com vam fer amb els 50 canònics.

- [ ] **Integrar les alternatives d'imatge per a les 5 sota copyright** (fitxer `data/copyright-alternatives.json`). L'agent del 2026-04-19 va trobar: #50 Guernica (mural ceràmic Gernika CC BY), #51 Pollock (foto CC BY-SA a la NGA), #52 Kahlo (**ja és PD a la UE des del 2025-01-01!**), #54 Abramović (foto Zugaldia CC BY), #55 Viola (l'única que necessita excepció educativa LPI Art. 32).

- [ ] **Enriquir l'anàlisi** (context, formal, significat, funció) per a cada una de les 55 obres. Ara la majoria tenen només resum breu; el clúster Venus té l'anàlisi completa com a plantilla.

- [ ] **Revisar les connexions**. La primera versió té ~84 arestes fetes de memòria/raonament. Revisar-les pedagògicament: són correctes? En falten? N'hi ha de discutibles?

- [ ] **Afegir preguntes contrafactuals** més elaborades per obra, també com a material d'avaluació.

### Tècnic

- [ ] **Layout "per cronologia"**: toggle que passi de `cose` (força-dirigit) a un preset amb X per any. Útil per visualitzar l'eix temporal.

- [ ] **Sort/highlight per període o tema**: en hover a una pastilla de període/tema, ressaltar els nodes corresponents al graf.

- [ ] **Millorar tipografia del graf** a mides diferents (mida projectada en classe vs. portàtil).
