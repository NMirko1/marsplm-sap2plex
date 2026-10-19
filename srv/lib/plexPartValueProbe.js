/**
 * ============================================================================
 * [PLEX-VALUE-PROBE] SONDA TEMPORANEA DI DIAGNOSI — DA RIMUOVERE
 * ============================================================================
 *
 * COSA DEVE STABILIRE
 * Quale VALORE il tenant Plex accetta nei campi `type` e `status` di POST /mdm/v1/parts.
 *
 * Il fatto da cui si parte. L'invio materiale ha risposto:
 *
 *   400 REQUEST_VALIDATION_FAILED
 *   errors: [ { FIELD_REFERENCE_NOT_FOUND, metadata: { field: 'Type',   value: '34670' } },
 *             { FIELD_REFERENCE_NOT_FOUND, metadata: { field: 'Status', value: '6387'  } } ]
 *
 * «attempts to reference data that does not exist»: la CHIAVE non e' il riferimento che Plex cerca.
 * Le schermate di setup dicono che `Part_Type_Key 34670` E' «Materia prima» e `Part_Status_Key 6387`
 * E' «Produzione», quindi il valore atteso e' quasi certamente il NOME della riga — e su questo
 * tenant i nomi sono italiani, mentre la tipologia del seed e' inglese (`Component`).
 * «Quasi certamente» non basta per scriverlo nel customizing di un cliente: da qui la sonda.
 *
 * COME FA A NON SPORCARE IL TENANT
 * La 400 elenca DUE errori insieme, ognuno col suo `metadata.field`: Plex raccoglie tutti gli errori
 * di validazione PRIMA di toccare i dati. Ogni chiamata di scoperta porta quindi, sull'ALTRO campo,
 * una SPINA DI SICUREZZA — il sentinella SENTINEL, che non puo' esistere in nessuna tabella di setup.
 * Il POST fallisce sempre, non crea nulla, e il verdetto e': il campo sondato compare in `errors[]`?
 * Se non compare, quel valore e' stato accettato.
 *
 * La spina e' un sentinella e NON `34670`/`6387`: quei due li crediamo rifiutati, ma se ci
 * sbagliassimo su uno dei due una coppia valida creerebbe una part che nessuno ha chiesto. Un valore
 * inventato non ha quel rischio, per costruzione.
 *
 * Conteggio: 1 calibratura + fino a 6 candidati `type` + fino a 3 `status` = al massimo 10 POST
 * che NON creano niente, piu' 1 di conferma che crea la part usa e getta (e 1 DELETE per
 * toglierla). Tipicamente sono 8 POST in tutto: appena un nome del tenant e' accettato, i nomi
 * successivi si saltano — i due CONTROLLI invece si eseguono sempre, servono a rispondere alla
 * domanda su RB-06. `PLEX_VALUE_PROBE_ALL=on` li esegue tutti.
 *
 * COSA NON FA
 * Non scrive niente, da nessuna parte: ne' ZMatExcLogHDR/POS (sono invii finti: falserebbero lo
 * storico del materiale e il delta del job, dove un 'S'/'W' conta come inviato — 0006 RB-11), ne'
 * ZMatPlexMapping (una part usa e getta non e' la part del materiale: nel dizionario farebbe fare
 * al prossimo invio vero un PUT sull'id sbagliato).
 * Non lancia MAI: una sonda che fallisce deve mostrare il perche', non produrre un 500.
 * Non parte da sola — e dalla W1-20 non parte da sola NESSUNA sonda: le altre si lanciano dalla
 * console (window.splitJobProbe(), window.jobSchedProbe(), …), questa dal clic sul bottone, che e' la forma
 * giusta perche' questa scrive su Plex e l'utente deve confermare.
 *
 * RIMOZIONE
 *   livello 1: PLEX_VALUE_PROBE=off + restart. Non richiede rilascio.
 *   livello 2: `grep -rn "PLEX-VALUE-PROBE"` da' il perimetro, e le sue voci sono di DUE specie.
 *
 *   DA CANCELLARE — e' la sonda, 7 punti:
 *     questo file · test/plexPartValueProbe.test.js ·
 *     srv/cat-service.cds (action probePlexPartValues) ·
 *     srv/cat-service.js (handler, plexConnectDelete, logProbeRows) ·
 *     app/marsplm-sap2plex/webapp/view/DetailNavigation.view.xml (bottone) ·
 *     il suo controller (onProbePlexValues e i tre metodi privati, piu' i controlli importati) ·
 *     le chiavi `probePlex*` / `btnProbePlexValues` nei due i18n del cockpit.
 *
 *   DA RISOLVERE, non da cancellare — sono i punti che l'esito della sonda decide, e restano
 *   sbagliati finche' qualcuno non li corregge:
 *     db/schema.cds (il TODO sul nome di PlexTypeCode / PlexStatusCode: una colonna «...Code» che
 *       contiene «Materia prima» e' un nome che mente) ·
 *     srv/lib/plexPartCodes.js (perche' isValidPlexCode non vincola piu' la forma) ·
 *     app/adminconfigplant/... (il perche' l'input non filtra piu' le cifre) ·
 *     test/plexPartCodes.test.js (i casi invertiti).
 *
 * Sopravvive alla rimozione il solo ESITO, scritto in DEC-65: quello e' la risposta, non la prova.
 * Da rimuovere quando il valore accettato e' confermato e scritto nel customizing del cliente.
 *
 * Modulo PURO: nessun `cds`, nessuna rete, nessuno stato globale. Si collauda con
 * `node test/plexPartValueProbe.test.js`.
 */

'use strict';

/**
 * La spina di sicurezza. Non e' un valore plausibile e non deve esserlo: serve a garantire che il
 * POST venga rifiutato, cosi' la chiamata di scoperta non crea nulla qualunque cosa risulti valida
 * sull'altro campo.
 */
const SENTINEL = '__MARS_PROBE_INVALID__';

/** I nomi dei campi come Plex li riporta in `metadata.field` — maiuscoli, non come li mandiamo. */
const FIELD_TYPE = 'Type';
const FIELD_STATUS = 'Status';

/**
 * I candidati per `type`: i quattro nomi visti nella schermata «Tipo di prodotto» del tenant, piu'
 * due CONTROLLI che cambiano UNA COSA SOLA rispetto a loro, cosi' una riga rossa nomina il colpevole.
 *
 * `"34670"` come stringa NON e' fra i candidati: quella l'abbiamo gia' provata, ed e' la 400 da cui
 * siamo partiti. Resta nel verdetto come fatto noto, non come tentativo.
 */
const TYPE_CANDIDATES = Object.freeze([
  { id: 'T1', value: 'Prodotto finito', sentAs: 'string', what: 'nome del tenant (Part_Type_Key 34669)' },
  { id: 'T2', value: 'Materia prima', sentAs: 'string', what: 'nome del tenant (Part_Type_Key 34670)' },
  { id: 'T3', value: 'Prodotto semifinito', sentAs: 'string', what: 'nome del tenant (Part_Type_Key 34671)' },
  { id: 'T4', value: 'Prodotto phantom', sentAs: 'string', what: 'nome del tenant (Part_Type_Key 34672)' },
  // Controllo 1: cambia SOLO la forma. La stringa '34670' e' gia' stata rifiutata; se il numero
  // passasse, il difetto era la serializzazione e non il valore.
  { id: 'C1', value: 34670, sentAs: 'number', control: true, what: 'CONTROLLO: la chiave come numero, non come stringa' },
  // Controllo 2: cambia SOLO la lingua. E' cio' che il ripiego RB-06 manda quando una tipologia non
  // ha valore configurato: se viene rifiutato, quel ripiego non degrada al comportamento storico ma
  // FALLISCE l'invio, e RB-06 va ripensata.
  { id: 'C2', value: 'Component', sentAs: 'string', control: true, what: 'CONTROLLO: la tipologia del seed (ripiego RB-06)' }
]);

/** I candidati per `status`: il nome del tenant, piu' gli stessi due controlli. */
const STATUS_CANDIDATES = Object.freeze([
  { id: 'S1', value: 'Produzione', sentAs: 'string', what: 'nome del tenant (Part_Status_Key 6387)' },
  { id: 'D1', value: 6387, sentAs: 'number', control: true, what: 'CONTROLLO: la chiave come numero, non come stringa' },
  { id: 'D2', value: 'Production', sentAs: 'string', control: true, what: 'CONTROLLO: lo stesso nome in inglese' }
]);

/** Normalizza a stringa trimmata. */
function s(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * La riga vuota: e' anche la forma del tipo di ritorno dichiarato in srv/cat-service.cds.
 * Chi aggiunge un campo qui lo aggiunge la', o non arriva al chiamante.
 */
function emptyRow() {
  return {
    id: '',
    what: '',
    field: '',
    candidate: '',
    sentAs: '',
    isControl: false,
    partNumber: '',
    httpStatus: 0,
    accepted: false,
    created: false,
    plexId: '',
    deleted: false,
    rejectedFields: '',
    responseBody: '',
    error: '',
    ms: 0
  };
}

/** Il numero della part usa e getta: derivato dal materiale, MAI il materiale stesso. */
function probePartNumber(product, id) {
  return `PRB${s(id)}-${s(product)}`.slice(0, 100);
}

/**
 * Il corpo della chiamata di sonda.
 *
 * `number` e `name` sono obbligatori e non si sondano: qui servono solo a rendere la richiesta
 * completa. Tutto il resto del payload d'esercizio e' fuori: una sonda che mandasse anche il mapping
 * campi non saprebbe piu' dire quale campo ha fatto fallire cosa.
 */
function buildProbeBody({ product, id, type, status }) {
  const partNumber = probePartNumber(product, id);
  return {
    number: partNumber,
    name: `MARS probe ${s(id)}`,
    type,
    status
  };
}

/**
 * I campi che Plex ha rifiutato, letti da `errors[]`.
 *
 * E' il primo lettore di `metadata.field` del progetto: l'unico consumatore di `errors[]` che
 * esisteva guarda `metadata.id`, per il recupero del duplicato. Per questo sta qui, in un modulo
 * puro coi suoi test, e non inline nell'handler.
 *
 * Tollerante sulla FORMA della risposta — corpo assente, stringa invece di oggetto, `errors` non
 * iterabile — perche' una sonda che lancia sul corpo d'errore non serve a niente.
 *
 * @returns {string[]} i valori di `metadata.field`, deduplicati, nell'ordine di comparsa
 */
function rejectedFieldsOf(body) {
  const out = [];
  const seen = new Set();
  const errors = (body && typeof body === 'object' && Array.isArray(body.errors)) ? body.errors : [];
  for (const e of errors) {
    const f = s(e && e.metadata && e.metadata.field);
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

/**
 * Il candidato e' stato accettato?
 *
 * La domanda e' UNA: il campo sondato compare fra quelli rifiutati? Se non compare, Plex non ha
 * avuto niente da dire su quel valore — ed e' l'unica cosa che si puo' concludere, perche' la
 * richiesta e' stata rifiutata comunque, dalla spina sull'altro campo.
 *
 * Su una risposta che non porta errori leggibili — `2xx`, corpo vuoto, errore di trasporto — non si
 * conclude NIENTE: `accepted: false` e il chiamante lo dichiara. «Non lo so» non e' «va bene».
 */
function isAccepted({ ok, status, rejectedFields, probedField }) {
  if (ok) return false;                       // 2xx in un giro di scoperta = la spina non ha tenuto
  if (status !== 400) return false;           // 401/404/0: non e' un verdetto di validazione
  if (!Array.isArray(rejectedFields) || rejectedFields.length === 0) return false;
  return !rejectedFields.includes(probedField);
}

/**
 * La calibratura e' utilizzabile?
 *
 * Manda il sentinella su ENTRAMBI i campi e si aspetta che Plex nomini entrambi. Se ne nomina uno
 * solo i giri 1 e 2 restano validi — sondano un campo per volta — ma va saputo prima di leggere gli
 * esiti, non dopo. Se non nomina nessuno dei due, la sonda non ha un oracolo e si ferma.
 */
function calibrationVerdict({ ok, status, rejectedFields }) {
  const fields = Array.isArray(rejectedFields) ? rejectedFields : [];
  const both = fields.includes(FIELD_TYPE) && fields.includes(FIELD_STATUS);
  const any = fields.includes(FIELD_TYPE) || fields.includes(FIELD_STATUS);
  if (ok) {
    return { usable: false, why: 'il sentinella e stato ACCETTATO: la spina di sicurezza non tiene, ogni giro creerebbe una part' };
  }
  if (status !== 400) {
    return { usable: false, why: `Plex ha risposto ${status} e non 400: non e un verdetto di validazione (credenziale, host o rete)` };
  }
  if (both) return { usable: true, why: 'Plex nomina entrambi i campi: l oracolo vale per tipologia e stato' };
  if (any) {
    return {
      usable: true,
      partial: true,
      why: `Plex nomina un campo solo (${fields.join(', ')}): i giri restano validi perche sondano un campo per volta, ma l assenza dell altro campo non prova niente`
    };
  }
  return { usable: false, why: 'Plex non nomina nessuno dei due campi in errors[].metadata.field: nessun oracolo, la sonda si ferma' };
}

/** La coppia vincente: il primo candidato NON di controllo accettato, per ciascun campo. */
function pickWinner(typeRows, statusRows) {
  const first = (rows) => (Array.isArray(rows) ? rows : [])
    .find((r) => r && r.accepted && !r.isControl) || null;
  const t = first(typeRows);
  const st = first(statusRows);
  if (!t || !st) return null;
  return { type: t.candidate, typeId: t.id, status: st.candidate, statusId: st.id };
}

/** Il blocco strutturato del verdetto: ESITO / MOSSA / CASO, poi i fatti uno per riga. */
function comporreVerdetto({ esito, mossa, caso, fatti }) {
  const righe = [`ESITO  ${esito}`, `MOSSA  ${mossa}`, `CASO   ${caso}`];
  for (const f of fatti || []) righe.push(`  · ${f}`);
  return righe.join('\n');
}

/**
 * Il verdetto: la prima riga della tabella, che si legge senza interpretare le altre.
 */
function verdict({ calibration, typeRows, statusRows, winner, confirmation, createdParts }) {
  const row = emptyRow();
  row.id = 'VERDETTO';

  if (calibration && calibration.usable === false) {
    row.what = comporreVerdetto({
      esito: 'SONDA FERMA — nessun oracolo',
      mossa: 'guardare la riga CAL: la risposta di Plex non permette di concludere niente sui candidati',
      caso: calibration.why,
      fatti: ['nessuna part e stata creata']
    });
    return row;
  }

  const accepted = (rows) => (rows || []).filter((r) => r.accepted).map((r) => `${r.id} «${r.candidate}»`);
  const okType = accepted(typeRows);
  const okStatus = accepted(statusRows);
  const fatti = [];

  if (calibration && calibration.partial) fatti.push(`calibratura PARZIALE: ${calibration.why}`);
  fatti.push(okType.length ? `type accettati: ${okType.join(', ')}` : 'type: nessun candidato accettato');
  fatti.push(okStatus.length ? `status accettati: ${okStatus.join(', ')}` : 'status: nessun candidato accettato');

  // Il controllo del ripiego RB-06 ha una conseguenza sua, e va detta qui.
  const seedRow = (typeRows || []).find((r) => r.id === 'C2');
  if (seedRow) {
    fatti.push(seedRow.accepted
      ? 'la tipologia del seed («Component») e ACCETTATA: il ripiego RB-06 regge su questo tenant'
      : 'la tipologia del seed («Component») e RIFIUTATA: il ripiego RB-06 NON degrada al comportamento storico, fallisce l invio — va ripensato');
  }

  const created = (createdParts || []).filter((p) => !p.deleted);
  if (created.length) {
    fatti.push(`da cancellare a mano su Plex: ${created.map((p) => `${p.partNumber} (${p.plexId})`).join(', ')}`);
  }

  if (!winner) {
    row.what = comporreVerdetto({
      esito: 'NESSUN CANDIDATO PASSA',
      mossa: 'chiedere a Rockwell quale valore risolve `partType`/`partStatus`, o una Data Source che legga part.dbo.Part_Type e Part_Status',
      caso: 'nessuno dei valori sondati e un riferimento noto al tenant',
      fatti
    });
    return row;
  }

  const conf = confirmation || {};
  if (conf.created) {
    row.what = comporreVerdetto({
      esito: `CONFERMATO — type «${winner.type}», status «${winner.status}»`,
      mossa: 'configurare questi due valori nella scheda «Codici Plex» del plant e rifare un invio vero',
      caso: `la coppia ha creato la part di prova ${conf.partNumber} (HTTP ${conf.httpStatus})`,
      fatti
    });
  } else {
    row.what = comporreVerdetto({
      esito: `ACCETTATI ma NON confermati — type «${winner.type}», status «${winner.status}»`,
      mossa: 'guardare la riga CONF: i due valori non sono stati rifiutati, ma la creazione non e riuscita per un altro motivo',
      caso: `la conferma ha risposto HTTP ${conf.httpStatus || 0}`,
      fatti
    });
  }
  return row;
}

/** Una variante non eseguibile si dichiara, non si tenta. */
function skipped(id, field, what) {
  const row = emptyRow();
  row.id = id;
  row.field = field || '';
  row.what = `NON ESEGUITA — ${what}`;
  return row;
}

module.exports = {
  SENTINEL,
  FIELD_TYPE,
  FIELD_STATUS,
  TYPE_CANDIDATES,
  STATUS_CANDIDATES,
  // esportate per il test: sono pure
  emptyRow,
  probePartNumber,
  buildProbeBody,
  rejectedFieldsOf,
  isAccepted,
  calibrationVerdict,
  pickWinner,
  comporreVerdetto,
  verdict,
  skipped
};
