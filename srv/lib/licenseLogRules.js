/**
 * [LICENSE-BODY] La RISPOSTA del license server, resa in una riga di log. Regole pure.
 *
 * PERCHE' ESISTE. srv/license.js dichiarava da sempre il proprio VERDETTO — HTTP, `Valid`, `Role`,
 * licenziato/no — e mai la risposta da cui quel verdetto viene. I tre casi in cui serve sono
 * esattamente i tre che oggi non si distinguono:
 *
 *   - un NON-2xx non lascia niente. `executeHttpRequest` rigetta su 4xx/5xx, quindi un 401 o un 500
 *     del license server finisce nel `catch` e stampa il solo `e.message` («Request failed with
 *     status code 401»), mentre il motivo sta nel corpo della risposta, che si buttava;
 *   - la FORMA IGNOTA si dichiara e non si mostra: il ramo che dice «nessuna riga sotto `d`» non
 *     dice cosa c'era al suo posto, e un envelope diverso, una pagina HTML di login da una
 *     destination sbagliata e un corpo vuoto danno oggi la stessa riga;
 *   - `Valid=false` non distingue le sue cause: plant sconosciuto, licenza scaduta e chiave API di
 *     un altro cliente sono lo stesso `Valid=false`.
 *
 * PERCHE' UN MODULO E NON DUE `console.log` INLINE. I due rami di srv/license.js — la licenza del
 * plant e il ruolo della coppia — devono stampare la stessa cosa nello stesso modo, e scritte inline
 * sarebbero due copie. La copia che divergerebbe e' il MASCHERAMENTO, cioe' la sola parte il cui
 * difetto non da' nessun errore: mette una chiave API o un indirizzo e-mail in `cf logs`, che e'
 * conservato, e si scopre altrove. Qui e' un punto solo, ed e' collaudabile:
 * `node test/licenseLogRules.test.js`.
 *
 * NESSUNA DIPENDENZA: ne' `cds` ne' la rete.
 *
 * UNA RIGA PER CHIAMATA, E NOMINA SEMPRE CHI. I plant si risolvono IN PARALLELO
 * (`Promise.all` in getUsablePlants e in srv/lib/plantAccess.js), quindi in `cf logs` le righe di
 * plant diversi si mescolano: una riga che non porta il proprio plant non e' attribuibile proprio
 * dove serve confrontarli. Il gettone `who` lo compone il chiamante, che quei pezzi ce li ha gia'.
 *
 * DA TOGLIERE. E' diagnostica sempre accesa: dalla 0048 quella chiamata esce per ogni plant
 * licenziato di OGNI lettura del cockpit, quindi sono P righe di corpo per richiesta. Il perimetro
 * completo e' `grep -rn "LICENSE-BODY"`.
 */

'use strict';

/**
 * Il tetto del corpo stampato.
 *
 * Una risposta di licenza e' minuscola (~80 caratteri), quindi un corpo enorme E' la notizia — una
 * pagina HTML da una destination sbagliata — e va vista TAGLIATA e non nascosta. Il troncamento si
 * dichiara con la lunghezza vera accanto: un corpo tagliato in silenzio si legge come un corpo
 * completo, ed e' lo stesso difetto che il progetto sorveglia sulle letture verso gli iFlow.
 */
const BODY_MAX_CHARS = 1000;

/** Quanti anelli di `cause`/`rootCause` si risalgono cercando la risposta. Vedi `responseOf`. */
const CAUSE_DEPTH = 5;

const s = (v) => (v === undefined || v === null ? '' : String(v));

/**
 * L'identita' nei log, mascherata. VIVE QUI e non in srv/license.js, dov'era prima, perche' il
 * corpo va mascherato con LA STESSA regola delle righe di log: con due definizioni un indirizzo
 * uscirebbe mascherato da una parte e intero dall'altra, che e' il difetto peggiore delle due.
 *
 * Un indirizzo e-mail e' un dato personale (DEC-10) e `cf logs` e' conservato: si tiene quel tanto
 * che serve a riconoscere chi era, non a raggiungerlo.
 */
function maskEmail(email) {
  const t = s(email);
  const at = t.indexOf('@');
  if (at <= 0) return t ? `${t.slice(0, 1)}***` : '(nessuna)';
  return `${t.slice(0, 1)}***${t.slice(at)}`;
}

/**
 * Via i segreti e via gli indirizzi, dal testo che sta per uscire.
 *
 * DUE MECCANISMI, E NON UNO. I `secrets` (la chiave API) si togliono per sostituzione esatta, come
 * fa `maskSecrets` in srv/lib/smtpRules.js — non importata perche' quel modulo non la esporta, e
 * allargare le esportazioni del canale mail per il canale licenza sarebbe un legame fra due
 * perimetri che non si parlano. Gli INDIRIZZI passano invece da un'espressione regolare, e la
 * ragione e' precisa: la sostituzione esatta e' sensibile alla grafia, e un server che rieccheggia
 * `Mario.Rossi@X.IT` dove noi abbiamo mandato `mario.rossi@x.it` la scavalcherebbe in silenzio.
 * L'espressione prende anche un indirizzo che non abbiamo mandato noi.
 *
 * Sotto i 3 caratteri un segreto non si maschera: sarebbe rumore che cancella mezzo testo.
 */
function scrub(text, { secrets = [] } = {}) {
  let out = s(text);
  for (const sec of secrets) {
    if (typeof sec !== 'string' || sec.length < 3) continue;
    out = out.split(sec).join('***');
  }
  return out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => maskEmail(m));
}

/** Il corpo come testo, qualunque cosa sia arrivata: oggetto JSON, stringa, o niente. */
function rawOf(data) {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch (e) {
    return String(data);
  }
}

/**
 * C'e' l'involucro `d`?
 *
 * Dichiara QUELLO CHE IL LETTORE VEDE, non quello che i byte contengono: srv/license.js legge
 * `res.data.d`, quindi un JSON con `d` consegnato come `text/plain` — che axios lascia stringa — da'
 * `NO`, ed e' la risposta giusta perche' e' esattamente il motivo per cui quel ramo cadrebbe nella
 * forma ignota. Un flag che dicesse `SI'` su un corpo che il codice non riesce a leggere manderebbe
 * a cercare il difetto dalla parte sbagliata.
 */
function hasD(data) {
  return !!(data && typeof data === 'object' && !Array.isArray(data)
    && Object.prototype.hasOwnProperty.call(data, 'd'));
}

/** Il content-type dichiarato, da qualunque delle due forme di header lo porti. */
function contentTypeOf(res) {
  const h = (res && res.headers) || {};
  const v = typeof h.get === 'function' ? h.get('content-type') : (h['content-type'] || h['Content-Type']);
  return s(v);
}

/**
 * I gettoni del corpo: lunghezza VERA, troncamento dichiarato, e il testo su una riga sola.
 *
 * Gli a capo si schiacciano PRIMA del taglio ma DOPO il conteggio: la lunghezza deve essere quella
 * del corpo arrivato, o non si riconosce piu' una risposta enorme da una normale.
 */
function bodyToken(raw, { secrets = [], max = BODY_MAX_CHARS } = {}) {
  const text = s(raw);
  if (!text) return 'corpo ASSENTE (nessun payload)';
  const flat = scrub(text, { secrets }).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return flat.length > max
    ? `corpo ${text.length} car., primi ${max} | ${flat.slice(0, max)}`
    : `corpo ${text.length} car. | ${flat}`;
}

/**
 * La riga della risposta RIUSCITA. Gli stessi gettoni del dump di srv/lib/isCallDumpRules.js — stato,
 * content-type, involucro `d`, lunghezza, corpo crudo — perche' chi confronta le due tracce non deve
 * trovare due rese diverse della stessa cosa.
 *
 * @param {object} res la risposta di `executeHttpRequest`
 * @param {{who?: string, secrets?: string[]}} opts `who` lo compone il chiamante (vedi la testata)
 */
function bodyLine(res, { who = '', secrets = [] } = {}) {
  const data = res ? res.data : undefined;
  const ct = contentTypeOf(res);
  return `risposta${who ? ` ${who}` : ''}: HTTP ${(res && res.status) || '(non dichiarato)'}`
    + ` | content-type ${ct || '(assente)'}`
    + ` | involucro \`d\` ${hasD(data) ? 'SI\'' : 'NO'}`
    + ` | ${bodyToken(rawOf(data), { secrets })}`;
}

/**
 * La risposta dentro un errore, risalendo gli anelli di `cause`.
 *
 * MISURATO (09/09/2026, sink locale con `--http 500`): su un rigetto HTTP la risposta sta su
 * `err.response`, primo livello. La risalita degli anelli e' una TOLLERANZA e non una necessita'
 * misurata — il Cloud SDK v4 incarta l'errore di axios, e quale livello porti la risposta dipende
 * da dove il rigetto e' nato — ma costa tre righe e la sua assenza costerebbe il corpo proprio sul
 * 401, cioe' sul caso per cui questa diagnostica esiste.
 */
function responseOf(err) {
  let e = err;
  for (let i = 0; i < CAUSE_DEPTH && e && typeof e === 'object'; i++) {
    if (e.response && typeof e.response === 'object') return e.response;
    e = e.cause || e.rootCause;
  }
  return null;
}

/**
 * [PLANT-ACCESS] Lo stato HTTP che il license server usa per dire «NON ABILITATO» (v1.3).
 *
 * Un `401` NON e' questo: quello e' «la chiave API non e' buona», cioe' un guasto nostro, e va
 * trattato come una chiamata che non ha risposto. La differenza fra i due decide se un utente
 * legge «chiedi l'abilitazione» oppure «riprova».
 */
const DENIED_STATUS = 403;

/**
 * [PLANT-ACCESS] Un errore della chiamata al license server e' un RIFIUTO dichiarato?
 *
 * PERCHE' ESISTE. `executeHttpRequest` RIGETTA su 4xx, quindi la risposta piu' informativa che il
 * license server sa dare — «questo utente non ha la licenza per quel plant» — arriva al chiamante
 * nella stessa forma di un cavo staccato. Senza questa distinzione un rifiuto passa per
 * «irraggiungibile»: entro il grace di 96 h il vecchio «si'» viene riservito, e oltre il grace il
 * perimetro dichiara un guasto che non c'e'.
 *
 * SI APPOGGIA A `responseOf`, che risale gli anelli di `cause`: un rigetto incartato dal Cloud SDK
 * porta la risposta a un livello che dipende da dove il rigetto e' nato. Senza la risalita un `403`
 * annidato tornerebbe a leggersi come un guasto di trasporto, senza dare nessun errore.
 *
 * @param {*} err l'errore rigettato da `executeHttpRequest`
 * @returns {boolean} `true` = il server ha risposto, e la risposta e' «no»
 */
function isAccessDenied(err) {
  const res = responseOf(err);
  return !!res && Number(res.status) === DENIED_STATUS;
}

/** Quante note di causa entrano nella riga: oltre, la riga diventa un muro. */
const MAX_CAUSE_NOTES = 6;

/**
 * La catena delle cause, dal piu' esterno al piu' interno, senza ripetizioni.
 *
 * SI RACCOLGONO ANCHE `code` E `errors[]`, E NON E' PRUDENZA: E' UNA MISURA. Col server spento
 * (09/09/2026, `ECONNREFUSED` sul sink locale) `message` e' **VUOTO** a ogni livello, e l'unico nome
 * della causa e' `code`; il testo utile — «connect ECONNREFUSED 127.0.0.1:4010», un indirizzo per
 * ogni famiglia IP — sta dentro l'`AggregateError` che axios mette in `cause`, nel suo `errors[]`.
 * Quindi la riga di srv/license.js che stampa il solo `e.message` esce **muta** proprio sul guasto
 * piu' banale e piu' frequente: destination sbagliata, porta sbagliata, nessuno in ascolto. Un DNS
 * che non risolve (`ENOTFOUND`) si comporta all'opposto e ha il messaggio al primo livello: sono due
 * forme diverse, e raccoglierne una sola lascia l'altra senza causa.
 *
 * `seen` non e' decorativo: un `cause` che punta a un antenato girerebbe per sempre.
 */
function causeChain(err) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const t = s(v).trim();
    if (t && !out.includes(t) && out.length < MAX_CAUSE_NOTES) out.push(t);
  };
  const visit = (e, depth) => {
    if (!e || typeof e !== 'object' || depth > CAUSE_DEPTH || seen.has(e)) return;
    seen.add(e);
    push(e.message);
    push(e.code);
    if (Array.isArray(e.errors)) for (const sub of e.errors) visit(sub, depth + 1);
    visit(e.cause || e.rootCause, depth + 1);
  };
  visit(err, 0);
  return out;
}

/**
 * La riga del ramo di RIGETTO.
 *
 * «NESSUNA RISPOSTA» NON E' «CORPO VUOTO», ed e' la distinzione che questa riga esiste per fare: un
 * guasto di rete e il tetto di tempo scaduto non hanno una risposta da mostrare, un 500 con un corpo
 * si'. Collassarle manderebbe a cercare un difetto di forma dove non c'e' nessun interlocutore, che
 * e' lo stesso «vuoto non e' ignoto» del resto del progetto.
 *
 * @param {Error} err l'errore rigettato da `executeHttpRequest`
 * @param {{who?: string, secrets?: string[]}} opts
 */
function errorLine(err, { who = '', secrets = [] } = {}) {
  const label = `risposta${who ? ` ${who}` : ''}`;
  const res = responseOf(err);
  if (!res) {
    // La catena dei messaggi al posto del corpo: senza risposta e' l'unica cosa che resta, e il
    // motivo vero («connect ECONNREFUSED», «timeout of 10000ms exceeded») sta spesso nell'anello
    // interno, che il solo `e.message` del chiamante non stampa.
    const chain = causeChain(err);
    return `${label}: NESSUNA RISPOSTA dal server (guasto di rete, o tetto di tempo scaduto)`
      + ` | ${chain.length ? scrub(chain.join(' <- '), { secrets }) : '(nessun messaggio)'}`;
  }
  const ct = contentTypeOf(res);
  return `${label}: RIGETTATA con HTTP ${s(res.status) || '(non dichiarato)'}`
    + ` | content-type ${ct || '(assente)'}`
    + ` | involucro \`d\` ${hasD(res.data) ? 'SI\'' : 'NO'}`
    + ` | ${bodyToken(rawOf(res.data), { secrets })}`;
}

/** Quante righe portava la risposta: `d.results` se c'e', altrimenti la riga singola. */
function rowsOf(data) {
  const d = data && typeof data === 'object' ? data.d : undefined;
  if (d && Array.isArray(d.results)) return d.results.length;
  if (d && typeof d === 'object') return 1;
  return 0;
}

/** L'area con cui le voci di licenza vivono nell'anello, accanto a `plex` e alle letture SAP. */
const TRACE_AREA = 'license';

/** Le due domande che si fanno al license server. Sono l'`op` della voce. */
const TRACE_OP = { PLANT: 'PLANT', ROLE: 'ROLE' };

/**
 * [LICENSE-BODY] La voce per l'anello di srv/lib/isCallLog.js, che il cockpit già legge.
 *
 * PERCHE' QUI. La costruzione della voce è il punto in cui il MASCHERAMENTO deve valere: l'anello è
 * del PROCESSO e condiviso fra utenti — srv/cat-service.js lo dichiara sulla function che lo serve,
 * «chi ha un plant vede anche le letture degli altri» — quindi un'e-mail intera in una voce non è un
 * log brutto: è il dato personale di un'altra persona, servito al browser di chi non è lei. Con la
 * costruzione inline in srv/license.js quella regola starebbe in due copie, e la copia che divergerà
 * è sempre questa. Pura: nessuna dipendenza da `isCallLog`, che taglia i campi per conto suo.
 *
 * `cached` E' LA META' CHE FA ESISTERE QUESTO LAVORO. Il positivo di licenza sta in cache 24 h e il
 * ruolo del cockpit pure: nel caso normale NON PARTE NESSUNA CHIAMATA, e una console che non stampa
 * niente si legge come «non c'è nessun check di licenza» — che è l'equivoco da cui questa feature
 * nasce. Quindi si registra anche il non-evento, con `outcome: 'SKIP'`, `calls: 0` e la PROVENIENZA
 * del verdetto nella nota. `rawSeen` resta `false`: «non misurato», che è la verità.
 *
 * @param {object} p
 * @param {'PLANT'|'ROLE'} p.kind quale delle due domande
 * @param {string} p.plant
 * @param {string} [p.email] presente solo sul ramo del ruolo
 * @param {string} [p.apiKey] da mascherare, mai da scrivere
 * @param {string} [p.target] l'indirizzo chiamato, come lo conosce il chiamante
 * @param {string} [p.destination] `MARS_LICENSE`, o la forma con url esplicito
 * @param {string} [p.effectiveUrl] l'URL risolto dal Cloud SDK, quando c'e'
 * @param {object} [p.res] la risposta riuscita
 * @param {Error} [p.err] l'errore, sul ramo di rigetto
 * @param {number} [p.ms]
 * @param {string} [p.verdict] il verdetto già composto dal chiamante, per la nota
 * @param {string} [p.cached] la provenienza quando la chiamata NON è partita
 * @param {string} [p.outcome] forza l'esito, per il caso che non è né riuscito né rigettato
 * @param {string} [p.errorText] il testo d'errore, quando non viene da un errore rigettato
 *
 * `outcome` E `errorText` ESISTONO PER UN CASO SOLO, e non è una comodità: la risposta di FORMA
 * IGNOTA arriva con HTTP 200 e va segnata KO, ma non c'è nessun errore rigettato da cui comporre la
 * riga. Fabbricare un `Error` finto per passare da `errorLine` produrrebbe «NESSUNA RISPOSTA dal
 * server» su una chiamata che ha risposto — cioè una voce che mente proprio sul difetto che deve
 * spiegare.
 */
function traceEntry({
  kind = TRACE_OP.PLANT, plant = '', email = '', apiKey = '',
  target = '', destination = '', effectiveUrl = '',
  res = null, err = null, ms = 0, verdict = '', cached = '',
  outcome = '', errorText = ''
} = {}) {
  const secrets = apiKey ? [apiKey] : [];
  const who = email ? maskEmail(email) : '';
  const criteria = `plant=${plant || '(nessuno)'}` + (who ? `&email=${who}` : '');
  const url = effectiveUrl || `${target}/LicenseStatus?${criteria}`;
  /**
   * ANCHE UN RIGETTO PUO' AVERE UNA RISPOSTA, e va usata. Su un `500` del license server
   * `executeHttpRequest` lancia, quindi `res` è `null` — ma il corpo c'è, dentro l'errore. Con la
   * sola `res` la voce usciva con stato `0` e corpo vuoto, e il cockpit stampava «nessuna risposta»
   * e «non misurato» SOPRA una riga d'errore che diceva `HTTP 500`: due righe che si contraddicono,
   * e quella sbagliata è la prima che si legge. È la stessa regola che vale per `errorLine`, qui
   * applicata ai campi della voce.
   */
  const effRes = res || responseOf(err);
  const data = effRes ? effRes.data : undefined;
  const raw = scrub(rawOf(data), { secrets });
  const notes = [];
  if (cached) notes.push(`nessuna chiamata: verdetto da ${cached}`);
  if (verdict) notes.push(scrub(verdict, { secrets }));

  return {
    area: TRACE_AREA,
    entity: kind === TRACE_OP.ROLE ? 'LicenseStatus (ruolo utente)' : 'LicenseStatus (licenza plant)',
    op: kind,
    derivedOp: kind,
    mode: 'LICENSE',
    destination: scrub(destination || '(non dichiarata)', { secrets }),
    // `root` PASSA DAL MASCHERAMENTO come `request` e `urls`, e non è simmetria per bellezza:
    // l'indirizzo può essere un `LICENSE_URL` (o un `credentials.url`) con la chiave nella query
    // string, e questo campo lo copiava tale e quale mentre gli altri due lo ripulivano. È il
    // difetto che una difesa scritta in tre punti produce sempre: due li ripulisci, il terzo no.
    root: scrub(target || '', { secrets }),
    form: '',
    calls: cached ? 0 : 1,
    rows: rowsOf(data),
    ms: Number(ms) || 0,
    outcome: outcome || (cached ? 'SKIP' : (err ? 'KO' : 'OK')),
    criteria,
    // Questo canale non ha un `$select`: dirlo evita che il campo vuoto si legga come una lacuna.
    columns: '(nessuno: OData V2 senza $select)',
    request: cached ? '' : `GET ${scrub(url, { secrets })}`,
    notes,
    error: errorText ? scrub(errorText, { secrets }) : (err ? errorLine(err, { who: criteria, secrets }) : ''),
    upstreamStatus: effRes ? Number(effRes.status) || 0 : 0,
    responseBody: raw,
    firstRow: '',
    rec: {
      urls: cached ? [] : [`GET ${scrub(url, { secrets })}`],
      urlCount: cached ? 0 : 1,
      // DEC-96: gli header non escono mai da nessuna parte — la chiave API sta in `Authorization`.
      headers: '',
      httpStatus: effRes ? Number(effRes.status) || 0 : 0,
      rawBody: raw,
      // «Non misurato» e non «vuoto»: senza chiamata non c'e' niente da aver misurato.
      rawSeen: !cached && !!effRes,
      responseContentType: contentTypeOf(effRes),
      rawHasD: hasD(data)
    }
  };
}

module.exports = {
  maskEmail,
  scrub,
  bodyLine,
  errorLine,
  // [PLANT-ACCESS] Il rifiuto dichiarato: lo consumano i due `catch` di license.js
  isAccessDenied,
  DENIED_STATUS,
  traceEntry,
  TRACE_AREA,
  TRACE_OP,
  rowsOf,
  // esportate per il test: la forma della risposta e la risalita degli anelli sono le due parti
  // che rompendosi non darebbero nessun errore
  rawOf,
  hasD,
  responseOf,
  causeChain,
  bodyToken,
  BODY_MAX_CHARS
};
