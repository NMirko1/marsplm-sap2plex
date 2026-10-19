/**
 * [ORDER-TECO] Backfill una-tantum del PLANT sul dizionario dei lotti (`ZProdOrderPlexMapping`).
 *
 * COSA FA
 * `ZProdOrderPlexMapping` ha guadagnato la colonna `Plant`. Le righe scritte prima nascono con
 * `NULL`, e un `NULL` non e' innocuo in nessuno dei due punti che quella colonna serve:
 *
 *   - il GATE DI LICENZA sui log ([LOG-PLANT-GATE], feature 0031) filtra questa entity con
 *     `where({ Plant: { in: [...plant, '#NA'] } })`. `Plant IS NULL` non entra in nessun `in`,
 *     quindi ogni riga storica SPARIREBBE dal cockpit — compresa la lettura del dettaglio ordine
 *     che risponde alla domanda «quest'ordine ha un job su Plex?»;
 *   - il job `PROD_TECO` pota i candidati per plant, e un plant ignoto deve valere «tienimi», non
 *     «escludimi».
 *
 * PERCHE' SERVE UNO SCRIPT E NON UN `default`. Un `DEFAULT` sulla colonna vale per le righe NUOVE:
 * NON riscrive i `NULL` gia' presenti. E' la trappola gia' pagata dalla 0039 (DEC-109), dove su
 * `ZMatRecvOpMapping` la colonna esisteva nullable e il deploy HDI falliva finche' i `NULL` non
 * venivano normalizzati PRIMA.
 *
 * DA DOVE VIENE IL PLANT, in quest'ordine:
 *   1. `ZProdOrderTecoState.Plant` — scritto dal job di chiusura tecnica, che l'ha letto da SAP;
 *   2. `ZProdOrderSplit.Plant`     — scritto dallo spacchettamento, stessa provenienza;
 *   3. `'#NA'`                     — non lo sappiamo, e lo si DICHIARA invece di indovinarlo.
 *
 * `'#NA'` non e' un ripiego pigro: e' il plant delle righe la cui attribuzione non e' stata
 * possibile (db/schema.cds), quello che il gate lascia passare per costruzione. Con `'#NA'` il
 * comportamento del cockpit resta IDENTICO a quello di oggi, e il job `PROD_TECO` continua a
 * trattare quelle righe come candidate — poi le impara dalla testata SAP e le riscrive da se'
 * (`learnLotPlants`), quindi l'arretrato si chiude in uno o due run senza altri interventi.
 *
 * NON si legge SAP: sarebbe una lettura per ordine su tutta la storia di un plant, e quello che
 * serve qui non e' il plant esatto di ogni riga — e' che nessuna riga resti `NULL`.
 *
 * IDEMPOTENTE: tocca solo le righe con `Plant` nullo o vuoto. Rilanciarlo non fa danni.
 * A SECCO per default: senza `--apply` non scrive nulla e stampa cosa farebbe.
 *
 *     node srv/lib/prodOrderMappingPlantBackfill.js            # a secco, stampa il piano
 *     node srv/lib/prodOrderMappingPlantBackfill.js --apply    # esegue
 */

'use strict';

const cds = require('@sap/cds');
const { PLANT_NA } = require('./jobCodes');

const NS = 'avvaleplm.marsplm.sap2plex';
const E_MAPPING = `${NS}.ZProdOrderPlexMapping`;
const E_TECO_STATE = `${NS}.ZProdOrderTecoState`;
const E_SPLIT = `${NS}.ZProdOrderSplit`;

const s = (v) => String(v ?? '').trim();

/**
 * Il plant noto di ogni ordine, dalle due tabelle che ce l'hanno.
 *
 * Le due sorgenti non si contraddicono in pratica — entrambe copiano `ProductionPlant` dalla
 * testata — ma se lo facessero vince la PRIMA scritta qui, e la divergenza si dichiara: due
 * risposte diverse alla stessa domanda sono un fatto da vedere, non da mediare.
 *
 * @returns {Promise<{ byOrder: Map<string,string>, conflicts: Array<object> }>}
 */
async function resolveKnownPlants(db) {
  const byOrder = new Map();
  const conflicts = [];
  const sources = [
    { table: E_TECO_STATE, label: 'ZProdOrderTecoState' },
    { table: E_SPLIT, label: 'ZProdOrderSplit' }
  ];

  for (const src of sources) {
    let rows;
    try {
      rows = await db.run(SELECT.from(src.table).columns('ManufacturingOrder', 'Plant'));
    } catch (e) {
      // Una sorgente illeggibile non ferma il backfill: significa solo piu' righe a '#NA', che e'
      // il valore sicuro. Va detto, perche' il risultato e' meno preciso di quanto potrebbe.
      console.warn(`>>> [BACKFILL] ${src.label} non leggibile (${e.message}): si procede senza`);
      continue;
    }
    for (const r of rows || []) {
      const order = s(r.ManufacturingOrder);
      const plant = s(r.Plant);
      if (!order || !plant || plant === PLANT_NA) continue;
      const already = byOrder.get(order);
      if (already && already !== plant) {
        conflicts.push({ order, kept: already, ignored: plant, from: src.label });
        continue;
      }
      if (!already) byOrder.set(order, plant);
    }
  }
  return { byOrder, conflicts };
}

/**
 * @param {{apply?: boolean}} opts
 * @returns {Promise<object>} il rapporto di cio' che e' stato fatto (o che si farebbe)
 */
async function run({ apply = false } = {}) {
  const db = await cds.connect.to('db');
  console.log(`>>> [BACKFILL] plant sul dizionario dei lotti — modalita' ${apply ? 'APPLY' : 'A SECCO'}`);

  const rows = await db.run(
    SELECT.from(E_MAPPING).columns('ManufacturingOrder', 'PlexJobNumber', 'Plant')
  );
  const todo = (rows || []).filter((r) => !s(r.Plant));
  const { byOrder, conflicts } = await resolveKnownPlants(db);

  const report = {
    apply,
    rows: (rows || []).length,
    toFill: todo.length,
    fromKnown: 0,
    fromUnknown: 0,
    conflicts: conflicts.length,
    updated: 0
  };

  for (const r of todo) {
    if (byOrder.get(s(r.ManufacturingOrder))) report.fromKnown += 1;
    else report.fromUnknown += 1;
  }

  console.log(`>>> [BACKFILL] righe totali ${report.rows}, da riempire ${report.toFill}`
    + ` (plant noto ${report.fromKnown}, '${PLANT_NA}' ${report.fromUnknown})`);
  for (const c of conflicts) {
    console.warn(`>>> [BACKFILL] ordine ${c.order}: plant discordante fra le sorgenti —`
      + ` si tiene '${c.kept}', ignorato '${c.ignored}' da ${c.from}`);
  }

  if (!apply) {
    console.log(">>> [BACKFILL] a secco: nessuna scrittura. Rilancia con --apply per eseguire.");
    return report;
  }

  for (const r of todo) {
    const plant = byOrder.get(s(r.ManufacturingOrder)) || PLANT_NA;
    await db.run(UPDATE(E_MAPPING).set({ Plant: plant }).where({
      ManufacturingOrder: r.ManufacturingOrder, PlexJobNumber: r.PlexJobNumber
    }));
    report.updated += 1;
  }
  console.log(`>>> [BACKFILL] completato: ${report.updated} righe aggiornate.`);
  return report;
}

module.exports = { run, resolveKnownPlants };

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
