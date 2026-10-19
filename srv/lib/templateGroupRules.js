/**
 * [TEMPLATE-GROUP] Regola pura dei gruppi oggetti sulle operazioni di un template di ciclo.
 *
 * LA REGOLA. Dentro un template, uno stesso gruppo oggetti sta su AL PIU' UNA operazione. Non e' un
 * vezzo di coerenza: il motore di auto-assegnazione manda un gruppo su UNA operazione per materiale
 * di testata (`ZCycleAutoAssignConfig`, chiave `(Plant, Material, ComponentGroup)`), quindi un
 * template che mettesse lo stesso gruppo su due operazioni descriverebbe qualcosa che quel motore
 * non sa esprimere — e il giorno in cui questi dati alimenteranno l'import, a scegliere quale delle
 * due vince sarebbe l'ordine di lettura del database.
 *
 * PERCHE' RIFIUTARE E NON DEDUPLICARE. Stessa ragione di `approvedWcRules.js`: un gruppo su due
 * operazioni non e' una riga in piu' da scartare, e' un customizing che dice due cose incompatibili.
 * Si rifiuta alla scrittura, dove c'e' una persona che puo' correggere.
 *
 * ================================================================
 * PERCHE' NON E' UNA GENERALIZZAZIONE DI `approvedWcRules.js`
 * ================================================================
 * La forma del problema e' la stessa — un identificativo che compare su due operazioni — e la
 * tentazione di parametrizzare quel modulo con «nome della collezione» e «nome del campo chiave» e'
 * legittima. Cade su una riga sola: LA CHIAVE DI CONFRONTO.
 *
 * Là la chiave e' TRIMMATA E MAIUSCOLA, ed e' corretto: i due lati sono GUID scritti da Plex, due
 * work center distinti non differiscono per il solo caso, e ignorarlo non puo' fondere due entita'.
 *
 * Qui i due lati sono codici NOSTRI, digitati da una persona nella scheda «Gruppi» e scelti da una
 * tendina che legge la stessa tabella. `@assert.unique.plantGroup` non dichiara nessuna
 * insensibilita' al caso, quindi `g1` e `G1` possono essere due righe diverse di `ZObjectGroup`:
 * piegare il caso FONDEREBBE DUE GRUPPI DIVERSI, cioe' rifiuterebbe un template corretto — il
 * difetto opposto a quello che questa regola esiste per fermare. E' l'asse di DEC-51: come si
 * confronta lo decide chi ha scritto i due lati.
 *
 * Il confronto e' quindi STRETTO, col solo trim: il trim c'e' perche' uno spazio in coda non e' una
 * scelta di nessuno, e perche' il valore memorizzato non viene toccato — si normalizza solo per
 * confrontare (come `normalizeUom` in srv/lib/recvOpRules.js).
 *
 * ================================================================
 * [TEMPLATE-AUTOASSIGN] LA SECONDA META': DAL TEMPLATE ALLA CONFIGURAZIONE
 * ================================================================
 * Dalla feature dell'import, le stesse operazioni descrivono anche le righe di
 * `ZCycleAutoAssignConfig` del materiale su cui il template viene importato — `autoAssignRowsOf`.
 * Quella funzione ha DUE chiamanti e deve restare una: il salvataggio del ciclo, che le righe le
 * persiste, e l'auto-assegnazione, che le usa senza persisterle per rispondere «dove va questo
 * componente» su un template importato e non ancora salvato. Due copie darebbero un'anteprima che
 * non corrisponde al risultato, cioe' un albero che cambia dopo il Salva senza che nessuno lo dica.
 *
 * Quello che qui NON c'e', ed e' voluto: la precedenza fra le regole del materiale e quelle di
 * ripiego (`Material = '*'`). Vive in `srv/lib/autoAssignRules.js` (`pickAssignment`, DEC-129) e non
 * si tocca — questo modulo dice QUALI righe esistono, quello dice come si sceglie fra loro.
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' stato globale. Non aggiungerne: il test si
 * lancia con `node test/templateGroupRules.test.js`. Nessuna funzione muta l'input.
 */

'use strict';

/**
 * Natura del conflitto, con la stessa coppia di `approvedWcRules.js` e per le stesse ragioni:
 *   CROSS_OP  lo stesso gruppo su DUE operazioni del template — il caso che il popover produce con
 *             un gesto normale (MultiSelect per operazione);
 *   SAME_OP   due righe identiche sulla STESSA operazione — il popover non lo produce, un payload
 *             sì. Senza questo ramo il doppione passerebbe: sarebbe letto come «prima occorrenza»
 *             due volte sulla stessa chiave.
 */
const GROUP_CONFLICT = {
  CROSS_OP: 'CROSS_OP',
  SAME_OP: 'SAME_OP'
};

/**
 * Chiave di CONFRONTO di un gruppo: il codice trimmato, NIENTE ALTRO.
 *
 * Il caso NON si piega: vedi l'intestazione. Il valore memorizzato non passa da qui.
 *
 * @param {string} groupId il codice del gruppo
 * @returns {string} la chiave, oppure `''` se non c'e' niente da confrontare
 */
function groupKey(groupId) {
  if (groupId === null || groupId === undefined) return '';
  return String(groupId).trim();
}

/**
 * Etichetta di un'operazione: il codice, il nome, il numero, l'id. Stessa scaletta di
 * `approvedWcRules.operationLabel` — duplicata e non importata perche' quel modulo e' `[W1-08]` e
 * un'importazione fra i due creerebbe il legame che l'intestazione spiega di non volere.
 *
 * @param {object} op operazione nella forma del payload dell'action
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

/**
 * I conflitti di gruppo di un template.
 *
 * VINCE LA PRIMA OCCORRENZA nell'ordine ricevuto, e le successive sono i conflitti: l'esito e'
 * riproducibile e il messaggio puo' dire «e' già sull'operazione X» nominandone una sola.
 *
 * @param {Array<object>} operations forma del payload di `saveRoutingTemplate`:
 *   [{ PlexOperationId, OperationCode, OperationName, OperationNumber,
 *      ObjectGroups: [{ GroupId }] }]
 * @returns {Array<object>} conflitti, vuoto se non ce ne sono
 */
function findGroupConflicts(operations) {
  const ops = Array.isArray(operations) ? operations : [];
  const conflicts = [];
  // chiave del gruppo -> prima operazione che la tiene
  const holders = new Map();

  for (const op of ops) {
    if (!op) continue;
    const groups = Array.isArray(op.ObjectGroups) ? op.ObjectGroups : [];
    const here = { PlexOperationId: op.PlexOperationId, label: operationLabel(op) };

    for (const g of groups) {
      if (!g) continue;
      const key = groupKey(g.GroupId);
      // Senza codice non c'e' nulla da confrontare, e la riga non e' salvabile comunque: la
      // `not null` dello schema la rifiuta a valle, e non e' questo il punto in cui si decide.
      if (!key) continue;

      const holder = holders.get(key);
      if (!holder) {
        holders.set(key, here);
        continue;
      }

      conflicts.push({
        kind: holder.PlexOperationId === op.PlexOperationId
          ? GROUP_CONFLICT.SAME_OP
          : GROUP_CONFLICT.CROSS_OP,
        GroupId: key,
        holder: { PlexOperationId: holder.PlexOperationId, label: holder.label },
        offender: here
      });
    }
  }

  return conflicts;
}

/**
 * Le righe da scrivere, appiattite, a partire dalle operazioni del payload.
 *
 * Sta qui e non nell'handler perche' la deduplica e' parte della regola: dopo che
 * `findGroupConflicts` ha rifiutato i conflitti veri non restano doppioni, ma questa funzione e'
 * cio' che rende quella promessa verificabile da un test senza database.
 *
 * @param {Array<object>} operations le operazioni del payload
 * @returns {Array<{PlexOperationId: string, GroupId: string}>} le righe, nell'ordine ricevuto
 */
function groupRowsOf(operations) {
  const ops = Array.isArray(operations) ? operations : [];
  const rows = [];
  const seen = new Set();

  for (const op of ops) {
    if (!op) continue;
    const groups = Array.isArray(op.ObjectGroups) ? op.ObjectGroups : [];
    for (const g of groups) {
      if (!g) continue;
      const key = groupKey(g.GroupId);
      if (!key) continue;
      const rowKey = `${op.PlexOperationId}||${key}`;
      if (seen.has(rowKey)) continue;
      seen.add(rowKey);
      rows.push({ PlexOperationId: op.PlexOperationId, GroupId: key });
    }
  }

  return rows;
}

/**
 * Il payload DICHIARA i gruppi?
 *
 * «Nessuna operazione porta la chiave» e «le operazioni portano una lista vuota» NON sono la stessa
 * cosa, ed e' l'unico punto in cui questa collezione si discosta dalle due sorelle. La ragione e'
 * il rilascio: una scheda gia' aperta nel browser continua a mandare il payload di prima, senza la
 * chiave, e siccome il salvataggio dei figli e' un delete-then-insert quel payload
 * CANCELLEREBBE i gruppi appena inseriti da qualcun altro — senza un errore, senza una riga di log,
 * e con l'utente convinto di aver salvato.
 *
 * Il prezzo si dichiara: un template non si svuota dei suoi gruppi con un payload che OMETTE la
 * chiave. Il client la manda sempre (lista vuota dove non ci sono gruppi), quindi svuotare
 * funziona.
 *
 * @param {Array<object>} operations le operazioni del payload
 * @returns {boolean} `true` se almeno un'operazione dichiara `ObjectGroups`
 */
function declaresGroups(operations) {
  const ops = Array.isArray(operations) ? operations : [];
  return ops.some((op) => op && Array.isArray(op.ObjectGroups));
}

/**
 * [TEMPLATE-AUTOASSIGN] C'e' ALMENO UN gruppo, su una qualsiasi operazione?
 *
 * E' UNA DOMANDA DIVERSA DA `declaresGroups`, e le due non si fondono. Quella chiede «il payload
 * PARLA dei gruppi?» e serve al salvataggio del template, dove la chiave assente significa «non
 * toccarli». Questa chiede «ce n'e' almeno uno?» ed e' il cancello della riscrittura della
 * configurazione di auto-assegnazione: nessun gruppo ⇒ non si tocca niente, che e' la regola
 * voluta. Con `ObjectGroups: []` su ogni operazione la prima risponde `true` e la seconda `false`,
 * ed e' esattamente la differenza che serve.
 *
 * E' anche il punto in cui si decide se pagare qualcosa: su un salvataggio ordinario di ciclo —
 * cioe' il caso normale, senza template di mezzo — questa funzione rende `false` senza toccare il
 * database, e nessuna delle query della riscrittura parte. Esce al primo gruppo trovato.
 *
 * @param {Array<object>} operations le operazioni del payload
 * @returns {boolean} `true` se almeno un'operazione porta almeno un gruppo con un codice
 */
function hasAnyGroup(operations) {
  const ops = Array.isArray(operations) ? operations : [];
  return ops.some((op) => Array.isArray(op && op.ObjectGroups)
    && op.ObjectGroups.some((g) => groupKey(g && g.GroupId)));
}

/**
 * [TEMPLATE-AUTOASSIGN] Le righe di `ZCycleAutoAssignConfig` che le operazioni descrivono.
 *
 * E' LA FUNZIONE CHE TIENE INSIEME LA FEATURE, perche' la chiamano in DUE: il salvataggio del ciclo,
 * che le persiste, e l'auto-assegnazione, che le usa senza persisterle per rispondere «dove andrebbe
 * questo componente» su un template importato e non ancora salvato. Se fossero due pezzi di codice
 * l'anteprima smetterebbe di corrispondere al risultato, e il sintomo sarebbe un albero che cambia
 * dopo il Salva — senza un errore da nessuna parte.
 *
 * IL BERSAGLIO E' IL CODICE dell'operazione, non il suo UUID: e' il contratto gia' in esercizio di
 * `ZCycleAutoAssignConfig.PlexOperation`, quello che la tendina della scheda «Assegnazione
 * automatica» scrive. Dove il codice manca si ripiega sull'id — `resolveTargetPartOperation` lo
 * risolve col suo ramo `OPERATION_ID` — e un'operazione senza ne' l'uno ne' l'altro non ha un
 * bersaglio: la sua riga non si inventa, si SCARTA, e il chiamante lo dichiara.
 *
 * `PlexOperationName` e' denormalizzato per la sola leggibilita' a schermo, come lo scrive la UI.
 *
 * @param {Array<object>} operations le operazioni del payload, con `ObjectGroups`
 * @param {string} material il materiale di testata: finisce in `Material` su ogni riga
 * @returns {{rows: Array<object>, skipped: Array<string>}} le righe, e i gruppi scartati perche'
 *          l'operazione che li porta non ha ne' codice ne' id
 */
function autoAssignRowsOf(operations, material) {
  const mat = groupKey(material);
  const rows = [];
  const skipped = [];
  const seen = new Set();

  for (const op of (Array.isArray(operations) ? operations : [])) {
    if (!op) continue;
    const groups = Array.isArray(op.ObjectGroups) ? op.ObjectGroups : [];
    if (!groups.length) continue;

    const target = groupKey(op.OperationCode) || groupKey(op.PlexOperationId);
    const name = groupKey(op.OperationName);

    for (const g of groups) {
      const code = groupKey(g && g.GroupId);
      if (!code) continue;
      if (!target) {
        // Si dichiara invece di scomparire: senza bersaglio la riga non e' scrivibile, e una
        // configurazione piu' corta di quella attesa e' indistinguibile da una giusta.
        skipped.push(code);
        continue;
      }
      // La deduplica e' sul GRUPPO e non sulla coppia: la chiave di `ZCycleAutoAssignConfig` e'
      // (Plant, Material, ComponentGroup), quindi due operazioni con lo stesso gruppo sono due
      // righe in conflitto — e' `findGroupConflicts` a rifiutarle prima, questa e' la rete.
      if (seen.has(code)) continue;
      seen.add(code);
      rows.push({
        Material: mat,
        ComponentGroup: code,
        PlexOperation: target,
        PlexOperationName: name || null
      });
    }
  }

  return { rows, skipped };
}

module.exports = {
  GROUP_CONFLICT,
  groupKey,
  operationLabel,
  findGroupConflicts,
  groupRowsOf,
  declaresGroups,
  // [TEMPLATE-AUTOASSIGN]
  hasAnyGroup,
  autoAssignRowsOf
};
