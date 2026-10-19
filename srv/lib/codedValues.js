// [CODED-VALUES] Le colonne il cui valore memorizzato NON e' quello che l'utente legge.
//
// IL CASO, ed e' uno solo oggi. Nella scheda «Auto-assegnazione» la colonna «Operazione» mostra il
// testo della tendina. Per un'operazione Plex concreta quel testo e' `CODICE - Nome`, ed e'
// memorizzato in `PlexOperationName`. Per i due pseudo-valori «Prima operazione» e «Ultima
// operazione» invece NON e' memorizzato niente — `onOperationChange` lascia il campo vuoto di
// proposito, perche' quelle due etichette sono TRADOTTE: scriverle nel dato metterebbe in colonna
// l'italiano se salva un italiano e l'inglese se salva un inglese, cioe' il difetto che DEC-92 ha
// tolto dagli storici invii. Il codice memorizzato resta `FIRST_OP` / `LAST_OP`.
//
// QUINDI SERVONO DUE STRADE, e passano tutte e due di qui:
//
//   - l'ORDINAMENTO (server, questo file): al posto del nome vuoto si rende l'etichetta risolta
//     nella lingua di chi chiede, cosi' «Prima operazione» sta sotto la P per un italiano e
//     «First Operation» sotto la F per un inglese;
//   - il FILTRO (browser, `app/adminconfigplant/webapp/util/codedValues.js`): il criterio digitato
//     si confronta con l'etichetta nella lingua corrente e, se aggancia, entra in OR
//     un'uguaglianza sul CODICE.
//
// QUI CI SONO SOLO CHIAVI i18n, MAI TESTI. E' cio' che rende il meccanismo indipendente dalle
// lingue installate: una lingua nuova e' un file `.properties` in piu' e nessuna riga di codice.
//
// LA COPIA E' VOLUTA E SORVEGLIATA. Il gemello sta sotto `app/`, in forma `sap.ui.define`, perche'
// a runtime il server NON puo' leggere i moduli dell'app: `mta.yaml` copia in `gen/srv` le sole
// cartelle `i18n`. Due dichiarazioni, quindi — e `test/adminColumnMenu.test.js` fallisce se
// divergono, come gia' fa per `columnSortRules.js`.
//
// Modulo PURO: nessuna dipendenza. Perimetro: grep -rn "CODED-VALUES"

'use strict';

const CODED_VALUES = {
  // La colonna su cui l'utente ordina e filtra -> dove sta il codice, e come si legge.
  PlexOperationName: {
    // Il campo che porta il codice. Sta nel `$select` dell'app perche' e' legato alla tendina.
    path: 'PlexOperation',
    // Il bundle da cui vengono le etichette: e' l'app che le possiede.
    app: 'adminconfigplant',
    // codice memorizzato -> chiave i18n. Mai il testo.
    labels: {
      FIRST_OP: 'opFirstOperation',
      LAST_OP: 'opLastOperation'
    }
  }
};

/** La dichiarazione della colonna, o `null` se quella colonna non ha valori codificati. */
function codedColumn(field) {
  return Object.prototype.hasOwnProperty.call(CODED_VALUES, field)
    ? CODED_VALUES[field]
    : null;
}

module.exports = { CODED_VALUES, codedColumn };
