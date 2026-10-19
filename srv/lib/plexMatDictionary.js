/**
 * [CONF-POSTING] Il dizionario dei materiali letto AL CONTRARIO: da UUID part Plex a materiale SAP
 * (feature 0028).
 *
 * PERCHE' ESISTE. Lo scarto di un pezzo GIA' VERSATO non ha `jobId` — il contratto Plex dice «a
 * production job is not necessary to record scrap» — quindi non ha ordine, e senza ordine cade la
 * testata da cui il job prende il materiale. L'unico aggancio che resta e' `partId`, che il
 * contratto dichiara su tutte e tre le letture: `ZMatPlexMapping` sa (Product -> PlexId), e qui si
 * legge nel verso opposto.
 *
 * PERCHE' UNA MAPPA E NON UN INDICE. Aggiungere un `.hdbindex` su `PlexId` costerebbe una modifica
 * di deployment HDI per una lettura che su un run senza scarti post-produzione non avviene mai. La
 * mappa e' PIGRA — si costruisce alla prima richiesta del run, come `createOrderCache` — e i
 * materiali sono qualche migliaio: una scansione sola, in memoria, e poi zero letture.
 *
 * IL CONFRONTO E' INSENSIBILE ALLA GRAFIA, e non contraddice DEC-51. I due lati vengono da due
 * chiamate Plex diverse (`ZMatPlexMapping.PlexId` e' cio' che Plex rispose alla creazione della
 * part, `partId` e' cio' che risponde la lettura dello storico) e `F9EEC9B7…` *e'* `f9eec9b7…`: e'
 * la stessa regola di DEC-63, dove la differenza sarebbe di grafia e non di semantica.
 *
 * UN UUID AMBIGUO SI RIFIUTA. Se due materiali SAP portano lo stesso `PlexId` non si prende il
 * primo: si dichiara. Qui il primo sbagliato scaricherebbe merce dal materiale di qualcun altro,
 * ed e' la stessa scelta di `plexJobRead` e della catena dei work center (DEC-78, DEC-80).
 *
 * [MAT-PLANT-PAIR] QUESTO MODULO NON CAMBIA CON LA 0039, E TRE COSE VANNO SAPUTE.
 *
 * 1. La motivazione di prima («non dovrebbe succedere, perche' la part e' una per materiale») e'
 *    CADUTA: dalla 0039 `ZMatPlexMapping` ha una riga per (materiale, plant). Con due tenant lo
 *    stesso materiale ha due UUID diversi, quindi due chiavi distinte che risolvono entrambe allo
 *    stesso materiale — l'indice resta univoco. Con due plant sullo STESSO tenant l'UUID e' uno
 *    solo e arriva due volte: a tenerlo non ambiguo e' la deduplica di `ensure()`
 *    (`if (!list.includes(product))`), che era una guardia difensiva ed e' diventata LA REGOLA.
 *    Toglierla manderebbe in quarantena ogni scarto senza ordine di quei materiali.
 * 2. IL PLANT NON SI AGGIUNGE AL `lookup`, benche' il chiamante ce l'abbia. La domanda qui e' «di
 *    quale materiale e' questa part», non «di quale plant»: il plant del documento materiale viene
 *    da `ZProdConfPlexEntry`, e l'UUID e' gia' la prova di quale tenant ha risposto. Filtrando per
 *    plant si romperebbe proprio il caso a tenant condiviso, dove la riga esiste per un plant solo.
 * 3. LE RIGHE STORICHE (`Plant = ''`) RESTANO NELL'INDICE, ed e' l'unico punto del progetto in cui
 *    devono restare visibili: quegli UUID sono ancora quelli di part vere su Plex, e filtrarli
 *    renderebbe irrisolvibile ogni scarto senza ordine finche' il perimetro non e' stato reinviato.
 *    E' un'eccezione dichiarata alla regola «ogni lettura filtra per un plant vero».
 *
 * NON E' UNA CACHE FRA RUN. L'istanza vive quanto l'oggetto che la crea, cioe' un run del job: un
 * materiale inviato a Plex mentre il run e' in corso comparirebbe al run successivo, che e' lo
 * stesso comportamento del dizionario in tutti gli altri suoi usi.
 *
 * PERIMETRO: grep -rn "CONF-POSTING".
 */

'use strict';

/** Nome dell'entity, in forma pienamente qualificata. */
const E_MAT_MAP = 'avvaleplm.marsplm.sap2plex.ZMatPlexMapping';

/** Esiti di `lookup`. */
const FOUND = 'FOUND';
const NO_ID = 'NO_ID';           // la registrazione Plex non porta un partId
const NOT_MAPPED = 'NOT_MAPPED'; // nessun materiale SAP con quell'UUID
const AMBIGUOUS = 'AMBIGUOUS';   // due o piu' materiali con lo stesso UUID
const READ_FAILED = 'READ_FAILED';

/** Grafia di confronto di un UUID. Vuoto -> `null`, cosi' «assente» non collide con «''». */
function normId(id) {
  const s = String(id === null || id === undefined ? '' : id).trim().toLowerCase();
  return s ? s : null;
}

/**
 * Crea il dizionario inverso di un run. Non legge niente finche' non gli si chiede un UUID.
 *
 * @param {object} db connessione CDS al db
 * @returns {{ lookup: (partId: string) => Promise<object>, stats: () => object }}
 */
function createPlexMatDictionary(db) {
  let index = null;      // Map(uuid minuscolo -> Product) — solo gli UUID NON ambigui
  let ambiguous = null;  // Map(uuid minuscolo -> [Product, …])
  let readError = null;
  let hits = 0;
  let misses = 0;

  async function ensure() {
    if (index || readError) return;
    const seen = new Map(); // uuid -> [Product, …]
    try {
      const rows = await db.run(SELECT.from(E_MAT_MAP).columns('Product', 'PlexId'));
      for (const r of rows || []) {
        const id = normId(r && r.PlexId);
        const product = String((r && r.Product) || '').trim();
        if (!id || !product) continue;
        const list = seen.get(id);
        // [MAT-PLANT-PAIR] Questa deduplica NON e' una guardia: e' la regola. Dalla 0039 lo stesso
        // materiale ha una riga per plant, e due plant sullo stesso tenant Plex portano lo STESSO
        // UUID due volte. Senza `includes` quell'UUID risulterebbe ambiguo e ogni scarto senza
        // ordine di quel materiale finirebbe in quarantena — cioe' non registrato.
        if (list) { if (!list.includes(product)) list.push(product); }
        else seen.set(id, [product]);
      }
    } catch (e) {
      readError = e.message;
      console.error(`>>> [CONF-POSTING] lettura del dizionario materiali fallita: ${e.message}`);
      return;
    }
    index = new Map();
    ambiguous = new Map();
    for (const [id, list] of seen) {
      if (list.length === 1) index.set(id, list[0]);
      else ambiguous.set(id, list);
    }
    console.log(`>>> [CONF-POSTING] dizionario materiali: ${index.size} part Plex risolvibili`
      + (ambiguous.size ? `, ${ambiguous.size} AMBIGUE` : ''));
  }

  /**
   * @param {string} partId UUID della part Plex
   * @returns {Promise<{ status: string, product?: string, products?: string[], reason: string }>}
   */
  async function lookup(partId) {
    const id = normId(partId);
    if (!id) {
      return { status: NO_ID, reason: 'la registrazione Plex non porta l\'UUID della part' };
    }
    await ensure();
    if (readError) {
      misses++;
      return { status: READ_FAILED, reason: `dizionario materiali illeggibile: ${readError}` };
    }
    const amb = ambiguous.get(id);
    if (amb) {
      misses++;
      return {
        status: AMBIGUOUS, products: amb.slice(),
        reason: `la part Plex ${partId} e' associata a ${amb.length} materiali SAP (${amb.join(', ')}):`
          + ' non si sceglie da soli su quale materiale scaricare merce'
      };
    }
    const product = index.get(id);
    if (!product) {
      misses++;
      return {
        status: NOT_MAPPED,
        // [MAT-PLANT-PAIR] Il rimedio si NOMINA. Dalla 0039 la causa piu' probabile non e' «part
        // sconosciuta» ma «materiale non ancora inviato a Plex per il plant che l'ha registrata»:
        // sono due indagini diverse, e senza questa frase si va a cercare quella sbagliata.
        reason: `la part Plex ${partId} non e' nel dizionario dei materiali: il materiale SAP non e'`
          + ' determinabile (il materiale potrebbe non essere ancora stato inviato a Plex per il'
          + ' plant di questa registrazione)'
      };
    }
    hits++;
    return { status: FOUND, product, reason: '' };
  }

  function stats() {
    return {
      loaded: !!index,
      size: index ? index.size : 0,
      ambiguous: ambiguous ? ambiguous.size : 0,
      hits,
      misses,
      readError
    };
  }

  return { lookup, stats };
}

module.exports = {
  E_MAT_MAP,
  FOUND,
  NO_ID,
  NOT_MAPPED,
  AMBIGUOUS,
  READ_FAILED,
  normId,
  createPlexMatDictionary
};
