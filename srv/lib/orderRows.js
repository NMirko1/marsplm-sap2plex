/**
 * [ORDER-ROWS] LA lettura del perimetro ordini: una sola, per il cockpit e per il job.
 *
 * PERCHE' QUESTO FILE ESISTE. Il 01-02/09/2026 il job `PROD_ORDER` ha letto zero ordini per due
 * giorni mentre la lista del cockpit, sullo STESSO service root e per lo STESSO plant, ne leggeva
 * 41. Le due letture erano scritte in due punti che non condividevano niente, e differivano in due
 * modi che nessuno aveva mai messo a confronto:
 *
 *   1. il `$select` — 21 colonne il cockpit, 13 il job (piu' i campi dei criteri in entrambi);
 *   2. l'ORDINE dei parametri nell'URL: `$select&$top&$filter` il cockpit,
 *      `$select&$filter&$top` il job.
 *
 * Il secondo e' quello che non si trova ragionando, e vale la pena capirlo una volta per tutte:
 * `cqn2odata` (node_modules/@sap/cds/libx/odata/parse/cqn2odata.js) costruisce le query option con
 * un `for…in` sull'oggetto `SELECT`, e i builder di `cds.ql` assegnano le chiavi NELL'ORDINE IN CUI
 * LI CHIAMI. Quindi `.columns().limit().where()` e `.columns().where().limit()` producono due URL
 * diversi carattere per carattere, a semantica identica. Chi confronta due chiamate su un log —
 * o chiede a un team esterno «perche' questa risposta e' vuota?» — deve poter dire che le due
 * richieste sono le stesse, e finora non era vero.
 *
 * QUAL E' L'ORDINE GIUSTO: QUELLO DEL COCKPIT. `.columns().limit().where()`. Non perche' sia piu'
 * bello, ma perche' la richiesta del cockpit e' l'unica con un esito buono OSSERVATO (41 righe): si
 * allinea il chiamante rotto a quello che funziona, mai il contrario. Se un giorno serve cambiarlo,
 * si cambia QUI e cambia per tutti.
 *
 * DUE ELENCHI, E NON SI FONDONO.
 *   `LIST_COLUMNS` (21) e' cio' che serve alla lista: comprende i campi che la dashboard MOSTRA.
 *   `HEAD_COLUMNS` (13) e' il minimo per operare su un ordine: lo usano le letture PER CHIAVE delle
 *   azioni manuali (createJobInPlex, prepareSplit, la sonda). Fonderli farebbe ereditare a quelle
 *   letture anche `OrderLongText`, che e' il campo caro — vedi il blocco qui sotto.
 *
 * IL PREZZO DI `OrderLongText`, DICHIARATO. Non e' un campo di tabella nemmeno su S/4: e' testo
 * lungo STXH/STXL via `READ_TEXT`, e srv/external/ECC_ProductionOrder_Sourcing.md la chiama «la
 * lettura piu' costosa», da rendere opzionale con un flag. Oggi l'iFlow lo consegna VUOTO (DEC-83,
 * contratto E-13), quindi allinearlo costa zero. Ma l'asimmetria va scritta: il cockpit legge UNA
 * PAGINA, il job legge il PERIMETRO INTERO col tetto di `listMaxRows()` (10000 di default). Il
 * giorno in cui la FM implementasse il `READ_TEXT`, «colonne identiche» significherebbe fino a
 * 10000 `READ_TEXT` in una chiamata di batch. Il rimedio, quel giorno, e' togliere QUESTA SOLA
 * colonna dalla lettura del job e DICHIARARLO — non scoprirlo da un timeout.
 *
 * COSA NON STA QUI, DI PROPOSITO. La superficie e' volutamente piccola: si costruisce ed esegue la
 * lettura di perimetro, e basta. Ricerca, ordinamento, paginazione, conteggio, filtro di stato a
 * valle e `identityGuard` restano di chi chiama, perche' il cockpit e il job ne fanno usi diversi e
 * un modulo che li assorbisse dovrebbe conoscere entrambi.
 *
 * FIN DOVE ARRIVA «IDENTICHE», DETTO CON PRECISIONE. I criteri di stato li risolvono entrambi i
 * chiamanti con la STESSA funzione (`prodOrderStatusFilter.resolveOrderScope`) e passano qui
 * `scope.byPlant`: per uno stesso plant i campi aggiunti al `$select` coincidono. L'unico modo in
 * cui le due stringhe possono ancora differire e' che differiscano gli INSIEMI DI PLANT — e quello
 * e' il gate di licenza, che deve restare diverso (vedi il blocco seguente). Con un plant solo, come
 * oggi, le due richieste sono la stessa a meno della destination.
 *
 * E NON STA QUI NEANCHE LA DERIVAZIONE DEI PLANT. Il `where` arriva GIA' COSTRUITO dal chiamante:
 * il cockpit deriva i plant da attivi ∩ selettore dell'utente, il job da attivi ∩ LICENZIATI. Sul
 * filo il valore e' lo stesso, ma le due derivazioni DEVONO restare diverse — il gate di licenza e'
 * il choke-point unico della 0001 e non si allinea per simmetria (0001, `getUsablePlants`).
 *
 * Il pattern e' quello dei materiali, per la stessa ragione: srv/lib/plantRows.js e
 * srv/lib/productRows.js sono i lettori condivisi fra server e job, con le colonne risolte in un
 * punto solo. Per gli ordini quel file non c'era, ed e' esattamente perche' i due elenchi hanno
 * potuto divergere. La rete e' test/orderRows.test.js.
 */

'use strict';

const prodOrderSource = require('./prodOrderSource');
const prodOrderStatusFilter = require('./prodOrderStatusFilter');

/**
 * [ORDER-ROWS] Le colonne della LISTA: i 20 campi del contratto E-13 piu' l'AUFPL.
 *
 * [IS-FULL-KEY] `OrderInternalBillOfOperations` (AUFPL) e' additivo e non si mostra: e' il criterio
 * della lettura delle operazioni dell'ordine, e viaggia con la riga fino al dettaglio perche' quella
 * lettura non debba ri-leggere la testata (DEC-42). Senza di esso la lettura non e' eseguibile su
 * questo canale e viene dichiarata invece che tentata (DEC-45).
 *
 * L'ordine dei nomi e' parte del contratto: e' l'ordine in cui finiscono nel `$select`.
 */
const LIST_COLUMNS = Object.freeze([
  'ManufacturingOrder',
  'OrderInternalBillOfOperations',
  'MasterProductionOrder',
  'ManufacturingOrderType',
  'Material',
  'ProductionPlant',
  'TotalQuantity',
  'ProductionUnit',
  'MfgOrderPlannedStartDate',
  'MfgOrderPlannedEndDate',
  'MfgOrderCreationDate',
  'MfgOrderConfirmedYieldQty',
  'ProductionSupervisor',
  'ProductionVersion',
  'SalesOrder',
  'SalesOrderItem',
  'OrderIsReleased',
  'OrderIsConfirmed',
  'OrderIsClosed',
  'OrderIsDeleted',
  'OrderLongText'
]);

/**
 * [ORDER-ROWS] Il minimo per OPERARE su un ordine, senza i campi che servono solo a mostrarlo.
 *
 * Lo usano le letture PER CHIAVE delle azioni manuali (createJobInPlex, prepareSplit, la sonda
 * ordine): la' `OrderLongText` non serve, e chiederlo sarebbe pagare il campo caro per niente.
 *
 * [IS-FULL-KEY] AUFPL e prenotazione (veicolata in `MasterProductionOrder`) sono le chiavi delle
 * letture di operazioni e componenti fatte da `loadOrderDetails` (DEC-42): senza di esse quelle
 * letture degradano.
 *
 * E' un PREFISSO di `LIST_COLUMNS` a meno dei campi di sola visualizzazione — un test lo asserisce,
 * perche' e' cio' che rende la lettura del job un sottoinsieme di quella del cockpit e non una
 * lista parallela.
 */
const HEAD_COLUMNS = Object.freeze([
  'ManufacturingOrder',
  'OrderInternalBillOfOperations',
  'MasterProductionOrder',
  'ManufacturingOrderType',
  'Material',
  'ProductionPlant',
  'TotalQuantity',
  'ProductionUnit',
  'MfgOrderPlannedStartDate',
  'MfgOrderPlannedEndDate',
  'OrderIsReleased',
  'OrderIsClosed',
  'OrderIsDeleted'
]);

/** I due insiemi ammessi. `list` e' quello delle letture di perimetro, cockpit E job. */
const KINDS = Object.freeze({ list: LIST_COLUMNS, head: HEAD_COLUMNS });

/**
 * [ORDER-ROWS] Le colonne da chiedere: elenco fisso piu' i campi citati dai criteri di stato.
 *
 * Senza i campi dei criteri il criterio non sarebbe valutabile e il fail-closed svuoterebbe la
 * lista. La deduplica NON e' una ridondanza innocua da lasciar passare: un nome ripetuto nel
 * `$select` e' una richiesta malformata, e `ManufacturingOrderType` / `ProductionSupervisor` — i due
 * campi dei criteri su VALORE — sono gia' negli elenchi fissi.
 *
 * FUNZIONE PURA. `prodOrderStatusFilter.selectColumns` accetta indifferentemente una `Map`
 * plant→criteri o un iterabile di criteri, e rende i nomi in ordine DETERMINISTICO (ordine del
 * catalogo degli stati, poi i campi valore): stesso input, stesso output, per il cockpit come per
 * il job. E' questa proprieta' che rende le due stringhe `$select` identiche e non solo equivalenti.
 *
 * @param {'list'|'head'} kind quale elenco fisso
 * @param {Map<string, object>|Iterable|null} cfgs i criteri per plant; `null` = nessun criterio
 * @returns {string[]} nomi di colonna, elenco fisso nell'ordine dichiarato, criteri in coda
 */
function columnsFor(kind, cfgs) {
  const fixed = KINDS[kind];
  if (!fixed) throw new Error(`[ORDER-ROWS] insieme di colonne ignoto: ${kind} (ammessi: list, head)`);
  return [...new Set([...fixed, ...prodOrderStatusFilter.selectColumns(cfgs)])];
}

/**
 * [ORDER-ROWS] Costruisce la query del perimetro. **L'ordine delle chiamate e' il contratto.**
 *
 * `.columns()` → `.limit()` → `.where()`, cioe' l'ordine del cockpit, cioe' `$select&$top&$filter`
 * sul filo. Il perche' e' in testa al file: `cqn2odata` itera le chiavi dell'oggetto `SELECT` con un
 * `for…in`, e i builder le assegnano nell'ordine di chiamata. Invertire due righe qui cambia l'URL
 * senza cambiare la semantica — cioe' rompe in silenzio l'unica cosa che questo modulo esiste per
 * garantire. `test/orderRows.test.js` asserisce l'ordine delle chiavi.
 *
 * Il secondo `where` non aggiunge una chiave: `cds.ql` fonde in AND sulla stessa (Whereable.js).
 *
 * @param {object} entity la definizione CSN `A_ProductionOrder_2` (da `s4.entities`)
 * @param {{columns: string[], cap: number, where: object, extraWhere?: object}} o
 */
function buildScopeQuery(entity, o) {
  const query = SELECT.from(entity).columns(...o.columns).limit(o.cap);
  query.where(o.where);
  if (o.extraWhere) query.where(o.extraWhere);
  return query;
}

/**
 * [ORDER-ROWS] Legge il perimetro ordini. E' LA lettura: cockpit e job passano da qui.
 *
 * NON lancia di suo: propaga l'errore della sorgente, perche' i due chiamanti lo trattano in modo
 * diverso (il cockpit lo trasforma in un `req.reject` con messaggio, il job in una voce di recap) e
 * inghiottirlo qui renderebbe una lettura fallita indistinguibile da un perimetro vuoto — che e'
 * esattamente l'ambiguita' costata i due giorni.
 *
 * @param {object} s4 la sorgente d'area (`prodOrderSource()`), da cui `entities` e `run`
 * @param {object} o
 * @param {object} o.where criterio GIA' COSTRUITO dal chiamante (vedi la testata: la derivazione
 *        dei plant non sta qui)
 * @param {Map<string, object>|Iterable|null} [o.cfgs] criteri di stato per plant
 * @param {'list'|'head'} [o.kind='list'] quale elenco fisso
 * @param {object} [o.extraWhere] secondo criterio, fuso in AND (il filtro del client nel cockpit)
 * @param {number} [o.cap] tetto; per default quello d'area, uno solo per server web e job
 * @returns {Promise<{rows: object[], columns: string[], cap: number}>} `columns` e `cap` tornano al
 *          chiamante perche' li DICHIARA nei suoi log e nel recap: sono i due numeri con cui si
 *          confrontano due letture.
 */
async function readOrdersInScope(s4, o) {
  const columns = columnsFor(o.kind || 'list', o.cfgs);
  const cap = Number.isFinite(o.cap) ? o.cap : prodOrderSource.listMaxRows();
  const query = buildScopeQuery(s4.entities.A_ProductionOrder_2, {
    columns, cap, where: o.where, extraWhere: o.extraWhere
  });
  const rows = await s4.run(query);
  return {
    rows: Array.isArray(rows) ? rows : (rows ? [rows] : []),
    // Il `$count` remoto arriva come proprieta' NON enumerabile: chi lo vuole lo legge da `raw`.
    raw: rows,
    columns,
    cap
  };
}

module.exports = {
  LIST_COLUMNS,
  HEAD_COLUMNS,
  columnsFor,
  buildScopeQuery,
  readOrdersInScope
};
