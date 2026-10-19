/**
 * Regole pure della CLASSE MATERIALE (W1-02, BBP §7.3.3).
 *
 * La BBP distingue cinque classi — materie prime, prodotti finiti, semilavorati PRODOTTI in
 * Plex, semilavorati NON prodotti in Plex ma consumati in linea, phantom — e il progetto ne
 * rappresentava quattro. La quinta non e' pero' una riga in piu' in una tendina: e' la
 * separazione di due cose che stavano in un campo solo.
 *
 *   - la CLASSE (`PartType`) e' cio' che MARS distingue e cio' che il configuratore sceglie
 *     su ZMatCategory;
 *   - la TIPOLOGIA PLEX (`PlexValue`) e' cio' che il tenant Plex conosce, e finisce in
 *     `payload.type` di POST/PUT /mdm/v1/parts.
 *
 * Coincidono su quattro classi su cinque. Non coincidono su 'Semifinished External', che per
 * noi e' un semilavorato e per Plex un componente acquistato (BBP §7.3.4: «sono considerati
 * componenti acquistati nella fase iniziale»). Vedi DEC-62.
 *
 * REGOLA DI RIPIEGO, ed e' il cuore della non-regressione: indice vuoto, classe sconosciuta o
 * `PlexValue` non valorizzato ⇒ si restituisce la CLASSE VERBATIM, che e' esattamente cio' che
 * il codice faceva prima di questa feature. Cosi' una value help illeggibile degrada al
 * comportamento storico invece di svuotare `payload.type`.
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' stato globale. Non aggiungerne: il test
 * si lancia con `node test/materialClass.test.js`. Stessa convenzione di srv/lib/splitRules.js,
 * srv/lib/isQueryShape.js e srv/lib/plexJobSortRules.js.
 *
 * La lettura di ZPlexPartTypeVH — con la sua cache e il suo fail-open — sta in
 * srv/lib/materialVisibility.js (loadPartTypeIndex), accanto al caricamento delle categorie.
 */

'use strict';

/**
 * Le cinque classi della BBP §7.3.3, nell'ordine in cui il documento le elenca.
 * NON e' la fonte di verita' a runtime — quella e' la tabella ZPlexPartTypeVH, seedata dal CSV
 * — ma e' l'elenco su cui i test si ancorano e il posto dove leggere quali sono le classi
 * senza aprire il database.
 */
const MATERIAL_CLASSES = Object.freeze([
  'Component',              // materie prime
  'Finished Product',       // prodotti finiti
  'Semifinished Product',   // semilavorati prodotti in Plex
  'Semifinished External',  // semilavorati NON prodotti in Plex, consumati in linea
  'Phantom'
]);

/** La semantica di una classe che non si conosce: tutto spento. */
const UNKNOWN_CLASS_INFO = Object.freeze({
  isSemifinished: false,
  isProducedInPlex: false,
  requiresReceivingOp: false
});

/** Normalizza a stringa trimmata (`''` per null/undefined), come s() di plexPartMapper.js. */
function s(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * Legge un flag booleano che arriva dal database.
 *
 * NON si confronta con `=== true`, ed e' il motivo per cui questa funzione esiste: il valore
 * viene da una colonna CDS `Boolean` e la sua FORMA dipende dal driver. Verificato su
 * sap2plex.db: `@cap-js/sqlite` restituisce NUMERI (`1`/`0`), non booleani. Un confronto
 * stretto spegnerebbe la semantica di tutte le classi — `classInfo` risponderebbe tutto
 * `false` — in silenzio e su tutto lo sviluppo locale, mentre su HANA funzionerebbe.
 *
 * Le forme ammesse sono quelle che un driver puo' rendere per un `Boolean`. NON si accetta
 * `'X'`: questa colonna e' un seed CSV nostro, non un campo SAP, e la convenzione `'X'`/`' '`
 * qui non c'entra (vedi 0013 sui booleani SAP).
 *
 * Tutto il resto — NULL, colonna assente, valore inatteso — e' FALSO: e' lo stato sicuro, ed
 * e' quello che arriva sulle righe HANA preesistenti quando la colonna viene aggiunta.
 */
function flag(v) {
  if (v === true) return true;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    return t === 'true' || t === '1';
  }
  return false;
}

/**
 * Indicizza le righe di ZPlexPartTypeVH per chiave di classe.
 *
 * Il confronto e' STRETTO sulla chiave, salvo il trim: la classe non e' un codice digitato a
 * mano ma un valore scelto da una tendina alimentata da questa stessa tabella, e la scrittura
 * e' validata contro di essa (validateMatCategory). Allineare maiuscole o spazi qui
 * nasconderebbe un customizing scritto a mano da fuori — che e' proprio il caso che la
 * validazione esiste per far vedere. Vedi DEC-51 sull'asse tollerante/stretto.
 *
 * @param {Array<object>} rows righe di ZPlexPartTypeVH
 * @returns {Map<string, object>} classe -> riga. Vuota su input assente o non iterabile.
 */
function indexPartTypes(rows) {
  const index = new Map();
  if (!Array.isArray(rows)) return index;
  for (const r of rows) {
    const key = s(r && r.PartType);
    if (key) index.set(key, r);
  }
  return index;
}

/**
 * La stringa che va in `payload.type` per una classe.
 *
 * @param {Map<string, object>} index da indexPartTypes
 * @param {string} partType la classe configurata su ZMatCategory
 * @returns {string|null} il valore Plex; `null` solo se la classe e' vuota.
 *          Classe sconosciuta o `PlexValue` vuoto ⇒ la classe stessa (ripiego, vedi in testa).
 */
function plexValueOf(index, partType) {
  const cls = s(partType);
  if (!cls) return null;
  const row = (index instanceof Map) ? index.get(cls) : null;
  const mapped = s(row && row.PlexValue);
  return mapped || cls;
}

/**
 * La semantica di una classe: le tre domande che W1-03 (operazione di ricevimento), W1-04
 * (attributi Picker) e W1-18 (fabbisogno semilavorati) porranno.
 *
 * @param {Map<string, object>} index da indexPartTypes
 * @param {string} partType la classe configurata su ZMatCategory
 * @returns {{isSemifinished: boolean, isProducedInPlex: boolean, requiresReceivingOp: boolean}}
 *          tutto `false` se la classe e' vuota o sconosciuta: chi non sa di essere un
 *          semilavorato non lo diventa per ripiego.
 */
function classInfo(index, partType) {
  const cls = s(partType);
  const row = (cls && index instanceof Map) ? index.get(cls) : null;
  if (!row) return { ...UNKNOWN_CLASS_INFO };
  return {
    isSemifinished: flag(row.IsSemifinished),
    isProducedInPlex: flag(row.IsProducedInPlex),
    requiresReceivingOp: flag(row.RequiresReceivingOp)
  };
}

/**
 * La classe e' una classe nota? E' la domanda della validazione in scrittura.
 * Una classe VUOTA e' ammessa e non si chiede qui: una categoria senza part type resta un
 * criterio di sola visibilita', ed e' il comportamento storico.
 */
function isKnownClass(index, partType) {
  const cls = s(partType);
  return !!cls && index instanceof Map && index.has(cls);
}

module.exports = {
  MATERIAL_CLASSES,
  indexPartTypes,
  plexValueOf,
  classInfo,
  isKnownClass,
  // Esportata per srv/lib/plexPartCodes.js (feature 0022), che legge l'IsActive delle sue due
  // tabelle e ha lo stesso problema di forma: duplicarla significherebbe avere due risposte a
  // «questo Boolean e' vero?», e una delle due sbaglierebbe su SQLite.
  flag
};
