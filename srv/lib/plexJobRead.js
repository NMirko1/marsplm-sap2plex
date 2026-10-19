/**
 * [JOB-READ] La lettura di un job su Plex: per il suo ID quando lo abbiamo, per numero quando no.
 *
 * PERCHE' ESISTE
 * Fino alla W1-36 il progetto leggeva un job SOLO con `GET /scheduling/v1/jobs?jobNumber=<ordine>`,
 * benche' l'UUID che Plex restituisce alla creazione fosse salvato in
 * `ZProdOrderPlexMapping.PlexJobId`. Il contratto dichiarava `get-job` non usata — «la lettura per
 * numero basta» — e quel «basta» e' finito il giorno in cui il filtro per numero ha cominciato a
 * rispondere `500 REQUEST_PROCESSING_ERROR` («Data is Null…») sui job che ESISTONO: la finestra di
 * spacchettamento non si apriva piu' (A6 e' la sua prima lettura) e il passo 2 di «Crea Job in Plex»
 * leggeva quell'errore come «job assente», arrivando a **creare un secondo job con lo stesso
 * numero**.
 *
 * QUEL `500` NON ERA UN DIFETTO DI PLEX: ERA NOSTRO, ed e' importante saperlo perche' per una
 * settimana e' stato istruito e girato a Rockwell come la terza faccia del difetto sul
 * backwards-schedule e sul `PUT` — il corpo d'errore era identico, e quella somiglianza e' stata
 * presa per un indizio di causa comune. Gli altri due erano davvero di Plex e sono stati corretti il
 * 27/08/2026; QUESTO no. L'errore era chiedere per NUMERO un job di cui avevamo gia' l'identificativo,
 * e il rimedio e' esattamente cio' che questo modulo fa. Le rettifiche verso Rockwell sono nei due
 * dossier (§2 e §7). La lezione: un messaggio d'errore generico non e' una prova di causa comune —
 * «Data is Null» dice CHE c'e' un null, non DOVE.
 *
 * LE QUATTRO REGOLE, e vanno insieme.
 *
 *   1. ID-FIRST. Con un `jobId` si chiede `GET /scheduling/v1/jobs/{id}`: un oggetto che abbiamo
 *      creato noi si legge per la sua identita'. E' anche piu' STRETTO del filtro per numero, che su
 *      Plex fa match per PREFISSO — la ragione per cui esiste il confronto esatto lato client (FR-19).
 *
 *   2. LA RIGA LETTA PER ID VA IDENTIFICATA. Se il suo `jobNumber` non e' esattamente quello atteso,
 *      l'id del dizionario punta a un ALTRO lotto: quella riga non si usa, si dichiara e si passa
 *      alla lettura per numero. E' la regola del «ambiguo si rifiuta» di DEC-70: la' il rischio era
 *      un dato in piu', qui e' ridurre o rischedulare il lotto di qualcun altro.
 *
 *   3. UN `404` SULL'ID NON E' «ASSENTE». Un id puo' essere stantio — job cancellato su Plex e
 *      ricreato con lo stesso numero — e in quel caso l'oggetto ESISTE. L'autorita' sull'esistenza
 *      resta Plex interrogato per numero, quindi si ripiega sul numero e si conclude da la'.
 *
 *   4. «NON LO SO» NON DIVENTA «NON C'E'». Si conserva il contratto storico di
 *      `findJobByExactNumber`: `ok:true, found:null` = accertatamente assente, `ok:false` = non
 *      conclusivo. L'assenza esce solo da una lettura che ha CONCLUSO; due letture fallite restano
 *      un «non lo so», perche' su un esito non conclusivo un chiamante che scrive deve fermarsi
 *      (DEC-60) e non creare un doppione.
 *
 * `via` dice QUALE lettura ha risposto (`'id'` | `'number'`): chi legge un log non deve dedurlo.
 *
 * Nessuna dipendenza da `cds`: le regole si collaudano con `node test/plexJobRead.test.js`.
 * Perimetro: grep -rn "JOB-READ".
 */

'use strict';

const { isExactJobNumber } = require('./splitRules');
const { plexErrText } = require('./plexCallTrace');

/** Le due forme di lettura, con il loro path. FUNZIONE PURA. */
function pathById(jobId) {
  return `/scheduling/v1/jobs/${encodeURIComponent(String(jobId).trim())}`;
}

function pathByNumber(jobNumber) {
  return `/scheduling/v1/jobs?jobNumber=${encodeURIComponent(jobNumber)}`;
}

/**
 * Il piano di lettura: quali letture, in quale ordine. FUNZIONE PURA.
 * Un `jobId` vuoto o non stringa non produce una lettura per id: senza questo, un `undefined` nel
 * dizionario diventerebbe `GET /scheduling/v1/jobs/undefined`.
 */
function readPlan({ jobNumber, jobId } = {}) {
  const plan = [];
  const id = jobId === undefined || jobId === null ? '' : String(jobId).trim();
  if (id) plan.push({ via: 'id', path: pathById(id) });
  plan.push({ via: 'number', path: pathByNumber(jobNumber) });
  return plan;
}

/** Le righe di una risposta: la lista di `list-jobs`, l'oggetto solo di `get-job`. PURA. */
function asArray(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && typeof body === 'object') return [body];
  return [];
}

/**
 * Esito della lettura PER ID. FUNZIONE PURA.
 *   FOUND        la riga c'e' ed e' quella giusta
 *   MISMATCH     la riga c'e' ma e' di un altro lotto (regola 2): non si usa
 *   ABSENT_ID    `404`: quell'id non esiste piu' (regola 3): non conclude l'assenza del NUMERO
 *   INCONCLUSIVE qualunque altro esito, eccezione compresa
 */
function interpretById(r, jobNumber, thrown) {
  if (thrown) return { state: 'INCONCLUSIVE', found: null, error: thrown.message };
  if (r && r.status === 404) return { state: 'ABSENT_ID', found: null, error: '' };
  if (!r || !r.ok) return { state: 'INCONCLUSIVE', found: null, error: plexErrText(r) };
  const row = asArray(r.body)[0] || null;
  if (!row) return { state: 'INCONCLUSIVE', found: null, error: 'risposta senza riga' };
  // Riga senza `jobNumber`: NON e' un lotto altrui, e' una riga che non si puo' identificare. Va
  // dichiarata come non conclusiva, non come incoerenza del dizionario.
  if (row.jobNumber === undefined || row.jobNumber === null || String(row.jobNumber).trim() === '') {
    return { state: 'INCONCLUSIVE', found: null, error: 'riga senza jobNumber: non identificabile' };
  }
  if (!isExactJobNumber(row.jobNumber, jobNumber)) {
    return {
      state: 'MISMATCH',
      found: null,
      error: `l'id porta il job ${row.jobNumber}, non ${jobNumber}`
    };
  }
  return { state: 'FOUND', found: row, error: '' };
}

/**
 * Esito della lettura PER NUMERO, cioe' il comportamento storico. FUNZIONE PURA.
 * `prefixOnly` sono le righe il cui numero INIZIA con quello cercato senza esserne uguale: non e'
 * un errore — il confronto esatto protegge — ma va saputo prima di scoprirlo con un pacchetto
 * ridotto per sbaglio.
 */
function interpretByNumber(r, jobNumber, thrown) {
  if (thrown) return { state: 'INCONCLUSIVE', found: null, error: thrown.message, prefixOnly: [] };
  if (!r || !r.ok) return { state: 'INCONCLUSIVE', found: null, error: plexErrText(r), prefixOnly: [] };
  const rows = asArray(r.body);
  const found = rows.find((j) => j && isExactJobNumber(j.jobNumber, jobNumber)) || null;
  const prefixOnly = rows.filter((j) => {
    const n = j && j.jobNumber !== undefined && j.jobNumber !== null ? String(j.jobNumber).trim() : '';
    return n && !isExactJobNumber(n, jobNumber) && n.startsWith(String(jobNumber).trim());
  });
  return { state: found ? 'FOUND' : 'ABSENT', found, error: '', prefixOnly };
}

/**
 * Legge un job. Forma di ritorno IDENTICA a quella storica di `findJobByExactNumber`, perche' i
 * chiamanti dello spacchettamento ci si appoggiano: `ok` dice se la risposta e' interpretabile,
 * `found` se il lotto esiste, e i due non coincidono.
 *
 * @param {{get: Function}} plex la tripla Plex (tracciata: srv/lib/plexCallTrace.js)
 * @param {object} o
 * @param {string} o.jobNumber numero del job cercato (per il lotto principale = l'ordine SAP)
 * @param {string} [o.jobId]   UUID Plex, se il dizionario ce l'ha
 * @returns {Promise<{ok, found, status, error, url, via, thrown, aborted, notes}>}
 */
async function findJob(plex, { jobNumber, jobId } = {}) {
  const plan = readPlan({ jobNumber, jobId });
  const notes = [];
  let idOutcome = null;

  for (const step of plan) {
    let r = null;
    let thrown = null;
    try {
      r = await plex.get(step.path);
    } catch (e) {
      thrown = e;
    }

    if (step.via === 'id') {
      idOutcome = interpretById(r, jobNumber, thrown);
      if (idOutcome.state === 'FOUND') {
        return { ok: true, found: idOutcome.found, status: r.status, url: step.path, via: 'id', notes };
      }
      // Regole 2 e 3: si dichiara e si prosegue col numero, che e' l'autorita' sull'esistenza.
      if (idOutcome.state === 'MISMATCH') {
        console.warn(`>>> [JOB-READ] ${pathById(jobId)}: ${idOutcome.error} — riga IGNORATA, si legge per numero`);
        notes.push(`id del dizionario incoerente: ${idOutcome.error}`);
      } else if (idOutcome.state === 'ABSENT_ID') {
        notes.push('id del dizionario non piu\' esistente su Plex (404): l\'esistenza la decide il numero');
      } else {
        notes.push(`lettura per id non conclusiva: ${idOutcome.error}`);
      }
      continue;
    }

    const byNumber = interpretByNumber(r, jobNumber, thrown);
    if (byNumber.prefixOnly.length) {
      console.warn(
        `>>> [JOB-READ] GET jobs?jobNumber=${jobNumber}: ${byNumber.prefixOnly.length} righe con numero che INIZIA `
        + 'con quello cercato senza esserne uguale: l\'endpoint fa probabilmente match per prefisso'
      );
    }
    if (byNumber.state === 'INCONCLUSIVE') {
      return {
        ok: false,
        found: null,
        status: thrown ? 0 : (r && r.status) || 0,
        url: step.path,
        via: 'number',
        error: byNumber.error,
        thrown: !!thrown,
        aborted: !!thrown && thrown.name === 'AbortError',
        notes
      };
    }
    return {
      ok: true,
      found: byNumber.found,
      status: (r && r.status) || 0,
      url: step.path,
      via: 'number',
      notes
    };
  }

  // Non raggiungibile: `readPlan` mette sempre la lettura per numero in coda. Resta come rete.
  return { ok: false, found: null, status: 0, url: pathByNumber(jobNumber), via: 'number', notes };
}

module.exports = {
  findJob,
  readPlan,
  interpretById,
  interpretByNumber,
  asArray,
  pathById,
  pathByNumber
};
