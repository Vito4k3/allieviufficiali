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
  return !!(SMTP_USER && SMTP_PASS);
}

let trasporto = null;
function trasportoAttivo() {
  if (!emailConfigurata()) return null;
  if (!trasporto) {
    trasporto = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,   // 465 = TLS diretto, 587 = STARTTLS
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
  return trasporto;
}

// Descrizione della configurazione in uso, senza mai la password:
// serve alla rotta di diagnostica dell'amministratore.
function configurazioneEmail() {
  return {
    configurata: emailConfigurata(),
    host: SMTP_HOST,
    porta: SMTP_PORT,
    sicura: SMTP_PORT === 465,
    mittente: SMTP_FROM || null,
    solo_ipv4: process.env.SMTP_ALLOW_IPV6 !== '1'
  };
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function inviaEmail({ a, oggetto, testo, html }) {
  const t = trasportoAttivo();
  if (!t) throw new Error('Servizio email non configurato (SMTP_USER / SMTP_PASS mancanti)');
  return t.sendMail({ from: SMTP_FROM, to: a, subject: oggetto, text: testo, html });
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
  inviaEmail,
  emailReimpostaPassword,
  SMTP_HOST,
  SMTP_PORT
};
