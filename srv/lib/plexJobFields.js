/**
 * [JOB-FIELDS] Regole PURE dei campi della testata job Plex ricavati dall'ordine SAP.
 *
 * PERCHE' UN MODULO PER UNA REGOLA SOLA. Il body di creazione job esiste in DUE punti — il passo 4
 * del job batch (srv/jobs/createPlexProductionOrders.js) e la creazione del pacchetto dello
 * spacchettamento (srv/lib/plexJobSplit.js) — e i due DEVONO restare identici: un pacchetto che
 * nasce con un job type diverso dal suo lotto padre e' esattamente il difetto che non si vede da
 * qui e si scopre aprendo Plex. I due file non si importano a vicenda (lo spacchettamento rilegge
 * anche le costanti d'ambiente per lo stesso motivo), quindi la regola condivisa sta in un terzo
 * posto, puro e collaudabile.
 *
 * DAL 19/08/2026 IL PACCHETTO NON RIAPPLICA LA REGOLA: COPIA IL PADRE (DEC-77). Applicare due volte
 * la stessa regola alla stessa sorgente dava due valori uguali solo finche' nessuno toccava Plex; il
 * lotto padre invece e' un oggetto vivo, e cio' che ha addosso ORA lo dice solo la lettura di A6.
 * `inheritedJobFields` e' quindi la funzione che usano i tre corpi dello spacchettamento, e
 * `jobTypeField` resta per il passo 4 del job batch, che crea il primo lotto e non ha nessun padre
 * da cui ereditare.
 *
 * Foglio `5. Orders or Jobs` del field mapping Ariston: `jobType` <- `AFKO-AUART`, in perimetro di
 * integrazione. Su Plex il job type e' una voce della setup table `part.dbo.Job_Type`; per
 * decisione di progetto (19/08/2026) l'AUART si manda COSI' COM'E', senza tabella di traduzione:
 * se i job type censiti sul tenant non coincidono coi codici SAP, Plex assegna il suo default e la
 * cosa si vede nel `RequestJson` del passo 4 — non e' un errore silenzioso.
 *
 * VALORE ASSENTE = CHIAVE OMESSA, mai stringa vuota: e' il foglio stesso a dirlo («If no value
 * submitted, the Job Type configured as "default" is assigned to the job»), e una stringa vuota
 * chiederebbe a Plex un job type che non esiste invece di non chiedere niente.
 */

'use strict';

/** Testo utilizzabile o stringa vuota: `trim` su qualunque cosa, `null`/`undefined` compresi. */
function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * [JOB-FIELDS] La quantita' da mandare a Plex, come NUMERO. FUNZIONE PURA.
 *
 * PERCHE' ESISTE. `A_ProductionOrder_2.TotalQuantity` e' un `Edm.Decimal`, e su OData V2 un decimale
 * viaggia come STRINGA JSON: nel corpo del passo 4 finiva `"quantity": "100.0"` dove il contratto
 * `AddJobInput` dichiara `number/double` (misurato il 20/08/2026 sull'ordine 000700000201). Plex ha
 * risposto `201`, quindi il difetto non si vede da qui: si vedrebbe piu' avanti, su un campo su cui
 * il suo scheduler fa aritmetica. E' la stessa forma di `toIso` per le date — una conversione sola,
 * al confine verso Plex, mai sparsa nei call site.
 *
 * NON ARROTONDA. La precisione e' quella che SAP ha mandato: `round3` esiste nello spacchettamento
 * perche' la' la quantita' viene PERSISTITA con una scala dichiarata, mentre qui si sta solo
 * ri-tipizzando un valore letto. Arrotondare significherebbe mandare a Plex una quantita' diversa
 * da quella dell'ordine.
 *
 * VALORE NON NUMERICO = CHIAVE OMESSA, e per questo torna `undefined` e non `null`: `JSON.stringify`
 * elimina la chiave, e un campo OBBLIGATORIO assente e' un `400` che nomina il campo. Un `null` su un
 * campo obbligatorio e' invece il modo di farsi rispondere «Data is Null», cioe' l'involucro generico
 * che non dice dove. Lo ZERO e' un valore e non un vuoto: la trappola del falsy va evitata qui, non
 * nei chiamanti.
 *
 * @param {number|string|null|undefined} v
 * @returns {number|undefined}
 */
function quantityOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  // Solo numero o stringa: `Number([])` vale 0 e `Number('   ')` vale 0, quindi un oggetto o una
  // stringa di soli spazi diventerebbero una quantita' NULLA invece di un dato assente.
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Il job type da mandare a Plex per un ordine.
 *
 * @param {object} order riga di `A_ProductionOrder_2` (serve `ManufacturingOrderType`, AUART)
 * @param {string|null} [fallback] ripiego globale: la variabile d'ambiente `PLEX_JOB_TYPE`.
 *   Serve ai tenant in cui il job type non dipende dall'ordine; NON e' piu' il valore primario.
 * @returns {string} il codice da mandare, o `''` se non c'e' niente da mandare
 */
function jobTypeOf(order, fallback = null) {
  return str(order && order.ManufacturingOrderType) || str(fallback);
}

/**
 * Il frammento da spargere (`...`) nel body: la chiave c'e' solo se c'e' un valore.
 * E' la forma in cui i due call site la usano, cosi' la regola «vuoto = omesso» sta qui e non
 * viene riscritta due volte con un `?:`.
 *
 * @param {object} order riga di `A_ProductionOrder_2`
 * @param {string|null} [fallback] `PLEX_JOB_TYPE`
 * @returns {{jobType?: string}}
 */
function jobTypeField(order, fallback = null) {
  const t = jobTypeOf(order, fallback);
  return t ? { jobType: t } : {};
}

/**
 * I campi di TESTATA che il contratto Plex accetta su un job e che si ereditano dal lotto padre.
 *
 * Sono esattamente i quattro non-quantitativi dello schema `UpdateJob`
 * (PUT /scheduling/v1/jobs/{id}), e la lettura `GET /scheduling/v1/jobs?jobNumber=` li restituisce
 * con gli STESSI nomi e la stessa forma: e' per questo che l'eredita' e' una copia e non una
 * conversione. `dueDate` e `quantity` non sono qui perche' li decide lo spacchettamento, non il
 * padre. Vedi srv/external/PLEX_JOB_API_CONTRACT.md.
 */
const INHERITABLE_FIELDS = Object.freeze(['jobType', 'buildingId', 'priority', 'earliestStartDateTime']);

/**
 * Il frammento di testata da spargere (`...`) nel body di una scrittura su un job che DISCENDE da
 * un lotto gia' presente su Plex — l'aggiornamento del lotto padre stesso, o la creazione di un
 * pacchetto di spacchettamento.
 *
 * PRECEDENZA: job padre -> AUART dell'ordine -> ripiego d'ambiente, e vale per il solo `jobType`.
 * Gli altri tre si copiano dal padre o non ci sono: il progetto non ha una sorgente SAP per building
 * e priorita', e inventarne una qui significherebbe riscrivere su Plex un valore che qualcuno ha
 * cambiato la' (stessa ragione di TD-8 per la `dueDate`, stessa precedenza di DEC-76 punto 3).
 *
 * VALORE ASSENTE = CHIAVE OMESSA, mai stringa vuota: e' la regola di `jobTypeField`, e qui vale
 * anche per i tre opzionali. Un padre senza priorita' non deve far viaggiare `priority: ''`.
 *
 * Il valore si copia COM'E', senza `trim`: e' un'eco di cio' che Plex ci ha appena dato, non un
 * dato letto da SAP da normalizzare. Il `trim` interviene solo sui ripieghi, dentro `jobTypeOf`.
 *
 * @param {object|null} parentJob riga del job padre letta da `GET /scheduling/v1/jobs`
 * @param {{order?: object|null, fallback?: string|null}} [opts]
 *   `order` riga di `A_ProductionOrder_2` (AUART), `fallback` la variabile `PLEX_JOB_TYPE`
 * @returns {{jobType?: string, buildingId?: string, priority?: string, earliestStartDateTime?: string}}
 */
function inheritedJobFields(parentJob, { order = null, fallback = null } = {}) {
  const out = {};
  for (const key of INHERITABLE_FIELDS) {
    const v = parentJob ? parentJob[key] : undefined;
    if (str(v)) out[key] = v;
  }
  // Il padre non porta il tipo: si ricade su cio' che il codice faceva prima di DEC-77, cosi'
  // l'eredita' puo' solo aggiungere informazione e mai toglierne.
  if (!out.jobType) Object.assign(out, jobTypeField(order, fallback));
  return out;
}

/**
 * [JOB-WINDOW] La finestra di schedulazione: si manda `earliestStartDateTime` oppure no.
 * FUNZIONE PURA.
 *
 * PERCHE' ESISTE. Nacque il 20/08/2026 come ultima ipotesi su un `500 REQUEST_PROCESSING_ERROR` /
 * «Data is Null…» che allora cadeva su `list-jobs` con filtro, sul `PUT /jobs/{id}` e sul
 * `POST /jobs/{id}/backwards-schedule`, mentre `POST /jobs` e le Data Source rispondevano. L'unica
 * variabile mai cambiata era che `earliestStartDateTime` fosse IDENTICO a `dueDate`, perche' in SAP
 * `MfgOrderPlannedStartDate` = `MfgOrderPlannedEndDate`.
 *
 * NON ERA LA CAUSA — il difetto era di Plex e Rockwell l'ha corretto il 27/08/2026 (verificato sul
 * tenant; la terza chiamata, la lettura con filtro, era invece un errore NOSTRO, vedi DEC-80). La
 * REGOLA pero' resta, perche' non dipendeva dal difetto: uno scheduler a rovescio con zero spazio non
 * ha niente su cui calcolare, e il campo e' opzionale in `AddJobInput` e in `UpdateJob`.
 *
 * LA REGOLA. Il campo si manda solo se e' STRETTAMENTE precedente alla data di consegna. Uguale,
 * successiva, assente o non interpretabile => non si manda: e' opzionale in `AddJobInput` e in
 * `UpdateJob`, e senza vincolo di inizio Plex schedula a rovescio dalla consegna, com'era prima che
 * il progetto cominciasse a riempirlo.
 *
 * NESSUNA DATA SI INVENTA. Non si sottrae un lead time che il progetto non ha: si toglie un vincolo
 * impossibile, non se ne fabbrica uno plausibile.
 *
 * @returns {{send: boolean, state: 'ok'|'degenere'|'assente'|'illeggibile', ms: number|null, note: string}}
 */
function schedulingWindow({ start, due } = {}) {
  const s = str(start);
  const d = str(due);
  if (!s) {
    return { send: false, state: 'assente', ms: null, note: 'nessuna data di inizio: earliestStartDateTime non inviato' };
  }
  const ts = Date.parse(s);
  const td = Date.parse(d);
  if (!Number.isFinite(ts) || !Number.isFinite(td)) {
    return {
      send: false,
      state: 'illeggibile',
      ms: null,
      note: `date non interpretabili (inizio=${s || '(vuota)'}, consegna=${d || '(vuota)'}): `
        + 'earliestStartDateTime non inviato'
    };
  }
  if (ts < td) {
    return { send: true, state: 'ok', ms: td - ts, note: `finestra di ${td - ts} ms: earliestStartDateTime=${s}` };
  }
  return {
    send: false,
    state: 'degenere',
    ms: td - ts,
    note: `finestra di ampiezza ${td - ts} ms (inizio=${s}, consegna=${d}): earliestStartDateTime NON inviato, `
      + 'Plex schedula a rovescio dalla consegna'
  };
}

/** Il frammento da spargere in un corpo: `{}` oppure `{earliestStartDateTime}`. PURA. */
function earliestStartField({ start, due } = {}) {
  const w = schedulingWindow({ start, due });
  return w.send ? { earliestStartDateTime: start } : {};
}

/**
 * [JOB-PUT] I DUE corpi del `PUT /scheduling/v1/jobs/{id}`, in ordine di tentativo. FUNZIONE PURA.
 *
 * PERCHE' DUE. Nel 20/08/2026 l'aggiornamento rispondeva `500 REQUEST_PROCESSING_ERROR` /
 * «Data is Null…» sia col corpo intero sia senza `buildingId` — due tentativi misurati, non ipotesi —
 * e il secondo corpo serviva a far dire al log QUALE forma il tenant accettasse, invece di farci
 * indovinare. Restano fuori solo i due campi OPZIONALI che rimandiamo per eco (`priority`,
 * `earliestStartDateTime`); i tre obbligatori dello schema `UpdateJob` ci sono in entrambi.
 *
 * IL DIFETTO E' CHIUSO dal 27/08/2026 (corretto da Rockwell, verificato sul tenant): il primo corpo
 * passa, e il secondo tentativo non si esercita quasi mai. La scala resta come rete su un `5xx`
 * futuro e costa zero finche' il primo corpo riesce — ma se un giorno si volesse semplificare a un
 * corpo solo, si tocca ANCHE `putJobHeader` in srv/lib/plexJobSplit.js, il campo `cleared`,
 * `clearedNote()` e i passi «tentativo scartato» nei tre call site. Non e' una riga da togliere.
 *
 * ORDINE DELLE CHIAVI come il sample della documentazione. Non ha alcun effetto — in JSON un
 * oggetto non e' una sequenza — ma allinearlo costa zero e toglie una domanda dal tavolo.
 *
 * ATTENZIONE, e va detto al chiamante: un `PUT` e' il modello INTERO, non una patch (DEC-77).
 * Il secondo corpo, se passa, **azzera** `priority` ed `earliestStartDateTime` sul job. Il contratto
 * dichiara `priority` opzionale con il default del tenant come ripiego; sulla data di inizio no.
 * Per questo `cleared` dice cosa il ripiego lascia indietro: chi lo usa lo dichiara.
 *
 * @param {object} inherited testata ereditata (`inheritedJobFields`)
 * @param {{dueDate: string|null, quantity: number}} o
 * @returns {Array<{body: object, kind: string, cleared: string[]}>} primo = modello intero
 */
function jobPutBodies(inherited, { dueDate, quantity }) {
  const h = inherited || {};
  // La quantita' si ri-tipizza QUI perche' questo e' il punto unico dei corpi di testata: i tre
  // chiamanti dello spacchettamento arrivano gia' numerici (`num()`), e `quantityOf` e' idempotente.
  const qty = quantityOf(quantity);
  const full = { dueDate, quantity: qty };
  if (str(h.buildingId)) full.buildingId = h.buildingId;
  full.jobType = h.jobType;
  if (str(h.priority)) full.priority = h.priority;
  // [JOB-WINDOW] Il vincolo di inizio viaggia solo se e' una finestra vera: uguale alla consegna
  // significa zero spazio, e uno scheduler a rovescio non ha su cosa calcolare. Era anche una delle
  // ipotesi sul `500` del 20/08/2026, che si e' rivelata falsa (difetto Plex, corretto il 27/08).
  Object.assign(full, earliestStartField({ start: h.earliestStartDateTime, due: dueDate }));

  const minimal = { dueDate, quantity: qty, jobType: h.jobType };
  // Cosa il corpo ridotto lascia indietro: la DIFFERENZA vera fra i due, non un elenco scritto a
  // mano. Un `PUT` e' il modello intero (DEC-77), quindi ogni chiave che c'e' nell'intero e non nel
  // ridotto viene AZZERATA su Plex — building compreso.
  const cleared = Object.keys(full).filter((k) => !(k in minimal));

  const out = [{ body: full, kind: 'modello intero', cleared: [] }];
  // Se il minimo e' identico all'intero non c'e' un secondo tentativo da fare.
  if (Object.keys(full).length > Object.keys(minimal).length) {
    out.push({ body: minimal, kind: 'soli campi obbligatori', cleared });
  }
  return out;
}

module.exports = {
  quantityOf,
  jobTypeOf,
  jobTypeField,
  inheritedJobFields,
  jobPutBodies,
  schedulingWindow,
  earliestStartField,
  INHERITABLE_FIELDS
};
