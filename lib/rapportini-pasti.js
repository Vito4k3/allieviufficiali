'use strict';

const TIPI_PASTO = Object.freeze(['servito', 'sacchetto', 'self', 'buono_pasto']);
const PASTI = Object.freeze(['colazione', 'pranzo', 'cena']);

// Valori iniziali ricavati dallo specchio A.A. 2026-2027 allegato.
// Il database li salva come regole settimanali modificabili senza cambiare codice.
const CORSI = Object.freeze({
  MECCANICA_TRAMAT: 'meccanica_tramat',
  INFORMATICA: 'informatica',
  TELECOMUNICAZIONI: 'telecomunicazioni',
  ELETTRONICA: 'elettronica',
  CIVILE: 'civile'
});

const ALIAS_CORSO = new Map([
  ['TRAMAT', CORSI.MECCANICA_TRAMAT], ['MECCANICA', CORSI.MECCANICA_TRAMAT],
  ['INFORMATICA', CORSI.INFORMATICA], ['TCL.', CORSI.TELECOMUNICAZIONI],
  ['TCL', CORSI.TELECOMUNICAZIONI], ['TELECOMUNICAZIONI', CORSI.TELECOMUNICAZIONI],
  ['ELETTRONICA', CORSI.ELETTRONICA], ['CIVILE', CORSI.CIVILE]
]);

function corsoNormalizzato(corso) {
  return ALIAS_CORSO.get(String(corso || '').trim().toLocaleUpperCase('it')) || null;
}

// weekday: 1 = lunedì … 5 = venerdì. Sabato e domenica restano senza regole
// finché non viene fornito un orario per quei giorni.
const REGOLE_INIZIALI = [];
function regola(weekday, course, meal, mealType, serviceTime = null, note = null) {
  REGOLE_INIZIALI.push({ weekday, course, meal, mealType, serviceTime, note });
}
function perCorso(course, weekday, colazione, pranzo, cena = ['servito']) {
  for (const [meal, values] of [['colazione', colazione], ['pranzo', pranzo], ['cena', cena]]) {
    const [mealType, serviceTime = null, note = null] = values;
    regola(weekday, course, meal, mealType, serviceTime, note);
  }
}
const S = ['servito'], B = ['buono_pasto'], A07 = ['servito', '07:00'];
const A0630 = ['servito', '06:30'], A0650 = ['servito', '06:50'];
const A1250 = ['servito', '12:50'], A1245 = ['servito', '12:45'];

// Lunedì
perCorso(CORSI.CIVILE, 1, ['sacchetto', null, 'Ritiro domenica sera'], B);
perCorso(CORSI.ELETTRONICA, 1, S, B);
perCorso(CORSI.INFORMATICA, 1, A07, B);
perCorso(CORSI.MECCANICA_TRAMAT, 1, A07, B);
perCorso(CORSI.TELECOMUNICAZIONI, 1, S, B);

// Martedì
perCorso(CORSI.CIVILE, 2, S, S);
perCorso(CORSI.ELETTRONICA, 2, S, B);
perCorso(CORSI.INFORMATICA, 2, A07, B);
perCorso(CORSI.MECCANICA_TRAMAT, 2, S, A1250);
perCorso(CORSI.TELECOMUNICAZIONI, 2, S, B);
// Mercoledì
perCorso(CORSI.CIVILE, 3, A07, B);
perCorso(CORSI.ELETTRONICA, 3, S, B);
perCorso(CORSI.INFORMATICA, 3, S, S);
perCorso(CORSI.MECCANICA_TRAMAT, 3, A07, B);
perCorso(CORSI.TELECOMUNICAZIONI, 3, S, B);
// Giovedì
perCorso(CORSI.CIVILE, 4, A07, B);
perCorso(CORSI.ELETTRONICA, 4, A0630, B);
perCorso(CORSI.INFORMATICA, 4, A07, S);
perCorso(CORSI.MECCANICA_TRAMAT, 4, A0630, B);
perCorso(CORSI.TELECOMUNICAZIONI, 4, S, B);
// Venerdì
perCorso(CORSI.CIVILE, 5, A07, B);
perCorso(CORSI.ELETTRONICA, 5, A0650, A1245);
perCorso(CORSI.INFORMATICA, 5, A07, B);
perCorso(CORSI.MECCANICA_TRAMAT, 5, A07, A1245);
perCorso(CORSI.TELECOMUNICAZIONI, 5, A0650, A1245);

function dataISOValida(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function giornoSettimana(value) {
  const d = new Date(`${value}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function giornoSuccessivo(value) {
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  TIPI_PASTO, PASTI, CORSI, REGOLE_INIZIALI,
  corsoNormalizzato, dataISOValida, giornoSettimana, giornoSuccessivo
};
