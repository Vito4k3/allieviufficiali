// ============================================================
//  Portale Allievi Ufficiali — Backend Server
//  Node.js + Express + MySQL 
// ============================================================
'use strict';

const express      = require('express');
const compression  = require('compression');
const mysql        = require('mysql2/promise');
const bcrypt       = require('bcrypt');
const jwt          = require('jsonwebtoken');
const cors         = require('cors');
const crypto       = require('crypto');
const path         = require('path');
const excelLU = require('./lib/excel-libere-uscite');
const pasti = require('./lib/rapportini-pasti');
const excelPasti = require('./lib/excel-rapportini-pasti');
const mailer  = require('./lib/email');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // dietro il proxy dell'hosting (per HTTPS e IP reali)

// Errori interni: log completo sul server, messaggio generico al client
function errServer(res, e, contesto = '') {
  // Lo stack va nei log (serve per capire DOVE è nato l'errore), al client
  // arriva solo un messaggio generico: mai dettagli interni.
  console.error(contesto ? `[ERRORE SERVER][${contesto}]` : '[ERRORE SERVER]', e.stack || e.message);
  res.status(500).json({ error: 'Errore interno del server. Riprova più tardi.' });
}

// ── CONFIG ────────────────────────────────────────────────────
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
if (process.env.NODE_ENV === 'production' && JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET deve essere configurato in produzione e contenere almeno 32 caratteri casuali.');
}
// In sviluppo una chiave casuale evita il segreto noto e non riutilizzabile tra riavvii.
const CHIAVE_JWT = JWT_SECRET || crypto.randomBytes(48).toString('base64url');
const PORT       = parseInt(process.env.PORT || '3000');
const PKG_VERSION = require('./package.json').version;

const DB_CONFIG = {
  host              : process.env.DB_HOST,
  port              : parseInt(process.env.DB_PORT || '3306'),
  user              : process.env.DB_USER,
  password          : process.env.DB_PASS,
  database          : process.env.DB_NAME,
  waitForConnections: true,
  // Il database sta dietro il proxy TCP di Railway, che chiude le connessioni
  // rimaste inattive. Un pool grande e senza scadenza accumulava socket ormai
  // morti e la query successiva falliva con
  //   "Connection lost: The server closed the connection".
  // Poche connessioni, chiuse prima che sia il proxy a tagliarle, piu' il
  // keep-alive che tiene viva quella in uso.
  connectionLimit      : 10,
  maxIdle              : 4,
  idleTimeout          : 60000,        // 60 s, sotto la soglia del proxy
  enableKeepAlive      : true,
  keepAliveInitialDelay: 10000,
  charset              : 'utf8mb4'
};

// Codici che significano "la connessione e' caduta", non "la query e'
// sbagliata": su questi conviene riprovare una volta con una connessione
// nuova invece di restituire un 500 all'utente.
const ERRORI_CONNESSIONE = new Set([
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_SEQUENCE_TIMEOUT', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
  'ECONNREFUSED', 'ER_CON_COUNT_ERROR', 'ER_SERVER_SHUTDOWN'
]);
function eErroreDiConnessione(e) {
  return !!e && (ERRORI_CONNESSIONE.has(e.code) || e.fatal === true);
}

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(compression()); // risposte compresse: pagine più veloci

// CORS chiuso: sito e API vivono sullo stesso indirizzo, quindi il browser
// non ha bisogno di CORS per il funzionamento normale. Prima qui c'era
// `origin: true` con credenziali: rifletteva QUALSIASI origine, cioè una
// pagina ostile su un altro dominio poteva leggere le risposte delle API
// usando il cookie di sessione del visitatore. Restano ammessi solo
// l'indirizzo pubblico configurato e localhost per lo sviluppo.
const ORIGINI_AMMESSE = new Set(
  [(process.env.APP_URL || '').trim().replace(/\/+$/, '')].filter(Boolean)
);
app.use(cors({
  credentials: true,
  origin(origin, cb) {
    if (!origin) return cb(null, true);                       // stessa origine / curl
    if (ORIGINI_AMMESSE.has(origin)) return cb(null, true);
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    return cb(null, false);                                    // niente intestazioni CORS
  }
}));

// Header di sicurezza su ogni risposta
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

function verificaFirmaStripe(body, header, secret) {
  if (!Buffer.isBuffer(body) || !secret || !header) return false;
  const fields = String(header).split(',').map(v => v.split('=', 2));
  const timestamp = fields.find(([key]) => key === 't')?.[1];
  const signatures = fields.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !signatures.length || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest();
  return signatures.some(signature => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const received = Buffer.from(signature, 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  });
}

async function accreditaCreditiStripe(session) {
  if (session?.payment_status !== 'paid'
      || session.mode !== 'payment'
      || session.currency !== 'eur'
      || Number(session.amount_total) !== 100
      || session.metadata?.purpose !== 'meal_pasti_credit_pack'
      || Number(session.metadata?.credits) !== 3) return;
  const userId = Number(session.metadata?.user_id);
  if (!Number.isInteger(userId) || userId <= 0 || !session.id) return;
  const c = await db();
  const connection = await c.getConnection();
  try {
    await connection.beginTransaction();
    const [insert] = await connection.execute(
      `INSERT IGNORE INTO meal_credit_payments
       (stripe_session_id,user_id,amount_cents,credits) VALUES (?,?,100,3)`,
      [session.id, userId]
    );
    if (insert.affectedRows) {
      const [update] = await connection.execute(
        'UPDATE users SET meal_export_credits=meal_export_credits+3 WHERE id=?', [userId]
      );
      if (!update.affectedRows) throw new Error('Utente del pagamento non trovato');
    }
    await connection.commit();
  } catch (e) {
    try { await connection.rollback(); } catch {}
    throw e;
  } finally {
    connection.release();
  }
}

async function accreditaAcquistoShop(session) {
  if (session?.payment_status !== 'paid' || session.mode !== 'payment' || session.currency !== 'eur'
      || session.metadata?.purpose !== 'shop_kaps_listing') return;
  const listingId = Number(session.metadata?.listing_id);
  const buyerId = Number(session.metadata?.buyer_id);
  if (!Number.isInteger(listingId) || listingId <= 0 || !Number.isInteger(buyerId) || buyerId <= 0 || !session.id) return;
  const c = await db();
  const connection = await c.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT id,price_cents,status,pending_buyer_id,pending_session_id,pending_commission_percent,pending_commission_cents,pending_seller_net_cents FROM shop_kaps_listings WHERE id=? FOR UPDATE', [listingId]
    );
    const listing = rows[0];
    if (!listing || Number(listing.pending_buyer_id) !== buyerId || listing.pending_session_id !== session.id
        || Number(session.amount_total) !== Number(listing.price_cents)) {
      await connection.rollback();
      return;
    }
    // Migrazione morbida: completa eventuali Checkout creati dalla versione
    // precedente, che non salvava ancora la ripartizione della commissione.
    const commissionPercent = listing.pending_commission_percent == null
      ? shopCommissionPercent() : Number(listing.pending_commission_percent);
    const commissionCents = listing.pending_commission_cents == null
      ? Math.round(Number(listing.price_cents) * commissionPercent / 100) : Number(listing.pending_commission_cents);
    const sellerNetCents = listing.pending_seller_net_cents == null
      ? Number(listing.price_cents) - commissionCents : Number(listing.pending_seller_net_cents);
    if (session.metadata?.commission_cents != null
        && (Number(session.metadata?.commission_percent) !== commissionPercent
          || Number(session.metadata?.commission_cents) !== commissionCents
          || Number(session.metadata?.seller_net_cents) !== sellerNetCents)) {
      await connection.rollback();
      return;
    }
    await connection.execute(
      `UPDATE shop_kaps_listings SET status='purchased',buyer_id=?,stripe_session_id=?,commission_percent=?,commission_cents=?,seller_net_cents=?,purchased_at=CURRENT_TIMESTAMP,
       pending_buyer_id=NULL,pending_session_id=NULL,pending_until=NULL,pending_commission_percent=NULL,pending_commission_cents=NULL,pending_seller_net_cents=NULL WHERE id=? AND status='available'`,
      [buyerId, session.id, commissionPercent, commissionCents, sellerNetCents, listingId]
    );
    await connection.commit();
  } catch (e) {
    try { await connection.rollback(); } catch {}
    throw e;
  } finally { connection.release(); }
}

// Stripe richiede il corpo originale per verificare la firma del webhook; la
// rotta è registrata prima del parser JSON generale.
app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  if (!verificaFirmaStripe(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET))
    return res.status(400).send('Firma Stripe non valida');
  try {
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await accreditaCreditiStripe(event.data?.object);
      await accreditaAcquistoShop(event.data?.object);
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const session = event.data?.object;
      if (session?.id) {
        const c = await db();
        await c.execute(
          'UPDATE shop_kaps_listings SET pending_buyer_id=NULL,pending_session_id=NULL,pending_until=NULL,pending_commission_percent=NULL,pending_commission_cents=NULL,pending_seller_net_cents=NULL WHERE pending_session_id=? AND status=\'available\'',
          [session.id]
        );
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[STRIPE WEBHOOK]', e.stack || e.message);
    res.status(500).json({ error: 'Elaborazione pagamento non riuscita' });
  }
});

// Limite del corpo: 10 MB servono SOLO ai comunicati con allegato. Tenere
// quel limite su tutte le rotte significava accettare 10 MB anche su un
// login. Il resto dell'API viaggia con un tetto normale.
const jsonNormale = express.json({ limit: '256kb' });
const jsonAllegati = express.json({ limit: '10mb' });
app.use((req, res, next) => {
  if (req.path === '/api/comunicazioni/posts' && req.method === 'POST')
    return jsonAllegati(req, res, next);
  return jsonNormale(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    const nome = path.basename(filePath);
    if (nome === 'sw.js' || nome === 'manifest.webmanifest') {
      // il service worker deve essere sempre ricontrollato (aggiornamenti app)
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.includes('icons')) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

// ── ANTI BRUTE-FORCE ──────────────────────────────────────────
// Il conteggio va fatto su CHI si sta cercando di forzare, non su da dove
// arriva la richiesta.
//
// In Accademia gli allievi escono quasi tutti dalla stessa rete, quindi per il
// server hanno un solo indirizzo IP: un tetto per IP li mette tutti nello
// stesso secchio, e il lunedì mattina bastava che accedessero in quindici
// perché al sedicesimo comparisse "Troppi tentativi" senza aver sbagliato
// nulla. Il tetto per IP resta, ma largo e solo come rete di sicurezza contro
// i tentativi automatici; quello stretto è sull'identità presa di mira:
// lo username per il login, l'indirizzo email per il recupero password.
//
// Su un attacco vero questo protegge di più: chi prova mille password su un
// account viene fermato dopo dieci tentativi, indipendentemente da quanti
// indirizzi IP usi.
const QUARTO_DORA = 15 * 60 * 1000;

const tentativi = new Map(); // "nome|chiave" → { n, primoTs }

/**
 * @param {string}   nome        etichetta del contatore (una per rotta e per asse)
 * @param {number}   max         tentativi consentiti nella finestra
 * @param {number}   finestraMs  durata della finestra
 * @param {Function} [estrai]    da cosa contare; se assente si conta per IP.
 *                               Se restituisce vuoto il controllo non si applica
 *                               (la rotta rifiuterà comunque i dati mancanti).
 */
function limitaTentativi(nome, max, finestraMs, estrai) {
  return (req, res, next) => {
    const valore = estrai ? estrai(req) : req.ip;
    if (!valore) return next();
    const chiave = nome + '|' + valore;
    const ora = Date.now();
    const rec = tentativi.get(chiave);
    if (!rec || ora - rec.primoTs > finestraMs) {
      tentativi.set(chiave, { n: 1, primoTs: ora });
      return next();
    }
    rec.n++;
    if (rec.n > max) {
      const attesa = Math.ceil((rec.primoTs + finestraMs - ora) / 60000);
      return res.status(429).json({ error: `Troppi tentativi. Riprova tra ${attesa} minut${attesa === 1 ? 'o' : 'i'}.` });
    }
    next();
  };
}

// Un accesso riuscito azzera il conto di quell'account: solo i tentativi
// falliti di fila devono avvicinare al blocco, altrimenti chi entra e riesce
// più volte nella stessa mattina si sbarrerebbe la porta da solo.
function azzeraTentativi(nome, valore) {
  if (valore) tentativi.delete(nome + '|' + valore);
}

// Restituisce il gettone consumato da una richiesta andata a buon fine: sul
// tetto per IP devono pesare solo i fallimenti. Senza questo, duecento allievi
// che accedono regolarmente dalla stessa rete esaurirebbero il budget pur non
// avendo sbagliato nulla — cioè proprio il caso che il limite non deve colpire.
function scalaTentativo(nome, valore) {
  const rec = valore && tentativi.get(nome + '|' + valore);
  if (rec && rec.n > 0) rec.n--;
}

// Come il server legge username ed email dalle richieste, normalizzati così
// che "Mario" e " mario " finiscano nello stesso conteggio.
const chiaveUtente = req => String(req.body?.username || '').trim().toLowerCase();
const chiaveEmail  = req => String(req.body?.email    || '').trim().toLowerCase();
// pulizia periodica della mappa
setInterval(() => {
  const ora = Date.now();
  for (const [chiave, rec] of tentativi) if (ora - rec.primoTs > 30 * 60 * 1000) tentativi.delete(chiave);
}, 10 * 60 * 1000).unref();

// ── DB POOL ───────────────────────────────────────────────────
// db() non restituisce il pool nudo ma un involucro con lo stesso metodo
// execute(): se la connessione presa dal pool era già stata chiusa dal proxy,
// la query viene ripetuta una sola volta su una connessione nuova. Così tutte
// le rotte restano invariate e smettono di rispondere 500 per un socket morto.
let pool;
function poolAttivo() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

async function eseguiConRitentativo(metodo, sql, params) {
  const p = poolAttivo();
  try {
    return params === undefined ? await p[metodo](sql) : await p[metodo](sql, params);
  } catch (e) {
    if (!eErroreDiConnessione(e)) throw e;
    console.warn('   DB: connessione caduta, riprovo una volta —', e.code || e.message);
    // Il pool scarta da solo la connessione fallita: il secondo tentativo
    // ne apre una nuova.
    return params === undefined ? await p[metodo](sql) : await p[metodo](sql, params);
  }
}

const clienteDb = {
  execute: (sql, params) => eseguiConRitentativo('execute', sql, params),
  query:   (sql, params) => eseguiConRitentativo('query',   sql, params),
  getConnection: () => poolAttivo().getConnection()
};

async function db() {
  return clienteDb;
}

// ── RIPARAZIONE CHIAVI (migrazione da freesqldatabase a Railway) ──────
// Il dump importato su Railway conteneva tabelle e dati ma nessuna chiave:
// niente PRIMARY KEY, niente UNIQUE, niente AUTO_INCREMENT. Su MySQL 5.5
// molti effetti restavano nascosti, su MySQL 8 no. Conseguenze osservate:
//   • registrazione utente → "Field 'id' doesn't have a default value"
//   • invio annuncio       → "Field 'id' doesn't have a default value"
//   • doppie iscrizioni alle liste (ER_DUP_ENTRY non scattava più)
// Lo stesso contenuto è in db/ripristina-chiavi-railway.sql, ma affidarsi a
// un'esecuzione manuale significa restare rotti finché qualcuno non la lancia:
// qui il server verifica e ripara da solo all'avvio. Tutto è idempotente e non
// tocca nessun dato, solo la struttura.

// Tabelle con id numerico che il codice NON valorizza negli INSERT:
// senza AUTO_INCREMENT ogni inserimento fallisce.
const TABELLE_AUTOINCREMENT = ['users', 'announcements', 'schedule_entries'];

// Tabelle con id proprio che devono avere la PRIMARY KEY
const TABELLE_CHIAVE_ID = [
  'users', 'announcements', 'schedule_entries', 'lists', 'list_signups',
  'list_relatives', 'subjects', 'grades', 'penalties', 'notes',
  'finance_transactions', 'calendar_events', 'comunicazioni_chat',
  'comunicazioni_posts'
];

// Vincoli di unicità su cui il codice si appoggia per i messaggi d'errore
// ("Username o email già registrati", "Già iscritto a questa lista") e per
// l'ON DUPLICATE KEY UPDATE dell'orario.
const VINCOLI_UNICI = [
  { tabella: 'users',            nome: 'uq_users_username', colonne: ['username'] },
  { tabella: 'users',            nome: 'uq_users_email',    colonne: ['email'] },
  { tabella: 'list_signups',     nome: 'unique_signup',     colonne: ['list_id', 'user_id'] },
  { tabella: 'schedule_entries', nome: 'uq_schedule_slot',  colonne: ['user_id', 'day_index', 'hour'] }
];

// Indici di sola ricerca: senza, ogni query fa una scansione completa
const INDICI_RICERCA = [
  { tabella: 'subjects',             nome: 'idx_subjects_user',  colonne: ['user_id'] },
  { tabella: 'grades',               nome: 'idx_grades_user',    colonne: ['user_id'] },
  { tabella: 'grades',               nome: 'idx_grades_subject', colonne: ['subject_id'] },
  { tabella: 'penalties',            nome: 'idx_penalties_user', colonne: ['user_id'] },
  { tabella: 'notes',                nome: 'idx_notes_user',     colonne: ['user_id'] },
  { tabella: 'finance_transactions', nome: 'idx_finance_user',   colonne: ['user_id'] },
  { tabella: 'announcements',        nome: 'idx_ann_user',       colonne: ['user_id'] },
  { tabella: 'announcements',        nome: 'idx_ann_created',    colonne: ['created_at'] },
  { tabella: 'list_signups',         nome: 'idx_signups_list',   colonne: ['list_id'] },
  { tabella: 'list_relatives',       nome: 'idx_relatives_list', colonne: ['list_id', 'user_id'] },
  { tabella: 'calendar_events',      nome: 'idx_cal_date',       colonne: ['event_date'] },
  { tabella: 'comunicazioni_posts',  nome: 'idx_posts_created',  colonne: ['created_at'] }
];

// Esito dell'ultima riparazione, rileggibile da GET /api/admin/db-stato
let statoSchema = { eseguita: false, riparazioni: [], problemi: [] };

function nomeSicuro(x) {           // solo identificatori del codice, mai input utente
  if (!/^[A-Za-z0-9_]+$/.test(x)) throw new Error('Identificatore non valido: ' + x);
  return '`' + x + '`';
}

async function riparaChiaviDatabase(c) {
  const riparazioni = [], problemi = [];

  // Una sola lettura di information_schema per tabelle, colonne e indici
  const [tabelle] = await c.execute(
    'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  const esistenti = new Set(tabelle.map(r => r.t));

  const [colonne] = await c.execute(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS col, EXTRA AS extra, COLUMN_TYPE AS tipo
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);
  const infoColonna = new Map(colonne.map(r => [r.t + '.' + r.col, r]));

  const [indici] = await c.execute(
    `SELECT TABLE_NAME AS t, INDEX_NAME AS idx FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()`);
  const indiciPresenti = new Set(indici.map(r => r.t + '.' + r.idx));

  // ── 1. PRIMARY KEY su id ────────────────────────────────────
  for (const t of TABELLE_CHIAVE_ID) {
    if (!esistenti.has(t) || indiciPresenti.has(t + '.PRIMARY')) continue;
    if (!infoColonna.has(t + '.id')) continue;
    try {
      // Righe con id duplicato renderebbero impossibile la chiave: meglio
      // dirlo che fallire in silenzio.
      const [dup] = await c.execute(
        `SELECT COUNT(*) AS n FROM (SELECT id FROM ${nomeSicuro(t)}
          GROUP BY id HAVING COUNT(*) > 1) AS d`);
      if (Number(dup[0].n) > 0) {
        problemi.push(`${t}: ${dup[0].n} id duplicati, PRIMARY KEY non applicabile`);
        continue;
      }
      await c.execute(`ALTER TABLE ${nomeSicuro(t)} ADD PRIMARY KEY (id)`);
      riparazioni.push(`${t}: PRIMARY KEY (id)`);
    } catch (e) {
      problemi.push(`${t}: PRIMARY KEY non aggiunta — ${e.message}`);
    }
  }

  // grade_settings è l'unica con la chiave su un'altra colonna: una riga di
  // impostazioni per utente, non un id proprio.
  if (esistenti.has('grade_settings') && !indiciPresenti.has('grade_settings.PRIMARY')
      && infoColonna.has('grade_settings.user_id')) {
    try {
      const [dup] = await c.execute(
        'SELECT COUNT(*) AS n FROM (SELECT user_id FROM `grade_settings` GROUP BY user_id HAVING COUNT(*) > 1) AS d');
      if (Number(dup[0].n) > 0) {
        problemi.push(`grade_settings: ${dup[0].n} utenti con impostazioni duplicate`);
      } else {
        await c.execute('ALTER TABLE `grade_settings` ADD PRIMARY KEY (`user_id`)');
        riparazioni.push('grade_settings: PRIMARY KEY (user_id)');
      }
    } catch (e) {
      problemi.push(`grade_settings: PRIMARY KEY non aggiunta — ${e.message}`);
    }
  }

  // ── 2. AUTO_INCREMENT (richiede che id sia già chiave) ──────
  for (const t of TABELLE_AUTOINCREMENT) {
    const col = infoColonna.get(t + '.id');
    if (!esistenti.has(t) || !col) continue;
    if (String(col.extra || '').toLowerCase().includes('auto_increment')) continue;
    try {
      const tipo = /int/i.test(col.tipo) ? col.tipo : 'int';
      await c.execute(
        `ALTER TABLE ${nomeSicuro(t)} MODIFY \`id\` ${tipo} NOT NULL AUTO_INCREMENT`);
      riparazioni.push(`${t}: id AUTO_INCREMENT`);
    } catch (e) {
      problemi.push(`${t}: AUTO_INCREMENT non applicato — ${e.message}`);
    }
  }

  // ── 3. Vincoli di unicità ───────────────────────────────────
  for (const v of VINCOLI_UNICI) {
    if (!esistenti.has(v.tabella)) continue;
    if (indiciPresenti.has(v.tabella + '.' + v.nome)) continue;
    if (v.colonne.some(col => !infoColonna.has(v.tabella + '.' + col))) continue;
    const elenco = v.colonne.map(nomeSicuro).join(',');
    try {
      const [dup] = await c.execute(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${nomeSicuro(v.tabella)}
          GROUP BY ${elenco} HAVING COUNT(*) > 1) AS d`);
      if (Number(dup[0].n) > 0) {
        problemi.push(`${v.tabella}.${v.nome}: ${dup[0].n} gruppi duplicati da ripulire prima`);
        continue;
      }
      await c.execute(
        `ALTER TABLE ${nomeSicuro(v.tabella)} ADD UNIQUE KEY ${nomeSicuro(v.nome)} (${elenco})`);
      riparazioni.push(`${v.tabella}: UNIQUE ${v.nome}`);
    } catch (e) {
      problemi.push(`${v.tabella}.${v.nome}: non aggiunto — ${e.message}`);
    }
  }

  // ── 4. Indici di ricerca ────────────────────────────────────
  for (const i of INDICI_RICERCA) {
    if (!esistenti.has(i.tabella)) continue;
    if (indiciPresenti.has(i.tabella + '.' + i.nome)) continue;
    if (i.colonne.some(col => !infoColonna.has(i.tabella + '.' + col))) continue;
    try {
      await c.execute(`ALTER TABLE ${nomeSicuro(i.tabella)} ADD KEY ${nomeSicuro(i.nome)} `
        + `(${i.colonne.map(nomeSicuro).join(',')})`);
      riparazioni.push(`${i.tabella}: indice ${i.nome}`);
    } catch (e) {
      problemi.push(`${i.tabella}.${i.nome}: non aggiunto — ${e.message}`);
    }
  }

  statoSchema = { eseguita: true, quando: new Date().toISOString(), riparazioni, problemi };
  if (riparazioni.length) {
    console.log('   DB: chiavi ripristinate →\n     - ' + riparazioni.join('\n     - '));
  } else {
    console.log('   DB: chiavi già a posto, nessuna riparazione necessaria');
  }
  if (problemi.length) {
    console.warn('   DB: da sistemare a mano →\n     - ' + problemi.join('\n     - '));
  }
  return statoSchema;
}

// ── DB INIT ───────────────────────────────────────────────────
async function initDB() {
  try {
    const c = await db();

    // Prima di tutto: le chiavi perse nella migrazione a Railway. Senza
    // AUTO_INCREMENT su users e announcements, registrazione e bacheca
    // falliscono e nessuna delle migrazioni che seguono serve a niente.
    try {
      await riparaChiaviDatabase(c);
    } catch (e) {
      console.error('   DB: riparazione chiavi non riuscita:', e.message);
      statoSchema = { eseguita: false, riparazioni: [], problemi: [e.message] };
    }

    // Aggiungi colonna role se non esiste
    try {
      await c.execute("ALTER TABLE users ADD COLUMN role VARCHAR(50) NOT NULL DEFAULT 'none'");
    } catch(e) { /* colonna già esistente */ }

    // Aggiungi colonna cognome per ordinamento liste
    try {
      await c.execute("ALTER TABLE users ADD COLUMN cognome VARCHAR(100) NOT NULL DEFAULT ''");
    } catch(e) { /* colonna già esistente */ }

    // Aggiungi colonna nome (separato da cognome)
    try {
      await c.execute("ALTER TABLE users ADD COLUMN nome VARCHAR(100) NOT NULL DEFAULT ''");
    } catch(e) { /* colonna già esistente */ }

    // ── MIGRAZIONE AUTOMATICA UTENTI ESISTENTI ──────────────────
    // Per chi ha cognome già impostato manualmente: ricava nome da full_name
    await c.execute(`
      UPDATE users
      SET nome = TRIM(REPLACE(TRIM(full_name), cognome, ''))
      WHERE cognome != '' AND nome = '' AND full_name != ''
    `);
    // Per chi NON ha cognome: ultima parola di full_name → cognome, resto → nome
    await c.execute(`
      UPDATE users
      SET
        cognome = IF(TRIM(full_name) LIKE '% %',
          TRIM(SUBSTRING_INDEX(TRIM(full_name), ' ', -1)),
          TRIM(full_name)),
        nome = IF(TRIM(full_name) LIKE '% %',
          TRIM(SUBSTRING(TRIM(full_name), 1,
            LENGTH(TRIM(full_name)) - LENGTH(SUBSTRING_INDEX(TRIM(full_name),' ',-1)) - 1)),
          '')
      WHERE cognome = '' AND full_name != ''
    `);

    // Tabella chat comunicazioni
    await c.execute(`
      CREATE TABLE IF NOT EXISTS comunicazioni_chat (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Indice per l'ordinamento della chat e per la potatura dei messaggi
    try {
      await c.execute("ALTER TABLE comunicazioni_chat ADD INDEX idx_chat_created (created_at)");
    } catch(e) { /* già presente */ }

    // Tabella comunicati ufficiali (con file opzionale)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS comunicazioni_posts (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) DEFAULT '',
        content LONGTEXT,
        file_name VARCHAR(255),
        file_data LONGTEXT,
        file_type VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabella liste
    await c.execute(`
      CREATE TABLE IF NOT EXISTS lists (
        id VARCHAR(64) PRIMARY KEY,
        list_type VARCHAR(50) NOT NULL,
        list_date DATE NOT NULL,
        notes VARCHAR(500),
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabella iscrizioni liste
    await c.execute(`
      CREATE TABLE IF NOT EXISTS list_signups (
        id VARCHAR(64) PRIMARY KEY,
        list_id VARCHAR(64) NOT NULL,
        user_id INT NOT NULL,
        relative_name VARCHAR(255),
        relative_relation VARCHAR(100),
        relative_id_card VARCHAR(100),
        note VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        signed_up_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_signup (list_id, user_id)
      )
    `);

    // Aggiungi colonna note se non esiste (per chi ha già la tabella)
    try {
      await c.execute("ALTER TABLE list_signups ADD COLUMN note VARCHAR(500)");
    } catch(e) { /* colonna già esistente */ }

    // ── ALLINEAMENTO SCHEMA list_signups ────────────────────────
    // GET /api/lists/:id ordina per signed_up_at, ma le tabelle create da
    // initDB avevano solo created_at: su un database ricreato da zero
    // (es. dopo una migrazione) la query fallirebbe con "Unknown column".
    // Controlliamo le colonne davvero presenti e aggiungiamo solo il mancante.
    try {
      const [colonne] = await c.execute(`
        SELECT COLUMN_NAME AS nome FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'list_signups'
      `);
      const nomi = colonne.map(r => r.nome);
      if (nomi.length && !nomi.includes('signed_up_at')) {
        await c.execute("ALTER TABLE list_signups ADD COLUMN signed_up_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP");
        // Recupera l'ordine cronologico reale dalle iscrizioni già presenti
        if (nomi.includes('created_at')) {
          await c.execute("UPDATE list_signups SET signed_up_at = created_at");
        }
        console.log('   DB: aggiunta colonna list_signups.signed_up_at');
      }
    } catch(e) {
      console.warn('   DB: controllo colonne list_signups non riuscito:', e.message);
    }

    // Il vincolo anti doppia iscrizione (unique_signup) è tra quelli che
    // riparaChiaviDatabase controlla e ripristina: qui non serve più, e
    // tenerlo in due punti significava provare ad aggiungerlo anche quando
    // le iscrizioni duplicate lo rendono impossibile.

    // Liste personalizzate: nome + definizione campi (JSON array di etichette)
    try {
      await c.execute("ALTER TABLE lists ADD COLUMN custom_name VARCHAR(255) NULL");
    } catch(e) { /* già presente */ }
    try {
      await c.execute("ALTER TABLE lists ADD COLUMN custom_fields_json TEXT NULL");
    } catch(e) { /* già presente */ }
    try {
      await c.execute("ALTER TABLE list_signups MODIFY COLUMN note TEXT NULL");
    } catch(e) { /* già TEXT o errore host */ }

    // Permesso accesso sezione 2 Compagnia
    try {
      await c.execute("ALTER TABLE users ADD COLUMN can_access_2compagnia TINYINT(1) NOT NULL DEFAULT 0");
    } catch(e) { /* già presente */ }

    // Identità di compagnia e corso dell'allievo sono dati del profilo,
    // distinti dai permessi di accesso. Gli account esistenti partono dalla
    // 2ª Compagnia; il campo può essere riassegnato quando si aggiungono altre.
    try {
      await c.execute('ALTER TABLE users ADD COLUMN company_id INT NOT NULL DEFAULT 2');
    } catch(e) { /* già presente */ }
    await c.execute(`
      CREATE TABLE IF NOT EXISTS shop_kaps_listings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        seller_id INT NOT NULL,
        buyer_id INT NULL,
        item_name VARCHAR(120) NOT NULL,
        category VARCHAR(30) NOT NULL DEFAULT 'altro',
        description VARCHAR(800) NOT NULL DEFAULT '',
        price_cents INT UNSIGNED NOT NULL,
        seller_phone VARCHAR(30) NOT NULL,
        status ENUM('available','purchased') NOT NULL DEFAULT 'available',
        stripe_session_id VARCHAR(191) NULL UNIQUE,
        commission_percent DECIMAL(5,2) NOT NULL DEFAULT 15.00,
        commission_cents INT UNSIGNED NOT NULL DEFAULT 0,
        seller_net_cents INT UNSIGNED NOT NULL DEFAULT 0,
        seller_paid_at TIMESTAMP NULL,
        seller_paid_by INT NULL,
        pending_buyer_id INT NULL,
        pending_session_id VARCHAR(191) NULL,
        pending_until TIMESTAMP NULL,
        pending_commission_percent DECIMAL(5,2) NULL,
        pending_commission_cents INT UNSIGNED NULL,
        pending_seller_net_cents INT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        purchased_at TIMESTAMP NULL,
        KEY idx_shop_status_created (status,created_at),
        KEY idx_shop_seller (seller_id,created_at),
        KEY idx_shop_buyer (buyer_id,purchased_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    for (const migration of [
      "ALTER TABLE shop_kaps_listings ADD COLUMN category VARCHAR(30) NOT NULL DEFAULT 'altro'",
      "ALTER TABLE shop_kaps_listings ADD COLUMN description VARCHAR(800) NOT NULL DEFAULT ''",
      'ALTER TABLE shop_kaps_listings ADD COLUMN commission_cents INT UNSIGNED NOT NULL DEFAULT 0',
      'ALTER TABLE shop_kaps_listings ADD COLUMN seller_net_cents INT UNSIGNED NOT NULL DEFAULT 0',
      'ALTER TABLE shop_kaps_listings ADD COLUMN seller_paid_at TIMESTAMP NULL',
      'ALTER TABLE shop_kaps_listings ADD COLUMN seller_paid_by INT NULL',
      'ALTER TABLE shop_kaps_listings ADD COLUMN commission_percent DECIMAL(5,2) NOT NULL DEFAULT 15.00',
      'ALTER TABLE shop_kaps_listings ADD COLUMN pending_commission_percent DECIMAL(5,2) NULL',
      'ALTER TABLE shop_kaps_listings ADD COLUMN pending_commission_cents INT UNSIGNED NULL',
      'ALTER TABLE shop_kaps_listings ADD COLUMN pending_seller_net_cents INT UNSIGNED NULL'
    ]) {
      try { await c.execute(migration); }
      catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME')
          console.error('[MIGRAZIONE SHOP]', migration, e.code || '', e.message || e);
      }
    }
    try {
      await c.execute('ALTER TABLE users ADD COLUMN course_code VARCHAR(60) NULL');
    } catch(e) { /* già presente */ }
    try {
      await c.execute('ALTER TABLE users ADD COLUMN meal_export_credits INT NOT NULL DEFAULT 0');
    } catch(e) { /* già presente */ }
    await c.execute('UPDATE users SET company_id=2 WHERE company_id IS NULL OR company_id=0');

    await c.execute(`
      CREATE TABLE IF NOT EXISTS meal_credit_payments (
        stripe_session_id VARCHAR(191) NOT NULL PRIMARY KEY,
        user_id INT NOT NULL,
        amount_cents INT NOT NULL,
        credits INT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_meal_credit_user (user_id,created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await c.execute(`
      CREATE TABLE IF NOT EXISTS meal_weekly_rules (
        company_id INT NOT NULL,
        weekday TINYINT NOT NULL,
        course_code VARCHAR(60) NOT NULL,
        meal VARCHAR(20) NOT NULL,
        meal_type VARCHAR(20) NOT NULL,
        service_time VARCHAR(5) NULL,
        note VARCHAR(255) NULL,
        PRIMARY KEY (company_id,weekday,course_code,meal),
        KEY idx_meal_rules_company_day (company_id,weekday)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await c.execute(`
      CREATE TABLE IF NOT EXISTS meal_day_entries (
        company_id INT NOT NULL,
        report_date DATE NOT NULL,
        user_id INT NOT NULL,
        meal VARCHAR(20) NOT NULL,
        default_type VARCHAR(20) NULL,
        meal_type VARCHAR(20) NULL,
        service_time VARCHAR(5) NULL,
        at_rest TINYINT(1) NOT NULL DEFAULT 0,
        note VARCHAR(255) NULL,
        updated_by INT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (company_id,report_date,user_id,meal),
        KEY idx_meal_day_date (company_id,report_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await c.execute(`
      CREATE TABLE IF NOT EXISTS meal_forecast_entries (
        company_id INT NOT NULL,
        forecast_date DATE NOT NULL,
        user_id INT NOT NULL,
        meal VARCHAR(20) NOT NULL,
        default_type VARCHAR(20) NULL,
        meal_type VARCHAR(20) NULL,
        service_time VARCHAR(5) NULL,
        at_rest TINYINT(1) NOT NULL DEFAULT 0,
        note VARCHAR(255) NULL,
        updated_by INT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (company_id,forecast_date,user_id,meal),
        KEY idx_meal_forecast_date (company_id,forecast_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Elettronica e Telecomunicazioni condividono la stessa frequenza delle
    // lezioni: elimina le vecchie righe separate e ricrea la regola comune.
    await c.execute(
      "DELETE FROM meal_weekly_rules WHERE company_id=2 AND course_code IN ('elettronica','telecomunicazioni')"
    );
    for (let i = 0; i < pasti.REGOLE_INIZIALI.length; i += 50) {
      const batch = pasti.REGOLE_INIZIALI.slice(i, i + 50);
      const placeholders = batch.map(() => '(2,?,?,?,?,?,?)').join(',');
      await c.execute(
        `INSERT INTO meal_weekly_rules
         (company_id,weekday,course_code,meal,meal_type,service_time,note)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE meal_type=VALUES(meal_type),
           service_time=VALUES(service_time),note=VALUES(note)`,
        batch.flatMap(r => [r.weekday, r.course, r.meal, r.mealType, r.serviceTime, r.note])
      );
    }

    // ── ANNO ACCADEMICO DEL REGISTRO VOTI ───────────────────────
    // I voti sono separati per anno di corso (1-5). Le righe già presenti
    // sono per definizione del 1° anno: DEFAULT 1 le preserva senza toccarle.
    try {
      await c.execute("ALTER TABLE subjects ADD COLUMN academic_year TINYINT NOT NULL DEFAULT 1");
    } catch(e) { /* già presente */ }
    try {
      await c.execute("ALTER TABLE grades ADD COLUMN academic_year TINYINT NOT NULL DEFAULT 1");
    } catch(e) { /* già presente */ }
    // Indici per il filtro per anno (ignorati se già creati)
    try {
      await c.execute("ALTER TABLE subjects ADD INDEX idx_subjects_user_anno (user_id, academic_year)");
    } catch(e) { /* già presente */ }
    try {
      await c.execute("ALTER TABLE grades ADD INDEX idx_grades_user_anno (user_id, academic_year)");
    } catch(e) { /* già presente */ }

    // Grado militare: AU come default per chi non ce l'ha
    await c.execute("UPDATE users SET military_rank = 'AU' WHERE military_rank IS NULL OR TRIM(military_rank) = ''");

    // Tabella parenti parlatorio (multi-parente per iscrizione)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS list_relatives (
        id VARCHAR(64) PRIMARY KEY,
        list_id VARCHAR(64) NOT NULL,
        user_id INT NOT NULL,
        relative_name VARCHAR(255) NOT NULL,
        relative_relation VARCHAR(100),
        relative_id_card VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── RECUPERO PASSWORD ───────────────────────────────────────
    // Del token si conserva solo l'impronta SHA-256: chi legge il database
    // non può ricostruire il link, esattamente come per le password.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS password_resets (
        token_hash CHAR(64) NOT NULL PRIMARY KEY,
        user_id    INT NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at    DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_reset_user (user_id),
        KEY idx_reset_scadenza (expires_at)
      )
    `);
    // Pulizia dei token scaduti o già usati da più di un giorno
    try {
      await c.execute(
        'DELETE FROM password_resets WHERE expires_at < NOW() - INTERVAL 1 DAY OR used_at < NOW() - INTERVAL 1 DAY');
    } catch(e) { /* tabella appena creata: niente da pulire */ }

    // Tabella calendario eventi
    await c.execute(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        event_date DATE NOT NULL,
        event_time VARCHAR(10),
        description TEXT,
        color VARCHAR(20) DEFAULT 'gold',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('   DB: tabelle inizializzate');
  } catch(e) {
    console.error('   DB init error:', e.message);
  }
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  // Solo token Bearer: nessuna autenticazione automatica da cookie, che
  // consentirebbe richieste cross-site senza consenso esplicito del browser.
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Non autenticato' });

  // Solo gli errori di firma/scadenza del JWT devono essere mostrati come
  // token non valido. Gli errori di connessione o query al DB sono errori
  // server e vanno registrati come tali.
  try {
    req.user = jwt.verify(token, CHIAVE_JWT, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }

  try {
    // I permessi nel JWT possono diventare obsoleti dopo una revoca. Ricarica
    // l'identità e i ruoli correnti dal DB a ogni richiesta autenticata:
    // account eliminati o permessi revocati hanno effetto immediato.
    const c = await db();
    const [utenti] = await c.execute(
      'SELECT id,username,full_name,military_rank,role,can_access_finance,can_access_2compagnia,is_admin,company_id,course_code FROM users WHERE id=?',
      [req.user.id]
    );
    if (!utenti.length) return res.status(401).json({ error: 'Account non più disponibile' });
    const u = utenti[0];
    Object.assign(req.user, {
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      military_rank: u.military_rank || 'AU',
      role: u.role || 'none',
      can_access_finance: !!Number(u.can_access_finance),
      can_access_2compagnia: !!Number(u.can_access_2compagnia),
      is_admin: !!Number(u.is_admin),
      company_id: Number(u.company_id || 2),
      course_code: u.course_code || ''
    });
    next();
  } catch (e) { errServer(res, e); }
}

function requireFinance(req, res, next) {
  if (req.user.is_admin || req.user.can_access_finance) return next();
  return res.status(403).json({ error: 'Strumento Gestione Finanze non sbloccato per il tuo account' });
}

// Il token dichiara i permessi ma vale 7 giorni: un admin revocato resterebbe
// admin fino alla scadenza. Per le operazioni amministrative (le più
// delicate: utenti, permessi, cancellazioni) il flag si riverifica sul
// database a ogni richiesta — una query su chiave primaria, costo irrisorio.
async function requireAdmin(req, res, next) {
  if (!req.user.is_admin)
    return res.status(403).json({ error: 'Solo gli amministratori possono eseguire questa operazione' });
  try {
    const c = await db();
    const [righe] = await c.execute('SELECT is_admin FROM users WHERE id=?', [req.user.id]);
    if (!righe.length || !Number(righe[0].is_admin))
      return res.status(403).json({ error: 'Permessi amministratore revocati. Esci e accedi di nuovo.' });
    next();
  } catch (e) { errServer(res, e); }
}

function requireCompagnia(req, res, next) {
  if (req.user.is_admin || req.user.can_access_2compagnia) return next();
  return res.status(403).json({ error: 'Accesso alla sezione 7 Compagnia non autorizzato' });
}

function labelCorsoPasti(corso) {
  const c = pasti.corsoNormalizzato(corso);
  if (c === pasti.CORSI.MECCANICA_TRAMAT) return 'Meccanica / TRAMAT';
  if (c === pasti.CORSI.INFORMATICA) return 'Informatica';
  if (c === pasti.CORSI.ELETTRONICA_TELECOMUNICAZIONI) return 'Elettronica / Telecomunicazioni';
  if (c === pasti.CORSI.CIVILE) return 'Civile';
  const altriCorsi = { SCIENZE_STRATEGICHE: 'Scienze strategiche', GIURISPRUDENZA: 'Giurisprudenza', MEDICINA: 'Medicina' };
  const scelto = altriCorsi[String(corso || '').trim().toUpperCase()];
  if (scelto) return scelto;
  return 'Corso da assegnare';
}

async function resetEccezioniPastoAllaRiapertura(c, companyId, data, forecast = false) {
  const table = forecast ? 'meal_forecast_entries' : 'meal_day_entries';
  const dateColumn = forecast ? 'forecast_date' : 'report_date';
  await c.execute(
    `UPDATE ${table}
     SET meal_type=default_type,at_rest=0,updated_by=NULL
     WHERE company_id=? AND ${dateColumn}=? AND updated_by IS NOT NULL`,
    [companyId, data]
  );
}

async function preparaVociPasto(c, companyId, data, forecast = false) {
  const weekday = pasti.giornoSettimana(data);
  const nomeTabella = forecast ? 'meal_forecast_entries' : 'meal_day_entries';
  const colonnaData = forecast ? 'forecast_date' : 'report_date';
  const [users] = await c.execute(
    `SELECT id,username,full_name,nome,cognome,military_rank,course_code
     FROM users WHERE company_id=? AND can_access_2compagnia=1
       AND UPPER(TRIM(COALESCE(military_rank,'AU'))) IN ('AU','A.U.')
     ORDER BY cognome,nome,full_name,course_code`,
    [companyId]
  );
  const [rules] = await c.execute(
    'SELECT course_code,meal,meal_type,service_time,note FROM meal_weekly_rules WHERE company_id=? AND weekday=?',
    [companyId, weekday]
  );
  const [plannedRows] = forecast ? [[]] : await c.execute(
    `SELECT user_id,meal,meal_type,at_rest FROM meal_forecast_entries
     WHERE company_id=? AND forecast_date=?`, [companyId, data]
  );
  const ruleMap = new Map(rules.map(r => [`${r.course_code}|${r.meal}`, r]));
  const plannedMap = new Map(plannedRows.map(r => [`${r.user_id}|${r.meal}`, r]));
  const insertRows = [];
  for (const u of users) {
    const course = pasti.corsoNormalizzato(u.course_code);
    for (const meal of pasti.PASTI) {
      const rule = course ? ruleMap.get(`${course}|${meal}`) : null;
      const planned = plannedMap.get(`${u.id}|${meal}`);
      insertRows.push([companyId, data, u.id, meal, rule?.meal_type || null,
        planned?.meal_type ?? rule?.meal_type ?? null, rule?.service_time || null,
        planned?.at_rest ? 1 : 0, rule?.note || null]);
    }
  }
  // Batch piccoli evitano una richiesta SQL per ogni allievo e restano sotto
  // il limite dei parametri anche quando la compagnia cresce.
  for (let i = 0; i < insertRows.length; i += 50) {
    const batch = insertRows.slice(i, i + 50);
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
    await c.execute(
      `INSERT INTO ${nomeTabella}
        (company_id,${colonnaData},user_id,meal,default_type,meal_type,service_time,at_rest,note)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
         default_type=VALUES(default_type),
         meal_type=IF(at_rest=1,'sacchetto',IF(updated_by IS NULL,VALUES(meal_type),meal_type)),
         service_time=IF(updated_by IS NULL,VALUES(service_time),service_time),
         note=IF(updated_by IS NULL,VALUES(note),note)`,
      batch.flat()
    );
  }
  const [entries] = await c.execute(
    `SELECT user_id,meal,default_type,meal_type,service_time,at_rest,note
     FROM ${nomeTabella} WHERE company_id=? AND ${colonnaData}=?`,
    [companyId, data]
  );
  const byKey = new Map(entries.map(e => [`${e.user_id}|${e.meal}`, e]));
  return {
    date: data,
    weekday,
    forecast,
    students: users.map(u => ({
      id: u.id,
      name: (u.full_name || [u.nome, u.cognome].filter(Boolean).join(' ') || u.username || '').trim(),
      firstName: u.nome || '',
      lastName: u.cognome || '',
      rank: u.military_rank || 'AU',
      course: labelCorsoPasti(u.course_code),
      courseCode: u.course_code || '',
      meals: Object.fromEntries(pasti.PASTI.map(meal => {
        const v = byKey.get(`${u.id}|${meal}`) || {};
        return [meal, {
          defaultType: v.default_type || null,
          type: v.meal_type || null,
          serviceTime: v.service_time || null,
          atRest: !!Number(v.at_rest),
          note: v.note || null
        }];
      }))
    }))
  };
}

async function salvaVociPasto(c, req, data, entries, forecast = false) {
  if (!Array.isArray(entries) || entries.length > 1000)
    throw Object.assign(new Error('Elenco pasti non valido'), { status: 400 });
  const companyId = 2; // I rapportini appartengono alla 7ª Compagnia, ID storico
  const allowed = new Set(pasti.PASTI);
  const typeAllowed = new Set(pasti.TIPI_PASTO);
  const table = forecast ? 'meal_forecast_entries' : 'meal_day_entries';
  const dateColumn = forecast ? 'forecast_date' : 'report_date';
  for (const e of entries) {
    const userId = Number(e.userId);
    const meal = String(e.meal || '');
    const requestedType = e.type == null || e.type === '' ? null : String(e.type);
    if (!Number.isInteger(userId) || userId <= 0 || !allowed.has(meal)
        || (requestedType && !typeAllowed.has(requestedType)))
      throw Object.assign(new Error('Una delle modifiche non è valida'), { status: 400 });
    const atRest = !!e.atRest;
    const finalType = atRest ? 'sacchetto' : requestedType;
    const [baseline] = await c.execute(
      `SELECT e.default_type FROM ${table} e
       JOIN users u ON u.id=e.user_id AND u.company_id=e.company_id
       WHERE e.company_id=? AND e.${dateColumn}=? AND e.user_id=? AND e.meal=?
         AND UPPER(TRIM(COALESCE(u.military_rank,'AU'))) IN ('AU','A.U.')`,
      [companyId, data, userId, meal]
    );
    if (!baseline.length)
      throw Object.assign(new Error('Allievo o pasto non appartenente alla compagnia'), { status: 403 });
    await c.execute(
      `UPDATE ${table}
       SET meal_type=?,at_rest=?,updated_by=?,note=COALESCE(?,note)
       WHERE company_id=? AND ${dateColumn}=? AND user_id=? AND meal=?`,
      [finalType, atRest ? 1 : 0, req.user.id, e.note ? String(e.note).slice(0, 255) : null,
        companyId, data, userId, meal]
    );
  }
  return preparaVociPasto(c, companyId, data, forecast);
}

async function impostaServitoPerTutti(c, req, data, forecast = false) {
  const table = forecast ? 'meal_forecast_entries' : 'meal_day_entries';
  const dateColumn = forecast ? 'forecast_date' : 'report_date';
  const companyId = 2; // 7ª Compagnia, ID storico
  await c.execute(
    `UPDATE ${table} e
     JOIN users u ON u.id=e.user_id AND u.company_id=e.company_id
     SET e.meal_type='servito',e.at_rest=0,e.updated_by=?,e.service_time=NULL,e.note=NULL
     WHERE e.company_id=? AND e.${dateColumn}=? AND u.can_access_2compagnia=1
       AND UPPER(TRIM(COALESCE(u.military_rank,'AU'))) IN ('AU','A.U.')`,
    [req.user.id, companyId, data]
  );
  return preparaVociPasto(c, companyId, data, forecast);
}

// Capitano e Tenente condividono lo stesso livello di autorizzazione:
// un'unica lista, nessuna logica duplicata.
// Anni di corso gestiti dal Registro Voti. Per aggiungerne altri in futuro
// basta estendere questo intervallo (e l'elenco corrispondente nel frontend).
const ANNO_MIN = 1, ANNO_MAX = 5;
function annoValido(v) {
  const n = parseInt(v, 10);
  if (isNaN(n) || n < ANNO_MIN || n > ANNO_MAX) return ANNO_MIN;
  return n;
}

const ROLES_WITH_COM_WRITE = ['allievo_servizio', 'capo_compagnia', 'vice_capo_compagnia', 'tenente', 'capitano'];

function canWriteComunicazioni(user) {
  return user.is_admin || ROLES_WITH_COM_WRITE.includes(user.role);
}

// ── SETUP ─────────────────────────────────────────────────────
// Il setup crea il primo amministratore e funziona una volta sola: resta stretto.
app.post('/api/setup', limitaTentativi('setup', 5, QUARTO_DORA), async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute('SELECT COUNT(*) AS n FROM users');
    if (rows[0].n > 0) return res.status(400).json({ error: 'Setup già completato. Usa il login.' });
    const { username, email, password, full_name } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
    if (String(password).length < 12 || Buffer.byteLength(String(password), 'utf8') > 72)
      return res.status(400).json({ error: 'La password deve avere almeno 12 caratteri e non superare 72 byte' });
    const hash = await bcrypt.hash(password, 12);
    await c.execute(
      "INSERT INTO users (username,email,password_hash,full_name,is_admin,can_access_finance,can_access_2compagnia,role) VALUES (?,?,?,?,1,1,1,'none')",
      [username, email, hash, full_name || username]
    );
    res.json({ ok: true, message: 'Amministratore creato con successo' });
  } catch (e) { errServer(res, e); }
});

// ── AUTH ──────────────────────────────────────────────────────
// Registrazione: qui non c'è un'identità da proteggere, l'unico asse è l'IP.
// Il tetto è però largo, perché un intero corso può iscriversi in un pomeriggio
// dalla stessa rete. Gli account nascono senza alcun permesso e l'admin può
// cancellarli, quindi qualche iscrizione di troppo non fa danno.
app.post('/api/auth/register', limitaTentativi('registrazione-ip', 40, QUARTO_DORA), async (req, res) => {
  const { username, email, password, nome, cognome } = req.body;
  const companyId = 2; // identificativo storico della 7ª Compagnia
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Username, email e password sono obbligatori' });
  if (!nome?.trim() || !cognome?.trim())
    return res.status(400).json({ error: 'Nome e cognome sono obbligatori' });
  if (password.length < 12)
    return res.status(400).json({ error: 'La password deve avere almeno 12 caratteri' });
  // bcrypt considera solo i primi 72 byte: oltre, la parte in più non conta
  // e l'utente crederebbe di avere una password più lunga di quella reale
  if (Buffer.byteLength(password, 'utf8') > 72)
    return res.status(400).json({ error: 'Password troppo lunga (massimo 72 caratteri)' });
  if (String(username).trim().length > 50 || String(email).trim().length > 100
      || String(nome).trim().length > 100 || String(cognome).trim().length > 100)
    return res.status(400).json({ error: 'Uno dei campi supera la lunghezza massima' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim()))
    return res.status(400).json({ error: 'Indirizzo email non valido' });
  try {
    const c    = await db();
    const hash = await bcrypt.hash(password, 12);
    const full_name = `${nome.trim()} ${cognome.trim()}`;
    const [result] = await c.execute(
      "INSERT INTO users (username,email,password_hash,full_name,nome,cognome,company_id,role) VALUES (?,?,?,?,?,?,?,'none')",
      [username.trim(), email.trim().toLowerCase(), hash, full_name, nome.trim(), cognome.trim(), companyId]
    );
    // Iscrizione riuscita: non deve consumare il budget della rete condivisa
    scalaTentativo('registrazione-ip', req.ip);
    res.json({ ok: true, id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY')
      return res.status(400).json({ error: 'Username o email già registrati' });
    errServer(res, e);
  }
});

// Login: il limite stretto è sull'account preso di mira (10 tentativi falliti
// di fila), quello per IP è largo e serve solo a fermare chi prova a raffica
// account diversi. Un accesso riuscito azzera il conto dell'account.
// L'ordine conta: prima il controllo sull'account, poi quello sulla rete. Chi
// insiste su un account già bloccato viene fermato subito e non intacca il
// budget dell'IP, che è condiviso con tutti gli altri allievi.
app.post('/api/auth/login',
  limitaTentativi('login-utente', 10, QUARTO_DORA, chiaveUtente),
  limitaTentativi('login-ip', 120, QUARTO_DORA),
  async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Credenziali mancanti' });
  try {
    const c = await db();
    const [rows] = await c.execute(
      'SELECT * FROM users WHERE username=? OR email=?',
      [username.trim(), username.trim().toLowerCase()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Credenziali non valide' });
    const user = rows[0];
    const ok   = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });

    const payload = {
      id: user.id, username: user.username, full_name: user.full_name,
      military_rank: user.military_rank || 'AU',
      role: user.role || 'none',
      can_access_finance:     !!Number(user.can_access_finance),
      can_access_2compagnia:  !!Number(user.can_access_2compagnia),
      is_admin: !!Number(user.is_admin),
      company_id: Number(user.company_id || 2),
      course_code: user.course_code || ''
    };
    const token = jwt.sign(payload, CHIAVE_JWT, { expiresIn: '7d', algorithm: 'HS256' });
    // Accesso riuscito: il conto di questo account riparte da zero e il
    // gettone consumato sul tetto per IP viene restituito. Così a pesare sono
    // solo i fallimenti, e una rete condivisa non si esaurisce da sola.
    azzeraTentativi('login-utente', chiaveUtente(req));
    scalaTentativo('login-ip', req.ip);
    res.json({ token, user: payload });
  } catch (e) { errServer(res, e); }
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true });
});

// ── RECUPERO PASSWORD ─────────────────────────────────────────
// Il token viaggia solo nel link inviato per email e vive in chiaro solo lì:
// nel database ne resta l'impronta SHA-256, come per le password. Il link usa
// il frammento (#reset=…) invece della query string, così il token non finisce
// nei log del server né nell'intestazione Referer verso terzi.
const RESET_VALIDITA_MINUTI = 60;

// Nei log un indirizzo email va mascherato: "mario.rossi@mail.it" → "ma***@mail.it"
function mascheraEmail(email) {
  const [locale, dominio] = String(email).split('@');
  if (!dominio) return '***';
  return locale.slice(0, 2) + '***@' + dominio;
}

function impronta(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Base pubblica del sito: su Render la variabile non è automatica, quindi si
// ripiega sull'host della richiesta, che per il portale è già quello giusto.
function baseSito(req) {
  const configurata = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configurata) return configurata;
  const proto = req.secure ? 'https' : (req.headers['x-forwarded-proto'] || req.protocol);
  return `${proto}://${req.get('host')}`;
}

// Crea un token nuovo e invalida quelli ancora aperti dello stesso utente:
// vale sempre e solo l'ultimo link richiesto.
async function creaTokenReset(c, userId) {
  const token = crypto.randomBytes(32).toString('base64url'); // 256 bit
  await c.execute(
    'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
    [userId]
  );
  // La scadenza la calcola il database, non Node: così il confronto con NOW()
  // usa sempre lo stesso orologio e non può sfasarsi per differenze di fuso
  // fra l'hosting e il server MySQL. I minuti sono una costante del codice,
  // scritta nella query come per i LIMIT: nessun input utente qui dentro.
  await c.execute(
    `INSERT INTO password_resets (token_hash,user_id,expires_at)
     VALUES (?,?,NOW() + INTERVAL ${RESET_VALIDITA_MINUTI} MINUTE)`,
    [impronta(token), userId]
  );
  return token;
}

function linkReset(req, token) {
  return `${baseSito(req)}/#reset=${token}`;
}

// Passo 1 — l'utente chiede il link.
// La risposta è sempre la stessa, esista o no l'indirizzo: altrimenti questa
// rotta diventerebbe uno strumento per scoprire chi è registrato.
// Recupero password: da difendere è la casella di posta di chi riceve, non la
// rete da cui parte la richiesta. Tre link ogni quarto d'ora per indirizzo
// sono abbondanti, visto che ognuno vale un'ora.
app.post('/api/auth/password/forgot',
  limitaTentativi('reset-email', 3, QUARTO_DORA, chiaveEmail),
  limitaTentativi('reset-ip', 60, QUARTO_DORA),
  async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const rispostaGenerica = {
    ok: true,
    message: 'Se l\'indirizzo è registrato riceverai a breve un\'email con il link per reimpostare la password.'
  };
  if (!email) return res.status(400).json({ error: 'Inserisci il tuo indirizzo email' });
  try {
    const c = await db();
    const [righe] = await c.execute('SELECT id,nome,full_name,email FROM users WHERE email=?', [email]);
    if (!righe.length) return res.json(rispostaGenerica);
    const utente = righe[0];

    if (!mailer.emailConfigurata()) {
      // Nessuna credenziale SMTP: si dice all'utente la stessa frase, ma nei
      // log resta scritto perché non è partito niente.
      console.warn('   reset password: servizio email non configurato, invio saltato per', mascheraEmail(email));
      return res.json(rispostaGenerica);
    }

    const token = await creaTokenReset(c, utente.id);
    const { oggetto, testo, html } = mailer.emailReimpostaPassword({
      nome: (utente.nome || utente.full_name || '').trim().split(/\s+/)[0] || '',
      link: linkReset(req, token),
      minutiValidita: RESET_VALIDITA_MINUTI
    });
    // La risposta non aspetta la consegna: è generica in ogni caso, e tenere
    // l'utente fermo davanti a una schermata bloccata per tutto il dialogo con
    // il server di posta non serve a niente. L'invio prosegue per conto suo e
    // un eventuale fallimento finisce nei log (e si diagnostica per intero da
    // POST /api/admin/email-test).
    mailer.inviaEmail({ a: utente.email, oggetto, testo, html })
      .catch(e => console.error('   reset password: invio email fallito —', e.message));
    res.json(rispostaGenerica);
  } catch (e) { errServer(res, e); }
});

// Passo 2 — il frontend controlla se il link è ancora buono prima di mostrare
// il modulo, così l'utente non digita una password per niente.
// Verifica e conferma del link: il token è da 256 bit, indovinarlo non è una
// minaccia concreta. Il tetto per IP resta solo per non far girare a vuoto il
// database, ed è largo perché la pagina si apre da rete condivisa.
app.get('/api/auth/password/reset/:token', limitaTentativi('reset-verifica-ip', 100, QUARTO_DORA), async (req, res) => {
  try {
    const c = await db();
    const [righe] = await c.execute(
      `SELECT r.user_id, u.username FROM password_resets r JOIN users u ON u.id = r.user_id
       WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > NOW()`,
      [impronta(String(req.params.token || ''))]
    );
    if (!righe.length)
      return res.status(400).json({ error: 'Link non valido o scaduto. Richiedine uno nuovo.' });
    res.json({ ok: true, username: righe[0].username });
  } catch (e) { errServer(res, e); }
});

// Passo 3 — la nuova password. Il token viene consumato nello stesso UPDATE
// che lo verifica: due richieste in parallelo non possono usarlo due volte.
app.post('/api/auth/password/reset', limitaTentativi('reset-conferma-ip', 60, QUARTO_DORA), async (req, res) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (!token) return res.status(400).json({ error: 'Link di reimpostazione mancante' });
  if (password.length < 12)
    return res.status(400).json({ error: 'La password deve avere almeno 12 caratteri' });
  if (Buffer.byteLength(password, 'utf8') > 72)
    return res.status(400).json({ error: 'Password troppo lunga (massimo 72 byte)' });
  try {
    const c = await db();
    const hashToken = impronta(token);
    const [consumato] = await c.execute(
      `UPDATE password_resets SET used_at = NOW()
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()`,
      [hashToken]
    );
    if (!consumato.affectedRows)
      return res.status(400).json({ error: 'Link non valido, già usato o scaduto. Richiedine uno nuovo.' });

    const [righe] = await c.execute('SELECT user_id FROM password_resets WHERE token_hash=?', [hashToken]);
    if (!righe.length) return res.status(400).json({ error: 'Link non valido' });

    // Stesso costo bcrypt della registrazione: nessun percorso meno sicuro.
    const hash = await bcrypt.hash(password, 12);
    await c.execute('UPDATE users SET password_hash=? WHERE id=?', [hash, righe[0].user_id]);
    // Eventuali altri link aperti per lo stesso utente decadono subito.
    await c.execute(
      'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
      [righe[0].user_id]
    );
    res.json({ ok: true, message: 'Password aggiornata. Ora puoi accedere.' });
  } catch (e) { errServer(res, e); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(
      'SELECT id,username,email,full_name,nome,cognome,military_rank,platoon,academic_year,role,can_access_finance,can_access_2compagnia,is_admin,company_id,course_code FROM users WHERE id=?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utente non trovato' });
    const u = rows[0];
    u.can_access_finance    = !!Number(u.can_access_finance);
    u.can_access_2compagnia = !!Number(u.can_access_2compagnia);
    u.is_admin              = !!Number(u.is_admin);
    u.role                  = u.role || 'none';
    u.military_rank         = u.military_rank || 'AU';
    const payload = {
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      military_rank: u.military_rank,
      role: u.role,
      can_access_finance:    u.can_access_finance,
      can_access_2compagnia: u.can_access_2compagnia,
      is_admin: u.is_admin,
      company_id: Number(u.company_id || 2),
      course_code: u.course_code || ''
    };
    const newToken = jwt.sign(payload, CHIAVE_JWT, { expiresIn: '7d', algorithm: 'HS256' });
    res.json({ ...u, token: newToken });
  } catch (e) { errServer(res, e); }
});

// ── PROFILO ───────────────────────────────────────────────────
app.put('/api/profile', auth, async (req, res) => {
  const { nome, cognome, platoon, academic_year, course_code } = req.body;
  const corsiValidi = new Set(['TRAMAT','MECCANICA','INFORMATICA','TCL.','TELECOMUNICAZIONI','ELETTRONICA','CIVILE','SCIENZE_STRATEGICHE','GIURISPRUDENZA','MEDICINA']);
  if (course_code && !corsiValidi.has(String(course_code).trim().toUpperCase()))
    return res.status(400).json({ error: 'Corso di laurea non valido' });
  if (platoon && !['1','2'].includes(String(platoon).trim()))
    return res.status(400).json({ error: 'Il plotone può essere 1, 2 oppure non indicato' });
  if (!nome?.trim() || !cognome?.trim())
    return res.status(400).json({ error: 'Nome e cognome obbligatori' });
  const full_name = `${nome.trim()} ${cognome.trim()}`;
  try {
    const c = await db();
    // military_rank non è modificabile dall'utente — rimane quello assegnato
    await c.execute(
      'UPDATE users SET nome=?, cognome=?, full_name=?, platoon=?, academic_year=?, course_code=? WHERE id=?',
      [nome.trim(), cognome.trim(), full_name, platoon ? String(platoon).trim() : '', academic_year||'1° Anno', course_code ? String(course_code).trim().toUpperCase() : null, req.user.id]
    );
    res.json({ ok: true });
  } catch(e) { errServer(res, e); }
});

// ── TETTO MESSAGGI (chat e bacheca annunci) ───────────────────
// Chat e bacheca conservano solo gli ultimi 50 messaggi: senza un tetto le
// tabelle crescono indefinitamente. Il limite è applicato sul database, non
// nascondendo righe nel frontend.
//
// Il limite è netto: appena entra il 51° messaggio esce il più vecchio, così
// in tabella restano sempre e solo i 50 più recenti. La potatura tocca una
// tabella che per costruzione non supera le ~51 righe, quindi resta
// trascurabile anche con molti utenti insieme; due inserimenti concorrenti
// possono potare nello stesso momento senza danno, perché l'operazione è
// idempotente (al massimo il secondo non trova più nulla da eliminare) e
// perché il criterio è sempre "tieni i 50 più recenti", mai "cancella N righe".
const MAX_MESSAGGI = 50;

// Le tabelle potabili sono elencate qui: il nome non arriva mai dall'esterno.
const TABELLE_CON_TETTO = new Set(['comunicazioni_chat', 'announcements']);

async function potaMessaggi(c, tabella) {
  if (!TABELLE_CON_TETTO.has(tabella)) throw new Error('Tabella non potabile: ' + tabella);
  const [[{ n }]] = await c.execute(`SELECT COUNT(*) AS n FROM \`${tabella}\``);
  if (n <= MAX_MESSAGGI) return 0;
  // Il numero nella LIMIT è una costante del codice, mai input utente.
  // La derivata `recenti` serve perché MySQL non accetta una sottoquery
  // sulla stessa tabella che sta cancellando.
  const [r] = await c.execute(`
    DELETE FROM \`${tabella}\`
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id FROM \`${tabella}\`
        ORDER BY created_at DESC, id DESC
        LIMIT ${MAX_MESSAGGI}
      ) AS recenti
    )
  `);
  return r.affectedRows;
}

// Il tetto non deve mai far fallire l'invio: se la potatura va storta si
// logga e il messaggio resta comunque salvato.
async function potaturaSicura(c, tabella) {
  try {
    await potaMessaggi(c, tabella);
  } catch (e) {
    console.warn(`   ${tabella}: potatura non riuscita:`, e.message);
  }
}

// ── ANNUNCI ───────────────────────────────────────────────────
app.get('/api/announcements', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(`
      SELECT a.id, a.content, a.created_at,
             u.id AS author_id, u.username, u.full_name, u.military_rank, u.role, u.is_admin
      FROM announcements a
      JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at DESC, a.id DESC LIMIT ${MAX_MESSAGGI}
    `);
    res.json(rows);
  } catch (e) { errServer(res, e); }
});

const MAX_LUNGHEZZA_MESSAGGIO = 4000;   // caratteri: oltre non è un messaggio, è un documento

app.post('/api/announcements', auth, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Il messaggio non può essere vuoto' });
  if (content.length > MAX_LUNGHEZZA_MESSAGGIO)
    return res.status(400).json({ error: `Messaggio troppo lungo (massimo ${MAX_LUNGHEZZA_MESSAGGIO} caratteri)` });
  try {
    const c = await db();
    const [result] = await c.execute(
      'INSERT INTO announcements (user_id,content) VALUES (?,?)',
      [req.user.id, content.trim()]
    );
    await potaturaSicura(c, 'announcements');
    res.json({ ok: true, id: result.insertId });
  } catch (e) { errServer(res, e); }
});

app.delete('/api/announcements/:id', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute('SELECT user_id FROM announcements WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Annuncio non trovato' });
    if (rows[0].user_id !== req.user.id && !req.user.is_admin)
      return res.status(403).json({ error: 'Non puoi eliminare questo annuncio' });
    await c.execute('DELETE FROM announcements WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

// ── COMUNICAZIONI: CHAT ───────────────────────────────────────
app.get('/api/comunicazioni/chat', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(`
      SELECT * FROM (
        SELECT m.id, m.content, m.created_at,
               u.id AS author_id, u.username, u.full_name, u.military_rank, u.role, u.is_admin
        FROM comunicazioni_chat m
        JOIN users u ON m.user_id = u.id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${MAX_MESSAGGI}
      ) AS ultimi
      ORDER BY ultimi.created_at ASC, ultimi.id ASC
    `);
    res.json(rows);
  } catch(e) { errServer(res, e); }
});

app.post('/api/comunicazioni/chat', auth, requireCompagnia, async (req, res) => {
  if (!canWriteComunicazioni(req.user))
    return res.status(403).json({ error: 'Non hai i permessi per scrivere in Comunicazioni' });
  const { id, content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Messaggio vuoto' });
  if (content.length > MAX_LUNGHEZZA_MESSAGGIO)
    return res.status(400).json({ error: `Messaggio troppo lungo (massimo ${MAX_LUNGHEZZA_MESSAGGIO} caratteri)` });
  try {
    const c = await db();
    await c.execute('INSERT INTO comunicazioni_chat (id,user_id,content) VALUES (?,?,?)',
      [id, req.user.id, content.trim()]);
    await potaturaSicura(c, 'comunicazioni_chat');
    res.json({ ok: true });
  } catch(e) { errServer(res, e); }
});

app.delete('/api/comunicazioni/chat/:id', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute('SELECT user_id FROM comunicazioni_chat WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Messaggio non trovato' });
    if (rows[0].user_id !== req.user.id && !req.user.is_admin)
      return res.status(403).json({ error: 'Non puoi eliminare questo messaggio' });
    await c.execute('DELETE FROM comunicazioni_chat WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { errServer(res, e); }
});

// ── COMUNICAZIONI: COMUNICATI UFFICIALI ───────────────────────
app.get('/api/comunicazioni/posts', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(`
      SELECT p.id, p.title, p.content, p.file_name, p.file_type, p.created_at,
             u.id AS author_id, u.username, u.full_name, u.military_rank, u.role, u.is_admin
      FROM comunicazioni_posts p
      JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC LIMIT 50
    `);
    res.json(rows);
  } catch(e) { errServer(res, e); }
});

app.get('/api/comunicazioni/posts/:id/file', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(
      'SELECT file_name,file_data,file_type FROM comunicazioni_posts WHERE id=?',
      [req.params.id]
    );
    if (!rows.length || !rows[0].file_data)
      return res.status(404).json({ error: 'File non trovato' });
    res.json({ file_name: rows[0].file_name, file_data: rows[0].file_data, file_type: rows[0].file_type });
  } catch(e) { errServer(res, e); }
});

app.post('/api/comunicazioni/posts', auth, requireCompagnia, async (req, res) => {
  if (!canWriteComunicazioni(req.user))
    return res.status(403).json({ error: 'Non hai i permessi per pubblicare comunicati' });
  const { id, title, content, file_name, file_data, file_type } = req.body;
  if (!title?.trim() && !content?.trim())
    return res.status(400).json({ error: 'Inserisci almeno un titolo o un contenuto' });
  if (String(title || '').length > 200 || String(content || '').length > 20000)
    return res.status(400).json({ error: 'Titolo o contenuto troppo lungo' });
  if (file_data != null) {
    const tipiAmmessi = new Set([
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain', 'image/png', 'image/jpeg'
    ]);
    const nome = String(file_name || '');
    const dati = String(file_data);
    const bytes = Buffer.from(dati, 'base64');
    if (!tipiAmmessi.has(file_type) || nome.length > 255 || /[\\/\r\n\0]/.test(nome)
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(dati) || dati.length % 4 !== 0
        || bytes.length > 5 * 1024 * 1024 || bytes.toString('base64') !== dati)
      return res.status(400).json({ error: 'Allegato non valido o non supportato (massimo 5 MB)' });
  }
  try {
    const c = await db();
    await c.execute(
      'INSERT INTO comunicazioni_posts (id,user_id,title,content,file_name,file_data,file_type) VALUES (?,?,?,?,?,?,?)',
      [id, req.user.id, title || '', content || '', file_name || null, file_data || null, file_type || null]
    );
    res.json({ ok: true });
  } catch(e) { errServer(res, e); }
});

app.delete('/api/comunicazioni/posts/:id', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute('SELECT user_id FROM comunicazioni_posts WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Comunicato non trovato' });
    if (rows[0].user_id !== req.user.id && !req.user.is_admin)
      return res.status(403).json({ error: 'Non puoi eliminare questo comunicato' });
    await c.execute('DELETE FROM comunicazioni_posts WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { errServer(res, e); }
});

// ── STRUMENTI › GESTIONE FINANZE ──────────────────────────────
// Lo strumento vive nella sezione "Strumenti", indipendente da "2 Compagnia":
// serve solo il permesso individuale can_access_finance (o essere admin).
app.get('/api/finance', auth, requireFinance, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(
      'SELECT id,type,description AS `desc`,amount,date,category AS cat,note FROM finance_transactions WHERE user_id=? ORDER BY date DESC',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { errServer(res, e); }
});

app.post('/api/finance', auth, requireFinance, async (req, res) => {
  const { id, type, desc, amount, date, cat, note } = req.body;
  if (!id || !type || !desc || !amount || !date)
    return res.status(400).json({ error: 'Dati transazione incompleti' });
  try {
    const c = await db();
    await c.execute(
      'INSERT INTO finance_transactions (id,user_id,type,description,amount,date,category,note) VALUES (?,?,?,?,?,?,?,?)',
      [id, req.user.id, type, desc, amount, date, cat || '', note || '']
    );
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.put('/api/finance/:id', auth, requireFinance, async (req, res) => {
  const { type, desc, amount, date, cat, note } = req.body;
  try {
    const c = await db();
    await c.execute(
      'UPDATE finance_transactions SET type=?,description=?,amount=?,date=?,category=?,note=? WHERE id=? AND user_id=?',
      [type, desc, amount, date, cat || '', note || '', req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.delete('/api/finance/:id', auth, requireFinance, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM finance_transactions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

// ── VOTI ──────────────────────────────────────────────────────
app.get('/api/grades/all', auth, requireCompagnia, async (req, res) => {
  try {
    const c  = await db();
    const id = req.user.id;
    const [[cadetRow]]   = await c.execute('SELECT full_name,military_rank AS `rank`,platoon,academic_year AS `year` FROM users WHERE id=?', [id]);
    const anno = annoValido(req.query.anno);
    const [subjects]     = await c.execute('SELECT * FROM subjects WHERE user_id=? AND academic_year=? ORDER BY sort_order,name', [id, anno]);
    const [gradesRaw]    = await c.execute('SELECT * FROM grades WHERE user_id=? AND academic_year=? ORDER BY date DESC', [id, anno]);
    const [penalties]    = await c.execute('SELECT * FROM penalties WHERE user_id=? ORDER BY date DESC', [id]);
    const [schedule]     = await c.execute('SELECT * FROM schedule_entries WHERE user_id=?', [id]);
    const [notes]        = await c.execute('SELECT * FROM notes WHERE user_id=? ORDER BY pinned DESC, created_at DESC', [id]);
    const [settingsRows] = await c.execute('SELECT * FROM grade_settings WHERE user_id=?', [id]);
    const settings = settingsRows[0] || { weight_uni:50, weight_acad:50, weight_gym:25, weight_mil:25, pen_consegna_rate:0.5 };

    const subjectsWithGrades = subjects.map(s => ({
      ...s, credits: parseFloat(s.credits),
      grades: gradesRaw.filter(g => g.subject_id === s.id).map(g => ({
        ...g, value: parseFloat(g.value), weight: parseFloat(g.weight)
      }))
    }));

    const schedMap = {};
    schedule.forEach(e => { schedMap[`${e.day_index}-${e.hour}`] = e; });

    res.json({
      anno,
      cadet: cadetRow || {},
      subjects: {
        university: subjectsWithGrades.filter(s => s.type === 'university'),
        gym:        subjectsWithGrades.filter(s => s.type === 'gym'),
        military:   subjectsWithGrades.filter(s => s.type === 'military')
      },
      penalties: {
        consegna: penalties.filter(p => p.type === 'consegna'),
        rigore:   penalties.filter(p => p.type === 'rigore')
      },
      schedule: schedMap, notes,
      settings: { ...settings, pen_consegna_rate: parseFloat(settings.pen_consegna_rate) }
    });
  } catch (e) { errServer(res, e); }
});

app.post('/api/grades/subjects', auth, requireCompagnia, async (req, res) => {
  const { id, type, name, credits, anno } = req.body;
  try {
    const c = await db();
    await c.execute('INSERT INTO subjects (id,user_id,type,name,credits,academic_year) VALUES (?,?,?,?,?,?)',
      [id, req.user.id, type, name, credits || 1, annoValido(anno)]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.put('/api/grades/subjects/:id', auth, requireCompagnia, async (req, res) => {
  const { name, credits } = req.body;
  try {
    const c = await db();
    await c.execute('UPDATE subjects SET name=?,credits=? WHERE id=? AND user_id=?',
      [name, credits, req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.delete('/api/grades/subjects/:id', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM grades   WHERE subject_id=? AND user_id=?', [req.params.id, req.user.id]);
    await c.execute('DELETE FROM subjects WHERE id=?         AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.post('/api/grades/grades', auth, requireCompagnia, async (req, res) => {
  const { id, subject_id, grade_type, value, weight, date, description, anno } = req.body;
  try {
    const c = await db();
    // L'anno del voto segue sempre quello della materia a cui appartiene
    const [[mat]] = await c.execute('SELECT academic_year FROM subjects WHERE id=? AND user_id=?', [subject_id, req.user.id]);
    const annoVoto = mat ? annoValido(mat.academic_year) : annoValido(anno);
    await c.execute(
      'INSERT INTO grades (id,subject_id,user_id,grade_type,value,weight,date,description,academic_year) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, subject_id, req.user.id, grade_type || 'exam', value, weight || 1, date || null, description || '', annoVoto]
    );
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.delete('/api/grades/grades/:id', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM grades WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.post('/api/grades/penalties', auth, requireCompagnia, async (req, res) => {
  const { id, type, days, date, reason } = req.body;
  try {
    const c = await db();
    await c.execute('INSERT INTO penalties (id,user_id,type,days,date,reason) VALUES (?,?,?,?,?,?)',
      [id, req.user.id, type, days, date || null, reason || '']);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.delete('/api/grades/penalties/:id', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM penalties WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.post('/api/grades/schedule/upsert', auth, requireCompagnia, async (req, res) => {
  const { day_index, hour, subject, room, type } = req.body;
  try {
    const c = await db();
    await c.execute(`
      INSERT INTO schedule_entries (user_id,day_index,hour,subject,room,type)
      VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE subject=VALUES(subject), room=VALUES(room), type=VALUES(type)
    `, [req.user.id, day_index, hour, subject, room || '', type]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.post('/api/grades/schedule/delete', auth, requireCompagnia, async (req, res) => {
  const { day_index, hour } = req.body;
  try {
    const c = await db();
    await c.execute('DELETE FROM schedule_entries WHERE user_id=? AND day_index=? AND hour=?',
      [req.user.id, day_index, hour]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.post('/api/grades/schedule/clear', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM schedule_entries WHERE user_id=?', [req.user.id]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.post('/api/grades/notes', auth, requireCompagnia, async (req, res) => {
  const { id, title, body, pinned, date } = req.body;
  try {
    const c = await db();
    await c.execute('INSERT INTO notes (id,user_id,title,body,pinned,note_date) VALUES (?,?,?,?,?,?)',
      [id, req.user.id, title || '', body, pinned ? 1 : 0, date || null]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.put('/api/grades/notes/:id', auth, requireCompagnia, async (req, res) => {
  const { pinned } = req.body;
  try {
    const c = await db();
    await c.execute('UPDATE notes SET pinned=? WHERE id=? AND user_id=?',
      [pinned ? 1 : 0, req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.delete('/api/grades/notes/:id', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM notes WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.put('/api/grades/settings', auth, requireCompagnia, async (req, res) => {
  const { weight_uni, weight_acad, weight_gym, weight_mil, pen_consegna_rate } = req.body;
  try {
    const c = await db();
    await c.execute(`
      INSERT INTO grade_settings (user_id,weight_uni,weight_acad,weight_gym,weight_mil,pen_consegna_rate)
      VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        weight_uni=VALUES(weight_uni), weight_acad=VALUES(weight_acad),
        weight_gym=VALUES(weight_gym), weight_mil=VALUES(weight_mil),
        pen_consegna_rate=VALUES(pen_consegna_rate)
    `, [req.user.id, weight_uni, weight_acad, weight_gym, weight_mil, pen_consegna_rate]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

// ── LISTE ─────────────────────────────────────────────────────
app.get('/api/lists', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    const [lists] = await c.execute(`
      SELECT
        l.*,
        (
          SELECT COUNT(*)
          FROM list_signups s
          WHERE s.list_id = l.id
        ) AS signup_count
      FROM lists l
      ORDER BY l.list_date DESC, l.created_at DESC
    `);
    res.json(lists);
  } catch(e) { errServer(res, e); }
});

app.post('/api/lists', auth, requireCompagnia, async (req, res) => {
  const { id, list_type, list_date, notes, custom_name, custom_field_label, custom_fields } = req.body;
  if (!list_date) return res.status(400).json({ error: 'Data obbligatoria' });
  let customNameDb = null;
  let fieldsJson = null;
  if (list_type === 'custom') {
    if (!custom_name?.trim()) return res.status(400).json({ error: 'Nome lista obbligatorio per liste personalizzate' });
    customNameDb = custom_name.trim();
    let arr = [];
    if (Array.isArray(custom_fields)) arr = custom_fields.map(x => String(x || '').trim()).filter(Boolean);
    else if (typeof custom_fields === 'string' && custom_fields.trim()) {
      arr = custom_fields.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    if (!arr.length && custom_field_label?.trim()) arr = [custom_field_label.trim()];
    fieldsJson = arr.length ? JSON.stringify(arr) : null;
  }
  try {
    const c = await db();
    await c.execute(
      'INSERT INTO lists (id,list_type,list_date,notes,created_by,custom_name,custom_fields_json) VALUES (?,?,?,?,?,?,?)',
      [id, list_type, list_date, notes || '', req.user.id, customNameDb, fieldsJson]
    );
    res.json({ ok: true });
  } catch(e) { errServer(res, e); }
});

app.delete('/api/lists/:id', auth, requireAdmin, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM list_signups WHERE list_id=?', [req.params.id]);
    await c.execute('DELETE FROM lists WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { errServer(res, e); }
});

app.get('/api/lists/:id', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    const [lists] = await c.execute('SELECT * FROM lists WHERE id=?', [req.params.id]);
    if (!lists.length) return res.status(404).json({ error: 'Lista non trovata' });
    const [signups] = await c.execute(`
      SELECT s.*, u.username, u.full_name, u.nome, u.cognome, u.military_rank
      FROM list_signups s JOIN users u ON s.user_id=u.id
      WHERE s.list_id=? ORDER BY s.signed_up_at ASC
    `, [req.params.id]);
    // Carica i parenti parlatorio per ogni iscritto
    const [allRelatives] = await c.execute(
      'SELECT * FROM list_relatives WHERE list_id=? ORDER BY created_at ASC',
      [req.params.id]
    );
    // Associa i parenti all'iscritto corrispondente
    const signupsWithRelatives = signups.map(s => ({
      ...s,
      relatives: allRelatives.filter(r => Number(r.user_id) === Number(s.user_id))
    }));
    res.json({ ...lists[0], signups: signupsWithRelatives });
  } catch(e) { errServer(res, e); }
});

app.post('/api/lists/:id/signup', auth, requireCompagnia, async (req, res) => {
  const { signup_id, relative_name, relative_relation, relative_id_card, note, custom_values } = req.body;
  try {
    const c = await db();
    const [lists] = await c.execute(
      'SELECT list_type, custom_fields_json FROM lists WHERE id=?',
      [req.params.id]
    );
    if (!lists.length) return res.status(404).json({ error: 'Lista non trovata' });
    const list = lists[0];
    let noteToStore = note != null && String(note).trim() !== '' ? String(note).trim() : null;

    if (list.list_type === 'custom' && list.custom_fields_json) {
      let labels = [];
      try {
        const raw = list.custom_fields_json;
        const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
        labels = Array.isArray(p) ? p.map(x => String(x || '').trim()).filter(Boolean) : [];
      } catch (e) { labels = []; }
      if (labels.length) {
        const vals = custom_values && typeof custom_values === 'object' && !Array.isArray(custom_values) ? custom_values : {};
        const out = {};
        for (const lab of labels) {
          const v = vals[lab] != null ? String(vals[lab]).trim() : '';
          if (!v) return res.status(400).json({ error: `Compila il campo: ${lab}` });
          out[lab] = v;
        }
        noteToStore = JSON.stringify(out);
      }
    }

    await c.execute(
      'INSERT INTO list_signups (id,list_id,user_id,relative_name,relative_relation,relative_id_card,note) VALUES (?,?,?,?,?,?,?)',
      [signup_id, req.params.id, req.user.id, relative_name || null, relative_relation || null, relative_id_card || null, noteToStore]
    );
    res.json({ ok: true });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Già iscritto a questa lista' });
    errServer(res, e);
  }
});

app.delete('/api/lists/:id/signup', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM list_signups WHERE list_id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch(e) { errServer(res, e); }
});

app.delete('/api/lists/:listId/signup/:userId', auth, requireAdmin, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM list_signups WHERE list_id=? AND user_id=?', [req.params.listId, req.params.userId]);
    // Rimuove anche i parenti parlatorio
    await c.execute('DELETE FROM list_relatives WHERE list_id=? AND user_id=?', [req.params.listId, req.params.userId]);
    res.json({ ok: true });
  } catch(e) { errServer(res, e); }
});

// ── EXPORT EXCEL LIBERE USCITE ────────────────────────────────────
// Il modulo copre l'intera giornata: raccogliPersoneGiornata unisce tutte le
// liste di libera uscita con la stessa data, elimina i duplicati e ordina.
app.get('/api/lists/:id/excel', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    const [lists] = await c.execute('SELECT id,list_type,list_date FROM lists WHERE id=?', [req.params.id]);
    if (!lists.length) return res.status(404).json({ error: 'Lista non trovata' });
    const richiesta = lists[0];
    if (!excelLU.eLiberaUscita(richiesta.list_type))
      return res.status(400).json({ error: 'Questa lista non ha un modulo Excel dedicato' });

    const persone = await excelLU.raccogliPersoneGiornata(
      (sql, params) => c.execute(sql, params), richiesta);
    if (!persone.length)
      return res.status(400).json({ error: 'Nessun iscritto per questa giornata' });

    const buf = await excelLU.compilaLiberaUscita({ data: richiesta.list_date, persone });
    const nomeFile = `LIBERI_USCENTI_${excelLU.dataItaliana(richiesta.list_date).replace(/\//g, '-')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeFile}"`);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (e) { errServer(res, e); }
});

// ── PARENTI PARLATORIO ────────────────────────────────────────────
app.post('/api/lists/:id/relatives', auth, requireCompagnia, async (req, res) => {
  const { id, relative_name, relative_relation, relative_id_card } = req.body;
  if (!relative_name?.trim()) return res.status(400).json({ error: 'Nome parente obbligatorio' });
  try {
    const c = await db();
    await c.execute(
      'INSERT INTO list_relatives (id,list_id,user_id,relative_name,relative_relation,relative_id_card) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, req.user.id, relative_name.trim(), relative_relation || null, relative_id_card || null]
    );
    res.json({ ok: true });
  } catch(e) { errServer(res, e); }
});

app.delete('/api/lists/:id/relatives/:relId', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM list_relatives WHERE id=? AND user_id=?', [req.params.relId, req.user.id]);
    res.json({ ok: true });
  } catch(e) { errServer(res, e); }
});

// ── CALENDARIO ────────────────────────────────────────────────
app.get('/api/calendar', auth, requireCompagnia, async (req, res) => {
  const { month, year } = req.query;
  try {
    const c = await db();
    let query = `
      SELECT e.*, u.full_name, u.cognome, u.username, u.military_rank
      FROM calendar_events e JOIN users u ON e.user_id = u.id
    `;
    const params = [];
    if(month && year){
      query += ' WHERE MONTH(e.event_date)=? AND YEAR(e.event_date)=?';
      params.push(parseInt(month), parseInt(year));
    }
    query += ' ORDER BY e.event_date ASC, e.event_time ASC';
    const [rows] = await c.execute(query, params);
    res.json(rows);
  } catch(e){ errServer(res, e); }
});

function dataRapporto(req) {
  const value = String(req.query.data || req.body?.data || '');
  if (!pasti.dataISOValida(value)) throw Object.assign(new Error('Data non valida'), { status: 400 });
  return value;
}

app.get('/api/rapportini-pasti/crediti', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute('SELECT meal_export_credits FROM users WHERE id=?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Utente non trovato' });
    const paymentsReady = !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET && process.env.APP_URL);
    res.json({ credits: Number(rows[0].meal_export_credits || 0), paymentsReady });
  } catch (e) { errServer(res, e); }
});

app.post('/api/rapportini-pasti/crediti/acquista', auth, requireCompagnia, async (req, res) => {
  const stripeSecret = String(process.env.STRIPE_SECRET_KEY || '').trim();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  const appUrl = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!stripeSecret || !webhookSecret || !appUrl)
    return res.status(503).json({ error: 'Acquisto crediti non ancora configurato' });
  try {
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('line_items[0][price_data][currency]', 'eur');
    form.set('line_items[0][price_data][unit_amount]', '100');
    form.set('line_items[0][price_data][product_data][name]', 'Pacchetto Rapportini pasti · 3 esportazioni');
    form.set('line_items[0][quantity]', '1');
    form.set('client_reference_id', String(req.user.id));
    form.set('metadata[purpose]', 'meal_pasti_credit_pack');
    form.set('metadata[user_id]', String(req.user.id));
    form.set('metadata[credits]', '3');
    form.set('success_url', `${appUrl}/?pagamento=successo&session_id={CHECKOUT_SESSION_ID}`);
    form.set('cancel_url', `${appUrl}/?pagamento=annullato`);
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${stripeSecret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
    const session = await response.json();
    if (!response.ok || !session.url) {
      console.error('[STRIPE CHECKOUT]', session.error?.message || `HTTP ${response.status}`);
      return res.status(502).json({ error: 'Non è stato possibile avviare il pagamento. Riprova più tardi.' });
    }
    res.json({ url: session.url });
  } catch (e) { errServer(res, e); }
});

app.post('/api/supporto/offri-caffe', auth, async (req, res) => {
  const stripeSecret = String(process.env.STRIPE_SECRET_KEY || '').trim();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  const appUrl = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const amountCents = Number(req.body?.amountCents);
  if (!stripeSecret || !webhookSecret || !appUrl)
    return res.status(503).json({ error: 'Pagamenti non ancora configurati' });
  if (![100, 200, 500, 1000].includes(amountCents))
    return res.status(400).json({ error: 'Importo non valido' });
  try {
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('line_items[0][price_data][currency]', 'eur');
    form.set('line_items[0][price_data][unit_amount]', String(amountCents));
    form.set('line_items[0][price_data][product_data][name]', 'Mancia volontaria · Offri un caffè');
    form.set('line_items[0][price_data][product_data][description]', 'Supporto facoltativo per il servizio Portale AU. Non aggiunge crediti o permessi.');
    form.set('line_items[0][quantity]', '1');
    form.set('client_reference_id', String(req.user.id));
    form.set('metadata[purpose]', 'portal_voluntary_tip');
    form.set('metadata[user_id]', String(req.user.id));
    form.set('success_url', `${appUrl}/?sezione=caffe&supporto=grazie`);
    form.set('cancel_url', `${appUrl}/?sezione=caffe&supporto=annullato`);
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${stripeSecret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
    const session = await response.json();
    if (!response.ok || !session.url) {
      console.error('[STRIPE TIP]', session.error?.message || `HTTP ${response.status}`);
      return res.status(502).json({ error: 'Non è stato possibile aprire il pagamento. Riprova più tardi.' });
    }
    res.json({ url: session.url });
  } catch (e) { errServer(res, e); }
});

app.get('/api/rapportini-pasti/crediti/conferma', auth, requireCompagnia, async (req, res) => {
  const stripeSecret = String(process.env.STRIPE_SECRET_KEY || '').trim();
  const sessionId = String(req.query.session_id || '');
  if (!stripeSecret) return res.status(503).json({ error: 'Pagamenti non configurati' });
  if (!/^cs_(?:test|live)_[A-Za-z0-9_]+$/.test(sessionId))
    return res.status(400).json({ error: 'Riferimento pagamento non valido' });
  try {
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${stripeSecret}` }
    });
    const session = await response.json();
    if (!response.ok) return res.status(502).json({ error: 'Verifica del pagamento non riuscita' });
    if (Number(session.metadata?.user_id) !== Number(req.user.id))
      return res.status(403).json({ error: 'Pagamento associato a un altro account' });
    if (session.payment_status !== 'paid') return res.json({ pending: true });
    await accreditaCreditiStripe(session);
    const c = await db();
    const [rows] = await c.execute('SELECT meal_export_credits FROM users WHERE id=?', [req.user.id]);
    res.json({ credits: Number(rows[0]?.meal_export_credits || 0) });
  } catch (e) { errServer(res, e); }
});

// ── SHOP KAPS ─────────────────────────────────────────────────
const SHOP_CATEGORIES = new Set(['abbigliamento','elettronica','libri','sport','altro']);
function shopCommissionPercent() {
  const raw = String(process.env.SHOP_COMMISSION_PERCENT ?? '15').trim();
  const percent = Number(raw);
  if (!Number.isFinite(percent) || percent < 0 || percent > 50)
    throw Object.assign(new Error('Configurazione SHOP_COMMISSION_PERCENT non valida (usa un valore tra 0 e 50)'), { status: 503 });
  return percent;
}
function datiAnnuncioShop(body) {
  const name = String(body?.name || '').trim();
  const description = String(body?.description || '').trim();
  const category = String(body?.category || 'altro').trim();
  const phone = String(body?.phone || '').trim();
  const price = Number(String(body?.price || '').replace(',', '.'));
  const priceCents = Math.round(price * 100);
  if (!name || name.length > 120) throw Object.assign(new Error('Inserisci un nome articolo (massimo 120 caratteri)'), { status: 400 });
  if (!SHOP_CATEGORIES.has(category)) throw Object.assign(new Error('Categoria non valida'), { status: 400 });
  if (description.length > 800) throw Object.assign(new Error('La descrizione può contenere al massimo 800 caratteri'), { status: 400 });
  const descrizioneCompatta = description.toLowerCase().replace(/[^a-z0-9@.+]/g, '');
  const contieneEmail = description.includes('@');
  const contieneLink = /(?:https?:\/\/|www\.)/i.test(description) || /\.[a-z]{2,}(?:\b|$)/i.test(description);
  const piattaformeContatto = ['whatsapp', 'telegram', 'instagram', 'facebook', 'snapchat', 'tiktok', 'signal'];
  const citaPiattaforma = piattaformeContatto.some(nome => descrizioneCompatta.includes(nome));
  const contieneTelefono = description.split('').filter(carattere => carattere >= '0' && carattere <= '9').length >= 7;
  if (contieneEmail || contieneLink || citaPiattaforma || contieneTelefono)
    throw Object.assign(new Error('Per evitare vendite fuori dallo Shop, non inserire numeri, email, link o profili social nella descrizione. I contatti si sbloccano dopo l’acquisto.'), { status: 400 });
  if (!Number.isFinite(price) || priceCents < 50 || priceCents > 1000000)
    throw Object.assign(new Error('Il prezzo deve essere compreso tra 0,50 € e 10.000 €'), { status: 400 });
  if (!/^\+?[0-9 ()-]{6,25}$/.test(phone) || phone.replace(/\D/g, '').length < 6)
    throw Object.assign(new Error('Inserisci un numero di telefono valido'), { status: 400 });
  return { name, category, description, phone, priceCents };
}

app.get('/api/shop-kaps/config', auth, (req, res) => {
  try { res.json({
    commission_percent: shopCommissionPercent(),
    payments_ready: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET && process.env.APP_URL)
  }); }
  catch (e) { res.status(e.status || 503).json({ error: e.message }); }
});

app.get('/api/shop-kaps/listings', auth, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const category = String(req.query.category || '').trim();
  try {
    const c = await db();
    const params = [];
    let where = '1=1';
    if (q) { where += ' AND l.item_name LIKE ?'; params.push(`%${q}%`); }
    if (SHOP_CATEGORIES.has(category)) { where += ' AND l.category=?'; params.push(category); }
    const [rows] = await c.execute(
      `SELECT l.id,l.item_name,l.category,l.description,l.price_cents,l.status,l.created_at,l.purchased_at,
      IF(l.seller_id=?,l.commission_percent,NULL) AS commission_percent,
       IF(l.seller_id=?,l.commission_cents,NULL) AS commission_cents,
       IF(l.seller_id=?,l.seller_net_cents,NULL) AS seller_net_cents,
       IF(l.seller_id=?,l.seller_paid_at,NULL) AS seller_paid_at,
       IF(l.seller_id=?,l.seller_phone,NULL) AS seller_phone,
       (l.seller_id=?) AS mine,(l.buyer_id=?) AS purchased_by_me,
       (l.pending_session_id IS NOT NULL AND l.seller_id=?) AS pending
       FROM shop_kaps_listings l WHERE ${where}
       ORDER BY CASE WHEN l.status='available' THEN 0 ELSE 1 END,l.created_at DESC`,
      [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, ...params]
    );
    res.json(rows.map(row => ({ ...row, mine: !!Number(row.mine), purchased_by_me: !!Number(row.purchased_by_me), pending: !!Number(row.pending) })));
  } catch (e) { errServer(res, e); }
});

app.post('/api/shop-kaps/listings', auth, async (req, res) => {
  try {
    const item = datiAnnuncioShop(req.body);
    const c = await db();
    const [result] = await c.execute(
      'INSERT INTO shop_kaps_listings (seller_id,item_name,category,description,price_cents,seller_phone) VALUES (?,?,?,?,?,?)',
      [req.user.id, item.name, item.category, item.description, item.priceCents, item.phone]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); errServer(res, e, 'pubblicazione annuncio Shop'); }
});

app.put('/api/shop-kaps/listings/:id', auth, async (req, res) => {
  try {
    const item = datiAnnuncioShop(req.body);
    const c = await db();
    const connection = await c.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT seller_id,status,pending_session_id FROM shop_kaps_listings WHERE id=? FOR UPDATE', [req.params.id]);
      const listing = rows[0];
      if (!listing) { await connection.rollback(); return res.status(404).json({ error: 'Annuncio non trovato' }); }
      if (Number(listing.seller_id) !== Number(req.user.id)) { await connection.rollback(); return res.status(403).json({ error: 'Puoi modificare solo i tuoi annunci' }); }
      if (listing.status !== 'available') { await connection.rollback(); return res.status(409).json({ error: 'Un annuncio venduto non si può modificare' }); }
      if (listing.pending_session_id) { await connection.rollback(); return res.status(409).json({ error: 'C’è un pagamento in corso per questo articolo. Riprova dopo la conferma o la scadenza del pagamento.' }); }
      await connection.execute(
        'UPDATE shop_kaps_listings SET item_name=?,category=?,description=?,price_cents=?,seller_phone=? WHERE id=? AND seller_id=? AND status=\'available\'',
        [item.name, item.category, item.description, item.priceCents, item.phone, req.params.id, req.user.id]
      );
      await connection.commit();
    } catch (e) { try { await connection.rollback(); } catch {} throw e; }
    finally { connection.release(); }
    res.json({ ok: true });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); errServer(res, e); }
});

app.delete('/api/shop-kaps/listings/:id', auth, async (req, res) => {
  try {
    const c = await db();
    const connection = await c.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT seller_id,status,pending_session_id FROM shop_kaps_listings WHERE id=? FOR UPDATE', [req.params.id]);
      const listing = rows[0];
      if (!listing) { await connection.rollback(); return res.status(404).json({ error: 'Annuncio non trovato' }); }
      if (Number(listing.seller_id) !== Number(req.user.id)) { await connection.rollback(); return res.status(403).json({ error: 'Puoi eliminare solo i tuoi annunci' }); }
      if (listing.status !== 'available') { await connection.rollback(); return res.status(409).json({ error: 'Un annuncio venduto non si può eliminare' }); }
      if (listing.pending_session_id) { await connection.rollback(); return res.status(409).json({ error: 'C’è un pagamento in corso per questo articolo. Riprova dopo la conferma o la scadenza del pagamento.' }); }
      await connection.execute('DELETE FROM shop_kaps_listings WHERE id=? AND seller_id=? AND status=\'available\'', [req.params.id, req.user.id]);
      await connection.commit();
    } catch (e) { try { await connection.rollback(); } catch {} throw e; }
    finally { connection.release(); }
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.post('/api/shop-kaps/listings/:id/checkout', auth, async (req, res) => {
  const stripeSecret = String(process.env.STRIPE_SECRET_KEY || '').trim();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  const appUrl = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Articolo non valido' });
  if (!stripeSecret || !webhookSecret || !appUrl) return res.status(503).json({ error: 'Pagamenti Stripe e webhook non ancora configurati' });
  const c = await db();
  const connection = await c.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM shop_kaps_listings WHERE id=? FOR UPDATE', [id]);
    const listing = rows[0];
    if (!listing || listing.status !== 'available') {
      await connection.rollback();
      return res.status(409).json({ error: 'Questo articolo è già stato comprato' });
    }
    if (Number(listing.seller_id) === Number(req.user.id)) {
      await connection.rollback();
      return res.status(403).json({ error: 'Non puoi comprare un tuo articolo' });
    }
    if (listing.pending_session_id) {
      await connection.rollback();
      return res.status(409).json({ error: 'È già in corso un pagamento per questo articolo. Riprova dopo la conferma o la scadenza.' });
    }
    const percent = shopCommissionPercent();
    const commissionCents = Math.round(Number(listing.price_cents) * percent / 100);
    const sellerNetCents = Number(listing.price_cents) - commissionCents;
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('line_items[0][price_data][currency]', 'eur');
    form.set('line_items[0][price_data][unit_amount]', String(listing.price_cents));
    form.set('line_items[0][price_data][product_data][name]', listing.item_name);
    form.set('line_items[0][quantity]', '1');
    form.set('client_reference_id', String(req.user.id));
    form.set('metadata[purpose]', 'shop_kaps_listing');
    form.set('metadata[listing_id]', String(id));
    form.set('metadata[buyer_id]', String(req.user.id));
    form.set('metadata[commission_percent]', String(percent));
    form.set('metadata[commission_cents]', String(commissionCents));
    form.set('metadata[seller_net_cents]', String(sellerNetCents));
    const integrationSuffix = Array.from(crypto.randomBytes(8), byte => String.fromCharCode(97 + byte % 26)).join('');
    form.set('integration_identifier', `shop_kaps_${integrationSuffix}`);
    form.set('success_url', `${appUrl}/?sezione=shop-kaps&acquisto=verifica&session_id={CHECKOUT_SESSION_ID}`);
    form.set('cancel_url', `${appUrl}/?sezione=shop-kaps&acquisto=annullato&listing_id=${id}`);
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST', headers: { Authorization: `Bearer ${stripeSecret}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2026-09-30.endive' }, body: form
    });
    const session = await response.json();
    if (!response.ok || !session.url || !session.id) {
      await connection.rollback();
      console.error('[SHOP STRIPE CHECKOUT]', session.error?.message || `HTTP ${response.status}`);
      return res.status(502).json({ error: 'Non è stato possibile avviare il pagamento. Riprova più tardi.' });
    }
    await connection.execute(
      'UPDATE shop_kaps_listings SET pending_buyer_id=?,pending_session_id=?,pending_until=DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 24 HOUR),pending_commission_percent=?,pending_commission_cents=?,pending_seller_net_cents=? WHERE id=?',
      [req.user.id, session.id, percent, commissionCents, sellerNetCents, id]
    );
    await connection.commit();
    res.json({ url: session.url });
  } catch (e) {
    try { await connection.rollback(); } catch {}
    if (e.status) return res.status(e.status).json({ error: e.message });
    errServer(res, e);
  } finally { connection.release(); }
});

app.get('/api/shop-kaps/purchases/confirm', auth, async (req, res) => {
  const stripeSecret = String(process.env.STRIPE_SECRET_KEY || '').trim();
  const sessionId = String(req.query.session_id || '');
  if (!stripeSecret || !/^cs_(?:test|live)_[A-Za-z0-9_]+$/.test(sessionId))
    return res.status(400).json({ error: 'Riferimento pagamento non valido' });
  try {
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${stripeSecret}` }
    });
    const session = await response.json();
    if (!response.ok) return res.status(502).json({ error: 'Verifica del pagamento non riuscita' });
    if (session.metadata?.purpose !== 'shop_kaps_listing' || Number(session.metadata?.buyer_id) !== Number(req.user.id))
      return res.status(403).json({ error: 'Pagamento associato a un altro account' });
    if (session.payment_status === 'paid') await accreditaAcquistoShop(session);
    res.json({ pending: session.payment_status !== 'paid' });
  } catch (e) { errServer(res, e); }
});

app.post('/api/shop-kaps/purchases/cancel', auth, async (req, res) => {
  const stripeSecret = String(process.env.STRIPE_SECRET_KEY || '').trim();
  const listingId = Number(req.body?.listing_id);
  if (!stripeSecret || !Number.isSafeInteger(listingId) || listingId < 1)
    return res.status(400).json({ error: 'Richiesta di annullamento non valida' });
  try {
    const c = await db();
    const [rows] = await c.execute(
      "SELECT pending_session_id FROM shop_kaps_listings WHERE id=? AND pending_buyer_id=? AND status='available'",
      [listingId, req.user.id]
    );
    const sessionId = rows[0]?.pending_session_id;
    if (!sessionId) return res.json({ ok: true });
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${stripeSecret}` }
    });
    const session = await response.json();
    if (!response.ok) return res.status(502).json({ error: 'Impossibile verificare lo stato del pagamento' });
    if (session.payment_status === 'paid') {
      await accreditaAcquistoShop(session);
      return res.json({ purchased: true });
    }
    if (session.status === 'open') {
      const expire = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
        method: 'POST', headers: { Authorization: `Bearer ${stripeSecret}` }
      });
      if (!expire.ok) return res.status(409).json({ error: 'Il pagamento è già in elaborazione e va verificato prima di modificare l’annuncio' });
    } else if (session.status !== 'expired') {
      return res.status(409).json({ error: 'Il pagamento è in elaborazione; l’annuncio non è ancora modificabile' });
    }
    await c.execute(
      "UPDATE shop_kaps_listings SET pending_buyer_id=NULL,pending_session_id=NULL,pending_until=NULL,pending_commission_percent=NULL,pending_commission_cents=NULL,pending_seller_net_cents=NULL WHERE id=? AND pending_session_id=? AND status='available'",
      [listingId, sessionId]
    );
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.get('/api/shop-kaps/purchases/:id/phone', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(
      "SELECT seller_phone FROM shop_kaps_listings WHERE id=? AND status='purchased' AND buyer_id=?",
      [Number(req.params.id), req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Numero disponibile solo dopo un acquisto completato' });
    res.json({ phone: rows[0].seller_phone });
  } catch (e) { errServer(res, e); }
});

app.get('/api/shop-kaps/admin/settlements', auth, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Accesso riservato agli amministratori' });
  try {
    const c = await db();
    const [rows] = await c.execute(
      `SELECT l.id,l.item_name,l.price_cents,l.commission_percent,l.commission_cents,l.seller_net_cents,l.seller_phone,l.purchased_at,
       u.full_name AS seller_name,u.email AS seller_email
       FROM shop_kaps_listings l JOIN users u ON u.id=l.seller_id
       WHERE l.status='purchased' AND l.seller_paid_at IS NULL ORDER BY l.purchased_at ASC`
    );
    res.json(rows);
  } catch (e) { errServer(res, e); }
});

app.post('/api/shop-kaps/admin/settlements/:id/paid', auth, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Accesso riservato agli amministratori' });
  try {
    const c = await db();
    const [result] = await c.execute(
      "UPDATE shop_kaps_listings SET seller_paid_at=CURRENT_TIMESTAMP,seller_paid_by=? WHERE id=? AND status='purchased' AND seller_paid_at IS NULL",
      [req.user.id, req.params.id]
    );
    if (!result.affectedRows) return res.status(409).json({ error: 'Saldo non trovato o già segnato come consegnato' });
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

app.get('/api/rapportini-pasti', auth, requireCompagnia, async (req, res) => {
  try {
    const date = dataRapporto(req);
    const c = await db();
    if (req.query.reset === '1' && req.user.is_admin) {
      await resetEccezioniPastoAllaRiapertura(c, 2, date);
      await resetEccezioniPastoAllaRiapertura(c, 2, date, true);
    }
    res.json(await preparaVociPasto(c, 2, date));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    errServer(res, e);
  }
});

app.put('/api/rapportini-pasti', auth, requireCompagnia, requireAdmin, async (req, res) => {
  try {
    const date = dataRapporto(req);
    const c = await db();
    await preparaVociPasto(c, 2, date);
    const risultato = req.body.allServito
      ? await impostaServitoPerTutti(c, req, date)
      : await salvaVociPasto(c, req, date, req.body.entries);
    res.json(risultato);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    errServer(res, e);
  }
});

app.get('/api/rapportini-pasti/previsionale', auth, requireCompagnia, async (req, res) => {
  try {
    const date = pasti.giornoSuccessivo(dataRapporto(req));
    const c = await db();
    if (req.query.reset === '1' && req.user.is_admin)
      await resetEccezioniPastoAllaRiapertura(c, 2, date, true);
    res.json(await preparaVociPasto(c, 2, date, true));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    errServer(res, e);
  }
});

app.put('/api/rapportini-pasti/previsionale', auth, requireCompagnia, requireAdmin, async (req, res) => {
  try {
    const date = req.body?.forecastDate;
    if (!pasti.dataISOValida(date)) throw Object.assign(new Error('Data previsionale non valida'), { status: 400 });
    const c = await db();
    await preparaVociPasto(c, 2, date, true);
    const risultato = req.body.allServito
      ? await impostaServitoPerTutti(c, req, date, true)
      : await salvaVociPasto(c, req, date, req.body.entries, true);
    res.json(risultato);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    errServer(res, e);
  }
});

app.get('/api/rapportini-pasti/export', auth, requireCompagnia, async (req, res) => {
  try {
    const date = dataRapporto(req);
    const nextDate = pasti.giornoSuccessivo(date);
    const companyId = 2; // 7ª Compagnia, ID storico
    const c = await db();
    const day = await preparaVociPasto(c, companyId, date);
    const forecast = await preparaVociPasto(c, companyId, nextDate, true);
    const file = await excelPasti.compilaRapportino({ date, students: day.students, forecast: forecast.students });
    const [debit] = await c.execute(
      'UPDATE users SET meal_export_credits=meal_export_credits-1 WHERE id=? AND meal_export_credits>0',
      [req.user.id]
    );
    if (!debit.affectedRows)
      return res.status(402).json({ error: 'Non hai crediti sufficienti. Acquista il pacchetto da 1 € per 3 esportazioni.' });
    const [balance] = await c.execute('SELECT meal_export_credits FROM users WHERE id=?', [req.user.id]);
    res.setHeader('X-Meal-Report-Credits', String(Number(balance[0]?.meal_export_credits || 0)));
    const filename = `RAPPORTINO_PASTI_${date}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(file);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    errServer(res, e);
  }
});

app.post('/api/calendar', auth, requireCompagnia, async (req, res) => {
  const { id, title, event_date, event_time, description, color } = req.body;
  if(!title?.trim() || !event_date) return res.status(400).json({ error: 'Titolo e data obbligatori' });
  try {
    const c = await db();
    await c.execute(
      'INSERT INTO calendar_events (id,user_id,title,event_date,event_time,description,color) VALUES (?,?,?,?,?,?,?)',
      [id, req.user.id, title.trim(), event_date, event_time||null, description||null, color||'gold']
    );
    res.json({ ok: true });
  } catch(e){ errServer(res, e); }
});

app.delete('/api/calendar/:id', auth, requireCompagnia, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute('SELECT user_id FROM calendar_events WHERE id=?', [req.params.id]);
    if(!rows.length) return res.status(404).json({ error: 'Evento non trovato' });
    if(rows[0].user_id !== req.user.id && !req.user.is_admin)
      return res.status(403).json({ error: 'Non puoi eliminare questo evento' });
    await c.execute('DELETE FROM calendar_events WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e){ errServer(res, e); }
});

// ── ADMIN ─────────────────────────────────────────────────────
app.get('/api/admin/users', auth, requireAdmin, async (req, res) => {
  try {
    const c = await db();
    // Ricerca per nome: parametrizzata (niente concatenazione di input) e con
    // i caratteri jolly di LIKE neutralizzati, così "50%" cerca davvero "50%".
    const q = String(req.query.q || '').trim();
    let sql = 'SELECT id,username,email,full_name,nome,cognome,military_rank,role,can_access_finance,can_access_2compagnia,is_admin,created_at FROM users';
    const params = [];
    if (q) {
      const termine = '%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
      sql += ' WHERE nome LIKE ? OR cognome LIKE ? OR full_name LIKE ? OR username LIKE ?'
           + " OR CONCAT(cognome,' ',nome) LIKE ? OR CONCAT(nome,' ',cognome) LIKE ?";
      params.push(termine, termine, termine, termine, termine, termine);
    }
    sql += ' ORDER BY id DESC';
    const [rows] = await c.execute(sql, params);
    rows.forEach(u => {
      u.can_access_finance    = !!u.can_access_finance;
      u.can_access_2compagnia = !!u.can_access_2compagnia;
      u.is_admin              = !!u.is_admin;
      u.role                  = u.role || 'none';
      u.military_rank         = u.military_rank || 'AU';
    });
    res.json(rows);
  } catch (e) { errServer(res, e); }
});

app.put('/api/admin/users/:id', auth, requireAdmin, async (req, res) => {
  // can_access_grades non esiste più come permesso a sé: l'accesso al Registro
  // Voti deriva da can_access_2compagnia. La colonna resta in tabella per non
  // fare modifiche distruttive, ma viene allineata al permesso 2 Compagnia.
  const { can_access_finance, can_access_2compagnia, is_admin, role } = req.body;
  try {
    const c = await db();
    await c.execute(
      'UPDATE users SET can_access_finance=?,can_access_2compagnia=?,can_access_grades=?,is_admin=?,role=? WHERE id=?',
      [can_access_finance ? 1 : 0, can_access_2compagnia ? 1 : 0, can_access_2compagnia ? 1 : 0, is_admin ? 1 : 0, role || 'none', req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

// Rete di sicurezza: l'admin genera a mano un link di reimpostazione da
// consegnare all'utente. Serve quando l'email non è ancora configurata o
// quando l'allievo non ha più accesso alla casella con cui si è registrato.
// Stesso token, stessa scadenza, stesso uso singolo del percorso via email.
app.post('/api/admin/users/:id/reset-link', auth, requireAdmin, async (req, res) => {
  try {
    const c = await db();
    const [righe] = await c.execute('SELECT id,username,full_name FROM users WHERE id=?', [req.params.id]);
    if (!righe.length) return res.status(404).json({ error: 'Utente non trovato' });
    const token = await creaTokenReset(c, righe[0].id);
    res.json({
      ok: true,
      username: righe[0].username,
      link: linkReset(req, token),
      minuti: RESET_VALIDITA_MINUTI
    });
  } catch (e) { errServer(res, e); }
});

// Prova di invio email. Il recupero password risponde sempre allo stesso modo
// per non rivelare chi è registrato, quindi un errore di configurazione SMTP
// resterebbe invisibile: qui invece l'errore torna per intero, e solo a un
// amministratore. Serve a distinguere "credenziali sbagliate" da "porta
// bloccata dall'hosting" senza dover leggere i log.
app.post('/api/admin/email-test', auth, requireAdmin, async (req, res) => {
  const config = mailer.configurazioneEmail();
  if (!config.configurata)
    return res.status(400).json({ error: 'SMTP non configurato: mancano SMTP_USER e/o SMTP_PASS', config });
  try {
    const c = await db();
    const [righe] = await c.execute('SELECT email FROM users WHERE id=?', [req.user.id]);
    const a = String(req.body?.a || righe[0]?.email || '').trim();
    if (!a) return res.status(400).json({ error: 'Nessun indirizzo a cui inviare la prova', config });
    // `porta` opzionale: permette di provare la 587 senza cambiare la
    // variabile d'ambiente e riavviare il servizio a ogni tentativo.
    const porta = req.body?.porta ? parseInt(req.body.porta, 10) : null;
    if (porta !== null && !(porta > 0 && porta < 65536))
      return res.status(400).json({ error: 'Porta non valida', config });
    const inizio = Date.now();
    await mailer.inviaEmail({
      a,
      porta,
      oggetto: 'Prova di invio — Portale Allievi Ufficiali',
      testo: 'Se stai leggendo questo messaggio, l\'invio email del portale funziona.\n'
           + 'Il recupero password è operativo.'
    });
    res.json({ ok: true, a, porta: porta || config.porta, millisecondi: Date.now() - inizio, config });
  } catch (e) {
    // Il messaggio deve bastare da solo: il frontend mostra solo `error`.
    res.status(502).json({
      error: `${e.message}${e.code ? ' [' + e.code + ']' : ''} — ${config.host}:${config.porta}`,
      codice: e.code || null,
      comando: e.command || null,
      config
    });
  }
});

// Quali porte del server di posta sono davvero raggiungibili da qui.
// Apre e chiude una connessione TCP, non invia niente e non usa le credenziali.
// Distingue i due casi che da fuori sembrano uguali: l'hosting che blocca le
// porte SMTP in uscita, e un problema di credenziali o di rete in generale
// (per quello c'è il controllo su HTTPS, che deve sempre riuscire).
app.get('/api/admin/email-diagnostica', auth, requireAdmin, async (req, res) => {
  try {
    res.json(await mailer.diagnosticaRete());
  } catch (e) { errServer(res, e); }
});

// Stato dello schema: dice se le chiavi perse nella migrazione a Railway sono
// state ripristinate e cosa resta eventualmente da sistemare a mano. Senza
// questo, l'unico modo di saperlo è leggere i log di avvio di Render.
app.get('/api/admin/db-stato', auth, requireAdmin, async (req, res) => {
  try {
    const c = await db();
    const [chiavi] = await c.execute(`
      SELECT TABLE_NAME AS tabella, COLUMN_NAME AS colonna, EXTRA AS extra
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'id'
        AND TABLE_NAME IN ('users','announcements','schedule_entries')
    `);
    const autoIncrement = {};
    chiavi.forEach(r => {
      autoIncrement[r.tabella] = String(r.extra || '').toLowerCase().includes('auto_increment');
    });
    res.json({
      riparazione: statoSchema,
      auto_increment: autoIncrement,
      email: mailer.configurazioneEmail()
    });
  } catch (e) { errServer(res, e); }
});

app.delete('/api/admin/users/:id', auth, requireAdmin, async (req, res) => {
  if (String(req.params.id) === String(req.user.id))
    return res.status(400).json({ error: 'Non puoi eliminare il tuo stesso account' });
  try {
    const c = await db();
    await c.execute('DELETE FROM password_resets WHERE user_id=?', [req.params.id]);
    await c.execute('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { errServer(res, e); }
});

// ── VERSIONE / DIAGNOSTICA DEPLOY ─────────────────────────────
// Endpoint pubblico, senza dati sensibili: dice quale commit sta girando
// davvero in produzione. Serve a distinguere "il codice non funziona" da
// "il codice nuovo non è mai stato deployato".
// RENDER_GIT_COMMIT e RENDER_GIT_BRANCH sono impostate da Render in automatico.
const AVVIO_SERVER = new Date().toISOString();
app.get('/api/version', (req, res) => {
  res.json({
    versione: PKG_VERSION,
    commit  : (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'sconosciuto',
    branch  : process.env.RENDER_GIT_BRANCH || 'sconosciuto',
    avviato : AVVIO_SERVER
  });
});

// ── PAGINA INSTALLAZIONE APP ──────────────────────────────────
app.get('/installa', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'installa.html'));
});

// ── COLLEGAMENTO CON L'APP ANDROID (Digital Asset Links) ──────
// Serve solo se in futuro si pubblica un vero pacchetto Android (TWA) al
// posto della sola installazione da Chrome: Android scarica questo file per
// verificare che l'app e il sito appartengano alla stessa persona, e senza
// la verifica l'app mostra la barra del browser.
// Si attiva impostando due variabili d'ambiente, niente da cambiare nel
// codice; finché non ci sono, la rotta risponde 404 come prima.
//   ANDROID_PACKAGE_NAME  → es. it.accademia.portaleau
//   ANDROID_SHA256_CERT   → impronta SHA-256 del certificato di firma
//                           (più impronte separate da virgola)
app.get('/.well-known/assetlinks.json', (req, res) => {
  const pacchetto = (process.env.ANDROID_PACKAGE_NAME || '').trim();
  const impronte  = (process.env.ANDROID_SHA256_CERT || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!pacchetto || !impronte.length)
    return res.status(404).json({ error: 'App Android non configurata' });
  res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: pacchetto,
      sha256_cert_fingerprints: impronte
    }
  }]);
});

// ── FALLBACK SPA ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────
async function avviaServer() {
  if (!JWT_SECRET)
    console.warn('⚠  JWT_SECRET non impostato: è stata generata una chiave temporanea, le sessioni scadranno al riavvio.');
  if (!process.env.DB_PASS)
    console.warn('⚠  ATTENZIONE: credenziali database mancanti. Imposta DB_HOST/DB_USER/DB_PASS/DB_NAME come variabili d\'ambiente!');
  if (!mailer.emailConfigurata())
    console.warn('⚠  Recupero password: SMTP non configurato. Imposta SMTP_USER e SMTP_PASS per l\'invio delle email.');
  console.log(`   Avvio: http://localhost:${PORT}`);
  console.log(`   DB:    ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  await initDB();
  app.listen(PORT, () => console.log(`⚔  Portale AU — Server avviato sulla porta ${PORT}\n`));

  // Sonda SMTP all'avvio: scrive nei log quali porte del server di posta sono
  // raggiungibili da QUESTO ambiente. Così la risposta a "l'hosting blocca la
  // 465?" sta nei log di ogni deploy, senza dover fare prove a mano.
  // Non parte niente: solo connessioni TCP aperte e richiuse.
  // Con Brevo attivo si controlla la forma della chiave invece delle porte:
  // il rifiuto "Key not found" nasce quasi sempre da un incollaggio troncato
  // o dalla chiave SMTP presa al posto di quella API.
  const cfgEmail = mailer.configurazioneEmail();
  if (cfgEmail.canale === 'brevo-https') {
    console.log(`   EMAIL: canale Brevo via HTTPS · mittente ${cfgEmail.mittente || '(non impostato!)'} · chiave: ${cfgEmail.chiave}`);
    if (!/^inizia con xkeysib-/.test(cfgEmail.chiave || ''))
      console.warn('   EMAIL: la chiave non inizia con "xkeysib-" — probabilmente è la chiave SMTP invece di quella API (scheda "Chiavi API" su Brevo).');
    if (!cfgEmail.mittente)
      console.warn('   EMAIL: nessun mittente impostato — serve SMTP_FROM oppure SMTP_USER con l\'indirizzo verificato su Brevo.');
  }
  if (mailer.emailConfigurata() && cfgEmail.canale === 'smtp') {
    mailer.diagnosticaRete().then(d => {
      const righe = d.porte.map(p => `${p.porta}:${p.esito === 'raggiungibile' ? 'OK' : p.esito}`).join('  ');
      console.log(`   SMTP: porte di ${d.host} → ${righe}  (https di controllo: ${d.controllo_https.esito})`);
      if (!d.aperte.length)
        console.warn('   SMTP: NESSUNA porta raggiungibile — l\'hosting blocca la posta in uscita. Usa BREVO_API_KEY (invio via HTTPS).');
      else if (!d.aperte.includes(d.porta_configurata))
        console.warn(`   SMTP: la porta configurata ${d.porta_configurata} è chiusa, ma la ${d.aperte[0]} è aperta — l'invio ripiegherà da solo, oppure imposta SMTP_PORT=${d.aperte[0]}.`);
    }).catch(e => console.warn('   SMTP: sonda non riuscita —', e.message));
  }
}

avviaServer().catch(e => {
  console.error('   Avvio server non riuscito:', e.stack || e.message);
  process.exitCode = 1;
});
