/**
 * [IS-SOURCE] Sorgente dati dell'area CICLI DI LAVORAZIONE (area C, feature 0013).
 *
 * SOSTITUISCE srv/lib/routingListSource.js, che serviva la sola LISTA della dashboard
 * (lotto 1, tag [IS-ROUTING-LIST]). Ora l'intera area passa da qui: lista, tab del
 * dettaglio, action, ricerca dei dati di test e job di sincronizzazione dei cicli.
 *
 * Leva: ROUTING_SOURCE (IS = default, ONPREM = pin sul canale storico).
 * ALIAS ONORATO: ROUTING_LIST_SOURCE — è il rollback documentato del lotto 1 (DEC-21) e un
 * rilascio successivo non deve invalidarlo. Chi ha in mano quel runbook continua a poterlo
 * usare; la variabile nuova ha la precedenza se sono impostate entrambe.
 *
 * Il tag [IS-ROUTING-LIST] resta grep-abile nei blocchi già marcati di cat-service.js:
 * `grep -rn "IS-ROUTING-LIST\|IS-SOURCE"` restituisce il perimetro completo delle due tranche.
 */

'use strict';

const createRemoteSource = require('./isRemoteSource');

/** Entry cds.requires che porta il modello CSN condiviso da tutte le istanze (DEC-18). */
const BASE = 'sap_s4_OP_API_PRODUCTION_ROUTING_0003_v3';

/**
 * Comportamenti per (entity, operazione).
 *
 * - `ProductionRoutingHeader` e `ProductionRoutingMatlAssgmt` hanno il SOLO `_QUERYGET`: i
 *   due `_GET` corrispondenti (E-02, E-05 del contratto) dichiarano chiavi che
 *   l'applicazione non conosce (3 e 6 chiavi, l'app ne conosce 2-3) e NON sono configurati,
 *   così una richiesta che li riguardasse non trova rotta e la sorgente lancia, invece di
 *   essere instradata a un indirizzo diverso (FR-02). Le letture `SELECT.one` sulla testata
 *   restano quindi in forma collection con `$top=1`, come oggi (TD-4).
 * - `ProductionRoutingOperation` è una lettura padre->figli — si passa il ciclo e si attende la
 *   LISTA delle operazioni — e dal 17/08/2026 legge da un service root `_QUERYGET`: collection
 *   + `$filter` sui due soli criteri che l'applicazione conosce, `(Group, Routing)`. Prima era
 *   una lettura per chiave con il predicate COMPLETO a 5 chiavi, 2 note e 3 inviate vuote
 *   (DEC-41): da un indirizzo per chiave non esce una lista, e le 3 chiavi vuote non si
 *   inviano più. È la terza occorrenza della stessa forma sbagliata, dopo
 *   `A_ProductionOrderComponent_2` (DEC-43) e `ProductionRoutingCompAlloc` (DEC-44), e con
 *   `A_ProductionOrderOperation_2` chiude le tre aree di 0013. Vedi DEC-45.
 *   La forma sopravvive solo dove il `_QUERYGET` non è pubblicato: le due letture della
 *   CLASSIFICAZIONE (`clfnSource.js`, `A_ProductClassCharc` e `A_ProductCharcValue`).
 * - `ProductionRoutingCompAlloc` è la stessa lettura padre->figli, ed è passata a `_QUERYGET`
 *   lo stesso giorno, per lo stesso motivo: prima erano 6 chiavi, 2 note e 4 vuote. Vedi DEC-44.
 * - `ProductionRouting` è configurata per completezza del contratto: nessuna lettura la usa.
 *   Le sue 2 chiavi sono tutte note, quindi non ha `keyPredicateBlanks`.
 *
 * [IS-BLANK-ROWS] `identity` sono i campi che rendono UTILIZZABILE una riga di questa entity. Non
 * è la chiave OData completa: è ciò che l'applicazione legge e con cui identifica la riga (la
 * versione interna non viene mai selezionata). Serve a riconoscere una risposta `200` ben formata
 * e tutta a valori iniziali — il difetto misurato su E-13 il 06/08/2026: vedi `identityCheck` in
 * isQueryShape.js. Un campo non presente nel `$select` della lettura è escluso dal controllo.
 */
const ROUTES = {
  ProductionRoutingHeader: {
    QUERY: { identity: ['ProductionRoutingGroup', 'ProductionRouting'] }
  },
  ProductionRoutingMatlAssgmt: {
    QUERY: { identity: ['ProductionRoutingGroup', 'ProductionRouting', 'Product'] }
  },
  ProductionRoutingOperation: {
    // [IS-QUERYGET-RTGOP] collection + $filter su gruppo e ciclo, che i due call site già
    // compongono come `where`. Nessun predicate: vedi il blocco qui sopra e DEC-45.
    // Tag distinto da [IS-QUERYGET-OPS], che è la gemella nell'area ordini.
    QUERY: {
      identity: ['ProductionRoutingGroup', 'ProductionRoutingSequence', 'ProductionRoutingOpIntID']
    }
  },
  ProductionRoutingCompAlloc: {
    QUERY: {
      identity: ['ProductionRoutingGroup', 'ProductionRoutingOpIntID', 'ProdnRtgOpBOMItemInternalID']
    }
  },
  ProductionRouting: {
    GET: {
      keyPredicate: ['ProductionRoutingGroup', 'ProductionRouting'],
      identity: ['ProductionRoutingGroup', 'ProductionRouting']
    }
  }
};

const routingSource = createRemoteSource({
  base: BASE,
  envVar: 'ROUTING_SOURCE',
  envAliases: ['ROUTING_LIST_SOURCE'],
  area: 'cicli',
  routes: ROUTES
});

module.exports = routingSource;
module.exports.ROUTES = ROUTES;
