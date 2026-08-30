'use strict';
// ============================================================
//  Invio email — usato dal recupero password
//
//  Nessuna credenziale è scritta qui dentro: host, utente e password
//  arrivano solo dalle variabili d'ambiente. Se non sono impostate il
//  modulo resta spento e lo dice, invece di fallire a ogni invio.
//
//  Configurazione minima (Gmail, il caso previsto per questo progetto):
//    SMTP_USER = indirizzo Gmail del mittente
//    SMTP_PASS = "password per le app" generata su myaccount.google.com
//  Opzionali, per usare un provider diverso:
//    SMTP_HOST (default smtp.gmail.com)
//    SMTP_PORT (default 465)
//    SMTP_FROM (default: "Portale Allievi Ufficiali <SMTP_USER>")
// ============================================================

const os = require('os');
const net = require('net');
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `Portale Allievi Ufficiali <${SMTP_USER}>` : '');

// ── Solo IPv4 verso il server di posta ───────────────────────────────
// Il contenitore dell'hosting espone un'interfaccia IPv6 ma non ha una rotta
// IPv6 verso l'esterno. Nodemailer risolve il nome da sé con dns.resolve4 e
// dns.resolve6, include gli indirizzi IPv6 perché "l'interfaccia c'è", e se
// prova a usarli l'invio muore con
//   connect ENETUNREACH 2a00:1450:4001:c21::6c:465
// oppure resta appeso fino al timeout. isFamilySupported() di nodemailer
// legge shared.networkInterfaces a ogni chiamata, apposta per poterlo
// sostituire: nascondendo le interfacce IPv6 restano solo gli indirizzi IPv4.
// SMTP_ALLOW_IPV6=1 disattiva questo accorgimento, se un giorno servisse.
function forzaIPv4() {
  if (process.env.SMTP_ALLOW_IPV6 === '1') return;
  try {
    const shared = require('nodemailer/lib/shared');
    if (!shared || !shared.networkInterfaces) return;
    shared.networkInterfaces = Object.fromEntries(
      Object.entries(os.networkInterfaces()).map(([nome, indirizzi]) =>
        [nome, (indirizzi || []).filter(i => i.family === 'IPv4' || i.family === 4)])
    );
  } catch (e) {
    console.warn('   email: preferenza IPv4 non applicata —', e.message);
  }
}
forzaIPv4();

function emailConfigurata() {
  return !!chiaveBrevo() || !!(SMTP_USER && SMTP_PASS);
}

function creaTrasporto(porta) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: porta,
    secure: porta === 465,   // 465 = TLS diretto; 587 e 2525 = STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Se la porta è bloccata o irraggiungibile è meglio saperlo in pochi
    // secondi che restare appesi per minuti: i valori predefiniti di
    // nodemailer sono 2 minuti per la connessione e 10 per il socket.
    dnsTimeout:        10 * 1000,
    connectionTimeout: 15 * 1000,
    greetingTimeout:   10 * 1000,
    socketTimeout:     30 * 1000
  });
}

let trasporto = null;
function trasportoAttivo() {
  if (!emailConfigurata()) return null;
  if (!trasporto) trasporto = creaTrasporto(SMTP_PORT);
  return trasporto;
}

// Descrizione della configurazione in uso, senza mai la password:
// serve alla rotta di diagnostica dell'amministratore.
function configurazioneEmail() {
  const brevo = !!chiaveBrevo();
  return {
    configurata: emailConfigurata(),
    canale: brevo ? 'brevo-https' : 'smtp',
    host: brevo ? 'api.brevo.com (HTTPS 443)' : SMTP_HOST,
    porta: brevo ? 443 : (portaFunzionante || SMTP_PORT),
    sicura: brevo || SMTP_PORT === 465,
    mittente: SMTP_FROM || null,
    // Forma della chiave, mai il suo valore: basta a diagnosticare un
    // incollaggio troncato o la chiave sbagliata.
    chiave: brevo ? formaChiave() : null,
    solo_ipv4: process.env.SMTP_ALLOW_IPV6 !== '1'
  };
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Brevo (email via HTTPS) ──────────────────────────────────────────
// Se l'hosting blocca le porte SMTP in uscita, l'unica strada che funziona
// sempre è la porta 443: Brevo espone un'API HTTPS per l'invio. Si attiva
// impostando BREVO_API_KEY (e ha la precedenza sull'SMTP quando presente).
// Il mittente è SMTP_FROM/SMTP_USER, che su Brevo va verificato una volta.
// Letta a ogni uso, non congelata al caricamento: su alcuni hosting le
// variabili possono arrivare dopo l'avvio del modulo.
// Ritagliata: incollando la chiave in un pannello di hosting è facile portarsi
// dietro uno spazio o un a capo, e il server della posta la rifiuterebbe come
// inesistente senza spiegare perché.
function chiaveBrevo() { return (process.env.BREVO_API_KEY || '').trim(); }

// Descrizione della chiave che si può mostrare senza esporla: il prefisso
// "xkeysib-" è uguale per tutte le chiavi API di Brevo, e la lunghezza dice
// subito se ne è stato incollato solo un pezzo. Serve a distinguere i tre casi
// che danno tutti "Key not found": chiave troncata, chiave revocata, e chiave
// SMTP presa al posto di quella API (che ha un formato diverso).
function formaChiave() {
  const k = chiaveBrevo();
  if (!k) return 'assente';
  return `${k.startsWith('xkeysib-') ? 'inizia con xkeysib-' : 'NON inizia con xkeysib-'}, ${k.length} caratteri`;
}

// Con Brevo le credenziali SMTP non servono più, ma un mittente sì: senza,
// l'API rifiuterebbe con un errore poco leggibile. Meglio dirlo qui.
function mittenteSpezzato() {
  const grezzo = (SMTP_FROM || SMTP_USER || '').trim();
  if (!grezzo)
    throw new Error('Mittente non configurato: imposta SMTP_FROM (o SMTP_USER) '
                  + 'con l\'indirizzo verificato su Brevo');
  // "Nome <indirizzo>" → { name, email }; oppure il solo indirizzo
  const m = /^(.*)<([^>]+)>\s*$/.exec(grezzo);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '') || undefined, email: m[2].trim() };
  return { email: grezzo };
}

async function inviaConBrevo({ a, oggetto, testo, html }) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': chiaveBrevo(), 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: mittenteSpezzato(),
      to: [{ email: a }],
      subject: oggetto,
      textContent: testo,
      ...(html ? { htmlContent: html } : {})
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) {
    const corpo = await r.text().catch(() => '');
    // Il suggerimento si decide dal codice HTTP, non cercando parole nel corpo:
    // un 401 contiene "unauthorized", che prima faceva scattare il consiglio
    // sbagliato ("verifica il mittente") mandando a caccia del problema
    // sbagliato. 401 riguarda sempre e solo la chiave.
    let suggerimento = '';
    if (r.status === 401) {
      suggerimento = ` — la chiave non è riconosciuta (${formaChiave()}). Controlla che sia`
        + ' incollata per intero, che sia quella della scheda "Chiavi API" e non della'
        + ' scheda "SMTP", e che non sia stata revocata su Brevo';
    } else if (r.status === 400 && /sender/i.test(corpo)) {
      suggerimento = ` — verifica che ${mittenteSpezzato().email} sia un mittente confermato`
        + ' su Brevo (Mittenti, domini e IP dedicati)';
    }
    const e = new Error(`Brevo ha rifiutato l'invio (HTTP ${r.status})${suggerimento}: ${corpo.slice(0, 250)}`);
    e.code = 'EBREVO';
    throw e;
  }
  return r.json();
}

// ── Invio con ripiego automatico di porta ────────────────────────────
// L'hosting può bloccare la porta configurata (in produzione la 465 va in
// "Connection timeout"): invece di fallire e basta, si riprova subito sulle
// altre porte SMTP note. Quella che funziona viene ricordata per il processo,
// così gli invii successivi partono al primo colpo. Cambiare SMTP_PORT resta
// possibile ma non più necessario.
const PORTE_SMTP = [465, 587, 2525];
let portaFunzionante = null;    // scoperta al primo invio riuscito

function eErroreDiPorta(e) {
  // Errori di connessione/handshake: la porta non parla. Un errore di
  // credenziali (EAUTH) NON è di porta: cambiarla non lo risolve.
  return !!e && ['ESOCKET', 'ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED',
                 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'EDNS', 'ETLS'].includes(e.code);
}

async function inviaVia(porta, msg) {
  const t = porta === SMTP_PORT ? trasportoAttivo() : creaTrasporto(porta);
  try {
    return await t.sendMail(msg);
  } finally {
    if (t !== trasporto) t.close();   // i trasporti usa e getta non restano aperti
  }
}

// `porta` forza un tentativo secco su quella porta (usata dalla diagnostica);
// senza, si parte dalla porta buona nota e si ripiega sulle altre.
async function inviaEmail({ a, oggetto, testo, html, porta }) {
  if (chiaveBrevo()) return inviaConBrevo({ a, oggetto, testo, html });
  if (!emailConfigurata())
    throw new Error('Servizio email non configurato (SMTP_USER / SMTP_PASS mancanti)');
  const msg = { from: SMTP_FROM, to: a, subject: oggetto, text: testo, html };

  if (porta) return inviaVia(Number(porta), msg);

  const daProvare = [...new Set([portaFunzionante, SMTP_PORT, ...PORTE_SMTP].filter(Boolean))];
  let ultimoErrore = null;
  for (const p of daProvare) {
    try {
      const esito = await inviaVia(p, msg);
      if (portaFunzionante !== p) {
        portaFunzionante = p;
        if (p !== SMTP_PORT)
          console.warn(`   email: porta ${SMTP_PORT} non raggiungibile, invio riuscito sulla ${p} — imposta SMTP_PORT=${p} per saltare i tentativi`);
      }
      return esito;
    } catch (e) {
      ultimoErrore = e;
      if (!eErroreDiPorta(e)) throw e;          // credenziali o rifiuto: inutile cambiare porta
      console.warn(`   email: porta ${p} non funziona (${e.code || e.message}), provo la successiva`);
    }
  }
  throw ultimoErrore || new Error('Nessuna porta SMTP raggiungibile');
}

// ── Sonda di raggiungibilità ─────────────────────────────────────────
// Apre e chiude subito una connessione TCP: non invia niente e non richiede
// credenziali. Serve a distinguere "porta bloccata dall'hosting" (timeout) da
// "credenziali sbagliate" (la porta risponde ma l'autenticazione fallisce).
function provaPorta(host, porta, timeoutMs = 8000) {
  return new Promise(risolvi => {
    const inizio = Date.now();
    let concluso = false;
    const socket = net.connect({ host, port: porta, family: 4 });
    const chiudi = (esito, dettaglio) => {
      if (concluso) return;
      concluso = true;
      socket.destroy();
      risolvi({ host, porta, esito, dettaglio: dettaglio || null, ms: Date.now() - inizio });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => chiudi('raggiungibile'));
    socket.once('timeout', () => chiudi('timeout'));
    socket.once('error', e => chiudi('errore', e.code || e.message));
  });
}

// Prova le porte SMTP usuali più un controllo su HTTPS: se anche il controllo
// fallisce il problema è la rete in generale, non le porte di posta.
async function diagnosticaRete() {
  const porte = [465, 587, 25, 2525];
  const prove = await Promise.all([
    ...porte.map(p => provaPorta(SMTP_HOST, p)),
    provaPorta('www.google.com', 443)
  ]);
  const controllo = prove[prove.length - 1];
  const smtp = prove.slice(0, -1);
  return {
    host: SMTP_HOST,
    porta_configurata: SMTP_PORT,
    controllo_https: controllo,
    porte: smtp,
    aperte: smtp.filter(p => p.esito === 'raggiungibile').map(p => p.porta)
  };
}

// ── Messaggio di reset password ──────────────────────────────────────
function emailReimpostaPassword({ nome, link, minutiValidita }) {
  const saluto = nome ? `Ciao ${nome},` : 'Ciao,';
  const testo =
`${saluto}

hai richiesto di reimpostare la password del Portale Allievi Ufficiali.

Apri questo link per scegliere una nuova password:
${link}

Il link vale ${minutiValidita} minuti e può essere usato una sola volta.

Se non hai richiesto tu il cambio password ignora questo messaggio:
la tua password attuale resta valida.`;

  const html =
`<div style="font-family:Arial,Helvetica,sans-serif;background:#05080d;padding:24px">
  <div style="max-width:480px;margin:0 auto;background:#0b121c;border:1px solid rgba(212,175,88,.3);border-radius:16px;padding:28px 24px;color:#e6edf5">
    <h1 style="margin:0 0 6px;font-size:19px;color:#f0d78c">Portale Allievi Ufficiali</h1>
    <p style="margin:0 0 20px;color:#8fa3bd;font-size:14px">Reimpostazione password</p>
    <p style="font-size:15px;line-height:1.6">${escapeHtml(saluto)}</p>
    <p style="font-size:15px;line-height:1.6">Hai richiesto di reimpostare la password del tuo account. Premi il pulsante qui sotto per sceglierne una nuova.</p>
    <p style="text-align:center;margin:26px 0">
      <a href="${escapeHtml(link)}" style="display:inline-block;background:#d4af58;color:#05080d;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:10px;font-size:15px">Scegli una nuova password</a>
    </p>
    <p style="font-size:13px;color:#8fa3bd;line-height:1.6">Il link vale <strong style="color:#e6edf5">${minutiValidita} minuti</strong> e può essere usato una sola volta.</p>
    <p style="font-size:13px;color:#8fa3bd;line-height:1.6">Se non hai richiesto tu il cambio password ignora questo messaggio: la tua password attuale resta valida.</p>
    <p style="font-size:11px;color:#54687f;word-break:break-all;margin-top:20px">Se il pulsante non funziona copia questo indirizzo nel browser:<br>${escapeHtml(link)}</p>
  </div>
</div>`;

  return { oggetto: 'Reimposta la password — Portale Allievi Ufficiali', testo, html };
}

module.exports = {
  emailConfigurata,
  configurazioneEmail,
  diagnosticaRete,
  provaPorta,
  inviaEmail,
  emailReimpostaPassword,
  SMTP_HOST,
  SMTP_PORT
};
