/**
 * [MAT-PLANT-PAIR] Quale part occupa il numero che Plex ci ha appena rifiutato.
 *
 * PERCHE' ESISTE
 * `POST /mdm/v1/parts` risponde `400 REQUEST_VALIDATION_FAILED` quando il numero part e' gia'
 * preso, e dentro `errors[].metadata.id` mette L'ID DELLA PART CHE LO OCCUPA. E' l'unica cosa che
 * serve per riagganciare il dizionario e proseguire con un aggiornamento: il rifiuto contiene gia'
 * la risposta.
 *
 * Il 14/09/2026 il materiale 025032052001 / plant 07 si e' fermato in errore proprio li'. In
 * srv/cat-service.js i POST a `/mdm/v1/parts` sono DUE — il ripiego dopo un `404` sulla PUT, e il
 * ramo senza mapping locale — e solo il secondo leggeva quel campo: il primo lanciava, buttando via
 * l'id che Plex gli aveva appena consegnato. Due copie della stessa decisione, divergenti. Questo
 * modulo e' la decisione, in un punto solo, e i due ramo la chiamano.
 *
 * SI TOLLERANO LE DUE FORME DEL CORPO, e non e' pedanteria: i due ramo arrivavano qui con corpi
 * diversi — `finalizeHttpExchange` consegna un oggetto gia' parsato, `response.text()` una stringa.
 * Una funzione che accettasse solo l'oggetto renderebbe `null` sul ramo che leggeva il testo, cioe'
 * proprio quello che questa correzione esiste per sistemare, e lo farebbe SENZA ERRORE: si
 * tornerebbe a lanciare come oggi.
 *
 * UN ID AMBIGUO SI RIFIUTA. Con due errori di duplicato che nominano id diversi non sappiamo quale
 * part occupi il numero, e scrivere quello sbagliato nel dizionario significa riversare i dati SAP
 * di questo materiale su UN'ALTRA part di quel tenant. Meglio l'errore di oggi: e' la stessa regola
 * della chiave ambigua di orderBomAdd e di plexJobRead (DEC-86, DEC-80).
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' orologio. Non aggiungerne: il test si lancia
 * con
 *     node test/plexDuplicateRules.test.js
 * Stessa convenzione di srv/lib/matPlantRules.js e srv/lib/splitRules.js.
 *
 * Nessuna funzione muta l'input.
 *
 * Perimetro: grep -rn "PART-DUPLICATE"
 */

'use strict';

/**
 * Il codice d'errore con cui Plex dichiara che la combinazione di campi e' gia' presa.
 * Esportato perche' e' anche cio' che il test di invariante cerca in srv/cat-service.js.
 */
const DUPLICATE_CODE = 'COMPOSITE_FIELD_REFERENCE_YIELDS_DUPLICATE';

/**
 * Il corpo di una risposta Plex come oggetto, qualunque forma sia arrivata.
 *
 * @param {*} body oggetto gia' parsato, oppure il testo JSON grezzo
 * @returns {object|null} `null` se non e' un oggetto interpretabile
 */
function bodyOf(body) {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
      return null;
    }
  }
  return (body && typeof body === 'object') ? body : null;
}

/**
 * L'id della part che occupa il numero, se il rifiuto e' un duplicato.
 *
 * @param {*} body corpo della risposta di `POST /mdm/v1/parts` (oggetto o testo JSON)
 * @returns {string|null} l'id, oppure `null` se il rifiuto non e' un duplicato, se l'id non c'e',
 *                        o se e' AMBIGUO (due id diversi). In tutti e tre i casi il chiamante
 *                        lancia, com'e' sempre stato.
 */
function duplicateIdOf(body) {
  const parsed = bodyOf(body);
  if (!parsed) return null;

  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  const ids = [];
  for (const err of errors) {
    if (!err || err.code !== DUPLICATE_CODE) continue;
    const id = err.metadata && err.metadata.id;
    // Una stringa vuota non e' un id: il `trim` evita che uno spazio diventi una chiave di
    // dizionario su cui poi si scrive.
    const clean = typeof id === 'string' ? id.trim() : '';
    if (clean && !ids.includes(clean)) ids.push(clean);
  }

  // Zero: non e' un duplicato, o Plex non ha detto quale part. Due o piu': ambiguo, vedi l'intestazione.
  return ids.length === 1 ? ids[0] : null;
}

module.exports = { DUPLICATE_CODE, duplicateIdOf, bodyOf };
