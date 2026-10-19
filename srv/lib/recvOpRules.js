/**
 * [W1-03] Regole pure dell'operazione di RICEVIMENTO della materia prima (BBP §7.3.4).
 *
 * Qui vivono le sole cose di questa feature che si possono verificare SENZA Plex: se una
 * classe part type vuole l'operazione, quale operazione spetta a un'unita' di misura, la
 * forma del payload del POST, il riconoscimento della part-operation gia' presente e la
 * lettura della risposta. L'orchestrazione — customizing, dizionario, chiamate HTTP, log —
 * sta in srv/lib/recvOpStep.js.
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' stato globale. Non aggiungerne: il
 * test si lancia con `node test/recvOpRules.test.js`. Stessa convenzione di
 * srv/lib/splitRules.js, srv/lib/isQueryShape.js e srv/lib/plexJobSortRules.js.
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

/** Esiti del passo. Chiavi stabili: entrano nel contratto dell'action, nei test e nel recap. */
const RECV_STATE = {
  NOT_REQUIRED: 'NOT_REQUIRED',   // la classe del materiale non vuole l'operazione: nessuna chiamata
  ALREADY_DONE: 'ALREADY_DONE',   // dizionario presente: gia' istanziata in un invio precedente
  CREATED: 'CREATED',             // POST riuscito
  EXISTS: 'EXISTS',               // gia' presente e ATTIVA su Plex, riagganciata senza POST
  EXISTS_INACTIVE: 'EXISTS_INACTIVE', // c'e' su Plex ma e' disattivata: non utilizzabile, e non ricreabile
  NO_CONFIG: 'NO_CONFIG',         // unita' di misura non mappata, o mappata su una riga inutilizzabile
  REALIGNED: 'REALIGNED',         // [RECV-OP-DRIFT] la configurazione era cambiata: portata sulla nuova operazione
  DRIFT_UNRESOLVED: 'DRIFT_UNRESOLVED', // [RECV-OP-DRIFT] configurazione cambiata e NON riallineata
  ERROR: 'ERROR'                  // la chiamata e' partita e non e' andata a buon fine
};

/**
 * [RECV-OP-DRIFT] I quattro modi in cui il dizionario e il customizing ATTUALE possono divergere.
 *
 * Sono quattro e non due perche' due di loro si assomigliano e hanno risposte OPPOSTE: vedi
 * `recvOpDrift`.
 */
const DRIFT = Object.freeze({
  NONE: 'NONE',       // allineati, o non valutabile
  UOM: 'UOM',         // il MEINS del materiale e' cambiato in SAP: si dichiara, non si corregge
  CONFIG: 'CONFIG',   // il plant ha cambiato l'operazione per quella unita': si RIALLINEA
  GONE: 'GONE'        // il customizing non risolve piu' niente: si dichiara, non si spegne
});

/**
 * Gli esiti che degradano l'invio materiale a 'W'. Gli altri lo lasciano com'e' (DEC-38).
 *
 * `NO_CONFIG` NON c'e' piu': un'unita' di misura senza riga di ricevimento non e' una lacuna
 * dell'invio materiale. L'unita' di misura non e' un dato della part su Plex — vive sul
 * COMPONENTE della distinta — quindi «M3 non mappata» non descrive niente che manchi alla part
 * appena uscita, e su ogni materiale con un'unita' fuori elenco tingeva di giallo un invio
 * perfettamente riuscito. Resta un esito con un suo nome, leggibile in
 * `sendProductToPlex.receivingOperation` e nel log di processo, ma non e' piu' un difetto.
 *
 * `ERROR` degrada eccome: li' la chiamata e' partita verso Plex e non e' andata a buon fine, ed
 * e' l'unico caso in cui qualcosa e' davvero rotto.
 *
 * `EXISTS_INACTIVE` degrada per la ragione OPPOSTA a quella di `NO_CONFIG`: li' non mancava
 * niente alla part, qui manca davvero: la part ha la sua operazione di ricevimento ma disattivata,
 * cioe' in fabbrica non ci si puo' ricevere niente. E non e' correggibile da qui — il body del
 * `PUT /mdm/v1/part-operations/{id}` non ha `active`, e l'unico verbo di stato e' `deactivate` —
 * quindi l'unica cosa utile che si puo' fare e' dirlo.
 *
 * [RECV-OP-DRIFT] `DRIFT_UNRESOLVED` degrada, `REALIGNED` NO, ed e' la distinzione che rende utile
 * l'attenzione. Il plant ha cambiato l'operazione di ricevimento: se il riallineamento e' riuscito
 * non resta niente da fare e tingere di giallo un invio riparato toglierebbe significato al
 * semaforo; se non e' riuscito, la part riceve ancora sull'operazione vecchia ed e' esattamente il
 * fatto da vedere — «attenzione finche' non e' risolto».
 */
const DEGRADING_STATES = Object.freeze([
  RECV_STATE.ERROR,
  RECV_STATE.EXISTS_INACTIVE,
  RECV_STATE.DRIFT_UNRESOLVED
]);

/** Corpo della risposta conservato nella traccia, troncato. */
const RESPONSE_MAX_CHARS = 200;

/**
 * Tetto del messaggio d'ERRORE, piu' alto di RESPONSE_MAX_CHARS.
 *
 * Con 200 caratteri il corpo di una `ValidationResponse` di Plex si tagliava esattamente dove
 * comincia l'informazione: i primi ~120 se li mangia l'involucro fisso
 * (`REQUEST_VALIDATION_FAILED` + «The request contains data or semantics that fails one or more
 * validation rule(s).»), identico a ogni rifiuto, e del messaggio specifico restava «The sp…».
 * Il campo contestato sta li' dentro e in nessun altro posto: `errors[]` ha solo `code` e
 * `message`, non un `field`. E' la stessa ragione di `plexErrText`
 * (srv/lib/plexCallTrace.js): su un rifiuto, quel corpo e' l'unico indizio.
 *
 * Resta comunque un tetto perche' la nota di log e' additiva dentro una colonna String(4000) e
 * `withReceivingNote` la OMETTE se sfora (0006 RB-23): meglio corta che assente.
 */
const ERROR_MAX_CHARS = 600;

/**
 * [PLEX-OP-TYPE] Il ripiego del tipo NON e' piu' una copia: si importa dal modulo del payload
 * part-operation, che e' dove vive (srv/lib/plexOpFieldMapper.js). Erano due costanti identiche da
 * cambiare insieme, e il commento di prima lo diceva senza poterlo impedire.
 *
 * plexOpFieldMapper e' puro quanto questo modulo: nessun `cds`, nessuna rete, nessuno stato.
 */
const { DEFAULT_OP_TYPE } = require('./plexOpFieldMapper');

/** Default del payload, identico a quello di syncRoutingPlexCycle (cat-service.js, POST op). */
const DEFAULT_OP_NUMBER = 10;

/**
 * Unita' di misura normalizzata per il CONFRONTO.
 *
 * Tollerante su spazi e maiuscole perche' i due lati del confronto hanno autori diversi: da
 * una parte un valore DIGITATO dal configuratore nella scheda del plant, dall'altra il MEINS
 * letto da SAP. E' il caso di DEC-51 — fra un valore digitato e un valore SAP il confronto e'
 * tollerante, perche' li' il difetto sarebbe nostro. Il valore memorizzato non viene toccato:
 * si normalizza solo per confrontare.
 *
 * @param {*} value
 * @returns {string} '' quando non c'e' niente di confrontabile
 */
function normalizeUom(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

// QUALI materiali vogliono l'operazione NON si decide qui: lo dice
// classInfo(index, partType).requiresReceivingOp di srv/lib/materialClass.js, cioe' la colonna
// ZPlexPartTypeVH.RequiresReceivingOp che W1-02 ha introdotto proprio come aggancio di questa
// feature. Non se ne fa una copia: la classe e' un fatto della BBP §7.3.3/§7.3.4 e deve avere
// una sola fonte di verita'.

/**
 * L'operazione di ricevimento che spetta a un'unita' di misura, fra le righe di customizing
 * del plant.
 *
 * Le righe disattivate non partecipano, e una riga senza PlexOperationId e' inutilizzabile:
 * il POST vuole `operationId`, quindi una riga senza id NON e' una riga. La validazione in
 * scrittura la rifiuta gia' (validateMatRecvOp), ma una riga arrivata prima di quella
 * validazione non deve diventare una chiamata malformata: si tratta come «non configurata».
 *
 * @param {{baseUnit: *, rules: Array<object>}} args
 * @returns {{state: string, config: object|null, baseUnit: string}}
 *   `state`: RECV_STATE.NOT_REQUIRED se non c'e' un'unita' da cercare,
 *            RECV_STATE.NO_CONFIG se non c'e' una riga utilizzabile, altrimenti 'OK'.
 */
function resolveReceivingOperation({ baseUnit, rules } = {}) {
  const uom = normalizeUom(baseUnit);
  // Senza unita' di misura non c'e' nemmeno la domanda da porre: il materiale e' senza MEINS,
  // che e' un difetto a monte, e va dichiarato come lacuna e non come «non serve».
  if (!uom) return { state: RECV_STATE.NO_CONFIG, config: null, baseUnit: '' };

  const list = Array.isArray(rules) ? rules : [];
  const hit = list.find((r) =>
    r && r.IsActive !== false
      && normalizeUom(r.BaseUnit) === uom
      && String(r.PlexOperationId || '').trim() !== ''
  );
  if (!hit) return { state: RECV_STATE.NO_CONFIG, config: null, baseUnit: uom };
  return { state: 'OK', config: hit, baseUnit: uom };
}

/**
 * Payload del POST /mdm/v1/part-operations per l'operazione di ricevimento.
 *
 * `partId` e `operationId` sono IDENTITA' e non vengono mai dal mapping campi: e' la stessa
 * regola dei LOCKED_FIELDS di srv/lib/plexOpFieldMapper.js. Gli altri campi ripetono i default
 * di syncRoutingPlexCycle, con numero operazione e shippable presi dal customizing perche'
 * sono le due risposte ancora da avere da Rockwell.
 *
 * Non passa da buildPartOperationPayload di proposito: ZPlexOpFieldMap e' il mapping delle
 * operazioni di CICLO, e una regola SAP_FIELD su un campo del ciclo (OperationNumber,
 * WorkCenter, StandardWorkQuantity) qui si risolverebbe a vuoto — un materiale senza ciclo non
 * ha nessuno di quei campi.
 *
 * [PLEX-OP-TYPE] Il `type` arriva da FUORI, e dalla feature 0024 (DEC-84) non e' piu' un campo di
 * questo customizing. Era `ZMatRecvOpConfig.PlexOpType`, testo libero, e diceva una seconda volta
 * una cosa che il catalogo Plex dichiara gia': `OperationDTO.type` dell'operazione scelta
 * (srv/external/PLEX_OPERATION_API_CONTRACT.md). Sul tenant di Albacina il ricevimento e'
 * «Ricevere» e il ciclo «Produzione», e proprio perche' i due tipi sono diversi il valore non si
 * puo' prendere dal mapping del ciclo: darebbe un tipo che Plex ACCETTA, quindi l'operazione di
 * ricevimento nascerebbe sbagliata senza che niente lo dica. Ma non si digita nemmeno — un nome
 * sbagliato non da' un dato sbagliato, da' `400 FIELD_REFERENCE_NOT_FOUND`, e l'operazione non
 * nasce affatto. Lo legge srv/lib/recvOpStep.js dal catalogo del plant e lo passa qui.
 *
 * I due insiemi non si sovrappongono mai per costruzione: una materia prima su Plex non ha
 * ciclo — e' la premessa stessa di questa feature — quindi nessuna operazione puo' essere al
 * tempo stesso di ciclo e di ricevimento.
 *
 * `opType` assente (catalogo illeggibile, o operazione senza tipo) = ripiego al comportamento
 * storico, dichiarato dall'esito del passo (DEC-53).
 *
 * @param {{partId: string, config: object, opType: string}} args
 * @returns {object}
 */
function buildReceivingOpBody({ partId, config, opType } = {}) {
  const cfg = config || {};
  const num = Number(cfg.OperationNumber);
  return {
    partId,
    operationId: cfg.PlexOperationId,
    type: String(opType || '').trim() || DEFAULT_OP_TYPE,
    operationNumber: Number.isInteger(num) && num > 0 ? num : DEFAULT_OP_NUMBER,
    subOperation: false,
    shippable: cfg.Shippable === true,
    netWeight: 0,
    standardQuantity: 0
  };
}

/**
 * [RECV-OP-DRIFT] Il dizionario e il customizing ATTUALE dicono la stessa cosa? (feature 0044)
 *
 * PERCHE' ESISTE. Il passo di ricevimento leggeva il dizionario e usciva PRIMA di risolvere il
 * customizing: riga presente ⇒ «gia' fatta», nessuna chiamata, nessuna degradazione. Quindi un plant
 * che cambiava l'operazione di ricevimento di un'unita' di misura non la vedeva arrivare su NESSUN
 * materiale gia' inviato — nemmeno con un invio a mano dal cockpit — e in fabbrica quei materiali
 * continuavano a ricevere sull'operazione vecchia, senza una riga di log che lo dicesse.
 *
 * QUATTRO USCITE, E DUE SI ASSOMIGLIANO CON RISPOSTE OPPOSTE. Sia un MEINS cambiato in SAP sia una
 * configurazione cambiata sul plant producono lo stesso sintomo — «l'operazione del dizionario non
 * e' quella che si risolverebbe adesso» — ma:
 *
 *   - `UOM`  e' un cambio del MATERIALE, e li' vale [DEC-63] conseguenza 3: si dichiara e non si
 *            corregge. Rifare la part-operation perche' e' cambiato il MEINS non e' una decisione
 *            nostra, e la BBP parla solo di creazione.
 *   - `CONFIG` e' un cambio della CONFIGURAZIONE, cioe' proprio la richiesta esplicita del plant:
 *            si riallinea (DEC-114).
 *
 * Per questo `UOM` si valuta PER PRIMO. Senza quella precedenza il caso verrebbe classificato
 * `CONFIG` — quando l'unita' cambia, cambia anche la riga di customizing che si risolve — e una
 * decisione presa verrebbe ribaltata per effetto collaterale, su ogni materiale il cui MEINS e'
 * cambiato. E' l'asserzione piu' importante del test.
 *
 * `GONE` (il customizing non risolve piu' niente: riga cancellata, disattivata, unita' non piu'
 * coperta) non spegne niente su Plex: «tolgo la configurazione» non e' «spegni l'operazione in
 * fabbrica», e la disattivazione di una part-operation NON e' reversibile dalla Connect API.
 *
 * «NON LO SO» NON E' «DIVERSO». Un dizionario che non nomina l'operazione, un customizing non
 * valutato (`resolved` assente) o un materiale senza MEINS non producono un disallineamento: la
 * regola risponde `NONE`. Il contrario significherebbe riscrivere su Plex sulla base di
 * un'informazione che non si ha.
 *
 * @param {object} args
 * @param {object|null} args.mapping  riga di ZMatRecvOpMapping (`PlexOperationId`, `BaseUnit`)
 * @param {object|null} args.resolved esito di `resolveReceivingOperation` col customizing ATTUALE
 * @param {*} args.baseUnit           MEINS attuale del materiale
 * @returns {{drift: string, from: string, to: string, fromUom: string, toUom: string}}
 *   `from`/`to`: id dell'operazione di prima e di adesso, normalizzati.
 */
function recvOpDrift({ mapping, resolved, baseUnit } = {}) {
  const fromUom = mapping ? normalizeUom(mapping.BaseUnit) : '';
  const toUom = normalizeUom(baseUnit);
  const from = mapping ? normalizeUuid(mapping.PlexOperationId) : '';
  const to = resolved && resolved.config ? normalizeUuid(resolved.config.PlexOperationId) : '';
  const none = { drift: DRIFT.NONE, from, to, fromUom, toUom };

  // Nessuna riga di dizionario: non c'e' niente che possa essere disallineato.
  if (!mapping) return { drift: DRIFT.NONE, from: '', to: '', fromUom: '', toUom };

  // 1. L'unita' di misura, PER PRIMA. Stessa condizione che il passo applicava in loco dal 2026:
  //    servono entrambi i valori, o un materiale senza MEINS diventerebbe un disallineamento.
  if (fromUom && toUom && fromUom !== toUom) {
    return { drift: DRIFT.UOM, from, to, fromUom, toUom };
  }

  // 2. Il dizionario non dice su quale operazione l'ha creata (righe con `PlexOperationId` vuoto):
  //    non e' una prova che sia quella sbagliata.
  if (!from) return none;

  // 3. Il customizing non e' stato valutato: non si conclude niente (lettura fallita = elenco vuoto
  //    in `loadRecvOpConfig`, e li' un `NO_CONFIG` NON deve valere «configurazione rimossa»).
  if (!resolved) return none;

  // 4. Il customizing attuale non risolve nessuna operazione utilizzabile.
  if (resolved.state !== 'OK' || !to) {
    return { drift: DRIFT.GONE, from, to: '', fromUom, toUom };
  }

  // 5. Stessa unita', operazione diversa: e' il caso che si riallinea.
  if (from !== to) return { drift: DRIFT.CONFIG, from, to, fromUom, toUom };

  return none;
}

/**
 * [RECV-OP-DRIFT] Corpo del `PUT /mdm/v1/part-operations/{id}` che RIPUNTA una part-operation
 * esistente sulla nuova operazione.
 *
 * E' un READ-MODIFY-WRITE, e non puo' essere altro: un `PUT` e' il modello INTERO
 * ([DEC-77]), quindi cio' che non si manda si azzera. `multiple` e' **obbligatorio in
 * aggiornamento** e il progetto non l'ha mai mandato in nessun `PUT` di quest'area: costruire il
 * corpo dal solo customizing lo porterebbe a `0` su una riga viva, e il contratto avverte che
 * mandarlo a zero su un'operazione che ne ha un altro lo azzera. Lo stesso vale per `shippable`, di
 * cui il contratto dice «the part should have at least one shippable operation. If not, MRP
 * calculations are impacted».
 *
 * Quindi: dalla LETTURA vengono `multiple`, `netWeight`, `subOperation`, `shippable`, invariati;
 * dal customizing e dal catalogo vengono i tre soli campi che devono cambiare — `operationId`,
 * `type`, `operationNumber`.
 *
 * I campi opzionali si mandano SOLO se la lettura li ha resi: un campo che il tenant non dichiara
 * non lo si inventa, e mandarlo con un valore di comodo sarebbe la stessa scrittura al buio da cui
 * questa funzione difende.
 *
 * NON COSTRUISCE UN CORPO INCOMPLETO: `ok: false` con l'elenco di cio' che manca. Il chiamante non
 * ripiega su un default — su un `PUT` di una riga in esercizio un ripiego cambia un dato che
 * funzionava, e Plex risponde `200`.
 *
 * @param {{current: object|null, config: object, opType: string}} args
 *   `current`: PartOperationDTO letto con `GET /mdm/v1/part-operations/{id}`
 * @returns {{ok: boolean, body: object|null, missing: Array<string>}}
 */
function buildRepointBody({ current, config, opType } = {}) {
  const cur = current && typeof current === 'object' ? current : null;
  const cfg = config || {};
  const missing = [];

  const operationId = String(cfg.PlexOperationId || '').trim();
  const type = String(opType || '').trim();
  const multiple = cur ? Number(cur.multiple) : NaN;

  if (!cur) missing.push('current');
  if (!operationId) missing.push('operationId');
  // Il tipo NON ripiega su DEFAULT_OP_TYPE come fa la creazione: qui si scrive su una riga che
  // esiste e funziona, e un tipo di ripiego la cambierebbe in silenzio (DEC-84, DEC-99).
  if (!type) missing.push('type');
  if (!Number.isInteger(multiple)) missing.push('multiple');
  if (missing.length) return { ok: false, body: null, missing };

  const num = Number(cfg.OperationNumber);
  const body = {
    operationId,
    operationNumber: Number.isInteger(num) && num > 0 ? num : DEFAULT_OP_NUMBER,
    multiple,
    type
  };
  if (cur.subOperation !== undefined) body.subOperation = cur.subOperation === true;
  if (cur.shippable !== undefined) body.shippable = cur.shippable === true;
  if (cur.netWeight !== undefined && Number.isFinite(Number(cur.netWeight))) {
    body.netWeight = Number(cur.netWeight);
  }
  return { ok: true, body, missing: [] };
}

/**
 * [RECV-OP-DRIFT] Un rifiuto del ripuntamento autorizza il ripiego «crea la nuova, disattiva la
 * vecchia»?
 *
 * SOLO su un rifiuto APPLICATIVO, cioe' un `4xx`: li' Plex ha valutato la richiesta e l'ha
 * respinta, quindi la part-operation e' ancora quella di prima e creare la nuova non duplica
 * niente. Un guasto di trasporto (`status` 0) o un `5xx` sono esiti NON CONCLUSIVI: il
 * ripuntamento potrebbe essere passato, e creare una seconda operazione lascerebbe la part con due
 * ricevimenti attivi. E' [DEC-60] fuori dalla contabilita' — «non so» e' piu' pericoloso di «no».
 *
 * @param {number} status
 * @returns {boolean}
 */
function repointRefused(status) {
  const code = Number(status) || 0;
  return code >= 400 && code < 500;
}

/**
 * Le part-operation di una risposta Plex, nelle tre forme che il progetto gia' incontra:
 * array nudo, `{ value: [...] }`, `{ results: [...] }`.
 * @param {*} data
 * @returns {Array<object>}
 */
function extractPartOperations(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.value)) return data.value;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

/**
 * UUID normalizzato per il CONFRONTO.
 *
 * Case-insensitive, e qui il confronto stretto di prima era sbagliato. DEC-51, lato «fra due
 * chiavi», parla di chiavi SAP con zeri iniziali, dove la differenza e' SEMANTICA e va vista.
 * Questi sono due UUID esadecimali — uno salvato dalla tendina, che lo prende da
 * `GET /mdm/v1/operations`, l'altro letto da `GET /mdm/v1/part-operations` — e `F9EEC9B7…` e
 * `f9eec9b7…` SONO lo stesso identificativo: un confronto insensibile alla grafia non puo'
 * nascondere un disallineamento reale, perche' un disallineamento reale non e' una differenza
 * di maiuscole.
 *
 * @param {*} value
 * @returns {string} '' quando non c'e' niente di confrontabile
 */
function normalizeUuid(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

/**
 * La part-operation e' attiva?
 *
 * `active` ASSENTE vale ATTIVA: il campo e' dichiarato non obbligatorio nel `PartOperationDTO`,
 * e un tenant che non lo rende non deve far sparire un'operazione che c'e'. Solo un `false`
 * esplicito e' una disattivazione.
 *
 * @param {object} op
 * @returns {boolean}
 */
function isPartOperationActive(op) {
  if (!op) return false;
  const flag = op.active !== undefined ? op.active : op.Active;
  return flag !== false;
}

/**
 * La part-operation gia' presente sulla part per quella operazione, se c'e'.
 *
 * Serve perche' il POST delle part-operation NON ha il ripiego «400 already exist» che hanno
 * gli approved-workcenter: un duplicato sarebbe un errore secco.
 *
 * L'id della part-operation nel contratto si chiama `id` (`PartOperationDTO`: `id`, `partId`,
 * `operationId`, `type`, `operationNumber`, `active`, …): `partOperationId` NON esiste nello
 * schema, ed e' tenuto in testa alla catena solo perche' e' la grafia che syncRoutingPlexCycle
 * prova per prima da sempre. Vedi srv/external/PLEX_PART_OPERATION_API_CONTRACT.md.
 *
 * Fra piu' righe con lo stesso `operationId` vince quella ATTIVA: e' l'unica utilizzabile, e
 * agganciare una disattivata avendone una buona a fianco sarebbe una diagnosi sbagliata.
 *
 * @param {*} data risposta di GET /mdm/v1/part-operations?partId=&operationId=
 * @param {string} operationId
 * @returns {{partOperationId: string|null, active: boolean, raw: object}|null}
 */
function findExistingPartOperation(data, operationId) {
  const wanted = normalizeUuid(operationId);
  if (!wanted) return null;
  const matches = extractPartOperations(data)
    .filter((op) => op && normalizeUuid(op.operationId || op.OperationId) === wanted);
  if (!matches.length) return null;
  const hit = matches.find(isPartOperationActive) || matches[0];
  const partOperationId = hit.partOperationId || hit.id || hit.Id || null;
  return {
    partOperationId: partOperationId ? String(partOperationId) : null,
    active: isPartOperationActive(hit),
    raw: hit
  };
}

/** Testo troncato e su una riga sola, per stare nelle colonne di log e recap. */
function truncate(value, max = RESPONSE_MAX_CHARS) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Il rifiuto di Plex reso leggibile, invece del suo JSON grezzo.
 *
 * La `ValidationResponse` del contratto e' `{ code, message, errors: [{ code, message }] }`, e
 * il suo `message` di testata e' un involucro FISSO — «The request contains data or semantics
 * that fails one or more validation rule(s).» — identico a ogni rifiuto. Dentro 200 caratteri
 * di JSON grezzo restava solo quello: `FIELD_REFERENCE_YIELDS_DUPLICATE` compariva col suo
 * `message` tagliato a «The sp…», e siccome `errors[]` NON ha un campo `field`, il campo
 * contestato non si leggeva da nessuna parte.
 *
 * Qui si tiene il codice di testata, e per ogni errore il suo codice e il suo messaggio: e'
 * cio' che distingue un `FIELD_REFERENCE_NOT_FOUND` su `type` (il tenant non ha quel nome,
 * DEC-76) da un `FIELD_REFERENCE_YIELDS_DUPLICATE` (il nome ne matcha piu' di uno, oppure la
 * riga c'e' gia').
 *
 * @param {*} body corpo della risposta, gia' deserializzato o stringa
 * @param {number} [max]
 * @returns {string}
 */
function plexValidationText(body, max = ERROR_MAX_CHARS) {
  if (body === null || body === undefined || body === '') return '';
  if (typeof body !== 'object') return truncate(body, max);

  const head = String(body.code || body.Code || '').trim();
  const errors = Array.isArray(body.errors) ? body.errors
    : (Array.isArray(body.Errors) ? body.Errors : []);

  const details = errors
    .map((e) => {
      if (!e) return '';
      const c = String(e.code || e.Code || '').trim();
      const m = String(e.message || e.Message || '').trim();
      return [c, m].filter(Boolean).join(': ');
    })
    .filter(Boolean);

  // Nessun `errors` utilizzabile: si ripiega sul messaggio di testata, che a quel punto e'
  // l'unica cosa che c'e' — anche se e' l'involucro.
  const parts = details.length
    ? [head, details.join(' | ')]
    : [head, String(body.message || body.Message || '').trim()];

  const text = parts.filter(Boolean).join(' / ');
  return truncate(text || JSON.stringify(body), max);
}

/**
 * Esito del POST.
 *
 * `2xx` senza id nel corpo resta CREATED: l'operazione su Plex e' passata, e ritentarla
 * duplicherebbe. L'id assente si dichiara nel messaggio e la riga di dizionario si scrive
 * comunque — senza, il prossimo invio ripeterebbe il POST su una part che l'operazione ce
 * l'ha gia'. E' lo stesso principio di DEC-60 sul retry contabile: un esito non conclusivo
 * non si ritenta.
 *
 * @param {{status: number, body: *}} res
 * @returns {{state: string, partOperationId: string|null, message: string}}
 */
function interpretReceivingOpResponse({ status, body } = {}) {
  const code = Number(status) || 0;
  if (code >= 200 && code < 300) {
    const id = body && (body.id || body.partOperationId || body.Id);
    return {
      state: RECV_STATE.CREATED,
      partOperationId: id ? String(id) : null,
      message: id
        ? `operazione di ricevimento creata (part-operation ${id})`
        : 'operazione di ricevimento creata: Plex non ha restituito l\'id della part-operation'
    };
  }
  return {
    state: RECV_STATE.ERROR,
    partOperationId: null,
    message: `HTTP ${code || 0}: ${plexValidationText(body)}`
  };
}

/** L'esito degrada l'invio materiale a 'W'? */
function degradesSend(state) {
  return DEGRADING_STATES.includes(state);
}

module.exports = {
  RECV_STATE,
  DRIFT,
  DEGRADING_STATES,
  RESPONSE_MAX_CHARS,
  ERROR_MAX_CHARS,
  DEFAULT_OP_TYPE,
  DEFAULT_OP_NUMBER,
  normalizeUom,
  normalizeUuid,
  resolveReceivingOperation,
  buildReceivingOpBody,
  recvOpDrift,
  buildRepointBody,
  repointRefused,
  extractPartOperations,
  isPartOperationActive,
  findExistingPartOperation,
  plexValidationText,
  interpretReceivingOpResponse,
  degradesSend,
  truncate
};
