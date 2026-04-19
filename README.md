# Art Map

Xarxa interactiva de les **55 obres** del temari d'Història de l'Art de les PAU 2026 (Catalunya), enriquida amb **46 obres pont** secundàries i **177 connexions** classificades en 5 tipus pedagògics: *precedent*, *cita*, *ruptura*, *parentiu* i *eco contemporani*.

Pensat per a **2n de batxillerat**: en comptes d'estudiar les obres aïlladament, es presenten com una xarxa on cada una dialoga amb el seu precedent, els seus ecos posteriors i les obres coetànies. La idea és que l'alumnat construeixi memòria per *relacions*, no per fitxa.

**Demo**: *pendent del desplegament de GitHub Pages* → `https://aaronfortuno.github.io/art-map/`

---

## Característiques

- **101 nodes** (55 canòniques PAU + 46 ponts secundaris), **177 connexions** tipificades
- **Cerca en calent** per títol, autor, període i tema
- **Imatges locals** per a les 55 canòniques (20 MB; 5 amb estratègies alternatives per drets d'autor vigents)
- **Panell lateral** amb fitxa analítica (context, anàlisi formal, significat, funció, preguntes contrafactuals)
- **Mode pantalla completa** amb la imatge grossa i l'anàlisi a banda
- **Hover / click** amb transicions suaus (200 ms)
- **Bombolles subtils** que donen vida al graf sense marejar
- **13 artistes dones** i **4 obres no-occidentals** entre els nodes pont — resposta explícita al mandat de perspectiva de gènere i no-eurocentrisme del Decret 171/2022

## Prova-ho localment

Només cal un servidor estàtic. Amb Python:

```sh
python -m http.server 5174
```

I obre [`http://localhost:5174/`](http://localhost:5174/). No hi ha *build step*: Cytoscape.js es carrega via CDN.

## Estructura del contingut

```
├── index.html · app.js · styles.css    aplicació
├── data/
│   ├── seed.json                       nodes, arestes, períodes, temes
│   ├── images.json                     metadades d'imatges (llicències, caveats)
│   ├── canonical-works.json            llista oficial PAU 2026
│   ├── secondary-proposals.json        propostes per eixos temàtics
│   └── copyright-alternatives.json     estratègies per les 5 obres amb drets
├── img/                                 55 imatges descarregades (NN.jpg)
├── scripts/                             utilitats Python (descàrrega, fusió)
├── curriculum.txt                       Decret 171/2022 (marc curricular)
├── TODO.md                              roadmap pedagògic i tècnic
├── ATTRIBUTIONS.md                      crèdits d'imatges per llicència
└── LICENSE                              MIT (codi)
```

## Com s'estenen els continguts

- **Afegir una obra**: nou node a `data/seed.json` (seguir l'esquema de `nodeSchema`) + arestes cap a nodes existents
- **Afegir una imatge**: a `data/images.json`, registrar-ne la font; executar `scripts/download_images.py`
- **Regenerar atribucions** (si canvien llicències o es canvien imatges): `python scripts/generate_attributions.py`

## Tecnologia

- **Visualització**: [Cytoscape.js](https://js.cytoscape.org/) (via CDN, sense bundler)
- **Backend**: cap, 100% estàtic
- **Scripts**: Python 3 estàndard (`urllib`, `json`, `re`) — no dependències externes

## Llicències

- **Codi** (`app.js`, `index.html`, `styles.css`, `scripts/`): [MIT](./LICENSE)
- **Contingut pedagògic** (anàlisis, connexions, preguntes contrafactuals a `data/seed.json`): [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- **Imatges**: llicències mixtes per fitxer. Detall complet a [`ATTRIBUTIONS.md`](./ATTRIBUTIONS.md). Inclouen obres en domini públic, CC BY, CC BY-SA i una imatge sota excepció educativa ([LPI Art. 32](https://www.boe.es/buscar/act.php?id=BOE-A-1996-8930)) per a l'obra de Bill Viola, les úniques imatges que no tenen llicència totalment lliure corresponen a estratègies alternatives (rèpliques o fotos contextuals) per a les 5 obres canòniques encara sota drets d'autor.

Les analitzades, preguntes i connexions són fruit d'un diàleg iteratiu amb assistents d'IA supervisat pel professor, i es poden reutilitzar i adaptar sota CC BY-SA.

## Estat

Versió **preliminar**. Les 55 canòniques tenen imatge i anàlisi bàsica; les 46 secundàries tenen metadades però encara no imatge. El clúster *Venus* (al voltant de l'obra de Botticelli) té l'anàlisi més desenvolupada com a plantilla. Vegeu [`TODO.md`](./TODO.md) per al *roadmap*.

## Autoria

**Aaron Fortuño** · Catalunya, 2026
