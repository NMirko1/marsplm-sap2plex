/**
 * [ROUTING-DEFAULT-OP] Censimento a secco prima di accendere l'allocazione di default (0051).
 *
 * A COSA SERVE, E PERCHE' NON E' FACOLTATIVO
 * Con l'allocazione dichiarata, l'elenco dei componenti di un ciclo non viene piu' dall'assegnazione
 * componente-operazione di SAP (`PLMZ`) ma dalla DISTINTA del materiale di testata. La distinta e'
 * quasi sempre piu' larga: contiene anche le posizioni che in SAP nessuno ha mai agganciato a
 * un'operazione — e quelle, per definizione, sono i componenti su cui nessuno ha mai ragionato
 * quando ha scritto le regole dei gruppi oggetto.
 *
 * Un componente che nessuna regola aggancia BLOCCA L'INTERO CICLO (`routingCompSourceRules`, regola
 * 3): non e' una degradazione, e' un invio che non parte. Accendere la casella su un plant la cui
 * auto-assegnazione e' stata scritta guardando il sottoinsieme `PLMZ` puo' quindi fermare TUTTI i
 * suoi cicli al primo run di `ROUTING_SYNC`, e lasciare il run rosso ogni notte finche' qualcuno non
 * configura le regole mancanti.
 *
 * Il numero che serve per decidere non si ricava leggendo il codice: si misura. Questo script lo
 * misura SENZA scrivere niente e SENZA toccare Plex.
 *
 *     ROUTING_SOURCE=ONPREM node srv/lib/routingDefaultOpCensus.js --plant 07
 *     ROUTING_SOURCE=ONPREM node srv/lib/routingDefaultOpCensus.js --plant 07 --verbose
 *
 * COSA MISURA, E COSA NON PUO' MISURARE
 * Gira la parte della catena che decide il blocco: distinta -> `resolveAutoAssignments` ->
 * `planCycleComponents`, cioe' gli stessi tre passi dell'invio, con gli stessi moduli. Non gira
 * l'ancora (`pickAnchorOperation`) ne' l'esplosione dei fantasma: la prima non influisce sul
 * blocco per mancanza di regola, la seconda ALLARGA l'elenco — quindi il numero che esce qui e' un
 * MINIMO, e va letto cosi'. E' dichiarato nel risultato (`isLowerBound`).
 *
 * NON legge il customizing `RoutingCompDefaultOp`: risponde alla domanda «cosa succederebbe SE lo
 * accendessi», che ha senso proprio quando e' ancora spento.
 */

'use strict';

const cds = require('@sap/cds');
const bomExplode = require('./bomExplode');
const routingCompRules = require('./routingCompSourceRules');
const { resolveAutoAssignments } = require('./autoAssign');

const NS = 'avvaleplm.marsplm.sap2plex';

/**
 * I cicli SALVATI di un plant, con il loro materiale di testata.
 *
 * Il plant non sta sulle tabelle del ciclo: si risolve dalla testata SAP, ed e' esattamente cio' che
 * il job fa con `resolveRoutingContext` ([ROUTING-PLANT]). Qui si riusa quella funzione invece di
 * rifare le due letture, o il censimento misurerebbe un perimetro diverso da quello che il job
 * tratta — che e' precisamente l'errore che renderebbe inutile il numero.
 *
 * @param {object} db
 * @param {string} plant
 * @returns {Promise<Array<{group: string, routing: string, material: string}>>}
 */
async function savedCyclesOfPlant(db, plant) {
  const { enumerateSavedCycles, resolveRoutingContext } = require('../jobs/syncRoutingsToPlex');
  const routingSource = require('./routingSource');
  const { routingKey } = require('./routingMaterialRules');
  const s4r = await routingSource();

  const saved = await enumerateSavedCycles(db);
  const ctx = await resolveRoutingContext(s4r, [plant], null);
  // VUOTO NON E' IGNOTO: con la lettura delle testate caduta, nessun ciclo si attribuisce al plant e
  // il censimento direbbe «0 cicli», che si legge come «nessun rischio» — la conclusione opposta a
  // quella giusta. Si lancia, e chi guarda sa che non ha misurato niente.
  if (ctx.headersOk !== true) {
    throw new Error('le testate dei cicli non sono state lette: il censimento non ha un perimetro'
      + ' su cui misurare (controlla ROUTING_SOURCE e la destination)');
  }

  const out = [];
  // `enumerateSavedCycles` rende una Map chiavata su (gruppo|contatore|materiale): si iterano i
  // VALORI, o `c` sarebbe la coppia [chiave, riga] e ogni campo uscirebbe `undefined` — senza
  // errore, con un censimento che non trova nessun ciclo.
  for (const c of saved.values()) {
    const kr = routingKey(c.ProductionRoutingGroup, c.ProductionRouting);
    const rowPlant = String(ctx.plantByRouting.get(kr) || '').trim();
    if (rowPlant !== plant) continue;
    out.push({
      group: c.ProductionRoutingGroup,
      routing: c.ProductionRouting,
      material: String(c.HeaderMaterial || '').trim()
    });
  }
  return out;
}

/**
 * Il censimento.
 *
 * @param {{plant: string, verbose?: boolean}} args
 * @returns {Promise<object>} il rapporto, pronto da stampare
 */
async function run(args) {
  const plant = String((args && args.plant) || '').trim().toUpperCase();
  const verbose = !!(args && args.verbose);
  if (!plant) throw new Error('serve --plant <codice>');

  const db = await cds.connect.to('db');
  const config = await bomExplode.resolveExplodeConfig(db, plant);
  const cache = bomExplode.createExplodeCache();

  const report = {
    plant,
    isLowerBound: true,
    bomConfig: {
      usage: config.BomUsage || '(qualunque)',
      variant: config.BomVariant || '(la piu\' bassa)',
      explodeInRouting: config.ExplodeInRouting === true
    },
    cycles: { total: 0, wouldSend: 0, wouldBlock: 0, noBom: 0, readFailed: 0 },
    // I componenti che fermano i cicli, con quanti cicli ciascuno ne ferma: e' l'elenco su cui si
    // interviene, ed e' ordinato per impatto perche' una riga di customizing puo' sbloccarne molti.
    blockingComponents: [],
    blockedCycles: []
  };

  const impact = new Map();
  const cycles = await savedCyclesOfPlant(db, plant);
  report.cycles.total = cycles.length;

  for (const c of cycles) {
    if (!c.material) { report.cycles.readFailed++; continue; }

    const read = await bomExplode.listBomComponents(c.material, plant, config, cache, null);
    if (read.error) { report.cycles.readFailed++; continue; }
    const components = (read.rows || [])
      .map((r) => ({ Material: String(r.Material || '').trim(), RequiredQuantity: 1, BaseUnit: '' }))
      .filter((x) => x.Material);
    if (!components.length) {
      // Distinta assente o senza posizioni: con l'opzione accesa e' un blocco dichiarato, non un
      // insieme vuoto. Si conta a parte perche' il rimedio e' un altro (SAP, o la scheda del plant).
      report.cycles.noBom++;
      report.cycles.wouldBlock++;
      if (verbose) report.blockedCycles.push({ ...c, reason: 'NO_BOM' });
      continue;
    }

    const aa = await resolveAutoAssignments({ plant, headerMaterial: c.material, components });
    const assigned = new Set((aa.assignments || []).map((a) => String(a.Material || '').trim()));
    const blocked = components
      .map((x) => x.Material)
      .filter((m) => !assigned.has(m));

    if (!blocked.length) { report.cycles.wouldSend++; continue; }

    report.cycles.wouldBlock++;
    for (const m of new Set(blocked)) impact.set(m, (impact.get(m) || 0) + 1);
    if (verbose) {
      report.blockedCycles.push({ ...c, reason: 'NO_RULE', components: [...new Set(blocked)] });
    }
  }

  report.blockingComponents = [...impact.entries()]
    .map(([material, cyclesBlocked]) => ({ material, cyclesBlocked }))
    .sort((a, b) => b.cyclesBlocked - a.cyclesBlocked || a.material.localeCompare(b.material));

  return report;
}

module.exports = { run, savedCyclesOfPlant };

if (require.main === module) {
  (async () => {
    const argv = process.argv;
    const at = argv.indexOf('--plant');
    const plant = at >= 0 ? argv[at + 1] : '';
    try {
      // L'ORDINE conta: cds.model va impostato PRIMA di cds.connect.to('db'), come nei job.
      cds.model = cds.linked(await cds.load('*'));
      await cds.serve('all');
      const report = await run({ plant, verbose: argv.includes('--verbose') });
      console.log(JSON.stringify(report, null, 2));
      const { wouldBlock, total } = report.cycles;
      console.log(`\n>>> [ROUTING-DEFAULT-OP] plant ${report.plant}: accendendo l'opzione,`
        + ` ${wouldBlock} cicli su ${total} NON partirebbero.`
        + (report.blockingComponents.length
          ? ` Primo componente da configurare: ${report.blockingComponents[0].material}`
            + ` (${report.blockingComponents[0].cyclesBlocked} cicli).`
          : '')
        + ' Il numero e\' un MINIMO: i fantasma esplosi allargano ancora l\'elenco.');
      process.exit(0);
    } catch (err) {
      console.error('>>> [ROUTING-DEFAULT-OP] censimento FALLITO:', err.message);
      console.error(err.stack);
      process.exit(1);
    }
  })();
}
