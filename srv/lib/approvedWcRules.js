/**
 * [W1-08] Regole pure del work center approvato: UNICITA' (BBP §7.6.2) e SOTTRAZIONE verso Plex.
 *
 * DUE REGOLE, E GUARDANO LO STESSO DATO IN DUE MOMENTI OPPOSTI. `findWorkcenterConflicts` gira
 * PRIMA di scrivere, sul payload, e rifiuta un customizing che dice due cose incompatibili;
 * `diffApprovedWorkcenters` gira DOPO aver scritto su Plex, e confronta cio' che il ciclo vuole con
 * cio' che Plex ha davvero. La prima difende la coerenza di quello che salviamo, la seconda che
 * Plex assomigli a quello che abbiamo salvato — e nessuna delle due sostituisce l'altra: il
 * conflitto rifiutato non arriva mai su Plex, l'eccesso su Plex e' nato da un salvataggio corretto.
 *
 * [W1-08] LA REGOLA DI UNICITA'. «Un workcenter puo' essere associato ad una SOLA operazione
 * produttiva per part number»: dentro il ciclo di una part, un work center sta al piu' su una
 * operazione.
 *
 * IL PERIMETRO IN CUI VALE, che e' la meta' della decisione. Il confronto si fa dentro l'unita'
 * che si SCRIVE — il ciclo di (gruppo, contatore, materiale di testata) oppure il template — e
 * NON attraverso i cicli SAP diversi che producono lo stesso materiale. Su Plex la part e' una e
 * il vincolo, alla lettera, sarebbe suo; ma due cicli alternativi dello stesso materiale sono
 * dati SAP legittimi, e rifiutare il salvataggio del secondo perche' il primo tiene quel work
 * center bloccherebbe una configurazione corretta. Vedi DEC-66.
 *
 * PERCHE' RIFIUTARE E NON DEDUPLICARE. Su Plex il POST approved-workcenters risponde
 * `400 "already exist"` sulla tripla identica (partId, partOperationId, workcenterId) e
 * cat-service.js lo tratta come skip: e' l'idempotenza di Plex, non un errore. Da lì e' breve il
 * passo di pensare che anche questo conflitto si possa assorbire scartando la riga in piu' al
 * momento dell'invio — ma un work center su due operazioni NON e' una riga in piu': e' un
 * customizing che dice due cose incompatibili, e quale delle due vinca lo deciderebbe l'ordine di
 * lettura. Si rifiuta alla scrittura, dove c'e' una persona che puo' correggere.
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' stato globale. Non aggiungerne: il test si
 * lancia con `node test/approvedWcRules.test.js`. Stessa convenzione di srv/lib/splitRules.js,
 * srv/lib/isQueryShape.js, srv/lib/plexJobSortRules.js e srv/lib/recvOpRules.js.
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

/**
 * Natura del conflitto. Sono due difetti diversi e vanno letti come tali:
 *   CROSS_OP  lo stesso work center su DUE operazioni del ciclo — il caso della BBP, ed e' quello
 *             che il popover produce con un gesto normale (MultiSelect per operazione);
 *   SAME_OP   due righe identiche sulla STESSA operazione — il popover non lo produce, un payload
 *             sì. Senza questo ramo il duplicato passerebbe: `findWorkcenterConflicts` lo vedrebbe
 *             come «prima occorrenza» due volte sulla stessa chiave.
 */
const WC_CONFLICT = {
  CROSS_OP: 'CROSS_OP',
  SAME_OP: 'SAME_OP'
};

/**
 * Chiave di CONFRONTO di un work center. Normalizza solo per confrontare: il valore memorizzato e
 * inviato a Plex non viene toccato (come `normalizeUom` in srv/lib/recvOpRules.js).
 *
 * Maiuscolo e trim, e NON e' il caso di DEC-51 — dove fra due chiavi SAP il confronto e' stretto
 * perche' un disallineamento e' un difetto a monte da vedere. Qui i due lati del confronto sono
 * entrambi GUID scritti da Plex, e due work center distinti non differiscono per il solo caso:
 * ignorarlo non puo' fondere due entita' diverse, mentre rispettarlo lascerebbe passare
 * esattamente l'incoerenza che questa regola esiste per fermare.
 *
 * @param {*} value
 * @returns {string} '' quando non c'e' niente di confrontabile
 */
function wcKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

// ====================================================================================
// [WC-SUBTRACT] La SOTTRAZIONE: che cosa sta su Plex e il ciclo non vuole piu'.
//
// Le due regole di questo file guardano lo stesso dato in due momenti opposti, e la distinzione
// va tenuta a mente leggendo: `findWorkcenterConflicts` gira PRIMA di scrivere, sul payload, e
// rifiuta un customizing incoerente (DEC-66); da qui in giu' si gira DOPO aver scritto su Plex, e
// si confronta cio' che il ciclo vuole con cio' che Plex ha davvero.
//
// L'allineamento era ADDITIVO: si ri-POSTava tutto e il `400 "already exist"` di Plex faceva da
// deduplicazione. Ma quel rifiuto arriva solo sulla TRIPLA IDENTICA, quindi un work center tolto
// dall'albero restava approvato per sempre, e uno SPOSTATO da un'operazione a un'altra finiva
// approvato su entrambe — cioe' proprio la doppia approvazione che la BBP §7.6.2 vieta e che
// findWorkcenterConflicts esiste per impedire.
// ====================================================================================

/**
 * Esito del confronto di UNA assegnazione. Sette nomi e non un booleano perche' quattro di essi
 * NON producono nessuna chiamata, e vanno dichiarati con la loro ragione: «non rimosso» e «non
 * rimovibile» sono due fatti diversi per due persone diverse.
 */
const WC_DIFF = Object.freeze({
  PRESENT: 'PRESENT',                 // desiderato e gia' su Plex: nessuna chiamata
  MISSING: 'MISSING',                 // desiderato e assente su Plex: POST
  EXCESS: 'EXCESS',                   // su Plex, in perimetro, e nessun ciclo del materiale lo vuole
  NO_PART_OP: 'NO_PART_OP',           // riga locale la cui operazione non ha part-operation su Plex
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',       // riga remota su una part-operation che non e' di questo ciclo
  UNATTRIBUTABLE: 'UNATTRIBUTABLE',   // riga remota la cui tripla d'identita' non e' leggibile
  REMOTE_UNKNOWN: 'REMOTE_UNKNOWN'    // la GET non e' riuscita: nessuna rimozione
});

/** Ragione per cui un eccesso rilevato non e' stato rimosso. Ognuna e' azionabile da qualcuno. */
const WC_NOT_REMOVED = Object.freeze({
  DS_DISABLED: 'DS_DISABLED',         // interruttore di rilascio a 0: nessuna chiamata e' partita
  KEY_UNRESOLVED: 'KEY_UNRESOLVED',   // una delle tre chiavi interne non si e' potuta leggere
  KEY_AMBIGUOUS: 'KEY_AMBIGUOUS',     // la lettura della chiave ha dato piu' di una riga
  REMOVE_FAILED: 'REMOVE_FAILED'      // la Data Source di rimozione ha risposto male
});

// [LOG-MSG-I18N] `DECLARATION_MAX_CHARS` rimosso con la 0029, come in plexBomRules: le
// dichiarazioni sono segmenti e chi sfora scarta segmenti interi dichiarando quanti
// (`logMessage.pack`), invece di tagliare una frase e decidere in silenzio quali cause dire.

/**
 * L'identita' di un'assegnazione su Plex: (partOperationId, workcenterId).
 *
 * `partId` NON entra nella chiave. E' costante dentro un invio — la part del materiale — e metterlo
 * darebbe l'illusione che il confronto sia PER PART, che e' esattamente la lettura sbagliata di
 * DEC-66: due cicli SAP alternativi dello stesso materiale scrivono part-operation sulla stessa
 * part, e un confronto per part li mescolerebbe.
 *
 * Entrambi i lati sono GUID scritti da Plex, quindi si normalizzano con `wcKey` — trim e maiuscolo,
 * solo per confrontare, senza toccare i valori che si inviano (DEC-66 §7).
 *
 * Gemella di `bomRules.bomKey`, e per lo stesso motivo: un punto solo che sa com'e' fatta la chiave.
 *
 * @param {*} partOperationId
 * @param {*} workcenterId
 * @returns {string} '' se manca uno dei due: senza entrambi non c'e' identita'
 */
function awcKey(partOperationId, workcenterId) {
  const po = wcKey(partOperationId);
  const wc = wcKey(workcenterId);
  if (!po || !wc) return '';
  return `${po}|${wc}`;
}

/** Gemella di bomRules.extractBomList: array nudo, {value}, {results}, {data}. */
function extractApprovedWcList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.value)) return data.value;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

/** Primo valore non vuoto fra piu' grafie dello stesso campo. */
function pick(row, ...names) {
  for (const n of names) {
    const v = row[n];
    if (v !== null && v !== undefined && String(v).trim() !== '') return v;
  }
  return undefined;
}

/**
 * Una riga `ApprovedWorkcenter` della GET, nei campi che servono.
 *
 * SI CONSERVANO ANCHE I CODICI DI BUSINESS, e non e' ridondanza. La rimozione non passa dalla
 * Connect API — la' esistono solo GET e POST — ma dalla Data Source 755, che pretende tre CHIAVI
 * INTERE. Gli input delle tre letture che quelle chiavi le ricavano (`Part_No`, `Revision`,
 * `Operation_Code`, `Workcenter_Code`) stanno tutti in questa riga: l'identita' di cio' che si
 * cancella viene da CIO' CHE PLEX HA DETTO, non dalla riga locale, che porta solo l'UUID del work
 * center e il suo codice.
 *
 * Tollerante sulla grafia perche' il JSON e' di un sistema esterno (come readBomRow).
 *
 * @param {object} row
 * @returns {object|null} null se non c'e' niente da leggere
 */
function readApprovedWcRow(row) {
  if (!row || typeof row !== 'object') return null;
  const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
  return {
    partOperationId: str(pick(row, 'partOperationId', 'PartOperationId', 'partOperationID')),
    workcenterId: str(pick(row, 'workcenterId', 'WorkcenterId', 'workCenterId')),
    workcenterCode: str(pick(row, 'workcenterCode', 'WorkcenterCode', 'workCenterCode')),
    workcenterName: str(pick(row, 'workcenterName', 'WorkcenterName', 'workCenterName')),
    operationId: str(pick(row, 'operationId', 'OperationId')),
    operationCode: str(pick(row, 'operationCode', 'OperationCode')),
    operationNo: pick(row, 'operationNo', 'OperationNo', 'operationNumber'),
    partId: str(pick(row, 'partId', 'PartId')),
    partNo: str(pick(row, 'partNo', 'PartNo', 'partNumber')),
    partRevision: str(pick(row, 'partRevision', 'PartRevision', 'revision')),
    raw: row
  };
}

/**
 * [WC-SUBTRACT] Che cosa manca e che cosa e' in ECCESSO su Plex, dentro il perimetro del ciclo.
 *
 * IL PERIMETRO, che e' meta' della decisione (DEC-66). NON e' la part: una
 * `GET approved-workcenters?partId=` restituisce anche i work center delle operazioni dei cicli SAP
 * ALTERNATIVI dello stesso materiale, e sottrarre su quell'insieme cancellerebbe la configurazione
 * di un ciclo legittimo che chi salva non ha davanti. Il perimetro e' l'insieme delle PART-OPERATION
 * di questo ciclo, cioe' l'immagine di `cycleOpIds` attraverso `partOpIdByOpId` — e non la mappa
 * nuda, che contiene una voce per OGNI part-operation della part. Tutto cio' che cade fuori e'
 * `OUT_OF_SCOPE` e non si tocca mai.
 *
 * E DENTRO IL PERIMETRO, CIO' CHE SI TIENE E' L'UNIONE. Niente impedisce a due cicli SAP dello
 * stesso materiale di scegliere la STESSA operazione Plex: la' la part-operation su Plex e' una, e
 * la sua configurazione e' la somma dei work center dei due cicli. Percio' `keep` sono le
 * assegnazioni volute da QUALUNQUE ciclo salvato del materiale, mentre `desired` — questo ciclo —
 * guida le sole creazioni. Vale `desired ⊆ keep`, ma la funzione non lo assume.
 *
 * NIENTE RIMOZIONI SU UNA LETTURA NON RIUSCITA. Con `remoteKnown: false` l'eccesso e' `[]` per
 * costruzione e `missing` torna a essere tutto il desiderato: e' il comportamento storico, cioe'
 * POST su tutto col `400 "already exist"` di Plex come deduplicazione (DEC-53).
 *
 * E QUI VA DETTA UNA COSA CHE NON E' OVVIA, perche' e' facile difendere questo flag col motivo
 * sbagliato. L'eccesso e' `remoto ∩ perimetro − keep`, quindi una riga remota che NON arriva —
 * lettura fallita, elenco troncato, pagina non seguita — non entra in `excess`: il difetto di una
 * lettura incompleta e' che si rimuove MENO, mai che si rimuova di piu'. Un elenco parziale non puo'
 * produrre una cancellazione sbagliata, e chi cercasse qui la difesa contro quel rischio non la
 * trova perche' non serve.
 *
 * Il flag serve a DICHIARARE. Senza di lui `counts.excess === 0` su una lettura fallita e'
 * indistinguibile da un ciclo allineato: il log direbbe «niente in eccesso» quando nessuno ha
 * guardato, ed e' esattamente la confusione che i watermark della 0021 hanno pagato (DEC-58), dove
 * una lettura fallita e «non c'era niente» erano lo stesso `[]`. La seconda ragione e' `present`: su
 * una lettura non riuscita non si puo' concludere che una riga sia gia' su Plex, quindi si torna a
 * POSTare tutto invece di saltare cio' che si crede presente.
 *
 * Non muta gli input. Nessuna dipendenza: `node test/approvedWcRules.test.js`.
 *
 * @param {object} input
 * @param {Array<object>} input.desired righe di ZPlexRoutingApprovedWorkcenter di QUESTO ciclo
 * @param {Array<object>} [input.keep] righe dello STESSO materiale su qualunque ciclo salvato;
 *   assente o vuoto ⇒ si usa `desired` (la funzione e' totale)
 * @param {Array<object>} input.remote righe della GET approved-workcenters, forma Plex
 * @param {boolean} input.remoteKnown la GET e' riuscita
 * @param {Object<string,string>} input.partOpIdByOpId operationId Plex → partOperationId
 * @param {Array<string>} input.cycleOpIds i `PlexOperationId` delle operazioni di questo ciclo
 * @returns {object} { missing, present, excess, unmapped, scope, counts }
 */
function diffApprovedWorkcenters(input) {
  const inp = input || {};
  const desired = Array.isArray(inp.desired) ? inp.desired : [];
  const keepRows = Array.isArray(inp.keep) && inp.keep.length ? inp.keep : desired;
  const remoteRaw = Array.isArray(inp.remote) ? inp.remote : [];
  const remoteKnown = inp.remoteKnown === true;
  const map = inp.partOpIdByOpId && typeof inp.partOpIdByOpId === 'object' ? inp.partOpIdByOpId : {};
  const cycleOpIds = Array.isArray(inp.cycleOpIds) ? inp.cycleOpIds : [];

  // --- Il perimetro: le part-operation di QUESTO ciclo, e nient'altro. ---
  const scopeIds = new Set();
  for (const opId of cycleOpIds) {
    const partOpId = wcKey(map[opId]);
    if (partOpId) scopeIds.add(partOpId);
  }

  // --- Il desiderato di questo ciclo: guida le CREAZIONI. ---
  const desiredByKey = new Map();
  const unmapped = [];
  let desiredDuplicates = 0;
  for (const row of desired) {
    if (!row) continue;
    const partOperationId = map[row.PlexOperationId];
    if (!wcKey(partOperationId)) {
      // Operazione non ancora su Plex, o GET delle part-operation fallita. La riga non e' inviabile
      // e la sua part-operation non entra nel perimetro: senza di essa non si sa quali righe remote
      // le appartengano, quindi su quell'operazione non si puo' sottrarre nulla.
      unmapped.push({
        PlexOperationId: row.PlexOperationId,
        WorkcenterId: row.WorkcenterId,
        WorkcenterCode: row.WorkcenterCode || ''
      });
      continue;
    }
    const key = awcKey(partOperationId, row.WorkcenterId);
    if (!key) continue; // senza work center non c'e' niente da inviare (la not null la rifiuta a valle)
    if (desiredByKey.has(key)) { desiredDuplicates++; continue; }
    desiredByKey.set(key, {
      PlexOperationId: row.PlexOperationId,
      partOperationId,
      WorkcenterId: row.WorkcenterId,
      WorkcenterCode: row.WorkcenterCode || '',
      WorkcenterName: row.WorkcenterName || '',
      key
    });
  }

  // --- Cio' che si TIENE: l'unione dei cicli del materiale. Protegge, non crea. ---
  const keepKeys = new Set();
  for (const row of keepRows) {
    if (!row) continue;
    const key = awcKey(map[row.PlexOperationId], row.WorkcenterId);
    if (key) keepKeys.add(key);
  }

  // --- Cio' che Plex ha. ---
  const remoteByKey = new Map();
  let outOfScope = 0;
  let unattributable = 0;
  let remoteDuplicates = 0;
  for (const raw of remoteRaw) {
    const row = readApprovedWcRow(raw);
    if (!row) continue;
    const key = awcKey(row.partOperationId, row.workcenterId);
    if (!key) { unattributable++; continue; }
    if (!scopeIds.has(wcKey(row.partOperationId))) { outOfScope++; continue; }
    if (remoteByKey.has(key)) { remoteDuplicates++; continue; }
    remoteByKey.set(key, row);
  }

  // --- Il confronto. ---
  const missing = [];
  const present = [];
  for (const [key, row] of desiredByKey) {
    if (remoteKnown && remoteByKey.has(key)) present.push(row);
    else missing.push(row);
  }

  const excess = [];
  if (remoteKnown) {
    for (const [key, row] of remoteByKey) {
      if (keepKeys.has(key)) continue;
      excess.push({ ...row, key, PlexOperationId: opIdOfPartOp(map, row.partOperationId) });
    }
  }

  return {
    missing,
    present,
    excess,
    unmapped,
    scope: {
      partOperationIds: Array.from(scopeIds),
      operations: cycleOpIds.length,
      mapped: scopeIds.size
    },
    counts: {
      desired: desiredByKey.size,
      keep: keepKeys.size,
      present: present.length,
      missing: missing.length,
      excess: excess.length,
      unmapped: unmapped.length,
      remoteRows: remoteRaw.length,
      remoteInScope: remoteByKey.size,
      outOfScope,
      unattributable,
      remoteDuplicates,
      desiredDuplicates,
      remoteKnown
    }
  };
}

/**
 * L'operationId Plex che corrisponde a una part-operation, girando la mappa. Serve solo per
 * ETICHETTARE l'eccesso nel log con l'operazione che l'utente riconosce: la rimozione usa i codici
 * di business della riga remota, non questo.
 */
function opIdOfPartOp(map, partOperationId) {
  const target = wcKey(partOperationId);
  for (const opId of Object.keys(map)) {
    if (wcKey(map[opId]) === target) return opId;
  }
  return '';
}

/**
 * [LOG-MSG-I18N] I segmenti per il messaggio del log, o `[]` se non c'e' niente da dire.
 *
 * OGNI CAUSA COL SUO NOME E MAI FUSE (DEC-56): «rimozione disattivata» e' un parametro di rilascio,
 * «chiave non risolta» e' un dato che manca su Plex, «operazione senza part-operation» e' un invio
 * incompleto a monte. Sono tre azioni diverse per tre persone diverse, e un conteggio unico le
 * renderebbe indistinguibili.
 *
 * DALLA 0029 OGNI CAUSA E' UN SEGMENTO, e non e' un cambio di forma: e' la regola qui sopra resa
 * STRUTTURALE. Prima le sette cause finivano in una frase unica tagliata a 200 caratteri, e con le
 * ultime che sparivano era il TRONCAMENTO a decidere quali si dichiarassero — per questo la frase
 * doveva essere strettissima e ogni voce accorciata al limite della leggibilita'. Ora chi sfora
 * scarta segmenti INTERI dalla coda e dichiara quanti (`logMessage.pack`), quindi le voci possono
 * tornare a essere frasi vere.
 *
 * L'ORDINE RESTA DELIBERATO, per la stessa ragione di prima e con lo stesso effetto: prima cio' su
 * cui qualcuno deve agire, per ultimo `outOfScope`, che non e' un difetto ed e' l'unica voce che
 * nessuno deve correggere. Il dettaglio completo per causa sta nei `counts` del JSON, che non ha
 * tetto: questi segmenti sono il richiamo, non il rapporto.
 *
 * Modulo PURO: qui si scelgono le chiavi, la resa e' di srv/lib/i18nMessages.js.
 *
 * @param {object} counts conteggi del diff piu' `removed` e `notRemovedBy` (per ragione)
 * @returns {Array<{c: string, p?: Array}>}
 */
function excessDeclarationSegments(counts) {
  const c = counts || {};
  const by = c.notRemovedBy || {};
  const out = [];

  if (c.removed > 0) out.push({ c: 'logWcRemoved', p: [String(c.removed)] });
  if (by[WC_NOT_REMOVED.DS_DISABLED] > 0) {
    out.push({ c: 'logWcExcessDisabled', p: [String(by[WC_NOT_REMOVED.DS_DISABLED])] });
  }
  // Le due cause di chiave si fondono di proposito, come prima: per chi legge sono lo stesso
  // problema — la chiave interna non e' utilizzabile — e il dettaglio sta nei `counts`.
  const keyProblems = (by[WC_NOT_REMOVED.KEY_UNRESOLVED] || 0) + (by[WC_NOT_REMOVED.KEY_AMBIGUOUS] || 0);
  if (keyProblems > 0) out.push({ c: 'logWcExcessKeyUnresolved', p: [String(keyProblems)] });
  if (by[WC_NOT_REMOVED.REMOVE_FAILED] > 0) {
    out.push({ c: 'logWcRemoveFailed', p: [String(by[WC_NOT_REMOVED.REMOVE_FAILED])] });
  }
  if (c.unmapped > 0) out.push({ c: 'logWcUnmapped', p: [String(c.unmapped)] });
  if (c.remoteKnown === false) out.push({ c: 'logWcRemoteNotRead' });
  if (c.outOfScope > 0) out.push({ c: 'logWcOutOfScope', p: [String(c.outOfScope)] });

  return out;
}

/**
 * Il corpo della Data Source di rimozione (`Approved_Workcenter_Delete`, id 755). UNICO punto che
 * conosce quella forma, come `buildTecoInputs` per la 23101.
 *
 * I TRE INPUT SONO INTERI OBBLIGATORI, e si RIFIUTA invece di tirare a indovinare. `Number(null)`
 * e' `0`, che e' un intero: una chiamata con una chiave a zero non e' una chiamata a vuoto, e' una
 * cancellazione su un oggetto che non e' il nostro. E' DEC-70 alla lettera — la' dove quella chiave
 * serviva a LEGGERE il rischio era un dato in piu', qui e' cancellare l'approvazione di un altro.
 *
 * @param {{partKey: *, partOperationKey: *, workcenterKey: *}} keys
 * @returns {{Part_Key: number, Part_Operation_Key: number, Workcenter_Key: number}}
 * @throws {Error} se una delle tre non e' un intero > 0
 */
function buildApprovedWcDeleteInputs(keys) {
  const k = keys || {};
  const asKey = (value, name) => {
    if (typeof value === 'boolean') throw new Error(`${name}: chiave non valida`);
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name}: chiave non valida`);
    return n;
  };
  return {
    Part_Key: asKey(k.partKey, 'Part_Key'),
    Part_Operation_Key: asKey(k.partOperationKey, 'Part_Operation_Key'),
    Workcenter_Key: asKey(k.workcenterKey, 'Workcenter_Key')
  };
}

/**
 * L'unica riga di una lettura di chiave, o niente.
 *
 * TRE ESITI E NON DUE. Zero righe e' «non rimovibile» (si dichiara e si va avanti); PIU' di una
 * riga senza corrispondenza esatta e' `AMBIGUOUS` e si RIFIUTA — non si prende la prima, perche'
 * qui la chiave alimenta una cancellazione. Nessun secondo tentativo piu' largo: una chiave piu'
 * permissiva puo' agganciare un altro oggetto.
 *
 * @param {Array<object>} rows righe della Data Source
 * @param {string} column nome della colonna della chiave
 * @returns {{state: 'OK'|'NONE'|'AMBIGUOUS', value: number|null}}
 */
function singleKey(rows, column) {
  const list = Array.isArray(rows) ? rows : [];
  const values = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const n = Number(r[column]);
    if (Number.isInteger(n) && n > 0) values.push(n);
  }
  const distinct = Array.from(new Set(values));
  if (!distinct.length) return { state: 'NONE', value: null };
  if (distinct.length > 1) return { state: 'AMBIGUOUS', value: null };
  return { state: 'OK', value: distinct[0] };
}

/**
 * Etichetta di un'operazione per il messaggio d'errore. I ripieghi sono in ordine di leggibilita':
 * il codice e' quello che il configuratore vede in schermata, il GUID e' l'ultima spiaggia — ma
 * qualcosa deve uscire sempre, perche' un messaggio che non dice QUALE operazione tiene il work
 * center non e' azionabile.
 *
 * @param {object} op operazione nella forma del payload
 * @returns {string}
 */
function operationLabel(op) {
  if (!op) return '';
  const code = String(op.OperationCode || '').trim();
  if (code) return code;
  const name = String(op.OperationName || '').trim();
  if (name) return name;
  if (op.OperationNumber !== null && op.OperationNumber !== undefined && op.OperationNumber !== '') {
    return `#${op.OperationNumber}`;
  }
  return String(op.PlexOperationId || '').trim();
}

/** Etichetta di un work center: il codice, il nome, l'id. Stessa logica di operationLabel. */
function workcenterLabel(wc) {
  if (!wc) return '';
  const code = String(wc.WorkcenterCode || '').trim();
  if (code) return code;
  const name = String(wc.WorkcenterName || '').trim();
  if (name) return name;
  return String(wc.WorkcenterId || '').trim();
}

/**
 * I conflitti di un ciclo o di un template.
 *
 * VINCE LA PRIMA OCCORRENZA nell'ordine ricevuto, e le successive sono i conflitti: l'esito e'
 * riproducibile (nessuna dipendenza dall'ordine di lettura del database) e il messaggio puo' dire
 * «e' già sull'operazione X» indicando una sola operazione.
 *
 * @param {Array<object>} operations forma del payload delle due action:
 *   [{ PlexOperationId, OperationCode, OperationName, OperationNumber,
 *      ApprovedWorkcenters: [{ WorkcenterId, WorkcenterCode, WorkcenterName }] }]
 * @returns {Array<object>} [] quando va tutto bene; altrimenti un elemento per ogni assegnazione
 *   in eccesso: { kind, WorkcenterId, WorkcenterCode, WorkcenterName, wcLabel,
 *                 holder: {PlexOperationId, label}, offender: {PlexOperationId, label} }
 */
function findWorkcenterConflicts(operations) {
  const ops = Array.isArray(operations) ? operations : [];
  const conflicts = [];
  // chiave work center -> prima operazione che la tiene
  const holders = new Map();

  for (const op of ops) {
    if (!op) continue;
    const wcs = Array.isArray(op.ApprovedWorkcenters) ? op.ApprovedWorkcenters : [];
    const here = { PlexOperationId: op.PlexOperationId, label: operationLabel(op) };

    for (const wc of wcs) {
      if (!wc) continue;
      const key = wcKey(wc.WorkcenterId);
      // Senza id non c'e' nulla da confrontare: la riga non e' inviabile a Plex e non e' questo il
      // punto in cui si decide che farne (la `not null` di schema la rifiuta a valle).
      if (!key) continue;

      const holder = holders.get(key);
      if (!holder) {
        holders.set(key, { ...here, wc });
        continue;
      }

      // Codice e nome si prendono da CHIUNQUE dei due li porti: il client manda la riga completa,
      // ma un payload puo' portare il solo id sull'occorrenza in eccesso — e un messaggio che
      // nomina il work center col GUID quando il codice era a portata di mano non e' leggibile.
      const code = String(wc.WorkcenterCode || holder.wc.WorkcenterCode || '').trim();
      const name = String(wc.WorkcenterName || holder.wc.WorkcenterName || '').trim();

      conflicts.push({
        kind: holder.PlexOperationId === op.PlexOperationId ? WC_CONFLICT.SAME_OP : WC_CONFLICT.CROSS_OP,
        WorkcenterId: wc.WorkcenterId,
        WorkcenterCode: code,
        WorkcenterName: name,
        wcLabel: workcenterLabel({ WorkcenterCode: code, WorkcenterName: name, WorkcenterId: wc.WorkcenterId }),
        holder: { PlexOperationId: holder.PlexOperationId, label: holder.label },
        offender: here
      });
    }
  }

  return conflicts;
}

module.exports = {
  WC_CONFLICT,
  wcKey,
  operationLabel,
  workcenterLabel,
  findWorkcenterConflicts,
  // [WC-SUBTRACT]
  WC_DIFF,
  WC_NOT_REMOVED,
  awcKey,
  extractApprovedWcList,
  readApprovedWcRow,
  diffApprovedWorkcenters,
  excessDeclarationSegments,
  buildApprovedWcDeleteInputs,
  singleKey
};
