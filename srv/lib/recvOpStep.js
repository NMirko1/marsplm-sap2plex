/**
 * [W1-03] Passo accessorio dell'invio materiale — operazione di RICEVIMENTO su Plex (BBP §7.3.4).
 *
 * Un materiale che Plex non produce non ha ciclo, quindi su Plex e' una part nuda: nessuna
 * part-operation, e niente su cui riceverlo. Questo modulo istanzia sulla part l'operazione di
 * ricevimento che spetta alla sua unita' di misura, UNA volta sola per (materiale, PLANT).
 *
 * [MAT-PLANT-PAIR] «Per plant» dalla feature 0039, e prima diceva «nella vita del materiale»: la
 * part e' per (materiale, plant) — un tenant Plex per plant dalla 0020 — quindi la sua
 * part-operation lo e' altrettanto. Il customizing che decide questo passo era gia' per plant su
 * entrambi i lati (`ZMatRecvOpConfig`, la classe dalle categorie del plant): era il DIZIONARIO a
 * dimenticare il contesto, e il primo plant che passava decideva per tutti.
 *
 * Tre responsabilita', e nessun'altra:
 *   1. risolvere il customizing del plant e il seed delle classi part type, con cache
 *      module-scoped + TTL sul modello di srv/lib/plexJobSort.js;
 *   2. eseguire GET e POST verso /mdm/v1/part-operations e interpretarne l'esito (le regole
 *      sono nel modulo puro srv/lib/recvOpRules.js);
 *   3. persistere il dizionario ZMatRecvOpMapping, che e' cio' che rende il passo idempotente.
 *
 * L'IDEMPOTENZA sta su tre livelli, ed e' voluta cosi': il dizionario risponde senza toccare la
 * rete dal secondo invio in poi; una lettura mirata verso Plex copre il primo invio di una part
 * che l'operazione ce l'ha gia'; e una rilettura dopo un tentativo rifiutato chiude il caso in
 * cui il rifiuto ERA «esiste gia'». Senza il terzo livello, un materiale la cui operazione
 * esiste ma che la prima lettura non vede ripete lo stesso POST a ogni esecuzione, per sempre.
 *
 * NON LANCIA MAI: ogni esito e' un valore di ritorno. La part e' gia' uscita su Plex quando
 * questo passo gira, e un'eccezione qui rovescerebbe l'esito di un'operazione riuscita —
 * esattamente cio' che DEC-38 vieta. Vale anche per la scrittura del dizionario: se fallisce,
 * l'esito resta quello della chiamata e il prossimo invio ritentera'.
 *
 * NESSUN req.error: dentro un'action esiste un request context e un req.error rollerebbe
 * indietro anche le righe di log (DEC-11).
 */

'use strict';

const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const R = require('./recvOpRules');
// [PLEX-OP-TYPE] Il tipo dell'operazione lo dichiara il CATALOGO Plex, non il nostro customizing
// (feature 0024, DEC-84): una lettura per plant, con cache e TTL, e la precedenza risolta dalla
// stessa funzione che usa la sincronizzazione del ciclo — cosi' le due non possono divergere.
const opCatalog = require('./plexOperationCatalog');
const { resolveOpType } = require('./plexOpFieldMapper');
// [W1-02] QUALI classi vogliono l'operazione lo dice la value help delle classi materiale, non
// questa feature: `classInfo(...).requiresReceivingOp` e' l'aggancio che W1-02 ha introdotto
// dichiarandolo destinato a W1-03. Si riusa anche la sua cache, invece di rileggere la stessa
// tabella con una seconda.
const { loadPartTypeIndex } = require('./materialVisibility');
const { classInfo } = require('./materialClass');
// [MAT-PLANT-PAIR] La chiave della coppia e il rifiuto del plant vuoto, condivisi con l'invio
// materiale e col job: una sola definizione. Regole pure: node test/matPlantRules.test.js
const { keyPart, sendablePlant } = require('./matPlantRules');

const NS = 'avvaleplm.marsplm.sap2plex';
const E_RECV_CONFIG = `${NS}.ZMatRecvOpConfig`;
const E_RECV_MAPPING = `${NS}.ZMatRecvOpMapping`;

/** TTL della cache di customizing. L'invalidazione esplicita e' il meccanismo, il TTL la rete. */
const CONFIG_TTL_MS = Number(process.env.PLEX_RECV_OP_CONFIG_TTL_MS || 60000);

// Cache module-scoped, come activePlantsCache e la configurazione del passo 8.
const configCache = new Map();     // plant -> { at, value: Array<riga ZMatRecvOpConfig> }

/**
 * Righe di customizing del plant piu' l'ESITO della lettura.
 *
 * Lettura FALLITA => elenco vuoto **e `ok: false`**, e le due informazioni non si sovrappongono.
 * Per la CREAZIONE l'elenco vuoto basta: l'effetto e' «nessuna unita' mappata», cioe' `NO_CONFIG`,
 * e non si emette una chiamata verso Plex su una configurazione che non si e' potuta leggere.
 *
 * [RECV-OP-DRIFT] Per il confronto col dizionario no, e per questo `ok` esiste (feature 0044): li'
 * un elenco vuoto significherebbe «il plant ha tolto la configurazione» (`DRIFT.GONE`), quindi un
 * guasto del database si leggerebbe come una scelta di chi configura. «Vuoto» non e' «ignoto».
 *
 * @returns {Promise<{rows: Array<object>, ok: boolean}>}
 */
async function loadRecvOpConfigState(db, plant, opts = {}) {
  const key = String(plant === null || plant === undefined ? '' : plant);
  if (!key) return { rows: [], ok: false };
  const hit = configCache.get(key);
  if (!opts.force && hit && (Date.now() - hit.at) < CONFIG_TTL_MS) return hit.value;

  let value = { rows: [], ok: true };
  try {
    value = { rows: await db.run(SELECT.from(E_RECV_CONFIG).where({ Plant: key })) || [], ok: true };
  } catch (e) {
    console.error(`>>> [W1-03] lettura customizing ricevimento del plant ${key} fallita: ${e.message}`);
    value = { rows: [], ok: false };
  }
  configCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Righe di customizing del plant, ordinate come stanno. Firma storica: rende il solo elenco.
 * Lettura FALLITA => elenco vuoto (vedi `loadRecvOpConfigState` per la distinzione).
 */
async function loadRecvOpConfig(db, plant, opts = {}) {
  return (await loadRecvOpConfigState(db, plant, opts)).rows;
}

/**
 * Svuota la cache. Chiamata dagli handler after(['CREATE','UPDATE','DELETE']) su
 * ZMatRecvOpConfig e dalla cascata di deletePlant.
 * @param {string} [plant] se assente svuota tutto
 */
function invalidateRecvOpConfigCache(plant) {
  const key = plant === null || plant === undefined ? '' : String(plant);
  if (key) {
    configCache.delete(key);
    console.log(`>>> [W1-03] cache del customizing ricevimento invalidata per il plant ${key}`);
  } else {
    configCache.clear();
    console.log('>>> [W1-03] cache del customizing ricevimento invalidata (tutti i plant)');
  }
}

/**
 * La classe del materiale vuole l'operazione di ricevimento?
 *
 * Indice vuoto (value help illeggibile) => `requiresReceivingOp: false` per ripiego di
 * classInfo, cioe' il passo non fa niente: non si inventa un perimetro che non si e' potuto
 * leggere, ed e' lo stesso fail-open con cui W1-02 tratta la stessa lettura.
 */
async function requiresReceivingOp(db, plexPartType) {
  try {
    return classInfo(await loadPartTypeIndex(db), plexPartType).requiresReceivingOp === true;
  } catch (e) {
    console.warn(`>>> [W1-03] classe materiale non risolta (${e.message}): nessuna operazione di ricevimento`);
    return false;
  }
}

/**
 * [MAT-PLANT-PAIR] La chiave del dizionario e' la COPPIA, e un plant vuoto non e' una chiave.
 *
 * Le due funzioni qui sotto rifiutano un plant vuoto invece di lasciarlo scorrere, e non e'
 * simmetria decorativa: sono due guasti diversi e tutti e due muti.
 *
 *  - `clearRecvOpMapping` senza plant sarebbe `DELETE ... where({ Product })`, cioe' la
 *    cancellazione del dizionario di TUTTI i plant a partire dal 404 di UNO. Il conteggio di righe
 *    toccate che la DELETE restituisce non lo legge nessuno, quindi non uscirebbe un solo segnale:
 *    gli altri plant ripeterebbero il POST a ogni invio e Plex risponderebbe «esiste gia'» — invio
 *    degradato a 'W' per sempre.
 *  - `readRecvOpMapping` con `Plant: undefined` produce un `where` che non matcha nulla, quindi il
 *    passo conclude «non fatta», rilegge Plex, la trova e riprova a scrivere il dizionario: la
 *    violazione di unicita' viene INGHIOTTITA da `saveRecvOpMapping`, che e' best-effort per
 *    disegno. Una GET in piu' per ogni invio, per sempre, senza una riga di errore.
 *
 * Il plant vuoto e' anche la chiave delle righe scritte prima della 0039, che devono restare
 * invisibili: agganciarle sarebbe leggere il dizionario di un tenant che non si sa quale sia.
 */

/**
 * La coppia (materiale, plant) ha gia' la sua operazione di ricevimento?
 * @returns {Promise<object|null>} riga di ZMatRecvOpMapping, o null
 */
async function readRecvOpMapping(db, product, plant) {
  if (!sendablePlant(plant)) {
    console.warn(`>>> [MAT-PLANT-PAIR] lettura dizionario ricevimento di ${product} SENZA plant:`
      + ' non si legge (una chiave a plant vuoto e\' una riga storica, non la coppia di nessuno)');
    return null;
  }
  try {
    return await db.run(
      SELECT.one.from(E_RECV_MAPPING).where({ Product: product, Plant: keyPart(plant) })
    ) || null;
  } catch (e) {
    console.warn(`>>> [W1-03] lettura dizionario ricevimento per ${product}/${plant} fallita: ${e.message}`);
    return null;
  }
}

/**
 * Cancella la riga di dizionario di una coppia (materiale, plant).
 *
 * Si chiama dal ramo 404 dell'invio materiale, insieme alla DELETE di ZMatPlexMapping: la part
 * e' stata ricreata su Plex, quindi le sue part-operation non esistono piu' e un dizionario
 * che sopravvive alla part farebbe saltare per sempre la ricreazione dell'operazione.
 * [MAT-PLANT-PAIR] Solo su QUEL tenant, pero': gli altri plant non c'entrano.
 */
async function clearRecvOpMapping(db, product, plant) {
  if (!sendablePlant(plant)) {
    console.warn(`>>> [MAT-PLANT-PAIR] pulizia dizionario ricevimento di ${product} SENZA plant:`
      + ' non si cancella niente (cancellerebbe la riga di ogni plant)');
    return;
  }
  try {
    await db.run(DELETE.from(E_RECV_MAPPING).where({ Product: product, Plant: keyPart(plant) }));
  } catch (e) {
    console.warn(`>>> [W1-03] pulizia dizionario ricevimento per ${product}/${plant} fallita: ${e.message}`);
  }
}

/** Scrittura del dizionario. Best-effort: un fallimento non cambia l'esito del passo. */
async function saveRecvOpMapping(db, row) {
  try {
    await db.run(INSERT.into(E_RECV_MAPPING).entries({ ...row, CreatedAt: new Date().toISOString() }));
    return true;
  } catch (e) {
    console.warn(`>>> [W1-03] scrittura dizionario ricevimento per ${row.Product} fallita: ${e.message}`);
    return false;
  }
}

/**
 * [RECV-OP-DRIFT] Aggiorna la riga di dizionario di una coppia dopo un riallineamento.
 *
 * Serve perche' `saveRecvOpMapping` e' un INSERT, e dopo un riallineamento la riga ESISTE gia': un
 * INSERT fallirebbe per violazione di chiave dentro il suo `try/catch` best-effort, cioe' in
 * silenzio. E il silenzio qui costa caro: il dizionario resterebbe sull'operazione vecchia, il
 * disallineamento verrebbe rilevato di nuovo al run successivo, e la part verrebbe RIPUNTATA ogni
 * notte, in eterno, con esito verde.
 *
 * A differenza della sorella NON e' best-effort nel valore di ritorno: il chiamante deve sapere se
 * la scrittura e' andata, per dichiarare `DRIFT_UNRESOLVED` invece di `REALIGNED`.
 *
 * @returns {Promise<boolean>}
 */
async function updateRecvOpMapping(db, product, plant, fields) {
  if (!sendablePlant(plant)) {
    console.warn(`>>> [RECV-OP-DRIFT] aggiornamento dizionario di ${product} SENZA plant: non si scrive`);
    return false;
  }
  try {
    await db.run(
      UPDATE(E_RECV_MAPPING).set(fields).where({ Product: product, Plant: keyPart(plant) })
    );
    return true;
  } catch (e) {
    console.error(`>>> [RECV-OP-DRIFT] aggiornamento dizionario per ${product}/${plant} fallito:`
      + ` ${e.message}`);
    return false;
  }
}

/** Esito, nella forma unica che tutti i rami restituiscono. */
function outcome(state, message, extra = {}) {
  return { state, message: message || '', partOperationId: null, exchange: null, ...extra };
}

/**
 * Legge da Plex LA part-operation di questa part per questa operazione.
 *
 * Il filtro lo fa Plex: `GET /mdm/v1/part-operations?partId=&operationId=` — entrambi sono query
 * param dichiarati dal contratto (srv/external/PLEX_PART_OPERATION_API_CONTRACT.md). Prima si
 * chiedeva la lista della sola part e si cercava a mano: il confronto lato client resta come
 * CONFERMA di cio' che e' tornato — un filtro puo' essere ignorato in silenzio, e questo progetto
 * ci e' gia' cascato (DEC-49) — ma non e' piu' l'unico criterio.
 *
 * NON si filtra su `active`: una part-operation disattivata deve essere VISTA, perche' occupa il
 * posto e non e' ricreabile (RECV_STATE.EXISTS_INACTIVE).
 *
 * Non lancia mai. Restituisce sempre la traccia di cio' che e' successo, ANCHE quando fallisce o
 * non trova: prima la GET si vedeva solo nel ramo che riusciva, e dopo tre rifiuti identici del
 * POST non era ricostruibile ne' se fosse partita ne' cosa avesse risposto. E' lo stesso
 * `console.log` che syncRoutingPlexCycle stampa da sempre al suo passo 4 (cat-service.js:5472).
 *
 * @returns {Promise<{probe: object, hit: object|null}>}
 */
async function readPartOperation({ baseUrl, headers, plexId, operationId, product, phase }) {
  const url = `${baseUrl}/mdm/v1/part-operations`
    + `?partId=${encodeURIComponent(plexId)}`
    + `&operationId=${encodeURIComponent(operationId)}`;
  const tag = `[W1-03] ${product} GET part-operations (${phase})`;
  const probe = { method: 'GET', url, phase, status: 0, ok: false, count: null, matched: false };

  try {
    const resp = await fetch(url, { method: 'GET', headers });
    probe.status = resp.status;
    probe.ok = resp.ok === true;
    if (!probe.ok) {
      console.warn(`>>> ${tag}: HTTP ${resp.status} — nessuna risposta utilizzabile`);
      return { probe, hit: null };
    }

    const data = await resp.json();
    const rows = R.extractPartOperations(data);
    probe.count = rows.length;
    const hit = R.findExistingPartOperation(data, operationId);
    probe.matched = !!hit;
    if (hit) probe.active = hit.active;

    console.log(`>>> ${tag}: HTTP ${resp.status}, ${rows.length} righe, `
      + `match=${probe.matched}${hit ? `, active=${hit.active}` : ''}`);
    if (rows.length > 0) {
      // Le chiavi grezze della prima riga: e' cosi' che si scopre in un colpo una grafia di
      // campo diversa da quella attesa, ed e' quello che fa gia' cat-service.js:5474.
      console.log(`>>> ${tag}: chiavi prima riga ${JSON.stringify(Object.keys(rows[0]))}`);
    }
    return { probe, hit };
  } catch (e) {
    probe.error = e.message;
    console.warn(`>>> ${tag}: fallita (${e.message})`);
    return { probe, hit: null };
  }
}

// ================================================================
// [RECV-OP-DRIFT] Le tre chiamate del riallineamento (feature 0044)
//
// Nessuna lancia: ognuna restituisce un esito. Stessa forma di `readPartOperation` qui sopra, e
// stessa ragione — la part e' gia' su Plex quando questo passo gira, e un'eccezione rovescerebbe
// l'esito di un'operazione riuscita (DEC-38).
// ================================================================

/**
 * `GET /mdm/v1/part-operations/{id}` — il modello ATTUALE di una part-operation.
 *
 * Endpoint che il progetto non usava. Serve al ripuntamento e non e' un lusso: un `PUT` e' il
 * modello intero (DEC-77) e `multiple` e' OBBLIGATORIO in aggiornamento, quindi senza questa
 * lettura il corpo lo porterebbe a zero su una riga viva.
 *
 * @returns {Promise<{probe: object, dto: object|null}>}
 */
async function readPartOperationById({ baseUrl, headers, partOperationId, product }) {
  const url = `${baseUrl}/mdm/v1/part-operations/${encodeURIComponent(partOperationId)}`;
  const probe = { method: 'GET', url, phase: 'pre-repoint', status: 0, ok: false };
  try {
    const resp = await fetch(url, { method: 'GET', headers });
    probe.status = resp.status;
    probe.ok = resp.ok === true;
    if (!probe.ok) {
      console.warn(`>>> [RECV-OP-DRIFT] ${product} GET part-operation ${partOperationId}:`
        + ` HTTP ${resp.status} — modello attuale non letto`);
      return { probe, dto: null };
    }
    const dto = await resp.json();
    // Le chiavi grezze: e' cosi' che si scopre in un colpo che il tenant non rende `multiple`.
    console.log(`>>> [RECV-OP-DRIFT] ${product} GET part-operation: HTTP ${resp.status},`
      + ` chiavi ${JSON.stringify(dto && typeof dto === 'object' ? Object.keys(dto) : typeof dto)}`);
    return { probe, dto: dto && typeof dto === 'object' ? dto : null };
  } catch (e) {
    probe.error = e.message;
    console.warn(`>>> [RECV-OP-DRIFT] ${product} GET part-operation fallita: ${e.message}`);
    return { probe, dto: null };
  }
}

/**
 * `PUT /mdm/v1/part-operations/{id}` — ripunta la part-operation sulla nuova operazione.
 *
 * E' la strada preferita perche' e' UNA chiamata e non ha stato intermedio: la riga resta una, e se
 * fallisce non e' cambiato niente. Il contratto non dichiara `operationId` immutabile — sta fra i
 * campi obbligatori del corpo, a differenza di `partId`, che e' escluso perche' identita' — ma
 * nemmeno lo dichiara mutabile: che il tenant lo accetti e' una premessa, e il ripiego esiste per
 * questo.
 *
 * @returns {Promise<{status: number, body: *, error: string|null, url: string}>}
 */
async function putPartOperation({ baseUrl, headers, partOperationId, body, product }) {
  const url = `${baseUrl}/mdm/v1/part-operations/${encodeURIComponent(partOperationId)}`;
  try {
    const resp = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
    const text = await resp.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
    console.log(`>>> [RECV-OP-DRIFT] ${product} PUT part-operation ${partOperationId}: HTTP ${resp.status}`);
    return { status: resp.status, body: parsed, error: null, url };
  } catch (e) {
    console.warn(`>>> [RECV-OP-DRIFT] ${product} PUT part-operation fallita: ${e.message}`);
    return { status: 0, body: null, error: e.message, url };
  }
}

/**
 * `PUT /mdm/v1/part-operations/{id}/deactivate` — spegne la part-operation vecchia.
 *
 * Senza corpo, e la risposta documentata e' `202`: ACCETTATA, non conclusa. Va in UNA direzione
 * sola — non esiste un verbo di riattivazione sulla Connect API — quindi si chiama solo dopo che la
 * nuova operazione e' stata creata: nell'ordine inverso un fallimento lascerebbe la part senza
 * nessuna operazione su cui ricevere, e senza modo di rimediare da qui.
 *
 * @returns {Promise<{ok: boolean, status: number, error: string|null}>}
 */
async function deactivatePartOperation({ baseUrl, headers, partOperationId, product }) {
  const url = `${baseUrl}/mdm/v1/part-operations/${encodeURIComponent(partOperationId)}/deactivate`;
  try {
    const resp = await fetch(url, { method: 'PUT', headers });
    console.log(`>>> [RECV-OP-DRIFT] ${product} deactivate ${partOperationId}: HTTP ${resp.status}`);
    return { ok: resp.ok === true, status: resp.status, error: null };
  } catch (e) {
    console.warn(`>>> [RECV-OP-DRIFT] ${product} deactivate fallita: ${e.message}`);
    return { ok: false, status: 0, error: e.message };
  }
}

/**
 * [RECV-OP-DRIFT] Porta la part-operation di ricevimento sulla NUOVA operazione (feature 0044).
 *
 * Si arriva qui solo con `DRIFT.CONFIG`: stessa unita' di misura, operazione diversa da quella con
 * cui il dizionario dice che l'operazione fu creata. Cioe' il plant ha cambiato il customizing dopo
 * che il materiale era gia' uscito.
 *
 * DUE STRADE, E LA PRIMA E' PREFERITA PERCHE' NON HA STATO INTERMEDIO.
 *
 *   1. `PUT /part-operations/{id}` che RIPUNTA la riga esistente: una chiamata, la part continua ad
 *      avere UNA sola operazione di ricevimento, e se fallisce non e' cambiato niente. Preceduta
 *      dalla rilettura del modello attuale, perche' un `PUT` e' il modello intero (DEC-77) e
 *      `multiple` e' obbligatorio in aggiornamento: senza rileggerlo lo si azzererebbe.
 *   2. Se Plex RIFIUTA il ripuntamento (`4xx`): si crea la nuova operazione e si disattiva la
 *      vecchia, IN QUESTO ORDINE. Nell'ordine inverso un `POST` fallito lascerebbe la part con zero
 *      operazioni utilizzabili, e la disattivazione non e' reversibile dalla Connect API.
 *
 * Il ripiego NON scatta su un guasto di trasporto o un `5xx`: la' non si sa se il ripuntamento sia
 * passato, e creare la seconda operazione lascerebbe la part con due ricevimenti attivi. E' DEC-60
 * fuori dalla contabilita' — «non so» e' piu' pericoloso di «no».
 *
 * QUALE DELLE DUE STRADE HA FUNZIONATO SI DICHIARA (`way` nell'esito, e nel log di processo): dopo
 * il primo riallineamento in DEV e' l'unica cosa che dice se il tenant accetta il ripuntamento, che
 * il contratto non garantisce.
 *
 * L'ULTIMO PASSO E' IL DIZIONARIO, e non e' una formalita': se resta sull'operazione vecchia il
 * disallineamento viene rilevato di nuovo al run successivo e la part viene ripuntata OGNI NOTTE,
 * in eterno, con esito verde. Per questo una scrittura fallita degrada a `DRIFT_UNRESOLVED` anche
 * quando Plex e' stato scritto bene.
 *
 * Non lancia mai.
 */
async function realignReceivingOp(args) {
  const {
    product, plant, plexId, db, baseUrl, consumerKey, headers, safeHeaders, mapping, resolved, drift
  } = args;
  const cfg = resolved.config;
  const opLabel = cfg.PlexOperationCode || cfg.PlexOperationId;
  const exchange = {
    method: 'PUT', url: null, headers: safeHeaders, drift: drift.drift,
    from: drift.from, to: drift.to, status: 0, way: null
  };

  /** Esito «disallineamento visto e NON risolto»: degrada, ed e' l'attenzione che resta. */
  const unresolved = (why, extra = {}) => outcome(R.RECV_STATE.DRIFT_UNRESOLVED,
    `configurazione di ricevimento cambiata (${drift.from} -> ${opLabel}) e NON riallineata: ${why}`,
    { partOperationId: mapping.PartOperationId || null, exchange: { ...exchange, ...extra } });

  /** Dizionario aggiornato: e' cio' che chiude il disallineamento. */
  const commit = async (partOperationId, way, note) => {
    const saved = await updateRecvOpMapping(db, product, plant, {
      PartOperationId: partOperationId,
      PlexOperationId: cfg.PlexOperationId,
      BaseUnit: resolved.baseUnit
    });
    exchange.way = way;
    if (!saved) {
      return unresolved('l\'operazione su Plex e\' stata riallineata ma il dizionario NON e\' stato'
        + ' aggiornato: senza quella scrittura il riallineamento verrebbe rifatto a ogni esecuzione',
        { way, partOperationId });
    }
    const msg = `operazione di ricevimento riallineata su ${opLabel}${note ? ` — ${note}` : ''}`;
    console.log(`>>> [RECV-OP-DRIFT] ${product}/${plant}: ${msg} (${way})`);
    // `way` esce anche in TESTA all'esito, non solo dentro la traccia: e' l'unica cosa che dice se
    // il tenant accetta il ripuntamento — che il contratto Plex non garantisce — e va nel recap del
    // job, non solo nel JSON del log di un singolo materiale.
    return outcome(R.RECV_STATE.REALIGNED, msg,
      { partOperationId, way, exchange: { ...exchange, way, status: exchange.status } });
  };

  // ---- il tipo della NUOVA operazione: senza, non si scrive --------------------------------
  // In creazione il ripiego `DEFAULT_OP_TYPE` produce al peggio un 400 e l'operazione non nasce.
  // Qui si scriverebbe su una riga che esiste e funziona: un tipo di ripiego la cambierebbe, e Plex
  // risponderebbe 200. Cio' che non si sa valutare non si tocca (DEC-84, DEC-99).
  const catalog = await opCatalog.loadOperationCatalog({ baseUrl, consumerKey }, plant);
  const opType = resolveOpType({ operation: opCatalog.typeOf(catalog, cfg.PlexOperationId) });
  if (opType.source === 'default') {
    return unresolved(catalog.ok
      ? `il catalogo Plex non dichiara un tipo per l'operazione ${opLabel}`
      : `catalogo operazioni non letto (${catalog.error})`);
  }

  // ---- quale part-operation stiamo per toccare? -------------------------------------------
  // Il dizionario puo' non avere l'id: `interpretReceivingOpResponse` scrive la riga anche su un
  // 2xx senza id nel corpo. Si prova a recuperarlo dalla VECCHIA operazione, con la stessa lettura
  // mirata del passo 4.
  let partOperationId = String(mapping.PartOperationId || '').trim();
  let oldActive = true;
  if (!partOperationId && drift.from) {
    const found = await readPartOperation({
      baseUrl, headers, plexId, operationId: drift.from, product, phase: 'repoint-lookup'
    });
    if (found.hit) {
      partOperationId = String(found.hit.partOperationId || '').trim();
      oldActive = found.hit.active !== false;
    }
  }

  // ---- strada 1: il ripuntamento ------------------------------------------------------------
  let refused = false;
  if (partOperationId && oldActive) {
    const current = await readPartOperationById({ baseUrl, headers, partOperationId, product });
    exchange.probe = current.probe;
    if (current.dto) {
      const built = R.buildRepointBody({ current: current.dto, config: cfg, opType: opType.value });
      if (built.ok) {
        const put = await putPartOperation({
          baseUrl, headers, partOperationId, body: built.body, product
        });
        exchange.url = put.url;
        exchange.body = built.body;
        exchange.status = put.status;
        exchange.response = R.truncate(put.body);
        if (put.status >= 200 && put.status < 300) {
          return await commit(partOperationId, 'PUT', 'ripuntata la part-operation esistente');
        }
        refused = R.repointRefused(put.status);
        if (!refused) {
          // 0 o 5xx: non si sa se sia passato. Creare la nuova qui lascerebbe due ricevimenti.
          return unresolved(`il ripuntamento non ha dato un esito conclusivo (HTTP ${put.status}`
            + `${put.error ? `, ${put.error}` : ''}): non si crea una seconda operazione su un esito`
            + ' incerto');
        }
        console.warn(`>>> [RECV-OP-DRIFT] ${product}: ripuntamento RIFIUTATO`
          + ` (HTTP ${put.status}: ${R.plexValidationText(put.body)}) — si passa al ripiego`);
      } else {
        // Manca un dato del modello attuale: scrivere il resto lo azzererebbe.
        return unresolved(`il modello attuale della part-operation e' incompleto`
          + ` (${built.missing.join(', ')}): un PUT e' il modello intero, e mandarlo cosi'`
          + ' azzererebbe cio\' che non si e\' letto');
      }
    } else {
      return unresolved('il modello attuale della part-operation non e\' leggibile: senza, il PUT'
        + ' scriverebbe al buio su una riga in esercizio');
    }
  } else if (partOperationId && !oldActive) {
    // La vecchia e' gia' spenta: ripuntarla darebbe una nuova operazione gia' spenta, cioe'
    // EXISTS_INACTIVE con un altro nome. Si crea e basta.
    console.log(`>>> [RECV-OP-DRIFT] ${product}: la part-operation di partenza e' DISATTIVATA,`
      + ' si crea direttamente quella nuova');
    refused = true;
  } else {
    // Nessun id: non c'e' niente da ripuntare, ma la nuova si puo' creare.
    console.log(`>>> [RECV-OP-DRIFT] ${product}: il dizionario non nomina la part-operation`
      + ' di partenza, si crea direttamente quella nuova');
    refused = true;
  }

  // ---- strada 2: crea la nuova, poi disattiva la vecchia ------------------------------------
  if (!refused) return unresolved('ripuntamento non tentato');
  if (!plexId) return unresolved('id della part Plex non disponibile');

  // Il POST non ha ripiego «already exist» (DEC-63 punto 2): si guarda prima. Copre anche il caso
  // in cui un run precedente aveva creato la nuova e non era riuscito a scrivere il dizionario.
  const existing = await readPartOperation({
    baseUrl, headers, plexId, operationId: cfg.PlexOperationId, product, phase: 'repoint-fallback'
  });
  exchange.recheck = existing.probe;

  let newPartOperationId = null;
  if (existing.hit && existing.hit.active) {
    newPartOperationId = existing.hit.partOperationId;
    console.log(`>>> [RECV-OP-DRIFT] ${product}: la nuova operazione era gia' sulla part`);
  } else if (existing.hit && !existing.hit.active) {
    return unresolved(`la part ha gia' l'operazione ${opLabel} ma DISATTIVATA: non e' ricreabile`
      + ' e non e\' riattivabile dalla API — va riattivata su Plex');
  } else {
    const body = R.buildReceivingOpBody({ partId: plexId, config: cfg, opType: opType.value });
    const postUrl = `${baseUrl}/mdm/v1/part-operations`;
    let status = 0;
    let respBody = null;
    try {
      const resp = await fetch(postUrl, { method: 'POST', headers, body: JSON.stringify(body) });
      status = resp.status;
      const text = await resp.text();
      try { respBody = JSON.parse(text); } catch (e) { respBody = text; }
    } catch (ePost) {
      return unresolved(`creazione della nuova operazione non riuscita: ${ePost.message}`,
        { way: 'CREATE+DEACTIVATE' });
    }
    exchange.url = postUrl;
    exchange.body = body;
    exchange.status = status;
    exchange.response = R.truncate(respBody);
    const out = R.interpretReceivingOpResponse({ status, body: respBody });
    if (out.state !== R.RECV_STATE.CREATED) {
      return unresolved(`creazione della nuova operazione rifiutata — ${out.message}`,
        { way: 'CREATE+DEACTIVATE' });
    }
    newPartOperationId = out.partOperationId;
  }

  // La disattivazione viene DOPO, sempre. Un suo fallimento non annulla il riallineamento — la
  // nuova operazione c'e' ed e' quella buona — ma lascia sulla part una riga attiva di troppo, che
  // si dichiara con il suo id perche' nessuno la ripeschera' al run successivo: il dizionario da
  // qui in poi e' allineato, quindi il disallineamento non verra' piu' rilevato.
  let deactivated = null;
  if (partOperationId && oldActive) {
    let d = await deactivatePartOperation({ baseUrl, headers, partOperationId, product });
    if (!d.ok) d = await deactivatePartOperation({ baseUrl, headers, partOperationId, product });
    deactivated = d.ok;
    exchange.deactivate = { partOperationId, status: d.status, ok: d.ok };
  }

  const note = deactivated === false
    ? `ATTENZIONE: la vecchia part-operation ${partOperationId} NON e' stata disattivata e resta`
      + ' attiva sulla part: va spenta su Plex'
    : (deactivated === true ? 'vecchia part-operation disattivata' : null);
  return await commit(newPartOperationId, 'CREATE+DEACTIVATE', note);
}

/**
 * Esegue il passo e restituisce il suo esito. Non lancia mai.
 *
 * @param {object} args
 * @param {string} args.product      materiale SAP
 * @param {string} args.plant        plant di contesto: decide QUALE customizing si applica
 * @param {string} args.plexId       id della part su Plex (ZMatPlexMapping.PlexId)
 * @param {string} args.baseUnit     MEINS del materiale, gia' letto per il mapping campi
 * @param {string|null} args.plexPartType  classe risolta dalla categoria (classifyMaterial)
 * @param {string} args.baseUrl      base URL Plex del plant (resolvePlexConnection)
 * @param {string} args.consumerKey  API key Plex del plant
 * @param {object} args.db           connessione CDS al db
 * @returns {Promise<{state: string, message: string, partOperationId: string|null,
 *                    exchange: object|null}>}
 *   `NOT_REQUIRED` => nessuna chiamata, nessuna traccia: l'assenza e' l'informazione.
 */
async function runReceivingOpStep(args) {
  const { product, plant, plexId, baseUnit, plexPartType, baseUrl, consumerKey, db } = args || {};
  try {
    if (!db) return outcome(R.RECV_STATE.NOT_REQUIRED);

    // ---- 1. la classe del materiale vuole l'operazione? (aggancio a W1-02) ---------------
    if (!await requiresReceivingOp(db, plexPartType)) {
      // Nessuna riga di log, nessun contatore: il materiale non e' un componente acquistato e
      // il suo scambio deve restare identico a quello di prima della feature.
      return outcome(R.RECV_STATE.NOT_REQUIRED);
    }

    // ---- 2. quale operazione spetta a questa unita' di misura? ---------------------------
    // [RECV-OP-DRIFT] Risolto QUI, PRIMA del dizionario, e lo spostamento e' la feature 0044.
    // Il passo usciva con «gia' fatta» appena trovava la riga di dizionario, senza nemmeno leggere
    // il customizing: un plant che cambiava l'operazione di ricevimento non la vedeva arrivare su
    // NESSUN materiale gia' inviato — nemmeno con un invio a mano dal cockpit — e in fabbrica quei
    // materiali continuavano a ricevere sull'operazione vecchia, senza una riga di log.
    const cfgState = await loadRecvOpConfigState(db, plant);
    const resolved = R.resolveReceivingOperation({ baseUnit, rules: cfgState.rows });

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Plex-Connect-Api-Key': consumerKey
    };
    // La API key non entra MAI nella traccia (RB-10 della 0006).
    const safeHeaders = { ...headers, 'X-Plex-Connect-Api-Key': '***MASKED***' };

    // ---- 3. l'abbiamo gia' fatta? (il dizionario, non il ramo CREATE/UPDATE) -------------
    const already = await readRecvOpMapping(db, product, plant);
    if (already) {
      // Il customizing NON letto non si passa: la' un elenco vuoto significherebbe «il plant ha
      // tolto la configurazione», cioe' un guasto del database letto come una scelta di chi
      // configura. «Vuoto» non e' «ignoto».
      const drift = R.recvOpDrift({
        mapping: already, resolved: cfgState.ok ? resolved : null, baseUnit
      });

      if (drift.drift === R.DRIFT.CONFIG) {
        return await realignReceivingOp({
          product, plant, plexId, db, baseUrl, consumerKey, headers, safeHeaders,
          mapping: already, resolved, drift
        });
      }

      if (drift.drift === R.DRIFT.UOM) {
        // Si DICHIARA e non si corregge: rifare la part-operation perche' e' cambiato il MEINS non
        // e' una decisione nostra, e la BBP parla solo di creazione (DEC-63 conseguenza 3). La 0044
        // ha cambiato l'ALTRO caso — la configurazione cambiata — non questo, e la distinzione e'
        // fissata da `recvOpDrift`, che valuta l'unita' per prima.
        return outcome(R.RECV_STATE.ALREADY_DONE,
          `unita' di misura cambiata dopo la creazione (${drift.fromUom} -> ${drift.toUom}):`
          + ` l'operazione di ricevimento su Plex e' ancora quella di ${drift.fromUom}`,
          { partOperationId: already.PartOperationId || null, uomChanged: true, drift: drift.drift });
      }

      if (drift.drift === R.DRIFT.GONE) {
        // [RECV-OP-DRIFT] Il customizing non risolve piu' niente per questa unita': riga
        // cancellata, disattivata, o unita' non piu' coperta. NON si spegne niente su Plex —
        // «tolgo la configurazione» non e' «spegni l'operazione in fabbrica», e una part-operation
        // disattivata non e' riattivabile dalla Connect API. Si dichiara e basta.
        return outcome(R.RECV_STATE.ALREADY_DONE,
          'la configurazione di ricevimento per questa unita\' di misura non c\'e\' piu\' (riga'
          + ' rimossa o disattivata): l\'operazione su Plex resta quella creata a suo tempo, e non'
          + ' viene spenta',
          { partOperationId: already.PartOperationId || null, drift: drift.drift });
      }

      return outcome(R.RECV_STATE.ALREADY_DONE, 'operazione di ricevimento gia\' presente',
        { partOperationId: already.PartOperationId || null });
    }

    if (!plexId) {
      return outcome(R.RECV_STATE.ERROR, 'id della part Plex non disponibile: operazione non istanziabile');
    }

    if (resolved.state !== 'OK') {
      // NON e' una lacuna dell'invio materiale, e non degrada niente (DEGRADING_STATES in
      // recvOpRules.js): l'unita' di misura non e' un dato della part su Plex — vive sul
      // componente della distinta — quindi «unita' non mappata» non descrive qualcosa che
      // manchi alla part appena uscita. Resta un esito con un suo nome, che si legge nel log
      // di processo e in `sendProductToPlex.receivingOperation`: nessun invio si tinge di
      // giallo, ma chi guarda sa perche' l'operazione non e' stata istanziata.
      const uomText = resolved.baseUnit || '(assente)';
      const message = `unita' di misura ${uomText} non mappata su un'operazione di ricevimento`
        + ` del plant ${plant || '?'}: nessuna operazione istanziata`;
      console.log(`>>> [W1-03] ${product}: ${message}`);
      return outcome(R.RECV_STATE.NO_CONFIG, message, { baseUnit: resolved.baseUnit });
    }
    const cfg = resolved.config;

    const opLabel = cfg.PlexOperationCode || cfg.PlexOperationId;

    /**
     * Riga di dizionario di questa COPPIA, con l'id della part-operation che si e' visto.
     *
     * [MAT-PLANT-PAIR] `Plant` era `plant || null` — la colonna era documentale e un `null` non
     * dava fastidio a nessuno. Dalla 0039 e' in chiave, quindi `null` viola il `NOT NULL` e
     * l'INSERT fallisce dentro il `try/catch` best-effort di `saveRecvOpMapping`: dizionario mai
     * scritto, POST ripetuto a ogni esecuzione, e nessun errore da nessuna parte. Il plant qui e'
     * gia' garantito non vuoto — `runReceivingOpStep` gira solo dietro `sendProductToPlex`, che
     * rifiuta il plant vuoto prima di toccare il database.
     */
    const remember = (partOperationId) => saveRecvOpMapping(db, {
      Product: product,
      Plant: keyPart(plant),
      PartOperationId: partOperationId,
      PlexOperationId: cfg.PlexOperationId,
      BaseUnit: resolved.baseUnit
    });

    /**
     * Esito di una lettura che ha trovato la riga: e' l'unico posto in cui si decide cosa
     * significa «c'e' gia'», e vale sia per la lettura PRIMA del POST sia per quella dopo un
     * rifiuto — cosi' le due non possono rispondere diversamente.
     */
    const fromHit = (hit, exchange, note) => {
      if (hit.active) {
        return remember(hit.partOperationId).then(() => outcome(
          R.RECV_STATE.EXISTS,
          `operazione di ricevimento gia' presente su Plex (${opLabel})${note ? ` — ${note}` : ''}`,
          { partOperationId: hit.partOperationId, exchange }
        ));
      }
      // C'e' ma e' DISATTIVATA. Non si scrive il dizionario — dire «fatta» sarebbe falso, la
      // part non ha un'operazione su cui ricevere — e non si ricrea: quella riga occupa gia' il
      // posto, il POST sarebbe il rifiuto che stiamo cercando di evitare. Riattivarla non e'
      // esprimibile sulla Connect API (il body del PUT non ha `active`, c'e' solo `deactivate`),
      // quindi l'unica cosa utile e' dirlo. Il materiale resta in coda e si richiude da solo il
      // giorno in cui qualcuno la riattiva su Plex.
      return Promise.resolve(outcome(
        R.RECV_STATE.EXISTS_INACTIVE,
        `operazione di ricevimento presente su Plex ma DISATTIVATA (${opLabel}): non e'`
        + ' utilizzabile e non e\' ricreabile — va riattivata su Plex',
        { partOperationId: hit.partOperationId, exchange }
      ));
    };

    // ---- 4. c'e' gia' su Plex? -----------------------------------------------------------
    // Il POST delle part-operation NON ha il ripiego «400 already exist» degli
    // approved-workcenter: un duplicato sarebbe un errore secco. Nel ramo EXISTING la part
    // esiste su Plex da prima e puo' avere gia' la sua operazione, quindi si guarda sempre.
    // Costa una volta sola nella vita del materiale: dal secondo invio decide il dizionario.
    const before = await readPartOperation({
      baseUrl, headers, plexId, operationId: cfg.PlexOperationId, product, phase: 'pre-post'
    });
    if (before.hit) {
      return await fromHit(before.hit, {
        method: 'GET',
        url: before.probe.url,
        status: before.probe.status,
        operationId: cfg.PlexOperationId,
        probe: before.probe
      });
    }
    // Lettura non riuscita: si prosegue col POST, come fa syncRoutingPlexCycle, che tratta la
    // GET non-ok come lista vuota. Il rischio del duplicato non resta pero' invisibile: la
    // traccia della lettura viaggia con l'esito, quindi «ho guardato e non c'era» e «non ho
    // potuto guardare» si distinguono guardando il log.

    // ---- 5. creazione --------------------------------------------------------------------
    // [PLEX-OP-TYPE] Il tipo si legge QUI e non si configura: e' `OperationDTO.type` dell'operazione
    // scelta. Nessun `remote` da conservare — se la part-operation esistesse siamo usciti al passo 4
    // — quindi la precedenza si riduce a «catalogo, altrimenti ripiego». Una lettura per plant, in
    // cache: dal secondo materiale del run non costa niente.
    const catalog = await opCatalog.loadOperationCatalog({ baseUrl, consumerKey }, plant);
    const opType = resolveOpType({ operation: opCatalog.typeOf(catalog, cfg.PlexOperationId) });
    if (opType.source === 'default') {
      // I due motivi si dichiarano separati: «non ho potuto leggere» e «quell'operazione non ha un
      // tipo» portano a interventi diversi, e un messaggio unico li renderebbe indistinguibili.
      console.warn(`>>> [PLEX-OP-TYPE] ${product}: tipo dell'operazione ${opLabel} non disponibile `
        + `(${catalog.ok ? 'il catalogo Plex non dichiara un tipo per questa operazione'
          : `catalogo operazioni non letto: ${catalog.error}`}) — si manda il ripiego «${opType.value}»`);
    }

    const body = R.buildReceivingOpBody({ partId: plexId, config: cfg, opType: opType.value });
    const postUrl = `${baseUrl}/mdm/v1/part-operations`;
    const exchange = {
      method: 'POST', url: postUrl, headers: safeHeaders, body,
      status: 0, probe: before.probe,
      // Da dove viene il tipo che e' partito: su un `400 FIELD_REFERENCE_NOT_FOUND` e' la prima
      // cosa da guardare, e senza questa riga si potrebbe solo indovinare.
      opType: opType.value, opTypeSource: opType.source
    };

    let status = 0;
    let respBody = null;
    let transportError = null;
    try {
      const resp = await fetch(postUrl, { method: 'POST', headers, body: JSON.stringify(body) });
      status = resp.status;
      const text = await resp.text();
      try { respBody = JSON.parse(text); } catch (e) { respBody = text; }
    } catch (ePost) {
      transportError = ePost.message;
    }
    exchange.status = status;
    exchange.response = R.truncate(respBody);

    const out = transportError
      ? { state: R.RECV_STATE.ERROR, partOperationId: null, message: `chiamata non riuscita: ${transportError}` }
      : R.interpretReceivingOpResponse({ status, body: respBody });

    if (out.state === R.RECV_STATE.CREATED) {
      await remember(out.partOperationId);
      console.log(`>>> [W1-03] ${product}: ${out.message}`);
      return outcome(out.state, out.message, { partOperationId: out.partOperationId, exchange });
    }

    // ---- 6. riconciliazione dopo un tentativo fallito -------------------------------------
    // Una sola rilettura. NON e' un ritentativo: DEC-60 vieta di RIPETERE la scrittura su un
    // esito non conclusivo, non di andare a GUARDARE prima di dichiarare — e qui le due
    // risposte sono opposte. Se la riga c'e', il rifiuto era «esiste gia'» oppure la POST era
    // passata malgrado il guasto di trasporto: in entrambi i casi il dizionario va scritto, o
    // ogni invio successivo ripetera' lo stesso POST all'infinito (che e' esattamente il ciclo
    // di tre righe gialle identiche da cui nasce questa correzione).
    console.warn(`>>> [W1-03] ${product}: operazione di ricevimento NON creata — ${out.message}`);
    const after = await readPartOperation({
      baseUrl, headers, plexId, operationId: cfg.PlexOperationId, product, phase: 'post-failure'
    });
    exchange.recheck = after.probe;
    if (after.hit) {
      return await fromHit(after.hit, exchange,
        `rilevata dopo un tentativo di creazione rifiutato (${out.message})`);
    }

    // Non si e' vista nemmeno adesso: l'errore resta, ma ora il messaggio dice quale campo Plex
    // contesta (plexValidationText) e la traccia dice se le due letture sono riuscite.
    if (respBody !== null && respBody !== undefined && respBody !== '') {
      // Corpo INTEGRALE in console: la nota di log ha un tetto, questo no. Su un rifiuto che il
      // contratto non enumera, quel corpo e' l'unico indizio (plexCallTrace.plexErrText).
      console.error(`>>> [W1-03] ${product}: corpo del rifiuto Plex — `
        + `${typeof respBody === 'string' ? respBody : JSON.stringify(respBody)}`);
    }
    return outcome(out.state, out.message, { partOperationId: out.partOperationId, exchange });
  } catch (err) {
    // Non lancia mai: un errore interno e' un esito. La part e' gia' su Plex.
    console.error(`>>> [W1-03] errore interno nel passo di ricevimento: ${err.message}`);
    return outcome(R.RECV_STATE.ERROR, `errore interno: ${err.message}`);
  }
}

module.exports = {
  runReceivingOpStep,
  loadRecvOpConfig,
  loadRecvOpConfigState,
  requiresReceivingOp,
  readRecvOpMapping,
  clearRecvOpMapping,
  invalidateRecvOpConfigCache
};
