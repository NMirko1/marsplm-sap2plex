/**
 * [IS-SOURCE] Lettura della CLASSIFICAZIONE PRODOTTO per l'auto-assegnazione (feature 0018).
 *
 * COSA RESTITUISCE
 * L'indice `classByMaterial` che `matchCond` (srv/cat-service.js) confronta da sempre, più la
 * risoluzione dei nomi di caratteristica in ATINN. Chi chiama non sa da quale canale arrivino:
 * è questo modulo il punto unico in cui si sceglie, con la leva `CLASSIFICATION_SOURCE`.
 *
 * PERCHE' ESISTE
 * L'auto-assegnazione valuta condizioni «il materiale è nella classe X, la cui caratteristica Y
 * vale Z». Fino alla 0018 leggeva la classificazione con `cds.connect.to` DIRETTO sui due servizi
 * CLFN e un `$expand` a DUE livelli su una collection: una forma che sull'Integration Suite non è
 * nemmeno inviabile — quattro dei sei indirizzi pubblicati sono `_GET`, dove la collection non è
 * esposta e la navigazione non esiste. Il risultato era che su IS ogni condizione `CLASS` non
 * agganciava mai, in silenzio: il `catch` loggava e proseguiva, e i componenti uscivano
 * «senza gruppo» esattamente come se il customizing non ci fosse (0013, flusso E).
 *
 * LE DUE MODALITA' NON HANNO LA STESSA FORMA, ED È VOLUTO
 *
 *   ONPREM  la lettura di sempre: un `$expand` a due livelli su `A_ProductClass`, a blocchi di 100
 *           materiali, con la chiave in formato ALPHA. **Non passa dalla sorgente d'area** — ci
 *           passerebbe senza errori, ma il chunking della sorgente la spezzerebbe a 15 (DEC-19)
 *           trasformando una lettura in sette, ognuna con un doppio expand. Sul canale storico il
 *           comportamento deve restare identico a prima del rilascio (DEC-34). Vale per la lettura
 *           delle CLASSI: la risoluzione del nome caratteristica (R1) passa invece dalla sorgente
 *           in entrambe le modalità, perché è la stessa identica query sui due canali.
 *
 *   IS      una CATENA di letture dirette, una entity per chiamata, nessun `$expand`, con la
 *           chiave NUDA. È la catena misurata dalla sonda della classificazione (rimossa il 03/09/2026):
 *
 *             R1  nome caratteristica -> ATINN     A_ClfnCharacteristicForKeyDate  QUERY
 *             R2  materiale -> lista CLINT         A_ProductClass                  QUERY
 *             R3  CLINT -> nome classe             A_ClfnClassForKeyDate           GET per chiave
 *             R4  la caratteristica è di quella classe?  A_ProductClassCharc       GET per chiave
 *             R5  IL VALORE                        A_ProductCharcValue             GET per chiave
 *
 * TRE COSE DELLA CATENA CHE NON SONO SCELTE DI STILE
 *
 * 1. **Il valore non passa dalla classe.** `A_ProductCharcValue` ha chiave `(Product, ClassType,
 *    CharcInternalID, CharcValuePositionNumber)`: il CLINT NON c'è. R5 è indipendente da R2/R3, e
 *    R4 esiste solo per riportare la condizione alla semantica del canale storico — dove il valore
 *    arrivava dentro `to_Characteristics/to_Valuation` DELLA classe. Senza R4 aggancerebbe anche un
 *    materiale la cui caratteristica appartiene a un'ALTRA sua classe.
 *
 * 2. **La classe si verifica al contrario.** Nessun indirizzo cerca una classe per NOME: si parte
 *    dai CLINT del materiale e si legge il nome di ognuno. Da qui la cache di processo CLINT ->
 *    nome, che è ciò che rende sostenibile il job ROUTING_SYNC (una chiamata per ciclo), e le
 *    ondate di R3, che smettono appena tutti i nomi CERCATI sono stati trovati: i CLINT rimasti non
 *    possono più cambiare l'esito di nessuna condizione, e ognuno costerebbe una lettura.
 *
 * 3. **Si legge solo per i CANDIDATI.** R4 e R5 girano sui soli materiali che risultano nella
 *    classe cercata, non su tutti i componenti: è l'ordine delle letture a contenere il costo.
 *
 * 4. **R4 e R5 PARTONO INSIEME, R2 e R3 no.** `R2 -> R3` è una dipendenza vera; `R4 -> R5` era solo
 *    apparente — l'accumulatore che sembrava fare da ponte fra i due cicli si calcola per intero
 *    prima che parta la prima chiamata. In fila ogni lettura lasciava il pool di concorrenza della
 *    sorgente mezzo vuoto per tutta la sua durata: una coppia con tre candidati occupa tre slot su
 *    otto. Il piano di quali letture fare è puro e sta in `planClassReads` (clfnRules.js), l'onda è
 *    `READ_WAVE`, e i motivi di fallimento si riversano nell'ordine di LANCIO (vedi `absorb`) —
 *    altrimenti a parità di guasto due esecuzioni identiche mostrerebbero motivi diversi.
 *
 * QUANDO NON SI RIESCE A LEGGERE, LO SI DICHIARA. `status: 'KO'` risale fino al motivo `NO_CLFN`
 * sui componenti non assegnati, al riepilogo delle due app e al recap del job. Una condizione che
 * non si è potuta valutare non deve somigliare a una condizione non soddisfatta.
 *
 * Perimetro: `grep -rn "IS-SOURCE"`. Vedi docs/0018-classificazione-su-is.md.
 */

'use strict';

const cds = require('@sap/cds');
const R = require('./clfnRules');
const { errorText, withConcurrency } = require('./isRemoteSource');
const { clfnProductSource, clfnCharcSource, BASE_PRODUCT } = require('./clfnSource');

const T = '>>> [IS-SOURCE] classificazione';

/**
 * Cache di processo: nome caratteristica (ATNAM) -> id interno (ATINN). Chiave presente con
 * valore `null` = risolta e NON trovata, per non richiederla a ogni invocazione. Era in
 * cat-service.js, dove serviva alla sola auto-assegnazione; sta qui perché ora la usano entrambi
 * i canali. Si svuota al riavvio del processo.
 */
const _charcIdByName = new Map();

/**
 * Cache di processo: CLINT -> nome della classe. È la gemella della precedente, e l'unica ragione
 * per cui la catena IS è sostenibile: i CLINT sono opachi, si risolvono uno per uno, e sono gli
 * STESSI per tutti i materiali e per tutti i cicli di un run. Anche qui `null` = assente.
 */
const _classNameByClint = new Map();

/** Il blocco della lettura storica. NON si tocca: è la forma in esercizio sul canale ONPREM. */
const ONPREM_CHUNK = 100;

/**
 * Ampiezza di un'ondata di risoluzione CLINT: due volte la concorrenza del fan-out. Più piccola
 * sprecherebbe la concorrenza, più grande leggerebbe CLINT che l'ondata precedente ha già reso
 * inutili.
 */
const CLINT_WAVE = 16;

/**
 * [CLFN-PARALLEL] Quante letture R4/R5 stanno in volo INSIEME (DEC-122). Sono indipendenti fra loro
 * (vedi `planClassReads` in
 * clfnRules.js), e in fila ognuna lasciava il pool di concorrenza della sorgente mezzo vuoto per
 * tutta la sua durata: una coppia con tre candidati occupa tre slot su otto, e gli altri cinque
 * restano fermi fino alla fine del blocco.
 *
 * IL BUDGET DI RICHIESTE IN VOLO E' IL PRODOTTO, non la somma: ogni lettura ha il suo fan-out con
 * il suo pool, quindi si arriva a `CLFN_READ_WAVE × concurrency` richieste contemporanee verso
 * l'iFlow. Il default `2` con la concorrenza dell'area dà lo stesso budget che `productSource.js`
 * dichiara e accetta in esercizio da mesi sulle sue due letture in parallelo.
 *
 * `1` riporta al comportamento di prima — le letture in fila, una per volta — ed è la via di ritorno
 * se l'iFlow non regge: la si tira senza rilasciare niente.
 */
const READ_WAVE = (() => {
  const raw = Number(process.env.CLFN_READ_WAVE);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
})();

/** Lunghezza del dettaglio d'errore restituito: è la larghezza dichiarata nel contratto OData. */
const DETAIL_MAX = 500;

// ================================================================
// Esito della lettura
// ================================================================

/**
 * Lo stato iniziale: nessuna lettura fallita.
 *
 * `deferWarn` è per le letture che girano INSIEME alle altre: là il messaggio non si stampa nel
 * momento in cui il guasto capita — sarebbe l'ordine di ARRIVO — ma si accumula, e lo stampa
 * `absorb` nell'ordine in cui le letture sono state lanciate. Vedi il perché in `absorb`.
 */
function newState(opts = {}) {
  return { status: 'OK', detail: '', failures: 0, warns: opts.deferWarn ? [] : null };
}

/**
 * Registra una lettura fallita. Il PRIMO motivo è quello che si mostra — è quello a monte della
 * catena, e gli altri ne sono spesso la conseguenza; gli altri si contano.
 */
function fail(state, what, e, kept) {
  state.status = 'KO';
  state.failures++;
  const msg = `${what}: ${errorText(e)}${kept ? ` (${kept} righe comunque utilizzabili)` : ''}`;
  if (!state.detail) state.detail = msg;
  const line = `${T}: lettura KO — ${msg}`;
  if (state.warns) state.warns.push(line);
  else console.warn(line);
}

/**
 * [CLFN-PARALLEL] Riversa nello stato complessivo l'esito di una lettura girata in parallelo —
 * NELL'ORDINE DI LANCIO, mai in quello di arrivo.
 *
 * PERCHE' NON BASTA PASSARE LO STATO CONDIVISO AI TASK. `fail` tiene il primo motivo perché quello è
 * «il primo della catena», e con le letture in volo insieme «primo» diventerebbe «la prima che
 * torna»: il dettaglio mostrato a schermo e nel recap sarebbe una lotteria fra letture equivalenti,
 * e a parità di guasto due esecuzioni identiche direbbero cose diverse. Ogni task scrive quindi in
 * uno stato SUO, e l'ordine lo ricompone qui — è lo stesso rimedio del riordino per offset in
 * pagedRead.js, dove le pagine di un'onda si riordinano prima di essere consumate.
 */
function absorb(state, local) {
  if (!local || local.status !== 'KO') return;
  for (const line of (local.warns || [])) console.warn(line);
  state.status = 'KO';
  state.failures += local.failures;
  if (!state.detail) state.detail = local.detail;
}

/**
 * Esegue `fn` misurandone la durata e la annota in `phases`, per la riga di riepilogo finale.
 *
 * Serve a rispondere alla sola domanda che conta quando la catena è lenta: QUALE delle cinque
 * letture costa. Senza, il totale non dice niente — e la leva giusta (la concorrenza dell'area, il
 * numero di letture in volo, o una richiesta di contratto sull'indirizzo) dipende da quella
 * risposta.
 */
async function timed(phases, name, calls, keys, fn) {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    phases.push({ name, calls, keys, ms: Date.now() - t0 });
  }
}

/** La riga di riepilogo: una voce per fase, `letture/chiavi` e i millisecondi. */
function phasesText(phases) {
  return phases.map(p => `${p.name} ${p.calls}L/${p.keys}k ${p.ms}ms`).join(' · ');
}

/** Il dettaglio da restituire: primo motivo, conteggio degli altri, tagliato alla larghezza. */
function detailOf(state) {
  if (!state.detail) return '';
  const extra = state.failures > 1 ? ` (+${state.failures - 1} altre letture fallite)` : '';
  const full = `${state.detail}${extra}`;
  return full.length > DETAIL_MAX ? `${full.slice(0, DETAIL_MAX - 1)}…` : full;
}

/** Righe di una lettura, sempre come array: `SELECT.one` e lettura per chiave tornano un oggetto. */
function toArray(rows) {
  if (Array.isArray(rows)) return rows;
  return rows ? [rows] : [];
}

/**
 * Una lettura che NON lancia. Su rotta tollerante la sorgente appende all'errore le righe già
 * arrivate (`partialRows`): si tengono — sono dati veri — e la lettura resta comunque dichiarata KO.
 *
 * @returns {{rows: Array<object>, ok: boolean}}
 */
async function safeRun(src, query, state, what) {
  try {
    return { rows: toArray(await src.run(query)), ok: true };
  } catch (e) {
    const partial = toArray(e && e.partialRows);
    fail(state, what, e, partial.length);
    return { rows: partial, ok: false };
  }
}

// ================================================================
// R1 — nome caratteristica -> ATINN
// ================================================================

/**
 * Risolve i nomi di caratteristica in id interni, passando dalla cache di processo.
 *
 * È l'anello senza il quale non si legge NIENTE su IS: l'ATINN è una CHIAVE della lettura del
 * valore, non un filtro. La lettura è la stessa su entrambi i canali.
 *
 * @returns {Promise<object>} `{ NOME: ATINN }` con le sole risoluzioni positive
 */
async function resolveCharcIds(src, names, state, phases) {
  const missing = names.filter(n => !_charcIdByName.has(n));
  if (missing.length) {
    const { A_ClfnCharacteristicForKeyDate } = src.entities;
    const { rows, ok } = await timed(phases || [], 'R1', 1, missing.length, () =>
      safeRun(src, SELECT.from(A_ClfnCharacteristicForKeyDate)
        .columns('CharcInternalID', 'Characteristic')
        .where({ Characteristic: R.inOrEq(missing) }), state, 'nome caratteristica -> ATINN (R1)'));
    for (const r of rows) {
      const name = R.normU(r.Characteristic);
      const id = R.norm(r.CharcInternalID);
      if (name && id) _charcIdByName.set(name, id);
    }
    // Cache negativa SOLO se la lettura è andata a buon fine: un nome non trovato è un nome che
    // non esiste, ma un nome non LETTO va richiesto la prossima volta.
    if (ok) for (const n of missing) if (!_charcIdByName.has(n)) _charcIdByName.set(n, null);
  }
  const out = {};
  for (const n of names) {
    const id = _charcIdByName.get(n);
    if (id) out[n] = id;
  }
  return out;
}

// ================================================================
// Canale storico — la lettura di sempre
// ================================================================

/**
 * La lettura ONPREM, **invariata**: un `$expand` a due livelli su `A_ProductClass`, a blocchi di
 * 100 materiali, chiave in formato ALPHA. Ogni modifica qui è una regressione sul canale che i
 * clienti non migrati usano in produzione (DEC-34).
 */
async function readViaOnPrem({ materials, state }) {
  const S4Clfn = await cds.connect.to(BASE_PRODUCT);
  const { A_ProductClass } = S4Clfn.entities;
  const byKey = new Map();
  const keys = materials.map(m => {
    const k = R.alphaKey(m);
    byKey.set(k, m);
    return k;
  });

  const classByMaterial = {};
  try {
    for (let i = 0; i < keys.length; i += ONPREM_CHUNK) {
      const slice = keys.slice(i, i + ONPREM_CHUNK);
      const rows = await S4Clfn.run(
        SELECT.from(A_ProductClass, pc => {
          pc('Product'); pc('ClassInternalID'); pc('ClassType');
          pc.to_ClassDetails(cd => { cd('Class'); });
          pc.to_Characteristics(cc => {
            cc('CharcInternalID');
            cc.to_Valuation(v => { v('CharcValue'); v('CharcFromNumericValue'); });
          });
        }).where({ Product: { in: slice }, ClassType: R.CLASS_TYPE_MATERIAL })
      );
      for (const row of rows) {
        const mat = R.resolveEcho(row.Product, byKey);
        const cd = Array.isArray(row.to_ClassDetails) ? row.to_ClassDetails[0] : row.to_ClassDetails;
        const className = R.normU(cd && cd.Class);
        const chars = {};
        for (const cc of (row.to_Characteristics || [])) {
          const cid = R.norm(cc.CharcInternalID);
          // Verbatim dalla lettura storica: `CharcValue` se c'è, altrimenti il numerico — e una
          // valorizzazione senza valore resta nell'elenco come stringa vuota. Non si sostituisce
          // con `valueOfRow`, che guarda sei campi: sarebbe un allargamento su un canale che deve
          // restare identico a prima del rilascio.
          chars[cid] = (cc.to_Valuation || []).map(v =>
            (v.CharcValue !== null && v.CharcValue !== undefined && v.CharcValue !== '')
              ? R.norm(v.CharcValue) : R.norm(v.CharcFromNumericValue)
          );
        }
        (classByMaterial[mat] = classByMaterial[mat] || []).push({ className, chars });
      }
    }
  } catch (e) {
    fail(state, 'classi e valorizzazioni (canale storico)', e);
  }
  return classByMaterial;
}

// ================================================================
// Integration Suite — la catena
// ================================================================

/** R2 — le classi di ogni materiale. È l'unica entity dell'area filtrabile. */
async function readClasses(src, materials, byKey, state) {
  const { A_ProductClass } = src.entities;
  const clintsByMaterial = new Map(materials.map(m => [m, []]));
  const { rows } = await safeRun(src, SELECT.from(A_ProductClass)
    .columns('Product', 'ClassInternalID', 'ClassType')
    .where({ Product: R.inOrEq([...byKey.keys()]), ClassType: R.CLASS_TYPE_MATERIAL }),
  state, 'classi del materiale (R2)');
  for (const r of rows) {
    const mat = R.resolveEcho(r.Product, byKey);
    const clint = R.norm(r.ClassInternalID);
    const list = clintsByMaterial.get(mat);
    if (!clint || !list) continue;
    if (!list.includes(clint)) list.push(clint);
  }
  return clintsByMaterial;
}

/**
 * R3 — dai CLINT ai nomi delle classi, a ondate.
 *
 * I CLINT più condivisi si risolvono per primi: una lettura sola serve più materiali, e il nome
 * cercato è quasi sempre fra quelli. Appena tutti i nomi che il customizing chiede sono risolti si
 * smette, e quanti CLINT restano ignoti lo si DICHIARA — un'ottimizzazione silenziosa somiglia
 * troppo a una lettura mancata.
 */
async function readClassNames(src, clintsByMaterial, wantedNames, state, stats) {
  const { A_ClfnClassForKeyDate } = src.entities;
  const nameByClint = new Map();
  const st = stats || {};
  st.waves = 0;
  st.clints = 0;

  const freq = new Map();
  for (const clints of clintsByMaterial.values()) {
    for (const c of clints) freq.set(c, (freq.get(c) || 0) + 1);
  }
  const unknown = [];
  for (const [clint] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
    if (_classNameByClint.has(clint)) {
      const cached = _classNameByClint.get(clint);
      if (cached) nameByClint.set(clint, cached);
    } else {
      unknown.push(clint);
    }
  }

  for (let i = 0; i < unknown.length; i += CLINT_WAVE) {
    if (R.allClassesResolved(wantedNames, nameByClint)) {
      console.log(`${T}: R3 interrotta — tutti i nomi cercati sono risolti, `
        + `${unknown.length - i} CLINT non interrogati (non possono cambiare l'esito)`);
      break;
    }
    const wave = unknown.slice(i, i + CLINT_WAVE);
    st.waves++;
    st.clints += wave.length;
    const { rows, ok } = await safeRun(src, SELECT.from(A_ClfnClassForKeyDate)
      .columns('ClassInternalID', 'Class', 'ClassType')
      .where({ ClassInternalID: R.inOrEq(wave) }), state, 'nome della classe (R3)');
    const seen = new Set();
    for (const r of rows) {
      const clint = R.norm(r.ClassInternalID);
      const name = R.normU(r.Class);
      if (!clint || !name) continue;
      nameByClint.set(clint, name);
      _classNameByClint.set(clint, name);
      seen.add(clint);
    }
    if (ok) for (const c of wave) if (!seen.has(c)) _classNameByClint.set(c, null);
  }
  return nameByClint;
}

/**
 * R4 — la caratteristica è di quella classe, per quel materiale?
 *
 * La riga tornata si verifica a valle: la chiave l'abbiamo spinta noi, ma una risposta che parla di
 * un'altra caratteristica registrerebbe una presenza inventata. Chi tace conferma la chiave chiesta
 * (l'eco vuoto è già dichiarato dalla sorgente, [IS-BLANK-ROWS]).
 */
async function readClassCharcs(src, { keys, byKey, clint, atinn, label }, state, out) {
  const { A_ProductClassCharc } = src.entities;
  const { rows } = await safeRun(src, SELECT.from(A_ProductClassCharc)
    .columns('Product', 'ClassInternalID', 'CharcInternalID')
    .where({ Product: R.inOrEq(keys), ClassInternalID: clint, CharcInternalID: atinn }),
  state, `caratteristica sulla classe (R4, ${label})`);
  for (const r of rows) {
    const mat = R.resolveEcho(r.Product, byKey);
    const got = R.norm(r.CharcInternalID);
    if (!mat || (got && got !== atinn)) continue;
    const key = `${mat}|${clint}`;
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(atinn);
  }
}

/** R5 — IL VALORE. Una lettura per ATINN, sui soli materiali candidati. */
async function readValues(src, { keys, byKey, atinn, label }, state, out) {
  const { A_ProductCharcValue } = src.entities;
  const { rows } = await safeRun(src, SELECT.from(A_ProductCharcValue)
    .columns('Product', 'ClassType', 'CharcInternalID', 'CharcValuePositionNumber', ...R.VALUE_FIELDS)
    .where({ Product: R.inOrEq(keys), ClassType: R.CLASS_TYPE_MATERIAL, CharcInternalID: atinn }),
  state, `valore della caratteristica (R5, ${label})`);
  for (const r of rows) {
    const mat = R.resolveEcho(r.Product, byKey);
    const got = R.norm(r.CharcInternalID);
    if (!mat || (got && got !== atinn)) continue;
    const { value } = R.valueOfRow(r);
    if (value === '') continue;
    const key = `${mat}|${atinn}`;
    if (!out.has(key)) out.set(key, []);
    if (!out.get(key).includes(value)) out.get(key).push(value);
  }
}

/** La catena completa sul canale IS. */
async function readViaIS({ src, materials, wanted, charcNameToId, state, phases = [] }) {
  // Nessun ATINN, nessuna catena. L'ATINN è una CHIAVE della lettura del valore, non un filtro:
  // senza, nessuna condizione CLASS può essere soddisfatta e le letture a valle sarebbero N
  // chiamate per confermare una risposta che si conosce già. Vale sia quando R1 è fallita — e
  // allora `status` è già KO — sia quando i nomi non esistono in SAP, che è un difetto di
  // customizing e non una lettura mancata.
  if (!Object.keys(charcNameToId).length) {
    console.log(`${T}: nessun nome di caratteristica risolto in ATINN — catena non tentata `
      + `(${materials.length} materiali, esito ${state.status})`);
    return {};
  }

  const byKey = new Map();
  for (const m of materials) byKey.set(R.productKeyFor('IS', m), m);

  // R2 e R3 restano IN FILA, e restano prima: sono dipendenze vere — R3 risolve i CLINT che R2 ha
  // trovato, e senza i nomi di classe non si sa quali coppie abbiano un bersaglio. L'interruzione
  // anticipata di R3 vive di questa sequenzialità (vedi il punto 2 in testa al file).
  const clintsByMaterial = await timed(phases, 'R2', 1, materials.length, () =>
    readClasses(src, materials, byKey, state));
  const r3 = {};
  const nameByClint = await timed(phases, 'R3', 0, 0, () =>
    readClassNames(src, clintsByMaterial, wanted.classNames, state, r3));
  const p3 = phases[phases.length - 1];
  if (p3) { p3.calls = r3.waves || 0; p3.keys = r3.clints || 0; }
  const clintByName = R.clintsOfWantedClasses(wanted.classNames, nameByClint);

  const charcsByMaterialClass = new Map();
  const valuesByMaterialCharc = new Map();

  // ================================================================
  // [CLFN-PARALLEL] R4 e R5 PARTONO INSIEME: la loro dipendenza era solo apparente (DEC-122).
  //
  // Il piano è puro e sta in clfnRules.js (`planClassReads`, col suo test): quali letture fare, su
  // quali materiali, in quale ordine. Ciò che qui era un accumulatore riempito dal primo ciclo e
  // consumato dal secondo — `candidatesByAtinn` — si calcola tutto da `clintsByMaterial`,
  // `clintByName` e `charcNameToId`, che a questo punto sono già in mano: R4 dice se la
  // caratteristica è di quella classe, R5 quanto vale, e nessuna delle due legge la risposta
  // dell'altra. Si incontrano solo in `buildClassIndex`.
  //
  // LE DUE MAPPE SI SCRIVONO DA PIU' TASK, e va bene per costruzione: le chiavi sono disgiunte
  // (`mat|CLINT` per R4, `mat|ATINN` per R5, e ogni `valueRead` ha un ATINN suo), e il
  // read-modify-write di `readClassCharcs` — `has`, `set`, `add` — non ha nessun `await` in mezzo,
  // quindi nessun altro task può inserirsi fra quelle tre righe. Se un giorno una `await` entrasse
  // là dentro, questa proprietà cade.
  //
  // Ogni lettura ha uno STATO SUO, riversato dopo nell'ordine di lancio: vedi `absorb`.
  // ================================================================
  const plan = R.planClassReads({
    pairs: wanted.pairs, clintByName, charcNameToId, clintsByMaterial, materials
  });

  const locals = [];
  const tasks = [];
  for (const r of plan.charcReads) {
    const local = newState({ deferWarn: true });
    locals.push(local);
    const keys = r.candidates.map(m => R.productKeyFor('IS', m));
    tasks.push(() => readClassCharcs(
      src, { keys, byKey, clint: r.clint, atinn: r.atinn, label: r.label }, local, charcsByMaterialClass
    ));
  }
  for (const r of plan.valueReads) {
    const local = newState({ deferWarn: true });
    locals.push(local);
    const keys = r.candidates.map(m => R.productKeyFor('IS', m));
    tasks.push(() => readValues(
      src, { keys, byKey, atinn: r.atinn, label: r.label }, local, valuesByMaterialCharc
    ));
  }

  const planKeys = [...plan.charcReads, ...plan.valueReads].reduce((n, r) => n + r.candidates.length, 0);
  await timed(phases, 'R4+R5', tasks.length, planKeys, async () => {
    // `shouldStop` è `null` di proposito: queste letture sono indipendenti, e fermare le altre
    // perché una è caduta renderebbe l'esito dipendente da quale sia tornata prima. Le rotte
    // tolleranti hanno già la loro guardia dentro il fan-out (`fanOutHopeless`).
    await withConcurrency(tasks, READ_WAVE, null);
  });
  for (const local of locals) absorb(state, local);

  console.log(`${T}: ${materials.length} materiali, ${wanted.pairs.length} coppie (classe, `
    + `caratteristica), ${plan.valueReads.length} caratteristiche con candidati, `
    + `${_classNameByClint.size} CLINT in cache — esito ${state.status}`);
  console.log(`${T}: tempi — ${phasesText(phases)} (R4+R5 a onde da ${READ_WAVE})`);

  return R.buildClassIndex({
    clintsByMaterial, nameByClint, charcsByMaterialClass, valuesByMaterialCharc
  });
}

// ================================================================
// Ingresso
// ================================================================

/**
 * La classificazione dei materiali indicati, nella forma che l'auto-assegnazione confronta.
 *
 * @param {object} p
 * @param {string[]} p.materials  materiali componente (già distinti)
 * @param {Array<object>} p.conditions righe `ZObjectGroupField` di tipo CLASS in gioco
 * @returns {Promise<{classByMaterial: object, charcNameToId: object, status: string, detail: string}>}
 *          `status` `'OK'` o `'KO'`: `KO` = una lettura necessaria non è arrivata, e le condizioni
 *          CLASS che dipendevano da essa NON sono state valutate.
 */
async function readClassification({ materials, conditions }) {
  const wanted = R.wantedFrom(conditions);
  const mats = [...new Set((materials || []).map(R.norm).filter(Boolean))];
  const state = newState();

  // Nessuna condizione valutabile o nessun materiale: non c'è niente da leggere, e non è un difetto.
  if (!wanted.pairs.length || !mats.length) {
    return { classByMaterial: {}, charcNameToId: {}, status: 'OK', detail: '' };
  }

  const phases = [];
  try {
    const [product, charc] = await Promise.all([clfnProductSource(), clfnCharcSource()]);
    const charcNameToId = await resolveCharcIds(charc, wanted.charcNames, state, phases);
    const classByMaterial = product.mode === 'IS'
      ? await readViaIS({ src: product, materials: mats, wanted, charcNameToId, state, phases })
      : await readViaOnPrem({ materials: mats, state });
    return { classByMaterial, charcNameToId, status: state.status, detail: detailOf(state) };
  } catch (e) {
    // Ci si arriva se le sorgenti non sono nemmeno inizializzabili (un path di service root
    // mancante in package.json, per esempio): è un difetto di configurazione, e va dichiarato
    // come tale invece di diventare «nessun gruppo agganciato».
    fail(state, 'sorgenti di classificazione non inizializzabili', e);
    return { classByMaterial: {}, charcNameToId: {}, status: 'KO', detail: detailOf(state) };
  }
}

module.exports = { readClassification };

// Quello che esce qui NON fa parte del contratto del modulo: chi legge la classificazione usa
// `readClassification`. Serve al test (test/clfnReadOrder.test.js) per sorvegliare le due proprietà
// che il parallelismo di R4/R5 mette a rischio senza dare nessun errore — il motivo mostrato non
// deve dipendere da quale lettura è tornata prima, e l'esito con le letture in volo insieme deve
// essere IDENTICO a quello con le letture in fila.
//
// `readViaIS` prende la sorgente come parametro, quindi il test la esercita con una sorgente finta:
// è la catena VERA, non una sua imitazione. Senza, il collaudo si fermerebbe al piano.
module.exports._forTests = { newState, fail, absorb, detailOf, readViaIS, READ_WAVE };
