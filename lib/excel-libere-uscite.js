'use strict';
// ============================================================
//  Compilazione del modulo Excel "Libera uscita"
//
//  CONCETTO: un template rappresenta un INTERO GIORNO, non una singola
//  lista. Il file del sabato contiene tutte le persone iscritte a una
//  qualsiasi lista di libera uscita di quel sabato (pomeriggio e sera),
//  ciascuna su una riga sola, con le X nelle colonne che le competono.
//
//  Il file finale NON viene ricostruito da zero: si parte dal template
//  .xlsx e se ne modificano solo le celle interessate, lasciando intatti
//  stili, bordi, larghezze colonne, celle unite e piè di pagina.
//
//  Struttura del template (verificata sul file reale, non ipotizzata):
//    A7       → "LIBERA USCITA DEL GIORNO gg/mm/aaaa"
//    riga 11  → intestazioni (N. | GRADO | COGNOME | NOME | …)
//    righe 12..31 → 20 posti di esempio, già compilati nel template
//    riga 32  → RIEPILOGATIVI, con i totali per colonna
//    righe 34..40 → firme e visto
//  Il numero di righe dati viene adattato alle persone effettive: la
//  tabella non lascia righe vuote e il blocco sottostante si sposta.
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

const RIGA_PRIMO     = 12;                                // prima riga dei nominativi
const RIGA_ULTIMO    = 31;                                // ultima riga presente nel template
const POSTI_TEMPLATE = RIGA_ULTIMO - RIGA_PRIMO + 1;      // 20
const RIGA_RIEPILOGO = 32;                                // riga dei totali nel template
const CELLA_DATA     = 'A7';
const GRADO          = 'A.U.';                            // valore già usato dal template
const SEGNO          = 'X';

// Colonne di crocetta gestite, con la chiave della persona corrispondente
const CROCETTE = [
  { col: COL.uscitaPom,  campo: 'pomeriggio' },
  { col: COL.uscitaSera, campo: 'sera' },
  { col: COL.saltoPasto, campo: 'saltoPasto' },
  { col: COL.pernotto,   campo: 'pernotto' }
];

// Colonne del riepilogo che non popoliamo mai: il totale resta a zero
const COLONNE_TOTALE_VUOTE = ['G', 'K', 'O'];

// ── Registro dei format: un template per giorno della settimana ──────
// getDay(): 0=domenica … 6=sabato. Per aggiungere un giorno basta una
// riga qui più il relativo file in templates/.
const FORMAT_PER_GIORNO = {
  0: 'libera-uscita-domenica.xlsx',
  6: 'libera-uscita-sabato.xlsx'
};
const FORMAT_PREDEFINITO = 'libera-uscita-sabato.xlsx';

// ── Tipi di lista → in quale colonna finisce la X dell'uscita ────────
// Aggiungere un tipo qui lo rende esportabile senza toccare altro.
const TIPI_LIBERA_USCITA = {
  liberi_sab_pom:  { campo: 'pomeriggio', etichetta: 'Sabato pomeriggio' },
  liberi_sab_sera: { campo: 'sera',       etichetta: 'Sabato sera' },
  liberi_dom_pom:  { campo: 'pomeriggio', etichetta: 'Domenica pomeriggio' }
};

function eLiberaUscita(listType) {
  return Object.prototype.hasOwnProperty.call(TIPI_LIBERA_USCITA, listType);
}
function tipiLiberaUscita() {
  return Object.keys(TIPI_LIBERA_USCITA);
}
function campoDiTipo(listType) {
  const t = TIPI_LIBERA_USCITA[listType];
  return t ? t.campo : null;
}

// ── Date ─────────────────────────────────────────────────────────────
// Il driver MySQL restituisce le colonne DATE come oggetti Date: convertirli
// implicitamente in stringa produce "Sat Jun 06 2026…", da cui nascevano
// date tipo "undefined/undefined/Sat Jun 06". Qui si normalizza sempre.
function pezziData(valore) {
  if (valore instanceof Date && !isNaN(valore)) {
    return {
      aa: String(valore.getFullYear()).padStart(4, '0'),
      mm: String(valore.getMonth() + 1).padStart(2, '0'),
      gg: String(valore.getDate()).padStart(2, '0')
    };
  }
  const testo = String(valore == null ? '' : valore).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(testo);            // 2026-08-29 o ISO completo
  if (m) return { aa: m[1], mm: m[2], gg: m[3] };
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(testo);             // 29/08/2026
  if (m) return { aa: m[3], mm: m[2], gg: m[1] };
  const d = new Date(testo);                                  // ultimo tentativo
  if (!isNaN(d)) {
    return {
      aa: String(d.getFullYear()).padStart(4, '0'),
      mm: String(d.getMonth() + 1).padStart(2, '0'),
      gg: String(d.getDate()).padStart(2, '0')
    };
  }
  throw new Error(`Data della lista non valida: ${testo || '(vuota)'}`);
}

function dataISO(valore) {
  const { aa, mm, gg } = pezziData(valore);
  return `${aa}-${mm}-${gg}`;
}
function dataItaliana(valore) {
  const { aa, mm, gg } = pezziData(valore);
  return `${gg}/${mm}/${aa}`;
}

function cartellaTemplate() {
  return path.join(__dirname, '..', 'templates');
}

// Sceglie il format in base al giorno della data della lista, con ripiego
// sul template predefinito se quel giorno non ha ancora un file dedicato.
function templatePerData(valore) {
  const d = new Date(dataISO(valore) + 'T12:00:00');
  const nome = FORMAT_PER_GIORNO[d.getDay()] || FORMAT_PREDEFINITO;
  const completo = path.join(cartellaTemplate(), nome);
  if (fs.existsSync(completo)) return completo;
  const ripiego = path.join(cartellaTemplate(), FORMAT_PREDEFINITO);
  if (fs.existsSync(ripiego)) return ripiego;
  throw new Error('Nessun template Excel disponibile in templates/');
}

// ── Unione delle liste dello stesso giorno ───────────────────────────
// Ogni persona compare una sola volta: se è iscritta a più liste dello
// stesso giorno si sommano le crocette sulla sua unica riga.
function unisciIscritti(liste) {
  const perPersona = new Map();
  for (const lista of liste || []) {
    const campo = campoDiTipo(lista.list_type);
    if (!campo) continue;
    for (const p of lista.iscritti || []) {
      const chiave = p.userId != null ? 'u' + p.userId
        : ((p.cognome || '') + '|' + (p.nome || '')).toLowerCase();
      let voce = perPersona.get(chiave);
      if (!voce) {
        voce = { cognome: p.cognome || '', nome: p.nome || '',
                 pomeriggio: false, sera: false, saltoPasto: false, pernotto: false };
        perPersona.set(chiave, voce);
      }
      voce[campo] = true;
      if (p.saltoPasto) voce.saltoPasto = true;
      if (p.pernotto)   voce.pernotto   = true;
    }
  }
  const collator = new Intl.Collator('it', { sensitivity: 'base' });
  return [...perPersona.values()].sort((a, b) =>
    collator.compare(a.cognome, b.cognome) || collator.compare(a.nome, b.nome));
}

// ── Raccolta dati della giornata ─────────────────────────────────────
// Le opzioni dell'iscrizione viaggiano nella colonna note come JSON: stesso
// meccanismo già usato dalle liste personalizzate, nessuna colonna nuova.
function leggiOpzioniIscrizione(note) {
  if (!note || typeof note !== 'string') return {};
  const t = note.trim();
  if (!t.startsWith('{')) return {};
  try {
    const o = JSON.parse(t);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) { return {}; }
}

// Cognome e nome separati, con ripiego su full_name per gli account storici
function scomponiNome(u) {
  const cognome = (u.cognome || '').trim();
  const nome    = (u.nome || '').trim();
  if (cognome || nome) return { cognome, nome };
  const intero = (u.full_name || u.username || '').trim();
  if (!intero) return { cognome: '', nome: '' };
  const pezzi = intero.split(/\s+/);
  if (pezzi.length === 1) return { cognome: pezzi[0], nome: '' };
  return { cognome: pezzi[pezzi.length - 1], nome: pezzi.slice(0, -1).join(' ') };
}

/**
 * Raccoglie tutte le persone della giornata a cui appartiene la lista
 * richiesta: unisce le liste di libera uscita con LA STESSA DATA, elimina i
 * duplicati e ordina. `esegui` è la funzione di query (sql, params) → [righe],
 * iniettata così da poter essere verificata senza database.
 */
async function raccogliPersoneGiornata(esegui, richiesta) {
  const giorno = dataISO(richiesta.list_date);
  const tipi = tipiLiberaUscita();
  const segnaposto = tipi.map(() => '?').join(',');

  // Confronto sul giorno esatto: liste di altre date non entrano mai
  const [listeGiorno] = await esegui(
    `SELECT id, list_type, list_date FROM lists
     WHERE list_date = ? AND list_type IN (${segnaposto})
     ORDER BY list_type ASC`,
    [giorno, ...tipi]
  );
  // Se la giornata non restituisce nulla si usa comunque la lista richiesta
  const daEsportare = (listeGiorno && listeGiorno.length) ? listeGiorno : [richiesta];

  const conIscritti = [];
  for (const lista of daEsportare) {
    const [signups] = await esegui(
      `SELECT s.user_id, s.note, u.nome, u.cognome, u.full_name, u.username
       FROM list_signups s JOIN users u ON s.user_id = u.id
       WHERE s.list_id = ?`,
      [lista.id]
    );
    conIscritti.push({
      list_type: lista.list_type,
      iscritti: (signups || []).map(s => {
        const opz = leggiOpzioniIscrizione(s.note);
        const { cognome, nome } = scomponiNome(s);
        return {
          userId: s.user_id, cognome, nome,
          saltoPasto: !!(opz.salto_pasto || opz.saltoPasto),
          pernotto:   !!(opz.pernotto)
        };
      })
    });
  }
  return unisciIscritti(conIscritti);
}

// ── Utilità XML ──────────────────────────────────────────────────────
function escapeXml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function trovaCella(xml, ref) {
  const re = new RegExp('<c r="' + ref + '"([^>]*?)(\\/>|>[\\s\\S]*?<\\/c>)');
  const m = re.exec(xml);
  if (!m) throw new Error(`Cella ${ref} non presente nel template: struttura inattesa`);
  const st = /\ss="(\d+)"/.exec(m[1] || '');
  return { match: m, stile: st ? ` s="${st[1]}"` : '' };
}

function sostituisci(xml, m, nuova) {
  return xml.slice(0, m.index) + nuova + xml.slice(m.index + m[0].length);
}

// Sostituisce il contenuto di una cella conservandone lo stile.
// I testi sono stringhe inline: non serve toccare sharedStrings.xml.
function scriviCella(xml, ref, valore, numerico) {
  const { match, stile } = trovaCella(xml, ref);
  let nuova;
  if (valore === null || valore === undefined || valore === '') {
    nuova = `<c r="${ref}"${stile}/>`;
  } else if (numerico) {
    nuova = `<c r="${ref}"${stile}><v>${Number(valore)}</v></c>`;
  } else {
    nuova = `<c r="${ref}"${stile} t="inlineStr"><is><t xml:space="preserve">${escapeXml(valore)}</t></is></c>`;
  }
  return sostituisci(xml, match, nuova);
}

// Scrive una formula con il valore già calcolato: Excel mostra subito il
// numero giusto e lo ricalcola comunque all'apertura.
function scriviFormula(xml, ref, formula, valore) {
  const { match, stile } = trovaCella(xml, ref);
  const nuova = `<c r="${ref}"${stile}><f>${escapeXml(formula)}</f><v>${Number(valore)}</v></c>`;
  return sostituisci(xml, match, nuova);
}

// ── Adattamento del numero di righe ──────────────────────────────────
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

// Porta la tabella ad avere esattamente `quante` righe dati: aggiunge
// clonando l'ultima riga dati, toglie eliminando quelle in eccesso, e in
// entrambi i casi sposta di conseguenza tutto ciò che sta sotto.
function adattaRighe(xml, quante) {
  const delta = quante - POSTI_TEMPLATE;
  if (delta === 0) return xml;
  const { testa, righe, coda } = spezzaRighe(xml);

  const modello = righe.find(r => indiceRiga(r) === RIGA_ULTIMO);
  if (!modello) throw new Error(`Riga modello ${RIGA_ULTIMO} non trovata`);

  const ultimaTenuta = RIGA_PRIMO + quante - 1;
  const sopra = [], sotto = [];
  for (const r of righe) {
    const n = indiceRiga(r);
    if (n === null) continue;
    if (n <= RIGA_ULTIMO) {
      // in riduzione si scartano le righe dati oltre l'ultima utile
      if (n <= ultimaTenuta) sopra.push(r);
    } else {
      sotto.push(r);
    }
  }

  const nuove = [];
  for (let k = 1; k <= delta; k++) nuove.push(rinumeraRiga(modello, RIGA_ULTIMO + k));

  const spostate = sotto.map(r => rinumeraRiga(r, indiceRiga(r) + delta));
  return testa + sopra.join('') + nuove.join('') + spostate.join('') + coda;
}

// Sposta le celle unite che stanno sotto la tabella (delta può essere negativo)
function spostaMerge(xml, quante) {
  const delta = quante - POSTI_TEMPLATE;
  if (delta === 0) return xml;
  return xml.replace(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g,
    (tutto, c1, r1, c2, r2) => {
      const a = parseInt(r1, 10), b = parseInt(r2, 10);
      if (a < RIGA_RIEPILOGO) return tutto;
      return `<mergeCell ref="${c1}${a + delta}:${c2}${b + delta}"/>`;
    });
}

// Costringe Excel a ricalcolare all'apertura
function forzaRicalcolo(workbookXml) {
  if (/<calcPr[^>]*\/>/.test(workbookXml)) {
    return workbookXml.replace(/<calcPr([^>]*?)\/>/, (tutto, attr) =>
      /fullCalcOnLoad/.test(attr) ? tutto : `<calcPr${attr} fullCalcOnLoad="1"/>`);
  }
  return workbookXml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
}

/**
 * Compila il modulo del giorno.
 * @param {object} opz
 * @param {*}      opz.data     data della giornata (Date o stringa)
 * @param {Array}  opz.persone  già unite e ordinate:
 *                              {cognome, nome, pomeriggio, sera, saltoPasto, pernotto}
 * @returns {Promise<Buffer>} il file .xlsx compilato
 */
async function compilaLiberaUscita({ data, persone }) {
  const elenco = Array.isArray(persone) ? persone : [];
  if (!elenco.length) throw new Error('Nessun iscritto da esportare per questa giornata');

  const percorso = templatePerData(data);
  const zip = await JSZip.loadAsync(fs.readFileSync(percorso));
  const nomeFoglio = 'xl/worksheets/sheet1.xml';
  let xml = await zip.file(nomeFoglio).async('string');

  // La tabella prende esattamente il numero di righe che servono
  xml = adattaRighe(xml, elenco.length);
  xml = spostaMerge(xml, elenco.length);

  const ultimaRigaDati = RIGA_PRIMO + elenco.length - 1;
  const rigaTotali     = RIGA_RIEPILOGO + (elenco.length - POSTI_TEMPLATE);

  // Data del documento
  xml = scriviCella(xml, CELLA_DATA, `LIBERA USCITA DEL GIORNO ${dataItaliana(data)}`);

  // Nominativi e crocette
  const totali = { [COL.uscitaPom]: 0, [COL.uscitaSera]: 0, [COL.saltoPasto]: 0, [COL.pernotto]: 0 };
  elenco.forEach((p, i) => {
    const riga = RIGA_PRIMO + i;
    xml = scriviCella(xml, COL.progressivo + riga, i + 1, true);
    xml = scriviCella(xml, COL.grado + riga, GRADO);
    xml = scriviCella(xml, COL.cognome + riga, String(p.cognome || '').toUpperCase());
    xml = scriviCella(xml, COL.nome + riga, String(p.nome || '').toUpperCase());
    for (const { col, campo } of CROCETTE) {
      const attiva = !!p[campo];
      xml = scriviCella(xml, col + riga, attiva ? SEGNO : null);
      if (attiva) totali[col]++;
    }
  });

  // Totali: contano solo le X realmente presenti, sull'intervallo effettivo
  for (const { col } of CROCETTE) {
    xml = scriviFormula(xml, col + rigaTotali,
      `COUNTIF(${col}${RIGA_PRIMO}:${col}${ultimaRigaDati},"X")`, totali[col]);
  }
  for (const col of COLONNE_TOTALE_VUOTE) {
    xml = scriviFormula(xml, col + rigaTotali,
      `COUNTIF(${col}${RIGA_PRIMO}:${col}${ultimaRigaDati},"X")`, 0);
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
    createFolders: false
  });
}

module.exports = {
  compilaLiberaUscita,
  raccogliPersoneGiornata,
  unisciIscritti,
  leggiOpzioniIscrizione,
  scomponiNome,
  eLiberaUscita,
  tipiLiberaUscita,
  campoDiTipo,
  templatePerData,
  dataISO,
  dataItaliana,
  pezziData,
  TIPI_LIBERA_USCITA,
  COL,
  RIGA_PRIMO,
  RIGA_ULTIMO,
  POSTI_TEMPLATE,
  RIGA_RIEPILOGO,
  CELLA_DATA,
  GRADO
};
