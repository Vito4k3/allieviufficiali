'use strict';
// ============================================================
//  Compilazione del modulo Excel "Libera uscita"
//
//  Il file finale NON viene ricostruito da zero: si parte dal template
//  .xlsx fornito e se ne modificano solo le celle interessate, lasciando
//  intatti stili, bordi, larghezze colonne, celle unite, intestazioni,
//  formule di riepilogo e piè di pagina.
//
//  Struttura del template (verificata sul file reale, non ipotizzata):
//    riga 7   → A7 "LIBERA USCITA DEL GIORNO gg/mm/aaaa"
//    riga 11  → intestazioni (N. | GRADO | COGNOME | NOME | ... )
//    righe 12..31 → 20 posti per i nominativi
//    riga 32  → RIEPILOGATIVI, con formule COUNTIF/COUNTA
//    righe 34..40 → firme e visto
// ============================================================

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

// ── Mappa colonne, dalle intestazioni di riga 11 del template ────────
const COL = {
  progressivo: 'A',   // numero d'ordine
  grado:       'B',   // "A.U."
  cognome:     'C',
  nome:        'D',
  pernotto:    'F',   // intestazione "PERNOTTO" → X
  uscitaPom:   'L',   // "LIBERA USCITA 14:00" → X
  saltoPasto:  'R',   // intestazione "SALTO CENA" → X
  uscitaSera:  'S'    // "LIBERA USCITA 21:00" → X
};

const RIGA_PRIMO   = 12;                 // prima riga dei nominativi
const RIGA_ULTIMO  = 31;                 // ultima riga prevista dal template
const POSTI_TEMPLATE = RIGA_ULTIMO - RIGA_PRIMO + 1;   // 20
const RIGA_RIEPILOGO = 32;               // prima riga sotto la tabella
const CELLA_DATA   = 'A7';
const GRADO        = 'A.U.';             // valore già usato dal template
const SEGNO        = 'X';

// Colonne che vanno ripulite sulle righe senza nominativo
const COLONNE_CROCETTE = [COL.pernotto, COL.uscitaPom, COL.saltoPasto, COL.uscitaSera];

// ── Registro dei format: un template per giorno della settimana ──────
// getDay(): 0=domenica … 6=sabato. Per aggiungere un giorno basta una
// riga qui più il relativo file in templates/.
const FORMAT_PER_GIORNO = {
  0: 'libera-uscita-domenica.xlsx',
  6: 'libera-uscita-sabato.xlsx'
};
const FORMAT_PREDEFINITO = 'libera-uscita-sabato.xlsx';

// ── Tipi di lista → quale colonna di uscita segnare ──────────────────
// Nuovi tipi di libera uscita si aggiungono qui, senza toccare il resto.
const TIPI_LIBERA_USCITA = {
  liberi_sab_pom:  { colonnaUscita: COL.uscitaPom,  etichetta: 'Sabato pomeriggio' },
  liberi_sab_sera: { colonnaUscita: COL.uscitaSera, etichetta: 'Sabato sera' },
  liberi_dom_pom:  { colonnaUscita: COL.uscitaPom,  etichetta: 'Domenica pomeriggio' }
};

function eLiberaUscita(listType) {
  return Object.prototype.hasOwnProperty.call(TIPI_LIBERA_USCITA, listType);
}

function cartellaTemplate() {
  return path.join(__dirname, '..', 'templates');
}

// Sceglie il format in base al giorno della data della lista, con ripiego
// sul template predefinito se quel giorno non ha ancora un file dedicato.
function templatePerData(dataISO) {
  const d = new Date(String(dataISO).slice(0, 10) + 'T12:00:00');
  const nome = FORMAT_PER_GIORNO[d.getDay()] || FORMAT_PREDEFINITO;
  const completo = path.join(cartellaTemplate(), nome);
  if (fs.existsSync(completo)) return completo;
  const ripiego = path.join(cartellaTemplate(), FORMAT_PREDEFINITO);
  if (fs.existsSync(ripiego)) return ripiego;
  throw new Error('Nessun template Excel disponibile in templates/');
}

// ── Utilità XML ──────────────────────────────────────────────────────
function escapeXml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function regexCella(ref) {
  return new RegExp('<c r="' + ref + '"([^>]*?)(\\/>|>[\\s\\S]*?<\\/c>)');
}

function stileDi(attributi) {
  const m = /\ss="(\d+)"/.exec(attributi || '');
  return m ? ` s="${m[1]}"` : '';
}

// Sostituisce il contenuto di una cella conservandone lo stile.
// valore null/'' svuota la cella. I testi vengono scritti come stringhe
// inline, così non serve toccare sharedStrings.xml.
function scriviCella(xml, ref, valore, numerico) {
  const re = regexCella(ref);
  const m = re.exec(xml);
  if (!m) throw new Error(`Cella ${ref} non presente nel template: struttura inattesa`);
  const s = stileDi(m[1]);
  let nuova;
  if (valore === null || valore === undefined || valore === '') {
    nuova = `<c r="${ref}"${s}/>`;
  } else if (numerico) {
    nuova = `<c r="${ref}"${s}><v>${Number(valore)}</v></c>`;
  } else {
    nuova = `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(valore)}</t></is></c>`;
  }
  return xml.slice(0, m.index) + nuova + xml.slice(m.index + m[0].length);
}

// ── Espansione della tabella oltre i 20 posti del template ───────────
function spezzaRighe(xml) {
  const apertura = '<sheetData>';
  const i = xml.indexOf(apertura);
  const j = xml.indexOf('</sheetData>');
  if (i < 0 || j < 0) throw new Error('sheetData non trovato nel template');
  const dentro = xml.slice(i + apertura.length, j);
  const righe = dentro.match(/<row [^>]*\/>|<row [\s\S]*?<\/row>/g) || [];
  return { testa: xml.slice(0, i + apertura.length), righe, coda: xml.slice(j) };
}

function indiceRiga(chunk) {
  const m = /^<row r="(\d+)"/.exec(chunk);
  return m ? parseInt(m[1], 10) : null;
}

function rinumeraRiga(chunk, nuovo) {
  return chunk
    .replace(/^<row r="\d+"/, `<row r="${nuovo}"`)
    .replace(/<c r="([A-Z]+)\d+"/g, (_, col) => `<c r="${col}${nuovo}"`)
    .replace(/ref="([A-Z]+)\d+:([A-Z]+)\d+"/g, (_, c1, c2) => `ref="${c1}${nuovo}:${c2}${nuovo}"`);
}

// Aggiunge posti alla tabella clonando l'ultima riga dati e spostando in
// basso tutto ciò che sta sotto (riepilogo, firme, righe vuote di coda).
function espandiTabella(xml, quantiInPiu) {
  if (quantiInPiu <= 0) return xml;
  const { testa, righe, coda } = spezzaRighe(xml);

  const modello = righe.find(r => indiceRiga(r) === RIGA_ULTIMO);
  if (!modello) throw new Error(`Riga modello ${RIGA_ULTIMO} non trovata`);

  const sopra = [], sotto = [];
  for (const r of righe) {
    const n = indiceRiga(r);
    if (n === null) continue;
    (n <= RIGA_ULTIMO ? sopra : sotto).push(r);
  }

  const nuove = [];
  for (let k = 1; k <= quantiInPiu; k++) nuove.push(rinumeraRiga(modello, RIGA_ULTIMO + k));

  const spostate = sotto.map(r => {
    let c = rinumeraRiga(r, indiceRiga(r) + quantiInPiu);
    // Le formule di riepilogo devono coprire anche le righe aggiunte
    c = c.replace(/<f([^>]*)>([\s\S]*?)<\/f>/g, (tutto, attr, corpo) => {
      const agg = corpo.replace(
        new RegExp('([A-Z]+)' + RIGA_ULTIMO + '(?![0-9])', 'g'),
        (_, col) => col + (RIGA_ULTIMO + quantiInPiu)
      );
      return `<f${attr}>${agg}</f>`;
    });
    return c;
  });

  return testa + sopra.join('') + nuove.join('') + spostate.join('') + coda;
}

// Sposta in basso le celle unite che stanno sotto la tabella
function spostaMerge(xml, quantiInPiu) {
  if (quantiInPiu <= 0) return xml;
  return xml.replace(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g,
    (tutto, c1, r1, c2, r2) => {
      const a = parseInt(r1, 10), b = parseInt(r2, 10);
      if (a < RIGA_RIEPILOGO) return tutto;
      return `<mergeCell ref="${c1}${a + quantiInPiu}:${c2}${b + quantiInPiu}"/>`;
    });
}

// Costringe Excel a ricalcolare le formule di riepilogo all'apertura,
// così i totali non restano quelli memorizzati nel template.
function forzaRicalcolo(workbookXml) {
  if (/<calcPr[^>]*\/>/.test(workbookXml)) {
    return workbookXml.replace(/<calcPr([^>]*?)\/>/, (tutto, attr) =>
      /fullCalcOnLoad/.test(attr) ? tutto : `<calcPr${attr} fullCalcOnLoad="1"/>`);
  }
  return workbookXml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
}

/**
 * Compila il modulo.
 * @param {object} opz
 * @param {string} opz.listType   tipo di lista (determina la colonna uscita)
 * @param {string} opz.dataISO    data della lista, formato AAAA-MM-GG
 * @param {Array}  opz.persone    [{cognome, nome, saltoPasto, pernotto}]
 * @returns {Promise<Buffer>} il file .xlsx compilato
 */
async function compilaLiberaUscita({ listType, dataISO, persone }) {
  const tipo = TIPI_LIBERA_USCITA[listType];
  if (!tipo) throw new Error(`Tipo di lista non gestito per l'Excel: ${listType}`);

  const percorso = templatePerData(dataISO);
  const zip = await JSZip.loadAsync(fs.readFileSync(percorso));

  const nomeFoglio = 'xl/worksheets/sheet1.xml';
  let xml = await zip.file(nomeFoglio).async('string');

  const elenco = Array.isArray(persone) ? persone : [];
  const inPiu = Math.max(0, elenco.length - POSTI_TEMPLATE);
  if (inPiu > 0) {
    xml = espandiTabella(xml, inPiu);
    xml = spostaMerge(xml, inPiu);
  }
  const ultimaRiga = RIGA_ULTIMO + inPiu;

  // Data del documento
  const [aa, mm, gg] = String(dataISO).slice(0, 10).split('-');
  xml = scriviCella(xml, CELLA_DATA, `LIBERA USCITA DEL GIORNO ${gg}/${mm}/${aa}`);

  // Nominativi e crocette, riga per riga
  for (let riga = RIGA_PRIMO; riga <= ultimaRiga; riga++) {
    const p = elenco[riga - RIGA_PRIMO];
    if (!p) {
      // Posto libero: si azzerano nominativo e crocette, il resto del
      // modulo prestampato (numero d'ordine, SI/NO) resta com'è
      xml = scriviCella(xml, COL.grado + riga, null);
      xml = scriviCella(xml, COL.cognome + riga, null);
      xml = scriviCella(xml, COL.nome + riga, null);
      for (const c of COLONNE_CROCETTE) xml = scriviCella(xml, c + riga, null);
      continue;
    }
    xml = scriviCella(xml, COL.progressivo + riga, riga - RIGA_PRIMO + 1, true);
    xml = scriviCella(xml, COL.grado + riga, GRADO);
    xml = scriviCella(xml, COL.cognome + riga, String(p.cognome || '').toUpperCase());
    xml = scriviCella(xml, COL.nome + riga, String(p.nome || '').toUpperCase());

    // La colonna dell'uscita dipende dal tipo di lista
    xml = scriviCella(xml, tipo.colonnaUscita + riga, SEGNO);
    // L'altra colonna di uscita va lasciata vuota
    const altra = tipo.colonnaUscita === COL.uscitaPom ? COL.uscitaSera : COL.uscitaPom;
    xml = scriviCella(xml, altra + riga, null);

    xml = scriviCella(xml, COL.saltoPasto + riga, p.saltoPasto ? SEGNO : null);
    xml = scriviCella(xml, COL.pernotto + riga, p.pernotto ? SEGNO : null);
  }

  zip.file(nomeFoglio, xml, { createFolders: false });

  const nomeWb = 'xl/workbook.xml';
  if (zip.file(nomeWb)) {
    zip.file(nomeWb, forzaRicalcolo(await zip.file(nomeWb).async('string')), { createFolders: false });
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    // Niente voci di cartella: il pacchetto resta identico a quello del template
    createFolders: false
  });
}

module.exports = {
  compilaLiberaUscita,
  eLiberaUscita,
  templatePerData,
  TIPI_LIBERA_USCITA,
  COL,
  RIGA_PRIMO,
  RIGA_ULTIMO,
  POSTI_TEMPLATE,
  CELLA_DATA,
  GRADO
};
