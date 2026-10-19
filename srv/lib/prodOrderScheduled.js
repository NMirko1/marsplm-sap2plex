/**
 * ============================================================================
 * [ORDER-SCHEDULED] Il LEGAME al flusso «job pianificato -> stato utente in SAP» (feature 0046)
 * ============================================================================
 *
 * Le regole vivono in [orderStatusFlow.js](orderStatusFlow.js), condivise con il flusso gemello
 * `Completed` della 0045: qui c'e' solo il legame al descrittore `FLOW_SCHEDULED`.
 *
 * QUESTO FILE E' CORTO, ED E' IL PUNTO. La feature 0046 e' «esattamente la stessa cosa» della 0045
 * con due differenze — QUALE stato Plex si guarda e QUALE Function Import si chiama — e per questo
 * costa un descrittore e quaranta righe invece di milleduecento. Una copia del modulo della 0045
 * sarebbe stata piu' rapida da scrivere e sarebbe divergita alla prima correzione fatta su una sola
 * delle due: e' il difetto che questo repo ha gia' pagato con la paginazione del perimetro
 * materiali (0035/0040, chiusa da `pagedRead`) e con l'auto-assegnazione.
 *
 * A DIFFERENZA DELLA GEMELLA, QUI NON SI USA IL WATERMARK. `FLOW_SCHEDULED.sourceCode` e' `null`, e
 * non e' una dimenticanza: su `GET /scheduling/v1/jobs` non esiste nessun filtro su una data di
 * modifica o di cambio stato — le tre coppie di date disponibili sono il completamento (evento di
 * un altro flusso) e due campi che scriviamo NOI in creazione — quindi non c'e' nessun asse su cui
 * costruire una finestra. Il rilevamento e' una FOTOGRAFIA dello stato corrente, e il punto di
 * ripresa e' lo stato per job persistito. Vedi la testata di
 * srv/jobs/scheduleSapOrdersFromPlex.js.
 *
 * Perimetro: grep -rn "ORDER-SCHEDULED"   ·   Collaudo: node test/orderStatusFlow.test.js
 */

'use strict';

const flow = require('./orderStatusFlow');

module.exports = flow.bindFlow(flow.FLOW_SCHEDULED);
