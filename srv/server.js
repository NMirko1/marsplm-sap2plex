const cds = require('@sap/cds');

// ================================================================
// [APP-URL] Toglie il PREFISSO DELL'APP davanti a una radice di servizio. SOLO IN SVILUPPO.
//
// IL PERCHE'. Dalla feature «URL app-relative» ogni chiamata del browser verso il nostro backend
// nasce con la base dell'app davanti (app/*/webapp/util/AppUrl.js), perche' servita da Work Zone
// l'app sta sotto un prefisso di path e un URL assoluto non raggiunge nessuna delle rotte del suo
// `xs-app.json`. In Work Zone il prefisso lo toglie il runtime gestito prima di valutare quelle
// rotte, quindi al backend arriva `/products/...` come sempre.
//
// SOTTO `cds watch` NON LO TOGLIE NESSUNO. Misurato il 18/09/2026 sulla porta 4099:
//
//     /products/$metadata                                      -> 200
//     /avvaleplm.marsplm.sap2plex.main/products/$metadata      -> 404
//     /avvaleplm.marsplm.sap2plex.adminconfigplant/index.html  -> 200
//
// cioe' CAP monta le app sotto `/<sap.app.id>/` e i service alla radice, e le due cose non si
// parlano. Senza questo middleware `npm run watch-*` smetterebbe di funzionare su TUTTE le app:
// non un errore di rotta, ma liste vuote e azioni fallite — lo stesso sintomo che la feature
// esiste per togliere.
//
// PERCHE' SOLO IN SVILUPPO, ed e' il vincolo che conta. In Cloud Foundry non si registra NIENTE:
// il comportamento del server web deployato resta identico byte per byte. Il prefisso, in
// produzione, o lo toglie il runtime gestito (Work Zone) o lo toglie l'approuter
// (app/router/xs-app.json), che e' lo strato giusto — l'instradamento non e' mestiere del server
// applicativo, e una riscrittura in produzione allargherebbe la superficie del backend a
// `/<qualunque cosa>/products/...`.
//
// E I SETTE JOB BATCH NON LO VEDONO, per due ragioni indipendenti: girano fuori dal server web
// (`srv/jobs/lib/runJob.js` fa `cds.serve('all')`, non il bootstrap di `cds serve`, quindi questo
// file non viene nemmeno caricato) e l'evento `bootstrap` lo emette solo la creazione di un'app
// express, che in un run batch non avviene. Il criterio non e' «l'ho guardato»: e'
// `test/appPrefixRewrite.test.js`, che sorveglia entrambe le guardie.
//
// L'ALTRA META' DI QUESTA SPIEGAZIONE STA QUI, E NON LA', per una ragione che e' costata un
// deploy: `app/router/xs-app.json` porta la rotta gemella, ma quel file NON PUO' SPIEGARSI. JSON
// non ha commenti, e `@sap/approuter` valida `xs-app.json` con uno schema che ha
// `additionalProperties: false` sulle rotte e al primo livello — sedici chiavi ammesse e nessuna
// e' un commento. Una chiave in piu' non viene ignorata: l'approuter RIFIUTA DI PARTIRE, con
// `VError: xs-app.json/routes/2/_comment: Additional properties not allowed`, exit 1, crash loop.
// E' successo il 18/09/2026 alle 08:39, con una `"_comment"` messa dentro la rotta: il server CAP
// era partito regolarmente, ed era giu' la sola interfaccia. Chi tocca quella rotta legge qui.
//
// La rete e' `test/appPrefixRewrite.test.js`, che valida TUTTI i sette `xs-app.json` con la
// funzione vera dell'approuter (`validators.validateXsApp`) invece che con `JSON.parse`: come
// JSON quel file era validissimo, ed e' per questo che nessun test l'aveva preso.
//
// `grep -rn "APP-URL"`
// ================================================================

/**
 * Le radici di servizio del progetto: il primo segmento di ogni path che il backend serve.
 *
 * L'ELENCO E' GEMELLO di quello in `app/router/xs-app.json`, e i due divergerebbero in silenzio:
 * `test/appPrefixRewrite.test.js` li confronta. Aggiungendo un service in `srv/cat-service.cds`
 * va aggiunta la sua radice QUI e LA'.
 */
const SERVICE_ROOTS = [
  'odata',
  'products',
  'production-orders',
  'production-routings',
  'routing-templates',
  'plex',
  'plex-fieldmap',
  'plex-opfieldmap',
  'objgroup-edit',
  'mat-category',
  'ordercomp-excl'
];

/**
 * `/<un-segmento-qualunque>/<radice>/<resto>` → `/<radice>/<resto>`.
 *
 * UN SOLO SEGMENTO, e la radice deve essere la SECONDA: cosi' `/plex/getPlexOperations` non
 * combacia (`getPlexOperations` non e' una radice) e `/job-run/runProdTeco` nemmeno. Le cartelle
 * delle app — `controller`, `util`, `view`, `model`, `css`, `i18n`, `control`, `test` — non
 * collidono con nessuna radice, quindi nessuna risorsa dell'app viene dirottata.
 */
// `(?:/webapp)?`: senza `cds-plugin-ui5` `cds watch` serve le app come `/<cartella>/webapp/index.html`
// (non `/<sap.app.id>/`), e le URL relative si risolvono sotto quel prefisso a DUE segmenti.
const PREFIXED = new RegExp('^/[^/]+(?:/webapp)?/((?:' + SERVICE_ROOTS.join('|') + ')/.*)$');

cds.on('bootstrap', (app) => {
  // [APP-URL] Il cancello. In produzione si esce prima di registrare qualunque cosa.
  if (cds.env.production) return;

  app.use((req, _res, next) => {
    const m = PREFIXED.exec(req.url);
    if (m) req.url = '/' + m[1];
    next();
  });

  console.log('[APP-URL] riscrittura del prefisso app attiva (solo sviluppo): /<app>/<radice>/… → /<radice>/…');
});

module.exports = cds.server;
