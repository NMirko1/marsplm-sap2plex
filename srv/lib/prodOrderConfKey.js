/**
 * [PRODCONF-POST] La CHIAVE della conferma d'ordine di produzione: forma interna dei codici e scelta
 * dell'operazione da confermare. FUNZIONI PURE: nessun accesso a rete, a `cds` o all'orologio.
 *
 * PERCHE' ESISTE QUESTO MODULO
 * Le stesse regole servono ora a DUE chiamanti — la sonda srv/lib/prodOrderConfPost.js e il job
 * PROD_CONF (srv/jobs/postProdOrderConfirmation.js) — e sono verificabili senza sistemi esterni.
 * Tenerne una copia per chiamante sarebbe il modo sicuro per farle divergere: il flusso delle
 * conferme e' l'unico Plex -> SAP e l'unico con effetti contabili, e una divergenza si vedrebbe
 * come un rifiuto del BAPI mesi dopo. Stessa scelta di splitRules.js, isQueryShape.js e
 * clfnRules.js. Collaudo: test/prodOrderConfKey.test.js.
 *
 * LA REGOLA: LE CHIAVI DELLA CONFERMA VANNO IN FORMA INTERNA
 * `AFRU-APLFL` (sequenza) e `AFRU-VORNR` (operazione) sono CHAR riempiti a zeri a sinistra. Il
 * 17/08/2026 la sonda ha mandato `Sequence: '0'` — cio' che la transazione CO11N MOSTRA nel campo
 * Sequence — e il BAPI ha risposto, dalla tabella `LT_DETAIL` letta col debugger:
 *
 *   E  RU  005  Sequence 0 is not defined in order 700000080, check entry
 *
 * Il 18/08/2026, forzando `000000` dal debugger, quel rifiuto e' scomparso. La forma interna non
 * e' un'ipotesi: e' misurata.
 *
 * NON E' LA NORMALIZZAZIONE DI UN VALORE LETTO. Il contratto C-7 verso l'Integration Suite
 * (specs/0013-collegamento-path-is/04-contracts.md) vieta di aggiungere o togliere zeri ai valori
 * che ARRIVANO da SAP, e DEC-51 vieta di allineare gli zeri fra due chiavi SAP che si confrontano.
 * Qui non si confronta e non si corregge una lettura: si SCRIVE, e si scrive nella forma che il
 * campo di destinazione ha per definizione — esattamente come `OrderID` va in ALPHA a 12 cifre
 * (`000700000080`, DEC-46). Il riempimento sta all'emissione, non sul dato.
 *
 * Si riempiono i codici INTERAMENTE NUMERICI e nessun altro: su un alfanumerico uno zero iniziale
 * e' significativo, e aggiungerne altri sarebbe modificare il valore (DEC-51, conseguenza 2). E'
 * la stessa forma di `alphaKey` in srv/lib/clfnRules.js.
 */

'use strict';

/**
 * Le lunghezze dei campi chiave della conferma, cioe' fino a dove si riempie.
 *
 * Sono quelle dichiarate dall'EDMX in srv/external/ZMARS_PRODCONF_POST.fields.json (`length`), non
 * numeri scelti qui: `Sequence` e' CO_FOLGE CHAR(6), `OrderOperation` e `OrderSuboperation` sono
 * VORNR/UVORN CHAR(4). test/prodOrderConfKey.test.js le confronta con l'inventario generato, cosi'
 * un cambio di lunghezza a monte non passa inosservato.
 *
 * `OrderID` NON e' in elenco di proposito: la sua forma interna e' un letterale della
 * configurazione della sonda (`DEFAULTS.orderId`), e la leva `PRODCONF_POST_ORDER` esiste per
 * mandarlo in forma ESTERNA come controprova. Riempirlo qui renderebbe quella controprova
 * impossibile senza dirlo.
 */
const CONF_KEY_LENGTHS = Object.freeze({
  Sequence: 6,
  OrderOperation: 4,
  OrderSuboperation: 4
});

/**
 * Un codice nella forma INTERNA del suo campo: riempito di zeri a sinistra fino a `length` se e'
 * tutto numerico, invariato altrimenti. FUNZIONE PURA.
 *
 * Un valore piu' lungo del campo NON viene troncato: e' un errore di dato, e troncarlo lo
 * nasconderebbe — meglio che SAP lo rifiuti dicendo quale campo e' sbagliato (stessa scelta del
 * `numc` in srv/lib/sapPostEncoding.js).
 *
 * @param {*} value il codice, in qualunque forma sia arrivato
 * @param {number} length lunghezza del campo di destinazione
 * @returns {string} il codice in forma interna
 */
function internalKey(value, length) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const n = Number(length);
  if (!Number.isFinite(n) || n <= 0) return s;
  return /^\d+$/.test(s) ? s.padStart(n, '0') : s;
}

/**
 * I valori della conferma con le sole CHIAVI portate in forma interna. FUNZIONE PURA.
 *
 * Tocca esclusivamente i campi di `CONF_KEY_LENGTHS`, e solo quelli presenti e valorizzati: un
 * campo assente resta assente — nella forma `entity` e' la differenza fra il letterale vuoto del
 * suo tipo e una stringa `'000000'` mandata dove non si voleva mandare niente.
 *
 * @param {object} values valori in forma naturale, per nome OData
 * @returns {object} una copia, coi campi chiave riempiti
 */
function internalConfKeys(values) {
  const out = { ...(values || {}) };
  for (const [name, length] of Object.entries(CONF_KEY_LENGTHS)) {
    if (out[name] === undefined || out[name] === null || out[name] === '') continue;
    out[name] = internalKey(out[name], length);
  }
  return out;
}

/**
 * Due codici SAP interamente numerici sono LO STESSO codice? TOLLERANTE sugli zeri iniziali.
 * FUNZIONE PURA.
 *
 * [CONF-OUTCOME] Serve a confrontare il numero d'ordine che MANDIAMO con quello che l'iFlow
 * RESTITUISCE, e la tolleranza qui non contraddice DEC-51 — che vieta di allineare gli zeri fra due
 * chiavi SAP — perche' i due lati non sono due chiavi SAP indipendenti: uno l'abbiamo scritto noi in
 * forma interna (`000700000080`, DEC-46) e l'altro e' la sua eco su un canale che i valori li
 * consegna SENZA riempimento (vedi la testata di questo file). Un confronto secco dichiarerebbe
 * fallita una conferma REGISTRATA, e su questo flusso «fallita» significa ritentare, cioe' quantita'
 * confermata due volte. E' lo stesso presidio di `pickOperation` qui sotto, che lo usa.
 *
 * Gli zeri si togliano solo davanti a un'altra cifra: `'0'` resta `'0'`, e un alfanumerico non viene
 * toccato in alcun modo.
 *
 * @param {*} a un codice
 * @param {*} b l'altro
 * @returns {boolean} vero se sono lo stesso codice. Due valori vuoti NON sono lo stesso codice:
 *   l'assenza non e' un'identita', e chi chiama deve poter distinguere «uguale» da «non c'e'»
 */
function sameOrderKey(a, b) {
  const bare = (v) => String(v == null ? '' : v).trim().replace(/^0+(?=\d)/, '');
  const x = bare(a);
  const y = bare(b);
  return !!x && !!y && x === y;
}

/**
 * Quale operazione confermare, fra quelle lette da `A_ProductionOrderOperation_2`. FUNZIONE PURA.
 *
 * Se l'operazione e' nota si cerca QUELLA. Solo se non la trova ripiega sulla prima, e lo dichiara
 * con `exact: false` — chi chiama decide se un ripiego e' accettabile: per la sonda, puntata su un
 * ordine di collaudo, e' un dato in piu' da vedere; per il job, che scrive una conferma contabile,
 * NON lo e'.
 *
 * Il confronto e' TOLLERANTE sugli zeri iniziali, e qui e' giusto che lo sia: l'operazione voluta
 * arriva dal blocco DATI della sonda o da `ZPlexCycleOperation`, il lato letto arriva dall'API, e
 * un confronto secco su `20` contro `0020` scarterebbe l'operazione giusta. E' lo stesso presidio
 * di `keepOperationsOfOrder` in srv/lib/prodOrderSource.js.
 *
 * @param {object[]} rows righe di A_ProductionOrderOperation_2
 * @param {string} wanted operazione desiderata, p.es. '0020'
 * @returns {{op: object|null, exact: boolean, reason: string}}
 */
function pickOperation(rows, wanted) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!list.length) return { op: null, exact: false, reason: 'nessuna operazione letta per quest\'ordine' };
  const w = String(wanted == null ? '' : wanted).trim();
  // Il confronto tollerante e' `sameOrderKey`: era scritto qui dentro, ed e' uscito perche' ora
  // serve anche a riconoscere l'ordine che l'iFlow restituisce ([CONF-OUTCOME]). Stessa regola, un
  // punto solo: due copie di un confronto sugli zeri divergono senza dare nessun errore.
  const hit = w ? list.find((r) => sameOrderKey(r.ManufacturingOrderOperation, w)) : null;
  if (hit) return { op: hit, exact: true, reason: `operazione ${w} trovata fra le ${list.length} lette` };
  return {
    op: list[0],
    exact: false,
    reason: w
      ? `operazione ${w} NON presente fra le ${list.length} lette (`
        + `${list.map((r) => r.ManufacturingOrderOperation).join(', ')}): si ripiega sulla prima`
      : `nessuna operazione richiesta: si prende la prima delle ${list.length}`
  };
}

module.exports = {
  internalKey,
  internalConfKeys,
  sameOrderKey,
  pickOperation,
  CONF_KEY_LENGTHS
};
