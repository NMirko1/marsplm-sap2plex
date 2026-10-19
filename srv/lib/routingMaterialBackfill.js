/**
 * [ROUTING-BY-MATERIAL] Backfill una-tantum del materiale di testata (feature 0015).
 *
 * COSA FA
 * La 0015 porta il materiale di testata nell'identita' del ciclo Plex e del suo log. Le righe
 * scritte PRIMA nascono senza quel campo, quindi:
 *   - le tre tabelle del ciclo (`ZPlexRoutingCycleOperation`, `ZPlexRoutingCycleComponent`,
 *     `ZPlexRoutingApprovedWorkcenter`) hanno `HeaderMaterial = ''`, e il dettaglio di un
 *     materiale non troverebbe il ciclo che l'utente aveva salvato;
 *   - le due tabelle di log (`ZRoutingExcLogHDR`, `ZRoutingExcLogPOS`) hanno `Material = ''`, e il
 *     semaforo «ultimo invio» della lista non si aggancerebbe ad alcuna riga di materiale.
 *
 * PERCHE' IL PRIMO MATERIALE DEL CICLO NON E' UN RIPIEGO
 * E' la verita' storica. Il codice di prima prendeva `Material.split(',')[0]` sia nell'azione sia
 * nel job: la part Plex su cui quegli invii sono andati e su cui quei cicli sono stati costruiti e'
 * ESATTAMENTE il primo materiale che MAPL restituisce per quel ciclo. Attribuire le righe a quel
 * materiale non inventa niente, registra cosa e' accaduto.
 *
 * L'ORDINE DI MAPL. «Primo» significa: il primo che la lettura restituisce, ordinato per materiale
 * crescente per essere RIPRODUCIBILE. La lettura di prima non ordinava, quindi in un caso limite
 * il materiale scelto oggi puo' differire da quello usato allora. Il backfill lo dichiara riga per
 * riga nel log, cosi' il caso limite e' ispezionabile invece che nascosto.
 *
 * IDEMPOTENTE: tocca solo le righe col campo vuoto. Rilanciarlo non fa danni.
 * A SECCO per default: senza `--apply` non scrive nulla e stampa cosa farebbe.
 *
 *     node srv/lib/routingMaterialBackfill.js            # a secco, stampa il piano
 *     node srv/lib/routingMaterialBackfill.js --apply    # esegue
 *
 * In locale servono i pin del canale storico, altrimenti la lettura MAPL e' vuota:
 *     ROUTING_SOURCE=ONPREM node srv/lib/routingMaterialBackfill.js --apply
 */

'use strict';

const cds = require('@sap/cds');
const routingSource = require('./routingSource');
const { keyPart, routingKey } = require('./routingMaterialRules');

const NS = 'avvaleplm.marsplm.sap2plex';

/** Le tre tabelle del ciclo: `HeaderMaterial` NON e' in chiave, quindi si aggiorna in loco. */
const CYCLE_TABLES = Object.freeze([
  'ZPlexRoutingCycleOperation',
  'ZPlexRoutingCycleComponent',
  'ZPlexRoutingApprovedWorkcenter'
]);

/** Le due tabelle di log: `Material` E' in chiave, quindi si riscrive delete+insert. */
const LOG_TABLES = Object.freeze(['ZRoutingExcLogHDR', 'ZRoutingExcLogPOS']);

/**
 * Il primo materiale di ciascun ciclo, da `MAPL`, per i cicli passati.
 *
 * La lettura e' filtrata per PLANT e non per gruppo: e' il criterio che la funzione ABAP dietro
 * l'iFlow pretende (vedi il blocco in testa a `READ Routings` in srv/cat-service.js). I plant si
 * ricavano dalle testate dei cicli da attribuire, perche' le tabelle locali non portano il plant.
 *
 * @param {Set<string>} routingKeys chiavi `gruppo|contatore` da attribuire
 * @returns {Promise<{ firstMaterial: Map<string,string>, ambiguous: Map<string,string[]> }>}
 */
async function resolveFirstMaterials(routingKeys) {
  const firstMaterial = new Map();
  const ambiguous = new Map();
  if (routingKeys.size === 0) return { firstMaterial, ambiguous };

  const s4r = await routingSource();
  const { ProductionRoutingHeader, ProductionRoutingMatlAssgmt } = s4r.entities;
  const groups = [...new Set([...routingKeys].map((k) => k.split('|')[0]))];

  // 1) i plant dei cicli da attribuire, dalla testata
  const headers = await s4r.run(
    SELECT.from(ProductionRoutingHeader)
      .columns('ProductionRoutingGroup', 'ProductionRouting', 'Plant')
      .where({ ProductionRoutingGroup: { in: groups } })
      .limit(10000)
  );
  const plants = [...new Set((headers || []).map((h) => keyPart(h.Plant)).filter(Boolean))];
  if (plants.length === 0) {
    console.warn('>>> [BACKFILL] nessun plant risolto dalle testate: MAPL non e\' interrogabile');
    return { firstMaterial, ambiguous };
  }
  console.log(`>>> [BACKFILL] ${headers.length} testate, plant=[${plants.join(', ')}]`);

  // 2) le assegnazioni di quei plant, in una chiamata
  const matls = await s4r.run(
    SELECT.from(ProductionRoutingMatlAssgmt)
      .columns('ProductionRoutingGroup', 'ProductionRouting', 'Product', 'Plant')
      .where({ Plant: { in: plants } })
      .limit(10000)
  );
  console.log(`>>> [BACKFILL] ${Array.isArray(matls) ? matls.length : 0} assegnazioni materiale lette`);

  // 3) per ciclo, i materiali ORDINATI: «primo» deve essere riproducibile
  const byRouting = new Map();
  for (const m of matls || []) {
    const k = routingKey(m.ProductionRoutingGroup, m.ProductionRouting);
    if (!routingKeys.has(k)) continue;
    const product = keyPart(m.Product);
    if (!product) continue;
    if (!byRouting.has(k)) byRouting.set(k, new Set());
    byRouting.get(k).add(product);
  }
  for (const [k, set] of byRouting) {
    const sorted = [...set].sort();
    firstMaterial.set(k, sorted[0]);
    // Piu' di un materiale = il caso in cui la scelta di allora non e' ricostruibile con
    // certezza. Si dichiara, non si nasconde.
    if (sorted.length > 1) ambiguous.set(k, sorted);
  }
  return { firstMaterial, ambiguous };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.apply=false] false = a secco, non scrive
 * @param {Function} [opts.resolveFirst] risolutore dei primi materiali. Esiste per poter
 *   collaudare il percorso di SCRITTURA — che e' delete+insert su una colonna in chiave, cioe' la
 *   parte che merita una prova — senza dipendere da SAP. In esercizio non si passa.
 * @returns {Promise<object>} conteggi per tabella
 */
async function run({ apply = false, resolveFirst = resolveFirstMaterials } = {}) {
  const db = await cds.connect.to('db');
  const e = (n) => `${NS}.${n}`;
  const report = { apply, cycle: {}, log: {}, ambiguous: [], unresolved: [] };

  // ---- 1. quali cicli vanno attribuiti -----------------------------------------
  const pending = new Set();
  for (const t of CYCLE_TABLES) {
    const rows = await db.run(
      SELECT.from(e(t)).columns('ProductionRoutingGroup', 'ProductionRouting')
        .where({ HeaderMaterial: '' })
    );
    report.cycle[t] = { toUpdate: (rows || []).length, updated: 0 };
    for (const r of rows || []) pending.add(routingKey(r.ProductionRoutingGroup, r.ProductionRouting));
  }
  for (const t of LOG_TABLES) {
    const rows = await db.run(
      SELECT.from(e(t)).columns('ProductionRoutingGroup', 'ProductionRouting')
        .where({ Material: '' })
    );
    report.log[t] = { toRewrite: (rows || []).length, rewritten: 0 };
    for (const r of rows || []) pending.add(routingKey(r.ProductionRoutingGroup, r.ProductionRouting));
  }

  const totals = Object.values(report.cycle).reduce((s, v) => s + v.toUpdate, 0)
    + Object.values(report.log).reduce((s, v) => s + v.toRewrite, 0);
  if (totals === 0) {
    console.log('>>> [BACKFILL] nessuna riga da attribuire: niente da fare.');
    return report;
  }
  console.log(`>>> [BACKFILL] ${totals} righe da attribuire su ${pending.size} cicli`);

  // ---- 2. il primo materiale di ciascuno ---------------------------------------
  const { firstMaterial, ambiguous } = await resolveFirst(pending);
  for (const [k, materials] of ambiguous) {
    console.warn(`>>> [BACKFILL] ciclo ${k}: ${materials.length} materiali [${materials.join(', ')}]`
      + ` -> attribuito al primo (${materials[0]}). La scelta di allora non e' ricostruibile con`
      + ' certezza: se le righe sono importanti, verificare su Plex quale part porta il ciclo.');
    report.ambiguous.push({ routing: k, materials });
  }
  for (const k of pending) {
    if (!firstMaterial.has(k)) {
      console.warn(`>>> [BACKFILL] ciclo ${k}: NESSUN materiale in MAPL -> righe lasciate a vuoto.`
        + ' Sono cicli senza assegnazione: restano agganciati alla riga di lista a materiale vuoto.');
      report.unresolved.push(k);
    }
  }

  if (!apply) {
    console.log('>>> [BACKFILL] esecuzione A SECCO: nulla e\' stato scritto. Rilancia con --apply.');
    return report;
  }

  // ---- 3. le tre tabelle del ciclo: UPDATE, il campo non e' in chiave ----------
  for (const t of CYCLE_TABLES) {
    let n = 0;
    for (const [k, material] of firstMaterial) {
      const [ProductionRoutingGroup, ProductionRouting] = k.split('|');
      const res = await db.run(
        UPDATE(e(t)).set({ HeaderMaterial: material })
          .where({ ProductionRoutingGroup, ProductionRouting, HeaderMaterial: '' })
      );
      n += typeof res === 'number' ? res : 0;
    }
    report.cycle[t].updated = n;
    console.log(`>>> [BACKFILL] ${t}: ${n} righe attribuite`);
  }

  // ---- 4. le due tabelle di log: delete+insert, il campo E' in chiave ---------
  // Si rilegge la riga INTERA, si riscrive col materiale e si cancella l'originale. L'ordine
  // conta: prima l'insert della nuova, poi la delete della vecchia, cosi' un'interruzione lascia
  // un doppione visibile e non un buco nella cronologia degli invii.
  for (const t of LOG_TABLES) {
    let n = 0;
    for (const [k, material] of firstMaterial) {
      const [ProductionRoutingGroup, ProductionRouting] = k.split('|');
      const rows = await db.run(
        SELECT.from(e(t)).where({ ProductionRoutingGroup, ProductionRouting, Material: '' })
      );
      for (const row of rows || []) {
        // La chiave della riga da cancellare. `Counter` e' in chiave SOLO nelle posizioni: nella
        // testata e' un campo qualunque, e la tripla (gruppo, contatore, materiale) individua
        // gia' una riga sola.
        const oldKey = { ProductionRoutingGroup, ProductionRouting, Material: '' };
        if (t === 'ZRoutingExcLogPOS') oldKey.Counter = row.Counter;
        await db.run(INSERT.into(e(t)).entries({ ...row, Material: material }));
        await db.run(DELETE.from(e(t)).where(oldKey));
        n++;
      }
    }
    report.log[t].rewritten = n;
    console.log(`>>> [BACKFILL] ${t}: ${n} righe riscritte`);
  }

  console.log('>>> [BACKFILL] completato.');
  return report;
}

module.exports = { run, resolveFirstMaterials, CYCLE_TABLES, LOG_TABLES };

if (require.main === module) {
  (async () => {
    const apply = process.argv.includes('--apply');
    try {
      // L'ORDINE conta: cds.model va impostato PRIMA di cds.connect.to('db'), come nei job.
      cds.model = cds.linked(await cds.load('*'));
      const report = await run({ apply });
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    } catch (err) {
      console.error('>>> [BACKFILL] FALLITO:', err.message);
      console.error(err.stack);
      process.exit(1);
    }
  })();
}
