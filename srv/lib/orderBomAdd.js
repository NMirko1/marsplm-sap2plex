/**
 * [ORDER-BOM-ADD] I componenti extra dell'ordine finiscono nella distinta DEL SUO JOB su Plex
 * (feature 0025). Orchestrazione: le regole verificabili senza sistemi esterni stanno nel modulo
 * puro srv/lib/orderBomAddRules.js (test: node test/orderBomAddRules.test.js; la sequenza ha il suo,
 * node test/orderBomAdd.test.js).
 *
 * DUE FASI, E LA RAGIONE E' IL PERIMETRO DELLA SCRITTURA.
 *
 *   planPartBomAdditions   PREVOLO, nessuna scrittura. Gira PRIMA che il job esista e guarda la
 *                          PART, che e' esattamente cio' che il job erediterà: quali componenti
 *                          dell'ordine mancano, su quale operazione vanno, quale part sono. Se
 *                          qualcosa non torna il chiamante NON crea il job — quando a decidere e'
 *                          il job pianificato (`blocking`, vedi `planTail`).
 *   applyJobBomAdditions   SCRITTURA, a job esistente. Una sola
 *                          `POST /scheduling/v1/jobs/{id}/bom-components` con l'array intero.
 *
 * PERCHE' SUL JOB. La part e' master data condivisa: una riga aggiunta per l'ordine di oggi
 * resterebbe li' e comparirebbe nel job di domani, dove il passo 7.2 la disattiverebbe. Il job no.
 * Il prezzo e' che il job deve gia' esistere quando si scrive, ed e' il motivo della fase 1: tutto
 * cio' che puo' fallire in modo PREVEDIBILE — componente non assegnabile, materiale che non e' una
 * part, operazione bersaglio che non c'e' — viene accertato prima, cosi' il gate «se fallisce non si
 * crea il job» resta intero. L'unico fallimento tardivo e' la POST stessa: il job resta con la
 * distinta incompleta, l'ordine chiude in errore dicendolo, e il run successivo ripete la POST —
 * l'operazione e' `add-update`, quindi non duplica.
 *
 * LA QUANTITA' E' QUELLA CHE L'ORDINE PORTA. `RequiredQuantity` di
 * `A_ProductionOrderComponent_2` e' il fabbisogno dell'INTERO ordine, mentre
 * `JobBomComponentCommand.quantity` e' dichiarata «per produrre il prodotto finito» — la stessa
 * dicitura della riga BOM della part, cioe' PER UNITA'. Le due scale non coincidono e qui non si
 * converte: questa feature governa l'ESISTENZA della riga, non il suo valore. E' una lacuna
 * dichiarata, non una svista, ed e' la stessa gia' aperta nel blocco `bomQtyUom` del log del ciclo
 * (W1-05, DEC-68).
 *
 * UNA LETTURA FALLITA E' UN ERRORE, NON UN INSIEME VUOTO. `syncRoutingPlexCycle` davanti a una GET
 * della distinta fallita ripiega su «POST tutto», e la' e' innocuo perche' Plex rifiuta i duplicati
 * sul ciclo. Qui produrrebbe righe che non servono su un lotto in produzione. Chi scrive si ferma
 * (DEC-60, DEC-80).
 *
 * Perimetro: grep -rn "ORDER-BOM-ADD".
 */

'use strict';

const cds = require('@sap/cds'); // per i globali di cds.ql (SELECT)
const rules = require('./orderBomAddRules');
const bomRules = require('./plexBomRules');
const autoAssign = require('./autoAssign');
const opCatalog = require('./plexOperationCatalog');
// [COMP-SOURCE] La collocazione decisa a mano nell'albero dell'ordine vince sulla regola (0036).
const compSource = require('./compSourceRules');
// Lo scheduler del fan-out, riusato: e' quello che il progetto ha gia' in esercizio e collaudato
// (test/fanOutPartial.test.js). Un secondo scheduler sarebbe un secondo posto dove sbagliare.
const { withConcurrency } = require('./isRemoteSource');

const NS = 'avvaleplm.marsplm.sap2plex';
const E_MAT_MAPPING = `${NS}.ZMatPlexMapping`;

/** Quanti caratteri del corpo di un rifiuto entrano nel motivo del fallimento. */
const REJECT_TEXT_MAX = 300;

/**
 * [CLFN-PARALLEL] Quante risoluzioni «materiale -> UUID Plex» stanno in volo insieme nel passo 5b
 * del prevolo (DEC-122).
 *
 * STRETTA DI PROPOSITO, e per due ragioni diverse dal fan-out verso l'Integration Suite. Il
 * bersaglio e' il tenant Plex, di cui non conosciamo i limiti di frequenza — l'unico rifiuto per
 * eccesso di chiamate mai osservato sul progetto e' arrivato da la' — e ogni risoluzione stampa due
 * righe di tracciato (`plexCallTrace`), che con l'onda larga diventano illeggibili.
 *
 * `1` riporta al comportamento di prima, una risoluzione per volta.
 */
const PART_LOOKUP_WAVE = (() => {
  const raw = Number(process.env.PLEX_PART_LOOKUP_WAVE);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
})();

/**
 * Il testo di un rifiuto Plex, senza l'involucro fisso.
 *
 * `errors[]` ha solo `code` e `message` e il campo contestato sta DENTRO il testo
 * (srv/external/PLEX_PART_OPERATION_API_CONTRACT.md): troncare a 200 caratteri di JSON grezzo
 * lasciava vedere solo `{"message":"The sp…`, cioe' niente. Si estraggono i messaggi veri.
 * @param {{status: number, body: *}} r
 * @returns {string}
 */
function rejectText(r) {
  const parts = [`HTTP ${r && r.status}`];
  const b = r && r.body;
  if (b && typeof b === 'object') {
    if (Array.isArray(b.errors) && b.errors.length) {
      parts.push(b.errors.map((e) => [e.code, e.message].filter(Boolean).join(': ')).join(' | '));
    } else if (b.code || b.message) {
      parts.push([b.code, b.message].filter(Boolean).join(': '));
    } else {
      parts.push(JSON.stringify(b));
    }
  } else if (typeof b === 'string' && b) {
    parts.push(b);
  }
  return parts.join(' ').slice(0, REJECT_TEXT_MAX);
}

/** Il messaggio d'errore, costruito dentro il budget di `Message` (String(255)). */
function failureMessage(failures, suffix) {
  const tail = suffix || '';
  return rules.describe(failures, rules.MESSAGE_MAX_CHARS - tail.length) + tail;
}

/**
 * La coda del messaggio del prevolo: DICE COSA E' SUCCESSO AL JOB, e le due risposte sono opposte.
 *
 * Il prevolo e' un gate quando a decidere e' il job pianificato, che non ha nessuno a cui chiedere e
 * quindi si ferma. Dall'azione manuale non lo e': chi preme il tasto guarda l'ordine, decide di
 * mandarlo lo stesso e si assume la responsabilita' di un lotto con la distinta incompleta. Cambia
 * l'esito, quindi deve cambiare anche la frase — un messaggio che dicesse «Nessun job creato» su un
 * job appena creato sarebbe falso, ed e' esattamente il tipo di bugia che rende illeggibile uno
 * storico.
 *
 * @param {boolean} blocking
 * @returns {string}
 */
function planTail(blocking) {
  return blocking
    ? ' Nessun job creato.'
    : ' Il job viene creato ugualmente: la distinta del lotto resta incompleta.';
}

/**
 * L'UUID Plex di un materiale componente.
 *
 * Stessa catena del passo 7c di `syncRoutingPlexCycle`: il dizionario `ZMatPlexMapping` dice quale
 * id abbiamo, e la lettura per numero parte dice quale id Plex ha ADESSO — i due divergono, ed e'
 * un caso gia' visto in esercizio.
 *
 * DIFFERENZA VOLUTA CON IL PASSO 7c: qui il dizionario NON si riscrive. Correggere l'anagrafica
 * materiali e' compito del flusso materiali; questo passo sta dentro la creazione di un job e non
 * deve lasciare effetti collaterali su una tabella che non governa. Il costo e' una lettura in piu'
 * al prossimo giro, e va bene.
 *
 * [MAT-PLANT-PAIR] IL DIZIONARIO SI LEGGE PER (materiale, PLANT), feature 0039: la part e' per
 * coppia, e il `plant` qui e' quello dell'ordine — lo stesso con cui e' stata risolta la
 * connessione Plex, quindi lo stesso tenant su cui la lettura per numero parte sta guardando. Senza
 * il plant, il ripiego dell'ultima riga («la lettura non e' riuscita, uso l'id del dizionario»)
 * potrebbe restituire l'id di UN ALTRO tenant: peggio che dichiarare il fallimento.
 *
 * @returns {Promise<string>} '' se il materiale non e' una part su Plex (assenza DIMOSTRATA)
 */
async function resolveComponentId({ plexGet, db, material, plant }) {
  const code = String(material || '').trim();
  if (!code) return '';
  const plantKey = String(plant || '').trim();

  let stored = '';
  try {
    // Plant assente: non si legge il dizionario invece di leggerlo su una chiave parziale, che
    // restituirebbe una riga arbitraria fra quelle del materiale. Resta la lettura su Plex, che e'
    // comunque l'autorita' di questo modulo.
    if (!plantKey) {
      console.warn(`>>> [MAT-PLANT-PAIR] ${code}: dizionario materiali non interrogato (plant assente)`);
    } else {
      const row = await db.run(
        SELECT.one.from(E_MAT_MAPPING).columns('PlexId').where({ Product: code, Plant: plantKey })
      );
      stored = (row && row.PlexId) || '';
    }
  } catch (e) {
    console.warn(`>>> [ORDER-BOM-ADD] dizionario materiali non letto per ${code}/${plantKey}: ${e.message}`);
  }

  const r = await plexGet(
    `/inventory/v1/inventory-definitions/parts?partNumber=${encodeURIComponent(code)}`
  );
  if (r.ok) {
    const list = Array.isArray(r.body)
      ? r.body : (r.body?.data || r.body?.results || r.body?.value || []);
    const hit = (list || []).find(
      (p) => String(p.number || p.partNumber || '').toUpperCase() === code.toUpperCase()
    );
    const found = hit ? String(hit.partId || hit.id || '') : '';
    if (found) {
      if (stored && found !== stored) {
        console.warn(`>>> [ORDER-BOM-ADD] ${code}: il dizionario dice ${stored}, Plex ${found}:`
          + ' si usa quello di Plex (il dizionario NON viene riscritto da qui)');
      }
      return found;
    }
    // Lettura riuscita e nessuna riga: il materiale su Plex non c'e'. E' un'ASSENZA DIMOSTRATA,
    // e solo per questo si puo' dichiarare tale.
    return '';
  }

  // Lettura NON riuscita: non si puo' dire ne' che ci sia ne' che non ci sia. Se il dizionario
  // porta un id lo si usa — e' l'unica informazione disponibile — altrimenti si dichiara il
  // fallimento della lettura, che il chiamante tratta come un errore e non come un'assenza.
  if (stored) {
    console.warn(`>>> [ORDER-BOM-ADD] ${code}: verifica su Plex non riuscita (HTTP ${r.status}),`
      + ' si usa l\'id del dizionario');
    return stored;
  }
  throw new Error(`part ${code} non verificabile su Plex (HTTP ${r.status})`);
}

// ================================================================
// FASE 1 — prevolo, nessuna scrittura
// ================================================================

/**
 * Cosa andra' aggiunto alla distinta del job, deciso PRIMA che il job esista.
 *
 * Guarda la PART perche' e' cio' che il job erediterà: le sue part-operation diventeranno le
 * operazioni del job, con la stessa numerazione, e la sua distinta diventera' la distinta del job.
 * Un prevolo che tornasse `ok: false` deve fermare il chiamante PRIMA della creazione — e' l'intero
 * senso di questa fase, e resta vero dove a decidere e' il job pianificato.
 *
 * `blocking` NON CAMBIA CIO' CHE IL PREVOLO FA: cambia solo la coda del messaggio, perche' con
 * `false` il chiamante creera' il job comunque (vedi `planTail`). L'esito resta `ok: false`, perche'
 * il prevolo E' fallito: che farne lo decide chi chiama, ed e' l'unico posto in cui si sa se c'e' un
 * utente. Il `plan` porta comunque le voci RISOLTE, ed e' cio' che permette alla fase 2 di scrivere
 * sul lotto quello che si puo'.
 *
 * @param {object} p
 * @param {{baseUrl: string, consumerKey: string}} p.creds connessione Plex del plant
 * @param {function(string): Promise<object>} p.plexGet
 * @param {object} p.db
 * @param {object} p.order ordine SAP, con `components` gia' caricati
 * @param {string} p.partId UUID della part su Plex (dal passo 1)
 * @param {Array<object>} p.steps traccia della sequenza, alimentata in loco
 * @param {boolean=} p.blocking `true` (default) = il chiamante si fermera', quindi il messaggio dice
 *   «Nessun job creato». Il default e' il comportamento del job pianificato: chi lo cambia lo fa
 *   esplicitamente, e non per una svista.
 * @param {function=} p.resolveAssignments l'auto-assegnazione, iniettabile. Il default e' quella
 *   vera; il parametro esiste perche' e' l'unica dipendenza che non passa gia' dagli argomenti, e
 *   senza di lui il collaudo dovrebbe manomettere `require.cache`. Stessa forma dell'iniezione di
 *   `checkScope` in srv/lib/orderCycleSeed.js.
 * @returns {Promise<{ok: boolean, message: string, plan: Array<object>, failures: Array<object>,
 *   notes: Array<string>}>}
 *   `plan` vuoto con `ok: true` = non manca niente, la fase 2 non ha di che lavorare.
 *   [COMP-SOURCE] `notes` sono dichiarazioni che NON toccano `ok`: il componente e' stato collocato,
 *   ma altrove rispetto a dove una persona lo aveva messo. Il chiamante le porta fra le attenzioni.
 */
async function planPartBomAdditions({
  creds, plexGet, db, order, partId, steps, blocking = true,
  resolveAssignments = autoAssign.resolveAutoAssignments
}) {
  const plant = order.ProductionPlant;
  const trace = Array.isArray(steps) ? steps : [];
  const tail = planTail(blocking);
  // [COMP-SOURCE] `notes`: dichiarazioni che NON bloccano il prevolo — oggi solo il ripiego di un
  // bersaglio manuale che su Plex non esiste. Non entrano in `ok`, perche' il componente viene
  // collocato comunque; entrano nelle attenzioni del chiamante, perche' e' stato collocato ALTROVE.
  const out = { ok: true, message: '', plan: [], failures: [], notes: [] };

  // --- 1. Le part-operation: il job erediterà queste, con la loro numerazione. ---
  const opsUrl = `/mdm/v1/part-operations?partId=${encodeURIComponent(partId)}`;
  const rOps = await plexGet(opsUrl);
  trace.push({
    step: '2bis.1 read part-operations',
    request: { url: opsUrl },
    status: rOps.status,
    response: rOps.ok ? rOps.body : { error: rejectText(rOps) }
  });
  if (!rOps.ok) {
    out.ok = false;
    out.message = 'Distinta del job non preparabile: lettura delle operazioni di Plex non'
      + ` riuscita (${rejectText(rOps)}).${tail}`;
    return out;
  }
  const partOperations = rules.usablePartOperations(
    Array.isArray(rOps.body) ? rOps.body : (rOps.body?.value || rOps.body?.results || [])
  );

  // --- 2. La distinta che il job erediterà dalla part. ---
  const bomUrl = `/engineering/v1/boms?partId=${encodeURIComponent(partId)}`;
  const rBom = await plexGet(bomUrl);
  trace.push({
    step: '2bis.2 read part BOM',
    request: { url: bomUrl },
    status: rBom.status,
    response: rBom.ok ? rBom.body : { error: rejectText(rBom) }
  });
  if (!rBom.ok) {
    out.ok = false;
    out.message = 'Distinta del job non preparabile: lettura della distinta di Plex non'
      + ` riuscita (${rejectText(rBom)}).${tail}`;
    return out;
  }
  const remoteBomRows = bomRules.extractBomList(rBom.body);

  // --- 3. Cosa manca. ---
  const { missing, presentCount, distinctCount } = rules.missingComponents({
    components: order.components,
    remoteBomRows
  });
  if (!missing.length) {
    const msg = `il job erediterà già tutti i componenti dell'ordine: ${presentCount} su`
      + ` ${distinctCount}`;
    console.log(`>>> [ORDER-BOM-ADD] ordine ${order.ManufacturingOrder}: ${msg}`);
    trace.push({
      step: '2bis.3 delta distinta',
      request: { componenti: distinctCount },
      status: 0,
      response: msg
    });
    return out;
  }
  console.log(`>>> [ORDER-BOM-ADD] ordine ${order.ManufacturingOrder}: ${missing.length} componenti`
    + ` su ${distinctCount} non sono nella distinta che il job erediterà`);

  // --- 4. Su quale operazione vanno: e' la stessa auto-assegnazione della UI e del ciclo. ---
  const aa = await resolveAssignments({
    plant,
    headerMaterial: order.Material,
    components: missing
  });

  // ================================================================
  // [COMP-SOURCE] 4bis. LA COLLOCAZIONE DECISA A MANO VINCE SULLA REGOLA (feature 0036).
  //
  // Fino alla 0036 questo passo interrogava le SOLE regole e non guardava mai l'albero salvato
  // dell'ordine: un componente che una persona aveva appeso all'operazione 30 nel cockpit finiva
  // sul job dove diceva il customizing — l'albero a schermo diceva una cosa e la fabbrica ne
  // vedeva un'altra, senza un errore da nessuna parte. E' la stessa regola che il ciclo applica
  // dalla 0025 (`manualMaterials` in cat-service.js), portata sul ramo ordini.
  //
  // DUE EFFETTI, e il secondo e' quello che si dimentica: un materiale manuale che le regole
  // avevano assegnato cambia bersaglio, e uno che le regole NON agganciavano affatto — il caso
  // tipico per cui la collocazione a mano esiste — esce dai falliti. Per questo la lettura sta
  // PRIMA del ciclo che accoda gli `UNASSIGNED`: dopo, il componente sarebbe gia' un fallimento.
  //
  // Il bersaglio e' `PlexOperationId`, cioe' l'UUID dell'operazione nel catalogo del tenant: lo
  // stesso identificativo che `resolveTargetPartOperation` scioglie per primo, e lo stesso ponte
  // per IDENTIFICATIVO di DEC-99. Nessuna lettura verso Plex in piu'.
  // ================================================================
  const savedTree = await db.run(
    SELECT.from(`${NS}.ZPlexCycleComponent`)
      .columns('Material', 'PlexOperationId', 'Sequence', 'AssignmentSource')
      .where({ ManufacturingOrder: order.ManufacturingOrder })
  );
  const manualTargets = compSource.manualTargetsByMaterial(savedTree);
  const applied = compSource.applyManualTargets({
    assignments: aa.assignments,
    unassigned: aa.unassigned,
    manualTargets,
    components: missing
  });
  aa.assignments = applied.assignments;
  aa.unassigned = applied.unassigned;
  const overriddenNote = compSource.describeOverridden(applied.overridden);
  if (overriddenNote) {
    console.log(`>>> [COMP-SOURCE] ordine ${order.ManufacturingOrder}: ${overriddenNote}`);
  }

  trace.push({
    step: '2bis.3 auto-assegnazione',
    request: { plant, headerMaterial: order.Material, materiali: missing.map((c) => c.Material) },
    status: 0,
    response: {
      assegnati: aa.assignments.length,
      nonAssegnati: aa.unassigned.length,
      classificazione: aa.ClassificationStatus,
      dettaglio: aa.ClassificationDetail || '',
      unassigned: aa.unassigned,
      // [COMP-SOURCE] Cosa la mano ha corretto: senza questa riga un bersaglio diverso da quello
      // delle regole si legge come un difetto del customizing.
      manuali: manualTargets.size,
      overridden: applied.overridden
    }
  });
  for (const u of aa.unassigned) {
    out.failures.push({ material: u.Material, code: rules.FAILURE.UNASSIGNED, reason: u.Reason });
  }

  // Il catalogo del tenant serve SOLO se qualche bersaglio e' espresso per codice: `PartOperationDTO`
  // porta `operationId` e non il codice. Non lo si puo' rimandare alla fase 2 — dove il codice
  // arriverebbe gratis dalla `JobOperationDTO` — perche' li' il job esisterebbe gia' e il prevolo
  // non fermerebbe piu' niente. Si legge pigramente: una chiamata, e non su ogni ordine.
  let codeById = null;
  const notOnPart = (t) => {
    const want = String(t || '');
    if (!want || want === rules.SENTINEL.FIRST || want === rules.SENTINEL.LAST) return false;
    return !partOperations.some((op) => rules.uuidKey(op.operationId) === rules.uuidKey(want));
  };
  // [COMP-SOURCE] Si guarda anche il bersaglio delle REGOLE, che dove c'e' fa da ripiego a uno
  // manuale non risolvibile: se e' espresso per CODICE, senza catalogo il ripiego non scioglierebbe
  // niente e il componente cadrebbe fra i falliti proprio nel caso in cui il ripiego serve. Su un
  // ordine senza collocazioni a mano `RuleTargetOperation` non esiste e il predicato e' quello di
  // prima.
  const needsCatalog = aa.assignments.some((a) => notOnPart(a.TargetOperation)
    || notOnPart(a.RuleTargetOperation));
  if (needsCatalog) {
    const cat = await opCatalog.fetchOperations(creds);
    codeById = new Map();
    if (cat.ok) {
      for (const op of cat.operations) {
        if (op.id) codeById.set(rules.uuidKey(op.id), op.code || '');
      }
    } else {
      console.warn('>>> [ORDER-BOM-ADD] catalogo operazioni non letto'
        + ` (${cat.error || cat.status}): i bersagli espressi per CODICE non si risolvono`);
    }
    trace.push({
      step: '2bis.4 catalogo operazioni',
      request: { motivo: 'bersagli espressi per codice' },
      status: cat.status,
      response: cat.ok ? { operazioni: cat.operations.length } : { error: cat.error || '' }
    });
  }

  // ================================================================
  // --- 5. Il piano: una voce per componente, pronta per la fase 2. ---
  //
  // [CLFN-PARALLEL] TRE FASI, e la separazione non e' stilistica (DEC-122).
  //
  //  5a  il BERSAGLIO, puro e in fila: nessuna rete, quindi l'ordine delle note e dei `console.warn`
  //      resta quello delle assegnazioni;
  //  5b  l'UUID Plex del componente, a onde: e' l'unica parte che parla con la rete — una lettura
  //      del dizionario piu' una `GET` su Plex per materiale — ed era il solo ciclo per componente
  //      del progetto in cui le chiamate partivano una dopo l'altra. Si puo' parallelizzare perche'
  //      `resolveComponentId` NON SCRIVE NIENTE (vedi la sua testata): ogni risoluzione e'
  //      indipendente dalle altre e non lascia effetti;
  //  5c  la RICOMPOSIZIONE, nell'ordine di `aa.assignments` e mai in quello di arrivo.
  //
  // PERCHE' L'ORDINE VA RICOMPOSTO. L'ordine di `plan` diventa a valle la `Sequence` persistita dei
  // componenti dentro l'operazione, e l'ordine di `failures` decide QUALI materiali il messaggio
  // nomina (`NAMED_IN_SUMMARY`, orderBomAddRules.js). Un `push` dentro il task li renderebbe
  // entrambi dipendenti da quale risposta di Plex e' tornata prima: due esecuzioni identiche
  // darebbero due alberi e due messaggi diversi, senza che niente segnali un errore.
  //
  // IL PREZZO, dichiarato: le chiamate Plex passano da `plexCallTrace`, che numera con un contatore
  // condiviso e stampa due righe per chiamata (invio e risposta). Con piu' chiamate in volo le due
  // righe di una stessa chiamata non sono piu' adiacenti in `cf logs` — il `#n` resta corretto e
  // appaiabile, e' l'adiacenza che si perde. E' anche il motivo per cui l'onda qui e' STRETTA: il
  // bersaglio e' il tenant Plex, non l'Integration Suite.
  // ================================================================

  // --- 5a. Il bersaglio di ogni componente: puro, in fila. ---
  const pending = [];
  for (const a of aa.assignments) {
    let target = rules.resolveTargetPartOperation({
      target: a.TargetOperation,
      partOperations,
      codeById
    });
    // ================================================================
    // [COMP-SOURCE] Un bersaglio scelto A MANO che su Plex non esiste NON fa uscire la sequenza.
    //
    // L'operazione puo' essere stata cancellata dal ciclo dopo che la persona ci aveva appeso il
    // componente: bloccare l'ordine per questo trasformerebbe la miglioria in un fermo. Si ripiega
    // sul bersaglio delle REGOLE e si DICHIARA — e' la forma di [SCHED-CONTINUE]: si raccoglie
    // l'attenzione e si prosegue. Senza la dichiarazione il componente finirebbe altrove in
    // silenzio, cioe' il difetto che questa feature e' nata per chiudere, dall'altro lato.
    //
    // Un materiale PROMOSSO da `unassigned` non ha ripiego (`RuleTargetOperation` vuoto): torna fra
    // i falliti, cioe' dov'era prima della 0036.
    // ================================================================
    if (!target && a.Source === 'MANUAL' && compSource.str(a.RuleTargetOperation)) {
      target = rules.resolveTargetPartOperation({
        target: a.RuleTargetOperation,
        partOperations,
        codeById
      });
      if (target) {
        const note = `componente ${a.Material}: l'operazione scelta a mano non esiste piu' su Plex,`
          + ' collocato dove dicono le regole dei gruppi';
        out.notes.push(note);
        console.warn(`>>> [COMP-SOURCE] ordine ${order.ManufacturingOrder}: ${note}`);
      }
    }
    if (!target) {
      pending.push({
        a,
        failure: {
          material: a.Material,
          code: rules.FAILURE.NO_TARGET_OP,
          detail: a.TargetOperationName || a.TargetOperation
        }
      });
      continue;
    }
    pending.push({ a, target });
  }

  // --- 5b. L'UUID Plex dei componenti da collocare: a onde, l'esito nel suo posto. ---
  const lookups = pending.filter(p => p.target);
  await withConcurrency(lookups.map(p => async () => {
    try {
      // [MAT-PLANT-PAIR] Il plant dell'ordine: e' lo stesso con cui e' stata risolta la connessione
      // Plex poche righe piu' su, quindi il dizionario si legge sul tenant che si sta guardando.
      p.componentPartId = await resolveComponentId({ plexGet, db, material: p.a.Material, plant });
    } catch (e) {
      // L'errore si TIENE, non si lancia: un `withConcurrency` non ha un `catch` per task, e una
      // part non verificabile e' un esito di QUEL componente — non un guasto degli altri.
      p.error = e;
    }
  }), PART_LOOKUP_WAVE, null);

  // --- 5c. La ricomposizione, nell'ordine delle assegnazioni. ---
  for (const p of pending) {
    if (p.failure) { out.failures.push(p.failure); continue; }
    if (p.error) {
      out.failures.push({
        material: p.a.Material, code: rules.FAILURE.NO_PLEX_PART, detail: p.error.message
      });
      continue;
    }
    if (!p.componentPartId) {
      out.failures.push({ material: p.a.Material, code: rules.FAILURE.NO_PLEX_PART });
      continue;
    }

    out.plan.push({
      material: p.a.Material,
      componentPartId: p.componentPartId,
      quantity: p.a.RequiredQuantity,
      depletionUnitOfMeasure: (p.a.BaseUnit || '').trim(),
      // Il PONTE verso la job operation: `JobOperationDTO` non porta l'`operationId` di catalogo.
      operationNumber: p.target.operationNumber,
      operationLabel: p.a.TargetOperationName || p.a.TargetOperation,
      via: p.target.via
    });
  }

  if (out.failures.length) {
    out.ok = false;
    out.message = failureMessage(out.failures, tail);
  }
  trace.push({
    step: '2bis.5 piano',
    request: null,
    status: 0,
    response: {
      daAggiungere: out.plan.length,
      falliti: out.failures.length,
      piano: out.plan,
      // [COMP-SOURCE] I ripieghi: un bersaglio manuale non piu' esistente su Plex.
      note: out.notes
    }
  });
  return out;
}

// ================================================================
// FASE 2 — scrittura, a job esistente
// ================================================================

/**
 * Scrive sul job le righe che il prevolo ha preparato.
 *
 * UNA SOLA CHIAMATA: `JobBomComponentCommand` viaggia in un ARRAY, quindi N componenti sono una
 * `POST` sola. E' `add-update`, quindi ripeterla su un job che ha gia' quelle righe le aggiorna
 * invece di duplicarle — ed e' la proprieta' su cui poggia il ritentativo al run successivo.
 *
 * @param {object} p
 * @param {function(string): Promise<object>} p.plexGet
 * @param {function(string, object): Promise<object>} p.plexPost
 * @param {string} p.jobId UUID del job su Plex
 * @param {string} p.jobNumber solo per i messaggi
 * @param {Array<object>} p.plan da `planPartBomAdditions`
 * @param {Array<object>} p.steps traccia
 * @returns {Promise<{ok: boolean, message: string, created: number, failures: Array<object>}>}
 */
async function applyJobBomAdditions({ plexGet, plexPost, jobId, jobNumber, plan, steps }) {
  const trace = Array.isArray(steps) ? steps : [];
  const out = { ok: true, message: '', created: 0, failures: [] };
  const items = Array.isArray(plan) ? plan : [];
  if (!items.length) return out;

  // --- 1. Le operazioni del JOB: e' da qui che viene `jobOpId`. ---
  const opsUrl = `/scheduling/v1/jobs/${encodeURIComponent(jobId)}/operations`;
  const rOps = await plexGet(opsUrl);
  trace.push({
    step: '4bis.1 read job operations',
    request: { url: opsUrl },
    status: rOps.status,
    response: rOps.ok ? rOps.body : { error: rejectText(rOps) }
  });
  if (!rOps.ok) {
    out.ok = false;
    out.failures = items.map((i) => ({
      material: i.material, code: rules.FAILURE.NO_JOB_OP, detail: `HTTP ${rOps.status}`
    }));
    out.message = `Job ${jobNumber} creato, ma le sue operazioni non sono leggibili`
      + ` (${rejectText(rOps)}): i componenti dell'ordine non presenti nel ciclo NON sono stati`
      + ' aggiunti alla distinta del job.';
    return out;
  }

  const { entries, failures } = rules.bridgeToJobOperations({
    plan: items,
    jobOperations: Array.isArray(rOps.body) ? rOps.body : (rOps.body?.value || rOps.body?.results || [])
  });
  out.failures.push(...failures);

  // --- 2. Una POST, con l'array intero. ---
  if (entries.length) {
    const sendFlag = bomRules.isEnabled(process.env.PLEX_BOM_AUTODEPLETE);
    const sendValidate = bomRules.isEnabled(process.env.PLEX_BOM_VALIDATE);
    const body = entries.map((e) => rules.buildJobBomBody({ ...e, sendValidate, sendFlag }));
    const url = `/scheduling/v1/jobs/${encodeURIComponent(jobId)}/bom-components`;
    const r = await plexPost(url, body);
    trace.push({
      step: `4bis.2 add job BOM (${entries.length})`,
      request: { url, body, materiali: entries.map((e) => e.material) },
      status: r.status,
      response: r.ok ? r.body : { error: rejectText(r) }
    });
    if (r.ok) {
      out.created = entries.length;
      console.log(`>>> [ORDER-BOM-ADD] job ${jobNumber}: ${entries.length} componenti aggiunti alla`
        + ` distinta del lotto (${entries.map((e) => e.material).join(', ')})`);
    } else {
      // L'array parte o non parte tutto insieme: un rifiuto li riguarda tutti.
      const detail = rejectText(r);
      for (const e of entries) {
        out.failures.push({ material: e.material, code: rules.FAILURE.POST_REJECTED, detail });
      }
    }
  }

  if (out.failures.length) {
    out.ok = false;
    // Il job C'E' gia': il messaggio non puo' dire «nessun job creato». Dice cosa manca e che il
    // giro successivo ci riprovera' — la POST e' `add-update`, quindi ripeterla e' sicuro.
    out.message = failureMessage(
      out.failures,
      ` Job ${jobNumber} creato ma con la distinta incompleta: il prossimo run ritenta.`
    );
  }
  return out;
}

module.exports = {
  planPartBomAdditions,
  applyJobBomAdditions,
  resolveComponentId,
  rejectText,
  planTail,
  // [CLFN-PARALLEL] L'onda del passo 5b esce per il test, che deve poter collaudare anche la via di
  // RITORNO (`PLEX_PART_LOOKUP_WAVE=1`, le risoluzioni una per volta): un test che pretende il
  // picco del default fallirebbe proprio nella configurazione in cui si ripiega, cioe' quando
  // serve sapere che tutto il resto funziona ancora.
  PART_LOOKUP_WAVE
};
