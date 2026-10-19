/**
 * [IS-SOURCE] Sorgenti dati dell'area CLASSIFICAZIONE PRODOTTO.
 *
 * PERCHE' ESISTE
 * È il punto unico in cui la classificazione sceglie il canale. Da qui passano DUE consumatori:
 * la lettura d'esercizio dell'auto-assegnazione (`srv/lib/clfnRead.js`, feature 0018) e la sonda
 * di diagnosi (rimossa il 03/09/2026). In modalità `IS` le letture vanno ai service root
 * dell'Integration Suite con lo stesso meccanismo delle altre aree — un'istanza remota per coppia
 * (entity, operazione), destination e timeout dal `package.json`; in `ONPREM` la classificazione
 * si continua a leggere col `$expand` a DUE livelli di sempre, e quella lettura NON passa da qui
 * (vedi il perché in testa a clfnRead.js).
 *
 * PERCHE' DUE SORGENTI E NON UNA
 * `createRemoteSource` prende UN SOLO `base`, cioè una sola entry `cds.requires`, perché è da
 * quella che eredita il modello CSN (DEC-18). La classificazione sta su DUE servizi: le classi e
 * le valorizzazioni su `OP_API_CLFN_PRODUCT_SRV`, l'anagrafica della caratteristica su
 * `OP_API_CLFN_CHARACTERISTIC_SRV`. Quindi due sorgenti, con la STESSA leva d'ambiente
 * `CLASSIFICATION_SOURCE`: sono un'area sola dal punto di vista di chi la commuta, e commutarne
 * metà non ha senso — la catena di letture le attraversa entrambe.
 *
 * QUALI OPERAZIONI ESISTONO, E QUALI NO
 * I sei indirizzi pubblicati (EndpointFlussiMARS_V1.xlsx, righe 23-28) NON coprono le due forme
 * per ogni entity, e la differenza decide la forma di ogni lettura:
 *
 *   A_ProductClass                  QUERY  ->  si filtra ($filter=Product eq ...)
 *   A_ClfnCharacteristicForKeyDate  QUERY + GET
 *   A_ClfnClassForKeyDate           GET    ->  solo per chiave
 *   A_ProductClassCharc             GET    ->  solo per chiave
 *   A_ProductCharcValue             GET    ->  solo per chiave
 *
 * Su un service root `_GET` la collection NON è esposta: `?$filter=...` risponde
 * `OData operation: GET_FEED is not configured` (misurato su E-15 il 2026-08-10, DEC-42). Le tre
 * entity GET-only si leggono quindi per key predicate COMPLETO, con le chiavi non note inviate
 * al loro valore iniziale (`keyPredicateBlanks`, DEC-41). Due di quelle chiavi sono NUMERICHE —
 * `CharcInternalID` (ATINN) e `CharcValuePositionNumber` (ATZHL) — e per esse il riempimento è
 * **`'0'`** e non lo spazio: lo spazio manda la funzione ABAP in `CX_SY_CONVERSION_NO_NUMBER`
 * (DEC-42). `ClassInternalID` (CLINT) è numerica per la stessa ragione.
 *
 * ATTENZIONE AL NOME DI UN INDIRIZZO
 * `A_ProductCharcValue` è pubblicato come `..._PRODUCTCHARVALUE_GET;v=1` — `CHARVALUE`, senza la
 * seconda `C`. È riportato VERBATIM dal foglio: se è un errore di battitura lo dice la sonda con
 * un `404`, non lo si corregge a tavolino.
 *
 * CHE FORMATO VUOLE IL NUMERO MATERIALE
 * `Product` è la chiave dell'oggetto classificato e va in formato interno ALPHA: `clfnKey`, qui
 * sotto, è la stessa regola che l'auto-assegnazione applica oggi. Se l'indirizzo la voglia o no
 * è una delle domande a cui risponde la sonda, che manda entrambe le forme.
 *
 * Leva: CLASSIFICATION_SOURCE (IS = predefinito, ONPREM = pin sul canale storico).
 * Perimetro: `grep -rn "IS-SOURCE"`.
 */

'use strict';

const createRemoteSource = require('./isRemoteSource');
// Le regole pure dell'area: le due forme della chiave e il class type stanno LI', perché sono
// collaudabili senza rete e le usa anche chi non parla con la sorgente.
const R = require('./clfnRules');

/** Entry cds.requires delle classi, delle caratteristiche di classe e delle valorizzazioni. */
const BASE_PRODUCT = 'OP_API_CLFN_PRODUCT_SRV';
/** Entry cds.requires dell'anagrafica caratteristica: è qui che il nome ATNAM diventa ATINN. */
const BASE_CHARC = 'OP_API_CLFN_CHARACTERISTIC_SRV';

/** Leva unica: le due sorgenti sono un'area sola per chi le commuta. */
const ENV_VAR = 'CLASSIFICATION_SOURCE';

/** Class type dei materiali. È l'unico in perimetro, come nella lettura di oggi. */
const CLASS_TYPE_MATERIAL = R.CLASS_TYPE_MATERIAL;

/**
 * Comportamenti per (entity, operazione) sul servizio delle classi.
 *
 * [IS-BLANK-ROWS] `identity` sono i campi che rendono UTILIZZABILE una riga: se arrivano tutti
 * vuoti la riga è spazzatura anche dentro un `200` ben formato (vedi `identityCheck` in
 * isQueryShape.js).
 */
const ROUTES_PRODUCT = {
  // L'unica entity dell'area con un _QUERYGET: le classi di un materiale si leggono filtrando.
  //
  // IL `fanOut` SU UN _QUERYGET È VOLUTO. `$filter=Product eq '<uno>'` è l'UNICA forma misurata
  // (sonda, variante PRD-CLS). Una lista multi-valore risponderebbe `200` anche se la funzione
  // ABAP dietro l'iFlow ne onorasse solo il primo elemento, e un insieme parziale è
  // indistinguibile da «gli altri materiali non sono classificati»: è la trappola di DEC-49.
  // Se il team Integration conferma le select-options multiple su SO_PRODUCT, togliere questa
  // riga fa scendere la lettura da N chiamate a N/chunkSize.
  A_ProductClass: {
    QUERY: { fanOut: 'Product', identity: ['Product', 'ClassInternalID'] }
  },
  // Nome leggibile della classe (CLINT -> `Class`). GET-only: una lettura per ogni classe del
  // materiale. Un _QUERYGET con `$filter=Class eq '...'` la collasserebbe in una sola: è una
  // richiesta da mettere a contratto, non un difetto dell'indirizzo.
  // `tolerant`: il nome di UNA classe che manda l'indirizzo in errore non deve azzerare i nomi
  // delle altre — le classi di un materiale sono indipendenti fra loro, e senza la tolleranza un
  // solo CLINT rotto renderebbe non verificabile l'appartenenza a QUALSIASI classe.
  A_ClfnClassForKeyDate: {
    GET: {
      keyPredicate: ['ClassInternalID'],
      fanOut: 'ClassInternalID',
      tolerant: true,
      identity: ['ClassInternalID']
    }
  },
  // Quali caratteristiche ha quella classe per quel prodotto. La terza chiave — l'ATINN — è nota
  // solo dopo la risoluzione del nome: quando non lo è, si invia a `0` = «tutte».
  // NON è `tolerant`: qui una chiave fallita si tradurrebbe in «la caratteristica non è di quella
  // classe», cioè in una condizione NON soddisfatta — un esito applicativo, non un dato mancante.
  // Meglio che la lettura risulti KO e l'auto-assegnazione lo DICHIARI (motivo NO_CLFN).
  A_ProductClassCharc: {
    GET: {
      keyPredicate: ['Product', 'ClassInternalID'],
      keyPredicateBlanks: ['CharcInternalID'],
      keyPredicateBlankValues: { CharcInternalID: '0' },
      fanOut: 'Product',
      expectsList: true,
      identity: ['Product', 'ClassInternalID', 'CharcInternalID']
    }
  },
  // IL VALORE. `CharcValuePositionNumber` (ATZHL) è il contatore delle valorizzazioni: non è
  // ricavabile a monte e si invia a `0` = «tutte le posizioni».
  // `tolerant` come sopra: le valorizzazioni di materiali diversi sono letture indipendenti, e le
  // righe già arrivate restano utilizzabili (la sorgente le appende all'errore in `partialRows`).
  A_ProductCharcValue: {
    GET: {
      keyPredicate: ['Product', 'ClassType', 'CharcInternalID'],
      keyPredicateBlanks: ['CharcValuePositionNumber'],
      keyPredicateBlankValues: { CharcValuePositionNumber: '0' },
      fanOut: 'Product',
      tolerant: true,
      expectsList: true,
      identity: ['Product', 'CharcInternalID', 'CharcValuePositionNumber']
    }
  }
};

/**
 * Comportamenti sul servizio dell'anagrafica caratteristica: ha entrambe le forme.
 *
 * Anche qui il `fanOut` sul _QUERYGET: `$filter=Characteristic eq '<uno>'` è la forma misurata, e i
 * nomi in gioco sono pochi e quasi sempre già in cache. Stesso motivo di `A_ProductClass`.
 */
const ROUTES_CHARC = {
  A_ClfnCharacteristicForKeyDate: {
    QUERY: { fanOut: 'Characteristic', identity: ['CharcInternalID'] },
    GET: { keyPredicate: ['CharcInternalID'], identity: ['CharcInternalID'] }
  }
};

/**
 * Chiave dell'oggetto classificato in formato interno ALPHA: un codice tutto numerico va
 * riempito di zeri a sinistra fino a 18 caratteri, uno alfanumerico passa così com'è. È la
 * stessa regola applicata oggi dall'auto-assegnazione (cat-service.js, `clfnKey`): duplicarla
 * qui sarebbe un secondo posto dove sbagliarla, per questo è esportata.
 *
 * **ATTENZIONE: questa è la regola del CANALE STORICO, e sull'Integration Suite NON vale.** Gli
 * indirizzi IS vogliono il numero materiale **nudo**, senza zeri iniziali — la conversione la fa la
 * funzione (indicazione del 2026-08-12). Le due forme convivono di proposito e si scelgono in base
 * al `mode` con `productKeyFor` (clfnRules.js): uniformarle è lo stesso genere di trappola
 * descritta in DEC-34.
 *
 * L'implementazione sta in `clfnRules.alphaKey`, che è collaudata senza rete; qui resta il nome
 * con cui la conoscono i due chiamanti storici.
 *
 * @param {string} material numero materiale come lo conosce l'applicazione
 * @returns {string} la chiave nel formato del canale storico
 */
const clfnKey = R.alphaKey;

const clfnProductSource = createRemoteSource({
  base: BASE_PRODUCT,
  envVar: ENV_VAR,
  area: 'classificazione',
  routes: ROUTES_PRODUCT
});

const clfnCharcSource = createRemoteSource({
  base: BASE_CHARC,
  envVar: ENV_VAR,
  area: 'classificazione (caratteristiche)',
  routes: ROUTES_CHARC
});

module.exports = {
  clfnProductSource,
  clfnCharcSource,
  clfnKey,
  CLASS_TYPE_MATERIAL,
  ENV_VAR,
  BASE_PRODUCT,
  BASE_CHARC,
  ROUTES_PRODUCT,
  ROUTES_CHARC
};
