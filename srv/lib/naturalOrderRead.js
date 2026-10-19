// ================================================================
// [NATURAL-ORDER] Le due liste EDITABILI della configurazione plant si ordinano in NODE (DEC-102)
//
// PERCHE'. Su Gruppi e Auto-assegnazione ordina il database, e `ORDER BY` e' lessicografico: su
// materiali a riempimento misto — numeri SAP riempiti a zeri accanto a numeri digitati a mano —
// esce `000000101600, 1, 101600, 2, 3`, cioe' `1`, `2` e `3` in mezzo ai codici lunghi. A chi
// guarda e' un elenco NON ordinato. La collazione numerica di ECMA-402 in SQL non e' esprimibile,
// e nemmeno lo e' un `NULLS LAST` portabile: percio' l'ordinamento sale qui, con lo stesso
// collatore della tendina delle operazioni Plex (`srv/lib/naturalOrder.js`).
//
// PERCHE' STA IN `srv/lib/` E NON DENTRO `cat-service.js`. Perche' cosi' ha un test. La prima
// stesura viveva dentro `cds.service.impl`, cioe' in una closure: non esportabile, non
// collaudabile — e i tre difetti che seguono sono passati inosservati fino a un elenco di 121
// righe. Le dipendenze si iniettano (`codedValues`, `i18nMessages`, `localeOf`) perche' due delle
// tre sono risolte dal servizio.
//
// PERCHE' `before` + `after` E NON UN `on`. Un handler «around» (`on('READ', …, (req, next) => …)`)
// sembra piu' pulito e ROMPE IL CONTEGGIO: dal momento in cui una entity ha un `on READ` custom,
// CAP smette di calcolare `@odata.count` da se' e lo prende dalla lunghezza di cio' che l'handler
// rende — quindi `$top=2` rispondeva `count=2` su un insieme di dodici righe, anche nel ramo che si
// limitava a delegare. Con `growing` quel conteggio e' il segnale di «ci sono altre righe»: la
// lista si fermerebbe alla prima pagina, e su una tabella corta non se ne accorgerebbe nessuno.
// Provato: `ZPlant`, che non ha handler, risponde `count=2` con `$top=1`. `before` e `after` non
// tolgono a CAP la lettura generica, quindi il conteggio resta suo.
//
// ================================================================
// LA SICUREZZA STA NELLA PRIMA RIGA DEL `before`, E FINO AL 27/08/2026 NON C'ERA.
//
// La regola voluta e' sempre stata: la strada nuova esiste SOLO quando l'utente ha cliccato
// «ordina» — la lettura per chiave dopo un `create`, gli `$expand` e ogni richiesta che il binding
// V4 emette durante la MODIFICA restano quelle di prima. Su tabelle che si scrivono e' la
// differenza fra una funzionalita' in piu' e un editor rotto.
//
// La prima stesura la esprimeva come «l'`orderBy` e' vuoto», e quel predicato **e' sempre falso**.
// Due handler generici di CAP girano nella fase `_initial`, cioe' PRIMA di ogni `before`
// dell'applicazione (la stessa fase della validazione di tipo, DEC-40):
//
//   1. `libx/_runtime/common/generic/paging.js` mette SEMPRE un limite —
//      `SELECT.limit.rows = { val: $top ?? 1000 }`;
//   2. `libx/_runtime/common/generic/sorting.js` aggiunge un ordinamento implicito sulle CHIAVI
//      «se singleton oppure `SELECT.limit`» — e per il punto 1 quel `limit` c'e' sempre.
//
// Quindi ogni lettura di collezione via HTTP arriva qui con
// `orderBy: [{ ref: ['ID'], sort: 'asc', implicit: true }]` e la guardia non scattava mai.
// Osservato il 27/08/2026 su `ObjectGroups`, con e senza `$orderby`. Tre conseguenze, tutte e tre
// viste in esercizio:
//
//   - la lista NON ordinata dall'utente veniva ordinata per **UUID**, cioe' in un ordine che a
//     schermo e' casuale (`104, 91, 36, 26, …`) — e sembrava «l'ordine del database»;
//   - OGNI lettura leggeva il perimetro INTERO e lo ordinava in memoria, comprese le decine che il
//     binding V4 emette mentre si compila una riga;
//   - il limite azzerato faceva emettere a CAP un `@odata.nextLink` FALSO, e da lì la lista
//     smetteva di sapere quante righe ha (vedi il blocco qui sotto).
//
// La guardia giusta guarda gli ordinamenti **CHIESTI**, e CAP li distingue da se': marca i propri
// con `implicit: true`. L'ordinamento implicito sulla chiave resta invece nel confronto, come
// ULTIMO criterio: e' il pareggio deterministico che rende stabile la paginazione quando il campo
// scelto ha valori ripetuti.
//
// ================================================================
// IL LIMITE SI RIMETTE A POSTO, PERCHE' CAP LO RILEGGE DOPO DI NOI.
//
// Togliere `orderBy` e `limit` alla query non e' una faccenda interna a questo handler: dopo la
// `dispatch`, `libx/odata/middleware/read.js` chiama `_setNextLink`, che decide la paginazione
// lato server leggendo `req.query.SELECT.limit?.rows?.val`. Con il limite azzerato le sue due
// uscite anticipate confrontano un numero con `undefined`:
//
//     result.length < undefined            -> false
//     skipped - offset + limit >= top      -> NaN >= 50 -> false
//
// e nessuna scatta: la risposta esce con
// `@odata.nextLink = …&$skiptoken=<base64 di "$rows=NaN&$offset=NaN">`, su OGNI pagina, anche
// sull'ultima da 21 righe.
//
// Lato UI5 quel campo e' un interruttore, non un'informazione: `_Cache.handleCount` entra nel ramo
// *server-driven paging*, che NON chiama `setCount` — quindi `$count` resta ignoto,
// `isLengthFinal()` resta falso per sempre e `sap.m.Table` mostra «Mostra di piu'» anche quando
// non c'e' piu' niente. Premendolo, la pagina chiesta non porta righe nuove, `createContexts`
// rende `bChanged = false`, `ODataListBinding` non emette `change` — e il trigger di
// `GrowingEnablement`, che quel `change` e' l'unica cosa che lo spegne, resta a girare **per
// sempre**. `sap.m.ListBase` lo dichiara nel proprio codice: «TODO: if there is a network error
// this will not get called but we need to turn back to initial state».
//
// Percio' l'`after` rimette `orderBy` e `limit` come stavano, e lo fa PRIMA di qualunque uscita
// anticipata: `_setNextLink` gira comunque, anche sulle letture in cui non c'era niente da
// ordinare.
//
// IL DETTAGLIO CHE DECIDE SE FUNZIONA: i campi dell'`orderBy` vanno AGGIUNTI al `$select`. UI5
// manda `$select=ComponentGroup,ID,Material,PlexOperation` — `PlexOperationName` non e' legato a
// nessuna cella e quindi non c'e' — e ordinare per un campo che le righe non portano non da'
// errore: da' un elenco che non si ordina. Nel risultato quei campi si tolgono, o la risposta
// porterebbe proprieta' che il client non ha chiesto.
//
// Il filtro resta al DATABASE: si tolgono `orderBy` e `limit` e nient'altro, quindi nessuna
// condizione viene re-implementata a mano — compreso il filtro per plant, che e' un gate.
//
// Vedi DEC-102. Perimetro: grep -rn "NATURAL-ORDER"
// ================================================================

'use strict';

const naturalOrder = require('./naturalOrder');

// Sopra questo numero di righe l'ordinamento in memoria si DICHIARA. Non e' un troncamento —
// troncare qui darebbe «i primi N in ordine» spacciandolo per l'elenco intero — ed e' il motivo
// per cui si scrive nel log invece di tagliare: sono tabelle di customizing per plant, se un
// giorno una supera il tetto e' quello il fatto da vedere.
const NATURAL_SORT_MAX_ROWS = parseInt(process.env.NATURAL_SORT_MAX_ROWS || '20000', 10);

// Dove il `before` lascia il lavoro per l'`after`. Un Symbol e non un nome: `req` e' un oggetto di
// CAP e una proprieta' con un nome qualunque potrebbe collidere oggi o dopo un aggiornamento.
const NATURAL_ORDER_PLAN = Symbol('naturalOrderPlan');

/** Il nome del campo in coda a un `ref` CQN. */
function refField(node) {
  return node && Array.isArray(node.ref) ? node.ref[node.ref.length - 1] : null;
}

/**
 * Gli ordinamenti CHIESTI da chi legge, cioe' quelli che non ha aggiunto CAP.
 *
 * E' la guardia dell'intera feature: se questo elenco e' vuoto la query non si tocca. `implicit`
 * lo marca `libx/_runtime/common/generic/sorting.js` sugli ordinamenti che aggiunge da se' sulle
 * chiavi — sempre, su ogni lettura di collezione via HTTP.
 */
function explicitOrderBy(orderBy) {
  if (!Array.isArray(orderBy)) return [];
  return orderBy.filter((o) => o && !o.implicit);
}

/**
 * Il piano di ordinamento di una lettura, o `null` se non c'e' niente da fare.
 *
 * Funzione PURA: nessun `cds`, nessuna rete. Prende la `SELECT` e rende cosa andra' fatto, senza
 * toccare niente — cosi' la decisione si collauda da sola.
 *
 * @param {object} sel      il nodo `SELECT` della query
 * @param {object} deps     `{ codedValues, labelOf }` — `labelOf(chiaveI18n, app)` rende il testo
 * @returns {object|null}
 */
function planFor(sel, { codedValues, labelOf }) {
  const explicit = explicitOrderBy(sel && sel.orderBy);
  if (!explicit.length) return null;

  // Si ORDINA per tutto l'`orderBy`, implicito compreso: la chiave in coda e' il pareggio
  // deterministico che tiene stabile la paginazione quando il campo scelto ha valori ripetuti.
  const orderBy = sel.orderBy;

  // I campi che servono per ordinare: quelli dell'orderBy, piu' il campo che porta il CODICE di
  // una colonna a valori codificati (senza, l'etichetta tradotta non si puo' risolvere).
  const needed = [];
  const labelsByField = {};
  for (const o of orderBy) {
    const f = refField(o);
    if (!f) continue;
    if (!needed.includes(f)) needed.push(f);
    const coded = codedValues.codedColumn(f);
    if (!coded) continue;
    if (!needed.includes(coded.path)) needed.push(coded.path);
    // [CODED-VALUES] Le etichette si risolvono UNA VOLTA per richiesta, non a ogni confronto: un
    // ordinamento fa O(n log n) confronti e il bundle andrebbe interrogato altrettante volte.
    const labels = {};
    for (const code of Object.keys(coded.labels)) {
      labels[code] = labelOf(coded.labels[code], coded.app);
    }
    labelsByField[f] = { path: coded.path, labels };
  }

  // Le colonne aggiunte per poter ordinare, da togliere dal risultato. Se `columns` non c'e', il
  // gestore generico rende tutte le colonne e non manca niente.
  const added = [];
  if (Array.isArray(sel.columns)) {
    for (const f of needed) {
      if (!sel.columns.some((c) => refField(c) === f)) added.push(f);
    }
  }

  const limit = sel.limit;
  return {
    sel,
    orderBy,
    labelsByField,
    added,
    // I valori ORIGINALI, da rimettere nell'`after`: CAP li rilegge dopo di noi.
    origOrderBy: sel.orderBy,
    origLimit: limit,
    top: Number(limit && limit.rows && limit.rows.val),
    skip: Number(limit && limit.offset && limit.offset.val) || 0,
    wantCount: sel.count === true
  };
}

/** Applica il piano alla query: aggiunge le colonne che servono, e toglie ordinamento e limite. */
function applyPlan(plan) {
  const sel = plan.sel;
  if (Array.isArray(sel.columns)) {
    for (const f of plan.added) sel.columns.push({ ref: [f] });
  }
  // Il database FILTRA; ordinare e paginare tocca a noi.
  //
  // ASSEGNAZIONE E NON `delete`. Su un `SELECT` di cds `orderBy` e `limit` non sono configurabili:
  // `delete` NON le toglie, e in modalita' non-strict non lancia — rende `false` e prosegue. La
  // prima stesura usava `delete` e l'`after` riceveva la PAGINA invece dell'insieme: ordinare
  // cinque righe di dodici e' il difetto peggiore del contratto, un risultato plausibile e
  // sbagliato, ed e' esattamente cio' che DEC-82 chiama «la piu' grande delle prime cento».
  sel.orderBy = undefined;
  sel.limit = undefined;
}

/**
 * Rimette la query come l'ha ricevuta.
 *
 * Non e' pulizia di stile: dopo la `dispatch` CAP rilegge `SELECT.limit` per decidere se aggiungere
 * un `@odata.nextLink`, e un limite azzerato gliene fa emettere uno falso. Vedi il blocco in testa.
 */
function restore(plan) {
  plan.sel.orderBy = plan.origOrderBy;
  plan.sel.limit = plan.origLimit;
}

/**
 * Ordina e affetta le righe secondo il piano, IN PLACE.
 *
 * SOSTITUZIONE IN PLACE, ed e' la seconda trappola di questo handler. Un `after` di READ puo'
 * modificare il risultato ma NON rimpiazzarlo con un `return`: restituire la pagina ordinata non
 * produce nessun effetto e la risposta resta quella del gestore generico — cioe' l'elenco intero
 * nell'ordine del database, senza un errore e senza una riga di log.
 *
 * @returns {number} il totale dell'insieme filtrato (non della pagina)
 */
function sortInPlace(rows, plan) {
  // [CODED-VALUES] Dove il valore memorizzato e' vuoto perche' l'etichetta e' TRADOTTA — le due
  // voci «Prima operazione» e «Ultima operazione» — si ordina sull'etichetta risolta nella lingua
  // di chi chiede. Cosi' sta sotto la P per un italiano e sotto la F per un inglese, senza che nel
  // database finisca una sola parola tradotta (DEC-92).
  const valueOf = (row, field) => {
    const stored = row ? row[field] : undefined;
    const coded = plan.labelsByField[field];
    if (!coded) return stored;
    if (!naturalOrder.isEmpty(stored)) return stored;
    const code = row ? row[coded.path] : undefined;
    // Un codice senza etichetta resta vuoto e finisce in coda: e' un valore che non si sa leggere,
    // non un valore da inventare.
    return (code && coded.labels[code]) || stored;
  };

  const sorted = [...rows].sort(naturalOrder.cmpFromOrderBy(plan.orderBy, valueOf));
  const total = sorted.length;
  const page = Number.isFinite(plan.top)
    ? sorted.slice(plan.skip, plan.skip + plan.top)
    : sorted.slice(plan.skip);

  // Le colonne aggiunte per ordinare escono di scena: il client non le ha chieste.
  if (plan.added.length) {
    for (const row of page) {
      for (const f of plan.added) delete row[f];
    }
  }

  rows.length = 0;
  Array.prototype.push.apply(rows, page);
  // Il conteggio e' quello dell'insieme FILTRATO intero, non della pagina: e' il segnale con cui
  // `growing` sa che ci sono altre righe da chiedere ([LIST-COUNT]).
  if (plan.wantCount) rows.$count = total;
  return total;
}

/**
 * Registra l'ordinamento naturale su una entity.
 *
 * @param {object} srv    il servizio
 * @param {string} entity nome della entity nel servizio
 * @param {object} deps   `{ codedValues, i18nMessages, localeOf }`
 */
function install(srv, entity, deps) {
  const { codedValues, i18nMessages, localeOf } = deps;

  srv.before('READ', entity, (req) => {
    const sel = req.query && req.query.SELECT;
    if (!sel) return;
    const plan = planFor(sel, {
      codedValues,
      labelOf: (key, app) => i18nMessages.text(key, app, localeOf(req), [])
    });
    // Nessun ordinamento CHIESTO: non si stanzia niente e la query resta quella. Vedi sopra —
    // «chiesto» e non «presente», perche' CAP ne aggiunge sempre uno sulle chiavi.
    if (!plan) return;
    req[NATURAL_ORDER_PLAN] = plan;
    applyPlan(plan);
  });

  srv.after('READ', entity, (rows, req) => {
    const plan = req[NATURAL_ORDER_PLAN];
    if (!plan) return;
    // PRIMA di ogni uscita anticipata: CAP rilegge il limite dopo di noi.
    restore(plan);
    if (!Array.isArray(rows)) return;

    if (rows.length > NATURAL_SORT_MAX_ROWS) {
      console.warn(`>>> [NATURAL-ORDER] ${entity}: ${rows.length} righe ordinate in memoria ` +
        `(tetto dichiarato ${NATURAL_SORT_MAX_ROWS}). Nessun troncamento: l'elenco e' intero.`);
    }

    sortInPlace(rows, plan);
  });
}

module.exports = {
  install,
  // esportate per il test: la decisione e la trasformazione, senza `cds` in mezzo
  explicitOrderBy,
  planFor,
  applyPlan,
  restore,
  sortInPlace,
  NATURAL_ORDER_PLAN,
  NATURAL_SORT_MAX_ROWS
};
