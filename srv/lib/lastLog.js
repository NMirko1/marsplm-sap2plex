/**
 * [LAST-LOG-WORST-DAY] La lettura che alimenta le due colonne di log delle liste (0049).
 *
 * PERCHE' ESISTE, E PERCHE' E' UNA SOLA
 * Le tre liste del cruscotto — materiali, cicli, ordini — devono rispondere alla stessa domanda su
 * tre tabelle diverse: «di questo oggetto, qual e' la riga peggiore del giorno piu' recente?». Il
 * verdetto e' puro e sta in srv/lib/lastLogRules.js; qui c'e' la lettura, in UN punto solo e con tre
 * DESCRITTORI. Tre letture gemelle scritte a mano divergerebbero al primo campo aggiunto — e' il
 * difetto che `orderRows.js` e `pagedRead.js` esistono per aver tolto, dopo che due copie della
 * stessa paginazione avevano gia' divergito ([PLANT-ROWS], DEC-105).
 *
 * CINQUE PROPRIETA' CHE VANNO CONOSCIUTE PRIMA DI TOCCARE QUESTO FILE.
 *
 *   1. LE COLONNE SONO ESPLICITE, E NON E' UN'OTTIMIZZAZIONE. Le tre tabelle POS portano
 *      `RequestJson` e `ResponseJson` come `LargeString`: la traccia intera di ogni chiamata verso
 *      Plex, corpo inviato e corpo ricevuto ([MAT-LOG-FULL], 0031). Un `SELECT *` la trascinerebbe
 *      per OGNI riga di storico di OGNI oggetto della lista, cioe' decine di megabyte per aprire una
 *      dashboard. Chi aggiunge una colonna qui la aggiunga leggera.
 *
 *   2. `MessageJson` STA NELL'ELENCO, e va tenuto. E' l'avvertimento gia' scritto sulla lettura dei
 *      cicli in cat-service.js: una colonna che non si chiede non e' `null`, e' ASSENTE, e
 *      `renderLogMessage` distingue i due casi — su un'assenza lascia il testo salvato, che e' lo
 *      snapshot italiano. Dimenticarla non da' nessun errore: da' la lista in una lingua sola
 *      (DEC-92, 0029). Dal 13/10/2026 sta nel TERZO passo, chiesta per le sole righe vincenti.
 *
 *   3. LA LISTA `IN` SI SPEZZA A BLOCCHI. Il perimetro materiali di un plant e' gia' 2300 codici e
 *      la lista ordini arriva al tetto dell'area (`IS_PROD_ORDER_MAX_ROWS`, 10000): una `IN` con
 *      diecimila valori e' un numero di parametri che i driver non promettono di accettare. Stessa
 *      forma di `srv/lib/productSource.js`.
 *
 *   4. NESSUN INDICE NUOVO. La colonna su cui si filtra e' sempre la PRIMA della chiave primaria
 *      della tabella letta — `Product`, `ProductionRoutingGroup`, `ManufacturingOrder` — quindi la
 *      serve la primary key; `SentDate` e `Counter` si filtrano DENTRO quel prefisso. Chi cambiasse
 *      `scopeColumn` in una colonna non di testa si troverebbe una scansione, e i `.hdbindex`
 *      scritti a mano stanno in `db/src/` (CAP non genera indici non-unici).
 *
 *   5. IL VOLUME E' LIMITATO PER COSTRUZIONE: AL PIU' UN GIORNO DI STORICO PER OGGETTO, IN COLONNE
 *      LEGGERE. Fino al 13/10/2026 la lettura era una sola: TUTTE le righe di storico degli oggetti
 *      in lista, messaggi compresi, accodate con `rows.push(...page)` e passate alla regola. Il
 *      volume non cresce con gli oggetti ma con i RETRY: una conferma d'ordine rifiutata da SAP
 *      viene ritentata ogni quarto d'ora e ogni tentativo scrive una riga di storico per
 *      registrazione (DEC-139); senza tetto di tentativi sul plant, 266 registrazioni rifiutate
 *      sono 25.000 righe al giorno. Lo spread di JavaScript regge ~120.000 elementi e a 150.000
 *      lancia `Maximum call stack size exceeded` (misurato); l'errore era catturato e la lista
 *      ordini usciva con le due colonne VUOTE PER TUTTI, anche gli ordini sani — nessun 500,
 *      nessun crash, una riga su stderr che nessuno legge. Ora la lettura e' in tre passi:
 *
 *        (a) il GIORNO PIU' RECENTE di ogni oggetto — `max(SentDate)` raggruppato per la chiave,
 *            una riga per oggetto qualunque sia il volume (stessa forma del `count(*) ... groupBy`
 *            di srv/jobs/postProdOrderConfirmation.js);
 *        (b) le righe di QUEL giorno, con le sole colonne che servono al verdetto (`Counter`,
 *            `SentDate`, `SentTime`, `Status`): una query per giorno distinto, a blocchi;
 *        (c) `Message` e `MessageJson` delle SOLE righe vincenti, una per oggetto.
 *
 *      Il filtro del passo (b) e' sul prefisso di chiave (`scopeColumn`), quindi un oggetto
 *      gemello — stesso `Product`, altro `Plant` — puo' portare righe di un giorno che non e' il
 *      suo: e' innocuo, perche' le righe del SUO giorno piu' recente arrivano dal suo gruppo e la
 *      regola «giorno prima della gravita'» le fa vincere. Un oggetto con sole righe senza
 *      `SentDate` e' un gruppo a se' (`max()` ignora i NULL) e si interroga con `SentDate IS NULL`,
 *      o sparirebbe dalla colonna. E da nessuna parte si accoda con uno spread: `append()`.
 *      Collaudo: test/lastLog.test.js, che fa rendere al database 200.000 righe in un giorno.
 *
 * Il modulo non importa `cds`: usa i costruttori CQL globali, che e' lo stile dei suoi pari in
 * srv/lib (`prodOrderExcLog`, `plexCycleAllocation`, `confPostingConfig`) e che dentro la CAP
 * runtime ci sono sempre. La connessione arriva da fuori.
 *
 * Non rende un testo: rende la RIGA vincente. La resa del messaggio nella lingua di chi guarda e'
 * del chiamante, perche' `renderLogMessage` vive nella closure di `cat-service.js` e vuole `req`.
 */

'use strict';

const lastLogRules = require('./lastLogRules');

/** Quanti valori per `IN`. Vedi la proprieta' 3 in testa al file. */
const SCOPE_CHUNK = 500;

/**
 * Le colonne che la riga vincente porta al chiamante, su tutte e tre le tabelle POS.
 *
 * `SentDate` e `Counter` decidono (giorno e progressivo), `Status` e' la cella del semaforo,
 * `Message` + `MessageJson` sono la cella del testo, `SentTime` e' il tie-break. Niente altro.
 * Le prime quattro si leggono al passo (b) per tutte le righe del giorno, le ultime due al passo
 * (c) per le sole vincenti: vedi la proprieta' 5.
 */
const LOG_COLUMNS = Object.freeze([
  'Counter', 'SentDate', 'SentTime', 'Status', 'Message', 'MessageJson'
]);

/** Le colonne LEGGERE del passo (b): quelle su cui `lastLogRules.isBetter` decide. */
const DAY_COLUMNS = Object.freeze(['Counter', 'SentDate', 'SentTime', 'Status']);

/** Le colonne del passo (c): il testo della riga vincente. */
const TEXT_COLUMNS = Object.freeze(['Message', 'MessageJson']);

/** L'alias con cui il passo (a) rende il giorno piu' recente. */
const LAST_DAY = 'LastDay';

/** `values` a blocchi di `size`. */
function chunksOf(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * Accoda il risultato di una `db.run` a `target`, UNA RIGA ALLA VOLTA. Mai `push(...page)`: e' lo
 * spread che a 150.000 righe ha spento le colonne della lista ordini (proprieta' 5).
 */
function append(target, page) {
  if (Array.isArray(page)) {
    for (const r of page) target.push(r);
  } else if (page) {
    target.push(page);
  }
}

/** Un valore di perimetro e' utilizzabile se non e' vuoto. */
function usable(v) {
  return v !== null && v !== undefined && v !== '';
}

/**
 * La riga di storico che riassume ognuno degli oggetti chiesti.
 *
 * @param {object} db                connessione (`cds.connect.to('db')`)
 * @param {string} opts.entity       FQN della tabella POS
 * @param {string[]} opts.keyColumns le colonne di identita' dell'oggetto, da chiedere nel `$select`
 * @param {string} opts.scopeColumn  su quale colonna filtrare: la PRIMA della chiave primaria
 * @param {Array} opts.scopeValues   i valori del perimetro
 * @param {(row:object)=>string} opts.keyOf  l'identita' dell'oggetto, come stringa
 * @param {string[]} [opts.extraColumns]     colonne aggiuntive da chiedere sulle righe del giorno
 *                                           (leggere: vedi punto 1)
 * @param {string} [opts.label]      etichetta per la riga di log di un guasto
 * @returns {Promise<Map<string, object>>} chiave -> riga vincente (`keyColumns` + `LOG_COLUMNS`).
 *   VUOTA su guasto.
 */
async function readLastLogByKey(db, {
  entity, keyColumns, scopeColumn, scopeValues, keyOf, extraColumns = [], label = ''
} = {}) {
  const values = [...new Set((scopeValues || []).filter(usable))];
  if (!values.length) return new Map();

  const tag = `>>> [LAST-LOG-WORST-DAY]${label ? ` ${label}:` : ''}`;
  // Un guasto NON e' un insieme vuoto travestito: si dichiara e si rende una mappa vuota, cosi' le
  // due colonne escono nulle. E' la stessa scelta delle due letture che questa sostituisce — una
  // lista che non si apre perche' il suo log non si legge sarebbe un difetto peggiore.
  try {
    // ---- (a) il giorno piu' recente di ogni oggetto -------------------------------------------
    const latest = [];
    for (const chunk of chunksOf(values, SCOPE_CHUNK)) {
      append(latest, await db.run(
        SELECT.from(entity).columns(...keyColumns, `max(SentDate) as ${LAST_DAY}`)
          .where({ [scopeColumn]: { in: chunk } })
          .groupBy(...keyColumns)
      ));
    }

    // Giorno normalizzato -> valori di perimetro che hanno quel giorno come piu' recente. Il
    // giorno vuoto (`''`) raccoglie gli oggetti con sole righe senza data. `dayOf` tollera le due
    // forme in cui un driver rende un `cds.Date`, come fa la regola.
    const scopesByDay = new Map();
    for (const g of latest) {
      const scope = g && g[scopeColumn];
      if (!usable(scope)) continue;
      const day = lastLogRules.dayOf({ SentDate: g[LAST_DAY] });
      if (!scopesByDay.has(day)) scopesByDay.set(day, new Set());
      scopesByDay.get(day).add(scope);
    }

    // ---- (b) le righe di quel giorno, leggere -------------------------------------------------
    const dayRows = [];
    for (const [day, scopes] of scopesByDay) {
      for (const chunk of chunksOf([...scopes], SCOPE_CHUNK)) {
        append(dayRows, await db.run(
          SELECT.from(entity).columns(...keyColumns, ...DAY_COLUMNS, ...extraColumns)
            .where({ [scopeColumn]: { in: chunk }, SentDate: day === '' ? null : day })
        ));
      }
    }
    const picked = lastLogRules.pickLastLogByKey(dayRows, keyOf);

    // ---- (c) il testo delle sole righe vincenti -----------------------------------------------
    // Sovrainsieme limitato: `scopeColumn IN (...) AND Counter IN (...)` rende al piu' una riga
    // per oggetto per contatore vincente del blocco; la coppia esatta (chiave, `Counter`) si
    // aggancia in memoria.
    const winners = [...picked.values()];
    for (const chunk of chunksOf(winners, SCOPE_CHUNK)) {
      const scopes = [...new Set(chunk.map((w) => w[scopeColumn]).filter(usable))];
      const counters = [...new Set(chunk.map((w) => w.Counter).filter(usable))];
      if (!scopes.length || !counters.length) continue;
      const texts = [];
      append(texts, await db.run(
        SELECT.from(entity).columns(...keyColumns, 'Counter', ...TEXT_COLUMNS)
          .where({ [scopeColumn]: { in: scopes }, Counter: { in: counters } })
      ));
      for (const t of texts) {
        const w = picked.get(keyOf(t));
        if (w && Number(w.Counter) === Number(t.Counter)) {
          w.Message = t.Message;
          w.MessageJson = t.MessageJson;
        }
      }
    }

    console.log(`${tag} ${dayRows.length} righe di storico su ${values.length} oggetti`
      + ` -> ${picked.size} con una riga da mostrare`);
    return picked;
  } catch (e) {
    console.error(`>>> [LAST-LOG-WORST-DAY] storico non letto${label ? ` (${label})` : ''}`
      + ` su ${entity}: ${e.message}. Le colonne di log della lista restano vuote.`);
    return new Map();
  }
}

module.exports = { readLastLogByKey, LOG_COLUMNS, DAY_COLUMNS, TEXT_COLUMNS, SCOPE_CHUNK };
