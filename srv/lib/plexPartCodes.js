/**
 * [PLEX-PART-CODES] Regole pure dei CODICI PLEX della part: tipologia e stato prodotto
 * (feature 0022, DEC-65).
 *
 * Su Plex la tipologia e lo stato di un prodotto sono chiavi numeriche del tenant — Part_Type_Key
 * 34669 per «Prodotto finito», Part_Status_Key 6387 per «Produzione» — e non i loro nomi. Il
 * progetto mandava a Plex la STRINGA (`payload.type = 'Finished Product'`) e non mandava affatto
 * lo stato: `status` era solo una voce selezionabile in ZPlexFieldMap, che nessun codice
 * valorizzava.
 *
 * Questo modulo e' l'ultimo anello di una catena che resta UNA:
 *
 *   ZMatCategory.PlexPartType -> ZPlexPartTypeVH.PlexValue -> ZPlexPartTypeCode.PlexTypeCode
 *      (classe MARS, 5)          (tipologia Plex, 4 - seed)     (codice del tenant, per plant)
 *
 * Il primo anello e' srv/lib/materialVisibility.js (classifyMaterial), il secondo
 * srv/lib/materialClass.js (plexValueOf), il terzo e' qui. Non e' una SECONDA traduzione: girano
 * tutti e tre nello stesso punto, buildPlexPartRequestBody, che resta il solo posto in cui si
 * decide cosa finisce in `payload.type` (DEC-62 conseguenza 3).
 *
 * REGOLA DI RIPIEGO, ed e' la stessa di materialClass.js: indice vuoto, tipologia senza codice o
 * codice non valido ⇒ non si tocca niente e parte la STRINGA, cioe' il comportamento storico. Un
 * customizing incompleto non deve poter produrre un `type` vuoto o un `type` sbagliato; deve
 * produrre cio' che si sarebbe mandato ieri. La lacuna si dichiara altrove (MessageStrip nella
 * scheda, riga aggregata nel recap di MAT_SYNC), non si trasforma in un errore d'invio: cio' che
 * parte e' una part che una persona ha chiesto di inviare (DEC-53).
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' stato globale — solo `flag` da
 * materialClass.js, che e' puro a sua volta. Il test si lancia con
 * `node test/plexPartCodes.test.js`. Stessa convenzione di srv/lib/splitRules.js,
 * srv/lib/isQueryShape.js, srv/lib/plexJobSortRules.js e srv/lib/materialClass.js.
 *
 * La lettura delle due tabelle — con le loro cache e il loro fail-open — sta in
 * srv/lib/materialVisibility.js (loadPartTypeCodeIndex, loadPartStatusConfig), accanto a
 * loadPartTypeIndex.
 */

'use strict';

const { flag } = require('./materialClass');

/**
 * Lunghezza massima del valore, allineata a String(50) delle due colonne e al limite che il
 * contratto Plex dichiara per `partType` / `partStatus`. Il troncamento a monte lo fa CAP nella fase
 * `_initial`, prima di ogni before handler (DEC-40): questo limite serve a NON accettare come valido
 * cio' che il database non potrebbe comunque contenere.
 */
const MAX_CODE_LENGTH = 50;

/** Normalizza a stringa trimmata (`''` per null/undefined), come s() di materialClass.js. */
function s(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * Il valore ha una forma accettabile?
 *
 * Qualunque stringa non vuota, fino a MAX_CODE_LENGTH caratteri.
 *
 * [PLEX-VALUE-PROBE] Prima qui c'era `/^[0-9]+$/`, perche' si credeva che Plex volesse la CHIAVE
 * numerica del tenant. Plex ha risposto `400 FIELD_REFERENCE_NOT_FOUND` su `Type: "34670"` e
 * `Status: "6387"` — «attempts to reference data that does not exist» — quindi non risolve per
 * chiave, e il valore atteso e' quasi certamente il NOME della riga di setup: su questo tenant
 * «Materia prima», «Produzione». Il vincolo sulle cifre rifiutava esattamente il valore giusto.
 *
 * Non si mette al suo posto un vincolo sui NOMI: quali nomi esistano lo sa il tenant, non noi, e un
 * elenco cablato qui sarebbe la stessa presunzione di prima al contrario. La forma si verifica
 * (non vuoto, entro la colonna), il contenuto lo verifica Plex — che infatti lo dice, e per campo.
 */
function isValidPlexCode(v) {
  const t = s(v);
  return t.length > 0 && t.length <= MAX_CODE_LENGTH;
}

/**
 * La forma con cui il valore viaggia sul filo: una STRINGA.
 *
 * CONFERMATO dal contratto Plex (18/08/2026): `partType` e `partStatus` sono dichiarati
 * `type: string`, 50 caratteri massimi, con rimando alle setup table `part.dbo.Part_Status`.
 * Non sono interi, benche' la chiave dietro di essi lo sia — la stessa distinzione che DEC-58 fa
 * sulle chiavi SAP: cio' che si manda e' la forma che il destinatario dichiara, non quella che il
 * valore ha nel suo database.
 *
 * La prima stesura mandava un NUMERO, per inferenza dalle schermate di Plex che mostrano
 * Part_Type_Key come intero. Era esattamente il modo di sbagliare contro cui mettono in guardia
 * DEC-43/44/45: una forma di wire non si indovina, si legge dal contratto.
 *
 * [PLEX-VALUE-PROBE] Il tipo era giusto, il VALORE no: la chiave non e' il riferimento che Plex
 * cerca. Questa funzione resta comunque l'unico punto in cui la forma si decide, ed e' il motivo
 * per cui correggerla e' costato una riga.
 *
 * @param {string} code il valore come sta sul database
 * @returns {string|null} `null` se il valore non e' valido (il chiamante non tocca il payload)
 */
function emitCode(code) {
  if (!isValidPlexCode(code)) return null;
  return s(code);
}

/**
 * Indicizza le righe di ZPlexPartTypeCode per tipologia Plex.
 *
 * Il confronto sulla chiave e' STRETTO salvo il trim, come indexPartTypes: la tipologia non e' un
 * codice digitato a mano ma un valore scelto da una tendina alimentata da ZPlexPartTypeVH, e la
 * scrittura e' validata contro quella stessa tabella. Allineare maiuscole qui nasconderebbe un
 * customizing scritto da fuori, che e' proprio il caso che la validazione esiste per far vedere
 * (DEC-51).
 *
 * Una riga NON attiva non entra nell'indice: disattivarla deve riportare al comportamento
 * storico, non lasciare il codice in vigore. Una riga con codice non valido nemmeno — non
 * dovrebbe esistere, la validazione la rifiuta, ma una riga scritta prima della validazione o a
 * mano sul database non deve poter mandare spazzatura a Plex.
 *
 * @param {Array<object>} rows righe di ZPlexPartTypeCode (di UN plant)
 * @returns {Map<string, string>} tipologia -> codice. Vuota su input assente o non iterabile.
 */
function indexTypeCodes(rows) {
  const index = new Map();
  if (!Array.isArray(rows)) return index;
  for (const r of rows) {
    if (!r) continue;
    if (!flag(r.IsActive)) continue;
    const key = s(r.PlexTypeValue);
    const code = s(r.PlexTypeCode);
    if (!key || !isValidPlexCode(code)) continue;
    index.set(key, code);
  }
  return index;
}

/**
 * Il codice del tenant per una tipologia Plex.
 *
 * @param {Map<string, string>} index da indexTypeCodes
 * @param {string} typeValue il valore che sta in `payload.type` — da qualunque sorgente arrivi
 * @returns {string|null} il codice, oppure `null` se non c'e': il chiamante lascia allora il
 *          payload com'e' (ripiego alla stringa, vedi in testa).
 */
function typeCodeOf(index, typeValue) {
  const key = s(typeValue);
  if (!key) return null;
  if (!(index instanceof Map)) return null;
  return index.get(key) || null;
}

/**
 * Lo stato di nascita configurato per il plant, dalla riga di ZPlexPartStatusConfig.
 *
 * Restituisce codice ED etichetta insieme perche' i due non si separano: il codice e' cio' che si
 * manda, l'etichetta e' cio' che si mostra, e mostrare `6387` a un utente e' esattamente il
 * difetto che questa feature esiste per evitare.
 *
 * @param {object|null} row la riga del plant (una sola, @assert.unique su Plant)
 * @returns {{code: string, label: string}|null} `null` se la riga manca, non e' attiva o non ha
 *          un codice valido: allora `status` resta ASSENTE dal payload, che e' cio' che succede
 *          oggi. `status: null` nel corpo JSON sarebbe peggio del campo assente.
 */
function statusFromRow(row) {
  if (!row) return null;
  if (!flag(row.IsActive)) return null;
  const code = s(row.PlexStatusCode);
  if (!isValidPlexCode(code)) return null;
  return { code, label: s(row.PlexStatusLabel) || code };
}

/**
 * Quali tipologie in uso non hanno ancora un codice.
 *
 * Alimenta le due dichiarazioni della lacuna — il MessageStrip della scheda e la riga aggregata
 * nel recap di MAT_SYNC — e non l'invio, che degrada da solo. Serve perche' «nessun codice» e
 * «codice giusto» sono indistinguibili guardando l'esito: in entrambi i casi la part esce.
 *
 * @param {Map<string, string>} index da indexTypeCodes
 * @param {Array<string>} typeValues le tipologie che le categorie attive del plant possono produrre
 * @returns {Array<string>} le tipologie scoperte, deduplicate, nell'ordine di comparsa
 */
function missingTypeCodes(index, typeValues) {
  const missing = [];
  if (!Array.isArray(typeValues)) return missing;
  const seen = new Set();
  for (const v of typeValues) {
    const key = s(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!typeCodeOf(index, key)) missing.push(key);
  }
  return missing;
}

module.exports = {
  MAX_CODE_LENGTH,
  isValidPlexCode,
  emitCode,
  indexTypeCodes,
  typeCodeOf,
  statusFromRow,
  missingTypeCodes
};
