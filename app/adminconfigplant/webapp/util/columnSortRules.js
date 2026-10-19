sap.ui.define([], () => {
    "use strict";

    // ================================================================
    // [COLUMN-SORT] Regole di ordinamento e filtro per colonna.
    //
    // COSA C'E' QUI E COSA NO. Qui stanno le sole regole di CONFRONTO: come si ordinano due
    // valori e come si decide se una riga soddisfa un criterio. L'orchestrazione — leggere le
    // colonne, aprire il menu, applicare `Sorter` e `Filter` al binding — sta in ColumnMenu.js.
    // La separazione e' la stessa di `srv/lib/splitRules.js` accanto a `srv/lib/plexJobSplit.js`,
    // ed e' cio' che rende collaudabile da node una funzionalita' tutta di interfaccia.
    //
    // QUESTO FILE VIVE IN DUE APP, IDENTICO BYTE PER BYTE:
    //   app/marsplm-sap2plex/webapp/util/columnSortRules.js   (le tre liste della dashboard)
    //   app/adminconfigplant/webapp/util/columnSortRules.js   (le schede Gruppi e Auto-assegnazione)
    // Le due app sono due artefatti deployati separatamente sull'html5-repo e non possono
    // richiedersi moduli a vicenda, quindi la condivisione e' una COPIA — e una copia si
    // sorveglia: `node test/adminColumnMenu.test.js` fallisce se i due file divergono di un
    // carattere. Il pezzo che non deve avere due versioni e' `sortFromChangeEvent`: legge le due
    // forme dell'evento `change` di QuickSort, e leggerne una sola da' un click che sembra
    // raccolto e una lista che non si ordina (e' gia' costato un rilascio, vedi sotto).
    //
    // I DUE ORCHESTRATORI INVECE SONO DIVERSI, e non e' una svista. Sulla dashboard le righe
    // stanno in un `JSONModel` e il confronto lo fa il browser: `Filter` con `test` e `Sorter`
    // con comparatore. Nella configurazione plant le tabelle sono binding OData V4 IN SCRITTURA
    // (`operationMode: "Server"`), dove un `test` non verrebbe applicato affatto e un comparatore
    // sarebbe ignorato: la' il confronto lo fa il database, con `$filter` e `$orderby`. Stessa
    // regola, due modi di eseguirla — vedi DEC-102.
    //
    // Nessuna dipendenza: `sap.ui.define([])` senza moduli richiesti, come
    // `util/ApprovedWcConflicts.js` e `adminconfigplant/util/comboBoxContains.js`. Test:
    // `node test/columnSortRules.test.js`.
    // ================================================================

    /** I tre tipi di colonna che la dashboard conosce. Una colonna senza tipo e' `string`. */
    const TYPE_STRING = "string";
    const TYPE_NUMBER = "number";
    const TYPE_DATE = "date";

    /**
     * I valori di `sap.ui.core.SortOrder`, come letterali.
     *
     * Stanno QUI e non in ColumnMenu.js perche' sono parte della regola — `sortFromChangeEvent` li
     * confronta — e un modulo puro non puo' importare la libreria di UI5 senza smettere di essere
     * collaudabile da node. Sono tre stringhe stabili dal 2013.
     */
    const SORT_NONE = "None";
    const SORT_ASC = "Ascending";
    const SORT_DESC = "Descending";

    /**
     * Le opzioni del collatore, identiche a quelle di `srv/lib/naturalOrder.js`.
     *
     * `numeric: true` fa confrontare come numeri le cifre dentro il testo; `sensitivity: 'base'`
     * rende maiuscole e accenti ininfluenti sull'ORDINE (le stringhe qui arrivano gia' in
     * minuscolo da `norm`, quindi l'effetto vero e' sugli accenti: `è` sta accanto a `e`).
     * Sono duplicate perche' un modulo puro del browser non puo' richiedere un file di `srv/`, ed
     * e' la stessa ragione per cui questo file esiste in due app: vedi l'intestazione.
     */
    const COLLATOR_OPTS = { numeric: true, sensitivity: "base" };

    /**
     * Un valore e' VUOTO se non c'e' o se e' la stringa vuota.
     *
     * `0` e `'0'` NON sono vuoti: sulla colonna «Versato» un ordine con zero pezzi versati e' un
     * dato, e mandarlo in coda insieme a quelli non letti nasconderebbe proprio le righe che si
     * stanno cercando.
     */
    function isEmpty(vValue) {
        return vValue === null || vValue === undefined || String(vValue).trim() === "";
    }

    /** Normalizzazione per il confronto testuale: senza spazi ai bordi, minuscolo. */
    function norm(vValue) {
        return String(vValue === null || vValue === undefined ? "" : vValue).trim().toLowerCase();
    }

    /** Solo cifre: serve alle date, che arrivano come `2026-08-21` o come `20260821`. */
    function digits(vValue) {
        return String(vValue === null || vValue === undefined ? "" : vValue).replace(/\D/g, "");
    }

    /** Zeri iniziali tolti, ma mai fino alla stringa vuota: `'000'` resta `'0'`. */
    function stripLeadingZeros(sDigits) {
        const sStripped = sDigits.replace(/^0+/, "");
        return sStripped === "" ? "0" : sStripped;
    }

    // ================================================================
    // ORDINAMENTO
    // ================================================================

    /**
     * Il comparatore di una colonna.
     *
     * DUE SCELTE CHE VANNO INSIEME, e sono la ragione per cui la direzione entra QUI invece di
     * essere lasciata al `Sorter`.
     *
     * 1. I VUOTI STANNO SEMPRE IN CODA, in salita e in discesa. `sap.ui.model.Sorter` con
     *    `bDescending` nega il risultato del comparatore, e negando finirebbero in testa: chi
     *    ordina per data di fine si troverebbe davanti una colonna di celle bianche. Quindi il
     *    chiamante costruisce sempre `new Sorter(path, false, false, comparatorFor(tipo, desc))`
     *    e la discesa la applica il comparatore, dove i vuoti restano fuori dall'inversione.
     * 2. NESSUNO SPAREGGIO ESPLICITO. A parita' di valore il comparatore rende `0` e l'ordine
     *    d'arrivo resta: e' quello del server, gia' deterministico per costruzione (lo spareggio
     *    sulle chiavi di `byDateDescChain`). L'ordinamento di JavaScript e' stabile, quindi
     *    riordinare per una colonna con molti valori uguali non rimescola le righe.
     *
     * @param {string}  sType        `string` | `number` | `date` (ignoto => `string`)
     * @param {boolean} bDescending  vero per l'ordine discendente
     * @returns {function(*, *): number} comparatore di due VALORI (non di due righe)
     */
    function comparatorFor(sType, bDescending) {
        const iDir = bDescending ? -1 : 1;

        return function compare(vA, vB) {
            const bEmptyA = isEmpty(vA);
            const bEmptyB = isEmpty(vB);
            // Fuori dall'inversione: `iDir` non entra in questo blocco.
            if (bEmptyA && bEmptyB) { return 0; }
            if (bEmptyA) { return 1; }
            if (bEmptyB) { return -1; }

            if (sType === TYPE_NUMBER) {
                // I decimali OData arrivano come STRINGA: senza `Number` `'100'` verrebbe prima
                // di `'99'`, che e' il difetto piu' visibile di un ordinamento per quantita'.
                const fA = Number(vA);
                const fB = Number(vB);
                // Un valore che non e' un numero non e' «vuoto» — c'e', ma non e' confrontabile
                // come numero: si ripiega sul confronto testuale invece di dichiararlo uguale a
                // tutto, che lo lascerebbe fermo in una posizione qualsiasi.
                if (!Number.isNaN(fA) && !Number.isNaN(fB)) {
                    if (fA === fB) { return 0; }
                    return (fA < fB ? -1 : 1) * iDir;
                }
            } else if (sType === TYPE_DATE) {
                // Le sole cifre: cosi' `2026-08-21` e `20260821` si ordinano allo stesso modo, e
                // il confronto resta lessicografico perche' entrambe le forme sono monotone.
                const sA = digits(vA);
                const sB = digits(vB);
                if (sA && sB) {
                    if (sA === sB) { return 0; }
                    return (sA < sB ? -1 : 1) * iDir;
                }
            }

            const sA = norm(vA);
            const sB = norm(vB);
            if (sA === sB) { return 0; }
            // `localeCompare` e non `<`: sulle descrizioni le accentate devono stare al loro
            // posto alfabetico, non dopo la Z.
            //
            // `numeric: true`: i numeri DENTRO il testo si confrontano come numeri, quindi `1, 2,
            // 10` e non `1, 10, 2`, e `V90` prima di `V100`. Non e' un vezzo — su una colonna di
            // materiali a riempimento misto l'ordine lessicografico da'
            // `000000101600, 1, 101600, 2, 3`, che a chi guarda sembra un elenco non ordinato.
            // E' lo stesso collatore della tendina delle operazioni Plex e di
            // `srv/lib/naturalOrder.js`: uno solo in tutto il progetto (DEC-102).
            //
            // ATTENZIONE: da qui in poi anche una colonna `type="string"` ordina i numeri come
            // numeri. `type="number"` resta comunque necessario, e per una ragione che il test
            // dimostra: la collazione confronta le CIFRE, quindi su `9.5` e `9.25` guarda `5`
            // contro `25` e mette `9.5` per primo. Su un decimale vero serve `Number`.
            return sA.localeCompare(sB, undefined, COLLATOR_OPTS) * iDir;
        };
    }

    /**
     * Da evento `change` di `QuickSort` allo stato di ordinamento.
     *
     * PERCHE' QUESTA FUNZIONE ESISTE, e perche' legge DUE forme dello stesso evento.
     *
     * In UI5 1.142 i metadati di `sap.m.table.columnmenu.QuickSort` dichiarano
     * `change: {key: string, sortOrder: sap.ui.core.SortOrder}`, ma l'implementazione passa
     * tutt'altro:
     *
     *     QuickSort.prototype.onChange = function(e){ this.fireChange({item:e}); ... }
     *
     * Dichiarazione e implementazione non concordano. Leggere i parametri DICHIARATI rende
     * `undefined`, e il difetto e' muto in un modo particolarmente cattivo: `onChange` chiude
     * comunque il popover subito dopo `fireChange`, quindi a schermo sembra che il click sia stato
     * raccolto e semplicemente non ordini. E' successo davvero, ed e' costato un rilascio.
     *
     * Si leggono quindi entrambe, con precedenza ai parametri dichiarati: sono il contratto, e se
     * un giorno UI5 allineasse l'implementazione leggere il solo `item` si romperebbe allo stesso
     * modo silenzioso. La lezione generale: il contratto di un evento si legge sulla chiamata
     * `fire*`, non sui metadati.
     *
     * @param {{key?: string, sortOrder?: string, item?: object}} oParams
     *        i parametri dell'evento, gia' estratti dal chiamante
     * @returns {{field: string, descending: boolean}|null} `null` = nessun ordinamento
     */
    function sortFromChangeEvent(oParams) {
        const o = oParams || {};
        const oItem = o.item;
        const get = (sGetter) => (oItem && typeof oItem[sGetter] === "function")
            ? oItem[sGetter]()
            : "";
        const sField = String(o.key || get("getKey") || "").trim();
        const sOrder = String(o.sortOrder || get("getSortOrder") || "").trim();
        // Il primo dei tre pulsanti e' `None`: azzera l'ordinamento, non e' un caso d'errore.
        if (!sField || !sOrder || sOrder === SORT_NONE) { return null; }
        return { field: sField, descending: sOrder === SORT_DESC };
    }

    // ================================================================
    // FILTRO
    // ================================================================

    /**
     * Un valore soddisfa un criterio digitato dall'utente?
     *
     * IL CONFRONTO E' TOLLERANTE, ed e' la faccia giusta di DEC-51: da una parte c'e' un valore
     * scritto da SAP, dall'altra un testo battuto a mano. Qui un disallineamento sarebbe NOSTRO,
     * quindi si ignorano maiuscole, spazi ai bordi e zeri iniziali. E' l'opposto del confronto
     * fra due chiavi SAP, dove lo scarto e' un difetto a monte da vedere.
     *
     * Gli zeri iniziali si allineano SOLO fra due stringhe di sole cifre: `0100` e `100` sono lo
     * stesso materiale, ma `0100` e `A0100` non lo sono, e togliere gli zeri dentro un codice
     * alfanumerico farebbe agganciare righe che non c'entrano.
     *
     * @param {*}      vValue valore della cella
     * @param {string} sQuery testo digitato
     * @returns {boolean}
     */
    function matchesCriterion(vValue, sQuery) {
        const sNeedle = norm(sQuery);
        if (!sNeedle) { return true; }          // criterio vuoto = nessuna restrizione
        const sHay = norm(vValue);
        if (sHay.indexOf(sNeedle) !== -1) { return true; }
        if (/^\d+$/.test(sHay) && /^\d+$/.test(sNeedle)) {
            return stripLeadingZeros(sHay).indexOf(stripLeadingZeros(sNeedle)) !== -1;
        }
        return false;
    }

    /**
     * GLI AGHI DA CERCARE per un criterio, quando a cercare non e' il browser ma il DATABASE.
     *
     * E' la stessa regola di `matchesCriterion` — sottostringa, insensibile a maiuscole, spazi ai
     * bordi e zeri iniziali — resa esprimibile in un `$filter` OData: `contains` non sa togliere
     * gli zeri, quindi l'allineamento si ottiene cercando DUE aghi in OR. Chi digita `0100` trova
     * anche il materiale scritto `100`; il verso opposto lo copre gia' `contains` da solo.
     *
     * UNA DIFFERENZA DICHIARATA, ed e' la ragione per cui questa funzione non e' `matchesCriterion`
     * riscritta. Nel browser gli zeri si allineano solo fra DUE stringhe di sole cifre: `A0100` non
     * e' `A100`. Qui il pagliaio non e' guardabile — c'e' solo l'ago — quindi il secondo ago
     * aggancia anche dentro un codice alfanumerico. Il filtro lato server e' percio' un filo piu'
     * TOLLERANTE di quello lato browser: governa cio' che si VEDE, e la' un risultato in piu' e' un
     * fastidio visibile mentre uno in meno e' una sparizione silenziosa (DEC-53).
     *
     * @param {string} sQuery testo digitato
     * @returns {Array<string>} aghi normalizzati; vuoto se il criterio non restringe
     */
    function criterionNeedles(sQuery) {
        const sNeedle = norm(sQuery);
        if (!sNeedle) { return []; }
        const aOut = [sNeedle];
        if (/^\d+$/.test(sNeedle)) {
            const sStripped = stripLeadingZeros(sNeedle);
            // `!== sNeedle`: senza zeri iniziali il secondo ago sarebbe identico al primo, cioe'
            // un OR fra una condizione e se stessa — una riga in piu' nel `$filter` per niente.
            if (sStripped !== sNeedle) { aOut.push(sStripped); }
        }
        return aOut;
    }

    /**
     * L'ALBERO DEI CRITERI ATTIVI, come struttura di dati.
     *
     * PERCHE' UN ALBERO E NON UNA FUNZIONE CHE GUARDA LA RIGA. UI5 valuta i filtri di un binding
     * con il proprio albero di `sap.ui.model.Filter`, e la funzione `test` di una foglia riceve
     * il VALORE della cella, non la riga: una regola scritta come `matches(riga, criteri)` non
     * sarebbe chiamabile dal binding e resterebbe codice che nessuno esegue. Qui si costruisce
     * quindi la forma, e ColumnMenu.js la trasforma in `Filter` con una mappatura meccanica,
     * senza logica propria.
     *
     * LA FORMA E' LA REGOLA, ed e' l'unica cosa che questa funzione decide:
     *
     *     AND( colonnaA, colonnaB, ... )
     *
     * Tutto in AND, nessun OR. Il gruppo OR che stava qui apparteneva alla ricerca libera in
     * toolbar, che e' stata RIMOSSA quando il menu di colonna ha reso possibile filtrare per
     * colonna: due meccanismi con semantiche opposte sulla stessa tabella erano una sorpresa che
     * aspettava di succedere.
     *
     * PERCHE' I CRITERI RESTANO NEL BROWSER — e non e' venuto meno con la ricerca. Se si
     * spingessero al server, in modalita' IS due filtri di colonna in AND —
     * `contains(A,'x') and contains(B,'y')` — verrebbero classificati `contains-search` da
     * `classifyClientFilter` (srv/lib/isQueryShape.js) e applicati a valle come OR tollerante: il
     * risultato si ALLARGA invece di restringersi, in silenzio. E sui materiali in ONPREM il
     * `$filter` viene spinto su `A_Product`, dove `Plant`, `PlexPartType` e `LastSendStatus` non
     * esistono. Qui «e» significa «e», ed e' l'unico posto dove e' vero.
     *
     * @param {{columns?: Array<{field: string, query: string}>}} oCriteria
     * @returns {{and: boolean, filters: Array}|null} `null` se non c'e' nessun criterio attivo
     */
    function criteriaTree(oCriteria) {
        const o = oCriteria || {};
        const aAnd = [];

        for (const oCol of (o.columns || [])) {
            // Un criterio senza campo o senza testo non e' un criterio: non deve diventare una
            // foglia che risponde sempre `true`, o l'elenco dei criteri attivi mostrerebbe una
            // riga che non restringe niente.
            if (oCol && oCol.field && norm(oCol.query)) {
                aAnd.push({ field: oCol.field, query: String(oCol.query).trim() });
            }
        }

        return aAnd.length ? { and: true, filters: aAnd } : null;
    }

    return {
        TYPE_STRING,
        TYPE_NUMBER,
        TYPE_DATE,
        SORT_NONE,
        SORT_ASC,
        SORT_DESC,
        isEmpty,
        comparatorFor,
        sortFromChangeEvent,
        matchesCriterion,
        criterionNeedles,
        criteriaTree
    };
});
