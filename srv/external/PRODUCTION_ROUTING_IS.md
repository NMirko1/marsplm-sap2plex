# Production Routing via SAP Integration Suite — analisi di migrazione

Analisi delle modifiche necessarie per spostare le letture **Production Routing** dal gateway OData on-premise agli **iFlow di SAP Integration Suite esposti come OData API**.

Fonte endpoint: `EndpointFlussiMARS.xlsx`, colonna G *Path Iflow SAP IS*, righe 2–8. Il file è escluso da git (`.gitignore` → `*.xlsx`): **questo documento è la fonte di verità versionata**.

> **Perimetro**: solo le letture **GET/QUERY del Production Routing usate dalla dashboard**. Product e Production Order (righe 9–16 del foglio) hanno lo stesso split e sono trattati in §10.
>
> **Stato**: analisi. Nessuna modifica a codice o configurazione.

Host runtime:

| Ambiente | Host |
|---|---|
| Test | `https://sd-integration-suite-dev-test-cf.it-cpi024-rt.cfapps.eu10-002.hana.ondemand.com` |
| Prod | `https://sd-integration-suite-prod-cf.it-cpi024-rt.cfapps.eu10-002.hana.ondemand.com` |

---

## 1. Sommario

Oggi tutto il routing passa da **una sola** entry `cds.requires` (`sap_s4_OP_API_PRODUCTION_ROUTING_0003_v3` → destination `MARS_SAP_CON`, path `/sap/opu/odata/sap/API_PRODUCTION_ROUTING;v=0003`), consumata in **17 punti** fra `srv/cat-service.js` e `jobs/syncRoutingsToPlex.js`.

Con SPCI ogni coppia (entity, operazione) ha il **proprio service root** `https://<host>/gw/odata/SAP/<NOME_IFLOW>;v=1`: 7 service root per 5 entity. In CAP il prefisso di path è **statico per istanza di servizio**, quindi 7 service root ⇒ 7 istanze. Ma le istanze possono **condividere un solo modello CSN** (§5), quindi la migrazione non richiede 7 modelli.

`ProductionRoutingOperation` e `ProductionRoutingCompAlloc` sono esposte **solo come GET**, per design: sono child collection della routing — si passa la routing e si ottengono tutte le sue operazioni / tutti i suoi componenti. CAP sa esprimere questa forma; servono due accorgimenti non ovvi (§4).

> **Superato il 17/08/2026, ed è la conclusione più importante di questo documento.** Quella forma **non
> esiste**: un service root `_GET` non restituisce una child collection, perché una read-by-key OData è
> tipizzata per serializzare una sola entry — risponde `200` con una riga e `500` con due o più. I due
> «accorgimenti non ovvi» del §4 servivano a costruire una richiesta che l'indirizzo non poteva soddisfare.
> Entrambe le entity leggono ora da un `…_QUERYGET;v=1`, in collection + `$filter` su gruppo e ciclo: vedi
> [DEC-44](../../docs/DECISIONI.md) e [DEC-45](../../docs/DECISIONI.md), contratti E-17 ed E-18. Il §4 resta
> come cronaca di come ci si è arrivati, non come istruzione.

| # | Tema | Esito |
|---|---|---|
| D1 | Split 7 service root | **Assunto come dato.** Nessuna richiesta di consolidamento |
| D2 | `_GET` per le child collection | **Praticabile.** 5 dei 6 punti coperti; serve `delete q.SELECT.one` (§4.2) |
| D3 | Unico punto non esprimibile | `cat-service.js:1766`, colonna *Work Center* della lista: richiede la lista di ~100 gruppi (§4.3) |
| D4 | Destination | **1 per ambiente**, URL = host nudo, service root nel `path` del `cds.requires` |
| D5 | Auth | `OAuth2ClientCredentials`, service key `it-rt` piano `integration-flow`, ruolo `ESBMessaging.send` |
| D6 | Cloud Connector | **Resta.** 7 servizi OData su 9 continuano su `MARS_SAP_CON` |
| D7 | Modelli | 7 `$metadata` da scaricare; **1 solo CSN** se nomi entity/campo combaciano — da verificare |
| D8 | Rischio nascosto #1 | Filtri `{in:[…]}` oltre 1028 char → CAP converte in `POST /$batch` **in silenzio** (§6.1) |
| D9 | Rischio nascosto #2 | Zeri iniziali NUMC: un `1` invece di `00000001` **orfanizza i cicli Plex già salvati** (§6.4) |
| D10 | Modifiche al codice | 1 modulo nuovo + **5 righe** di rewiring + 5 letture child da convertire (§7) |

---

## 2. Come cambia l'architettura

**Oggi** — 1 destination, 1 path, 1 istanza, 1 modello:

```
cat-service.js:1670  cds.connect.to('sap_s4_OP_API_PRODUCTION_ROUTING_0003_v3')
                          │
                     MARS_SAP_CON (OnPremise, Cloud Connector)
                     + path /sap/opu/odata/sap/API_PRODUCTION_ROUTING;v=0003
                          │
                     ECC gateway ──> ProductionRoutingHeader
                                     ProductionRoutingOperation
                                     ProductionRoutingCompAlloc
                                     ProductionRoutingMatlAssgmt
```

**Target** — 1 destination, 7 path, 7 istanze, **1 modello**:

```
cat-service.js:1670  routingSource()          <- nuovo modulo srv/lib/routingSource.js
                          │
                     dispatch su (entity, operazione) dal CQN
                          │
        ┌─────────────────┼─────────────────┬──────────────────┐
   HEADER_QUERYGET   MATLASSGMT_QUERYGET  OPERATION_GET   COMPALLOC_GET   ...
        │                 │                  │                │
        └─────────────────┴──────────────────┴────────────────┘
                          │
                     MARS_IS_CON (Internet, OAuth2ClientCredentials)
                          │
                     CPI iFlow ──RFC──> FM ZMARS_* su ECC
```

Il fatto che rende questo economico: `cds.connect.to(name, {credentials:{…, path}})` crea un'istanza **nuova e non cachata** che **condivide `definition` e gli oggetti entity** con la entry base.

Verificato su `@sap/cds` 9.9.2:

```
a = cds.connect.to(BASE, { credentials: { …, path: '…HEADER_QUERYGET;v=1' } })
b = cds.connect.to(BASE, { credentials: { …, path: '…HEADER_GET;v=1'      } })

a === b                                               -> false
a.definition === b.definition                         -> true
a.entities.ProductionRoutingHeader === b.entities…    -> true    <-- decisivo
'sap_s4_…' in cds.services                            -> false   (cache non inquinata)
```

Poiché gli oggetti entity sono **identici** fra le istanze, **il CQN non va mai riscritto**: si cambia solo su quale istanza si chiama `.run()`.

Meccanica del path (`libx/_runtime/remote/`):

| Dove | Codice |
|---|---|
| `Service.js:216` | `this.path = this.options.credentials.path` — letto **una volta** in `init()` |
| `query.js:190` | `if (service.path) requestConfig.url = \`${encodeURI(service.path)}${requestConfig.url}\`` |

`encodeURI` non tocca `;` `=` `.` `_` → `;v=1` passa inalterato. Precedente già in produzione: `path: "/sap/opu/odata/sap/API_PRODUCTION_ROUTING;v=0003"`.

---

## 3. Inventario endpoint (righe 2–8 del foglio)

Prefisso comune: `/gw/odata/SAP/F0491.87_OPERATIONS_SAPECC_SAPBTPMARS_`

| Riga | Entity | Op | Suffisso iFlow | FM ABAP | Stato d'uso |
|---|---|---|---|---|---|
| 2 | `ProductionRouting` | GET | `PRODUCTIONROUTING_GET;v=1` | `ZMARS_ROUTING_GET` | ⚠️ entity **mai letta** dal codice |
| 3 | `ProductionRoutingHeader` | GET | `PRODUCTIONROUTINGHEADER_GET;v=1` | `ZMARS_ROUTING_HEADER_GET` | ⚠️ non utilizzabile (chiavi parziali, §4.4) |
| 4 | `ProductionRoutingHeader` | QUERY | `PRODUCTIONROUTINGHEADER_QUERYGET;v=1` | idem | ✅ **6 chiamate** |
| 5 | `ProductionRoutingMatlAssgmt` | QUERY | `PRODUCTIONROUTINGMATLASSGMT_QUERYGET;v=1` | `ZMARS_ROUTING_MATL_ASSGMT_GET` | ✅ **5 chiamate** |
| 6 | `ProductionRoutingMatlAssgmt` | GET | `PRODUCTIONROUTINGMATLASSGMT_GET;v=1` | idem | ⚠️ non utilizzabile (chiavi parziali) |
| 7 | `ProductionRoutingCompAlloc` | ~~GET~~ | ~~`PRODUCTIONROUTINGCOMPALLOC_GET;v=1`~~ | `ZMARS_ROUTING_COMP_ALLOC_GET` | **ritirato il 17/08/2026** → `…_QUERYGET;v=1`, collection + `$filter` (DEC-44). Sempre 3 chiamate |
| 8 | `ProductionRoutingOperation` | ~~GET~~ | ~~`PRODUCTIONROUTINGOPERATION_GET;v=1`~~ | — | **ritirato il 17/08/2026** → `…_QUERYGET;v=1`, collection + `$filter` (DEC-45). Sempre 2 chiamate + 1 problematica (§4.3) |

### 3.1 Anomalie del foglio da correggere

| # | Riga | Problema | Impatto |
|---|---|---|---|
| A1 | 3 | Path **senza `/` iniziale** (`gw/odata/SAP/…`) | CAP concatena `service.path` così com'è, non normalizza → URL malformato |
| A2 | 8 | Colonna *Entity* dice `ProductionRoutingCompAlloc` e *FM* dice `ZMARS_ROUTING_COMP_ALLOC_GET`, ma l'iFlow è `…PRODUCTIONROUTINGOPERATION_GET` | Le celle C/D sembrano copiate dalla riga 7. Da confermare che la riga 8 sia l'endpoint di `ProductionRoutingOperation` |
| A3 | 2 | `ProductionRouting` non è letta da nessuna delle 17 chiamate — il codice usa l'header (cfr. commento `cat-service.js:1684-1685`) | Endpoint mappabile per completezza, non se ne dipenda |

---

## 4. Come si traducono le chiamate

### 4.1 Cosa genera CAP, verificato

Misurato con `cds.odata.urlify()` sul CSN reale del progetto (`@sap/cds` 9.9.2):

| Forma CQN | URL generato | `one` |
|---|---|---|
| `SELECT.from(Op).where({Group, Routing})` — **quello che il codice fa oggi** | `ProductionRoutingOperation?$select=…&$filter=…Group eq '…' and …Routing eq '…'&$top=500` | `false` |
| `SELECT.from(Op, {Group, Routing})` — 2 chiavi su 5 | `ProductionRoutingOperation(ProductionRoutingGroup='41710000',ProductionRouting='01')` | **`true`** |
| idem `+ .columns() .limit()` | `…(…)?$select=Operation,OperationText&$top=500` | `true` |
| idem `+ .where({Plant:{in:[…]}})` | `…(…)?$select=…&$filter=(Plant eq '1710' or Plant eq '1010')` | `true` |
| `SELECT.from(Op, {Group})` — una sola chiave | `ProductionRoutingOperation('41710000')` ← **forma corta senza nome**, ambigua | `true` |
| `SELECT.from(Op, {Group:{in:[…]}})` | `…(ProductionRoutingGroupin[object Object],…)` ← **URL corrotto** | `true` |

Due conseguenze utili: CAP costruisce il key predicate **con le chiavi che gli passi**, senza pretendere tutte quelle dichiarate nel CSN; e `$select` / `$top` / un `$filter` aggiuntivo **sopravvivono** accanto al predicate.

### 4.2 Le due trappole della GET per chiave

**Trappola 1 — `one: true` scarta tutte le righe tranne la prima.**

`SELECT.from(E, {chiavi})` imposta `one: true`, e `libx/_runtime/remote/Service.js:306` fa:

```js
result = typeof query === 'object' && query.SELECT?.one && Array.isArray(result) ? result[0] : result
```

Quindi con un iFlow che ritorna la lista, CAP restituisce **un solo elemento**. Serve rimuovere il flag:

```js
const q = SELECT.from(ProductionRoutingOperation, { ProductionRoutingGroup, ProductionRouting })
  .columns('ProductionRoutingOpIntID', 'Operation', 'WorkCenterInternalID', …);
delete q.SELECT.one;                    // <-- altrimenti arriva una riga sola
const ops = await srv.run(q);
```

**Trappola 2 — la forma della risposta.**

`libx/_runtime/remote/utils/client.js:124`:

```js
const purgedResponse = typeof data === 'object' && 'results' in data ? data.results : data
```

L'iFlow deve rispondere `{"d":{"results":[…]}}`. Con quella forma l'array viene srotolato correttamente. Se risponde con un singolo entry (`{"d":{…}}`) arriva un **oggetto** e il codice chiamante — che fa `.length`, `for…of`, `.map()` — si rompe.

Se il `$metadata` dichiara tutte 5/6 le chiavi e il sender adapter valida il predicate, si passano stringhe vuote per quelle che non conosciamo:

```
ProductionRoutingOperation(ProductionRoutingGroup='41710000',ProductionRouting='01',
                           ProductionRoutingSequence='',ProductionRoutingOpIntID='',
                           ProductionRoutingOpIntVersion='')
```

Funziona lato CAP, ma è più fragile: la FM deve ignorarle. Da qui la domanda **Q1** (§8): quali campi sono dichiarati `key`?

> **Risolto il 2026-08-07 — è questa la forma in esercizio.** Le chiavi dichiarate sono tutte 5 (e tutte 6 su
> `ProductionRoutingCompAlloc`) e il predicate parziale non è accettato: si inviano tutte, con stringa vuota su
> quelle che l'applicazione non conosce, e le FM le trattano come parametri opzionali. Vedi
> [DEC-41](../../docs/DECISIONI.md) e la route table in [routingSource.js](../lib/routingSource.js)
> (`keyPredicateBlanks`).
>
> **Superato il 2026-08-17 su `ProductionRoutingCompAlloc`, e la domanda era mal posta.** Il vero problema non
> era *quante* chiavi dichiara l'indirizzo, ma che a un indirizzo **per chiave** si chiedeva una **lista**: una
> read-by-key è tipizzata per serializzare una sola entry, quindi risponde `200` con una riga e `500` con due o
> più. Le assegnazioni componenti leggono ora da un `…PRODUCTIONROUTINGCOMPALLOC_QUERYGET;v=1`, in collection +
> `$filter` su gruppo e ciclo, e le 4 chiavi vuote non si inviano più. Vedi
> [DEC-44](../../docs/DECISIONI.md) e il contratto E-17.
>
> **Superato lo stesso giorno anche su `ProductionRoutingOperation`**, che era l'ultima lettura dei cicli in
> quella forma: il team Integration ha pubblicato `…PRODUCTIONROUTINGOPERATION_QUERYGET;v=1` (richiesta R-13,
> chiusa) e le operazioni leggono in collection + `$filter` su gruppo e ciclo, con le 3 chiavi vuote che non si
> inviano più. Insieme a esso è arrivato `…PRODUCTIONORDEROPERATION_QUERYGET;v=1`, che chiude la stessa forma
> nell'area **ordini** (R-2 punto b). Vedi [DEC-45](../../docs/DECISIONI.md) e i contratti E-18 ed E-19.
>
> **Quindi tutto il §4.2 è materiale storico**: nell'area cicli non si compone più alcun key predicate, tranne
> su `ProductionRouting`, che non ha lettori. Ciò che resta vero è il criterio di scelta, ed è l'unica riga da
> portarsi via: **una lettura per chiave è la forma di un risultato a una riga, non di una lettura padre →
> figli**, quali che siano le chiavi che si conoscono. Il collaudo di una lettura di figli va fatto su un padre
> con **più di un figlio** — con uno solo, la forma sbagliata risponde `200`, ed è il motivo per cui il difetto
> è sopravvissuto a tre rilasci.

### 4.3 L'unico punto non esprimibile: `cat-service.js:1766`

Il key predicate **non può contenere una lista** (ultima riga di §4.1). E `:1766` è l'unico arricchimento **a livello di lista**: prende `pageGroups` (`:1761`, fino a 100 gruppi — `readPaging(req,{defTop:100,maxTop:500})` a `:1682`) e ne ricava il primo `WorkCenterInternalID` per riga, per riempire la colonna *Work Center*.

Per chiave diventerebbero **~100 chiamate CPI per ogni caricamento della lista** (ogni URL misura ~154 char, quindi nessun problema di lunghezza — solo di numero).

Tre vie d'uscita, in ordine di preferenza:

| # | Soluzione | Costo | Effetto |
|---|---|---|---|
| 1 | **`PlanningWorkCenter` sull'header** — **nessuna richiesta al team IS**: il campo esiste già nel CSN v3 (`String(8)`, label SAP *"Work Center"*, riga 2076 di `sap-s4-OP_API_PRODUCTION_ROUTING_0003-v3.cds`) | un campo in più nel `$select` | La chiamata `:1766` **sparisce**, e con essa il fan-out e il problema `in`-list. Miglior rapporto valore/costo di tutta la migrazione |
| 2 | Fan-out con concorrenza limitata (es. 8 in parallelo) | codice + carico | 100 chiamate CPI e 100 RFC su ECC per pagina |
| 3 | Colonna *Work Center* on-demand (solo alla riga selezionata) | codice + UI | Nessun fan-out, ma cambia il comportamento della lista |

> **Stato: risolto.** Implementata la soluzione 1 con una variante: la colonna *Work Center* è stata **rimossa dalla lista** (decisione di progetto), e `PlanningWorkCenter` viene selezionato dall'header per la sola banda header del dettaglio. La chiamata `:1766` è disattivata. Vedi i blocchi `[IS-ROUTING-LIST]` in `srv/cat-service.js` e `RoutingsTab.fragment.xml`.
>
> Da notare: il campo che `:1766` usava, `ProductionRoutingOperation.WorkCenterInternalID`, ha label SAP **"Object ID"** — è l'ARBID interno, non il codice del work center. Nella stessa entity esiste `WorkCenter` (label *"Work Center"*), che sarebbe stato il campo corretto. Verificato sul sandbox per il gruppo `41710000`:
>
> ```
> header      PlanningWorkCenter = ""           <- vuoto, come ResponsiblePlannerGroup
> operation   WorkCenterInternalID = "10000045"  WorkCenter = "ASSEMBLY"
> ```
>
> **Sul sandbox l'header non popola `PlanningWorkCenter`.** Sul sistema reale è da verificare (Q11.6). Conseguenza pratica: nella lista non si vede, perché la colonna è stata rimossa; nella banda header del dettaglio il campo può risultare vuoto dove prima mostrava l'ARBID.
>
> **Sistemazione naturale**, quando si migrerà il dettaglio: la tab Operazioni leggerà comunque `ProductionRoutingOperation` via l'iFlow `_GET`, quindi il dettaglio potrà valorizzare da sé il proprio work center usando `WorkCenter` (il campo corretto), e `Routings.PlanningWorkCenter` diventa superfluo.

`:1783` (colonna *Material*) usa `ProductionRoutingMatlAssgmt`, che **ha** il `_QUERYGET`: resta in forma collection.

### 4.4 Perché i `_GET` di Header e MatlAssgmt non sono utilizzabili

Non è una questione di stile del codice: **le chiavi non ci sono**.

| Entity | Chiavi nel CSN | Quante ne conosce l'app |
|---|---|---|
| `ProductionRoutingHeader` | `ProductionRoutingGroup`, `ProductionRouting`, **`ProductionRoutingInternalVers`** | 2 su 3 |
| `ProductionRoutingMatlAssgmt` | `Product`, `Plant`, `ProductionRoutingGroup`, `ProductionRouting`, `ProductionRoutingMatlAssgmt`, `ProductionRtgMatlAssgmtIntVers` | 2–3 su 6 |

E non si deve "migliorare" il codice per procurarsele: `:1717-1721` **deliberatamente** deduplica per `(Group, Routing)` tenendo la prima versione. Scegliere una `InternalVers` cambierebbe la semantica.

Per Operation e CompAlloc la situazione è diversa e favorevole: le chiavi mancanti (`Sequence`, `OpIntID`, `OpIntVersion` / `ProdnRtgOpBOMItemInternalID`, `…IntVersion`) sono **esattamente il risultato** che la chiamata sta cercando — cioè il caso d'uso "passa la routing, ricevi i figli".

---

## 5. Inventario delle 17 chiamate CAP

Contratto verso il team Integration Suite. Rigenerabile con:

```bash
grep -n "S4Routing.run\|s4r.run\|S4Routing\.entities" srv/cat-service.js jobs/syncRoutingsToPlex.js
```

| # | Punto nel codice | Entity | Filtro attuale | `$select` | `$top` | Forma target | Endpoint |
|---|---|---|---|---|---|---|---|
| 1 | `cat-service.js:1695` READ `Routings` | Header | **nessuno** | 9 campi | 10000 | collection | riga 4 |
| 2 | ~~`cat-service.js:1766` colonna *Work Center*~~ | ~~Operation~~ | — | — | — | **disattivata**: colonna rimossa dalla lista, `PlanningWorkCenter` preso dall'header (§4.3) | nessuno |
| 3 | `cat-service.js:1783` colonna *Material* | MatlAssgmt | `Group in [≤500]` | 3 | 5000 | collection | riga 5 |
| 4 | `cat-service.js:1870` READ `RoutingOperations` | Operation | `Group eq … and Routing eq …` (il plant si applica a valle) | 9 | 500 | collection + `$filter` | riga 8 |
| 5 | `cat-service.js:1926` READ `RoutingComponentAllocations` | CompAlloc | `Group eq … and Routing eq …` | 9 | 1000 | collection + `$filter` | riga 7 |
| 6 | `cat-service.js:1453` `autoImportPlexCycle` | MatlAssgmt | `Product eq …` | 2 | — | collection | riga 5 |
| 7 | `cat-service.js:2049` `autoAssignPlexCycle` | Header | `Group eq … and Routing eq …` | `Plant` | 1 | collection | riga 4 |
| 8 | `cat-service.js:2053` idem | MatlAssgmt | idem | `Product` | 1 | collection | riga 5 |
| 9 | `cat-service.js:2068` idem | CompAlloc | idem | 3 | 1000 | collection + `$filter` | riga 7 |
| 10 | `cat-service.js:2115` `saveRoutingPlexCycle` | Header | idem | `Plant` | 1 | collection | riga 4 |
| 11 | `cat-service.js:2218` `syncRoutingPlexCycle` | Header | idem | `Plant` | 1 | collection | riga 4 |
| 12 | `cat-service.js:285` `fetchRoutingOpFields` | Operation | idem | 6 | — | collection + `$filter` | riga 8 |
| 13 | `cat-service.js:2488` `syncRoutingPlexCycle` auto-assign | CompAlloc | idem | 2 | 1000 | collection + `$filter` | riga 7 |
| 14 | `cat-service.js:2910` `findRoutingTestData` | MatlAssgmt | **nessuno** | 4 | 2000 | collection | riga 5 |
| 15 | `cat-service.js:2929` `findRoutingTestData` | Header | **nessuno** | 3 | 2000 | collection | riga 4 |
| 16 | `jobs/syncRoutingsToPlex.js:91` | Header | `Group in [n]` | 3 | 5000 | collection | riga 4 |
| 17 | `jobs/syncRoutingsToPlex.js:103` | MatlAssgmt | `Group in [n]` | 3 | 5000 | collection | riga 5 |

Riepilogo: **16 collection** e **1 problematica** (#2). *(Aggiornato il 17/08/2026: erano «10 collection + 6 key predicate». Le 6 letture di Operation e CompAlloc erano l'unica ragione per cui servivano i `_GET`, e sono passate ai `_QUERYGET` — DEC-44, DEC-45. Nell'area cicli **nessuna lettura compone più un key predicate**: la colonna «Forma target» qui sopra è aggiornata riga per riga.)*

Le chiamate #14 e #15 sono in `findRoutingTestData`, un'azione diagnostica: leggono **senza filtro** con `.limit(2000)` e non hanno gating su plant o licenza. Da isolare dietro un flag o rimuovere prima di puntarle su CPI.

### 5.1 Ogni fallimento è silenzioso

Tutte le letture sono dentro `try/catch → return []` / `catch → warn`:

| Punto | `catch` |
|---|---|
| READ `Routings` (header) | `cat-service.js:1712` → `return []` |
| colonna *Work Center* | `cat-service.js:1777` → prosegue con `wcMap` vuoto |
| colonna *Material* | `cat-service.js:1795` → prosegue con `matlMap` vuoto |
| READ `RoutingOperations` | `cat-service.js:1889` → `return []` |
| READ `RoutingComponentAllocations` | `cat-service.js:1967` → `return []` |
| `fetchRoutingOpFields` | `cat-service.js:300` → `warn`, mappa vuota |
| job sync | `syncRoutingsToPlex.js:99`, `:114` → `error`, Plant/Material a stringa vuota |

Conseguenza operativa: un endpoint mal configurato non produce un errore in dashboard, produce **colonne e tab vuote**. Questo è il motivo per cui la strategia di verifica di §9 controlla che i campi arricchiti **non** siano vuoti, invece di limitarsi a controllare l'assenza di errori.

---

## 6. Rischi tecnici

### 6.1 Auto-`$batch` a 1028 caratteri

`libx/_runtime/remote/utils/query.js:181`:

```js
const maxGetUrlLength = service.options.max_get_url_length ?? cds.env.remote?.max_get_url_length ?? 1028
if (requestConfig.method === 'GET' && KINDS_SUPPORTING_BATCH[service.kind] && requestConfig.url.length > maxGetUrlLength)
  _batchEnvelope(requestConfig, maxGetUrlLength)     // -> POST <root>/$batch, multipart/mixed
```

Un `{in:[…]}` in OData V2 viene espanso in un OR di `eq`. Misurato sulla forma attuale di `:1766`:

| Gruppi nella lista `in` | Lunghezza URL |
|---|---|
| 15 | 829 |
| **19** | **1021** ← ultimo sotto soglia |
| **20** | **1069** ← da qui `POST /$batch` |
| 100 (`defTop`) | 4909 |
| 500 (`maxTop`) | ~26 000 |

**La prima pagina della dashboard è già oggi oltre soglia**: il gateway on-prem accetta `$batch`, un iFlow FM-based quasi certamente no.

Il controllo di lunghezza avviene **prima** che `service.path` venga aggiunto (`query.js:190` è dopo `:187`), quindi il path CPI più lungo non sposta la soglia dei ~19 termini.

Punti che restano in forma collection e quindi esposti: **#3**, **#16**, **#17** (in `syncRoutingsToPlex.js` la lista `groups` è **illimitata** — tutti i gruppi con cicli salvati).

Mitigazioni, non alternative ma in ordine:

1. **Chunking applicativo** delle liste `in`, soglia ~15 termini, da centralizzare nel modulo di §7. Autotarabile misurando con la stessa funzione che usa CAP: `cds.odata.urlify(q, {kind:'odata-v2', model, method:'GET'}).path.length`.
2. **`max_get_url_length` esplicito** al **top level** della entry `cds.requires` — non dentro `credentials`, perché `Service.js` legge `this.options.max_get_url_length`. Valore ~4000, come rete di sicurezza.
3. Domande **Q6**/**Q7** al team IS (§8).

### 6.2 La query header più pesante non ha filtro

`cat-service.js:1695-1709` → `ProductionRoutingHeader?$select=<9 campi>&$top=10000`, **nessun `$filter`**. Il commento `:1691-1694` spiega perché: la ricerca è un OR di `contains` che il servizio v2 on-prem non gestisce, quindi filtro e ricerca sono applicati in memoria a `:1727-1748`.

Tre rischi:

| Rischio | Meccanismo |
|---|---|
| Timeout | `Service.js:219` → `requestTimeout` default **60000 ms**. Una FM sincrona su 10 000 header PLKO non ci sta |
| **Troncamento silenzioso** | CAP **non segue `__next`**: lo copia in una proprietà non-enumerabile `$next` che nessuno legge. Il dedup/sort/paginate di `:1717-1760` produce una pagina plausibile ma **sbagliata**, con `$count` sbagliato a `:1830` |
| Carico su ECC | Scansione completa della testata task list a ogni apertura della lista |

Mitigazione quasi gratuita: `resolveEffectivePlants(req)` è **già calcolato** a `:1730` e usato solo per un `.filter()` in memoria a `:1731`. Spingerlo giù come `$filter=Plant in (…)` (oggi 3 plant, sotto la soglia di chunking) riduce il volume di un ordine di grandezza. Il comportamento è preservato: le righe con `Plant` vuoto sono già scartate dal filtro in memoria.

### 6.3 Date e decimali

`libx/_runtime/remote/utils/data.js:76-88` converte solo il formato `/Date(ms)/`:

```js
} else if (type === 'cds.Timestamp' || type === 'cds.DateTime' || type === 'cds.Date') {
  const match = value.match(/\/Date\((.*)\)\//)
  …
  } else if (type === 'cds.Date') {
    value = value.slice(0, 10)          // se non c'era match: troncamento cieco
```

| Se l'iFlow ritorna | Effetto |
|---|---|
| `/Date(1752537600000)/` | ✅ convertito in ISO |
| `"20260727"` (DATS CHAR(8) da FM Z) | ⚠️ `value.slice(0,10)` → resta `"20260727"`, contro `Routings.LastChangeDate: Date` (`cat-service.cds:224`) |
| un **numero** | ❌ `value.match is not a function` → `TypeError` dentro il client remoto |

`ChangedDateTime` è il **primo** criterio di ordinamento (`byDateDescChain(['ChangedDateTime','LastChangeDate','CreationDate'], …)` a `:1751`): un formato diverso scompagina il "più recenti in cima" della lista.

Analogo per `OperationReferenceQuantity` e `StandardWorkQuantity1` (usati a `cat-service.js:285-297`, persistiti come `Decimal(13,3)`), e per `MatlCompIsMarkedForBackflush` — ECC ritorna `'X'`/`' '`, ma `cat-service.cds:260` lo dichiara `Boolean`.

### 6.4 Zeri iniziali NUMC — il rischio dati più grave

Questi campi sono **chiavi persistite**, non solo dati di visualizzazione:

| Campo | Origine ABAP | Persistito in |
|---|---|---|
| `ProductionRoutingOpIntID` | PLNKN | `db/schema.cds:308` (`ZPlexRoutingCycleOperation`) |
| `BillOfMaterialItemNodeNumber` | STPO | `db/schema.cds:326` (`ZPlexRoutingCycleComponent`, come `BOMItemNodeNumber`) |
| `ProductionRoutingSequence` | PLNFL | chiave di join |
| `ProductionRoutingGroup` / `ProductionRouting` | PLNNR / PLNAL | chiavi di **tutte** le tabelle locali |

Se l'iFlow ritorna `1` invece di `00000001`, i join contro `ZPlexRoutingCycleOperation`, `ZPlexRoutingCycleComponent`, `ZPlexRoutingApprovedWorkcenter` (`db/schema.cds:299`, `:320`, `:335`) e `ZRoutingExcLogHDR/POS` **non matchano più**: i cicli Plex già salvati dagli utenti vengono **orfanizzati in silenzio**. Nessun errore, nessun log — semplicemente le assegnazioni scompaiono dalla UI.

È la ragione per cui §8 **Q9.1** chiede esplicitamente la conservazione degli zeri iniziali, e §9 verifica il formato su dati reali prima di andare in esercizio.

---

## 7. Modifiche al codice

### 7.1 Nuovo modulo `srv/lib/routingSource.js`

Sta accanto a `materialVisibility.js`, `plexOpFieldMapper.js`, `plexPartMapper.js`. Espone **solo i due membri che le 17 chiamate usano davvero** — `.entities` e `.run(query)` — così le call site non cambiano forma:

```js
const P = '/gw/odata/SAP/F0491.87_OPERATIONS_SAPECC_SAPBTPMARS_';
const ROUTES = {
  ProductionRoutingHeader:     { QUERY: `${P}PRODUCTIONROUTINGHEADER_QUERYGET;v=1` },
  ProductionRoutingMatlAssgmt: { QUERY: `${P}PRODUCTIONROUTINGMATLASSGMT_QUERYGET;v=1` },
  ProductionRoutingOperation:  { GET:   `${P}PRODUCTIONROUTINGOPERATION_GET;v=1` },  // dal 17/08/2026: QUERY su …_QUERYGET;v=1 (DEC-45)
  ProductionRoutingCompAlloc:  { GET:   `${P}PRODUCTIONROUTINGCOMPALLOC_GET;v=1` },  // dal 17/08/2026: QUERY su …_QUERYGET;v=1 (DEC-44)
  ProductionRouting:           { GET:   `${P}PRODUCTIONROUTING_GET;v=1` },
};

module.exports = async function routingSource() {
  return { entities, run(query) { /* dispatch */ }, mode, describe(query) };
};
```

Responsabilità, tutte in un unico punto:

| # | Responsabilità | Perché qui |
|---|---|---|
| 1 | Pool memoizzato di istanze per path via `cds.connect.to(BASE, {credentials:{…, path}})` | §2 — 7 istanze, 1 modello |
| 2 | Dispatch su `(entity, op)` derivato dal CQN; entity ignota → `throw` **rumoroso** | Un mis-route silenzioso è il peggior esito possibile |
| 3 | **Chunking delle liste `in`**, soglia ~15 | §6.1 — impossibile da fare pulito 17 volte |
| 4 | Rilevazione troncamento: `rows.$next != null` o `rows.length === $top` → warn strutturato | §6.2 — oggi invisibile |
| 5 | Switch `legacy` \| `cpi` | Rollback senza redeploy (§10.2) |
| 6 | Assert che ogni path inizi con `/` | Anomalia **A1** (§3.1) |
| 7 | Un log per chiamata: entity, op, iFlow, righe, ms | Oggi non c'è modo di sapere quale dei 7 root è stato usato |

Da scrivere **generico** (`remoteSource(baseName, routeTable)`): il foglio mostra lo stesso split in arrivo su Product e Production Order (§11).

Il duck-typing su `.entities` + `.run()` è già l'assunzione del codice esistente: `fetchRoutingOpFields(S4Routing, …)` a `cat-service.js:280` e `resolveRoutingContext(s4r, …)` a `syncRoutingsToPlex.js:88` usano **solo** quei due membri. Continuano a funzionare senza modifiche.

### 7.2 Rewiring — 5 righe

| File | Riga | Da | A |
|---|---|---|---|
| `srv/cat-service.js` | in testa | — | `const routingSource = require('./lib/routingSource');` |
| `srv/cat-service.js` | 1670 | `await cds.connect.to('sap_s4_OP_API_PRODUCTION_ROUTING_0003_v3')` | `await routingSource()` |
| `srv/cat-service.js` | 1451 | idem (dentro `autoImportPlexCycle`) | `await routingSource()` |
| `jobs/syncRoutingsToPlex.js` | 31 | `const S4_ROUTING = 'sap_s4_…';` | `const routingSource = require('../srv/lib/routingSource');` |
| `jobs/syncRoutingsToPlex.js` | 149 | `await cds.connect.to(S4_ROUTING)` | `await routingSource()` |

### 7.3 Conversione delle 5 letture child in key predicate

Chiamate **#4, #5, #9, #12, #13** di §5. Per ciascuna: `.where({Group, Routing})` → key tuple, più `delete q.SELECT.one` (§4.2).

Esempio, `cat-service.js:285` (`fetchRoutingOpFields`):

```js
// prima
SELECT.from(ProductionRoutingOperation)
  .columns('ProductionRoutingOpIntID', 'Operation', 'WorkCenterInternalID',
           'OperationControlProfile', 'OperationReferenceQuantity', 'StandardWorkQuantity1')
  .where({ ProductionRoutingGroup, ProductionRouting })

// dopo
const q = SELECT.from(ProductionRoutingOperation, { ProductionRoutingGroup, ProductionRouting })
  .columns('ProductionRoutingOpIntID', 'Operation', 'WorkCenterInternalID',
           'OperationControlProfile', 'OperationReferenceQuantity', 'StandardWorkQuantity1');
delete q.SELECT.one;
```

Per **#4** (`:1870`) il filtro plant resta pushable: `SELECT.from(Op, {Group, Routing}).where({Plant:{in: activePlants}})` → `…(…)?$select=…&$filter=(Plant eq '1710' or …)`. Se l'iFlow non onora il `$filter` accanto al predicate (**Q6**), il filtro si sposta in memoria — modifica locale a `:1864-1868`.

La conversione può essere **incapsulata nel modulo** invece che sparsa nelle call site: il dispatcher sa già se la rotta è `GET` o `QUERY`, quindi può riscrivere lui la `where` in key predicate. Preferibile: le call site restano invariate e la logica sta in un punto solo. Da decidere in fase di implementazione, dopo la risposta a **Q1**.

### 7.4 Scelta su `cat-service.js:1766`

Vedi §4.3. Nessuna modifica progettabile prima della risposta del team IS su `PlanningWorkCenter` (**Q9.6**).

---

## 8. Configurazione

### 8.1 Destination

Il tenant CPI è `it-cpi024-rt` su **eu10-002**; l'app CAP è su **eu10-004** (`.cdsrc-private.json` → `api.cf.eu10-004`). Sono **subaccount distinti**: la service key OAuth va creata dove vive CPI, le credenziali vanno copiate nella destination del subaccount dell'app.

```bash
# nel subaccount/space CPI (eu10-002)
cf marketplace -e it-rt                      # verificare i piani disponibili
cf create-service it-rt integration-flow marsplm-cpi-client -c '{"roles":["ESBMessaging.send"]}'
cf create-service-key marsplm-cpi-client marsplm-cpi-key
cf service-key marsplm-cpi-client marsplm-cpi-key
```

| Proprietà | TEST | PROD |
|---|---|---|
| **Name** | `MARS_IS_CON` | `MARS_IS_CON` |
| **Type** | `HTTP` | `HTTP` |
| **URL** | `https://sd-integration-suite-dev-test-cf.it-cpi024-rt.cfapps.eu10-002.hana.ondemand.com` | `https://sd-integration-suite-prod-cf.it-cpi024-rt.cfapps.eu10-002.hana.ondemand.com` |
| **Proxy Type** | `Internet` | `Internet` |
| **Authentication** | `OAuth2ClientCredentials` | idem |
| **Client ID / Secret** | dalla service key `it-rt` | idem (subaccount prod) |
| **Token Service URL** | `https://<subdomain-cpi>.authentication.eu10.hana.ondemand.com/oauth/token` | idem |
| **Token Service URL Type** | `Dedicated` | `Dedicated` |

Non servono `WebIDEEnabled`, `HTML5.DynamicDestination`, `sap-client`, `CloudConnectorLocationId`.

**URL nudo, non service root completo.** L'URL finale è `destination.URL` + `encodeURI(credentials.path)` + `/<EntitySet>?<opzioni>` (§2). Mettere il service root nella destination richiederebbe **7 destination**, quindi 7 copie delle stesse credenziali, 7 cache token e 7 punti di manutenzione manuale in cockpit. Con l'URL nudo, aggiungere un endpoint è una PR su `package.json` invece di un ticket a ops. È anche coerente col pattern esistente: `MARS_SAP_CON` è un host + 9 `path` diversi.

### 8.2 `cds.requires`

```json
"mars_is_routing_header_queryget": {
  "kind": "odata-v2",
  "model": "srv/external/mars-is-routing-header-queryget",
  "max_get_url_length": 4000,
  "credentials": {
    "[hybrid]": {
      "url": null,
      "headers": null,
      "destination": "MARS_IS_CON",
      "path": "/gw/odata/SAP/F0491.87_OPERATIONS_SAPECC_SAPBTPMARS_PRODUCTIONROUTINGHEADER_QUERYGET;v=1",
      "requestTimeout": 120000
    },
    "[production]": {
      "destination": "MARS_IS_CON",
      "path": "/gw/odata/SAP/F0491.87_OPERATIONS_SAPECC_SAPBTPMARS_PRODUCTIONROUTINGHEADER_QUERYGET;v=1",
      "requestTimeout": 120000
    }
  }
}
```

| Parametro | Dove | Default | Proposto | Perché |
|---|---|---|---|---|
| `requestTimeout` | dentro `credentials` (`Service.js:219`) | 60 000 ms | **120 000** | §6.2 |
| `max_get_url_length` | **top level** della entry | 1028 | **4000** | §6.1 — `Service.js` legge `this.options.…`, non `credentials` |

**`[hybrid]` deve azzerare `url` e `headers`.** Verificato: `cds env get profiles --profile hybrid` → `["hybrid","development"]`, cioè hybrid attiva **anche** `development`. Senza i `null` espliciti l'`APIKey` del sandbox si fonderebbe nel merge. `[production]` non ne ha bisogno.

**`[development]` va omesso** per questi servizi: non esiste un equivalente del sandbox `sandbox.api.sap.com`. `cds watch` (profilo `development`) fallirà con `No credentials configured for "…"` (`Service.js:200`) — errore esplicito, preferibile a un fallback silenzioso su dati sbagliati. Per lo sviluppo locale: `cds watch --profile hybrid`, oppure `cds mock <servizio>` con CSV in `test/data/`.

**Effetto collaterale positivo**: `connectivity` è dichiarato solo sotto `[production]`, quindi oggi `cds watch --profile hybrid` **non può** raggiungere `MARS_SAP_CON` (ProxyType OnPremise richiede il proxy connectivity, non raggiungibile da laptop). Con `MARS_IS_CON` a ProxyType `Internet`, il routing diventa **il primo servizio SAP testabile in hybrid da locale**.

### 8.3 Cloud Connector: non rimuovere

| `cds.requires` | Destination | Dopo la migrazione |
|---|---|---|
| `OP_API_PRODUCTION_ORDER_2_SRV_0001` | `MARS_SAP_CON` | on-prem |
| `API_PROD_ORDER_CONFIRMATION_2_SRV` | `MARS_SAP_CON` | on-prem |
| `OP_API_BILL_OF_MATERIAL_SRV_0002` | `MARS_SAP_CON` | on-prem |
| `OP_API_PRODUCT_SRV_0001` | `MARS_SAP_CON` | on-prem |
| `OP_API_CLFN_PRODUCT_SRV` | `MARS_SAP_CON` | on-prem |
| `OP_API_CLFN_CHARACTERISTIC_SRV` | `MARS_SAP_CON` | on-prem |
| `OP_API_MATERIAL_DOCUMENT_SRV` | `MARS_SAP_CON` | on-prem (flusso movimenti, cfr. `SAP_CONF_MOVEMENT_API.md`) |
| `sap_s4_OP_API_PRODUCTION_ROUTING_0003_v3` | `MARS_SAP_CON` | **→ CPI** |
| `API_PRODUCTION_ROUTING_AVVALE` | `MARS_SAP_CON` | **dangling, da eliminare** (§11.1) |
| `MARS_LICENSE` | `MARS_LICENSE` | invariato |

**7 servizi su 9 restano su `MARS_SAP_CON`**: la risorsa `marsplm-sap2plex-connectivity` (`mta.yaml:207-211`) e il `"connectivity": true` sotto `[production]` **devono restare**.

### 8.4 Destination come contenuto MTA — fase 2

Oggi `mta.yaml:212-216` crea l'istanza destination **senza `config`**, quindi le destination sono 100% lavoro manuale in cockpit. Si può dichiararle nel descrittore:

```yaml
  - name: marsplm-sap2plex-destination
    type: org.cloudfoundry.managed-service
    parameters:
      service: destination
      service-plan: lite
      config:
        init_data:
          subaccount:                                  # NON 'instance' — vedi sotto
            existing_destinations_policy: update
            destinations:
              - Name: MARS_IS_CON
                Type: HTTP
                URL: ~{cpi-host}
                ProxyType: Internet
                Authentication: OAuth2ClientCredentials
                tokenServiceURLType: Dedicated
                tokenServiceURL: ~{cpi-token-url}
                clientId: ~{cpi-client-id}
                clientSecret: ~{cpi-client-secret}
```

⚠️ **Usare `subaccount`, non `instance`.** `mta.yaml` crea l'istanza `marsplm-sap2plex-destination`, mentre `.cdsrc-private.json` binda `marsplm-destination` — **nomi diversi**. Con `init_data.instance` le destination sarebbero visibili solo all'app deployata e **invisibili in hybrid** (`Cannot resolve destination 'MARS_IS_CON'`). Alternativa: `cds bind --to marsplm-sap2plex-destination --kind destinations --for hybrid`.

| Pro | Contro |
|---|---|
| Destination versionata e revisionabile in PR | `clientSecret` non può stare in `mta.yaml` → serve un `.mtaext` fuori git |
| Elimina il lavoro manuale in cockpit | `existing_destinations_policy: update` sovrascrive a ogni deploy gli hotfix fatti in cockpit; con `ignore` gli aggiornamenti non arrivano mai |
| Allineamento test/prod garantito | Il deploy richiede privilegi di subaccount admin |

**Sequenza consigliata**: fase 1 creazione manuale + specifica scritta in questo documento; fase 2, a endpoint stabile, migrazione a `init_data.subaccount` + `.mtaext`.

---

## 9. Modelli esterni (EDMX / CSN)

### 9.1 Procedura

```bash
cd /home/user/projects/marsplm-plex

TOKEN=$(curl -s -u "$CID:$CSEC" -d grant_type=client_credentials "$TOKEN_URL" | jq -r .access_token)

# il NOME FILE determina il namespace del servizio CAP ('-' -> '_')
curl -s -H "Authorization: Bearer $TOKEN" \
  "$CPI_HOST/gw/odata/SAP/F0491.87_OPERATIONS_SAPECC_SAPBTPMARS_PRODUCTIONROUTINGHEADER_QUERYGET;v=1/\$metadata" \
  -o ~/Downloads/mars-is-routing-header-queryget.edmx

cds import ~/Downloads/mars-is-routing-header-queryget.edmx --as cds --odata-v2-annotations \
  -c '{"[production]":{"credentials":{"destination":"MARS_IS_CON","path":"/gw/odata/SAP/F0491.87_OPERATIONS_SAPECC_SAPBTPMARS_PRODUCTIONROUTINGHEADER_QUERYGET;v=1"}}}'
```

Note operative (`cds-dk` 9.9.3):

| Opzione | Nota |
|---|---|
| *(nessuna)* | `cds import` copia il sorgente in `srv/external/`, scrive il CSN accanto e **aggiunge da sé** la entry in `package.json#cds.requires` — è la convenzione già presente nel repo |
| `--as cds` | Produce `.cds` leggibile come i 7 modelli esistenti. Da usare: `OP_API_PROD_ORDER_CONFIRMATIO_2_SRV_0001.csn` è l'unico `.csn` residuo e stona |
| `--odata-v2-annotations` | Per OData V2 le annotazioni **non** sono importate di default. Servono `sap:display-format`, `sap:filterable`, `sap:label` per il confronto col modello vecchio |
| `--into` | **Non esiste.** L'opzione è `-o` / `--out`, e *disabilita* la copia in `srv/external` → non usarla |
| `--keep-namespace` | **Non usare.** Userebbe lo `Schema Namespace` dell'EDMX (oggi `cds_api_productionrouting_3`): gli artefatti CPI probabilmente lo condividono e collidereebbero |
| `-f` / `--force` | Obbligatoria per rigenerare un `.cds` esistente (c'è un checksum in testa al file) |
| `--destination` | Non supportata per import `edmx` → si passa con `-c` |

### 9.2 Un modello o sette?

Vincolo: `service.path` è statico per istanza (§2), quindi 7 service root ⇒ 7 istanze. **Ma le istanze possono condividere un CSN** se i nomi entity e campo combaciano.

| Scenario | Modelli | Entry `cds.requires` | Condizione |
|---|---|---|---|
| **Riuso del CSN esistente** | 1 (`sap-s4-OP_API_PRODUCTION_ROUTING_0003-v3`) | 1, più `credentials.path` ad-hoc per istanza | I `$metadata` degli iFlow usano gli stessi nomi entity/campo di S/4, ed sono un **sottoinsieme** dei campi |
| **Un modello per service root** | 7 | 7 | Nomi o tipi divergono |

Il discriminante è la risposta a **Q8** (§10). Vale la pena verificarlo prima di scrivere codice: è la differenza fra 1 file da mantenere e 7 da riscaricare a ogni modifica lato CPI.

**Come CAP indirizza l'entity set**: usa il nome dell'entity CSN **non qualificato**, così com'è (`libx/odata/parse/cqn2odata.js`, `_entityUrl`). Quindi il nome nel `$metadata` dell'iFlow deve essere identico a quello S/4 (`ProductionRoutingHeader`, `ProductionRoutingOperation`, `ProductionRoutingCompAlloc`, `ProductionRoutingMatlAssgmt`), altrimenti oltre al mapping campi serve rinominare ogni riferimento nel codice.

Naming file per lo scenario a 7 modelli:

| File (`srv/external/`) | Servizio CAP |
|---|---|
| `mars-is-routing-header-queryget.edmx` | `mars_is_routing_header_queryget` |
| `mars-is-routing-matlassgmt-queryget.edmx` | `mars_is_routing_matlassgmt_queryget` |
| `mars-is-routing-operation-get.edmx` | `mars_is_routing_operation_get` |
| `mars-is-routing-compalloc-get.edmx` | `mars_is_routing_compalloc_get` |
| `mars-is-routing-header-get.edmx` | `mars_is_routing_header_get` |
| `mars-is-routing-matlassgmt-get.edmx` | `mars_is_routing_matlassgmt_get` |
| `mars-is-routing-get.edmx` | `mars_is_routing_get` |

`srv/cat-service.cds:11` importa `RoutingService` ma **l'alias non è mai usato** nel file (solo `ProductionService` lo è, righe 60-61). Il modello è già caricato da `cds.requires[].model`, quindi il `using` è ridondante: **non aggiungerne 7**.

### 9.3 Checklist su ogni `$metadata`

Da eseguire **prima** di toccare codice, per ciascun service root.

| # | Verifica | Perché |
|---|---|---|
| C1 | `EntityContainer Name` e `Schema Namespace` | Oggi `cds_api_productionrouting_3_Entities` / `cds_api_productionrouting_3`. Se condivisi fra artefatti, import **senza** `--keep-namespace` |
| C2 | Nome `EntitySet` identico a S/4 | §9.2 |
| C3 | **Quali campi sono `key`** | Decisivo per §4.2: 2 chiavi ⇒ predicate pulito, 5/6 ⇒ servono le stringhe vuote. **Risposto il 2026-08-07: 5/6, stringhe vuote — DEC-41** |
| C4 | `Edm.DateTime` + `sap:display-format="Date"` su `LastChangeDate`, `CreationDate` | §6.3 |
| C5 | `Edm.DateTimeOffset` su `ChangedDateTime` | §6.3 — è il primo criterio di ordinamento |
| C6 | `Edm.Decimal` con `Precision`/`Scale` su `OperationReferenceQuantity`, `StandardWorkQuantity1` | §6.3 |
| C7 | `Edm.Boolean` su `MatlCompIsMarkedForBackflush` | §6.3 — ECC ritorna `'X'`/`' '` |
| C8 | **Zeri iniziali** su `ProductionRoutingSequence`, `ProductionRoutingOpIntID`, `ProdnRtgOpBOMItemInternalID`, `BillOfMaterialItemNodeNumber` | §6.4 — rischio dati più grave |
| C9 | Idem su `ProductionRoutingGroup` (CHAR 8) e `ProductionRouting` (CHAR 2, `'01'`) | §6.4 |
| C10 | `sap:filterable="false"` sui campi filtrati (`ProductionRoutingGroup`, `ProductionRouting`, `Plant`, `Product`) | §5 |
| C11 | `sap:requires-filter="true"` sull'header | **Romperebbe** `cat-service.js:1695`, che non manda `$filter` |
| C12 | `sap:pageable`, `sap:topable` | §6.2 |
| C13 | `Nullable="false"` su campi che ECC può ritornare vuoti | Errori di serializzazione a runtime |

Confronto campo-per-campo fra vecchio e nuovo modello:

```bash
cd /home/user/projects/marsplm-plex
diff \
  <(cds compile srv/external/sap-s4-OP_API_PRODUCTION_ROUTING_0003-v3.cds --to json 2>/dev/null \
    | jq -r '.definitions["sap_s4_OP_API_PRODUCTION_ROUTING_0003_v3.ProductionRoutingHeader"].elements
             | to_entries[] | [.key,(.value.type//"-"),(.value.length//""),(if .value.key then "KEY" else "" end)] | @tsv' | sort) \
  <(cds compile srv/external/mars-is-routing-header-queryget.cds --to json 2>/dev/null \
    | jq -r '.definitions["mars_is_routing_header_queryget.ProductionRoutingHeader"].elements
             | to_entries[] | [.key,(.value.type//"-"),(.value.length//""),(if .value.key then "KEY" else "" end)] | @tsv' | sort)
```

Set minimo di campi richiesti dal codice, per entity:

| Entity | Campi |
|---|---|
| `ProductionRoutingHeader` | `ProductionRoutingGroup`, `ProductionRouting`, `LastChangeDate`, `ChangedDateTime`, `CreationDate`, `BillOfOperationsDesc`, `BillOfOperationsStatus`, `ResponsiblePlannerGroup`, `Plant` |
| `ProductionRoutingOperation` | `ProductionRoutingGroup`, `ProductionRouting`, `ProductionRoutingSequence`, `ProductionRoutingOpIntID`, `Operation`, `OperationText`, `Plant`, `WorkCenterInternalID`, `OperationControlProfile`, `OperationReferenceQuantity`, `StandardWorkQuantity1` |
| `ProductionRoutingCompAlloc` | `ProductionRoutingGroup`, `ProductionRouting`, `ProductionRoutingSequence`, `ProductionRoutingOpIntID`, `ProdnRtgOpBOMItemInternalID`, `BillOfMaterial`, `BillOfMaterialComponent`, `BillOfMaterialItemNodeNumber`, `MatlCompIsMarkedForBackflush` |
| `ProductionRoutingMatlAssgmt` | `ProductionRoutingGroup`, `ProductionRouting`, `Product`, `Plant` |
| `ProductionRouting` | *nessuno* — entity mai usata |

### 9.4 Test di contratto in CI

`test/routingModelContract.test.js`, sulla falsariga di `test/materialVisibility.test.js`: carica i CSN con `cds.compile` e asserisce per ogni entity la presenza dei campi del set minimo, il `type` atteso e le `key` attese. È l'unico modo di intercettare C3/C4/C6/C7/C8 in CI invece che in produzione.

---

## 10. Domande al team Integration Suite

### Contratto d'accesso

**Q1 — Quali campi sono dichiarati `key` nel `$metadata` di `…PRODUCTIONROUTINGOPERATION_GET` e `…PRODUCTIONROUTINGCOMPALLOC_GET`?**
Se le chiavi sono `(ProductionRoutingGroup, ProductionRouting)`, chiamiamo `Entity(Group='X',Routing='01')` e riceviamo la lista dei figli: pulito. Se sono dichiarate tutte 5/6, dobbiamo passare stringhe vuote per quelle che non conosciamo (`…,Sequence='',OpIntID='',OpIntVersion=''`) e la FM deve ignorarle. Preferiamo la prima.

> **Risposta (2026-08-07): sono dichiarate tutte 5/6, e il predicate parziale non è accettato.** In esercizio va
> la seconda variante — quella che qui era la meno preferita. Vedi [DEC-41](../../docs/DECISIONI.md).
>
> **La domanda era mal posta (17/08/2026).** Nessuna delle due varianti regge dove l'indirizzo deve restituire
> **più di una riga**: una read-by-key serializza una sola entry, quindi risponde `200` con un figlio e `500` con
> due o più. La domanda giusta, per un indirizzo padre→figli, non è *quali campi sono dichiarati chiave* ma
> *esiste il `_QUERYGET`?* — ed è stata posta così al team Integration, che ha pubblicato entrambi lo stesso
> giorno: `ProductionRoutingCompAlloc` (DEC-44) e `ProductionRoutingOperation` (DEC-45, richiesta R-13 chiusa)
> leggono ora in collection + `$filter`. **Q1 è quindi chiusa e senza più oggetto**, e Q2 qui sotto va letta come
> il sintomo di questo, non come una preferenza di formato.

**Q2 — La risposta è `{"d":{"results":[…]}}` o un singolo entry `{"d":{…}}`?**
Ci serve la prima forma: il client CAP srotola `d.results` in un array (`remote/utils/client.js:124`). Con un singolo entry il codice chiamante — che itera — si rompe.

**Q3 — Il `$filter` è accettato accanto al key predicate?**
Es. `ProductionRoutingOperation(Group='X',Routing='01')?$filter=Plant eq '1710'`. Ci serve per il gating sui plant attivi (`cat-service.js:1867`). Se non è supportato lo spostiamo in memoria, ma preferiamo non trasferire righe inutili.

**Q4 — `…PRODUCTIONROUTINGHEADER_GET` e `…PRODUCTIONROUTINGMATLASSGMT_GET` sono inutilizzabili: confermate?**
La chiave dell'header ha 3 campi e l'app non conosce mai `ProductionRoutingInternalVers`; `MatlAssgmt` ne ha 6 e l'app ne conosce al massimo 3. Tutte le letture di queste due entity passano dai `_QUERYGET`. Possiamo ritirare i due `_GET`?

**Q5 — `…PRODUCTIONROUTING_GET` (entity `ProductionRouting`): a cosa serve?**
Nessuna delle 17 chiamate la usa. Possiamo escluderla dallo scope?

### Opzioni di sistema

**Q6 — Per ciascun iFlow, ogni opzione è: supportata e propagata alla FM / supportata ma applicata in CPI dopo il fetch completo / ignorata / errore?**
La terza risposta accettabile è "errore esplicito". **"Ignorata in silenzio" è la peggiore**, perché produce dati sbagliati senza segnale.

| Opzione | Necessità | Chi la genera | Se non supportata |
|---|---|---|---|
| `$filter` con `eq` + `and` | **obbligatoria** | 14/17 chiamate | bloccante |
| `$filter` con **`or` espanso** (fino a 500 termini) | **obbligatoria** | `{in:[…]}` — chiamate #3, #16, #17 | chunking a ~15 termini (§6.1) |
| `$select` | fortemente desiderata | tutte | payload 5–10× più grande, timeout probabile su 10 000 header |
| `$top` | **obbligatoria** | `.limit(10000/5000/2000/1000/500)` | rischio OOM / timeout |
| `$skip` | desiderata | oggi la paginazione è in memoria (`:1754`); necessaria per rimuovere il `.limit(10000)` | resta in memoria |
| `$orderby` | desiderata | oggi in memoria (`:1749-1751`) | resta in memoria |
| `$inlinecount=allpages` | desiderata | CAP la genera per `SELECT.count` | `$count` resta calcolato in memoria |
| `substringof()` | **non richiesta** | la ricerca è già in memoria (commento `:1691-1694`) | nessun impatto |
| `$expand` | **non richiesta** | nessuna chiamata la usa | nessun impatto |

**Q7 — `$batch` è supportato dall'artefatto OData? E qual è il limite di lunghezza URL / query string del sender adapter?**
Se un GET supera `max_get_url_length` (default 1028), il runtime CAP converte **automaticamente e in silenzio** la richiesta in `POST <root>/$batch` `multipart/mixed`. Con 100 gruppi il `$filter` OR-espanso misura ~5 200 char (§6.1). Ci serve: `$batch` supportato **oppure** il limite esatto, così tariamo il chunking sotto quella soglia.

**Q8 — Page size massima e `__next`.**
Se la risposta contiene `d.__next`, **CAP non lo segue**: lo copia in una proprietà non-enumerabile che nessuno legge, quindi l'app vede solo la prima pagina e la considera il totale, **senza errori**. Ci serve sapere: (1) la page size massima per entity set; (2) se `__next` viene emesso e a quale soglia; (3) se un `$top` maggiore della page size viene **rispettato** o **troncato in silenzio**.

**Q9 — Il caso peggiore: 10 000 header senza filtro.**
`cat-service.js:1695` esegue `ProductionRoutingHeader?$select=<9 campi>&$top=10000`, **senza `$filter`** (plant e ricerca sono applicati in memoria dopo). Domande: (1) `ZMARS_ROUTING_HEADER_GET` regge 10 000 righe PLKO in una chiamata sincrona? (2) Qual è il timeout dell'iFlow e del sender adapter — noi portiamo CAP da 60 a 120 s, è compatibile? (3) Dimensione massima messaggio, e cosa succede al superamento: errore o troncamento? (4) **Alternativa preferibile**: un `$filter=Plant in (…)` (oggi 3 plant attivi) più `$orderby=ChangedDateTime desc` e `$top`/`$skip` reali eliminerebbe il `.limit(10000)`. È supportabile?

### Contratto dati

**Q10 — Nomi degli `EntitySet`.**
Devono essere identici a S/4: `ProductionRoutingHeader`, `ProductionRoutingOperation`, `ProductionRoutingCompAlloc`, `ProductionRoutingMatlAssgmt`. CAP indirizza l'entity set col nome dell'entity CSN così com'è. Nomi diversi = refactoring diffuso nel codice.

**Q11 — Tipi `Edm`, `Nullable`, formattazione.** In allegato il set minimo di campi per entity (§9.3). Richieste puntuali:

1. **Zeri iniziali NUMC preservati** su `ProductionRoutingSequence` (PLNFL), `ProductionRoutingOpIntID` (PLNKN), `ProdnRtgOpBOMItemInternalID`, `BillOfMaterialItemNodeNumber`, e CHAR con zeri su `ProductionRoutingGroup` (PLNNR) / `ProductionRouting` (PLNAL). **Sono chiavi persistite** nelle nostre tabelle: un `1` invece di `00000001` **orfanizza in silenzio i cicli Plex già salvati dagli utenti** (§6.4).
2. Date `DATS` come `Edm.DateTime` + `sap:display-format="Date"`, non `Edm.String`.
3. `ChangedDateTime` come `Edm.DateTimeOffset` — è il primo criterio di ordinamento della lista.
4. Quantità come `Edm.Decimal` con `Precision`/`Scale`, non `Edm.String`.
5. `MatlCompIsMarkedForBackflush` come `Edm.Boolean`, non `'X'`/`' '`.
6. **`PlanningWorkCenter` sull'header: da mantenere nell'esposizione.** Non è una richiesta di aggiunta — il campo esiste già nel modello S/4 v3 e l'applicazione **lo usa già** al posto della vecchia chiamata a `ProductionRoutingOperation` (§4.3). Serve solo la conferma che l'iFlow header lo esponga: senza di lui la banda header del dettaglio resta vuota.
7. ~~**Aggiunta richiesta: quantità e unità componente** (`STPO-MENGE`, `STPO-MEINS`) su `ProductionRoutingCompAlloc`.~~ **NON È PIÙ UNA DIPENDENZA** (W1-05, [DEC-68](../../docs/DECISIONI.md)). L'app non manda più `1` / `''`: quantità e unità si prendono dalla **distinta**, agganciando la riga per `(BillOfMaterial, BillOfMaterialItemNodeNumber)` — i due campi che l'assegnazione componenti già porta — con la stessa lettura che serve all'esplosione dei fantasma, quindi una sola chiamata in più per (ciclo, materiale). La richiesta **resta utile** e non la ritiriamo: con i due campi sul comp-alloc quella lettura sparirebbe. Ma non blocca più niente, quindi scende di priorità sotto tutte le altre di questo elenco.
8. **Header: quante versioni tornano?** L'app deduplica per `(Group, Routing)` tenendo la prima (`:1717-1721`). Se l'iFlow ritorna solo la versione attiva, la deduplica sparisce — confermate.

**Q12 — Autenticazione.**
Confermate che il sender adapter usa `ESBMessaging.send` e non un User Role custom, così creiamo la service key `it-rt`/`integration-flow` col `roles` giusto. Serve anche subaccount e subdomain CPI (per il `tokenurl`), e se preferite `binding-secret` o `x509`/mTLS.

**Q13 — Ambienti.**
Confermate che gli stessi nomi di artefatto esistono su entrambi gli host, così il `path` è identico nei profili `[hybrid]` e `[production]` e cambia solo l'URL della destination. Confermate anche che l'host test punta a un **ECC di test**.

**Q14 — Errori e osservabilità.**
(1) Formato del body d'errore (`error.message.value` OData standard?), così i nostri `catch` possono loggare qualcosa di utile invece di ingoiare (§5.1). (2) CAP invia sempre `x-correlation-id` e `x-correlationid`: vengono propagati nel Message Monitoring di CPI? (3) Qual è il codice HTTP per "opzione di query non supportata"? Deve essere 4xx/5xx, **non 200 con risultato filtrato diversamente**.

**Q15 — Anomalie del foglio.** Vedi §3.1: il path della riga 3 senza `/` iniziale, e la riga 8 con entity/FM che sembrano copiati dalla riga 7.

---

## 11. Verifica

### 11.1 Livello 1 — curl per service root, prima di scrivere codice

```bash
CPI_HOST='https://sd-integration-suite-dev-test-cf.it-cpi024-rt.cfapps.eu10-002.hana.ondemand.com'
ROOT="$CPI_HOST/gw/odata/SAP/F0491.87_OPERATIONS_SAPECC_SAPBTPMARS_PRODUCTIONROUTINGHEADER_QUERYGET;v=1"
TOKEN_URL='https://<subdomain-cpi>.authentication.eu10.hana.ondemand.com/oauth/token'
CID='<clientid>'; CSEC='<clientsecret>'

# T1 — token
TOKEN=$(curl -s -u "$CID:$CSEC" -d grant_type=client_credentials "$TOKEN_URL" | jq -r .access_token)
[ -n "$TOKEN" ] && [ "$TOKEN" != null ] && echo "OK token" || echo "KO token"

# T2 — $metadata -> checklist C1..C13
curl -s -H "Authorization: Bearer $TOKEN" "$ROOT/\$metadata" -o rtg-header.edmx
grep -o 'EntitySet Name="[^"]*"'       rtg-header.edmx | sort -u      # C2
grep -o 'EntityContainer Name="[^"]*"' rtg-header.edmx                # C1
grep -o '<PropertyRef Name="[^"]*"'    rtg-header.edmx                # C3
grep -o 'sap:display-format="[^"]*"'   rtg-header.edmx | sort -u      # C4/C8

# T3 — query reale con gli header che manda CAP (Accept: application/json,text/plain)
curl -sG -w '\nHTTP %{http_code} in %{time_total}s\n' \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json,text/plain' \
  -H 'x-correlation-id: probe-T3' -H 'x-correlationid: probe-T3' \
  "$ROOT/ProductionRoutingHeader" \
  --data-urlencode '$select=ProductionRoutingGroup,ProductionRouting,LastChangeDate,ChangedDateTime,CreationDate,BillOfOperationsDesc,BillOfOperationsStatus,ResponsiblePlannerGroup,Plant' \
  --data-urlencode '$top=100' --data-urlencode '$inlinecount=allpages' -o t3.json
jq '{righe:(.d.results|length), count:.d.__count, next:(.d.__next // "assente")}' t3.json   # Q8
jq '.d.results[0]' t3.json     # C4/C8: '/Date(…)/' o "20260727"? '00000001' o '1'?

# T4 — OR espanso, esattamente come lo genera CAP per { in: [...] }        Q6
curl -sG -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' \
  "$ROOT/ProductionRoutingHeader" \
  --data-urlencode "\$filter=(ProductionRoutingGroup eq '41710000' or ProductionRoutingGroup eq '41710001' or ProductionRoutingGroup eq '50000004')" \
  --data-urlencode '$top=500' | jq '.d.results|length'

# T5 — child collection: dal 17/08/2026 e' un _QUERYGET (DEC-45). USARE UN CICLO MULTI-OPERAZIONE:
#      con una sola operazione anche la forma sbagliata rispondeva 200.                Q1/Q2/Q3
OPROOT="$CPI_HOST/gw/odata/SAP/F0491.87_OPERATIONS_SAPECC_SAPBTPMARS_PRODUCTIONROUTINGOPERATION_QUERYGET;v=1"
# 5a) collection + $filter sui due criteri noti: ritorna la LISTA delle operazioni?
curl -sG -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' \
  "$OPROOT/ProductionRoutingOperation" \
  --data-urlencode "\$filter=ProductionRoutingGroup eq '41710000' and ProductionRouting eq '01'" \
  --data-urlencode '$top=500' \
  | jq '{forma:(if (.d|has("results")) then "d.results (OK)" else "singolo entry (KO)" end), n:(.d.results|length?)}'
# 5b) SOLO il gruppo: il ciclo deve essere una select-option facoltativa (buco di DEC-41)
curl -sG -o /dev/null -w 'solo gruppo: HTTP %{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "$OPROOT/ProductionRoutingOperation" \
  --data-urlencode "\$filter=ProductionRoutingGroup eq '41710000'"
# 5c) il plant nel $filter: non c'e' SO_PLANT, quindi ci si attende 4xx oppure 200-ignorata (R-6d)
curl -sG -o /dev/null -w 'filtro plant: HTTP %{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "$OPROOT/ProductionRoutingOperation" \
  --data-urlencode "\$filter=ProductionRoutingGroup eq '41710000' and Plant eq '1710'"

# T6 — probe opzioni: ogni riga deve dare 200-con-effetto o 4xx, MAI 200-ignorata    Q6
for OPT in '$orderby=ChangedDateTime desc' '$skip=10' '$top=1' "\$filter=Plant eq '1710'" '$select=ProductionRoutingGroup'; do
  printf '%-45s ' "$OPT"
  curl -sG -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
    -H 'Accept: application/json' "$ROOT/ProductionRoutingHeader" --data-urlencode "$OPT"
done

# T7 — caso peggiore: 10000 righe senza filtro (cat-service.js:1695)       Q9
curl -sG -w '\nHTTP %{http_code} in %{time_total}s, %{size_download} byte\n' \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' "$ROOT/ProductionRoutingHeader" \
  --data-urlencode '$top=10000' -o t7.json
jq '{righe:(.d.results|length), next:(.d.__next // "assente")}' t7.json

# T8 — $batch supportato?                                                  Q7
printf -- '--b1\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nGET ProductionRoutingHeader?$top=1 HTTP/1.1\r\nAccept: application/json\r\n\r\n\r\n--b1--\r\n' > b.txt
curl -s -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: multipart/mixed; boundary=b1' -H 'Accept: multipart/mixed' \
  --data-binary @b.txt "$ROOT/\$batch"

# T9 — 401 senza token
curl -s -o /dev/null -w 'senza token: HTTP %{http_code}\n' "$ROOT/ProductionRoutingHeader?\$top=1"
```

Ripetere T2/T3/T5 per **ogni** service root. Da incapsulare in `scripts/probe-is-routing.sh` (versionato, credenziali da env).

### 11.2 Livello 2 — destination end-to-end, senza avviare l'app

Isola il problema dal codice CAP. Riusa `executeHttpRequest`, già in uso a `srv/license.js:55`:

```bash
cd /home/user/projects/marsplm-plex
cds bind --exec --profile hybrid -- node -e "
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
(async () => {
  const r = await executeHttpRequest({ destinationName: 'MARS_IS_CON' }, {
    method: 'GET',
    url: '/gw/odata/SAP/F0491.87_OPERATIONS_SAPECC_SAPBTPMARS_PRODUCTIONROUTINGHEADER_QUERYGET;v=1/ProductionRoutingHeader?\$top=1',
    headers: { Accept: 'application/json' } });
  console.log('HTTP', r.status); console.log(JSON.stringify(r.data).slice(0, 800));
})().catch(e => { console.error('KO', e.message, e.response && e.response.status); process.exit(1); });
"
```

`cds bind --exec` inietta `VCAP_SERVICES`, quindi il Cloud SDK risolve la destination reale e fa il token exchange OAuth vero. Se passa, destination + OAuth + rete sono a posto.

### 11.3 Livello 3 — `cds watch --profile hybrid`

```bash
cd /home/user/projects/marsplm-plex
./fix-cds.sh                                        # se si arriva da una build MTA (cfr. fix-cds.md)

cds env get requires.mars_is_routing_header_queryget --profile hybrid
cds env get profiles --profile hybrid               # atteso: [ "hybrid", "development" ]

CDS_LOG_LEVELS_REMOTE=debug cds watch --profile hybrid
```

Il log `remote` stampa l'**URL completo** che CAP costruisce — verifica diretta della composizione `destination + path + entity set + opzioni` — **e rende visibile l'auto-`$batch`**:

```
URL of remote request exceeds the configured max length of 1028. Converting it to a $batch request.
```

**Se questa riga appare, §6.1 si è materializzato.**

### 11.4 Livello 4 — asserzioni sulla dashboard

L'endpoint CAP è OData v4 (`serviceUrl: "/production-routings/"`, `DashboardNavigation.controller.js:44`).

```bash
B=http://localhost:4004; G=41710000; R=01

# A1 — lista routing con count
curl -s "$B/production-routings/Routings?\$top=100&\$count=true" | jq '{count:."@odata.count", righe:(.value|length)}'

# A2 — clamp $top (readPaging: defTop 100, maxTop 500)  -> atteso 500
curl -s "$B/production-routings/Routings?\$top=1000" | jq '.value|length'

# A3 — plant selector
curl -s "$B/production-routings/Routings?\$top=100&plants=1710" | jq '[.value[].Plant]|unique'

# A4 — CAMPI ARRICCHITI NON VUOTI: se sono tutti "" la fan-out di :1766/:1783
#      è fallita in silenzio (§5.1). E' l'asserzione piu' importante.
curl -s "$B/production-routings/Routings?\$top=100" \
  | jq '{wc_vuoti:[.value[]|select(.PlanningWorkCenter=="")]|length,
         mat_vuoti:[.value[]|select(.Material=="")]|length, tot:(.value|length)}'

# A5 — formato date e chiavi (C4/C8/C9): NON devono comparire "20260727" ne' "1"
curl -s "$B/production-routings/Routings?\$top=5" \
  | jq -r '.value[]|"\(.ProductionRoutingGroup)|\(.ProductionRouting)|\(.LastChangeDate)"'

# A6 — operazioni del dettaglio (RoutingDetail.controller.js:139)
curl -s "$B/production-routings/RoutingOperations?\$filter=ProductionRoutingGroup%20eq%20'$G'%20and%20ProductionRouting%20eq%20'$R'" \
  | jq '{n:(.value|length), primo:.value[0]}'
# assert: ProductionRoutingOpIntID con zeri iniziali; Operation/OperationText/WorkCenterInternalID popolati

# A7 — componenti (RoutingDetail.controller.js:140)
curl -s "$B/production-routings/RoutingComponentAllocations?\$filter=ProductionRoutingGroup%20eq%20'$G'%20and%20ProductionRouting%20eq%20'$R'" \
  | jq '{n:(.value|length), primo:.value[0]}'
# assert: BillOfMaterialComponent non vuoto; MatlCompIsMarkedForBackflush true/false (non "X")

# A8 — guardie: filtro assente => [] (cat-service.js:1856-1859, :1917-1920)
curl -s "$B/production-routings/RoutingOperations" | jq '.value|length'            # atteso 0
curl -s "$B/production-routings/RoutingComponentAllocations" | jq '.value|length'  # atteso 0

# A9 — azioni: leggono header (:2049) e comp-alloc (:2068)
curl -s -X POST "$B/production-routings/autoAssignPlexCycle" -H 'Content-Type: application/json' \
  -d "{\"ProductionRoutingGroup\":\"$G\",\"ProductionRouting\":\"$R\"}" | jq '{Plant, HeaderMaterial, counts}'
# assert: Plant NON vuoto -> se vuoto, la lettura header e' fallita e :2058-2060 ritorna vuoto SENZA errore

# A10 — job batch (Header + MatlAssgmt con in-list)
cds bind --exec --profile hybrid -- npm run job-sync-routings
# assert nel log: NESSUN '[SYNC-ROUTING] ERRORE lettura ProductionRouting…' (syncRoutingsToPlex.js:99, :114)
```

**`USE_TEST_DATA_FILTER`** (`cat-service.js:1726`, `:1864`) è l'interruttore che rende il confronto deterministico:

| Valore | `Routings` (`:1726-1732`) | `RoutingOperations` (`:1864-1868`) | Uso |
|---|---|---|---|
| `true` | filtra sui 17 gruppi hard-coded di `TEMP_ROUTING_GROUPS` (`:1724`), **bypassa** plant attivi e licenza | non aggiunge `Plant in (attivi)` | **confronto old-vs-new**: set fisso e ripetibile |
| non impostata | `resolveEffectivePlants(req)` = Active ∩ licenziati ∩ `?plants=` | aggiunge `Plant in (attivi)`; se vuoto ⇒ `[]` | **collaudo di accettazione** |

Eseguire **entrambi**. Nota: `.cfignore` esclude `.env` proprio per evitare che sovrascriva `USE_TEST_DATA_FILTER` in produzione — non aggirare.

### 11.5 Livello 5 — confronto payload old-vs-new

Richiede che entrambi i path siano attivi contemporaneamente (switch di §12). Con `USE_TEST_DATA_FILTER=true`, per ognuno dei 17 gruppi: numero di righe, `Plant`, `Material`, ordinamento per `LastChangeDate`, insieme dei `BillOfMaterialComponent`, e **formato** di `ProductionRoutingOpIntID` / `BillOfMaterialItemNodeNumber`. §6.3 e §6.4 falliscono in silenzio, non con un errore: il diff campo-per-campo è l'unico modo di intercettarli.

---

## 12. Rollout e rollback

| # | Passo | Rischio | Note |
|---|---|---|---|
| 1 | **Probe** dei 7 `$metadata` + T5 (§11.1) | nullo | Tutto il resto è contingente. Risponde a Q1, Q2, Q3, Q8, Q11 |
| 2 | Pulizia `API_PRODUCTION_ROUTING_AVVALE` (§13.1) | nullo | Commit separato, indipendente |
| 3 | `routingSource.js` in `mode: 'legacy'` | nullo | Le rotte puntano tutte al path S/4 attuale: **no-op** byte-identico. Review isolata + test unitari |
| 4 | Rewiring delle 5 righe (§7.2), ancora `legacy` | basso | **Il chunking entra in vigore contro S/4**: già qui rimuove il `POST /$batch` che oggi parte a ogni pagina (§6.1). Valore indipendente dalla migrazione |
| 5 | Push-down del filtro plant a `:1695` (§6.2) + log di troncamento | basso | Ancora `legacy`, quindi confrontabile con la fonte nota |
| 6 | Conversione delle 5 letture child in key predicate (§7.3) | medio | Solo dopo Q1. Ancora `legacy` non è testabile (S/4 accetta il predicate ma con chiavi complete) → testare direttamente su CPI test |
| 7 | `[hybrid]` → `mode: 'cpi'`, host **test** | medio | Esercitare i 4 flussi UI + il job. Il log per chiamata (§7.1) conferma quale dei 7 root è stato usato |
| 8 | Riconciliazione campo-per-campo (§11.5) | — | §6.3/§6.4 falliscono in silenzio |
| 9 | `[production]` → `cpi` | alto | Kill switch documentato nel runbook |

**Rollback**: `mode` risolto da env var, così tornare a `legacy` è un **restart, non un redeploy**. `MARS_SAP_CON` resta configurata (la usano 7 servizi su 9), quindi il path on-prem resta raggiungibile per almeno una release.

### 12.1 Lotto 1 — LISTA della dashboard: implementato

Primo lotto rilasciato, marcato in tutto il codice con il tag **`[IS-ROUTING-LIST]`** (`grep -rn "IS-ROUTING-LIST"` restituisce l'intera modifica).

Perimetro: **solo** l'handler `READ Routings` (`cat-service.js`) e il fragment `RoutingsTab`. Le tab del dettaglio, le action, `findRoutingTestData` e il job continuano a usare `this.S4Routing` sul gateway on-premise, invariati.

| File | Modifica |
|---|---|
| `srv/lib/routingListSource.js` | **nuovo**: pool di istanze per service root, dispatch su entity, chunking delle liste `in`, rilevazione troncamento, switch `ROUTING_LIST_SOURCE` |
| `srv/cat-service.js` | `require` + `this.S4RoutingList`; nell'handler: `PlanningWorkCenter` nel `$select`, chiamata `:1766` commentata, `PlanningWorkCenter` dall'header |
| `app/…/fragments/RoutingsTab.fragment.xml` | colonna e cella *Work Center* commentate (allineate per posizione) |
| `package.json` | blocco `routingList` dentro la entry `cds.requires` esistente + `max_get_url_length: 4000` |

Chiamate SAP della lista: **da 3 a 2**. Entrambe usano i `_QUERYGET` già disponibili (righe 4 e 5 del foglio): nessun endpoint mancante.

Configurazione: **nessuna**. Gli iFlow sono il **default** — la lista è migrata, quindi non c'è niente da impostare per il funzionamento normale. Solo il ritorno indietro è esplicito: `ROUTING_LIST_SOURCE=ONPREM`, che è anche l'unico valore riconosciuto (case- e spazi-insensibile); qualsiasi altro valore lascia attivo IS.

Il chunking è attivo in entrambe le modalità, quindi rimuove il `POST /$batch` che partiva a ogni caricamento della lista anche contro il gateway on-premise.

**Effetto sullo sviluppo locale.** Con IS per default, `cds watch` prova a leggere la lista attraverso la destination `MARS_SAP_CON`: in un ambiente dove quella destination punta al gateway on-premise (§12.2), i due path `/gw/odata/...` non esistono e la lista risulta **vuota**. Per lavorare in locale sulla dashboard: `ROUTING_LIST_SOURCE=ONPREM cds watch`.

All'avvio il log dichiara sempre la modalità e, in IS, i service root usati:

```
>>> [IS-ROUTING-LIST] modalita' IS (default): lista routing dagli iFlow SAP Integration Suite, destination MARS_SAP_CON, 2 service root, chunk 15
>>> [IS-ROUTING-LIST]   ProductionRoutingHeader -> /gw/odata/SAP/F0491.87_..._PRODUCTIONROUTINGHEADER_QUERYGET;v=1
>>> [IS-ROUTING-LIST]   ProductionRoutingMatlAssgmt -> /gw/odata/SAP/F0491.87_..._PRODUCTIONROUTINGMATLASSGMT_QUERYGET;v=1
```

### 12.2 La destination `MARS_SAP_CON`: attenzione, non è la stessa in tutti i subaccount

Presso il cliente (subaccount *MARS - DEV&TEST - CF*) `MARS_SAP_CON` punta **già all'Integration Suite**:

| Proprietà | Valore |
|---|---|
| Description | `User Propagation Service to Integration Suite` |
| Proxy Type | `Internet` |
| URL | `https://sd-integration-suite-dev-test-cf.it-cpi024-rt.cfapps.eu10-002.hana.ondemand.com` (host nudo, come serve) |
| Authentication | **`OAuth2SAMLBearerAssertion`** |
| Token Service URL | `https://sd-integration-suite-dev-test-cf.authentication.eu10.hana.ondemand.com/oauth/token/alias/…` (Dedicated, Basic credentials) |

Quindi per quel subaccount **non serve nessuna destination nuova**: `routingList.destination = "MARS_SAP_CON"` è già corretto.

Nell'ambiente di sviluppo Avvale, invece, la destination omonima punta a `https://s4hanalab.r53.avvale.com` (il gateway on-premise): lì una chiamata a `/gw/odata/SAP/…_PRODUCTIONROUTINGHEADER_QUERYGET;v=1/ProductionRoutingHeader` risponde `503 Service Not Available — No system found`, perché il Web Dispatcher non instrada quel path. **Stesso nome, due host diversi**: il probe va sempre eseguito contro il subaccount di destinazione, non in locale.

**Conseguenza di `OAuth2SAMLBearerAssertion`: serve il JWT dell'utente.** CAP lo inoltra (`remote/Service.js:283-287`, che lo prende da `cds.context.user.authInfo.token.jwt` e in fallback dall'header `Authorization`), e il Cloud SDK esegue lo scambio SAML bearer. Due implicazioni:

- La **lista della dashboard** è una richiesta di un utente autenticato via approuter/xsuaa → il JWT c'è, funziona.
- Un processo **senza contesto utente** non ha JWT e lo scambio non può avvenire. Riguarda `jobs/syncRoutingsToPlex.js` (Job Scheduler): fuori dal perimetro del lotto 1, ma da verificare separatamente se in quel subaccount deve continuare a funzionare.

**Da controllare prima del deploy**: se `MARS_SAP_CON` è stata *ripuntata* dal gateway on-premise all'Integration Suite, gli altri 8 servizi che la usano con path `/sap/opu/odata/sap/API_*` (Product, Production Order, Confirmation, BOM, CLFN ×2, Material Document) non trovano più quei path. Vedi l'inventario in §8.3.

---

## 13. Appendice

### 13.1 Pulizia indipendente da questa migrazione

`package.json` → `cds.requires.API_PRODUCTION_ROUTING_AVVALE` dichiara `model: "srv/external/API_PRODUCTION_ROUTING_AVVALE"`, ma **quel file non esiste**. Il `using` è commentato a `srv/cat-service.cds:10` e nessun codice fa `cds.connect.to('API_PRODUCTION_ROUTING_AVVALE')`. È stato superato da `sap_s4_OP_API_PRODUCTION_ROUTING_0003_v3`. Dangling puro: rimuovere la entry e la riga commentata.

### 13.2 Gli altri flussi del foglio

Righe 9–16: `A_Product`, `A_ProductPlant`, `A_ProductDescription` (Product) e `A_ProductionOrder_2`, `A_ProductionOrderOperation_2`, `A_ProductionOrderComponent_2` (Production Order). Stesso split GET/QUERYGET, stessi rischi.

Consumatori: `cat-service.js:956` / `:1057` (servizi `Product` e `ProductionOrder`), `jobs/syncMaterialsToPlex.js`, `jobs/createPlexProductionOrders.js`, `jobs/postProdOrderConfirmation.js`.

Da notare: `A_ProductionOrderComponent_2` ha chiave `(Reservation, ReservationItem)` ma il codice lo filtra sempre per `ManufacturingOrder`, che **non è una chiave** — quindi lì il key predicate non è un'opzione, serve un `_QUERYGET`. Da verificare quando si arriva a quel perimetro.

> **Aggiornato il 2026-08-10, con due misure sul tenant di test.** La nota sopra concludeva che sui componenti «serve un `_QUERYGET`»: la conclusione resta, ma nel frattempo la forma collection si è rivelata **non interrogabile affatto** su questi service root — `A_ProductionOrderComponent_2?$filter=…` risponde `500 · OData operation: GET_FEED is not configured`, lo stesso difetto di `PRODUCT_DESCRIPTION_GET`. Quindi:
>
> - **Operazioni**: situazione favorevole come su `ProductionRoutingOperation`. La chiave è `(AUFPL, APLZL)` e l'**AUFPL è un campo di `A_ProductionOrder_2`**, letto prima delle operazioni da tutti i percorsi: lettura **per chiave** con l'`APLZL` a uno **spazio** — §4.2 applicato a un'altra entity, con la differenza che qui la stringa vuota non è accettata e lo spazio sì. Il numero d'ordine **non** viene spinto — con il `$filter` accanto al predicate l'indirizzo risponde `500` — e si verifica sulle righe lette.
> - **Componenti**: anche qui la chiave arriva dalla testata, per accordo col team Integration: il RSNUM è veicolato nel campo **`MasterProductionOrder`** (un contenitore: il suo significato SAP sarebbe `MAUFNR`). Lettura per chiave `(Reservation='<RSNUM>',ReservationItem='%20')`, nessun `$filter`, nessun `$top`. Cade quindi la conclusione «serve un `_QUERYGET`»: resta da confermare che l'item a uno spazio valga «tutte le posizioni» (R-2, punto a).
>
> Vedi DEC-42 e i contratti E-14 ed E-15.

Il modulo di §7.1 va scritto generico (`remoteSource(baseName, routeTable)`) proprio per essere riusato qui: il routing è il pilota di altri due flussi.
