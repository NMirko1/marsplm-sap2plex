sap.ui.define([], () => {
    "use strict";

    // ================================================================
    // [CODED-VALUES] Le colonne il cui valore memorizzato NON e' quello che l'utente legge.
    //
    // Gemello di `srv/lib/codedValues.js`, e la spiegazione completa sta la'. In breve: nella
    // colonna «Operazione» dell'auto-assegnazione i due pseudo-valori «Prima operazione» e «Ultima
    // operazione» hanno `PlexOperationName` VUOTO, perche' la loro etichetta e' TRADOTTA e una
    // traduzione non si persiste (DEC-92). Il codice memorizzato resta `FIRST_OP` / `LAST_OP`.
    //
    // Questa copia serve al FILTRO: `ColumnMenu` risolve l'etichetta dal bundle nella lingua
    // corrente e, se il criterio digitato la aggancia, mette in OR un'uguaglianza sul codice —
    // cosi' si cerca cio' che si vede, in qualunque lingua. L'ORDINAMENTO fa la strada gemella sul
    // server, dove risolve l'etichetta e ordina su quella.
    //
    // SOLO CHIAVI i18n, MAI TESTI: e' cio' che rende il meccanismo indipendente dalle lingue
    // installate. Una lingua nuova e' un file `.properties` in piu' e nessuna riga di codice.
    //
    // PERCHE' UNA COPIA E NON UN IMPORT: a runtime il server non puo' leggere i moduli dell'app —
    // `mta.yaml` copia in `gen/srv` le sole cartelle `i18n` — e l'app non puo' leggere `srv/lib`.
    // La divergenza la sorveglia `test/adminColumnMenu.test.js`, che carica i due file e li
    // confronta.
    //
    // Nessuna dipendenza (`sap.ui.define([])`): e' cio' che lo rende collaudabile da node.
    // Perimetro: grep -rn "CODED-VALUES"
    // ================================================================

    const CODED_VALUES = {
        PlexOperationName: {
            path: "PlexOperation",
            app: "adminconfigplant",
            labels: {
                FIRST_OP: "opFirstOperation",
                LAST_OP: "opLastOperation"
            }
        }
    };

    /** La dichiarazione della colonna, o `null` se quella colonna non ha valori codificati. */
    function codedColumn(sField) {
        return Object.prototype.hasOwnProperty.call(CODED_VALUES, sField)
            ? CODED_VALUES[sField]
            : null;
    }

    return { CODED_VALUES, codedColumn };
});
