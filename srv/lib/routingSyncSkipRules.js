/**
 * [ROUTING-ORPHAN] Regole pure del perimetro del job `ROUTING_SYNC` (srv/jobs/syncRoutingsToPlex.js).
 *
 * PERCHE' ESISTE
 * Il job itera i cicli SALVATI e per ognuno deve decidere una cosa sola: si invia, oppure no e
 * perche'. Quel «perche'» era un `if` a due rami che collassava DUE cause opposte nello stesso
 * contatore muto:
 *
 *   - il plant del ciclo non e' licenziato / non e' attivo  -> normale, e' il gate di licenza;
 *   - la TESTATA SAP del ciclo non si risolve piu'          -> anomalia: qualcuno ha costruito
 *     quel ciclo, la routing in SAP non c'e' piu', e quel ciclo non partira' MAI PIU'.
 *
 * Il secondo caso finiva in `skippedInactive`, cioe' in `summary.skip()`, che e' solo un numero:
 * nessuna voce, nessun elenco, niente su cui agire. I cicli fuori perimetro — un caso MENO grave,
 * perche' li' la configurazione sta facendo il suo lavoro — avevano gia' la loro voce nel recap.
 *
 * La decisione e' verificabile senza SAP, senza Plex e senza database, quindi sta qui e non
 * nell'orchestrazione: stessa convenzione di srv/lib/routingVisibility.js e
 * srv/lib/routingMaterialRules.js. Nessuna dipendenza — ne' `cds`, ne' rete, ne' db, ne' stato
 * globale, ne' orologio. Non aggiungerne: il test si lancia con
 *     node test/routingSyncSkipRules.test.js
 *
 * Nessuna funzione muta l'input.
 *
 * QUI STA ANCHE L'INDICIZZAZIONE DEGLI INGRESSI DEL VERDETTO (`indexJoinedRoutings`), e non e'
 * un accostamento di comodo: `classifySavedCycle` decide su `plant` e `fallbackMaterial`, e chi
 * legge il verdetto deve trovare nello stesso file DA DOVE quei due valori vengono. Vengono
 * entrambi dalle righe di `routingMaterialRules.joinRoutingRows`, cioe' dalla STESSA riga di
 * testata — ed e' la proprieta' su cui l'intero perimetro cicli sta in piedi: vedi il blocco in
 * testa a `indexJoinedRoutings`.
 */

'use strict';

// ================================================================
// Verdetti
// ================================================================

/**
 * I cinque esiti possibili per un ciclo salvato. Sono stringhe e non numeri perche' finiscono nei
 * `console.log` del job: un verdetto va letto senza una legenda accanto.
 */
const VERDICT = {
  /** Il plant non e' risolvibile: testata SAP assente, oppure presente ma senza WERKS. */
  NO_HEADER: 'NO_HEADER',
  /** Plant risolto, ma non fra quelli attivi/licenziati. E' il gate di licenza, non un'anomalia. */
  INACTIVE: 'INACTIVE',
  /** Righe salvate senza materiale di testata (pre-0015): il ripiego MAPL non le raggiunge. */
  NOT_ATTRIBUTED: 'NOT_ATTRIBUTED',
  /** Nessun materiale, ne' sulla riga salvata ne' dal ripiego MAPL. */
  NO_MATERIAL: 'NO_MATERIAL',
  /** Si invia, sul materiale restituito insieme al verdetto. */
  SEND: 'SEND'
};

/** `trim` e nient'altro, come routingMaterialRules.keyPart: qui non si decide il formato di SAP. */
const clean = (v) => String(v ?? '').trim();

/** Un plant e' attivo? Accetta un `Set` (come nel job) o un array (comodo nei test). */
function isActivePlant(activePlants, plant) {
  if (!activePlants) return false;
  if (typeof activePlants.has === 'function') return activePlants.has(plant);
  return Array.isArray(activePlants) && activePlants.indexOf(plant) >= 0;
}

/**
 * Cosa fare di un ciclo salvato.
 *
 * L'ORDINE DI VALUTAZIONE E' PARTE DELLA REGOLA. Il plant si guarda per primo perche' senza di
 * lui non si sa nemmeno di CHI sia il ciclo: dire «manca il materiale» su un ciclo di cui non si
 * conosce lo stabilimento manderebbe a cercare nel posto sbagliato.
 *
 * `plant` undefined E `plant` vuoto danno lo STESSO verdetto, ed e' voluto: «la testata non c'e'»
 * e «la testata c'e' ma non dice lo stabilimento» sono due modi di non poter rispondere alla
 * domanda, e nessuno dei due e' «lo stabilimento non e' licenziato» — che e' esattamente la
 * confusione da togliere. Il chiamante li distingue gia' per costruzione, perche' scrive
 * `plantByRouting.set(k, h.Plant || '')` solo quando la testata l'ha vista.
 *
 * NOT_ATTRIBUTED E' UN RISPARMIO, NON UNA RESTRIZIONE. Con `headerMaterial` vuoto le righe salvate
 * stanno sotto `''`, mentre il ripiego MAPL propone un materiale X — e l'action cerca l'albero
 * PER MATERIALE. I due soli esiti possibili erano: nessuna riga sotto X, quindi
 * `400 No Plex operations` a ogni esecuzione e per sempre (nessun log => nessuna testata =>
 * `needsSend()` ripesca); oppure — ciclo backfillato a meta' — le righe di X, che sono gia'
 * inviate dalla loro entrata, quindi un doppione. In entrambi i casi le righe a `''` restano dove
 * sono e il rimedio e' uno solo: il backfill.
 *
 * @param {object}   args
 * @param {string}   [args.plant]            cio' che ha restituito `plantByRouting.get(key)`
 * @param {Set|Array}[args.activePlants]     i plant attivi/licenziati
 * @param {string}   [args.headerMaterial]   `ZPlexRoutingCycleOperation.HeaderMaterial`
 * @param {string}   [args.fallbackMaterial] il primo materiale MAPL del ciclo, se noto
 * @returns {{verdict: string, material: string}} `material` valorizzato solo su `SEND`
 */
function classifySavedCycle({ plant, activePlants, headerMaterial, fallbackMaterial } = {}) {
  const p = clean(plant);
  if (!p) return { verdict: VERDICT.NO_HEADER, material: '' };
  if (!isActivePlant(activePlants, p)) return { verdict: VERDICT.INACTIVE, material: '' };

  const own = clean(headerMaterial);
  if (own) return { verdict: VERDICT.SEND, material: own };

  const fallback = clean(fallbackMaterial);
  if (fallback) return { verdict: VERDICT.NOT_ATTRIBUTED, material: '' };
  return { verdict: VERDICT.NO_MATERIAL, material: '' };
}

/**
 * I cicli orfani si dichiarano nel recap?
 *
 * QUESTA E' LA FUNZIONE CHE ROMPE IN SILENZIO, ED E' PER LEI CHE IL MODULO HA UN TEST. Se la
 * lettura delle testate e' fallita, `plantByRouting` resta VUOTA e OGNI ciclo esce `NO_HEADER`:
 * la voce direbbe «N cicli non esistono piu' in SAP» quando la verita' e' «non l'ho potuto
 * sapere», e il run indicherebbe come da ripulire l'intero archivio dei cicli. Quel caso ha gia'
 * la sua voce (`logRoutingHeaderReadFailed`, status 'E'), che dice la cosa giusta.
 *
 * E' la stessa regola di `remoteKnown` in [PART-ALIVE] (DEC-112) e del flag «ho letto il remoto»
 * in [WC-SUBTRACT] (DEC-78): **vuoto non e' ignoto**.
 *
 * Il confronto e' `=== true` e non `!!`: un chiamante che si dimentica di passare `headersOk`
 * riceve `undefined`, e `undefined` non deve valere «la lettura e' andata bene».
 *
 * @param {object}  args
 * @param {boolean} [args.headersOk] la lettura di ProductionRoutingHeader e' riuscita?
 * @param {number}  [args.count]     quanti cicli sono usciti NO_HEADER
 * @returns {boolean}
 */
function declaresOrphans({ headersOk, count } = {}) {
  return headersOk === true && Number(count) > 0;
}

// ================================================================
// Gli ingressi del verdetto
// ================================================================

/** La chiave di default: (gruppo, contatore). Il chiamante puo' iniettare la propria. */
const defaultKey = (group, routing) => `${clean(group)}|${clean(routing)}`;

/**
 * [ROUTING-PLANT] Le tre mappe di contesto del job, dalle righe di
 * `routingMaterialRules.joinRoutingRows`.
 *
 * PLANT E TESTATA NASCONO DALLA STESSA RIGA, ED E' L'INVARIANTE CHE TIENE IN PIEDI IL PERIMETRO.
 * Il gate del perimetro cicli e' `routingPasses(headerByRouting.get(k) || {}, scopeRules.get(plant)
 * || [])`. Se il plant venisse da una lettura e la testata da un'altra, un plant risolto senza la
 * sua testata darebbe `scopeRules.get(plant)` valorizzato e riga `{}` — fail-closed, il ciclo
 * esce fuori perimetro senza esserlo — e, peggio, un plant NON risolto ma non vuoto (o che non
 * combacia con la chiave del customizing) darebbe `|| []`, cioe' `routingPasses` a `true`: il
 * perimetro EVAPORA in silenzio e il ciclo parte senza che nessuna regola lo abbia valutato.
 * `joinRoutingRows` emette una riga solo per testate esistenti, non cancellate e in perimetro
 * plant, e la riga porta insieme `Plant`, `BillOfOperationsStatus` e `BillOfOperationsUsage`:
 * finche' le tre mappe si popolano DA QUI, i due casi non possono nascere.
 *
 * `headerByRouting` contiene la RIGA, non la testata originale: e' la forma che `routingPasses` e
 * `describeRow` consumano gia' (test/routingVisibility.test.js e' scritto su quella forma).
 *
 * IL MATERIALE DI RIPIEGO ESCLUDE LE RIGHE A MATERIALE VUOTO. Con `keepUnassigned: true`
 * `joinRoutingRows` emette una riga a `Material: ''` per i cicli che in `MAPL` non compaiono
 * affatto: se entrasse nell'elenco, il ripiego proporrebbe la stringa vuota come materiale e il
 * verdetto `NO_MATERIAL` — che e' quello giusto — diventerebbe `NOT_ATTRIBUTED`, mandando a
 * eseguire un backfill che non ha niente da attribuire. L'ordinamento serve a rendere il ripiego
 * riproducibile fra due esecuzioni, come nella versione che leggeva `MAPL` da se'.
 *
 * @param {Array<object>} rows righe di `joinRoutingRows` (ProductionRoutingGroup,
 *   ProductionRouting, Material, Plant, BillOfOperationsStatus, BillOfOperationsUsage, ...)
 * @param {function(*, *): string} [makeKey] costruttore della chiave, iniettato perche' il modulo
 *   non ha dipendenze e la chiave non deve avere due definizioni
 * @returns {{plantByRouting: Map<string,string>, headerByRouting: Map<string,object>,
 *          materialByRouting: Map<string,string>}}
 */
function indexJoinedRoutings(rows, makeKey = defaultKey) {
  const plantByRouting = new Map();
  const headerByRouting = new Map();
  const materialByRouting = new Map();
  const materials = new Map();

  for (const row of rows || []) {
    if (!row) continue;
    const k = makeKey(row.ProductionRoutingGroup, row.ProductionRouting);
    // La PRIMA riga vince, come `dedupeHeaders`: le righe di uno stesso ciclo differiscono per il
    // solo materiale, i campi di testata sono gli stessi per costruzione.
    if (!headerByRouting.has(k)) {
      headerByRouting.set(k, row);
      plantByRouting.set(k, clean(row.Plant));
    }
    const material = clean(row.Material);
    if (!material) continue;
    if (!materials.has(k)) materials.set(k, []);
    materials.get(k).push(material);
  }
  for (const [k, list] of materials) materialByRouting.set(k, list.slice().sort()[0]);

  return { plantByRouting, headerByRouting, materialByRouting };
}

module.exports = {
  VERDICT, classifySavedCycle, declaresOrphans, isActivePlant, indexJoinedRoutings
};
