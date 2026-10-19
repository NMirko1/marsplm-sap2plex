/**
 * Visibilità dei cicli (customizing per plant, feature 0016).
 *
 * Decide, a partire dal customizing ZRoutingFilterConfig, QUALI cicli SAP compaiono nella lista
 * del cockpit, per combinazione di stato (`PLNST`) e utilizzo (`PLNAW`) della lista di operazioni.
 *
 * SEMANTICA:
 *   - un ciclo è mostrato se soddisfa ALMENO UNA regola attiva  (OR fra le regole);
 *   - una regola è soddisfatta se TUTTI i suoi campi valorizzati coincidono (AND dentro la
 *     regola); un campo VUOTO nella regola significa «qualunque valore»;
 *   - NESSUNA regola attiva per il plant => NESSUNA restrizione, si vedono tutti i cicli.
 *
 * È il gemello dichiarato di srv/lib/materialVisibility.js, che fa la stessa cosa per i materiali
 * («visibile se soddisfa almeno una categoria; nessuna categoria => prendi tutto»): stessa forma,
 * stesso stile, stesse scelte sul ramo d'errore. Se cambi la semantica qui, guarda anche là.
 *
 * Consumato da:
 *   - srv/cat-service.js  READ Routings   (lista del cockpit)
 *   - srv/cat-service.js  routingListDiag (diagnostica: «perché la lista è vuota?»)
 *
 * Le funzioni pure non dipendono da `cds`, dalla rete o dal database, e hanno il proprio test:
 *     node test/routingVisibility.test.js
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

/**
 * Nome pienamente qualificato dell'entita', non `db.entities(NS)`: quello e' deprecato in CAP 9
 * (`srv.entities()` -> usare `cds.entities()`) e, soprattutto, NON e' invocabile in contesto job
 * standalone — e' la stessa ragione per cui i job usano costanti FQN (vedi E_CYCLE_OP in
 * srv/jobs/syncRoutingsToPlex.js). Con la stringa la lettura funziona in ogni contesto.
 */
const E_FILTER = 'avvaleplm.marsplm.sap2plex.ZRoutingFilterConfig';

/** I due campi che una regola confronta, nei nomi che hanno sia sulla regola sia sulla riga. */
const RULE_FIELDS = Object.freeze(['BillOfOperationsStatus', 'BillOfOperationsUsage']);

// ================================================================
// Confronto dei codici
// ================================================================

/** `trim` e nient'altro. */
function s(v) {
  return String(v ?? '').trim();
}

/**
 * Zeri iniziali rimossi. `'004'` -> `'4'`, `'000'` -> `'0'`, `''` -> `''`.
 * Solo per valori interamente numerici: su un codice alfanumerico gli zeri iniziali possono
 * essere significativi e toglierli sarebbe una modifica del valore, non una normalizzazione.
 */
function unpad(v) {
  const t = s(v);
  if (!/^\d+$/.test(t)) return t;
  return t.replace(/^0+(?=\d)/, '');
}

/**
 * Confronto TOLLERANTE fra il codice scritto in configurazione e quello che arriva da SAP.
 *
 * PERCHE' E' TOLLERANTE, E PERCHE' NON CONTRADDICE RB-05 DELLA 0015.
 * In RB-05 si vieta il `padStart` perché là si univano DUE CHIAVI SAP: allineare gli zeri
 * avrebbe mascherato un difetto a monte, facendo sembrare coerenti due letture che non lo erano.
 * Qui invece si confronta un valore SCRITTO DA UN UTENTE con un valore SAP. Stato e utilizzo sono
 * codici numerici — `'4'`, `'04'` e `'004'` sono lo stesso stato, non tre stati — e non esiste un
 * caso in cui distinguerli sia utile. Senza tolleranza, un utente che scrive `4` mentre SAP
 * restituisce `04` ottiene una lista vuota e nessun modo di capirlo: il difetto non sarebbe a
 * monte, sarebbe nostro.
 *
 * Si normalizza IL CONFRONTO, mai il dato: in tabella resta scritto quello che l'utente ha
 * digitato (vedi validateRoutingFilter, che fa solo `trim`).
 *
 * @param {*} configured valore nella regola. Vuoto = «qualunque», gestito dal chiamante
 * @param {*} actual valore sulla riga del ciclo
 * @returns {boolean}
 */
function codeMatches(configured, actual) {
  const a = s(configured);
  const b = s(actual);
  if (a === b) return true;
  return unpad(a) === unpad(b);
}

// ================================================================
// Valutazione delle regole
// ================================================================

/**
 * Una singola regola aggancia la riga?
 *
 * Un campo VUOTO nella regola è «qualunque valore» e quindi non vincola. Ne segue che una regola
 * con ENTRAMBI i campi vuoti aggancerebbe qualunque ciclo, cioè disattiverebbe l'intero filtro:
 * `validateRoutingFilter` la rifiuta alla scrittura, e qui la si rifiuta comunque — una regola
 * senza alcun criterio non è una regola, e se arrivasse (riga scritta a mano nel database, o
 * migrata da chissà dove) trasformarla in un passa-tutto silenzioso sarebbe il comportamento
 * peggiore possibile.
 *
 * @param {object} rule
 * @param {object} row riga di lista, con BillOfOperationsStatus / BillOfOperationsUsage
 * @returns {boolean}
 */
function ruleMatches(rule, row) {
  if (!rule) return false;
  const criteria = RULE_FIELDS.filter((f) => s(rule[f]) !== '');
  if (criteria.length === 0) return false; // nessun criterio: non è una regola
  return criteria.every((f) => codeMatches(rule[f], row && row[f]));
}

/**
 * La riga passa il filtro del suo plant?
 * @param {object} row
 * @param {Array<object>} rules le regole ATTIVE del plant
 * @returns {boolean} true anche quando non ci sono regole: nessuna configurazione = nessun filtro
 */
function routingPasses(row, rules) {
  if (!rules || rules.length === 0) return true;
  return rules.some((r) => ruleMatches(r, row));
}

/**
 * Applica il filtro a un insieme di righe di lista.
 *
 * Restituisce anche le COPPIE RIFIUTATE con i loro conteggi, che finiscono nel log e nella
 * diagnostica. Senza value help sui due codici, sono l'unico modo per accorgersi del caso
 * «hai configurato 4 ma i tuoi dati hanno 02»: le coppie scartate lo mostrano nero su bianco,
 * invece di lasciare una lista vuota senza spiegazione.
 *
 * @param {Array<object>} rows righe con Plant, BillOfOperationsStatus, BillOfOperationsUsage
 * @param {Map<string, Array<object>>} rulesByPlant plant -> regole attive
 * @returns {{ kept: Array<object>, stats: object }}
 */
function applyRoutingFilter(rows, rulesByPlant) {
  const all = Array.isArray(rows) ? rows : [];
  const byPlant = rulesByPlant instanceof Map ? rulesByPlant : new Map();
  const stats = {
    in: all.length,
    kept: 0,
    excluded: 0,
    plantsWithRules: [...byPlant.keys()].filter((p) => (byPlant.get(p) || []).length > 0).sort(),
    rejectedPairs: [] // [{ Plant, BillOfOperationsStatus, BillOfOperationsUsage, count }]
  };
  // Nessun plant configurato: non si tocca niente e non si costruisce nulla.
  if (stats.plantsWithRules.length === 0) {
    stats.kept = all.length;
    return { kept: all, stats };
  }

  const rejected = new Map();
  const kept = [];
  for (const row of all) {
    const plant = s(row && row.Plant);
    const rules = byPlant.get(plant) || [];
    if (routingPasses(row, rules)) { kept.push(row); continue; }
    const key = `${plant}|${s(row.BillOfOperationsStatus)}|${s(row.BillOfOperationsUsage)}`;
    const hit = rejected.get(key);
    if (hit) { hit.count++; } else {
      rejected.set(key, {
        Plant: plant,
        BillOfOperationsStatus: s(row.BillOfOperationsStatus),
        BillOfOperationsUsage: s(row.BillOfOperationsUsage),
        count: 1
      });
    }
  }
  stats.kept = kept.length;
  stats.excluded = all.length - kept.length;
  stats.rejectedPairs = [...rejected.values()].sort((a, b) => b.count - a.count);
  return { kept, stats };
}

// ================================================================
// Caricamento del customizing
// ================================================================

/** SELECT delle regole, con una `where` opzionale. */
async function _selectRules(db, where) {
  let q = SELECT.from(E_FILTER)
    .columns('Plant', 'BillOfOperationsStatus', 'BillOfOperationsUsage');
  if (where) q = q.where(where);
  return db.run(q);
}

/**
 * Tutte le regole ATTIVE, raggruppate per plant.
 *
 * Sul ramo d'errore si logga e si restituisce una mappa vuota, come fa `loadCategoryConfig` in
 * materialVisibility.js. Qui «vuoto» significa NESSUNA RESTRIZIONE, quindi una lettura fallita
 * mostra tutti i cicli invece di nasconderli: fail-OPEN, coerente con RB-04 della 0015 —
 * mostrare qualcosa in più è un fastidio che si vede, nascondere tutto è una sparizione
 * silenziosa.
 *
 * @returns {Promise<Map<string, Array>>} plant -> regole[]
 */
async function loadRoutingFilterConfig(db) {
  const map = new Map();
  try {
    const rows = await _selectRules(db, { IsActive: true });
    for (const r of rows || []) {
      const plant = s(r.Plant);
      if (!map.has(plant)) map.set(plant, []);
      map.get(plant).push(r);
    }
  } catch (e) {
    console.warn(`>>> [ROUTING-VIS] lettura del filtro cicli fallita, nessun filtro applicato: ${e.message}`);
  }
  return map;
}

/**
 * Le regole ATTIVE di un solo plant, PER I PERCORSI CHE SCRIVONO.
 *
 * A differenza di `loadRoutingFilterConfig`, questa NON decide da sola cosa fare del fallimento:
 * lo DICHIARA con `readOk`, e lascia scegliere al chiamante. Le due direzioni sono opposte di
 * proposito:
 *
 *   - la LISTA va fail-OPEN (`loadRoutingFilterConfig`): configurazione illeggibile => nessun
 *     filtro => si vede tutto. Mostrare qualcosa in piu' e' un fastidio che si vede;
 *   - i percorsi che SCRIVONO vanno fail-CLOSED: se non si e' riusciti a leggere le regole non si
 *     puo' affermare che il ciclo sia in perimetro, e scrivere su Plex sulla base di una verifica
 *     NON FATTA e' peggio che non scrivere. E' la stessa direzione di `rejectIfPlantNotUsable`,
 *     che su plant nullo o sconosciuto blocca.
 *
 * `readOk: true` con `rules` vuoto e' un caso ben diverso da `readOk: false`: significa che la
 * lettura e' riuscita e per quel plant non c'e' alcuna regola, cioe' NESSUNA RESTRIZIONE.
 *
 * @returns {Promise<{ rules: Array<object>, readOk: boolean }>}
 */
async function loadPlantRoutingFilters(plant, db) {
  if (!plant) return { rules: [], readOk: true };
  try {
    const rules = await _selectRules(db, { Plant: plant, IsActive: true });
    return { rules: rules || [], readOk: true };
  } catch (e) {
    console.error(`>>> [ROUTING-VIS] lettura del filtro cicli del plant ${plant} FALLITA:`
      + ` ${e.message} — i percorsi che scrivono si fermano`);
    return { rules: [], readOk: false };
  }
}

/** Il ciclo, in forma leggibile per i messaggi: «stato=4/uso=1». */
function describeRow(row) {
  return `stato=${s(row && row.BillOfOperationsStatus) || '(vuoto)'}`
    + `/uso=${s(row && row.BillOfOperationsUsage) || '(vuoto)'}`;
}

/** Le regole di UN plant, in forma leggibile per i messaggi. */
function describePlantRules(rules) {
  if (!rules || !rules.length) return '(nessuna regola)';
  return rules.map((r) => `stato=${s(r.BillOfOperationsStatus) || '*'}`
    + `/uso=${s(r.BillOfOperationsUsage) || '*'}`).join(' oppure ');
}

/** Riga leggibile per log e diagnostica: le regole in vigore, per plant. */
function describeRules(rulesByPlant) {
  const byPlant = rulesByPlant instanceof Map ? rulesByPlant : new Map();
  const parts = [];
  for (const plant of [...byPlant.keys()].sort()) {
    const rules = byPlant.get(plant) || [];
    if (!rules.length) continue;
    const txt = rules.map((r) => {
      const st = s(r.BillOfOperationsStatus) || '*';
      const us = s(r.BillOfOperationsUsage) || '*';
      return `stato=${st}/uso=${us}`;
    }).join(' oppure ');
    parts.push(`${plant}: ${txt}`);
  }
  return parts.length ? parts.join(' | ') : '(nessuna regola: nessun filtro)';
}

module.exports = {
  codeMatches,
  ruleMatches,
  routingPasses,
  applyRoutingFilter,
  loadRoutingFilterConfig,
  loadPlantRoutingFilters,
  describeRules,
  describeRow,
  describePlantRules,
  RULE_FIELDS,
  E_FILTER
};
