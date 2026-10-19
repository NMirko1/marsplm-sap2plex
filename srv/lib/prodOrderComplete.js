/**
 * ============================================================================
 * [ORDER-COMPLETE] Il LEGAME al flusso «job completato -> stato utente in SAP» (feature 0045)
 * ============================================================================
 *
 * Le regole vivono in [orderStatusFlow.js](orderStatusFlow.js), condivise con il flusso gemello
 * `Scheduled` della 0046: qui c'e' solo il legame al descrittore `FLOW_COMPLETE` e la
 * RI-ESPORTAZIONE INVARIATA dei nomi con cui questo flusso e' nato.
 *
 * PERCHE' I NOMI STORICI RESTANO. `test/prodOrderComplete.test.js` — 45 test che sorvegliano il
 * tetto dei tentativi, il riconoscimento del lotto padre, la quarantena e la diagnosi dello zero —
 * passa NON MODIFICATO, e quello e' cio' che dimostra che la 0046 ha fatto un'estrazione e non una
 * riscrittura. E' il metodo con cui questo repo ha validato `pagedRead` (`test/plantRows.test.js`
 * non modificato) e il `prefix` di `plexConfWindow`. Rinominare qui per «pulizia» costerebbe la
 * prova, che vale piu' della simmetria dei nomi.
 *
 * E' la stessa forma con cui `routingCompSourceRules.js` ri-esporta `compSourceRules.js`
 * ([CLAUDE.md](../../CLAUDE.md), `grep -rn "COMP-SOURCE"`).
 *
 * Perimetro: grep -rn "ORDER-COMPLETE"   ·   Collaudo: node test/prodOrderComplete.test.js
 */

'use strict';

const flow = require('./orderStatusFlow');

const bound = flow.bindFlow(flow.FLOW_COMPLETE);

module.exports = {
  // Tutto cio' che il modulo condiviso espone, gia' legato a questo flusso.
  ...bound,

  // ---- i nomi storici, invariati -----------------------------------------------------------
  // Non sono alias di comodo: sono il contratto su cui `test/prodOrderComplete.test.js` e il job
  // `completeSapOrdersFromPlex.js` sono scritti, e tenerli e' la prova dell'estrazione.
  JOB_CODE: flow.FLOW_COMPLETE.jobCode,
  SOURCE_CODE: flow.FLOW_COMPLETE.sourceCode,
  E_COMPLETE_CONFIG: flow.FLOW_COMPLETE.configEntity,
  E_COMPLETE_STATE: flow.FLOW_COMPLETE.stateEntity,
  DEFAULT_STATUSES: flow.FLOW_COMPLETE.defaultStatuses,
  validateCompleteConfig: bound.validateConfig,
  resolveCompleteScope: bound.resolveScope,
  completeRecapEntries: bound.recapEntries
};
