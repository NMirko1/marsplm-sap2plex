/**
 * [ORDER-COMP-REMOVE] Regole pure della rimozione MANUALE di un componente dall'albero Plex di un
 * ordine di produzione (feature 0026). FUNZIONI PURE: nessun `cds`, nessuna rete, nessun
 * `process.env`. Collaudo: node test/orderCompRemovalRules.test.js
 *
 * COS'E' UNA RIMOZIONE, E COSA NON E'.
 * Una persona apre il dettaglio dell'ordine, guarda l'albero Plex — che l'ordine ha ereditato dal
 * ciclo del MATERIALE — e vede un componente che quell'ODP non ha piu': tolto o sostituito in SAP.
 * La rimozione dichiara «questo componente non appartiene piu' a quest'ordine», e come DEC-74 non
 * e' una regola di invio: e' una RESTRIZIONE di `order.components`, l'insieme SAP su cui il passo
 * 2bis calcola cosa aggiungere e il passo 7.2 calcola cosa disattivare. Un componente rimosso non
 * viene «non mandato» — non lo mandavamo comunque — viene DISATTIVATO sul job, che e' l'unico
 * effetto che la fabbrica vede.
 *
 * PERCHE' NON SI GUARDA L'ALBERO SALVATO. La strada breve sarebbe far diventare
 * `ZPlexCycleComponent` l'autorita' sull'insieme dei componenti dell'invio: cio' che vedi e' cio'
 * che parte. Non si fa, perche' «assente dall'albero» ha DUE cause con rimedi opposti — rimosso a
 * mano, oppure mai collocato da nessuna operazione. Nel secondo caso oggi il passo 2bis lo dichiara
 * e ferma l'ordine (DEC-86, `FAILURE.UNASSIGNED`); leggendo l'albero, quel componente
 * sparirebbe in silenzio e in SAP il 261 lo consumerebbe lo stesso. La rimozione e' quindi un
 * ATTO ESPLICITO che si scrive, non un'assenza che si interpreta.
 *
 * GRANULARITA' PER SOLO MATERIALE, non per coppia (operazione, materiale): la stessa del 7.2 e del
 * 2bis (DEC-86 RB-03). Due granularita' diverse sullo stesso oggetto darebbero un
 * aggiungi-e-poi-disattiva a ogni giro.
 */

'use strict';

const { matKey } = require('./orderBomAddRules');

/** Stringa potata, mai `undefined`. */
function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * L'insieme delle chiavi materiale rimosse, dalle righe di `ZProdOrderCompRemoved`.
 *
 * La chiave e' `matKey` di orderBomAddRules — LA STESSA che il passo 2bis usa per decidere se un
 * componente e' presente sulla distinta. Due normalizzazioni diverse sui due lati dello stesso
 * confronto sarebbero un componente che risulta rimosso qui e presente la', cioe' un'esclusione che
 * non esclude. Tollerante sulla grafia, stretta sugli zeri iniziali (DEC-51).
 *
 * ACCETTA RIGHE **E** CODICI, come `normalizeMaterials`, perche' i due chiamanti veri passano forme
 * diverse: il payload della action porta `{ Material }`, `loadRemovedMaterials` porta i soli codici.
 * Leggere solo `.Material` non dava un errore — dava un insieme VUOTO, cioe' nessuna rimozione
 * applicata in silenzio, che e' il difetto peggiore di questa feature (colto al primo collaudo
 * contro il database).
 *
 * @param {Array<object|string>|null} rows righe con `Material`, o codici materiale
 * @returns {Set<string>}
 */
function removedKeys(rows) {
  const out = new Set();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const k = matKey(typeof r === 'string' ? r : (r && r.Material));
    if (k) out.add(k);
  }
  return out;
}

/**
 * Sottrae dai componenti dell'ordine quelli rimossi a mano.
 *
 * NESSUNA RIGA => NESSUNA RESTRIZIONE, cioe' il comportamento di prima della 0026: un ordine che
 * nessuno ha mai aperto nel cockpit si comporta esattamente come oggi (DEC-53).
 *
 * `materials` porta i codici COME SONO ARRIVATI dalle righe componente, non le chiavi
 * normalizzate: e' l'elenco che finisce nei messaggi e nel recap, e un materiale scritto a schermo
 * in maiuscolo forzato non sarebbe piu' quello che l'utente ha rimosso.
 *
 * @param {object} args
 * @param {Array<object>} args.components righe componente (dopo esplosione fantasma ed esclusioni
 *        di customizing: la rimozione manuale e' l'ultimo strato)
 * @param {Array<object>|Set<string>} args.removed righe di `ZProdOrderCompRemoved`, o l'insieme
 *        delle chiavi gia' calcolato
 * @returns {{kept: Array<object>, dropped: Array<object>,
 *           stats: {read: number, kept: number, removed: number, materials: Array<string>,
 *                   unmatched: Array<string>}}}
 *   `stats.unmatched` sono i materiali dichiarati rimossi che nell'ordine NON ci sono (piu'):
 *   non e' un errore — SAP puo' averli tolti dopo la rimozione — ma va visto, perche' e' anche la
 *   forma che prende uno zero iniziale sbagliato.
 */
function applyRemovals({ components, removed } = {}) {
  const list = Array.isArray(components) ? components : [];
  const keys = removed instanceof Set ? removed : removedKeys(removed);
  const stats = { read: list.length, kept: list.length, removed: 0, materials: [], unmatched: [] };
  if (!keys.size) return { kept: list, dropped: [], stats };

  const kept = [];
  const dropped = [];
  const hit = new Set();
  for (const c of list) {
    const k = matKey(c && c.Material);
    if (k && keys.has(k)) {
      hit.add(k);
      dropped.push(c);
      stats.materials.push(str(c && c.Material));
      continue;
    }
    kept.push(c);
  }
  stats.kept = kept.length;
  stats.removed = dropped.length;
  for (const k of keys) if (!hit.has(k)) stats.unmatched.push(k);
  return { kept, dropped, stats };
}

/**
 * I materiali da scrivere, dal payload del client.
 *
 * Potatura, scarto dei vuoti e deduplica sulla CHIAVE di confronto: due grafie dello stesso
 * materiale sono una riga sola, altrimenti la tabella avrebbe due chiavi primarie diverse per lo
 * stesso componente e l'INSERT massivo cadrebbe su un duplicato solo a volte. Il valore
 * conservato e' il PRIMO arrivato, non quello normalizzato: la chiave della tabella e' un codice
 * materiale SAP e non si riscrive (DEC-51).
 *
 * @param {Array<object|string>|null} list voci `{ Material }` o codici
 * @returns {Array<string>}
 */
function normalizeMaterials(list) {
  const seen = new Set();
  const out = [];
  for (const item of (Array.isArray(list) ? list : [])) {
    const raw = str(typeof item === 'string' ? item : (item && item.Material));
    const k = matKey(raw);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(raw);
  }
  return out;
}

/**
 * I materiali che il payload AGGIUNGE rispetto a quelli gia' registrati.
 *
 * Serve al guardiano di `savePlexCycle`: il client rimanda ogni volta le rimozioni che ha letto,
 * quindi «l'ordine e' gia' inviato, elenco non vuoto» rifiuterebbe qualunque salvataggio
 * successivo al primo invio — comprese le modifiche alle operazioni, che con le rimozioni non
 * c'entrano. Cio' che va rifiutato dopo l'invio e' una rimozione NUOVA.
 *
 * @param {Array<object|string>|null} wanted il payload
 * @param {Array<object|string>|null} existing le righe gia' in tabella
 * @returns {Array<string>} i codici nuovi, nella grafia con cui sono arrivati
 */
function addedMaterials(wanted, existing) {
  const known = new Set(normalizeMaterials(existing).map(matKey));
  return normalizeMaterials(wanted).filter((m) => !known.has(matKey(m)));
}

/**
 * L'ordine e' GIA' STATO INVIATO a Plex?
 *
 * Lo dice il NOSTRO dizionario, non Plex: una riga in `ZProdOrderPlexMapping` e' scritta alla
 * creazione del job e anche sugli esiti `W` (DEC-80). Basta UNA riga — lotto principale o pacchetto
 * dello spacchettamento — che porti un `PlexJobId`, perche' su Plex esista qualcosa che porta il
 * nome di quest'ordine.
 *
 * Perche' non si interroga Plex: qui la domanda non e' «il job esiste ancora?» ma «questo ordine e'
 * gia' uscito?», e a quella risponde cio' che abbiamo scritto noi. Una lettura verso Plex
 * aggiungerebbe un modo di NON saperlo a una schermata che deve solo abilitare un pulsante.
 *
 * [ORDER-MAP-JOB] MA LA DOMANDA NON E' «ESISTE UNA RIGA». Lo era, e per questo la striscia
 * «L'ordine e' gia' stato inviato a Plex» compariva su ordini mai usciti: `writeMappingAndLog`
 * scriveva la riga dopo OGNI esito, compresi i `return outcome('E', ...)` che escono prima di una
 * sola chiamata verso Plex — il gate del ciclo vuoto su tutti. La riga nasceva con
 * `PlexJobId: null`, e «Rimuovi» restava spento su un ordine su cui non c'era niente da
 * proteggere. La scrittura e' stata ristretta (`srv/lib/orderMappingRules.js`), ma il predicato va
 * cambiato lo stesso: le righe gia' in tabella restano, e smettono di contare solo se a contare e'
 * l'ID.
 *
 * SI DECIDE IN MEMORIA, non in SQL: il repo non ha nessun precedente di `IS NOT NULL` in CQN, e una
 * forma che generasse `= NULL` non aggancerebbe NESSUNA riga — «mai inviato» per ogni ordine, cioe'
 * il verso che concede la rimozione su lotti vivi. La forma qui e' quella di `plexJobSplit.js`
 * (`if (!mainRow || !mainRow.PlexJobId)`), l'unico punto che poneva gia' la domanda giusta.
 *
 * UN CONTEGGIO NON PUO' PIU' RISPONDERE, e si rifiuta invece di indovinare: `3` righe non dicono se
 * una porti un id. Chi legge deve chiedere la colonna.
 *
 * @param {Array<object>|object|null} mappingRows righe lette, con almeno la colonna `PlexJobId`
 * @returns {boolean}
 */
function isAlreadySent(mappingRows) {
  if (typeof mappingRows === 'number') {
    throw new TypeError('[ORDER-MAP-JOB] isAlreadySent vuole le RIGHE, non il loro conteggio:'
      + ' il verdetto e\' «almeno una riga porta un PlexJobId», e un numero non lo sa');
  }
  const rows = Array.isArray(mappingRows) ? mappingRows : (mappingRows ? [mappingRows] : []);
  return rows.some((r) => r && typeof r === 'object' && hasJobId(r.PlexJobId));
}

/**
 * Un `PlexJobId` che porta qualcosa.
 *
 * La colonna e' `String(36)` e nullable: arriva `null` dal database, `undefined` da una riga letta
 * con un `$select` che non la comprende, e `''` da una riga azzerata. Le tre forme significano
 * tutte «nessun job», e trattarne una sola come vuota lascerebbe passare le altre due.
 */
function hasJobId(v) {
  return typeof v === 'string' ? v.trim() !== '' : !!v;
}

/** Una riga di recap leggibile, o `''` se non c'e' niente da dire. */
function describe(stats) {
  if (!stats || !stats.removed) return '';
  const shown = stats.materials.slice(0, 10).join(', ');
  const rest = stats.materials.length > 10 ? ` e altri ${stats.materials.length - 10}` : '';
  return `componenti rimossi a mano dall'ordine: ${stats.removed} di ${stats.read} (${shown}${rest})`;
}

module.exports = {
  removedKeys,
  applyRemovals,
  normalizeMaterials,
  addedMaterials,
  isAlreadySent,
  hasJobId,
  describe
};
