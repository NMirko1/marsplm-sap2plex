/**
 * Regole pure dello spacchettamento di un ordine di produzione su Plex (feature 0012).
 *
 * Qui vivono le decisioni delicate del flusso — codice del pacchetto, progressivo,
 * validazione della quantità, verdetto della creazione, decisione di compensare e
 * mappatura sulla matrice degli esiti (FDD 0012 §6) — estratte in funzioni **pure**
 * per un motivo preciso: sono le uniche cose di questa feature che si possono
 * verificare senza toccare Plex. Le dieci righe della matrice degli esiti diventano
 * altrettante asserzioni in test/splitRules.test.js.
 *
 * Nessuna dipendenza: né `cds`, né rete, né database. Non aggiungerne: il test si
 * lancia con `node test/splitRules.test.js`, senza runtime CAP.
 *
 * L'orchestrazione (chiamate a Plex, transazioni, lock, log) sta in srv/lib/plexJobSplit.js.
 */

'use strict';

// ================================================================
// Costanti di dominio
// ================================================================

/** Progressivo massimo di pacchetto per ordine (FR-18: da 0001 a 9999). */
const MAX_PACKAGE_SEQUENCE = 9999;

/** Decimali ammessi di default nella quantità: la Scale persistita dell'EDMX (§9.3 A-5). */
const DEFAULT_QTY_DECIMALS = 3;

/**
 * Stati di un lotto in ZProdOrderPlexMapping.SplitState (FDD 0012 §5.2).
 * Non sono annotati sull'entity con @(assert.enum, assert.values): la validazione è
 * applicativa e sta qui (DEC-02).
 */
const SPLIT_STATES = Object.freeze({
  MAIN: 'M',        // lotto principale
  PENDING: 'P',     // pacchetto in corso di creazione (riga pre-inserita prima della POST)
  ACTIVE: 'A',      // pacchetto attivo e agganciato all'ordine SAP
  INCOMPLETE: 'I',  // pacchetto attivo, un passo accessorio non è riuscito
  TO_LINK: 'L',     // pacchetto esistente su Plex ma non agganciato all'ordine SAP
  TO_RESTORE: 'R',  // pacchetto accertatamente inesistente, quantità da ripristinare
  UNCERTAIN: 'U',   // non si sa se il pacchetto esista
  CLOSED: 'X'       // mai esistito e chiuso dopo il ripristino (codice bruciato)
});

/** Stati che rappresentano un caso residuale APERTO da sanare (FR-26). */
const OPEN_RESIDUAL_STATES = new Set([
  SPLIT_STATES.PENDING, SPLIT_STATES.TO_LINK, SPLIT_STATES.TO_RESTORE, SPLIT_STATES.UNCERTAIN
]);

/** Stati che contano nella somma dei lotti e in PackageCount (contratto §3.3/§3.4). */
const COUNTED_PACKAGE_STATES = new Set([SPLIT_STATES.ACTIVE, SPLIT_STATES.INCOMPLETE]);

/** Modalità ammesse dell'action di scrittura (contratto §4.1). */
const MODES = Object.freeze({ SPLIT: 'SPLIT', COMPLETE: 'COMPLETE', RESTORE: 'RESTORE' });

/** Comandi che la finestra può proporre (contratto §3.5). */
const COMMANDS = Object.freeze({ SPLIT: 'SPLIT', COMPLETE: 'COMPLETE', RESTORE: 'RESTORE', NONE: 'NONE' });

/**
 * Da identificativo del messaggio dell'FDD (§9) alla chiave i18n usata sul filo come
 * `messageCode` (contratto §5.3). I testi vivono in
 * app/marsplm-sap2plex/webapp/i18n/i18n[_it].properties e sono letti anche dal backend (DEC-07).
 *
 * M-07 (quantità sotto il prodotto) e M-29 (quantità prodotta non determinabile) NON sono qui:
 * la decisione G3-1 del 2026-08-05 li ha ritirati insieme alla revoca di BR-12. Non
 * reintrodurli: nessun passo del backend legge quantità prodotte (TD-9).
 */
const MESSAGE_KEYS = Object.freeze({
  'M-01': 'splitOrderNotShared',
  'M-02': 'splitPlantNotUsable',
  'M-03': 'splitMainLotNotFound',
  'M-04': 'splitQtyPositive',
  'M-05': 'splitQtyBelowResidual',
  'M-06': 'splitStateChanged',
  'M-08': 'splitQtyDecimals',
  'M-09': 'splitNothingToSplit',
  'M-10': 'splitSuccess',
  'M-11': 'splitInProgress',
  'M-12': 'splitSequenceExhausted',
  'M-13': 'splitCodeTaken',
  'M-14': 'splitResyncDisabled',
  'M-15': 'splitQtyMismatch',
  'M-16': 'splitRolledBack',
  'M-16a': 'splitRolledBackNoReschedule',
  'M-16b': 'splitRollbackFailed',
  'M-17': 'splitMainRescheduleFailed',
  'M-18': 'splitPkgScheduleFailed',
  'M-19': 'splitPkgAlignFailed',
  'M-20': 'splitPkgNotLinked',
  'M-21': 'splitHistoryNotWritten',
  'M-22': 'splitResidualToLink',
  'M-22a': 'splitResidualToRestore',
  'M-23': 'splitUnexpectedError',
  'M-24': 'splitRestoreDone',
  'M-25': 'splitCompleteDone',
  'M-26': 'splitCreatedButUnconfirmed',
  'M-27': 'splitUncertain',
  'M-28': 'splitStillUncertain'
});

/** Chiave i18n di un messaggio M-xx; la chiave stessa se l'id non è noto. */
function messageKeyFor(code) {
  return MESSAGE_KEYS[code] || code || null;
}

// ================================================================
// Codice del pacchetto (FR-16, FR-18)
// ================================================================

/**
 * Codice di un pacchetto: numero d'ordine, trattino, progressivo a 4 cifre (FR-16).
 * Lancia fuori dall'intervallo 1..9999: un codice `-10000` non esiste e restituirlo
 * silenziosamente creerebbe un lotto Plex fuori convenzione.
 */
function formatPackageCode(order, seq) {
  const base = String(order === null || order === undefined ? '' : order).trim();
  if (!base) throw new RangeError('formatPackageCode: ManufacturingOrder mancante');
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PACKAGE_SEQUENCE) {
    throw new RangeError(`formatPackageCode: progressivo fuori intervallo 1..${MAX_PACKAGE_SEQUENCE}: ${seq}`);
  }
  return `${base}-${String(n).padStart(4, '0')}`;
}

/** Match ANCORATO: un codice pacchetto è tale solo se finisce con trattino + 4 cifre. */
const PACKAGE_CODE_RE = /^(.+)-(\d{4})$/;

/**
 * Inverso di formatPackageCode. `null` se la stringa non è un codice pacchetto —
 * compreso `<ordine>-0000`, che non è un pacchetto ma il marcatore del lotto principale.
 */
function parsePackageCode(code) {
  const m = PACKAGE_CODE_RE.exec(String(code === null || code === undefined ? '' : code).trim());
  if (!m) return null;
  const seq = Number(m[2]);
  if (seq < 1 || seq > MAX_PACKAGE_SEQUENCE) return null;
  return { order: m[1], seq };
}

/**
 * Confronto ESATTO fra due numeri di lotto (FR-19).
 * `String(...)` su entrambi i lati perché un `jobNumber` numerico restituito da Plex
 * fallirebbe il `===` con la stringa che arriva da SAP; trim perché uno spazio in coda
 * non è una differenza di identità. Un valore vuoto non è mai uguale a nulla: un
 * confronto fra due vuoti significa "non ho niente da confrontare", non "coincidono".
 */
function isExactJobNumber(a, b) {
  const sa = a === null || a === undefined ? '' : String(a).trim();
  const sb = b === null || b === undefined ? '' : String(b).trim();
  if (!sa || !sb) return false;
  return sa === sb;
}

/**
 * Prossimo progressivo assegnabile: il primo MAI assegnato prima per quell'ordine
 * (FR-16). Si prende il massimo fra l'ultimo assegnato (ZProdOrderSplit.LastSequence)
 * e i progressivi presenti fra i pacchetti, e si incrementa: un codice non si riusa mai,
 * nemmeno se il pacchetto corrispondente non è mai arrivato a esistere.
 * `null` quando i 9999 progressivi sono esauriti (FR-18).
 */
function nextSplitSequence({ lastSequence = 0, usedSequences = [] } = {}) {
  const used = (usedSequences || [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
  const base = Math.max(Number(lastSequence) || 0, used.length ? Math.max(...used) : 0);
  const next = base + 1;
  return next > MAX_PACKAGE_SEQUENCE ? null : next;
}

// ================================================================
// Validazione della quantità (FR-10, FR-11, FR-12)
// ================================================================

/** Numero di decimali scritti in una rappresentazione testuale di quantità. */
function countDecimals(text) {
  const s = String(text).trim();
  // Notazione esponenziale: la si normalizza passando per Number, altrimenti '1e-4'
  // conterebbe zero decimali.
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return 0;
    return countDecimals(n.toFixed(12).replace(/0+$/, ''));
  }
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  return s.slice(dot + 1).replace(/0+$/, '').length;
}

/**
 * Valida la quantità richiesta per un pacchetto. TRE soli parametri, e non è una
 * dimenticanza: `raw` (quello che l'utente ha scritto), `residual` (la R letta da Plex)
 * e `decimals` (il limite di §9.3 A-5).
 *
 * NESSUNA quantità già prodotta entra in questa validazione (decisione G3-1 del
 * product owner, 2026-08-05; TDD §5.3 e TD-9). Lo spacchettamento **presuppone** che
 * sul lotto principale la produzione non sia iniziata, e il sistema **non lo verifica**:
 * il dato non è ottenibile in modo affidabile (nessuna API Plex integrata lo espone, la
 * tabella locale registra per operazione e solo dal primo run del job di consuntivazione),
 * e un controllo costruito su una sottostima direbbe "sì" a un taglio che porta il lotto
 * sotto il prodotto vero, con l'autorevolezza di un controllo. Chi legge questa funzione
 * e pensa di correggere un difetto aggiungendo `produced` sta riaprendo BR-12, che è
 * stato **revocato**: la strada è un endpoint Plex che esponga la quantità completata,
 * non una stima locale.
 *
 * @returns {{ok: boolean, code: string|null, params: object, quantity: number|null}}
 *   `code` è l'id di messaggio dell'FDD ('M-04' | 'M-05' | 'M-08'); `params` porta i soli
 *   valori noti a questa funzione (l'unità di misura la aggiunge il chiamante).
 */
function validateSplitQuantity({ raw, residual, decimals } = {}) {
  const maxDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : DEFAULT_QTY_DECIMALS;
  const bad = (code, params = {}) => ({ ok: false, code, params, quantity: null });

  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!text) return bad('M-04');

  // La virgola decimale è accettata: la finestra è in italiano e l'utente la digita.
  const q = Number(text.replace(',', '.'));
  if (!Number.isFinite(q) || q <= 0) return bad('M-04');

  const r = Number(residual);
  // FR-11: q < R stretto. Una quantità pari alla residua trasferirebbe l'intero lotto,
  // e il lotto principale deve sopravvivere con quantità positiva.
  if (!Number.isFinite(r) || q >= r) return bad('M-05', { residual: Number.isFinite(r) ? r : 0 });

  if (countDecimals(text.replace(',', '.')) > maxDecimals) return bad('M-08', { decimals: maxDecimals });

  return { ok: true, code: null, params: {}, quantity: q };
}

/**
 * True quando la quantità residua del lotto principale non è più spacchettabile in sé:
 * `R <= 0`, oppure R così piccola che nessun `q > 0` rispetta `q < R` con i decimali
 * ammessi (con 3 decimali: R <= 0.001). È la condizione che resta al messaggio M-09
 * dopo G3-1 — la vecchia «tutta la residua è già prodotta» non è più verificabile.
 */
function isResidualSplittable(residual, decimals) {
  const maxDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : DEFAULT_QTY_DECIMALS;
  const r = Number(residual);
  if (!Number.isFinite(r)) return false;
  const smallest = Math.pow(10, -maxDecimals);
  return r > smallest;
}

// ================================================================
// Verdetto della creazione e decisione di compensare (FR-42, R0)
// ================================================================

/** Status HTTP su cui Plex ha risposto RIFIUTANDO: il pacchetto non esiste. */
const CONCLUSIVE_REJECT_STATUS = new Set([400, 401, 403, 404, 409, 422]);

/**
 * Da che parte del confine sto? È la domanda più delicata dell'intera feature.
 * «La creazione non è riuscita» ha due significati diversi e confonderli è pericoloso:
 * un rifiuto di Plex significa che il pacchetto NON esiste, una risposta mai arrivata
 * significa che potrebbe esistere.
 *
 * @param {{thrown: boolean, aborted: boolean, ok: boolean, status: number, hasId: boolean}} o
 * @returns {'CREATED'|'FAILED'|'INCONCLUSIVE'}
 */
function classifyCreateVerdict({ thrown, aborted, ok, status, hasId } = {}) {
  // Eccezione di rete o AbortError da timeout (TD-6): la risposta non è mai arrivata.
  if (thrown || aborted) return 'INCONCLUSIVE';
  if (ok) {
    // `ok` senza id: non si sa che cosa sia stato creato. Il job batch tratta questo caso
    // come errore secco (createPlexProductionOrders.js:393); qui non basta, perché
    // "errore secco" autorizzerebbe una compensazione alla cieca.
    return hasId ? 'CREATED' : 'INCONCLUSIVE';
  }
  const code = Number(status);
  if (CONCLUSIVE_REJECT_STATUS.has(code)) return 'FAILED';
  // 408, 429, 5xx e qualunque altro status: la richiesta può essere stata eseguita e
  // non raccontata. Il default è la prudenza.
  return 'INCONCLUSIVE';
}

/**
 * Decide se compensare, dopo aver verificato su Plex l'esistenza del pacchetto (R0).
 *
 * @param {'CREATED'|'FAILED'|'INCONCLUSIVE'} verdict verdetto di P3
 * @param {'FOUND'|'ABSENT'|'INCONCLUSIVE'} probe esito di R0 (case-insensitive)
 * @returns {'PROCEED'|'COMPENSATE'|'UNCERTAIN'}
 *
 * `UNCERTAIN` è l'unico caso in cui il sistema accetta consapevolmente un ammanco, e non
 * è una dimenticanza: è l'asimmetria del danno (FR-42). Non compensare lascia una quantità
 * che non è in produzione da nessuna parte, recuperabile in qualunque momento con
 * «Ripristina»; compensare alla cieca rischia una sovra-allocazione su un lotto che la
 * fabbrica potrebbe già vedere e aver iniziato a lavorare, e quella non è più recuperabile.
 * Fra un errore reversibile e uno irreversibile si sceglie sempre il primo.
 */
function decideRollback(verdict, probe) {
  if (verdict === 'CREATED') return 'PROCEED';
  const p = String(probe || '').toUpperCase();
  if (p === 'FOUND') return 'PROCEED';      // P3 in realtà è riuscito: non si compensa nulla
  if (p === 'ABSENT') return 'COMPENSATE';  // accertato assente: R1 -> R2 -> R3
  return 'UNCERTAIN';                       // R0 non conclusiva: non si compensa
}

// ================================================================
// Matrice degli esiti (FDD 0012 §6)
// ================================================================

/**
 * Righe della matrice: status mostrato all'utente e chiave del messaggio.
 * La riga `A` non ha una chiave propria perché il suo messaggio dipende dalla verifica
 * che non è passata: la porta il passo terminale.
 * La riga `I` (esecuzione interrotta) non è qui: per definizione nessuna risposta
 * raggiunge il client, quindi non è un esito che questa funzione possa produrre.
 */
const OUTCOME_ROWS = Object.freeze({
  A: { status: 'E', messageKey: null },
  B: { status: 'E', messageKey: MESSAGE_KEYS['M-23'] },
  C: { status: 'S', messageKey: MESSAGE_KEYS['M-10'] },
  C2: { status: 'S', messageKey: MESSAGE_KEYS['M-10'] },
  D: { status: 'W', messageKey: MESSAGE_KEYS['M-17'] },
  E0: { status: 'W', messageKey: MESSAGE_KEYS['M-26'] },
  E1: { status: 'E', messageKey: MESSAGE_KEYS['M-16'] },
  E2: { status: 'E', messageKey: MESSAGE_KEYS['M-16a'] },
  E3: { status: 'E', messageKey: MESSAGE_KEYS['M-16b'] },
  E4: { status: 'E', messageKey: MESSAGE_KEYS['M-27'] },
  F: { status: 'W', messageKey: MESSAGE_KEYS['M-18'] },
  G: { status: 'W', messageKey: MESSAGE_KEYS['M-19'] },
  H: { status: 'W', messageKey: MESSAGE_KEYS['M-20'] },
  J: { status: 'W', messageKey: MESSAGE_KEYS['M-21'] }
});

/** Un passo è fallito quando il suo esito è certo-negativo ('E') o non conclusivo ('U'). */
function stepFailed(s) {
  return !!s && (s.status === 'E' || s.status === 'U');
}

/**
 * Mappa la sequenza dei passi eseguiti su una riga della matrice degli esiti (§6),
 * sullo `status` mostrato all'utente e sulla chiave del messaggio.
 *
 * Forma attesa di un passo: `{ step: 'P1', status: 'S'|'W'|'E'|'U', verdict, messageKey, codeChanged }`.
 * I passi ammessi sono quelli del contratto §4.3 (`P0`…`P6`, `R0`…`R3`, `LOG`) più i passi
 * preliminari, che iniziano per `A` (`A5`, `A6`, `A8`, `A9`): un preliminare fallito è per
 * definizione la riga A, perché nulla è ancora stato modificato.
 *
 * Priorità quando più passi accessori sono falliti nella stessa esecuzione: la matrice
 * elenca casi terminali, quindi si sceglie l'anomalia che richiede l'azione più urgente.
 * L'ordine è H (pacchetto non agganciato: le registrazioni non tornerebbero in SAP, è
 * l'anomalia a priorità massima dell'FDD) > G (contenuto di lavoro) > F (schedulazione
 * del pacchetto) > D (rischedulazione del principale) > E0 (creazione non confermata ma
 * ritrovata) > J (storico). La sequenza completa resta comunque in `steps`.
 */
function resolveOutcomeRow(steps) {
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const at = (name) => list.filter((s) => s.step === name).pop();
  const row = (name, messageKey) => ({
    row: name,
    status: OUTCOME_ROWS[name].status,
    messageKey: messageKey || OUTCOME_ROWS[name].messageKey || MESSAGE_KEYS['M-23']
  });

  const p0 = at('P0');
  const p1 = at('P1');
  const p2 = at('P2');
  const p3 = at('P3');
  const p4 = at('P4');
  const p5 = at('P5');
  const p6 = at('P6');
  const r0 = at('R0');
  const r1 = at('R1');
  const r2 = at('R2');
  const log = at('LOG');

  // --- riga A: niente è stato modificato, né su Plex né in locale -----------------
  const preliminary = list.find((s) => /^A/.test(String(s.step)) && stepFailed(s));
  if (preliminary) return row('A', preliminary.messageKey);
  if (stepFailed(p0)) return row('A', p0.messageKey);
  // Nessun P1: l'esecuzione non è arrivata a toccare la quantità del lotto principale.
  if (!p1) return row('A', (at('P0') || {}).messageKey);

  // --- riga B: la riduzione del lotto principale non è riuscita -------------------
  if (stepFailed(p1)) return row('B', p1.messageKey);

  // --- il pacchetto esiste? È il verdetto di P3, corretto da quello di R0 ---------
  const created = !!p3 && p3.verdict === 'CREATED';
  const probe = r0 ? String(r0.verdict || '').toUpperCase() : null;
  const exists = created || probe === 'FOUND';

  if (!exists) {
    // Compensazione: R0 accertatamente assente => R1/R2/R3; altrimenti stato incerto.
    if (probe !== 'ABSENT') return row('E4');
    if (stepFailed(r1)) return row('E3');
    if (stepFailed(r2)) return row('E2');
    return row('E1');
  }

  // --- da qui il pacchetto esiste: nessun esito può più essere 'E' ----------------
  // È il confine fra E e F della matrice: da quando il pacchetto esiste il sistema non
  // distrugge nulla e l'esito è al più un'attenzione.
  if (stepFailed(p6)) return row('H');
  if (stepFailed(p5)) return row('G');
  if (stepFailed(p4)) return row('F');
  if (stepFailed(p2)) return row('D');
  if (!created) return row('E0');           // creato ma non confermato, ritrovato da R0
  if (stepFailed(log)) return row('J');
  return row(p3 && p3.codeChanged ? 'C2' : 'C');
}

/**
 * [ORDER-SORT-ON-WRITE] Lo spacchettamento ha gia' toccato Plex?
 *
 * La domanda serve all'ordinamento della lista di lavoro (P7), che va chiesto dopo OGNI scrittura su
 * un ordine — non solo quando il pacchetto nasce (addendum del 06/10/2026 a DEC-100). P1 e' la prima
 * scrittura della sequenza e ogni altra viene dopo di lui riuscito, quindi basta guardare P1:
 *   - 'S': il lotto principale e' stato ridotto. Che poi P3 fallisca e si compensi, o resti incerto,
 *     la lista di lavoro e' cambiata;
 *   - 'U': la richiesta e' partita senza risposta. Non sappiamo se Plex l'abbia applicata, e
 *     l'ordinamento si chiama lo stesso — ricalcola la sola sequenza, quindi nel dubbio costa una
 *     richiesta, mentre saltarlo lascia la lista nell'ordine sbagliato;
 *   - 'E' o assente: Plex ha risposto no, o non gli si e' chiesto niente. Nessun ordinamento.
 *
 * Si guarda l'ULTIMO P1, come `resolveOutcomeRow`: con due passi omonimi l'esito dipenderebbe da
 * quale si legge.
 */
function plexTouched(steps) {
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const p1 = list.filter((s) => s.step === 'P1').pop();
  return !!p1 && (p1.status === 'S' || p1.status === 'U');
}

// ================================================================
// Stato dei pacchetti e quadratura
// ================================================================

/** True se sull'ordine esiste almeno un caso residuale aperto (FR-26). */
function hasOpenResidual(packageRows) {
  return (Array.isArray(packageRows) ? packageRows : [])
    .some((r) => r && OPEN_RESIDUAL_STATES.has(r.SplitState));
}

/** Il comando che la finestra deve proporre per un pacchetto in stato residuale. */
function commandForResidual(splitState) {
  if (splitState === SPLIT_STATES.TO_LINK) return COMMANDS.COMPLETE;
  if (splitState === SPLIT_STATES.TO_RESTORE) return COMMANDS.RESTORE;
  // 'U' e 'P': nessun comando alla cieca finché lo stato non è accertato (FR-26).
  return COMMANDS.NONE;
}

/** Chiave del messaggio da mostrare in testa alla finestra per un caso residuale aperto. */
function messageKeyForResidual(splitState) {
  if (splitState === SPLIT_STATES.TO_LINK) return MESSAGE_KEYS['M-22'];
  if (splitState === SPLIT_STATES.TO_RESTORE) return MESSAGE_KEYS['M-22a'];
  return MESSAGE_KEYS['M-28'];
}

/** True se lo stato è uno dei valori ammessi in SplitState (validazione applicativa, DEC-02). */
function isValidSplitState(state) {
  return Object.values(SPLIT_STATES).includes(state);
}

/** True se il `Mode` dell'action è uno dei tre ammessi (contratto §4.1). */
function isValidMode(mode) {
  return Object.values(MODES).includes(mode);
}

/**
 * Ordinamento NORMATIVO dei pacchetti in risposta (contratto §3.4, C-6): prima gli stati
 * anomali, poi gli altri per progressivo crescente. FR-28 chiede che gli stati anomali
 * siano evidenziati, non elencati in fondo; deciderlo lato server evita che due client
 * ordinino diversamente. Non muta l'array ricevuto.
 */
function sortPackages(packageRows) {
  return (Array.isArray(packageRows) ? [...packageRows] : []).sort((a, b) => {
    const wa = OPEN_RESIDUAL_STATES.has(a.SplitState) ? 0 : 1;
    const wb = OPEN_RESIDUAL_STATES.has(b.SplitState) ? 0 : 1;
    if (wa !== wb) return wa - wb;
    return (Number(a.SplitSequence) || 0) - (Number(b.SplitSequence) || 0);
  });
}

/** Arrotondamento a 3 decimali: la Scale persistita. Evita i falsi mismatch dei float. */
function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

/**
 * Divergenza fra quantità dell'ordine SAP e somma dei lotti su Plex (FR-30).
 * Nella somma entrano il lotto principale e i soli pacchetti in stato 'A'/'I': un
 * pacchetto «da agganciare» o «da ripristinare» non è quantità in produzione.
 * Nessun riallineamento automatico: la divergenza si mostra e si gestisce a mano.
 */
function computeMismatch({ sapQty, mainQty, packages } = {}) {
  const sum = round3(
    (Number(mainQty) || 0) +
    (Array.isArray(packages) ? packages : [])
      .filter((p) => p && COUNTED_PACKAGE_STATES.has(p.SplitState))
      .reduce((acc, p) => acc + (Number(p.Quantity) || 0), 0)
  );
  if (sapQty === null || sapQty === undefined || !Number.isFinite(Number(sapQty))) {
    return { sum, mismatch: false };
  }
  return { sum, mismatch: sum !== round3(sapQty) };
}

module.exports = {
  // costanti
  MAX_PACKAGE_SEQUENCE,
  DEFAULT_QTY_DECIMALS,
  SPLIT_STATES,
  OPEN_RESIDUAL_STATES,
  COUNTED_PACKAGE_STATES,
  MODES,
  COMMANDS,
  MESSAGE_KEYS,
  OUTCOME_ROWS,
  // regole
  messageKeyFor,
  formatPackageCode,
  parsePackageCode,
  isExactJobNumber,
  nextSplitSequence,
  validateSplitQuantity,
  isResidualSplittable,
  classifyCreateVerdict,
  decideRollback,
  resolveOutcomeRow,
  plexTouched,
  hasOpenResidual,
  commandForResidual,
  messageKeyForResidual,
  isValidSplitState,
  isValidMode,
  sortPackages,
  computeMismatch,
  // [ORDER-QTY-SYNC] Esportata per srv/lib/orderQtyRules.js: il riallineamento della quantita'
  // lavora sulla stessa scala persistita di qui, e una seconda copia dell'arrotondamento sarebbe
  // il modo in cui le due divergono sul terzo decimale.
  round3
};
