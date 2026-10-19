/**
 * [SMTP-MAIL] Regole pure del trasporto SMTP del recap di fine job.
 *
 * Modulo PURO: nessun require, ne' cds ne' nodemailer ne' rete. E' cio' che rende collaudabile
 * un canale che parla solo con un sistema esterno, come splitRules.js e confPostingRules.js.
 * L'orchestrazione impura (getDestination, process.env, cds.env) sta in srv/lib/mailer.js.
 *
 * Tre cose vanno lette prima di toccare questo file.
 *
 * 1. IL 5xx SMTP E' L'OPPOSTO DEL 5xx HTTP. In HTTP un 5xx e' un guasto del server e si ritenta;
 *    in SMTP (RFC 5321 s.4.2.1) un 5xx e' un rifiuto DEFINITIVO - destinatario inesistente,
 *    messaggio troppo grande, mittente non autorizzato - e un 4xx e' temporaneo (greylisting,
 *    casella piena). Riusare la regola HTTP significherebbe ritentare ogni hard bounce e non
 *    ritentare mai un greylisting: esattamente il contrario di quel che serve.
 *
 * 2. «NON IMPOSTATO» E «IMPOSTATO A FALSE» NON SONO LA STESSA COSA. Nelle proprieta' di una
 *    destination i booleani arrivano come STRINGHE ('true'/'false'), e l'assenza vale undefined,
 *    mai false: senza questa distinzione la derivazione della cifratura dalla porta non puo'
 *    funzionare. Stessa regola del set() di materialDocPost.js.
 *
 * 3. NON SI LOGGA MAI LA CONFIGURAZIONE NUDA (DEC-10). Ogni riga di log che nomini la config
 *    passa da redactSmtpConfig(), e classifySmtpError() riceve i segreti da mascherare: il
 *    messaggio di un rifiuto puo' contenere l'utenza, e quel messaggio finisce su ZJobRunMail,
 *    che a sua volta esce dalla piattaforma in un allegato.
 *
 * Perimetro: grep -rn "SMTP-MAIL"
 */

'use strict';

/** Campi della configurazione SMTP, nell'ordine in cui si fondono le sorgenti. */
const SMTP_FIELDS = [
  'host', 'port', 'secure', 'starttls', 'user', 'pass', 'auth',
  'from', 'envelopeFrom', 'replyTo', 'name',
  'pool', 'maxMessages', 'timeoutMs', 'tlsRejectUnauthorized', 'allowPlaintext',
  'maxMessageBytes', 'onPremise', 'oauth', 'destination'
];

/** Campi che non vanno mai stampati, in nessuna forma. */
const SECRET_FIELDS = ['pass'];

/**
 * Le proprieta' di una destination MAIL che sappiamo leggere. Serve SOLO a calcolare il
 * complemento - le chiavi che una destination porta e che non riconosciamo - e quel complemento
 * finisce in un messaggio d'errore: e' l'unico modo di distinguere «destination non creata» da
 * «creata con i nomi sbagliati». Chi aggiunge un nome sopra lo aggiunga anche qui.
 */
const KNOWN_DESTINATION_KEYS = new Set([
  'mail.smtp.host', 'mail.host', 'mail.smtp.port', 'mail.port',
  'mail.smtp.ssl.enable', 'mail.smtp.starttls.enable', 'mail.smtp.starttls.required',
  'mail.smtp.ssl.trust', 'mail.smtp.ssl.checkserveridentity',
  'mail.transport.protocol', 'mail.smtp.auth',
  'mail.user', 'mail.smtp.user', 'mail.password', 'mail.smtp.password',
  'mail.from', 'mail.smtp.from', 'mail.reply.to', 'mail.replyTo',
  // Non sono nostre ma le mette il cockpit BTP su ogni destination: elencarle come «non
  // riconosciute» sarebbe rumore che nasconde le poche che contano.
  'Name', 'Type', 'ProxyType', 'Authentication', 'Description', 'URL', 'User', 'Password',
  'CloudConnectorLocationId'
]);

/** Nomi delle sorgenti, dalla meno alla piu' forte. Vedi resolveSmtpConfig(). */
const SOURCE_ORDER = ['defaults', 'cds', 'destination', 'env'];

/**
 * Codici nodemailer che descrivono un errore NOSTRO, non del trasporto, quando il server non
 * si e' ancora pronunciato: destinatario/mittente malformato, messaggio non costruibile,
 * autenticazione rifiutata senza codice. Ritentarli fra due secondi non cambia niente.
 * ECONNECTION, ETIMEDOUT, ESOCKET, EDNS restano fuori: sono guasti di trasporto e si ritentano.
 */
const PERMANENT_CODES = new Set(['EENVELOPE', 'EMESSAGE', 'EAUTH']);

/**
 * La STESSA regex del server (srv/cat-service.js, validazione di ZJobNotifyRecipient.Email):
 * mailer e validazione destinatari devono concordare su cosa sia un indirizzo, o si accetterebbe
 * in configurazione un mittente che poi il canale rifiuta.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

// ---- normalizzazione dei valori grezzi ------------------------------------------------------

/** true se il valore e' stato DAVVERO fornito: una stringa vuota non sovrascrive un default. */
function isProvided(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return true;
}

/**
 * Booleano tollerante: le destination consegnano stringhe, le env pure.
 * Ritorna undefined su un valore non riconoscibile, cosi' un refuso non diventa `false`
 * (che qui e' una decisione, non un'assenza).
 */
function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (!isProvided(v)) return undefined;
  const s = String(v).trim().toLowerCase();
  if (['true', 'on', 'yes', '1', 'enable', 'enabled', 'required'].includes(s)) return true;
  if (['false', 'off', 'no', '0', 'disable', 'disabled'].includes(s)) return false;
  return undefined;
}

/** Intero, o null se il valore non e' un intero pulito. Il valore grezzo resta visibile a chi valida. */
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (!isProvided(v)) return null;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function trimOrUndef(v) {
  return isProvided(v) ? String(v).trim() : undefined;
}

/** Da `Nome Cognome <a@b.it>` a `a@b.it`; una forma gia' nuda torna se stessa. */
function extractAddress(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  const m = s.match(/<([^>]*)>\s*$/);
  return m ? m[1].trim() : s;
}

function isEmail(v) {
  return EMAIL_RE.test(extractAddress(v));
}

/** Una riga sola, troncata: un \n spezzerebbe la colonna del recap, e la colonna e' String(255). */
function oneLine(text, max) {
  const s = String(text === undefined || text === null ? '' : text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const limit = max || 255;
  return s.length > limit ? s.slice(0, limit) : s;
}

/** Sostituisce ogni occorrenza dei segreti con ***: usata sui messaggi che escono dal canale. */
function maskSecrets(text, secrets) {
  let out = String(text === undefined || text === null ? '' : text);
  for (const s of (secrets || [])) {
    if (typeof s !== 'string' || s.length < 3) continue;   // sotto i 3 caratteri mascherare e' rumore
    out = out.split(s).join('***');
  }
  return out;
}

// ---- mappatura di una destination di tipo MAIL ----------------------------------------------

/** Primo valore fornito fra le chiavi indicate, cercate nell'ordine. */
function pick(bag, keys) {
  for (const k of keys) {
    if (bag && isProvided(bag[k])) return bag[k];
  }
  return undefined;
}

/**
 * Da una destination BTP di tipo MAIL alla nostra configurazione.
 *
 * Il Cloud SDK non ha alcun supporto SMTP: una destination MAIL e' solo un sacchetto di
 * proprieta' JavaMail in `originalProperties`, e il parsing e' nostro. `User`/`Password` della
 * destination sono gia' mappati dal SDK su `username`/`password` e servono da ripiego, perche'
 * chi crea la destination puo' averli messi nei campi standard invece che in `mail.user`.
 *
 * @param {object} originalProperties  destination.originalProperties, in una delle due forme
 * @param {object} [destination]       la destination stessa (username, password, proxyType, type)
 * @returns {object} configurazione parziale, con i soli campi che la destination fornisce
 */
function mapDestinationToSmtp(originalProperties, destination) {
  // Il SDK consegna `originalProperties` in DUE forme, e quale delle due dipende dal tipo di
  // autenticazione della destination: PIATTA sul percorso senza scambio di token - dove passa
  // `response.data.destinationConfiguration`, ed e' il caso di BasicAuthentication, cioe' il
  // nostro - e ANNIDATA sotto `destinationConfiguration` sui percorsi OAuth2 e certificato, dove
  // passa `response.data` intero (connectivity 4.4.0, destination-service.js:67 vs :157, scelta
  // in destination-from-service.js:64-86). Si accettano entrambe, e non per generosita': con la
  // forma sbagliata non uscirebbe un errore, uscirebbe `unknownKeys` popolato di `owner`,
  // `destinationConfiguration`, `authTokens`, `certificates` - quattro nomi del SDK al posto
  // delle proprieta' JavaMail, cioe' l'esatto contrario di cio' per cui quell'elenco esiste.
  const p = (originalProperties && originalProperties.destinationConfiguration)
    || originalProperties || {};
  const d = destination || {};
  const out = {};

  const host = pick(p, ['mail.smtp.host', 'mail.host']);
  if (isProvided(host)) out.host = String(host).trim();

  const port = pick(p, ['mail.smtp.port', 'mail.port']);
  if (isProvided(port)) out.port = port;                    // grezzo: la validazione vuole vederlo

  const ssl = toBool(pick(p, ['mail.smtp.ssl.enable']));
  if (ssl !== undefined) out.secure = ssl;

  const starttls = toBool(pick(p, ['mail.smtp.starttls.enable', 'mail.smtp.starttls.required']));
  if (starttls !== undefined) out.starttls = starttls;

  // La CA interna: SAP documenta due proprieta' per la fiducia sul certificato, e senza
  // leggerle l'unico modo di accettarne uno non verificabile sarebbe una variabile d'ambiente
  // - cioe' fuori dalla destination, che e' il posto dove chi configura si aspetta di metterlo.
  const sslTrust = trimOrUndef(pick(p, ['mail.smtp.ssl.trust']));
  const checkIdentity = toBool(pick(p, ['mail.smtp.ssl.checkserveridentity']));
  if (sslTrust === '*' || checkIdentity === false) out.tlsRejectUnauthorized = false;

  // `smtps` e' il protocollo con TLS implicito: e' un'informazione sulla cifratura, non un
  // sinonimo di `smtp`, e chi la scrive intende la porta 465.
  const proto = trimOrUndef(pick(p, ['mail.transport.protocol']));
  if (proto && proto.toLowerCase() === 'smtps' && out.secure === undefined) out.secure = true;

  const auth = toBool(pick(p, ['mail.smtp.auth']));
  if (auth !== undefined) out.auth = auth;

  const user = pick(p, ['mail.user', 'mail.smtp.user']) || (isProvided(d.username) ? d.username : undefined);
  if (isProvided(user)) out.user = String(user).trim();

  const pass = pick(p, ['mail.password', 'mail.smtp.password']) || (isProvided(d.password) ? d.password : undefined);
  if (isProvided(pass)) out.pass = String(pass);            // NON si fa trim di una password

  const from = pick(p, ['mail.from']);
  if (isProvided(from)) out.from = String(from).trim();

  const envFrom = pick(p, ['mail.smtp.from']);
  if (isProvided(envFrom)) out.envelopeFrom = String(envFrom).trim();

  const replyTo = pick(p, ['mail.reply.to', 'mail.replyTo']);
  if (isProvided(replyTo)) out.replyTo = String(replyTo).trim();

  // Il Cloud Connector: il SDK riempirebbe un proxyConfiguration socks5, ma nessuno apre quel
  // socket - e il proxy del connectivity service usa il metodo di autenticazione proprietario
  // SAP 0x80, che nessun pacchetto Node implementa. Si dichiara, non si indovina.
  const proxyType = trimOrUndef(d.proxyType) || trimOrUndef(p.ProxyType);
  if (proxyType && proxyType.toLowerCase() === 'onpremise') out.onPremise = true;

  // OAuth2: una destination MAIL puo' dichiararlo, e noi sappiamo fare solo utenza+password.
  // Tentare comunque significherebbe un AUTH PLAIN rifiutato con 535, che si legge come
  // «password sbagliata» e manda a cercare dalla parte opposta. Si dichiara.
  const authType = trimOrUndef(d.authentication) || trimOrUndef(p.Authentication);
  const looksOAuth = (authType && /oauth/i.test(authType))
    || isProvided(p.clientId) || isProvided(p.tokenServiceURL) || isProvided(p.tokenServiceUrl);
  if (looksOAuth) out.oauth = authType || 'OAuth2';

  // Le chiavi che questa destination porta e che non sappiamo usare. Servono a distinguere
  // «destination non creata» da «creata con i nomi sbagliati»: due guasti con rimedi opposti,
  // e oggi indistinguibili. Solo i NOMI - i valori non escono mai da qui.
  out.unknownKeys = Object.keys(p).filter((k) => !KNOWN_DESTINATION_KEYS.has(k));

  return out;
}

// ---- fusione e validazione -------------------------------------------------------------------

/**
 * Fonde le sorgenti nella precedenza dichiarata e valida il risultato.
 *
 *   DEFAULTS  <-  cds.requires.MARS_MAIL.mail.smtp  <-  destination MARS_MAIL  <-  env MAIL_SMTP_*
 *
 * La destination batte package.json perche' e' la verita' per-ambiente e custodisce il segreto;
 * le env battono la destination perche' e' l'invariante gia' stabilita nel progetto
 * (MAIL_TRANSPORT, MAIL_URL, LICENSE_URL) ed e' la leva che si tira alle tre di notte.
 *
 * `source` registra CHI HA VINTO per ogni campo: senza, un host che arriva da una env dimenticata
 * e' indistinguibile da uno che arriva dalla destination, e la diagnosi parte dal posto sbagliato.
 *
 * @param {object} sources {defaults, fromCds, fromDestination, fromEnv, destinationError}
 * @returns {{ok:boolean, config:object|null, reason:string|null, message:string,
 *            missing:string[], warnings:string[], source:object}}
 */
function resolveSmtpConfig(sources) {
  const s = sources || {};
  const bags = [
    ['defaults', s.defaults],
    ['cds', s.fromCds],
    ['destination', s.fromDestination],
    ['env', s.fromEnv]
  ];

  const raw = {};
  const source = {};
  for (const [name, bag] of bags) {
    if (!bag) continue;
    for (const f of SMTP_FIELDS) {
      if (!isProvided(bag[f])) continue;
      raw[f] = bag[f];
      source[f] = name;
    }
  }

  const warnings = [];
  const fail = (reason, message, missing) => ({
    ok: false, config: null, reason, message: oneLine(message), missing: missing || [], warnings, source
  });

  // 1. On-premise: rende irrilevante tutto il resto, quindi si dichiara per primo.
  if (toBool(raw.onPremise) === true) {
    return fail('ONPREM_NOT_SUPPORTED',
      'destination MARS_MAIL e\' OnPremise: SMTP dietro Cloud Connector non e\' supportato '
      + '(il proxy SOCKS5 del connectivity service usa il metodo di autenticazione SAP 0x80). '
      + 'Alternativa: un iFlow Mail dell\'Integration Suite, con il trasporto `destination`');
  }

  // 2. OAuth2: sappiamo fare solo utenza+password. Tentare comunque darebbe un 535, che si legge
  //    come «password sbagliata» e manda a cercare dalla parte opposta.
  if (isProvided(raw.oauth)) {
    return fail('OAUTH2_NOT_SUPPORTED',
      `la destination dichiara autenticazione ${oneLine(raw.oauth, 40)}: il canale SMTP sa usare `
      + 'solo utenza e password. Configurare la destination con BasicAuthentication (mail.user / '
      + 'mail.password), oppure con mail.smtp.auth=false se il relay autorizza per indirizzo IP');
  }

  // 3. Host. Sono due guasti diversi con rimedi opposti: la destination non c'e', oppure c'e' ma
  //    porta nomi che non riconosciamo - e il secondo e' quello probabile, visto che a crearla e'
  //    qualcun altro. Si dichiara QUALE dei due, elencando le chiavi viste: solo i NOMI, perche'
  //    fra i valori c'e' una password.
  const host = trimOrUndef(raw.host);
  if (!host) {
    const unknown = (s.fromDestination && s.fromDestination.unknownKeys) || [];
    let hint;
    if (s.destinationError) {
      hint = ` (lettura della destination fallita: ${oneLine(s.destinationError, 80)})`;
    } else if (unknown.length) {
      hint = ` (destination letta, ma nessuna proprieta' host riconosciuta; trovate: `
        + `${unknown.slice(0, 8).join(', ')}${unknown.length > 8 ? ', ...' : ''}; attesa mail.smtp.host)`;
    } else {
      hint = '';
    }
    return fail('NOT_CONFIGURED',
      `SMTP non configurato: manca host${hint}. Impostare la destination MARS_MAIL (Type=MAIL) `
      + 'oppure MAIL_SMTP_HOST/MAIL_SMTP_PORT', ['host']);
  }

  // 4. Porta: il valore GREZZO nel messaggio, perche' i refusi veri sono '587 ', '587;', 'smtp:587'.
  const port = toInt(raw.port);
  if (port === null || port < 1 || port > 65535) {
    return fail('BAD_PORT', `SMTP: porta non valida "${oneLine(raw.port, 40)}" (atteso un intero 1-65535)`);
  }

  // 5. Cifratura. Le due modalita' si escludono: SMTPS cifra dal primo byte, STARTTLS parte in
  //    chiaro e promuove la connessione. Chiederle insieme e' una configurazione che non esiste.
  let secure = toBool(raw.secure);
  let starttls = toBool(raw.starttls);
  const allowPlaintext = toBool(raw.allowPlaintext) === true;

  if (secure === true && starttls === true) {
    return fail('BAD_TLS_COMBINATION',
      'SMTP: cifratura implicita (SMTPS) e STARTTLS richieste insieme, sono alternative: '
      + 'impostarne una sola');
  }

  let derived = false;
  if (secure === undefined && starttls === undefined) {
    // Si deriva verso la sicurezza, non verso il default comodo.
    if (port === 465) secure = true; else starttls = true;
    derived = true;
  } else if (secure === true) {
    starttls = false;
  } else if (starttls === true) {
    secure = false;
  }

  if (secure !== true && starttls !== true) {
    if (!allowPlaintext) {
      return fail('INSECURE_PLAINTEXT',
        'SMTP: cifratura disattivata. Il corpo porta indirizzi e dati di stabilimento e '
        + 'l\'autenticazione viaggerebbe in chiaro: impostare MAIL_SMTP_ALLOW_PLAINTEXT per '
        + 'accettarlo esplicitamente');
    }
    warnings.push('cifratura disattivata per opt-out esplicito: il traffico SMTP viaggia in chiaro');
  }

  if (!derived) {
    if (secure === true && port !== 465) {
      warnings.push(`cifratura implicita su porta ${port} (l'usuale e' 465): configurazione insolita ma ammessa`);
    }
    if (starttls === true && port === 465) {
      warnings.push('STARTTLS su porta 465 (l\'usuale e\' la cifratura implicita): configurazione insolita ma ammessa');
    }
  }

  // 6. Mittente: e' la causa piu' frequente di rifiuto su un relay aziendale (SPF/DMARC).
  const from = trimOrUndef(raw.from);
  if (!from) {
    return fail('NO_FROM', 'SMTP: mittente non impostato (mail.from sulla destination, oppure MAIL_SMTP_FROM)');
  }
  if (!isEmail(from)) {
    return fail('NO_FROM', `SMTP: mittente non valido "${oneLine(from, 60)}" (attesa la forma nome@dominio.it o Nome <nome@dominio.it>)`);
  }
  const envelopeFrom = trimOrUndef(raw.envelopeFrom);
  if (envelopeFrom && !isEmail(envelopeFrom)) {
    return fail('NO_FROM', `SMTP: indirizzo di ritorno non valido "${oneLine(envelopeFrom, 60)}"`);
  }
  const replyTo = trimOrUndef(raw.replyTo);
  if (replyTo && !isEmail(replyTo)) {
    return fail('NO_FROM', `SMTP: indirizzo di risposta non valido "${oneLine(replyTo, 60)}"`);
  }

  // 7. Autenticazione. Un solo estremo su due e' quasi sempre una env sovrascritta a vuoto,
  //    e senza questo controllo nodemailer tenterebbe un AUTH con password vuota.
  const authFlag = toBool(raw.auth);
  const user = trimOrUndef(raw.user);
  const pass = isProvided(raw.pass) ? String(raw.pass) : undefined;

  if (authFlag === false) {
    if (user) warnings.push('autenticazione disattivata (mail.smtp.auth=false): l\'utenza configurata viene ignorata');
  } else if (user && !pass) {
    return fail('MISSING_PASSWORD', `SMTP: utenza "${oneLine(user, 40)}" senza password`);
  } else if (pass && !user) {
    return fail('MISSING_PASSWORD', 'SMTP: password impostata senza utenza');
  }

  // Si invia senza autenticarsi: vale sia con auth spenta esplicitamente sia senza credenziali,
  // perche' la conseguenza operativa e' la stessa e va verificata prima del primo invio vero.
  if (authFlag === false || (!user && !pass)) {
    warnings.push('nessuna autenticazione SMTP: il relay deve autorizzare per indirizzo IP, e su Cloud Foundry l\'IP di uscita e\' variabile');
  }

  const tlsRejectUnauthorized = toBool(raw.tlsRejectUnauthorized) !== false;
  if (!tlsRejectUnauthorized) {
    warnings.push('verifica del certificato TLS disattivata: la connessione e\' cifrata ma non autenticata');
  }

  const useAuth = authFlag !== false && !!user && !!pass;
  const timeoutMs = toInt(raw.timeoutMs) || 20000;
  const maxMessages = toInt(raw.maxMessages) || 100;
  const maxMessageBytes = toInt(raw.maxMessageBytes);

  const config = {
    host,
    port,
    secure: secure === true,
    // requireTLS pretende STARTTLS e fallisce se il server non lo offre: e' il punto in cui
    // «cifrato» smette di essere un'aspettativa e diventa un requisito.
    requireTLS: starttls === true,
    ignoreTLS: secure !== true && starttls !== true,
    auth: useAuth ? { user, pass } : null,
    from,
    envelopeFrom: envelopeFrom || null,
    replyTo: replyTo || null,
    name: trimOrUndef(raw.name) || null,
    pool: toBool(raw.pool) !== false,
    maxMessages,
    timeoutMs,
    tlsRejectUnauthorized,
    allowPlaintext,
    maxMessageBytes: maxMessageBytes && maxMessageBytes > 0 ? maxMessageBytes : null
  };

  return { ok: true, config, reason: null, message: describeSmtpConfig(config, source), missing: [], warnings, source };
}

/** Riga di log della configurazione risolta: dice anche CHI ha deciso ogni campo. */
function describeSmtpConfig(config, source) {
  const src = (f) => (source && source[f] ? source[f] : 'defaults');
  const tls = config.secure ? 'SMTPS' : (config.requireTLS ? 'STARTTLS' : 'IN CHIARO');
  return oneLine(
    `smtp ${config.host}:${config.port} (${src('host')}/${src('port')}), ${tls}`
    + `, auth ${config.auth ? 'si (' + config.auth.user + ')' : 'no'}`
    + `, from ${config.from} (${src('from')})`
    + `, pool ${config.pool ? 'si' : 'no'}, timeout ${config.timeoutMs}ms`
    + (config.tlsRejectUnauthorized ? '' : ', VERIFICA CERTIFICATO DISATTIVATA')
  );
}

/** Copia loggabile: i segreti diventano ***. Ogni log che nomini la config passa da qui. */
function redactSmtpConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const out = {};
  for (const k of Object.keys(config)) {
    if (SECRET_FIELDS.includes(k)) { out[k] = '***'; continue; }
    if (k === 'auth' && config.auth && typeof config.auth === 'object') {
      out.auth = { user: config.auth.user, pass: '***' };
      continue;
    }
    out[k] = config[k];
  }
  return out;
}

/** I valori da mascherare nei messaggi che escono dal canale (log e ZJobRunMail.Message). */
function secretsOf(config) {
  const out = [];
  if (config && config.auth && config.auth.pass) out.push(String(config.auth.pass));
  if (config && config.pass) out.push(String(config.pass));
  return out;
}

// ---- esito di un invio -------------------------------------------------------------------------

/**
 * Un codice SMTP e' ritentabile se e solo se e' un 4xx. Vedi il punto 1 in testa al file:
 * NON e' la regola HTTP, e chi «uniforma» le due riapre il difetto.
 * `null` (il dialogo non e' mai avvenuto) si ritenta: e' un guasto di trasporto.
 */
function isRetryableSmtp(status) {
  if (status === null || status === undefined) return true;
  const n = Number(status);
  if (!Number.isFinite(n)) return true;
  return n >= 400 && n < 500;
}

/**
 * Traduce un errore nodemailer nel contratto del mailer.
 *
 * Il responseCode VINCE sul code, e non e' un dettaglio: EAUTH con 535 e' una password sbagliata
 * (ritentare fra due secondi e' inutile e su alcuni relay fa scattare il blocco dell'utenza),
 * EAUTH con 454 e' un rifiuto temporaneo dell'autenticazione e si ritenta. Il `code` si guarda
 * solo quando il server non si e' pronunciato affatto.
 *
 * `err.response` NON entra nel messaggio: e' l'eco grezza del server e su un 535 puo' contenere
 * l'utenza. `err.command` invece si': e' un verbo (RCPT TO, AUTH PLAIN, DATA) e dice DOVE si e'
 * rotto il dialogo, che e' il singolo dato diagnostico piu' utile.
 *
 * @param {*} err            errore nodemailer (o qualunque cosa: non lancia mai)
 * @param {string[]} [secrets] valori da mascherare nel testo, tipicamente secretsOf(config)
 */
function classifySmtpError(err, secrets) {
  const e = (err && typeof err === 'object') ? err : {};
  const rc = Number.isInteger(e.responseCode) ? e.responseCode : null;
  const code = (typeof e.code === 'string' && e.code.trim()) ? e.code.trim() : null;

  let status = null;
  let retryable;
  if (rc !== null) {
    status = rc;
    retryable = isRetryableSmtp(rc);
  } else if (code && PERMANENT_CODES.has(code)) {
    retryable = false;
  } else {
    // Un guasto ignoto e' di trasporto finche' non si dimostra il contrario, e il tetto resta
    // comunque un solo ritentativo.
    retryable = true;
  }

  const detail = (typeof e.message === 'string' && e.message)
    ? e.message
    : (typeof err === 'string' ? err : 'errore invio SMTP');
  const command = (typeof e.command === 'string' && e.command.trim()) ? ` ${e.command.trim()}` : '';
  const text = `smtp ${code || '-'}/${rc === null ? '-' : rc}${command} - ${detail}`;

  return { status, retryable, message: oneLine(maskSecrets(text, secrets), 255) };
}

// ---- il messaggio ------------------------------------------------------------------------------

/**
 * Da msg (il contratto di sendMail) all'oggetto che nodemailer si aspetta.
 * Puro di proposito: la forma della busta si prova senza un server.
 *
 * `to` e' e resta una STRINGA SINGOLA: una mail per destinatario e' la regola centrale di
 * jobNotifier.js, e un elenco mostrerebbe a ognuno gli indirizzi degli altri.
 */
function buildNodemailerMessage(msg, config) {
  const m = msg || {};
  const c = config || {};
  const out = {
    from: c.from,
    to: m.to,
    subject: m.subject,
    // Un fuori-sede che risponde a un noreply innesca un ping-pong: questi due header lo dicono
    // ai server che li rispettano.
    headers: {
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All'
    }
  };

  if (m.html) out.html = m.html;
  // Chiavi omesse e non vuote: `text: ''` produrrebbe una parte MIME vuota, `cc: []` un header
  // Cc: vuoto che alcuni server rifiutano.
  if (m.text) out.text = m.text;
  if (Array.isArray(m.cc) && m.cc.length) out.cc = m.cc.slice();
  if (c.replyTo) out.replyTo = c.replyTo;

  // Il Return-Path puo' dover differire dall'header From perche' e' quello su cui il relay
  // verifica SPF.
  if (c.envelopeFrom && extractAddress(c.envelopeFrom) !== extractAddress(c.from)) {
    out.envelope = { from: extractAddress(c.envelopeFrom), to: m.to };
  }

  if (Array.isArray(m.attachments) && m.attachments.length) {
    out.attachments = m.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      // Il Buffer va passato nudo: `encoding` qui e' dannoso, e un base64 fatto a mano
      // verrebbe codificato una seconda volta.
      content: a.content,
      contentDisposition: 'attachment'
    }));
  }

  return out;
}

/**
 * Stima dei byte sul filo. Serve a confrontarsi col limite del relay PRIMA di trasmettere:
 * un 552 arriva dopo che il corpo e' stato spedito per intero.
 * Gli allegati viaggiano in base64, che aggiunge circa un terzo (4/3), piu' l'imbustamento MIME.
 */
function estimateMimeBytes(msg) {
  const m = msg || {};
  const attBytes = (m.attachments || []).reduce((sum, a) => {
    const len = a && a.content && typeof a.content.length === 'number' ? a.content.length : 0;
    return sum + Math.ceil(len * 4 / 3) + 200;              // 200: header della parte MIME
  }, 0);
  const bodyBytes = Buffer.byteLength(String(m.html || ''), 'utf8')
    + Buffer.byteLength(String(m.text || ''), 'utf8');
  return attBytes + bodyBytes + 2048;                        // 2 KB: header del messaggio e boundary
}

module.exports = {
  resolveSmtpConfig,
  mapDestinationToSmtp,
  classifySmtpError,
  isRetryableSmtp,
  buildNodemailerMessage,
  estimateMimeBytes,
  redactSmtpConfig,
  describeSmtpConfig,
  secretsOf,
  // esportate per i test e per gli override da env in mailer.js
  toBool,
  toInt,
  extractAddress,
  oneLine,
  SMTP_FIELDS,
  PERMANENT_CODES
};
