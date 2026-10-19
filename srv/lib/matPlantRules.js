/**
 * [MAT-PLANT-PAIR] Regole pure del materiale come oggetto per (materiale, plant) — feature 0039.
 *
 * PERCHE' ESISTE
 * Dalla 0020 la connessione Plex e' PER PLANT, quindi lo stesso materiale in perimetro su due
 * plant e' due part su due tenant diversi: due UUID, due mapping di campi, due esiti. La 0031 ha
 * gia' portato il plant in chiave sui log; questa feature lo porta sui due dizionari, sul delta
 * del job e su cio' che il cockpit filtra. Qui vive la sola parte di quel disegno che si puo'
 * verificare SENZA sistemi esterni: la chiave della coppia, l'indicizzazione che rende invisibili
 * le righe storiche, la decisione di delta, e la selezione sotto tetto.
 *
 * LA CHIAVE STAVA SCRITTA IN CINQUE POSTI. `${Product}|${Plant}` era composta a mano in
 * srv/cat-service.js (join della lista, dedup dell'invio massivo) e in
 * srv/jobs/syncMaterialsToPlex.js, e questa feature ne aggiungeva altri quattro. Due definizioni
 * della stessa chiave non danno nessun errore: danno un lookup che non aggancia, cioe' un delta
 * che rispedisce tutto o che non manda niente.
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' stato globale, ne' orologio. Non
 * aggiungerne: il test si lancia con
 *     node test/matPlantRules.test.js
 * Stessa convenzione di srv/lib/routingMaterialRules.js e srv/lib/splitRules.js.
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

// [PART-ALIVE] La grafia di confronto di un UUID, in un punto solo del progetto (DEC-63): i due lati
// vengono da due posti diversi — il nostro dizionario e la lista del tenant — e `F9EEC9B7…` *e'*
// `f9eec9b7…`. Riusata e non riscritta: una seconda definizione e' una seconda occasione di divergere.
const { normalizeUuid } = require('./recvOpRules');

// ================================================================
// Chiave della coppia
// ================================================================

/**
 * Normalizzazione di un componente di chiave: solo `trim`.
 *
 * NON si aggiunge `padStart`: allineare gli zeri iniziali significherebbe DECIDERE il formato di
 * SAP, e fra due chiavi SAP il confronto e' STRETTO di proposito (DEC-51) — un disallineamento e'
 * un difetto a monte che deve restare visibile. Il `trim` invece serve: `Plant` arriva da tre
 * strade diverse (customizing locale, riga di `A_ProductPlant`, parametro di una action costruita
 * dal browser) e uno spazio in coda farebbe mancare ogni lookup senza un errore.
 *
 * @param {*} v
 * @returns {string}
 */
function keyPart(v) {
  return String(v ?? '').trim();
}

/**
 * La chiave di un oggetto «materiale»: (materiale, plant).
 *
 * IL SEPARATORE E' PARTE DEL CONTRATTO. Un codice materiale SAP puo' contenere quasi qualunque
 * carattere, `|` compreso: senza separatore stabile `('M|X', '')` e `('M', 'X')` collidono, e la
 * collisione si manifesta come un invio attribuito al plant sbagliato. Il test lo fissa.
 *
 * @param {*} product
 * @param {*} plant
 * @returns {string}
 */
function pairKey(product, plant) {
  return `${keyPart(product)}|${keyPart(plant)}`;
}

/**
 * Il plant e' utilizzabile per un invio?
 *
 * E' LA REGOLA DIETRO IL RIFIUTO DI `sendProductToPlex`. Un plant vuoto non e' «un plant come un
 * altro»: e' la chiave con cui sono rimaste in tabella le righe scritte PRIMA della 0039 — quelle
 * che questa feature dichiara invisibili. Una scrittura con `Plant = ''` non fallirebbe: andrebbe
 * a collidere con una riga storica (violazione di unicita', il caso buono) o a RISCRIVERLA
 * (`UPDATE`, il caso muto). Il plant vuoto quindi non si normalizza e non si tollera: si rifiuta
 * prima di toccare il database.
 *
 * @param {*} plant
 * @returns {boolean}
 */
function sendablePlant(plant) {
  return keyPart(plant) !== '';
}

// ================================================================
// Indicizzazione per coppia
// ================================================================

/**
 * Indicizza righe che hanno `Product` e `Plant` sulla chiave della coppia, SCARTANDO quelle con
 * plant vuoto e dicendo quante ne ha scartate.
 *
 * E' LA DECISIONE «LE RIGHE STORICHE SONO INVISIBILI», RESA ESEGUIBILE. La 0039 non fa backfill:
 * le righe scritte prima restano in tabella con `Plant = ''` e non devono agganciare nessuna
 * coppia reale. Scartarle e' quindi corretto — ma scartarle IN SILENZIO no: `legacyIgnored` esiste
 * perche' il chiamante possa dichiararlo una volta per esecuzione. Il giorno in cui quel numero
 * non scende piu' verso zero, vuol dire che qualcuno sta ancora scrivendo senza plant.
 *
 * La riga vince la PRIMA, come `dedupeHeaders` della 0015: su una chiave primaria il duplicato non
 * esiste, e se esistesse sarebbe un dato da guardare, non da fondere.
 *
 * @param {Array<object>} rows righe con `Product` e `Plant`
 * @returns {{ index: Map<string, object>, legacyIgnored: number, duplicates: number }}
 */
function indexByPair(rows) {
  const index = new Map();
  let legacyIgnored = 0;
  let duplicates = 0;
  for (const r of rows || []) {
    if (!r) continue;
    if (!sendablePlant(r.Plant)) { legacyIgnored++; continue; }
    const k = pairKey(r.Product, r.Plant);
    if (index.has(k)) { duplicates++; continue; }
    index.set(k, r);
  }
  return { index, legacyIgnored, duplicates };
}

/**
 * Coppie distinte, nell'ordine di prima apparizione.
 * @param {Array<{Product: *, Plant: *}>} list
 * @returns {Array<{Product: string, Plant: string}>}
 */
function dedupePairs(list) {
  const seen = new Set();
  const out = [];
  for (const p of list || []) {
    if (!p) continue;
    const k = pairKey(p.Product, p.Plant);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...p, Product: keyPart(p.Product), Plant: keyPart(p.Plant) });
  }
  return out;
}

/**
 * I materiali DISTINTI di un elenco di coppie.
 *
 * Serve al job: `A_Product` e' anagrafica cross-plant (descrizione, MTART, MEINS, data di
 * modifica) e su canale IS ogni materiale costa due letture per chiave (DEC-43). Moltiplicarle per
 * il numero di plant e' costo puro per zero informazione in piu'.
 *
 * @param {Array<{Product: *}>} pairs
 * @returns {string[]}
 */
function distinctProducts(pairs) {
  const s = new Set();
  for (const p of pairs || []) {
    const k = keyPart(p && p.Product);
    if (k) s.add(k);
  }
  return [...s];
}

/**
 * Numeri del perimetro, per la voce di recap che rende VISIBILE il cambio di volume.
 * @param {Array<{Product: *, Plant: *}>} pairs
 * @returns {{ pairs: number, materials: number, plants: number }}
 */
function pairStats(pairs) {
  const list = pairs || [];
  const plants = new Set();
  for (const p of list) if (p) plants.add(keyPart(p.Plant));
  return { pairs: list.length, materials: distinctProducts(list).length, plants: plants.size };
}

// ================================================================
// Perimetro e ordine
// ================================================================

/**
 * Restringe un elenco di coppie ai plant selezionati. Selezione vuota o assente = nessuna
 * restrizione, che e' la semantica del selettore plant del cockpit (`resolveEffectivePlants`).
 *
 * NON e' un gate di licenza e non lo sostituisce: quello vive lato server e interseca sempre con i
 * plant attivi (0001). Qui si riproduce in memoria la sola parte «cosa ha scelto l'utente».
 *
 * @param {Array<{Plant: *}>} pairs
 * @param {Set<string>|Array<string>|null} selected
 * @returns {Array<object>}
 */
function narrowToPlants(pairs, selected) {
  if (selected == null) return [...(pairs || [])];
  const set = selected instanceof Set ? selected : new Set(selected);
  if (set.size === 0) return [...(pairs || [])];
  const wanted = new Set([...set].map(keyPart));
  return (pairs || []).filter((p) => p && wanted.has(keyPart(p.Plant)));
}

/**
 * Ordine di elaborazione: per plant, poi per materiale, stabile.
 *
 * Non e' una questione di cache — `plexConnection` e `plexOperationCatalog` sono `Map` chiavate sul
 * plant, non slot singoli, quindi l'ordine non cambia il numero di letture. E' leggibilita': un
 * plant che cade lascia un blocco contiguo di errori nel recap e nel CSV, invece di righe rosse
 * sparse fra i plant sani.
 *
 * @param {Array<{Product: *, Plant: *}>} pairs
 * @returns {Array<object>}
 */
function orderByPlant(pairs) {
  return [...(pairs || [])].sort((a, b) =>
    keyPart(a.Plant).localeCompare(keyPart(b.Plant))
    || keyPart(a.Product).localeCompare(keyPart(b.Product)));
}

/**
 * Selezione sotto tetto: round-robin fra i plant.
 *
 * PERCHE' NON `slice(0, max)`. `needsSend` rimette in coda ogni coppia il cui ultimo esito non e'
 * `S`/`W`, quindi un plant con la connessione Plex rotta ripresenta ogni notte esattamente le
 * stesse coppie fallite. Ordinate per plant, quelle stanno sempre in testa: con un tetto attivo i
 * plant successivi non partirebbero MAI, e nessuna riga di recap direbbe che non sono partiti —
 * direbbe solo che il tetto ha rimandato N coppie. Il round-robin garantisce che ogni plant avanzi
 * a ogni esecuzione.
 *
 * `max <= 0` significa «nessun tetto», che e' il default di `PLEX_MAT_MAX_PER_RUN`.
 *
 * L'ordine interno di ciascun plant e' quello ricevuto: chi vuole un ordine stabile passa gia'
 * `orderByPlant`. La selezione e l'ordine di elaborazione sono due decisioni distinte e restano
 * due funzioni.
 *
 * @param {Array<{Plant: *}>} pairs
 * @param {number} max
 * @returns {Array<object>}
 */
function selectFairSlice(pairs, max) {
  const list = pairs || [];
  if (!Number.isFinite(max) || max <= 0 || max >= list.length) return [...list];

  const queues = new Map();          // plant -> coppie, nell'ordine ricevuto
  for (const p of list) {
    const k = keyPart(p && p.Plant);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(p);
  }

  const out = [];
  const order = [...queues.keys()];
  let i = 0;
  while (out.length < max) {
    let served = false;
    for (const k of order) {
      const q = queues.get(k);
      if (i < q.length) {
        out.push(q[i]);
        served = true;
        if (out.length >= max) break;
      }
    }
    if (!served) break;              // tutte le code esaurite: non puo' accadere con max < length
    i++;
  }
  return out;
}

// ================================================================
// [PART-ALIVE] La part esiste ancora su Plex? (feature 0042)
// ================================================================

/**
 * Le coppie la cui part NON risulta esistere su Plex, e che quindi vanno (ri)inviate.
 *
 * PERCHE' ESISTE. Il delta si fidava solo del nostro registro: `ZMatExcLogHDR` dice «inviato» e
 * nessuno chiedeva a Plex se la part ci fosse ancora. Su un tenant di test che si azzera ogni
 * settimana — e in produzione dopo una cancellazione a mano — quelle coppie non sarebbero mai piu'
 * partite finche' il materiale non cambia in SAP: un MES a cui manca l'anagrafica, e niente che lo
 * dica.
 *
 * DUE META', E LA SECONDA PUO' NON SAPERE.
 *
 *   1. LOCALE — nessuna riga di dizionario per la coppia. E' un fatto nostro, sempre affidabile, e
 *      non e' un comportamento nuovo: e' l'implementazione mancante della 0039, che dichiarava «il
 *      primo run paga l'arretrato perche' nessuna coppia ha un mapping» mentre il delta il
 *      dizionario non lo leggeva affatto.
 *   2. REMOTA — la riga c'e', ma il suo `PlexId` non e' fra gli id del tenant. Vale SOLO se la
 *      lettura e' riuscita (`remoteKnown`): una lettura fallita non dimostra che il dato non c'e'.
 *
 * SI CONFRONTANO GLI UUID, NON I NUMERI PART, e non e' un dettaglio di gusto. `PlexId` e' cio' che
 * Plex ci ha risposto quando ha creato la part: viene dallo stesso sistema che risponde alla lista,
 * quindi la condizione si AUTO-CHIUDE — dopo un invio riuscito la riga porta l'id appena confermato,
 * e quell'id sta nel tenant al run successivo. Col numero part servirebbe una quarta convenzione di
 * confronto testuale (nel progetto ce ne sono gia' tre) e un disallineamento di grafia renderebbe la
 * coppia «mancante» PER SEMPRE: reinvio perenne, in verde. E' la cicatrice di DEC-63.
 *
 * @param {Array<{Product: string, Plant: string}>} pairs
 * @param {Map<string, object>} mappingIndex chiave di coppia -> riga di ZMatPlexMapping
 * @param {Map<string, {ids: Set<string>, remoteKnown: boolean}>} tenantByPlant per plant
 * @returns {{missing: Set<string>, noMapping: number, goneOnPlex: number, plantsUnknown: string[]}}
 */
function partMissingSet(pairs, mappingIndex, tenantByPlant) {
  const missing = new Set();
  const plantsUnknown = new Set();
  let noMapping = 0;
  let goneOnPlex = 0;

  for (const p of pairs || []) {
    if (!p) continue;
    const key = pairKey(p.Product, p.Plant);
    const row = mappingIndex && mappingIndex.get ? mappingIndex.get(key) : undefined;
    const plexId = row ? normalizeUuid(row.PlexId) : '';

    // Meta' LOCALE. Una riga senza `PlexId` vale come riga assente: dichiara una part che non sa
    // nominare, quindi non e' una prova che la part esista.
    if (!plexId) { missing.add(key); noMapping++; continue; }

    const tenant = tenantByPlant && tenantByPlant.get ? tenantByPlant.get(keyPart(p.Plant)) : undefined;
    if (!tenant || tenant.remoteKnown !== true) {
      // Meta' REMOTA non valutabile: la coppia NON si dichiara mancante. «Vuoto non e' ignoto» —
      // una lettura fallita che facesse reinviare tutto il perimetro sarebbe il difetto peggiore
      // introducibile qui, e sarebbe verde.
      plantsUnknown.add(keyPart(p.Plant));
      continue;
    }
    if (!tenant.ids.has(plexId)) { missing.add(key); goneOnPlex++; }
  }

  return { missing, noMapping, goneOnPlex, plantsUnknown: [...plantsUnknown] };
}

// ================================================================
// Delta di invio
// ================================================================

/**
 * Decide se una COPPIA (materiale, plant) va inviata.
 *
 * Viveva in srv/jobs/syncMaterialsToPlex.js ed e' arrivata qui INVARIATA (feature 0039): il difetto
 * non e' mai stato in questa funzione, era nella chiave con cui le si passava `hdr` — il job
 * indicizzava `ZMatExcLogHDR` per solo `Product` su una tabella la cui chiave e' `(Product, Plant)`
 * dalla 0031, quindi teneva l'ultima riga letta e decideva il delta di un materiale sull'esito di
 * un plant arbitrario. Spostandola qui diventa collaudabile senza runtime CAP.
 *
 * SAP traccia la modifica solo a livello di DATA (`LastChangeDate`), quindi il confronto e' a
 * granularita' giornaliera su stringhe ISO `YYYY-MM-DD`, e l'operatore e' `>=`: un materiale
 * modificato lo stesso giorno in cui e' stato inviato rientra nel delta finche' non cambia il
 * giorno. E' voluto — l'alternativa e' perdere una modifica fatta dopo l'invio.
 *
 * @param {{LastChangeDate: string|null}|undefined} detail dettaglio SAP del materiale
 * @param {{SentDate: string, Status: string}|undefined} hdr riga di ZMatExcLogHDR DELLA COPPIA
 * @param {{recvOpMissing?: boolean, partMissing?: boolean, recvOpDrifted?: boolean}} [pending]
 *   lacune note su questa coppia
 * @returns {boolean}
 */
function needsSend(detail, hdr, pending = {}) {
  // [PART-ALIVE] La part non risulta esistere su Plex: si rispedisce, qualunque cosa dicano le date.
  //
  // Sta accanto a `recvOpMissing` e per la stessa ragione: e' una condizione che non guarda il
  // calendario ma lo STATO del sistema esterno. Il nostro registro puo' dire «inviato» e Plex essere
  // vuoto — il tenant di test si azzera ogni settimana, e in produzione una part si cancella a mano.
  // Senza questa riga quelle coppie non tornerebbero mai piu' nel delta.
  //
  // Si auto-chiude: l'invio e' idempotente e scrive la riga di dizionario su tutti i suoi rami di
  // successo, quindi al run seguente la coppia ha un `PlexId` che il tenant conferma. Chi la
  // modificasse in modo da non chiudersi otterrebbe un reinvio perenne con esito verde — vedi
  // `partMissingSet` qui sopra.
  if (pending && pending.partMissing) return true;
  // [W1-03] La coppia ASPETTA l'operazione di ricevimento e non ce l'ha: si rispedisce.
  //
  // Sta PRIMA delle altre perche' e' l'unica che non guarda le date, e senza di lei il buco non si
  // richiuderebbe mai: un ricevimento fallito lascia lo stato a 'W' (la part e' uscita, DEC-38) e
  // 'W' conta come inviato, quindi la coppia sparirebbe dal delta con l'operazione mancante finche'
  // qualcuno non tocca il materiale in SAP.
  //
  // «Aspetta» e' piu' stretto di «non ce l'ha»: lo decide `findMissingReceivingOps`, che chiede
  // anche che l'unita' di misura sia mappata sul plant di QUELLA coppia. Un materiale con
  // un'unita' fuori elenco non ha niente da attendere, e tenerlo qui lo rispediva per sempre.
  if (pending && pending.recvOpMissing) return true;
  // [RECV-OP-DRIFT] La coppia ha la sua operazione di ricevimento, ma il plant ha cambiato QUALE
  // deve essere: si rispedisce perche' e' l'invio a portarla sulla nuova (feature 0044).
  //
  // Terza della famiglia, e la posizione e' quella delle altre due: guarda lo stato del sistema
  // esterno e non il calendario. Il riallineamento passa dall'invio invece che da un passo suo
  // perche' i dati di un invio vanno SOLAMENTE nello storico del loro oggetto (DEC-96): un passo a
  // parte avrebbe bisogno di una casa per il proprio log, cioe' della schermata trasversale che
  // quella decisione vieta.
  //
  // Si auto-chiude: il passo di ricevimento aggiorna il dizionario con la nuova operazione, quindi
  // al run seguente `recvOpDrift` risponde `NONE`. Se il riallineamento NON riesce la coppia resta
  // in coda e viene ritentata ogni notte, in attenzione — la stessa proprieta' di
  // `EXISTS_INACTIVE`, ed e' cio' che rende la condizione auto-riparante invece che una tantum.
  if (pending && pending.recvOpDrifted) return true;
  if (!hdr) return true;                                     // mai inviato SU QUESTO PLANT
  if (hdr.Status !== 'S' && hdr.Status !== 'W') return true;  // ultimo invio fallito
  if (!hdr.SentDate) return true;                             // riga senza data invio
  const lastChange = detail && detail.LastChangeDate;
  if (!lastChange) return true;                               // data modifica assente -> conservativo
  return String(lastChange) >= String(hdr.SentDate);
}

module.exports = {
  keyPart,
  pairKey,
  partMissingSet,
  sendablePlant,
  indexByPair,
  dedupePairs,
  distinctProducts,
  pairStats,
  narrowToPlants,
  orderByPlant,
  selectFairSlice,
  needsSend
};
