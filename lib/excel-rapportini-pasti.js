'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'rapportino-pasti.xlsx');
const FIRST_ROW = 21;
const TEMPLATE_LAST_ROW = 71;
const FIRST_CAPACITY = TEMPLATE_LAST_ROW - FIRST_ROW + 1;
const CAT_COLS = Object.freeze({
  colazione: { sacchetto: 'E', servito: 'F', self: 'G' },
  pranzo: { sacchetto: 'H', servito: 'I', self: 'J', buono_pasto: 'K' },
  cena: { sacchetto: 'M', servito: 'N', self: 'O' }
});

function excelSerial(isoDate) {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error('Data non valida per il rapportino');
  return Math.round(ms / 86400000 + 25569);
}

function trovaCella(xml, ref) {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<c\\b(?=[^>]*\\br="${escaped}")[^>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)`);
  const match = re.exec(xml);
  if (!match) throw new Error(`Cella ${ref} non trovata nel modello Excel`);
  return match;
}

function scriviCella(xml, ref, value, numeric = false) {
  const match = trovaCella(xml, ref);
  const attrs = /^<c\b([^>]*)/.exec(match[0])[1]
    .replace(/\s+t="[^"]*"/g, '').replace(/\/$/, '');
  let replacement;
  if (value === null || value === undefined || value === '') {
    replacement = `<c${attrs}/>`;
  } else if (numeric) {
    replacement = `<c${attrs} t="n"><v>${Number(value)}</v></c>`;
  } else {
    const text = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    replacement = `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
  }
  return xml.slice(0, match.index) + replacement + xml.slice(match.index + match[0].length);
}

function scriviFormula(xml, ref, formula, value) {
  const match = trovaCella(xml, ref);
  const attrs = /^<c\b([^>]*)/.exec(match[0])[1]
    .replace(/\s+t="[^"]*"/g, '').replace(/\/$/, '');
  const replacement = `<c${attrs} t="n"><f>${formula}</f><v>${Number(value)}</v></c>`;
  return xml.slice(0, match.index) + replacement + xml.slice(match.index + match[0].length);
}

function numero(riga) { return Number(/^<row\b[^>]*\br="(\d+)"/.exec(riga)?.[1]); }
function rigaConNumero(xml, row) {
  return new RegExp(`<row\\b(?=[^>]*\\br="${row}")[^>]*>[\\s\\S]*?<\\/row>`).exec(xml)?.[0] || null;
}
function cambiaNumeroRiga(rowXml, next) {
  return rowXml.replace(/(<row\b[^>]*\br=")\d+/, `$1${next}`)
    .replace(/(<c\b[^>]*\br="[A-Z]+)\d+("[^>]*>)/g, `$1${next}$2`)
    .replace(/(<c\b[^>]*\br="[A-Z]+)\d+("\/>)/g, `$1${next}$2`);
}
function spostaRiferimentiFormula(rowXml, delta) {
  return rowXml.replace(/(<f[^>]*>)([\s\S]*?)(<\/f>)/g, (all, start, formula, end) => {
    const shifted = formula.replace(/(\$?[A-Z]{1,3}\$?)(\d+)/g, (ref, col, row) =>
      Number(row) >= 72 ? `${col}${Number(row) + delta}` : ref);
    return start + shifted + end;
  });
}

function adattaRighe(xml, count) {
  const delta = Math.max(0, count - FIRST_CAPACITY);
  if (!delta) return xml;
  const sheetDataStart = xml.indexOf('<sheetData>');
  const sheetDataEnd = xml.indexOf('</sheetData>');
  if (sheetDataStart < 0 || sheetDataEnd < 0) throw new Error('Sezione dati Excel non trovata');
  const before = xml.slice(0, sheetDataStart + '<sheetData>'.length);
  const after = xml.slice(sheetDataEnd);
  const body = xml.slice(sheetDataStart + '<sheetData>'.length, sheetDataEnd);
  const rows = body.match(/<row\b[\s\S]*?<\/row>/g) || [];
  const model = rows.find(r => numero(r) === TEMPLATE_LAST_ROW);
  if (!model) throw new Error('Riga modello allievi non trovata nel foglio Excel');
  const above = rows.filter(r => numero(r) < FIRST_ROW);
  const below = rows.filter(r => numero(r) > TEMPLATE_LAST_ROW)
    .map(r => spostaRiferimentiFormula(cambiaNumeroRiga(r, numero(r) + delta), delta));
  const added = Array.from({ length: count }, (_, i) => cambiaNumeroRiga(model, FIRST_ROW + i));
  let out = before + above.join('') + added.join('') + below.join('') + after;
  out = out.replace(/(<mergeCell\b[^>]*\bref="[A-Z]+)(\d+)(:[A-Z]+)(\d+)("\/>)/g,
    (m, a, first, b, last, z) => Number(first) >= 72 ? `${a}${Number(first) + delta}${b}${Number(last) + delta}${z}` : m);
  out = out.replace(/(<dimension\b[^>]*\bref="[A-Z]+\d+:[A-Z]+)(\d+)(")/,
    (m, a, last, z) => `${a}${Number(last) + delta}${z}`);
  return out;
}

function pulisciRigaAllievo(xml, row) {
  for (const col of 'ABCDEFGHIJKLMNOPQR') xml = scriviCella(xml, `${col}${row}`, null);
  return xml;
}
function valorePasto(person, meal) { return person.meals?.[meal]?.type || null; }
function noteRiga(person) {
  const notes = [];
  const names = { colazione: 'COLAZIONE', pranzo: 'PRANZO', cena: 'CENA' };
  for (const meal of ['colazione', 'pranzo', 'cena']) {
    const item = person.meals?.[meal] || {};
    if (item.type === 'servito' && item.serviceTime)
      notes.push(`ANTICIPO ${names[meal]} ${item.serviceTime}`);
    if (item.note && !notes.includes(item.note)) notes.push(item.note);
  }
  return notes.join('; ');
}
function colonnaPasto(meal, type) { return CAT_COLS[meal]?.[type] || null; }
function conteggi(persons) {
  const out = Object.fromEntries(['colazione', 'pranzo', 'cena'].map(meal =>
    [meal, { servito: 0, sacchetto: 0, self: 0, buono_pasto: 0 }]));
  for (const p of persons) for (const meal of Object.keys(out)) {
    const type = valorePasto(p, meal);
    if (type && out[meal][type] !== undefined) out[meal][type]++;
  }
  return out;
}
function contaAnticipi(persons, meal) {
  return persons.filter(p => p.meals?.[meal]?.type === 'servito' && p.meals?.[meal]?.serviceTime).length;
}
function names(p) {
  const firstName = String(p.firstName || '').trim();
  const lastName = String(p.lastName || '').trim();
  if (firstName || lastName) return { firstName, lastName };
  const bits = String(p.name || '').trim().split(/\s+/);
  return bits.length > 1 ? { firstName: bits.slice(0, -1).join(' '), lastName: bits[bits.length - 1] } : { firstName: bits[0] || '', lastName: '' };
}

function ordineCorsoExcel(person) {
  const code = String(person.courseCode || '').trim().toLocaleUpperCase('it');
  if (code === 'TRAMAT') return 0;
  if (code === 'MECCANICA') return 1;
  if (code === 'ELETTRONICA') return 2;
  if (code === 'INFORMATICA') return 3;
  if (['TCL.', 'TCL', 'TELECOMUNICAZIONI'].includes(code)) return 4;
  if (code === 'CIVILE') return 5;
  return 6;
}

async function compilaRapportino({ date, students = [], forecast = [] }) {
  if (!fs.existsSync(TEMPLATE)) throw new Error('Modello Excel dei rapportini non disponibile');
  const people = Array.isArray(students) ? [...students] : [];
  const collator = new Intl.Collator('it', { sensitivity: 'base' });
  people.sort((a, b) => {
    const courseDifference = ordineCorsoExcel(a) - ordineCorsoExcel(b);
    if (courseDifference) return courseDifference;
    const aName = names(a), bName = names(b);
    return collator.compare(aName.lastName, bName.lastName)
      || collator.compare(aName.firstName, bName.firstName);
  });
  const forecastPeople = Array.isArray(forecast) ? forecast : [];
  const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE));
  const sheetName = 'xl/worksheets/sheet1.xml';
  let xml = await zip.file(sheetName).async('string');
  xml = adattaRighe(xml, people.length);
  const lastRow = Math.max(FIRST_ROW, FIRST_ROW + people.length - 1);
  const delta = Math.max(0, people.length - FIRST_CAPACITY);
  const rowTotalsStudents = 72 + delta;
  const rowTotalsAll = 73 + delta;
  const rowAdvance = 74 + delta;
  const rowForecastDate = 77 + delta;
  const rowForecastCadets = 84 + delta;

  xml = scriviCella(xml, 'D5', excelSerial(date), true);
  // Ricrea la sola sezione degli allievi della 2ª Compagnia; le righe 1–16
  // del modello e i dati permanenti restano quelli del modello originale.
  for (let i = 0; i < FIRST_CAPACITY; i++) {
    const row = FIRST_ROW + i;
    if (i >= people.length) xml = pulisciRigaAllievo(xml, row);
  }
  people.forEach((p, i) => {
    const row = FIRST_ROW + i;
    const { firstName, lastName } = names(p);
    xml = scriviCella(xml, `A${row}`, i + 1, true);
    xml = scriviCella(xml, `B${row}`, 'A.U.');
    xml = scriviCella(xml, `C${row}`, lastName.toLocaleUpperCase('it'));
    xml = scriviCella(xml, `D${row}`, firstName);
    for (const col of 'EFGHIJKLMNOP') xml = scriviCella(xml, `${col}${row}`, 0, true);
    for (const meal of ['colazione', 'pranzo', 'cena']) {
      const type = valorePasto(p, meal);
      const col = colonnaPasto(meal, type);
      if (col) xml = scriviCella(xml, `${col}${row}`, 1, true);
    }
    xml = scriviCella(xml, `Q${row}`, p.courseCode || '');
    xml = scriviCella(xml, `R${row}`, noteRiga(p));
  });

  const actualCounts = conteggi(people);
  for (const col of ['B', ...'FGHIJKLMNOP']) {
    const categoryCol = col === 'B' ? 'E' : col;
    const meal = Object.keys(CAT_COLS).find(m => Object.values(CAT_COLS[m]).includes(categoryCol));
    const type = meal && Object.entries(CAT_COLS[meal]).find(([, c]) => c === categoryCol)?.[0];
    const count = meal && type ? actualCounts[meal][type] : 0;
    xml = scriviFormula(xml, `${col}${rowTotalsStudents}`, `SUM(${categoryCol}${FIRST_ROW}:${categoryCol}${lastRow})`, count);
    const fixedCell = col === 'B' ? 'E' : col;
    const fixedRows = [11, 12, 13, 14].reduce((sum, r) => sum + Number((/>(\d+)</.exec(trovaCella(xml, `${fixedCell}${r}`)[0]) || [])[1] || 0), 0);
    xml = scriviFormula(xml, `${col}${rowTotalsAll}`, `SUM(${fixedCell}15,${col}${rowTotalsStudents})`, count + fixedRows);
  }
  const anticipationRows = [
    ['F', 'colazione'], ['I', 'pranzo'], ['N', 'cena']
  ];
  for (const [col, meal] of anticipationRows) {
    const count = contaAnticipi(people, meal);
    const label = meal.toLocaleUpperCase('it');
    xml = scriviFormula(xml, `${col}${rowAdvance}`, `COUNTIF(R${FIRST_ROW}:R${lastRow},"ANTICIPO ${label}*")`, count);
  }

  // Il giorno dopo ha una sola riga di aggregazione AU (riga 84 del modello).
  xml = scriviFormula(xml, `C${rowForecastDate}`, 'D5+1', excelSerial(date) + 1);
  const foreCounts = conteggi(forecastPeople);
  const foreCols = { E: ['colazione', 'sacchetto'], F: ['colazione', 'servito'], G: ['colazione', 'self'],
    H: ['pranzo', 'sacchetto'], I: ['pranzo', 'servito'], J: ['pranzo', 'self'], K: ['pranzo', 'buono_pasto'],
    L: ['pranzo', null], M: ['cena', 'sacchetto'], N: ['cena', 'servito'], O: ['cena', 'self'], P: ['cena', null] };
  xml = scriviCella(xml, `B${rowForecastCadets}`, 0, true);
  for (const [col, [meal, type]] of Object.entries(foreCols))
    xml = scriviCella(xml, `${col}${rowForecastCadets}`, type ? foreCounts[meal][type] : 0, true);

  zip.file(sheetName, xml, { createFolders: false });
  const workbookName = 'xl/workbook.xml';
  let workbook = await zip.file(workbookName).async('string');
  if (/<calcPr\b/.test(workbook)) {
    workbook = workbook.replace(/<calcPr\b([^>]*?)(\/?)>/, (all, attrs, close) => {
      const updated = attrs
        .replace(/\s+calcMode="[^"]*"/g, '')
        .replace(/\s+fullCalcOnLoad="[^"]*"/g, '')
        .replace(/\s+forceFullCalc="[^"]*"/g, '');
      return `<calcPr${updated} calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"${close || ''}>`;
    });
  } else {
    workbook = workbook.replace('</workbook>', '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>');
  }
  zip.file(workbookName, workbook, { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, createFolders: false });
}

module.exports = { compilaRapportino, TEMPLATE, excelSerial, conteggi };
