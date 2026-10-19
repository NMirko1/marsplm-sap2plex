/**
 * [IS-EGRESS] Come esce da QUESTO processo una chiamata verso gli iFlow di SAP Integration Suite:
 * su quale destination.
 *
 * PERCHE' UNA DESTINATION DIVERSA DENTRO UN JOB
 * `MARS_SAP_CON` usa `OAuth2SAMLBearerAssertion`, che PRETENDE il JWT dell'utente: CAP lo prende da
 * `cds.context.user.authInfo.token.jwt`, il Cloud SDK lo scambia con un'asserzione SAML, e solo
 * allora la chiamata parte (vedi il blocco `[IS-NO-USER]` in isRemoteSource.js). Un run batch NON ha
 * un utente collegato, quindi su quella destination nessuna sua chiamata può funzionare a regime.
 * `MARS_SAP_CON_BA` è la destination con utenza tecnica: la decisione va presa una volta,
 * `resolveEgress()` qui sotto la prende, e i quattro punti d'uscita la applicano.
 *
 * L'HEADER APPLICATIVO NON PARTE PIU' (28/08/2026)
 * Fino al 28/08/2026 la destination viaggiava insieme a un header applicativo `AuthType: Basic`, che
 * diceva all'iFlow con quale autenticazione proseguire verso ECC — «un solo interruttore», diceva la
 * DEC-98. Non lo è più: l'header è stato RIMOSSO da ogni canale, e questo modulo decide SOLO la
 * destination. Non va rimesso qui: se un giorno servisse di nuovo, l'esperimento per rimandarlo è
 * `scripts/isAuthTypeSample.js`, e la decisione si prende col team Integration. Che non torni di
 * nascosto in un `before('*')` lo sorveglia `test/isEgress.test.js`, che cerca quel nome nel CODICE
 * di tutto `srv/` — spogliato dai commenti, perché nei commenti (come qui) serve a spiegare.
 *
 * PERCHE' UN MODULO E NON QUATTRO COSTANTI
 * Le chiamate verso gli iFlow escono da punti che NON condividono niente fra loro: le letture delle
 * cinque aree dati passano dalla factory (srv/lib/isRemoteSource.js — materiali, ordini, cicli,
 * classificazione e distinta, perché clfnSource.js e bomSource.js la usano), mentre il documento
 * materiale, la conferma d'ordine e la chiusura tecnica hanno ognuno la propria istanza remota e la
 * propria `connect()` (materialDocPost.js, prodOrderConfPost.js, prodOrderStatusPost.js). Un nome di
 * destination ripetuto in quattro file è un nome che divergerà: il giorno in cui cambia, il punto
 * dimenticato non dà errore — dà una chiamata che esce da una destination sbagliata, letta lontano
 * dalla causa. Qui il nome esiste una volta sola, e `test/isEgress.test.js` sorveglia che i quattro
 * punti passino da qui.
 *
 * SOLO DENTRO UN JOB, E NIENTE FUORI
 * Il perimetro è il PROCESSO: un run batch. Nessuna chiamata del server web — cockpit, azioni
 * manuali, sonde — deve uscire sulla destination tecnica: uscirebbe con credenziali che non sono di
 * chi sta usando l'applicazione, e smetterebbe di essere la chiamata di quell'utente. Il 26/08/2026
 * il costo di un perimetro più largo si è visto sull'header, quando era ancora in esercizio:
 * agganciato all'istanza per service root, che è UNA e condivisa, partiva su tutte le letture IS del
 * progetto e la lista ordini della dashboard rispondeva `500 INTERNAL_SERVER_ERROR` dove senza
 * rispondeva `200`. Isolare per CHIAMANTE non si può, le istanze sono le stesse; isolare per
 * PROCESSO sì, ed è quello che serve.
 *
 * `MARS_SAP_CON` NON STA QUI, DI PROPOSITO
 * La destination del server web resta il default di ciascun chiamante (package.json, `cds.requires`,
 * o il `DEFAULTS` del modulo): `resolveEgress` la riceve e, fuori da un run batch, la restituisce
 * VERBATIM. Ridefinirla da qui vorrebbe dire un secondo posto da cui il canale del cockpit dipende.
 *
 * UNA TERZA VIA E' ESISTITA PER UN GIORNO, E NON VA RIMESSA (03/09/2026)
 * Il 03/09/2026 `resolveEgress` ha accettato per qualche ora un `opts.force === 'batch'`: una richiesta
 * esplicita di canale batch da parte del chiamante, che permetteva alla sonda del canale ordini di
 * eseguire dal SERVER WEB la stessa lettura sui due canali. La sonda ha risposto — mancano le
 * autorizzazioni dell'identità che arriva a ECC da un run batch (DEC-123) — ed è stata rimossa, e
 * `force` con lei.
 *
 * Non si rimette «perché un giorno servirà». Senza chiamanti è una via DORMIENTE per cui il server web
 * può uscire sull'utenza tecnica, cioè esattamente ciò che il blocco qui sopra vieta, e nessun test la
 * copre più. Il giorno che serve di nuovo si riscrive in quindici righe: il metodo — la stessa lettura
 * sui due canali dallo stesso processo, con lo stesso lettore e lo stesso trasporto — sta in DEC-123.
 *
 * Nessuna dipendenza: né `cds`, né rete, né stato. Non aggiungerne — il test si lancia con
 * `node test/isEgress.test.js`, senza runtime CAP.
 */

'use strict';

/**
 * La destination con utenza tecnica, usata da OGNI chiamata di un run batch. E' l'unico posto del
 * progetto in cui questo nome esiste, e un test lo asserisce su tutto `srv/`.
 *
 * NON è dichiarata in `mta.yaml`: come `MARS_SAP_CON` è una destination di subaccount creata a mano
 * nel cockpit BTP. Se non esiste, le chiamate dei job muoiono sulla risoluzione della destination —
 * e il rientro immediato è `IS_BATCH_EGRESS=off` sul task, senza rilascio.
 */
const BATCH_DESTINATION = 'MARS_SAP_CON_BA';

/**
 * Il marcatore che un run batch mette nel PROPRIO ambiente: lo scrive `srv/jobs/lib/runJob.js`,
 * bootstrap unico dei cinque job (`npm run job-*`, `cf run-task` e il `fork` di `[JOB-TRIGGER]`
 * passano tutti da lì, DEC-97). Il server web non lo imposta mai, e il figlio del `fork` erediterebbe
 * l'ambiente del padre — dove non c'è.
 */
const IS_BATCH_ENV = 'MARS_BATCH_JOB';

/**
 * Leva di AMBITO: `off` riporta un run batch sulla destination configurata dal chiamante, `on` manda
 * sulla destination tecnica anche fuori da un job. Serve a due cose concrete: rientrare in produzione
 * con un `cf set-env` sul task se la destination tecnica non è ancora stata creata o non è
 * autorizzata su qualche iFlow, e far uscire sul canale batch uno script che non passa da `runJob()`
 * (`srv/lib/routingMaterialBackfill.js`).
 */
const IS_EGRESS_ENV = 'IS_BATCH_EGRESS';

/**
 * Come esce una chiamata verso gli iFlow da questo processo. FUNZIONE PURA: l'ambiente arriva per
 * parametro, e la destination configurata dal chiamante pure.
 *
 * Rende anche il PERCHE', perché è quello che finisce nei log: «non è un run batch» e «è un run batch
 * che qualcuno ha riportato sul canale del server web» sono due fatti diversi, e a distanza di mesi
 * il secondo non si ricostruisce.
 *
 * Un valore non riconosciuto della leva NON inventa un terzo comportamento: decide il marcatore,
 * come se la leva non ci fosse, ma il testo lo DICHIARA — altrimenti un `=false` battuto per
 * distrazione sarebbe indistinguibile da un `=off` che funziona (stessa forma di DEC-85).
 *
 * Va chiamata al momento dell'uso e non a caricamento del modulo: il marcatore lo scrive `runJob()`
 * quando il processo è già partito, e una costante calcolata al `require` sarebbe già stata
 * valutata — cioè «server web» in ogni job.
 *
 * `batch` resta nella risposta anche ora che l'header non c'è più, e non è un residuo: lo legge il
 * gate `[IS-NO-USER]` di isRemoteSource.js, che su un canale batch NON deve dichiarare «manca il JWT
 * dell'utente» — là un utente non serve, e la nota sarebbe un falso allarme a ogni lettura del job.
 *
 * @param {object} env `process.env`, o qualunque oggetto della stessa forma
 * @param {object} [opts]
 * @param {string} [opts.destination] la destination configurata dal chiamante, usata fuori dai job
 * @returns {{batch: boolean, destination: string, why: string}}
 */
function resolveEgress(env = {}, opts = {}) {
  const configured = opts.destination === undefined || opts.destination === null
    ? ''
    : String(opts.destination);

  const raw = env[IS_EGRESS_ENV] === undefined ? '' : String(env[IS_EGRESS_ENV]).trim();
  const lever = raw.toLowerCase();
  if (lever === 'off') {
    return { batch: false, destination: configured, why: `forzato da ${IS_EGRESS_ENV}=off` };
  }
  if (lever === 'on') {
    return { batch: true, destination: BATCH_DESTINATION, why: `forzato da ${IS_EGRESS_ENV}=on` };
  }

  const unknown = raw ? ` — ${IS_EGRESS_ENV}=${raw} NON RICONOSCIUTO (ammessi: on|off)` : '';
  const job = env[IS_BATCH_ENV] === undefined ? '' : String(env[IS_BATCH_ENV]).trim();
  return job
    ? { batch: true, destination: BATCH_DESTINATION, why: `run batch ${job}${unknown}` }
    : {
      batch: false,
      destination: configured,
      why: `server web (nessun ${IS_BATCH_ENV} nell'ambiente)${unknown}`
    };
}

/** Una riga leggibile: destination effettiva e il perché di quella e non dell'altra. */
function egressText(eg) {
  return `destination ${eg.destination || '(non configurata)'} [${eg.why}]`;
}

module.exports = {
  BATCH_DESTINATION,
  IS_BATCH_ENV,
  IS_EGRESS_ENV,
  resolveEgress,
  egressText
};
