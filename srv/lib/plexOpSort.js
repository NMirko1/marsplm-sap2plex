// [PLEX-OP-SORT] Ordinamento della lista di operazioni Plex mostrata all'utente.
//
// Plex restituisce le operazioni (`GET /mdm/v1/operations`) nell'ordine che decide lui: non e'
// alfabetico e non e' garantito stabile fra due chiamate. Quello stesso elenco compare in quattro
// schermate — dialog «Aggiungi Operazioni» del dettaglio ciclo, del template ciclo e del dettaglio
// ordine, piu' la tendina «Operazione Plex» dell'assegnazione automatica — e tutte leggono
// l'action `getPlexOperations`. Ordinare li', in un punto solo, e' cio' che tiene le quattro liste
// coerenti fra loro: quattro sort lato client sarebbero quattro punti da riallineare a mano, e il
// prossimo consumatore se ne dimenticherebbe.
//
// Modulo PURO: nessuna dipendenza da `cds` ne' dalla rete, cosi' la regola e' collaudabile senza
// sistemi esterni (`test/plexOpSort.test.js`).

// La chiave e' l'ETICHETTA CHE L'UTENTE LEGGE, non un campo scelto a tavolino: `name` se
// valorizzato, altrimenti `code`. Sul tenant Albacina `name` e' vuoto su tutte le operazioni ed e'
// `code` a portare il testo leggibile (`V090-Sgrassaggio+Veniciatura`), quindi ordinare per il solo
// `name` non sposterebbe niente; la forma `name || code` resta corretta se domani Plex popolasse
// `name`, senza dover tornare qui.
function plexOpSortKey(op) {
  if (!op || typeof op !== 'object') return '';
  return String(op.name || op.code || '').trim();
}

// [NATURAL-ORDER] Il confronto non e' piu' qui: sta in `srv/lib/naturalOrder.js`, ed e' lo STESSO
// che ordina le due liste editabili della configurazione plant (DEC-102). La regola non e'
// cambiata — numeri confrontati come numeri (`V90` precede `V100` anche senza zeri di
// riempimento), maiuscole e accenti ininfluenti, chiave vuota IN FONDO perche' una riga senza
// etichetta non deve aprire l'elenco — e' cambiato solo dove vive. Una seconda copia sarebbero due
// elenchi ordinati in modo diverso nella stessa applicazione, ed e' proprio cio' che nessuno
// noterebbe. Il test di questo file e' rimasto invariato: e' la prova che l'estrazione non ha
// toccato la tendina.
const { compareValues: compareLabels } = require('./naturalOrder');

// Restituisce una NUOVA array ordinata: l'ingresso non viene mutato, perche' chi chiama passa il
// risultato di un `map` che potrebbe voler riusare.
function sortPlexOperations(ops) {
  if (!Array.isArray(ops)) return [];

  return [...ops].sort((a, b) => {
    const byLabel = compareLabels(plexOpSortKey(a), plexOpSortKey(b));
    if (byLabel !== 0) return byLabel;

    // Tie-break su `code` e poi su `id`: senza, due operazioni con la stessa etichetta potrebbero
    // scambiarsi di posto fra una chiamata e l'altra a seconda dell'ordine in cui Plex le consegna,
    // e la lista «ordinata» risulterebbe diversa a ogni riapertura del dialog. L'ordine deve essere
    // TOTALE, non solo alfabetico.
    const byCode = compareLabels(
      String((a && a.code) || '').trim(),
      String((b && b.code) || '').trim()
    );
    if (byCode !== 0) return byCode;

    return compareLabels(
      String((a && a.id) || '').trim(),
      String((b && b.id) || '').trim()
    );
  });
}

module.exports = { plexOpSortKey, sortPlexOperations };
