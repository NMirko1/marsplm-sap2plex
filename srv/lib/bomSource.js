/**
 * [IS-SOURCE] Sorgente dati dell'area DISTINTA BASE.
 *
 * PERCHE' ESISTE
 * Nato per la sonda della distinta base (rimossa il 03/09/2026), che mandava le letture ai service root
 * dell'Integration Suite passando dallo stesso meccanismo delle altre aree: un'istanza remota per
 * coppia (entity, operazione), destination e timeout dal `package.json`. Il consumatore storico
 * — `buildBomNodeMap` in cat-service.js, `cds.connect.to` diretto sul path
 * `/sap/opu/odata/sap/API_BILL_OF_MATERIAL_SRV` — non è più referenziato da quando c'è il
 * comp-alloc v3.
 *
 * DA ORA C'E' ANCHE UNA LETTURA D'ESERCIZIO: [ROUTING-BY-MATERIAL] `resolveMaterialBomKeys` in
 * cat-service.js interroga `MaterialBOM` (= `MAST`) per materiale + plant, per sapere QUALE
 * distinta appartiene a un materiale e attribuirgli le assegnazioni componenti del ciclo
 * (`PLMZ` punta alla distinta, non al materiale). E' l'unica, e usa la sola forma `QUERY`.
 * ATTENZIONE alla forma della query: `MaterialBOM` ha DUE rotte, quindi un `SELECT.one`
 * verrebbe instradato sul root `_GET` la cui chiave comprende `BillOfMaterialCategory` e
 * `BillOfMaterialVariant` — i due valori che la lettura sta cercando. Sempre collection + `where`.
 *
 * I TRE INDIRIZZI PUBBLICATI (EndpointFlussiMARS_V1.xlsx, righe 17-19)
 *
 *   ExplodeBOM   GET            ..._BOM_EXPLODE_GET;v=1     FM ZMARS_BOM_EXPLODE_GET
 *   MaterialBOM  GET            ..._BOM_GET;v=1             FM ZMARS_BOM_GET
 *   MaterialBOM  QUERY          ..._BOM_QUERYGET;v=1        FM ZMARS_BOM_GET
 *
 * `ExplodeBOM` nel servizio SAP standard **non è una entity**: è un `FunctionImport` con
 * `m:HttpMethod="GET"` e 21 parametri (OP_API_BILL_OF_MATERIAL_SRV_0002.edmx). Sull'iFlow è
 * pubblicato come un `_GET` qualunque, cioè con la forma di una lettura per chiave, e come si
 * chiami davvero l'entity set esposto dal suo `$metadata` **non lo sa nessuno**: è la prima cosa
 * che la sonda verifica. Finché non risponde, il nome usato è quello della colonna *Entity* del
 * foglio, `ExplodeBOM`.
 *
 * PERCHE' LE `routes` SONO QUASI VUOTE DI COMPORTAMENTO
 * `rawGet` — il trasporto della sonda — scrive la query string a mano e NON passa da `plan()`,
 * quindi `keyPredicate`, `identity` e compagnia alla sonda non servirebbero. Le voci ci sono lo
 * stesso perché il ciclo che crea le istanze itera su `routes` (isRemoteSource.js:195-211): senza
 * la voce, nessuna istanza, e `rawGet` risponde «nessun service root configurato».
 * La lettura d'esercizio di `MaterialBOM` passa invece da `plan()`, e usa la sola voce `QUERY`,
 * che non ha bisogno di comportamento: è una collection con `$filter` e `$select`. Il
 * `keyPredicate` a 4 campi della voce `GET` resta dichiarato ma nessuno lo esercita — su un root
 * `_GET` sarebbe l'unica forma inviabile (DEC-42), e per questa lettura non è utilizzabile.
 *
 * Leva: BOM_SOURCE (IS = predefinito, ONPREM = pin sul canale storico).
 * Perimetro: `grep -rn "IS-SOURCE"`.
 */

'use strict';

const createRemoteSource = require('./isRemoteSource');

/** Entry cds.requires che porta il CSN della distinta base (DEC-18). */
const BASE = 'OP_API_BILL_OF_MATERIAL_SRV_0002';

/** Leva d'area, sulla falsariga di PRODUCT_SOURCE / PROD_ORDER_SOURCE / ROUTING_SOURCE. */
const ENV_VAR = 'BOM_SOURCE';

/** Il nome di ripiego dell'entity set dell'esplosione: quello del foglio, finché il $metadata tace. */
const E_EXPLODE = 'ExplodeBOM';
const E_BOM = 'MaterialBOM';

/**
 * Le sette chiavi dell'esplosione, NELL'ORDINE del `FunctionImport` standard. L'ordine non è
 * decorativo: è quello in cui la sonda scrive il key predicate, ed è quello che si gira al team
 * Integration se la lettura non passa.
 */
const EXPLODE_KEYS = Object.freeze([
  'BillOfMaterial',
  'BillOfMaterialCategory',
  'BillOfMaterialVariant',
  'BillOfMaterialVersion',
  'EngineeringChangeDocument',
  'Material',
  'Plant'
]);

/**
 * Comportamenti per (entity, operazione). Oggi portano il solo `identity`, che a `rawGet` non
 * serve: sono qui perché è da queste voci che nascono le istanze remote.
 *
 * [IS-BLANK-ROWS] `identity` sono i campi che rendono UTILIZZABILE una riga: se arrivano tutti
 * vuoti la riga è spazzatura anche dentro un `200` ben formato.
 */
const ROUTES = {
  // L'esplosione. Root `_GET`: la collection non è esposta, si legge per chiave completa.
  [E_EXPLODE]: {
    GET: { keyPredicate: [...EXPLODE_KEYS], identity: ['Material', 'Plant'] }
  },
  // La testata/posizioni della distinta, nelle due forme. Registrata ora perché è l'unico
  // indirizzo BOM con un `_QUERYGET`, cioè l'unico su cui una lista sarà interrogabile: la sonda
  // ne chiede il `$metadata` nella scala completa, e il passo successivo parte da lì.
  [E_BOM]: {
    GET: {
      keyPredicate: ['Material', 'Plant', 'BillOfMaterialCategory', 'BillOfMaterialVariant'],
      identity: ['BillOfMaterial']
    },
    QUERY: { identity: ['BillOfMaterial'] }
  }
};

const bomSource = createRemoteSource({
  base: BASE,
  envVar: ENV_VAR,
  area: 'distinta base',
  routes: ROUTES
});

module.exports = bomSource;
module.exports.BASE = BASE;
module.exports.ENV_VAR = ENV_VAR;
module.exports.ROUTES = ROUTES;
module.exports.EXPLODE_KEYS = EXPLODE_KEYS;
module.exports.E_EXPLODE = E_EXPLODE;
module.exports.E_BOM = E_BOM;
