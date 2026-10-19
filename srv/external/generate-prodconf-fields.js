/**
 * [PRODCONF-POST] Generatore dell'inventario dei campi della conferma d'ordine di produzione.
 *
 * STRUMENTO DI DESIGN TIME, NON CODICE DI RUNTIME. Sta in srv/external/ per la stessa ragione del
 * gemello generate-matdoc-contract.js: e' li' che vive il materiale di contratto verso il team
 * Integration, e quella cartella NON e' caricata da CAP (`cds.resolve('*')` prende solo i modelli
 * nominati da un `model:` in cds.requires). Nessuno di questi file finisce nel modello servito.
 *
 * COSA PRODUCE  (node srv/external/generate-prodconf-fields.js)
 *   ZMARS_PRODCONF_POST.fields.json   inventario dei 107 campi di IS_CONFIRMATION col tipo ABAP
 *
 * Un solo artefatto, non quattro come il matdoc: qui il contratto non e' in discussione. La forma
 * del messaggio e' quella dichiarata dalla FM ZMARS_PROD_ORDER_CONF_POST (IS_CONFIRMATION +
 * IV_POST_ERRORS), l'indirizzo e' pubblicato, e non c'e' la questione delle N righe che aveva
 * costretto a scrivere il movimento merci in tre rese diverse.
 *
 * PERCHE' GENERATO E NON SCRITTO A MANO
 * I campi sono 107 e la loro CODIFICA dipende dal tipo: DATS, TIMS, NUMC, DEC, XFELD si scrivono in
 * modi diversi e il tipo va letto dall'EDMX, non ricordato. Riprodurli a mano e' garanzia di
 * sbagliarne qualcuno, e Simple Transformation si ferma al PRIMO valore illegale: un campo sbagliato
 * per volta costa un ciclo di deploy a testa.
 *
 * I deduttori (`readEntityType`, `abapKind`, `fieldEntry`) sono importati da
 * generate-matdoc-contract.js: la deduzione EDMX -> tipo ABAP e' una sola per tutto il progetto, e
 * la stessa che governa la codifica applicata a runtime in srv/lib/sapPostEncoding.js.
 *
 * ATTENZIONE: il file prodotto NON va modificato a mano. Si cambia questo generatore e si rilancia.
 *
 * Contratto verso il team Integration: srv/external/PROD_ORDER_CONF_POST_IS.md
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readEntityType, fieldEntry } = require('./generate-matdoc-contract');

const HERE = __dirname;
const SOURCE = path.join(HERE, 'OP_API_PROD_ORDER_CONFIRMATIO_2_SRV_0001.edmx');
const ENTITY = 'ProdnOrdConf2Type';
const OUT = 'ZMARS_PRODCONF_POST.fields.json';

/**
 * I campi che il blocco MOCK di srv/lib/prodOrderConfPost.js valorizza DAVVERO oggi. Marcarli serve
 * solo a leggere l'inventario: `sent: false` non significa «assente dalla request» — TUTTI i campi
 * partono, quelli senza valore come stringa vuota.
 */
const SENT = [
  'OrderID', 'Sequence', 'OrderOperation', 'Plant', 'WorkCenter',
  'ConfirmationYieldQuantity', 'ConfirmationUnit',
  'PostingDate',
  'IsFinalConfirmation', 'OpenReservationsIsCleared', 'APIConfHasNoGoodsMovements',
  'ConfirmationText'
  // Fuori dall'elenco dal 17/08/2026, con l'ordine vero: `Material` e `FinalConfirmationType`
  // perche' SAP li deriva o non ne conosciamo i valori ammessi, `ConfirmationScrapQuantity` perche'
  // lo scrap del time ticket collaudato e' vuoto, `Personnel` e `CapacityRequirementSplit` perche'
  // erano di sola copertura tipi e su un ordine vero sono due motivi di rifiuto — la copertura sta
  // ora in test/prodOrderConfPost.test.js. Le ragioni per campo sono nel blocco DATI della sonda.
  //
  // Fuori dall'elenco dal 18/08/2026: `ConfirmedProcessingStartDate`, `ConfirmedProcessingEndDate` e
  // `ConfirmedProcessingStartTime`. Partivano tutti e tre con l'istante di invio, ma la
  // `ConfirmedProcessingEndTime` no — e un'ora senza valore in ABAP e' `000000`, cioe' una fine a
  // mezzanotte prima di un inizio alle 14:22. Il BAPI ha risposto `E RU 028 «Two operation times are
  // not in ascending order»`. Le durate vere non le abbiamo (un solo istante da Plex), quindi la
  // conferma non manda tempi d'operazione: li deriva SAP. Vedi DEC-59 e `valuesFor` nella sonda.
];

/**
 * Le chiavi le assegna SAP. NON VANNO IN RICHIESTA: la struttura di ingresso ne ha 105, la tabella
 * di risposta ne ha 107 — le stesse 105 piu' queste due, valorizzate. E' la differenza fra le due
 * direzioni, ed e' anche il modo in cui si legge l'esito, visto che non c'e' un ET_RETURN:
 * chiavi valorizzate = conferma registrata.
 *
 * Restano nell'inventario, marcate `key: true`, perche' l'inventario descrive l'ENTITY: e'
 * srv/lib/prodOrderConfPost.js a filtrarle quando costruisce la richiesta. Tenerle qui significa
 * che il loro tipo e la loro lunghezza sono dichiarati una volta sola, per entrambe le direzioni.
 */
const ASSIGNED_BY_SAP = ['ConfirmationGroup', 'ConfirmationCount'];

function main() {
  const xml = fs.readFileSync(SOURCE, 'utf8');
  const props = readEntityType(xml, ENTITY, SOURCE);
  const fields = props.map((p) => {
    const e = fieldEntry(p, SENT);
    // IL TIPO EDM, oltre a quello ABAP. Non e' un doppione: chi valida la richiesta e' l'EDM, e i
    // due non stanno in corrispondenza biunivoca. `Edm.String` copre sia CHAR sia NUMC (che va
    // riempito a zeri), e `Edm.Guid` finisce anch'esso in `char` perche' per l'XSD e' testo — ma il
    // suo letterale VUOTO non e' `""`, che l'EDM rifiuta, bensi' `null`.
    // Un EdmSimpleTypeException su ExternalSystemConfirmation e' esattamente cio' che e' costato
    // l'aggiunta di questo campo: senza, la codifica OData deduce dal tipo sbagliato.
    e.edm = String(p.Type || '').replace(/^Edm\./, '');
    if (ASSIGNED_BY_SAP.includes(p.Name)) e.key = true;
    return e;
  });

  const content = JSON.stringify({
    _comment: 'GENERATO da srv/external/generate-prodconf-fields.js a partire da '
      + 'OP_API_PROD_ORDER_CONFIRMATIO_2_SRV_0001.edmx, entity type ProdnOrdConf2Type. NON '
      + 'MODIFICARE A MANO. Inventario dei 107 campi della conferma col loro tipo ABAP: e\' cio\' '
      + 'da cui srv/lib/prodOrderConfPost.js ricava il nome maiuscolo, la formattazione del valore '
      + 'e il valore iniziale. La codifica vera e propria sta in srv/lib/sapPostEncoding.js.',
    _kinds: 'char = testo | numc = numerico riempito a zeri | int = numerico senza riempimento | '
      + 'dats = xsd:date | tims = xsd:time | dec = decimale col punto | xfeld = flag "X" o ""',
    _edm: 'Tipo dichiarato dall\'EDM del servizio, ed e\' l\'EDM che valida la richiesta. NON e\' '
      + 'in corrispondenza biunivoca con `kind`: Edm.String copre char e numc, e Edm.Guid finisce '
      + 'in char perche\' per l\'XSD e\' testo. Il letterale VUOTO della forma entity si decide da '
      + 'qui, non da `kind`: String -> "", Boolean -> false, tutto il resto -> null.',
    _key: `key: true su ${ASSIGNED_BY_SAP.join(' e ')} — assegnati da SAP. La RICHIESTA `
      + `(IS_CONFIRMATION) ne ha ${fields.length - ASSIGNED_BY_SAP.length}: questi due sono esclusi. `
      + `La RISPOSTA e' una tabella di righe da ${fields.length} campi, le stesse piu' queste due `
      + 'valorizzate. Non c\'e\' un ET_RETURN: le chiavi SONO l\'esito.',
    confirmation: fields
  }, null, 2) + '\n';

  fs.writeFileSync(path.join(HERE, OUT), content);

  const byKind = {};
  const byEdm = {};
  for (const e of fields) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    byEdm[e.edm] = (byEdm[e.edm] || 0) + 1;
  }
  console.log(`Fonte: ${path.basename(SOURCE)} — ${ENTITY}, ${fields.length} campi`);
  console.log(`Tipi ABAP: ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`Tipi EDM : ${Object.entries(byEdm).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`Richiesta: ${fields.filter((e) => !e.key).length} campi `
    + `(escluse le chiavi ${ASSIGNED_BY_SAP.join(', ')}) — risposta: ${fields.length}`);
  console.log(`Valorizzati dal MOCK: ${fields.filter((e) => e.sent).length}`);
  console.log(`  ${OUT.padEnd(34)} ${content.split('\n').length} righe`);
}

if (require.main === module) main();

module.exports = { SENT, ASSIGNED_BY_SAP };
