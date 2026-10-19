/**
 * [ROUTING-COMP-SOURCE] Regole pure della sorgente componenti del ciclo (feature 0025).
 *
 * COSA DECIDONO QUESTE REGOLE
 * Il job dei cicli costruisce l'elenco dei componenti da mandare a Plex da DUE letture di SAP —
 * l'assegnazione componente-operazione del ciclo, come da sempre, e la distinta del materiale di
 * testata letta a una data di riferimento — e poi decide, componente per componente, su quale
 * operazione collocarlo. Qui c'e' tutto cio' che quella decisione ha di verificabile senza SAP,
 * senza Plex e senza database: la fusione delle due letture, la precedenza fra provenienza
 * automatica e manuale, la risoluzione dell'operazione di destinazione e il verdetto di blocco.
 * L'orchestrazione — le letture, la persistenza, l'invio — sta in srv/lib/routingCompSource.js e
 * nell'azione di sincronizzazione del ciclo.
 *
 * TRE REGOLE CHE VANNO INSIEME, E IL PERCHE'
 *
 * 1. LA PRIMA LETTURA VINCE SULLA SECONDA. Un componente presente in entrambe conserva la
 *    quantita', l'unita' e il nodo di distinta della lettura del CICLO. La seconda lettura e' a
 *    una data lontana nel futuro e serve a scoprire cosa ESISTERA': prendere da li' la quantita'
 *    di un componente che esiste gia' oggi significherebbe mandare in fabbrica il numero di
 *    domani per un pezzo che si consuma adesso. La seconda lettura AGGIUNGE, non corregge.
 *
 * 2. LA PROVENIENZA VINCE SULLA REGOLA, IN UNA SOLA DIREZIONE. Se una riga salvata dice che
 *    quel componente e' stato collocato a mano, quella collocazione resta e la regola non viene
 *    nemmeno interrogata. Il contrario non vale: una riga automatica viene spostata senza
 *    esitazione appena la regola cambia idea, ed e' esattamente il difetto che la 0025 corregge.
 *
 * 3. UN SOLO COMPONENTE SENZA OPERAZIONE FERMA TUTTO IL CICLO. Non e' una degradazione: e' un
 *    blocco. `planCycleComponents` non decide da sola di non inviare — restituisce l'elenco dei
 *    bloccati e il chiamante si ferma — ma qui c'e' la definizione di cosa conta come blocco, e
 *    comprende un caso che prima passava in silenzio: l'operazione che la regola nomina ma che
 *    nel ciclo non esiste (`NO_OPERATION`). Prima era un contatore, `skippedNoOp`, e il
 *    componente semplicemente non arrivava in fabbrica.
 *
 * PERCHE' IL BLOCCO NON DISTINGUE FRA I MOTIVI. «Nessun gruppo aggancia» e «la classificazione
 * non si e' potuta leggere» sono due cose diversissime da riparare, e infatti il motivo viene
 * riportato per ogni componente; ma nessuna delle due autorizza a mandare a Plex un ciclo
 * incompleto, perche' un componente che non arriva in fabbrica non si vede da nessuna parte —
 * ne' su Plex, dove non c'e', ne' nel ciclo, dove non e' mai entrato. E' la stessa direzione di
 * DEC-52: dove si SCRIVE verso un sistema esterno, cio' che non si e' potuto verificare non
 * passa.
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' database. Test: node test/routingCompSourceRules.test.js
 * Perimetro: `grep -rn "ROUTING-COMP-SOURCE"`.
 */

'use strict';

// ================================================================
// [COMP-SOURCE] Il vocabolario della provenienza sta in srv/lib/compSourceRules.js (feature 0036).
//
// `ORIGIN` e `normalizeOrigin` erano definite qui e sono uscite quando l'albero dell'ORDINE ha
// avuto la sua colonna `AssignmentSource`: la domanda «questa collocazione l'ha decisa una
// persona?» e' la stessa sui due alberi, e il divieto dichiarato piu' sotto in questo file — mai
// una SECONDA decisione su cosa e' automatico — vale fra i due alberi come vale fra codice e SQL.
//
// SI RI-ESPORTANO INVARIATE, e non per comodita': test/routingCompSourceRules.test.js le importa
// ancora da questo modulo e deve passare senza una modifica. E' la prova che lo spostamento non ha
// cambiato comportamento.
// ================================================================
const compSource = require('./compSourceRules');

// ================================================================
// Costanti
// ================================================================

/** I due valori di `ZPlexRoutingCycleComponent.AssignmentSource`. [COMP-SOURCE] */
const ORIGIN = compSource.ORIGIN;

/** Da dove viene un componente dell'elenco desiderato: serve solo a dichiarare, non a decidere. */
const SOURCE = Object.freeze({ CYCLE: 'CYCLE', BOM: 'BOM' });

/**
 * I motivi per cui un componente resta senza operazione. I primi quattro arrivano
 * dall'auto-assegnazione (`resolveAutoAssignments`), il quinto nasce qui.
 */
const BLOCK_REASON = Object.freeze({
  /** Nessun gruppo oggetto del plant aggancia il componente. E' l'esito «normale». */
  NO_GROUP: 'NO_GROUP',
  /** Il gruppo aggancia, ma non esiste la riga gruppo -> operazione per questo materiale. */
  NO_MAPPING: 'NO_MAPPING',
  /** La classificazione prodotto non e' stata letta: le condizioni CLASS non sono state valutate. */
  NO_CLFN: 'NO_CLFN',
  /** Del componente non e' arrivato nemmeno il dato di stabilimento. */
  NO_PLANT_DATA: 'NO_PLANT_DATA',
  /** La regola nomina un'operazione che nel ciclo salvato non esiste. */
  NO_OPERATION: 'NO_OPERATION',
  /**
   * L'elenco desiderato e' VUOTO mentre il ciclo ha gia' componenti automatici.
   *
   * Non e' un componente che manca: e' la lettura di SAP che non ha portato niente, e riscrivere
   * su quel niente svuoterebbe il ciclo. Le due cose sono indistinguibili — un iFlow interrogato
   * con un criterio che non gli basta risponde `200` con zero righe, esattamente come risponde
   * quando i dati davvero non ci sono (DEC-49) — quindi non si sceglie: ci si ferma e lo si dice.
   * Un ciclo che perde tutti i componenti in silenzio e' il danno peggiore che questa feature
   * potrebbe fare, perche' su Plex non si rimuove nulla e la divergenza si scoprirebbe in
   * fabbrica.
   */
  EMPTY_SOURCE: 'EMPTY_SOURCE',
  /**
   * [ROUTING-DEFAULT-OP] La distinta scelta come sorgente non ha dato componenti (feature 0051).
   *
   * E' il gemello di `EMPTY_SOURCE` per l'altra sorgente, e serve perche' quello NON SCATTA in
   * questo caso: la sua guardia e' `!seen.size && autoReplacedIds.length > 0`, cioe' pretende che
   * il ciclo abbia gia' righe automatiche salvate. Su un ciclo al primo invio — o ri-salvato dal
   * cockpit con le sole operazioni — `autoReplacedIds` e' vuoto, e un elenco desiderato vuoto
   * passerebbe il gate: il ciclo parte, le operazioni si creano su Plex, il passo distinta non ha
   * niente da mandare, e il recap lo conta fra i RIUSCITI.
   *
   * Non aiuta nemmeno l'errore: `listBomComponents` rende `noBom: true` con `error: ''`, quindi
   * «questo materiale non ha una distinta» arriva a valle nella stessa forma di «la distinta e'
   * vuota», che e' la forma di «tutto bene, zero righe». Qui si SCRIVE verso la fabbrica (DEC-52):
   * cio' che non si e' potuto verificare non passa.
   *
   * Vale SOLO con l'allocazione dichiarata accesa: a interruttore spento la sorgente e' PLMZ e una
   * distinta vuota non e' un fatto che riguardi l'elenco dei componenti.
   */
  NO_BOM: 'NO_BOM'
});

/** Le due parole chiave che l'auto-assegnazione puo' restituire al posto di un'operazione. */
const FIRST_OP = 'FIRST_OP';
const LAST_OP = 'LAST_OP';

/** Passo della numerazione dei componenti dentro un'operazione, come da sempre nel progetto. */
const SEQUENCE_STEP = 10;

// ================================================================
// Normalizzazioni
// ================================================================

/** Stringa spogliata: `null`/`undefined` diventano stringa vuota, mai `'null'`. */
function str(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

/**
 * La provenienza di una riga salvata.
 *
 * [COMP-SOURCE] Definita in srv/lib/compSourceRules.js e ri-esportata qui: e' la stessa domanda sui
 * due alberi, e vale ancora la sua regola — VUOTO = 'AUTO', che e' una scelta e non una svista,
 * perche' una riga senza provenienza dichiarata e' governata dalle regole; con il ripiego opposto la
 * feature non avrebbe effetto su nulla di cio' che esiste gia', cioe' non avrebbe effetto.
 * @param {*} v
 * @returns {'AUTO'|'MANUAL'}
 */
const normalizeOrigin = compSource.normalizeOrigin;

/**
 * La data di riferimento della seconda lettura, dal customizing.
 *
 * NON INVENTA UNA DATA. Un valore illeggibile torna `null`, cioe' «seconda lettura spenta»: e'
 * il comportamento di prima della 0025, ed e' l'unico ripiego che non cambia in silenzio il
 * perimetro di cio' che arriva in fabbrica. Il chiamante DICHIARA quando questo accade, perche'
 * una data scritta male e una data non scritta si vedono uguali.
 *
 * Accetta la forma `YYYY-MM-DD` che CAP restituisce per un campo `Date`, un oggetto `Date`, e un
 * timestamp ISO completo (di cui prende il giorno).
 * @param {*} v
 * @returns {Date|null}
 */
function normalizeKeyDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** La data di riferimento in forma leggibile, per i messaggi. Vuota se non c'e'. */
function keyDateLabel(date) {
  return date instanceof Date && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10) : '';
}

// ================================================================
// Fusione delle due letture
// ================================================================

/**
 * L'elenco desiderato dei componenti, dalle due letture.
 *
 * La prima lettura passa INTATTA — comprese le righe con lo stesso materiale su operazioni
 * diverse, che l'auto-assegnazione fondera' da se' — e la seconda contribuisce i soli materiali
 * che la prima non ha. Vedi la regola 1 in testa al file.
 *
 * `_source` viene attaccato a ogni riga per un motivo solo: dire nel recap QUANTI componenti sono
 * arrivati dalla seconda lettura. Senza quel numero, un perimetro allargato dalla data e un
 * perimetro allargato per errore sono la stessa cosa a schermo.
 *
 * @param {Array<object>} cycleComponents componenti dall'assegnazione del ciclo (gia' preparati)
 * @param {Array<object>} bomComponents componenti dalla distinta alla data (gia' preparati)
 * @returns {{ components: Array<object>, stats: { cycle: number, bom: number, added: number,
 *           total: number, addedMaterials: Array<string> } }}
 */
function mergeComponentSources(cycleComponents, bomComponents) {
  const fromCycle = (Array.isArray(cycleComponents) ? cycleComponents : []).filter((c) => c && str(c.Material));
  const fromBom = (Array.isArray(bomComponents) ? bomComponents : []).filter((c) => c && str(c.Material));

  const seen = new Set(fromCycle.map((c) => str(c.Material)));
  const components = fromCycle.map((c) => ({ ...c, _source: SOURCE.CYCLE }));
  const addedMaterials = [];

  for (const c of fromBom) {
    const material = str(c.Material);
    if (seen.has(material)) continue;   // regola 1: la prima lettura vince
    seen.add(material);
    addedMaterials.push(material);
    components.push({ ...c, _source: SOURCE.BOM });
  }

  return {
    components,
    stats: {
      cycle: fromCycle.length,
      bom: fromBom.length,
      added: addedMaterials.length,
      total: components.length,
      addedMaterials
    }
  };
}

// ================================================================
// Risoluzione dell'operazione
// ================================================================

/**
 * L'operazione di destinazione, dal valore che il customizing dichiara.
 *
 * Le operazioni sono quelle SALVATE NELLE NOSTRE TABELLE, non quelle lette da Plex: e' li' che
 * vive il ciclo che stiamo per inviare, e un'operazione appena creata nel cockpit su Plex non
 * esiste ancora. Vanno passate gia' ordinate per numero, perche' `FIRST_OP` e `LAST_OP` si
 * risolvono per posizione.
 *
 * IL CONFRONTO E' STRETTO su `PlexOperationId`, che e' un identificativo, e TOLLERANTE su
 * `OperationCode`, che una persona ha digitato nella scheda di auto-assegnazione (DEC-51).
 *
 * @param {string} target `FIRST_OP` | `LAST_OP` | un codice o un id di operazione
 * @param {Array<object>} operations operazioni del ciclo, ordinate per numero
 * @returns {object|null} l'operazione, oppure `null` se non esiste nel ciclo
 */
function resolveTargetOperation(target, operations) {
  const ops = Array.isArray(operations) ? operations.filter(Boolean) : [];
  if (!ops.length) return null;
  const want = str(target);
  if (!want) return null;
  if (want === FIRST_OP) return ops[0];
  if (want === LAST_OP) return ops[ops.length - 1];
  const byId = ops.find((op) => str(op.PlexOperationId) === want);
  if (byId) return byId;
  const wantU = want.toUpperCase();
  return ops.find((op) => str(op.OperationCode).toUpperCase() === wantU) || null;
}

// ================================================================
// [ROUTING-DEFAULT-OP] L'allocazione DICHIARATA invece che chiesta (feature 0051)
// ================================================================

/**
 * I due bersagli ammessi di `ZPhantomExplodeConfig.RoutingCompDefaultOpTarget`.
 *
 * Sono le STESSE due parole di `ZCycleAutoAssignConfig.PlexOperation`, dichiarate qui sopra: la
 * domanda «prima o ultima operazione?» e' la stessa, e chiamarle diversamente farebbe credere che
 * siano un'altra cosa. Il fatto che le due tabelle le usino su DUE alberi diversi — SAP qui, Plex
 * la'  — non cambia il vocabolario.
 */
const DEFAULT_OP_TARGETS = Object.freeze([FIRST_OP, LAST_OP]);

/** Perche' l'allocazione dichiarata non e' in vigore. `ON` = lo e'. */
const DEFAULT_OP_STATE = Object.freeze({
  /** L'interruttore e' spento: si usa la component allocation, come sempre. */
  OFF: 'OFF',
  /** Acceso, ma nessun bersaglio scelto. */
  NO_TARGET: 'NO_TARGET',
  /** Acceso con un bersaglio che non e' ne' FIRST_OP ne' LAST_OP. */
  BAD_TARGET: 'BAD_TARGET',
  /** In vigore. */
  ON: 'ON'
});

/**
 * L'allocazione dichiarata e' in vigore su questo plant?
 *
 * ACCESO SENZA UN BERSAGLIO VALIDO VALE SPENTO, E NON `FIRST_OP`. E' la regola che giustifica
 * l'esistenza di questa funzione: un ripiego silenzioso sulla prima operazione metterebbe OGNI
 * componente di OGNI ciclo del plant sull'operazione sbagliata, senza un errore da nessuna parte —
 * l'albero e' pieno, il ciclo parte, Plex accetta, e la cosa si scopre in fabbrica. Preferire il
 * comportamento storico e' l'unico ripiego che non inventa una decisione che nessuno ha preso.
 *
 * Il motivo esce insieme al verdetto perche' i tre «non in vigore» hanno rimedi diversi e chi
 * guarda deve poterli distinguere: `OFF` e' una scelta, gli altri due sono configurazione a meta'.
 *
 * @param {object} config configurazione normalizzata da `bomExplodeRules.normalizeConfig`
 * @returns {{ on: boolean, target: string, state: string }} `target` vuoto quando `on` e' falso
 */
function compDefaultOp(config) {
  const c = config || {};
  if (c.RoutingCompDefaultOp !== true) {
    return { on: false, target: '', state: DEFAULT_OP_STATE.OFF };
  }
  const target = str(c.RoutingCompDefaultOpTarget).toUpperCase();
  if (!target) return { on: false, target: '', state: DEFAULT_OP_STATE.NO_TARGET };
  if (!DEFAULT_OP_TARGETS.includes(target)) {
    return { on: false, target, state: DEFAULT_OP_STATE.BAD_TARGET };
  }
  return { on: true, target, state: DEFAULT_OP_STATE.ON };
}

/**
 * La validazione in scrittura dei due campi, nella forma di `bomExplodeRules.validateConfig`.
 *
 * Sta qui e non la' per non dichiarare una terza volta le due parole chiave: `bomExplodeRules` non
 * ha dipendenze, ed e' una proprieta' che vale la pena non rompere. L'handler chiama entrambe.
 *
 * Il bersaglio si pretende SOLO a interruttore acceso: una scheda in cui si spegne la spunta senza
 * svuotare la tendina non deve diventare non salvabile.
 *
 * @param {object} row la riga in scrittura, gia' fusa con l'esistente
 * @returns {Array<{key: string, args: Array, field: string}>}
 */
function validateCompDefaultOp(row) {
  const errors = [];
  const r = row || {};
  if (r.RoutingCompDefaultOp !== true) return errors;
  const target = str(r.RoutingCompDefaultOpTarget).toUpperCase();
  if (!target) {
    errors.push({ key: 'phxDefaultOpTargetMandatory', args: [], field: 'RoutingCompDefaultOpTarget' });
  } else if (!DEFAULT_OP_TARGETS.includes(target)) {
    errors.push({
      key: 'phxDefaultOpTargetInvalid',
      args: [str(r.RoutingCompDefaultOpTarget), DEFAULT_OP_TARGETS.join(', ')],
      field: 'RoutingCompDefaultOpTarget'
    });
  }
  return errors;
}

/**
 * Le operazioni SAP di un ciclo, ordinate.
 *
 * L'ordine e' `(ProductionRoutingSequence, Operation, ProductionRoutingOpIntID)`, tutti e tre come
 * STRINGHE: sono NUMC zero-riempiti, quindi il confronto lessicografico coincide con quello
 * numerico, e non si converte a numero per la stessa ragione di DEC-51 — fra chiavi SAP il
 * confronto e' stretto, e un `Number()` su un customizing non standard darebbe `NaN` silenzioso.
 *
 * NON FILTRA NIENTE e non muta l'input: serve sia a scegliere l'ancora sia a rendere la READ delle
 * operazioni in un ordine stabile, e quella deve mostrare il ciclo INTERO. Il filtro alla sequenza
 * principale e' in `pickAnchorOperation`, dove la domanda e' un'altra.
 *
 * @param {Array<object>} operations
 * @returns {Array<object>} una copia ordinata
 */
function sortSapOperations(operations) {
  const ops = (Array.isArray(operations) ? operations : []).filter(Boolean);
  return ops.slice().sort((a, b) => {
    const s = str(a.ProductionRoutingSequence).localeCompare(str(b.ProductionRoutingSequence));
    if (s !== 0) return s;
    const o = str(a.Operation).localeCompare(str(b.Operation));
    if (o !== 0) return o;
    return str(a.ProductionRoutingOpIntID).localeCompare(str(b.ProductionRoutingOpIntID));
  });
}

/**
 * L'operazione SAP a cui appendere tutti i componenti letti dalla distinta.
 *
 * SI GUARDA LA SOLA SEQUENZA MINIMA PRESENTE, che in un ciclo standard e' la sequenza principale.
 * «Ultima operazione» calcolata sull'unione di tutte le sequenze cadrebbe in coda al ramo
 * ALTERNATIVO o PARALLELO con il numero di sequenza piu' alto, che non e' la fine del ciclo: un
 * risultato che sembra giusto e non lo e'. Limite dichiarato: i rami paralleli sono ignorati, e un
 * componente che in SAP apparterrebbe a uno di essi finisce comunque sulla principale.
 *
 * `null` = nessuna operazione utilizzabile. Non si ripiega su niente: il chiamante torna alla
 * component allocation e lo dichiara. Un ciclo senza operazioni non ha una «prima».
 *
 * @param {Array<object>} operations operazioni SAP, in qualunque ordine
 * @param {string} target `FIRST_OP` | `LAST_OP`
 * @returns {object|null}
 */
function pickAnchorOperation(operations, target) {
  const ops = sortSapOperations(operations);
  if (!ops.length) return null;
  const want = str(target).toUpperCase();
  if (!DEFAULT_OP_TARGETS.includes(want)) return null;

  // La sequenza minima e' la prima dell'ordinamento: `sortSapOperations` ordina per sequenza per
  // primo. Si filtra invece di prendere `ops[0]`/`ops[ops.length-1]` perche' `LAST_OP` deve essere
  // l'ultima DELLA PRINCIPALE, non l'ultima in assoluto.
  const mainSeq = str(ops[0].ProductionRoutingSequence);
  const main = ops.filter((op) => str(op.ProductionRoutingSequence) === mainSeq);
  if (!main.length) return null;
  return want === FIRST_OP ? main[0] : main[main.length - 1];
}

/**
 * Da posizioni di distinta a righe nella forma di `ProductionRoutingCompAlloc`.
 *
 * SI SINTETIZZANO RIGHE DI ASSEGNAZIONE, non componenti, ed e' la decisione che tiene in piedi
 * tutto il resto: cosi' `routingComponentsOf`, `prepareRoutingComponents`,
 * `buildDesiredRoutingComponents` ed `explodeAllocRows` non cambiano di una riga, e il client — che
 * raggruppa per `ProductionRoutingOpIntID` — nemmeno. Il prezzo e' che questa funzione deve
 * comporre la riga per INTERO: con uno spread di un oggetto che non esiste (`_alloc`) uscirebbero
 * righe senza chiave, e l'albero a schermo apparirebbe VUOTO senza un errore.
 *
 * `BillOfMaterial` e il nodo sono i due agganci che fanno funzionare il resto della catena senza
 * modifiche: `applyBomQuantities` indicizza su `<distinta>|<nodo>` e `buildPhantomIndex` riconosce
 * i fantasma sulla stessa chiave. Vengono dalla distinta che `chooseBom` ha scelto, cioe' la STESSA
 * che quei due indicizzano — e' per quello che l'esplosione continua a funzionare identica.
 *
 * LA CHIAVE E' `B<nodo>`, e la lettera non e' decorativa: `ProdnRtgOpBOMItemInternalID` e' chiave
 * OData e deve essere unica. `STLKN` e' unico DENTRO una distinta e qui la distinta e' una sola,
 * quindi il nodo basta; la `B` dichiara la riga come sintetica in un dump, come i `<nodo>.<n>` dei
 * figli dei fantasma dichiarano la loro. Il ripiego `B#<i>` vale per il canale che non rendesse il
 * nodo: e' posizionale e quindi instabile fra due letture, ma senza nodo non c'e' niente di stabile
 * da usare — e `#` non e' una cifra, quindi non puo' collidere con un `B<nodo>` vero.
 *
 * Quantita' e unita' nascono di RIPIEGO, come nelle altre due sorgenti: le riempie subito dopo
 * `prepareRoutingComponents` con i valori veri della distinta. Non si copia `row.Quantity` qui —
 * sarebbe la quantita' per l'intera quantita' base della testata, non per un pezzo.
 *
 * @param {object} args
 * @param {Array<object>} args.rows righe normalizzate da `bomExplodeRules.normalizeRow`
 * @param {object} args.anchor l'operazione da `pickAnchorOperation`
 * @param {object} args.bom la testata scelta da `chooseBom`
 * @param {string} args.headerMaterial materiale di TESTATA del ciclo
 * @param {string} args.group
 * @param {string} args.routing
 * @param {*} args.defaultQuantity ripiego quantita' (`DEFAULT_COMP_QTY` del chiamante)
 * @param {string} args.defaultUnit ripiego unita'
 * @returns {Array<object>}
 */
function allocRowsFromBom(args) {
  const {
    rows = [], anchor = null, bom = null, headerMaterial = '', group = '', routing = '',
    defaultQuantity = 1, defaultUnit = ''
  } = args || {};
  if (!anchor) return [];

  const out = [];
  let fallbackKey = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const material = str(r && r.Material);
    if (!material) continue;
    const node = str(r && r.ItemNode);
    fallbackKey += 1;
    out.push({
      ProductionRoutingGroup: str(group),
      ProductionRouting: str(routing),
      ProductionRoutingSequence: str(anchor.ProductionRoutingSequence),
      ProductionRoutingOpIntID: str(anchor.ProductionRoutingOpIntID),
      ProdnRtgOpBOMItemInternalID: node ? `B${node}` : `B#${fallbackKey}`,
      BillOfMaterialComponent: material,
      BillOfMaterialItemNodeNumber: node || null,
      BillOfMaterialItemQuantity: defaultQuantity,
      BillOfMaterialItemUnit: defaultUnit,
      BillOfMaterial: str(bom && bom.BillOfMaterial),
      BillOfMaterialCategory: str(bom && bom.BillOfMaterialCategory),
      BillOfMaterialVariant: str(bom && bom.BillOfMaterialVariant),
      // L'attribuzione al materiale e' certa PER COSTRUZIONE: questa e' la sua distinta. Il
      // fail-open dichiarato di [ROUTING-BY-MATERIAL] — albero indistinto, `Material` vuoto — su
      // questa sorgente non e' nemmeno raggiungibile.
      Material: str(headerMaterial),
      // Non lo porta la distinta e sul ramo cicli nessuno lo legge. `null` e non `false`: sarebbe
      // un'affermazione, e qui non sappiamo.
      MatlCompIsMarkedForBackflush: null,
      PhantomSource: '',
      PhantomPath: ''
    });
  }
  return out;
}

// ================================================================
// Il piano
// ================================================================

/**
 * Le righe componente che il ciclo deve avere, e i componenti che lo bloccano.
 *
 * NON SCRIVE E NON DECIDE DI NON INVIARE: restituisce il piano e l'elenco dei bloccati. Chi
 * chiama guarda `blocked.length` e si ferma. Questa separazione e' cio' che rende il blocco
 * collaudabile senza SAP e senza Plex.
 *
 * COSA SUCCEDE ALLE RIGHE SALVATE
 *   - manuale     -> resta esattamente com'e' (stessa riga, stesso id, stessa operazione), e il
 *                    suo materiale NON viene sottoposto alla regola: non puo' bloccare;
 *   - automatica  -> viene ricalcolata. Se la regola la manda altrove, si sposta e lo si dichiara;
 *   - non piu' desiderata -> semplicemente non compare fra le righe nuove. La riga locale sparisce
 *                    al riscrivere; su Plex resta, e per scelta esplicita non si rimuove nulla.
 *
 * [COMP-ORPHAN] E LA PROTEZIONE DELLA MANUALE VALE FINCHE' IL COMPONENTE ESISTE (0037). La terza
 * riga qui sopra descriveva solo le AUTO, perche' sono le sole cancellate: una riga MANUALE il cui
 * materiale era sparito da `desired` non veniva nemmeno visitata, restava nel database per sempre e
 * veniva RIINVIATA a Plex a ogni giro (l'elenco che parte e' una SELECT fresca di tutto lo scope).
 * Ora le manuali si dividono in `manualKept` e `manualDropped`, e il criterio e' l'appartenenza a
 * `desired`: lo STESSO insieme da cui le automatiche vengono riscritte. Simmetria, non una seconda
 * regola.
 *
 * La potatura e' subordinata a `sourceComplete`, che il chiamante passa e il cui DEFAULT E' `false`:
 * senza una dichiarazione esplicita non si cancella niente, cioe' il comportamento di prima. Il
 * perche' e' in testa a `pruneOrphans` (srv/lib/compSourceRules.js): l'errore qui e' distruttivo e
 * asimmetrico — una riga automatica cancellata per sbaglio torna al run successivo, una manuale
 * cancellata per sbaglio e' una decisione umana persa.
 *
 * LA NUMERAZIONE RIPARTE DALLE MANUALI. Le righe automatiche di un'operazione si numerano DOPO
 * quelle manuali gia' presenti su quella stessa operazione, o due righe della stessa operazione
 * finirebbero con la stessa sequenza.
 *
 * @param {object} args
 * @param {Array<object>} args.desired elenco desiderato, da `mergeComponentSources`
 * @param {Array<object>} args.stored righe gia' salvate del ciclo di QUESTO materiale
 * @param {Array<object>} args.operations operazioni del ciclo, ordinate per numero
 * @param {Array<object>} args.assignments da `resolveAutoAssignments`
 * @param {Array<object>} args.unassigned da `resolveAutoAssignments`
 * @param {boolean} [args.sourceComplete=false] [COMP-ORPHAN] `true` = l'elenco `desired` e' la
 *   fotografia COMPLETA di cio' che SAP ha, quindi un materiale che non c'e' e' un'assenza
 *   DIMOSTRATA e la sua riga manuale si pota. `false` (default) = non si pota niente.
 * @returns {{ rows: Array<object>, manualKept: Array<object>, autoReplacedIds: Array<string>,
 *            manualDropped: Array<object>, manualDroppedIds: Array<string>, pruned: boolean,
 *            blocked: Array<object>, moved: Array<object>, counts: object }}
 */
function planCycleComponents(args) {
  const {
    desired = [], stored = [], operations = [], assignments = [], unassigned = [],
    sourceComplete = false
  } = args || {};

  const ops = Array.isArray(operations) ? operations.filter(Boolean) : [];
  const storedRows = Array.isArray(stored) ? stored.filter(Boolean) : [];

  // ================================================================
  // [COMP-ORPHAN] I materiali che SAP ha, con la STESSA chiave di confronto usata qui sotto per
  // decidere «questo materiale e' manuale» (`str`: trim, confronto stretto — fra due chiavi SAP gli
  // zeri iniziali non si allineano, DEC-51). Due chiavi diverse sullo stesso oggetto potrebbero
  // potare una riga che il confronto di sotto tiene.
  // ================================================================
  const desiredKeys = new Set();
  for (const c of (Array.isArray(desired) ? desired : [])) {
    const m = str(c && c.Material);
    if (m) desiredKeys.add(m);
  }

  // Le righe manuali, per materiale. Un materiale con almeno una riga manuale e' manuale: le sue
  // righe restano tutte, anche se sono piu' d'una su operazioni diverse.
  // [COMP-ORPHAN] ...ma solo se il componente esiste ancora in SAP: le altre si potano. I due
  // guardiani (insieme non utilizzabile, insieme vuoto) stanno dentro `pruneOrphans`.
  const manualRows = storedRows.filter((r) => normalizeOrigin(r.AssignmentSource) === ORIGIN.MANUAL);
  const prune = compSource.pruneOrphans({
    stored: manualRows,
    sapKeys: sourceComplete ? desiredKeys : null,
    keyOf: str
  });
  const manualKept = prune.kept;
  const manualDropped = prune.dropped;
  const manualDroppedIds = prune.ids;
  const manualMaterials = new Set(manualKept.map((r) => str(r.Material)));

  // ================================================================
  // Le righe che il ricalcolo SOSTITUISCE, per identificativo.
  //
  // NON SI CANCELLA CON UN CRITERIO SULLA PROVENIENZA, perche' sarebbe una SECONDA decisione su
  // cosa e' automatico, presa in SQL, accanto a quella che `normalizeOrigin` prende qui — e le
  // due non danno la stessa risposta. `normalizeOrigin` confronta senza distinguere maiuscole e
  // spazi, quindi una riga con `manual` minuscolo per lei e' manuale e resta; un
  // `DELETE ... WHERE AssignmentSource <> 'MANUAL'` la cancellerebbe, e la collocazione fatta a
  // mano sparirebbe senza che nessuno se ne accorga. Con l'elenco degli identificativi cio' che
  // si cancella e' esattamente cio' che questa funzione ha deciso di sostituire, punto.
  // ================================================================
  const autoReplacedIds = storedRows
    .filter((r) => normalizeOrigin(r.AssignmentSource) !== ORIGIN.MANUAL)
    .map((r) => r.ID)
    .filter((id) => id !== null && id !== undefined && id !== '');

  // Dov'era ogni materiale automatico prima di questo giro: serve a dichiarare gli spostamenti.
  const autoWas = new Map();
  for (const r of storedRows) {
    if (normalizeOrigin(r.AssignmentSource) === ORIGIN.MANUAL) continue;
    const m = str(r.Material);
    if (m && !autoWas.has(m)) autoWas.set(m, str(r.PlexOperationId));
  }

  // Quanti componenti ha gia' ogni operazione: le manuali occupano le prime posizioni.
  const countByOp = new Map();
  for (const r of manualKept) {
    const opId = str(r.PlexOperationId);
    countByOp.set(opId, (countByOp.get(opId) || 0) + 1);
  }

  // L'esito dell'auto-assegnazione, indicizzato per materiale.
  const assignedByMaterial = new Map();
  for (const a of (Array.isArray(assignments) ? assignments : [])) {
    const m = str(a && a.Material);
    if (m && !assignedByMaterial.has(m)) assignedByMaterial.set(m, a);
  }
  const unassignedByMaterial = new Map();
  for (const u of (Array.isArray(unassigned) ? unassigned : [])) {
    const m = str(u && u.Material);
    if (m && !unassignedByMaterial.has(m)) unassignedByMaterial.set(m, u);
  }

  const rows = [];
  const blocked = [];
  const moved = [];
  const seen = new Set();
  let manualSkipped = 0;

  for (const comp of (Array.isArray(desired) ? desired : [])) {
    const material = str(comp && comp.Material);
    if (!material || seen.has(material)) continue;
    seen.add(material);

    // Regola 2: la collocazione fatta a mano vince, e non passa dalla regola.
    if (manualMaterials.has(material)) { manualSkipped++; continue; }

    const assignment = assignedByMaterial.get(material);
    if (!assignment) {
      const u = unassignedByMaterial.get(material);
      blocked.push({
        Material: material,
        Reason: str(u && u.Reason) || BLOCK_REASON.NO_GROUP,
        PhantomSource: str(comp.PhantomSource),
        Source: str(comp._source) || SOURCE.CYCLE
      });
      continue;
    }

    const targetOp = resolveTargetOperation(assignment.TargetOperation, ops);
    if (!targetOp) {
      // Prima era il contatore `skippedNoOp`: il componente spariva senza che nessuno lo sapesse.
      blocked.push({
        Material: material,
        Reason: BLOCK_REASON.NO_OPERATION,
        Target: str(assignment.TargetOperation),
        ComponentGroup: str(assignment.ComponentGroup),
        PhantomSource: str(comp.PhantomSource),
        Source: str(comp._source) || SOURCE.CYCLE
      });
      continue;
    }

    const opId = str(targetOp.PlexOperationId);
    const n = (countByOp.get(opId) || 0) + 1;
    countByOp.set(opId, n);

    rows.push({
      Material: material,
      PlexOperationId: opId,
      BOMItemNodeNumber: comp.BOMItemNodeNumber || null,
      RequiredQuantity: comp.RequiredQuantity != null ? comp.RequiredQuantity : 0,
      BaseUnit: str(comp.BaseUnit),
      PhantomSource: str(comp.PhantomSource),
      Sequence: n * SEQUENCE_STEP,
      AssignmentSource: ORIGIN.AUTO,
      _source: str(comp._source) || SOURCE.CYCLE,
      _group: str(assignment.ComponentGroup)
    });

    const was = autoWas.get(material);
    if (was && was !== opId) moved.push({ Material: material, From: was, To: opId });
  }

  // Vedi BLOCK_REASON.EMPTY_SOURCE: una lettura che non ha portato niente non autorizza a
  // svuotare un ciclo che i giri precedenti avevano riempito. Si guarda `autoReplacedIds` e non
  // `manualKept`, perche' sono le righe automatiche quelle che la riscrittura porterebbe via.
  if (!seen.size && autoReplacedIds.length > 0) {
    blocked.push({
      Material: '*',
      Reason: BLOCK_REASON.EMPTY_SOURCE,
      Existing: autoReplacedIds.length
    });
  }

  return {
    rows,
    manualKept,
    autoReplacedIds,
    // [COMP-ORPHAN] Le righe manuali il cui componente SAP non ha piu'. `pruned` dice se la
    // potatura e' stata VALUTATA: `false` con `manualDropped` vuoto significa «non ho potuto
    // guardare», che non e' «non c'era niente da togliere» — e chi chiama lo dichiara.
    manualDropped,
    manualDroppedIds,
    pruned: prune.evaluated,
    blocked,
    moved,
    counts: {
      desired: seen.size,
      auto: rows.length,
      manual: manualSkipped,
      manualDropped: manualDropped.length,
      blocked: blocked.length,
      moved: moved.length,
      fromBom: rows.filter((r) => r._source === SOURCE.BOM).length
    }
  };
}

// ================================================================
// Dichiarazione
// ================================================================

/** Testo per un motivo di blocco, per il log e per la mail di recap. */
const REASON_TEXT = Object.freeze({
  [BLOCK_REASON.NO_GROUP]: 'nessuna regola di assegnazione lo aggancia',
  [BLOCK_REASON.NO_MAPPING]: 'il gruppo non ha una mappatura verso un\'operazione',
  [BLOCK_REASON.NO_CLFN]: 'classificazione non letta: le condizioni di classe non sono state valutate',
  [BLOCK_REASON.NO_PLANT_DATA]: 'nessun dato di stabilimento per il materiale',
  [BLOCK_REASON.NO_OPERATION]: 'l\'operazione indicata dalla regola non esiste nel ciclo',
  [BLOCK_REASON.EMPTY_SOURCE]: 'la lettura di SAP non ha restituito alcun componente, mentre il '
    + 'ciclo ne ha gia\': riscrivere lo svuoterebbe, quindi non si tocca niente',
  [BLOCK_REASON.NO_BOM]: 'il plant legge i componenti dalla distinta base, ma quella del materiale '
    + 'di testata non esiste o non ha posizioni: non si invia un ciclo senza componenti'
});

/**
 * [LOG-MSG-I18N] La chiave i18n del messaggio di ogni motivo di blocco. Gemella di `REASON_TEXT`,
 * che resta per il `console.error` del server (dove la lingua e' quella del progetto e non c'e'
 * nessun utente).
 */
const REASON_MSG_KEY = Object.freeze({
  [BLOCK_REASON.NO_GROUP]: 'logRoutingBlockedNoGroup',
  [BLOCK_REASON.NO_MAPPING]: 'logRoutingBlockedNoMapping',
  [BLOCK_REASON.NO_CLFN]: 'logRoutingBlockedNoClfn',
  [BLOCK_REASON.NO_PLANT_DATA]: 'logRoutingBlockedNoPlantData',
  [BLOCK_REASON.NO_OPERATION]: 'logRoutingBlockedNoOperation',
  [BLOCK_REASON.EMPTY_SOURCE]: 'logRoutingBlockedEmptySource',
  [BLOCK_REASON.NO_BOM]: 'logRoutingBlockedNoBom'
});

/**
 * [LOG-MSG-I18N] I segmenti del messaggio di blocco: quanti, e i primi con nome e motivo.
 *
 * SI NOMINANO I COMPONENTI, non si dice «N componenti non assegnati». Chi legge la mail deve
 * poter aprire la scheda dei gruppi e sapere su quale materiale intervenire; un numero da solo
 * obbliga a rifare a mano il lavoro che il job ha appena fatto.
 *
 * UN SEGMENTO = UNA AFFERMAZIONE TRADUCIBILE, e da qui viene la forma. Il motivo non puo' essere un
 * PARAMETRO — un parametro e' un dato, e un dato non si traduce — quindi e' il CODICE del segmento a
 * portare il motivo, e il materiale e' il suo parametro. Per la stessa ragione la provenienza da
 * fantasma e il bersaglio della regola sono segmenti PROPRI e non decorazioni infilate nel
 * parametro: cucite dentro il materiale sarebbero prosa italiana dentro un valore.
 *
 * @param {Array<object>} blocked
 * @param {number} [limit] quanti nominarne per esteso
 * @returns {Array<{c: string, p?: Array}>}
 */
function describeBlockedSegments(blocked, limit = 10) {
  const list = Array.isArray(blocked) ? blocked.filter(Boolean) : [];
  if (!list.length) return [];

  // La sorgente vuota non e' «componenti senza operazione», e col titolo degli altri sarebbe una
  // diagnosi sbagliata: chi legge andrebbe a cercare una regola mancante che non c'e'.
  const empty = list.find((b) => str(b.Reason) === BLOCK_REASON.EMPTY_SOURCE);
  if (empty && list.length === 1) {
    return [{ c: 'logRoutingBlockedEmptySource', p: [String(empty.Existing || 0)] }];
  }

  // [ROUTING-DEFAULT-OP] Stessa ragione per la distinta assente: il rimedio e' in SAP o nella
  // scheda del plant, non nei gruppi oggetto. Il materiale che si nomina e' quello di TESTATA —
  // la distinta che manca e' la sua — e non un componente, che qui non esiste per definizione.
  const noBom = list.find((b) => str(b.Reason) === BLOCK_REASON.NO_BOM);
  if (noBom && list.length === 1) {
    return [{ c: 'logRoutingBlockedNoBom', p: [str(noBom.Material)] }];
  }

  const out = [{ c: 'logRoutingBlockedHead', p: [String(list.length)] }];
  const head = list.slice(0, Math.max(1, limit));
  for (const b of head) {
    const material = str(b.Material);
    out.push({
      c: REASON_MSG_KEY[str(b.Reason)] || 'logRoutingBlockedUnknown',
      p: [material, str(b.Reason)]
    });
    if (str(b.PhantomSource)) {
      out.push({ c: 'logRoutingBlockedFromPhantom', p: [material, str(b.PhantomSource)] });
    }
    if (str(b.Target)) {
      out.push({ c: 'logRoutingBlockedRuleTarget', p: [material, str(b.Target)] });
    }
  }
  const rest = list.length - head.length;
  if (rest > 0) out.push({ c: 'logRoutingBlockedMore', p: [String(rest)] });
  return out;
}

/**
 * La riga di dichiarazione della seconda lettura. Vuota quando la data non e' configurata: non si
 * dichiara cio' che non e' successo.
 * @param {{ keyDate: Date|null, honored: boolean, stats: object|null }} info
 * @returns {string}
 */
function describeSecondRead(info) {
  const { keyDate = null, honored = true, stats = null } = info || {};
  const label = keyDateLabel(keyDate);
  if (!label) return '';
  if (!honored) {
    // Si dice cio' che si sa: la data non viene inviata. COSA torni al suo posto lo decide quel
    // canale, e affermare «torna la distinta di oggi» sarebbe una supposizione — l'unica cosa
    // accertata e' che il risultato NON e' la distinta a quella data.
    return `distinta al ${label}: il canale attivo non sa esprimere la data, che quindi non viene`
      + ' inviata: cio\' che la seconda lettura restituisce non e\' la distinta a quella data, e i'
      + ' componenti che entrano piu\' avanti potrebbero non esserci';
  }
  const added = stats ? stats.added : 0;
  if (!added) return `distinta al ${label}: nessun componente da aggiungere`;
  const names = (stats.addedMaterials || []).slice(0, 10).join(', ');
  const rest = added - Math.min(added, 10);
  return `distinta al ${label}: ${added} componenti aggiunti al ciclo (${names}`
    + (rest > 0 ? `, e altri ${rest}` : '') + ')';
}

module.exports = {
  ORIGIN,
  SOURCE,
  BLOCK_REASON,
  REASON_TEXT,
  FIRST_OP,
  LAST_OP,
  SEQUENCE_STEP,
  // [ROUTING-DEFAULT-OP] L'allocazione dichiarata (feature 0051)
  DEFAULT_OP_TARGETS,
  DEFAULT_OP_STATE,
  compDefaultOp,
  validateCompDefaultOp,
  sortSapOperations,
  pickAnchorOperation,
  allocRowsFromBom,
  normalizeOrigin,
  normalizeKeyDate,
  keyDateLabel,
  mergeComponentSources,
  resolveTargetOperation,
  planCycleComponents,
  describeBlockedSegments,
  REASON_MSG_KEY,
  describeSecondRead
};
