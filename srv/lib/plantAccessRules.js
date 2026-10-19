/**
 * [PLANT-ACCESS] Regole pure del perimetro plant PER UTENTE (feature 0048).
 *
 * PERCHE' ESISTE. Fino alla 0048 il perimetro era per PLANT e non per persona: `getActivePlants()`
 * rendeva `Status='Active'` intersecato con la licenza, e qualunque utente autenticato vedeva i dati
 * di tutti i plant licenziati. Ogni cliente ha la sua istanza, quindi non era una fuga fra clienti:
 * era dentro l'azienda — un utente abilitato al plant A vedeva i materiali e gli ordini del plant B,
 * e poteva inviarli al tenant Plex di B, che e' un tenant diverso (la connessione Plex e' per plant,
 * feature 0020). Il check per utente esisteva gia' (`getUserRole` in srv/license.js) ma serviva UN
 * plant alla volta, per la scheda di configurazione: non era mai stato usato per filtrare un INSIEME.
 * Qui stanno le decisioni che si possono verificare senza rete e senza database: quale ruolo abilita
 * cosa, quale ruolo vince quando il license server ne restituisce piu' di uno, che verdetto dare a
 * una coppia (utente, plant), e se la richiesta corrente ha un utente da valutare.
 * L'orchestrazione — che chiama il license server, tiene la cache e scrive i log — sta in
 * srv/lib/plantAccess.js.
 *
 * NESSUNA DIPENDENZA: ne' `cds` ne' la rete. Test: `node test/plantAccessRules.test.js`.
 *
 * LE TRE SOGLIE SONO TRE, E NON SI FONDONO. Il repo ne aveva gia' due e la 0048 aggiunge la terza:
 *   - `enablesFullAdmin`  -> solo 'admin'. E' `rejectIfNotFullAdmin` (cat-service.js), il gate dei
 *     due segreti Plex di `ZPlexConnConfig`, della cancellazione di un plant e dell'ATTIVAZIONE.
 *   - `enablesPlantConfig` -> 'admin' e 'admin-config'. E' il contratto della function `getUserRole`
 *     e del client di adminconfigplant.
 *   - `enablesDashboard`  -> tutti e tre, 'user' compreso. E' la 0048: sul cockpit operativo chi ha
 *     un ruolo qualsiasi su un plant ne vede i dati.
 * Fonderle sarebbe una regressione di sicurezza in un verso e una tendina vuota nell'altro.
 *
 * IL PROCESSO VINCE SUL CHIAMANTE, e l'ordine di `identifyKind` non e' un dettaglio. Dentro un run
 * batch `req.user` E' l'utente anonimo di CAP, e due job (MAT_SYNC e ROUTING_SYNC) eseguono gli
 * handler di cat-service.js NEL PROPRIO PROCESSO — `cds.serve('all')` in srv/jobs/lib/runJob.js.
 * Valutare l'identita' prima del processo li farebbe cadere sul rifiuto per ogni oggetto trattato.
 * E' la stessa forma di srv/lib/isEgress.js (DEC-98): il perimetro e' il processo.
 *
 * Perimetro: grep -rn "PLANT-ACCESS".
 */

'use strict';

/**
 * I ruoli che il license server puo' restituire, DAL PIU' FORTE AL PIU' DEBOLE.
 *
 * E' un insieme chiuso ED E' l'ordine di forza: le due cose stanno in un elenco solo perche' erano
 * la stessa informazione scritta in due modi. Prima della 0048 l'insieme viveva in
 * `RECOGNIZED_ROLES` dentro srv/license.js — cioe' dentro il TRASPORTO — e il filtro la' dentro
 * scartava 'user' prima che raggiungesse qualunque chiamante: la 0048 ha bisogno di quel ruolo,
 * quindi il trasporto ora rende il ruolo grezzo e a decidere sono i tre predicati qui sopra.
 */
const ROLE_PRECEDENCE = ['admin', 'admin-config', 'user'];

/** I ruoli che abilitano la DASHBOARD: tutti quelli riconosciuti (feature 0048). */
const DASHBOARD_ROLES = new Set(ROLE_PRECEDENCE);
/** I ruoli che abilitano la CONFIGURAZIONE di un plant. Contratto della function `getUserRole`. */
const PLANT_CONFIG_ROLES = new Set(['admin', 'admin-config']);
/** Il solo ruolo che abilita i segreti, la cancellazione di un plant e l'attivazione. */
const FULL_ADMIN_ROLE = 'admin';

/** I verdetti di `classifyPlantAccess`. Sono cinque e NON si collassano: vedi il docblock la'. */
const ACCESS = Object.freeze({
  GRANTED: 'GRANTED',
  NO_ROLE: 'NO_ROLE',
  NOT_LICENSED: 'NOT_LICENSED',
  NOT_ACTIVE: 'NOT_ACTIVE',
  UNKNOWN: 'UNKNOWN'
});

/** Gli esiti di `identifyKind`. Due, e il primo vince (vedi il docblock del modulo). */
const KIND = Object.freeze({ USER: 'USER', BATCH: 'BATCH' });

/**
 * Il ruolo, normalizzato: senza spazi, minuscolo, e `null` se non e' uno dei riconosciuti.
 *
 * Il confronto e' TOLLERANTE perche' il valore lo scrive un sistema esterno (il license server) e
 * non un utente ne' SAP: e' la regola di DEC-51 applicata a questo campo. Un valore che non
 * riconosciamo rende `null`, cioe' «nessun ruolo», e non un ruolo sconosciuto da trattare con
 * prudenza: un insieme chiuso e' l'unica difesa contro un valore nuovo che il server introducesse.
 */
function normalizeRole(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  return ROLE_PRECEDENCE.includes(s) ? s : null;
}

/**
 * `true` se nessun ruolo puo' essere piu' forte di questo.
 *
 * SERVE A NON PAGARE LA DISCOVERY PER INTERO. `checkUserRoleLive` prova le API key di
 * `ZLicenseConfig` IN SERIE, e prima della 0048 si fermava alla prima che rendeva un ruolo. Col
 * ruolo grezzo quella regola diventa sbagliata: se la chiave A risponde 'user' e la B 'admin',
 * fermarsi su A DEGRADEREBBE un amministratore, che perderebbe l'accesso alla configurazione.
 * La difesa e' tenere il ruolo piu' forte — ma iterare sempre tutte le chiavi farebbe costare K
 * chiamate seriali anche all'utente ABILITATO, cioe' il caso normale. Con questa uscita il costo
 * pieno resta a chi non ha nessun ruolo, che e' anche l'unico caso in cui serve davvero.
 */
function isStrongestRole(role) {
  return normalizeRole(role) === ROLE_PRECEDENCE[0];
}

/**
 * Il ruolo piu' forte fra quelli passati, `null` se nessuno e' riconosciuto.
 *
 * @param {Iterable<string>} roles i ruoli grezzi raccolti dalla discovery sulle API key
 */
function strongestRole(roles) {
  if (!roles || typeof roles[Symbol.iterator] !== 'function') return null;
  let best = null;
  let bestRank = ROLE_PRECEDENCE.length;
  for (const raw of roles) {
    const role = normalizeRole(raw);
    if (!role) continue;
    const rank = ROLE_PRECEDENCE.indexOf(role);
    if (rank < bestRank) { best = role; bestRank = rank; }
    if (rank === 0) break;   // nessuno puo' essere piu' forte: la ricerca finisce qui
  }
  return best;
}

/** `true` se il ruolo abilita a vedere i dati di un plant nel cockpit (feature 0048). */
function enablesDashboard(role) {
  const r = normalizeRole(role);
  return !!r && DASHBOARD_ROLES.has(r);
}

/** `true` se il ruolo abilita la scheda di configurazione del plant. */
function enablesPlantConfig(role) {
  const r = normalizeRole(role);
  return !!r && PLANT_CONFIG_ROLES.has(r);
}

/** `true` solo per 'admin': i segreti Plex, la cancellazione di un plant, l'attivazione. */
function enablesFullAdmin(role) {
  return normalizeRole(role) === FULL_ADMIN_ROLE;
}

/**
 * Il verdetto per una coppia (utente, plant). Cinque valori, e nessuno si collassa su un altro.
 *
 * PERCHE' CINQUE E NON DUE. Un perimetro che si svuota obbliga a DICHIARARE perche' (DEC-52), e le
 * cause hanno rimedi diversi: il plant non e' attivo (customizing), non e' licenziato
 * (`ZLicenseConfig`), l'utente non ha un ruolo (license server), oppure NON SI SA — il server non
 * ha risposto e il grace e' esaurito. L'ultima non e' «nessun ruolo»: «vuoto non e' ignoto», ed e'
 * la regola che il progetto applica dal DEC-112 in poi. Chi rende un verdetto solo booleano
 * costringe la schermata a indovinare, e la schermata indovina male.
 *
 * L'ORDINE DI VALUTAZIONE E' PARTE DELLA REGOLA. Le tre condizioni sono INDIPENDENTI — il ramo
 * ruolo di srv/license.js non legge `Valid` e non consulta `ZPlant`, quindi un ruolo positivo non
 * prova ne' che il plant sia attivo ne' che sia licenziato — ma il loro ordine decide QUALE causa
 * si dichiara quando piu' di una vale. Si va dalla piu' locale alla piu' remota: cosi' un plant
 * disattivato non si presenta come «non hai un ruolo», che manderebbe a chiedere un'abilitazione
 * per un plant che nessuno sta usando.
 *
 * @param {object}  o
 * @param {boolean} o.active     `ZPlant.Status === 'Active'`
 * @param {boolean} o.licensed   il verdetto di licenza per il plant
 * @param {?string} o.role       il ruolo grezzo dell'utente su quel plant
 * @param {boolean} o.roleKnown  `false` = non si e' potuto sapere (server giu', grace esaurito)
 * @returns {string} uno dei valori di `ACCESS`
 */
function classifyPlantAccess({ active, licensed, role, roleKnown } = {}) {
  if (!active) return ACCESS.NOT_ACTIVE;
  if (!licensed) return ACCESS.NOT_LICENSED;
  if (roleKnown === false) return ACCESS.UNKNOWN;
  return enablesDashboard(role) ? ACCESS.GRANTED : ACCESS.NO_ROLE;
}

/** `true` se il verdetto ammette l'utente al plant. E' l'unico verdetto che lo fa. */
function accessGranted(verdict) {
  return verdict === ACCESS.GRANTED;
}

/**
 * Che tipo di richiesta stiamo servendo: quella di una persona, o un run batch?
 *
 * IL PROCESSO VINCE SUL CHIAMANTE. `batchEnv` e' il marcatore `MARS_BATCH_JOB` (srv/lib/isEgress.js),
 * scritto dal bootstrap dei job PRIMA di `cds.serve('all')`: dentro quel processo gli handler di
 * cat-service.js girano per tutti e 13 i servizi, e `req.user` e' l'utente anonimo di CAP. Se si
 * guardasse l'identita' per prima, MAT_SYNC e ROUTING_SYNC — i due job che invocano action di
 * servizio con `send()` nudo — cadrebbero sul rifiuto per ogni oggetto trattato.
 *
 * NESSUN RAMO PER L'ANONIMO, ED E' UNA DECISIONE. `req.user.id` non e' mai `null` quando non c'e'
 * un utente: CAP rende l'utente `default`, con `id: 'anonymous'` (@sap/cds/lib/req/user.js). Quindi
 * l'idioma `req.user?.id || … || null`, che il repo usa in tre punti, non rileva MAI l'assenza — i
 * suoi rami «senza email -> 403» sono codice morto. La 0048 non prova a ricostruire quella
 * distinzione: 'anonymous' e' l'identita' che si manda al license server, e a decidere e' lui.
 * Conseguenza dichiarata: in locale la dashboard resta vuota finche' 'anonymous' non e' censito su
 * una licenza. Il rimedio e' una riga sul license server, non una leva nel codice.
 *
 * @param {object}  o
 * @param {?string} o.userId    `req.user.id` (o la mail, se l'IdP la mette altrove)
 * @param {?string} o.batchEnv  il valore di `process.env.MARS_BATCH_JOB`, letto AL MOMENTO DELL'USO
 * @returns {{kind: string, email: string}} `email` e' `''` quando non c'e' un'identita' utilizzabile
 */
function identifyKind({ userId, batchEnv } = {}) {
  if (batchEnv !== null && batchEnv !== undefined && String(batchEnv).trim() !== '') {
    return { kind: KIND.BATCH, email: '' };
  }
  return { kind: KIND.USER, email: String(userId === null || userId === undefined ? '' : userId).trim() };
}

/**
 * [PLANT-ACCESS] La chiave i18n che spiega un plant rifiutato (feature 0048).
 *
 * QUATTRO CAUSE, QUATTRO RIMEDI: il customizing (plant non attivo), la licenza, l'abilitazione
 * dell'utente, e «non si e' potuto sapere» — che NON e' «non hai un ruolo»: il primo si riprova, il
 * secondo si chiede. Un messaggio solo per tutte manderebbe a cercare il rimedio sbagliato.
 *
 * `plantNotLicensedUse` E NON `plantNotLicensed`: quest'ultima esiste da prima e dice «impossibile
 * attivarlo», perche' e' il messaggio del gate di ATTIVAZIONE di un plant. Riusarla per un'azione
 * qualunque — creare un job, salvare un ciclo — nominerebbe un rimedio che non c'entra.
 *
 * Le chiavi vivono nel bundle `adminconfigplant`, dove sono gli altri messaggi dei gate. Che
 * esistano in entrambe le lingue lo sorveglia test/plantAccessRules.test.js: una chiave che manca
 * non da' errore, esce come CHIAVE GREZZA a schermo.
 */
const MESSAGE_KEYS = Object.freeze({
  [ACCESS.NOT_ACTIVE]: 'plantNotActive',
  [ACCESS.NOT_LICENSED]: 'plantNotLicensedUse',
  [ACCESS.NO_ROLE]: 'plantNoRole',
  [ACCESS.UNKNOWN]: 'plantRoleUnknown'
});

/**
 * La chiave i18n per un verdetto di rifiuto.
 * @param {string} verdict uno dei valori di `ACCESS`
 * @returns {?string} `null` per `GRANTED`, che non e' un rifiuto e non ha niente da spiegare
 */
function messageKeyFor(verdict) {
  if (verdict === ACCESS.GRANTED) return null;
  // Un verdetto che non conosciamo si spiega come «non si e' potuto sapere», non come un'assenza
  // di ruolo: e' la direzione che non accusa l'utente di un difetto nostro.
  return MESSAGE_KEYS[verdict] || MESSAGE_KEYS[ACCESS.UNKNOWN];
}

/**
 * [PLANT-ACCESS] La busta del perimetro, divisa in CONCESSI ed ESCLUSI (feature 0048).
 *
 * PERCHE' E' UNA REGOLA PURA E NON TRE RIGHE NELL'HANDLER. Decide cosa finisce nella TENDINA del
 * cockpit: un plant che passasse dalla parte sbagliata sarebbe un plant fuori perimetro offerto
 * all'utente come se fosse suo — il difetto esatto che la feature esiste per impedire, e non
 * darebbe nessun errore. Qui e' verificabile senza database, senza rete e senza CAP.
 *
 * `granted` E `excluded` PARTIZIONANO: ogni plant valutato sta in uno dei due, e l'appartenenza la
 * decide `plants` (l'insieme che l'hub ha concesso), non il verdetto — cosi' un verdetto nuovo
 * aggiunto domani non finisce fra i concessi per distrazione.
 *
 * @param {object} o
 * @param {Map<string,{verdict:string,role:?string,roleKnown:boolean}>} o.byPlant i plant valutati
 * @param {Set<string>} o.plants  i plant CONCESSI
 * @param {Map<string,string>} [o.names] plant -> nome, per la tendina
 * @returns {{granted: Array<object>, excluded: Array<object>}} righe ordinate per codice
 */
function splitScope({ byPlant, plants, names } = {}) {
  const entries = byPlant instanceof Map ? [...byPlant.entries()] : [];
  const allowed = plants instanceof Set ? plants : new Set(plants || []);
  const nameOf = names instanceof Map ? names : new Map();
  const granted = [];
  const excluded = [];
  for (const [plant, v] of entries) {
    const row = {
      Plant: plant,
      Name: nameOf.get(plant) || '',
      Verdict: (v && v.verdict) || ACCESS.UNKNOWN,
      // `roleKnown` assente vale «saputo»: l'unico caso che deve uscire `false` e' quello in cui
      // l'hub lo dichiara esplicitamente. Il contrario renderebbe ogni plant un guasto.
      RoleKnown: !(v && v.roleKnown === false),
      // [MASS-IMPORT] IL RUOLO ESCE, e prima veniva scartato qui dentro. `resolveUserPlants` lo
      // risolve gia' — deve, per distinguere GRANTED da NO_ROLE — quindi restituirlo non costa
      // nessuna chiamata in piu' al license server, che di richieste ne fa sedici per apertura.
      // Serve al cockpit per sapere se mostrare i gesti che sono di CONFIGURAZIONE e non di
      // esercizio: la soglia e' `enablesPlantConfig`, non «ho un ruolo».
      //
      // NORMALIZZATO, e non grezzo: il confronto lato client e' su due letterali, e un `Admin`
      // maiuscolo dall'hub spegnerebbe il pulsante senza dare nessun errore.
      //
      // Stringa vuota e non `null` quando il ruolo non c'e' o non si sa: `RoleKnown` dice gia'
      // quale dei due casi e', e un `null` in un campo `String` di OData esce comunque come
      // assente — due modi di dire la stessa cosa su cui il client dovrebbe ragionare.
      Role: normalizeRole(v && v.role) || ''
    };
    (allowed.has(plant) ? granted : excluded).push(row);
  }
  const byCode = (a, b) => String(a.Plant).localeCompare(String(b.Plant));
  granted.sort(byCode);
  excluded.sort(byCode);
  return { granted, excluded };
}

module.exports = {
  ROLE_PRECEDENCE,
  ACCESS,
  KIND,
  splitScope,
  messageKeyFor,
  MESSAGE_KEYS,
  normalizeRole,
  isStrongestRole,
  strongestRole,
  enablesDashboard,
  enablesPlantConfig,
  enablesFullAdmin,
  classifyPlantAccess,
  accessGranted,
  identifyKind
};
