// [PLEX-OP-TYPE-FILTER] Regole pure del filtro per TIPO delle operazioni Plex (feature 0024).
//
// Le tendine che offrono il catalogo operazioni di Plex (`GET /mdm/v1/operations`) mostravano tutte
// le operazioni del tenant: 154 su Albacina, con i `Ricevere kg` / `Ricevere L` / `Ricevere m³`
// mescolati alle operazioni di ciclo `V090-Sgrassaggio+Verniciatura`. Chi configura il ricevimento
// di un materiale scorreva le operazioni di ciclo, e chi costruisce un ciclo scorreva i
// ricevimenti.
//
// Il criterio e' customizing PER PLANT (`ZPlexOpTypeFilter`, due ambiti: RECV e CYCLE) e non tre
// `if`: quali tipi esistano lo sa il tenant, non il progetto — e' la stessa ragione per cui
// `ZPlexPartTypeCode` non ha un elenco chiuso (DEC-65) e per cui il `type` della part-operation non
// ha un enum nel contratto Plex.
//
// FAIL-OPEN: elenco vuoto = nessuna restrizione, si vedono tutte le operazioni. Questo customizing
// governa solo cio' che si VEDE in una tendina, non cio' che viene scritto verso Plex, quindi
// «non configurato» significa «nessun filtro» e non «niente» — e' il ramo di DEC-53 che vale per
// ZMatCategory e ZRoutingFilterConfig, l'opposto di ZProdOrderFilterConfig.
//
// Modulo PURO: nessuna dipendenza da `cds` ne' dalla rete, cosi' la regola e' collaudabile senza
// sistemi esterni (`test/plexOpTypeFilter.test.js`). Nessuna funzione muta l'input.

'use strict';

/** Gli ambiti. Chiavi stabili: entrano nella colonna `Scope`, nell'action e nei test. */
const OP_TYPE_SCOPE = {
  RECV: 'RECV',    // la tendina della scheda «Operazioni di ricevimento»
  CYCLE: 'CYCLE'   // le quattro tendine che inseriscono operazioni in un ciclo
};

const OP_TYPE_SCOPES = Object.freeze([OP_TYPE_SCOPE.RECV, OP_TYPE_SCOPE.CYCLE]);

/**
 * Ambito normalizzato, o '' se non e' uno dei due.
 *
 * Tollerante sulla grafia perche' l'ambito arriva anche dal parametro di un'action, cioe' da un
 * chiamante HTTP: `'recv'` e `'RECV'` sono la stessa richiesta. Un valore che non e' un ambito NON
 * diventa un ambito di ripiego — diventa «nessun filtro», che e' l'unico ripiego sicuro qui.
 *
 * @param {*} value
 * @returns {string} 'RECV' | 'CYCLE' | ''
 */
function normalizeScope(value) {
  if (value === null || value === undefined) return '';
  const folded = String(value).trim().toUpperCase();
  return OP_TYPE_SCOPES.includes(folded) ? folded : '';
}

/**
 * Elenco dei tipi normalizzato, nella forma prescritta: split sulle virgole, trim di ogni token,
 * scarto dei vuoti, rimozione dei duplicati CASE-INSENSITIVE conservando la PRIMA occorrenza NELLA
 * FORMA SCRITTA, ordine di scrittura conservato, ricomposizione con virgola e SENZA spazi.
 *
 * Gemello dichiarato di `normalizeFrozenList` (srv/lib/plexJobSortRules.js) e per la stessa
 * ragione: cio' che si memorizza, cio' che si mostra e cio' che si applica devono essere lo stesso
 * valore, o la scheda direbbe una cosa e il filtro ne farebbe un'altra.
 *
 * Maiuscole e minuscole NON vengono alterate: il valore e' il NOME di una riga di setup del tenant
 * e va mostrato come l'ha scritto chi configura. La tolleranza sta nel confronto, non nel dato.
 *
 * @param {string|null|undefined} raw
 * @returns {{ value: string, tokens: string[] }}
 */
function parseOpTypes(raw) {
  const text = raw === null || raw === undefined ? '' : String(raw);
  const tokens = [];
  const seen = new Set();
  for (const part of text.split(',')) {
    const token = part.trim();
    if (!token) continue;                 // virgola doppia, iniziale o finale: nessun token
    const folded = token.toLowerCase();   // dedup case-insensitive...
    if (seen.has(folded)) continue;       // ...conservando la PRIMA occorrenza
    seen.add(folded);
    tokens.push(token);                   // ...nella forma in cui e' stata scritta
  }
  return { value: tokens.join(','), tokens };
}

/**
 * Il tipo di un'operazione, normalizzato per il CONFRONTO.
 *
 * TOLLERANTE su spazi e maiuscole, e la ragione e' quella di DEC-51: i due lati del confronto hanno
 * autori diversi — da una parte un valore DIGITATO nella scheda del plant, dall'altra il `type` che
 * Plex consegna — quindi qui il difetto sarebbe nostro. E' lo stesso ramo di `normalizeUom`
 * (srv/lib/recvOpRules.js), non quello del confronto stretto fra due chiavi SAP.
 *
 * @param {*} value
 * @returns {string} '' quando non c'e' niente di confrontabile
 */
function foldOpType(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

/** Il `type` di una riga del catalogo Plex, nelle due grafie che una risposta puo' avere. */
function operationType(op) {
  if (!op || typeof op !== 'object') return '';
  const raw = op.type !== undefined ? op.type : op.Type;
  return raw === null || raw === undefined ? '' : String(raw);
}

/**
 * Applica il filtro a un elenco di operazioni.
 *
 * Due regole che vanno lette insieme:
 *
 *   - `tokens` VUOTO tiene tutto. E' il fail-open, e non e' un caso limite: e' la configurazione di
 *     partenza di ogni plant.
 *   - Un'operazione SENZA `type`, a filtro attivo, viene SCARTATA: non e' «di uno dei tipi
 *     indicati», e tenerla dentro renderebbe il filtro una raccomandazione. Ma e' anche l'unico
 *     scarto che l'utente non si aspetta, quindi si CONTA a parte (`droppedNoType`) e chi chiama lo
 *     dichiara: una sparizione silenziosa qui si leggerebbe come «questa operazione non esiste sul
 *     tenant», che e' il difetto della tenda vuota di DEC-81.
 *
 * @param {Array<object>} ops elenco consegnato da Plex (gia' mappato dall'action)
 * @param {string[]} tokens tipi ammessi, come li restituisce parseOpTypes
 * @returns {{ kept: Array<object>, dropped: Array<object>, droppedNoType: number }}
 *   `kept` e' una NUOVA array; le righe sono le stesse istanze (nessuna copia).
 */
function filterOperationsByType(ops, tokens) {
  const list = Array.isArray(ops) ? ops : [];
  const wanted = Array.isArray(tokens) ? tokens.map(foldOpType).filter(Boolean) : [];

  if (wanted.length === 0) {
    return { kept: [...list], dropped: [], droppedNoType: 0 };
  }

  const allowed = new Set(wanted);
  const kept = [];
  const dropped = [];
  let droppedNoType = 0;

  for (const op of list) {
    const folded = foldOpType(operationType(op));
    if (folded && allowed.has(folded)) {
      kept.push(op);
      continue;
    }
    if (!folded) droppedNoType++;
    dropped.push(op);
  }

  return { kept, dropped, droppedNoType };
}

/**
 * La riga di customizing dell'ambito richiesto, fra quelle lette per il plant.
 *
 * Nessuna riga, ambito non riconosciuto o elenco vuoto danno tutti la stessa risposta — nessun
 * filtro — ma `configured` le distingue: serve a dire «il plant non l'ha mai compilato» invece di
 * «l'ha compilato e non filtra niente», e sono due schermate diverse.
 *
 * @param {Array<object>} rows righe di ZPlexOpTypeFilter del plant
 * @param {*} scope ambito richiesto
 * @returns {{ scope: string, value: string, tokens: string[], configured: boolean }}
 */
function resolveOpTypeFilter(rows, scope) {
  const wantedScope = normalizeScope(scope);
  if (!wantedScope) return { scope: '', value: '', tokens: [], configured: false };

  const list = Array.isArray(rows) ? rows : [];
  const hit = list.find((r) => r && normalizeScope(r.Scope) === wantedScope);
  const parsed = parseOpTypes(hit ? hit.OpTypes : '');
  return { scope: wantedScope, value: parsed.value, tokens: parsed.tokens, configured: !!hit };
}

module.exports = {
  OP_TYPE_SCOPE,
  OP_TYPE_SCOPES,
  normalizeScope,
  parseOpTypes,
  foldOpType,
  operationType,
  filterOperationsByType,
  resolveOpTypeFilter
};
