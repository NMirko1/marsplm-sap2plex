// [NATURAL-ORDER] Il collatore del progetto: uno solo, e questo e' lui.
//
// PERCHE' ESISTE. `srv/lib/plexOpSort.js` aveva gia' la regola giusta — `localeCompare` con
// `numeric: true`, cosi' `V90` precede `V100` anche dove il codice non e' riempito a zeri, e i
// vuoti finiscono IN CODA invece di aprire l'elenco. Quando il menu di colonna delle liste
// editabili della configurazione plant ha avuto bisogno della stessa regola (DEC-102), la scelta
// era copiarla o estrarla: copiata, sarebbe diventata due collatori che possono divergere, cioe'
// due elenchi ordinati in modo diverso nella stessa applicazione. `plexOpSort.js` ora fa `require`
// di qui e la tendina non cambia di una virgola — lo dimostra il suo test, che e' rimasto
// invariato.
//
// PERCHE' L'ORDINAMENTO NON LO FA SQL. Sulle due liste della configurazione plant ordina il
// SERVER in Node, non il database: `$orderby` diventa un `ORDER BY` lessicografico, che su
// materiali a riempimento misto da' `000000101600, 1, 101600, 2, 3` — un elenco che a chi guarda
// sembra non ordinato. La collazione numerica di ECMA-402 in SQL non e' esprimibile, e nemmeno lo
// e' un `NULLS LAST` portabile.
//
// Modulo PURO: nessuna dipendenza da `cds` ne' dalla rete (`node test/naturalOrder.test.js`).

'use strict';

// `numeric: true`: i numeri dentro il testo si confrontano come numeri.
// `sensitivity: 'base'`: maiuscole e accenti non spostano l'ordine — `àlfa` sta al suo posto
// alfabetico e non dopo la Z, che e' la ragione per cui non si usa `<`.
const COLLATOR_OPTS = { numeric: true, sensitivity: 'base' };

/** Un valore e' VUOTO se non c'e' o se, ridotto a testo, e' tutto spazi. */
function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/**
 * Confronto di due VALORI (non di due righe).
 *
 * LA DIREZIONE ENTRA QUI, e non e' un vezzo: i VUOTI vanno in coda in salita **e in discesa**.
 * Se `desc` invertisse il risultato dall'esterno, i vuoti finirebbero in testa e chi ordina per un
 * campo si troverebbe davanti una colonna di celle bianche — cioe' esattamente le righe che non
 * stava cercando. Percio' il blocco dei vuoti sta FUORI dall'inversione, ed e' la stessa forma di
 * `comparatorFor` in `columnSortRules.js`.
 *
 * @param {*} a
 * @param {*} b
 * @param {boolean} [desc] vero per l'ordine discendente
 */
function compareValues(a, b, desc) {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  // `desc` non entra in questo blocco.
  if (ea && eb) return 0;
  if (ea) return 1;
  if (eb) return -1;
  const c = String(a).trim().localeCompare(String(b).trim(), undefined, COLLATOR_OPTS);
  return desc ? -c : c;
}

/**
 * Da `orderBy` CQN a comparatore di RIGHE.
 *
 * `orderBy` e' la forma che CAP mette in `req.query.SELECT.orderBy`:
 * `[{ ref: ['Campo'], sort: 'asc' | 'desc' }, …]`.
 *
 * `valueOf(row, field)` e' l'anello che serve alla colonna «Operazione»: il valore su cui ordinare
 * non e' sempre quello memorizzato. Le due voci «Prima operazione» e «Ultima operazione» hanno
 * `PlexOperationName` VUOTO — la loro etichetta e' tradotta, e una traduzione non si persiste
 * (DEC-92) — quindi chi chiama la risolve dal bundle nella lingua di chi guarda e la rende da qui.
 * Il default legge la proprieta' e basta.
 *
 * NESSUNO SPAREGGIO IMPLICITO: a parita' su tutti i campi si rende `0` e l'ordine d'arrivo resta.
 * `Array.prototype.sort` e' stabile, quindi due righe uguali non si scambiano fra una pagina e
 * l'altra. Chi ha bisogno di un ordine TOTALE aggiunge un campo chiave in coda a `orderBy` — e'
 * quello che fa `sortPlexOperations` con `code` e `id`.
 */
function cmpFromOrderBy(orderBy, valueOf) {
  const read = typeof valueOf === 'function'
    ? valueOf
    : (row, field) => (row ? row[field] : undefined);
  const terms = (Array.isArray(orderBy) ? orderBy : [])
    .map((o) => ({
      field: o && Array.isArray(o.ref) ? o.ref[o.ref.length - 1] : null,
      desc: !!(o && String(o.sort).toLowerCase() === 'desc')
    }))
    .filter((t) => !!t.field);

  return (a, b) => {
    for (const t of terms) {
      // La direzione la applica `compareValues`, o i vuoti uscirebbero dalla coda in discesa.
      const c = compareValues(read(a, t.field), read(b, t.field), t.desc);
      if (c !== 0) return c;
    }
    return 0;
  };
}

module.exports = { COLLATOR_OPTS, isEmpty, compareValues, cmpFromOrderBy };
