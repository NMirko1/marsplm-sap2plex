/**
 * [ORDER-COMP-REMOVE] Orchestrazione della rimozione MANUALE dei componenti di un ordine
 * (feature 0026).
 *
 * Le REGOLE stanno in orderCompRemovalRules.js, che e' puro e collaudato
 * (node test/orderCompRemovalRules.test.js). Qui c'e' solo quello che tocca il mondo: la lettura
 * delle righe di `ZProdOrderCompRemoved` e le note per il recap.
 *
 * DOVE SI INNESTA. Come ultimo strato della catena che costruisce `order.components`, cioe' subito
 * DOPO `orderCompExcl.applyComponentExclusions` — che a sua volta viene dopo l'esplosione dei
 * fantasma. L'ordine dei tre non e' arbitrario: la rimozione e' un atto su un elenco che una
 * persona ha VISTO, e cio' che vede e' l'elenco esploso e filtrato dal customizing. Rimuovere prima
 * significherebbe nominare un fantasma che a schermo non c'e'.
 *
 * SI INNESTA IN DUE PUNTI SU TRE, e il terzo e' una scelta:
 *   - `loadOrderDetails` del job (che serve anche «Crea Job» e lo spacchettamento): SI', e' il
 *     choke-point dell'invio;
 *   - `autoAssignPlexCycle`: SI', o l'auto-assegnazione ricollocherebbe un componente rimosso;
 *   - `READ ProductionOrderComponents`, l'albero SAP di sinistra nel cockpit: NO. Quell'albero e'
 *     la verita' di SAP ed e' l'unico posto da cui si trascina il componente per farlo RIENTRARE:
 *     nasconderlo li' renderebbe la rimozione irreversibile. Il componente rimosso si MARCA nel
 *     nodo, e la marcatura la mette il client, che l'elenco dei rimossi lo ha gia' letto.
 *
 * NON LANCIA MAI, e su una lettura fallita l'elenco resta INVARIATO. La direzione e' la stessa di
 * orderCompExcl.js e per la stessa ragione: questo codice sta dentro il percorso che porta a
 * `Active = 0` le righe BOM di un job schedulato, e una sottrazione fatta al buio vale una distinta
 * svuotata. Il verso opposto — una rimozione non applicata — si VEDE, perche' il componente
 * compare su Plex; e si dichiara, perche' altrimenti l'utente crederebbe di averlo tolto.
 *
 * Perimetro: grep -rn "ORDER-COMP-REMOVE".
 */

'use strict';

// Il require di `@sap/cds` non e' decorativo: e' quello che mette in globale `SELECT`.
require('@sap/cds');
const R = require('./orderCompRemovalRules');

const NS = 'avvaleplm.marsplm.sap2plex';
const E_REMOVED = `${NS}.ZProdOrderCompRemoved`;
const E_MAPPING = `${NS}.ZProdOrderPlexMapping`;

/**
 * I materiali rimossi a mano da un ordine.
 *
 * Nessuna cache: le righe sono poche, la lettura e' locale, e un valore tenuto caldo qui sarebbe
 * una rimozione appena salvata che il pulsante «Crea Job» non vede.
 *
 * @param {object} db connessione CDS al db
 * @param {string} ManufacturingOrder
 * @returns {Promise<{ materials: Array<string>, readError: string }>}
 *   `readError` valorizzato = NON si sa: chi chiama non sottrae niente e lo dichiara.
 */
async function loadRemovedMaterials(db, ManufacturingOrder) {
  const order = ManufacturingOrder === null || ManufacturingOrder === undefined
    ? '' : String(ManufacturingOrder).trim();
  if (!order) return { materials: [], readError: '' };
  try {
    const rows = await db.run(
      SELECT.from(E_REMOVED).columns('Material').where({ ManufacturingOrder: order })
    );
    return { materials: (rows || []).map((r) => r.Material), readError: '' };
  } catch (e) {
    return { materials: [], readError: e.message };
  }
}

/**
 * Sottrae dalle righe componente quelle che una persona ha rimosso dall'albero dell'ordine.
 *
 * @param {object} args
 * @param {object} args.db connessione CDS al db
 * @param {string} args.ManufacturingOrder
 * @param {Array<object>} args.rows righe componente, dopo esplosione fantasma ed esclusioni
 * @param {string} [args.tag] prefisso di log
 * @returns {Promise<{ rows: Array<object>, dropped: Array<object>, applied: boolean,
 *   stats: object|null, notes: Array<{level: string, text: string}> }>}
 */
async function applyManualRemovals(args) {
  const { db, ManufacturingOrder, rows, tag = '' } = args || {};
  const pfx = `>>> [ORDER-COMP-REMOVE] ${tag ? `${tag}: ` : ''}`;
  const inert = { rows: rows || [], dropped: [], applied: false, stats: null, notes: [] };
  if (!inert.rows.length) return inert;

  try {
    const { materials, readError } = await loadRemovedMaterials(db, ManufacturingOrder);
    if (readError) {
      const text = `componenti rimossi a mano non leggibili (${readError}): elenco invariato,`
        + ' i componenti rimossi tornano su Plex';
      console.error(`${pfx}${text}`);
      inert.notes.push({ level: 'W', text });
      return inert;
    }
    if (!materials.length) return inert;

    const { kept, dropped, stats } = R.applyRemovals({ components: inert.rows, removed: materials });

    const line = R.describe(stats);
    if (line) {
      console.log(`${pfx}${line}`);
      inert.notes.push({ level: 'I', text: line });
    }
    // Un materiale dichiarato rimosso che nell'ordine non c'e' non e' un guasto — SAP puo' averlo
    // tolto dopo la rimozione, ed e' esattamente il caso d'uso della feature — ma e' anche la forma
    // che prende uno zero iniziale sbagliato, e le due si distinguono solo guardando i codici.
    if (stats.unmatched.length) {
      const text = `${stats.unmatched.length} materiali dichiarati rimossi non sono (piu') fra i`
        + ` componenti dell'ordine: ${stats.unmatched.slice(0, 10).join(', ')}`
        + `${stats.unmatched.length > 10 ? ', …' : ''}`;
      console.log(`${pfx}${text}`);
      inert.notes.push({ level: 'I', text });
    }

    return { rows: kept, dropped, applied: true, stats, notes: inert.notes };
  } catch (e) {
    const text = `rimozione manuale non applicata (${e.message}): elenco invariato`;
    console.error(`${pfx}${text}`);
    inert.notes.push({ level: 'W', text });
    return inert;
  }
}

/**
 * L'ordine e' gia' stato inviato a Plex? Vedi `isAlreadySent` in orderCompRemovalRules.js per il
 * perche' la risposta la da' il nostro dizionario e non Plex.
 *
 * Su lettura FALLITA si risponde «inviato». E' l'unico posto di questa feature in cui il dubbio
 * chiude invece di aprire, e la ragione e' l'asimmetria del danno: negare una rimozione lascia
 * l'utente con un messaggio e un ritentativo, concederla su un ordine che invece era gia' uscito
 * disattiva una riga BOM di un lotto in produzione.
 *
 * @param {object} db
 * @param {string} ManufacturingOrder
 * @returns {Promise<{ sent: boolean, readError: string }>}
 */
async function isOrderAlreadySent(db, ManufacturingOrder) {
  const order = ManufacturingOrder === null || ManufacturingOrder === undefined
    ? '' : String(ManufacturingOrder).trim();
  if (!order) return { sent: false, readError: '' };
  try {
    // [ORDER-MAP-JOB] Si legge `PlexJobId`, non `PlexJobNumber`: il secondo e' in CHIAVE e quindi
    // c'e' sempre, anche sulla riga di un tentativo fallito — leggerlo significa chiedere «esiste
    // una riga?», che e' la domanda sbagliata.
    //
    // E CADE IL `.limit(1)`. Con il predicato nuovo quel tetto e' pericoloso nel verso peggiore:
    // un ordine puo' avere piu' righe — il lotto principale e i pacchetti dello spacchettamento —
    // e se la prima che torna e' quella senza id la risposta sarebbe «mai inviato» su un ordine
    // che su Plex ha un lotto vivo, cioe' rimozione concessa e riga di distinta disattivata. Le
    // righe per ordine sono poche e la chiave le indicizza.
    const rows = await db.run(
      SELECT.from(E_MAPPING).columns('PlexJobId').where({ ManufacturingOrder: order })
    );
    return { sent: R.isAlreadySent(rows), readError: '' };
  } catch (e) {
    console.error(`>>> [ORDER-COMP-REMOVE] ${order}: dizionario dei job non leggibile`
      + ` (${e.message}): la rimozione si nega`);
    return { sent: true, readError: e.message };
  }
}

module.exports = {
  E_REMOVED,
  loadRemovedMaterials,
  applyManualRemovals,
  isOrderAlreadySent
};
