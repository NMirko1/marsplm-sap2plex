/**
 * [PLANT-ACCESS] Il perimetro plant di CHI STA CHIEDENDO: l'orchestrazione (feature 0048).
 *
 * PERCHE' ESISTE, E PERCHE' QUI. Fino alla 0048 il perimetro era `Status='Active'` intersecato con
 * la licenza, e bastava essere autenticati per vedere i dati di tutti i plant licenziati — su un
 * progetto multi-cliente, i materiali e gli ordini di un altro cliente. Il pezzo che mancava non
 * era il check — `getUserRole` esiste dalla 0020 — ma il fatto che servisse UN plant alla volta.
 * Qui quel check diventa un insieme, e sta in `srv/lib/` perche' le funzioni del choke-point non
 * sono esportabili: `srv/cat-service.js` ha un solo `module.exports`, ed e' l'impl del servizio.
 *
 * DIPENDE DA `srv/license.js` (rete) MA NON DA `cds` NE' DAL DATABASE: gli insiemi di partenza —
 * i plant attivi e quelli licenziati — glieli passa il chiamante, che e' l'unico a sapere da quale
 * delle due sorgenti dell'elenco plant vengono (il cockpit da `getActiveStatusPlants`, i job da
 * `resolveActivePlants`). Le decisioni pure stanno accanto, in srv/lib/plantAccessRules.js.
 * Test: `node test/plantAccess.test.js`.
 *
 * IL PROCESSO VINCE SUL CHIAMANTE, e non e' un dettaglio di stile. Due job — MAT_SYNC e
 * ROUTING_SYNC — fanno `cds.serve('all')` nel proprio processo (srv/jobs/lib/runJob.js) e invocano
 * action di servizio con `send()` nudo: la' dentro gli handler di cat-service.js girano per tutti e
 * 13 i servizi e `req.user` E' l'utente anonimo di CAP. Se il gate guardasse l'identita' per prima,
 * quei due job rifiuterebbero ogni oggetto trattato. E' la stessa forma di srv/lib/isEgress.js
 * (DEC-98), da cui questo modulo prende anche il NOME della variabile: un marcatore ripetuto in due
 * file e' un marcatore che divergera'.
 *
 * IL MARCATORE SI LEGGE AL MOMENTO DELL'USO. Al `require` direbbe «server web» dentro ogni job: il
 * bootstrap lo scrive DOPO che i file del job hanno fatto i loro `require`
 * (srv/lib/isCallDumpRules.js lo dichiara).
 *
 * Perimetro: grep -rn "PLANT-ACCESS".
 */

'use strict';

const R = require('./plantAccessRules');
const { IS_BATCH_ENV } = require('./isEgress');
const { getUserPlantRole } = require('../license');

/**
 * Le risoluzioni IN VOLO, per coppia `email::plant`.
 *
 * E' SINGLE-FLIGHT, NON UNA CACHE DI VALORI, e la differenza e' la decisione di progetto sulla
 * politica: il positivo lo tiene `roleCacheScope` dentro srv/license.js per 24 h, il negativo non
 * lo tiene NESSUNO — un utente appena abilitato deve vedere il plant subito. Qui si condivide
 * soltanto la chiamata mentre e' in corso, e la voce si sfratta appena risolta.
 *
 * SERVE PERCHE' L'APERTURA DELLA DASHBOARD E' CONCORRENTE: `onInit` lancia il perimetro ordini e le
 * tre liste senza attendersi, piu' la busta dei plant. Su cache fredda sono cinque risoluzioni
 * dello stesso insieme nello stesso istante, cioe' cinque volte P x K chiamate al license server
 * nel momento peggiore. Il modello e' srv/lib/productDetailCache.js: si mette in cache la PROMESSA,
 * non il risultato.
 */
const inFlight = new Map();

/** Il ruolo di una coppia, condividendo la chiamata con chi la sta gia' aspettando. */
function roleOnce(email, plant) {
  const key = `${email}::${plant}`;
  const hit = inFlight.get(key);
  if (hit) return hit;
  const p = getUserPlantRole(email, plant)
    .catch((e) => {
      // Un guasto non previsto non e' un «nessun ruolo»: esce come NON SAPUTO, quindi il verdetto
      // sara' UNKNOWN e la schermata potra' dirlo. «Vuoto non e' ignoto».
      console.error(`>>> [PLANT-ACCESS] risoluzione del ruolo fallita per ${plant} - ${e.message}`);
      return { role: null, known: false };
    })
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

/**
 * Chi sta chiedendo: una persona, o un run batch?
 *
 * L'identita' si ricava SEMPRE lato server da `req.user` e mai dal client. Non c'e' nessun ramo per
 * l'anonimo: CAP rende `id: 'anonymous'` quando non c'e' un utente, e quella e' l'identita' che si
 * manda al license server — a decidere e' lui. Conseguenza dichiarata: in locale la dashboard resta
 * vuota finche' 'anonymous' non e' censito su una licenza.
 *
 * @param {object} req la richiesta CAP, oppure `null`/`undefined` fuori da una richiesta
 * @returns {{kind: string, email: string}}
 */
function identify(req) {
  const u = req && req.user;
  const userId = (u && (u.id || (u.attr && u.attr.email))) || '';
  return R.identifyKind({ userId, batchEnv: process.env[IS_BATCH_ENV] });
}

/**
 * Il perimetro di questo richiedente: quali plant vede, e con che verdetto ognuno.
 *
 * @param {Iterable<string>} activePlants   i plant `Status='Active'` (dal database)
 * @param {Iterable<string>} licensedPlants il sottoinsieme licenziato (da `getUsablePlants`)
 * @param {{kind: string, email: string}} who l'esito di `identify(req)`
 * @returns {Promise<{plants: Set<string>, byPlant: Map<string, object>, roleReadOk: boolean, reason: string}>}
 *   `plants` e' l'insieme da usare come perimetro; `byPlant` porta il verdetto di OGNI plant attivo,
 *   compresi quelli esclusi, perche' un perimetro che si svuota deve dichiarare PERCHE' (DEC-52).
 */
async function resolveUserPlants(activePlants, licensedPlants, who = {}) {
  const active = [...(activePlants || [])];
  const licensed = licensedPlants instanceof Set ? licensedPlants : new Set(licensedPlants || []);
  const byPlant = new Map();

  // Un run batch non ha un utente da valutare: il perimetro e' quello di sempre (attivo +
  // licenziato). E' la decisione della feature, e i sette job continuano a passare da la'.
  if (who.kind === R.KIND.BATCH) {
    for (const p of active) {
      byPlant.set(p, licensed.has(p)
        ? { verdict: R.ACCESS.GRANTED, role: null, roleKnown: true }
        : { verdict: R.ACCESS.NOT_LICENSED, role: null, roleKnown: true });
    }
    return {
      plants: new Set(active.filter((p) => licensed.has(p))),
      byPlant,
      roleReadOk: true,
      reason: 'run batch: nessun utente da valutare, perimetro attivo + licenziato'
    };
  }

  // Nessuna identita' utilizzabile: non si chiede niente al license server e non si mostra niente.
  // Fail-closed DICHIARATO — il verdetto non e' «non hai un ruolo», e' «non lo so».
  if (!who.email) {
    for (const p of active) {
      byPlant.set(p, { verdict: R.ACCESS.UNKNOWN, role: null, roleKnown: false });
    }
    console.warn('>>> [PLANT-ACCESS] nessuna identita\' nella richiesta: perimetro VUOTO'
      + ` (${active.length} plant attivi non valutati)`);
    return {
      plants: new Set(),
      byPlant,
      roleReadOk: false,
      reason: 'identita\' non determinabile: nessun plant valutato'
    };
  }

  // Il ruolo si chiede SOLO sui plant licenziati. Su un plant senza licenza il server non
  // risponderebbe comunque un ruolo (lo rende solo con `Valid=true`), quindi sarebbe una chiamata
  // il cui esito conosciamo — e il verdetto giusto e' l'altro: la causa e' la licenza, non il ruolo.
  const resolved = await Promise.all(active.map(async (plant) => {
    if (!licensed.has(plant)) {
      return { plant, verdict: R.ACCESS.NOT_LICENSED, role: null, roleKnown: true };
    }
    const { role, known } = await roleOnce(who.email, plant);
    return {
      plant,
      verdict: R.classifyPlantAccess({ active: true, licensed: true, role, roleKnown: known }),
      role,
      roleKnown: known
    };
  }));

  const plants = new Set();
  let unknown = 0;
  for (const r of resolved) {
    byPlant.set(r.plant, { verdict: r.verdict, role: r.role, roleKnown: r.roleKnown });
    if (R.accessGranted(r.verdict)) plants.add(r.plant);
    if (r.verdict === R.ACCESS.UNKNOWN) unknown++;
  }

  const counts = {};
  for (const r of resolved) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const detail = Object.keys(counts).sort().map((k) => `${k}=${counts[k]}`).join(' ');
  console.log(`>>> [PLANT-ACCESS] perimetro utente: ${plants.size}/${active.length} plant`
    + (detail ? ` (${detail})` : ''));

  return {
    plants,
    byPlant,
    // `false` = almeno un plant non si e' potuto valutare. Non e' «nessun ruolo»: chi dichiara il
    // perimetro deve poter distinguere un guasto da un'esclusione, o mandera' a chiedere
    // un'abilitazione per un license server caduto.
    roleReadOk: unknown === 0,
    reason: unknown
      ? `${unknown} plant su ${active.length} non valutati: license server non raggiungibile`
      : ''
  };
}

module.exports = { identify, resolveUserPlants };
