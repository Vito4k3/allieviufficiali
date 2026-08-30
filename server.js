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
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');
const path         = require('path');
const excelLU = require('./lib/excel-libere-uscite');
const mailer  = require('./lib/email');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // dietro il proxy dell'hosting (per HTTPS e IP reali)

// Errori interni: log completo sul server, messaggio generico al client
function errServer(res, e) {
  console.error('[ERRORE SERVER]', e.message);
  res.status(500).json({ error: 'Errore interno del server. Riprova più tardi.' });
}

// ── CONFIG ────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'portale_au_jwt_secret_CAMBIA_IN_PROD';
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
app.use(cors({ origin: true, credentials: true }));

// Header di sicurezza su ogni risposta
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
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
// Limita i tentativi per IP sulle rotte sensibili (login, registrazione,
// recupero password).
//
// Il contatore è per (rotta, IP), non per solo IP: prima era condiviso, così
// i tentativi di login consumavano anche il budget della registrazione e del
// recupero password, e chi sbagliava qualche password si ritrovava bloccato
// pure il "Password dimenticata". Ogni rotta ha già il suo `max`: teneva
// senso solo con contatori separati.
const tentativi = new Map(); // "nome|ip" → { n, primoTs }
function limitaTentativi(nome, max, finestraMs) {
  return (req, res, next) => {
    const chiave = nome + '|' + req.ip;
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
// pulizia periodica della mappa
setInterval(() => {
  const ora = Date.now();
  for (const [ip, rec] of tentativi) if (ora - rec.primoTs > 30 * 60 * 1000) tentativi.delete(ip);
}, 10 * 60 * 1000).unref();

// Opzioni cookie di sessione: non leggibile da JS, solo stesso sito, HTTPS in produzione
function cookieSessione(req) {
  return { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 7 * 86400 * 1000 };
}

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
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Non autenticato' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }
}

function requireFinance(req, res, next) {
  if (req.user.is_admin || req.user.can_access_finance) return next();
  return res.status(403).json({ error: 'Strumento Gestione Finanze non sbloccato per il tuo account' });
}

function requireAdmin(req, res, next) {
  if (req.user.is_admin) return next();
  return res.status(403).json({ error: 'Solo gli amministratori possono eseguire questa operazione' });
}

function requireCompagnia(req, res, next) {
  if (req.user.is_admin || req.user.can_access_2compagnia) return next();
  return res.status(403).json({ error: 'Accesso alla sezione 2 Compagnia non autorizzato' });
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
app.post('/api/setup', limitaTentativi('setup', 5, 15 * 60 * 1000), async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute('SELECT COUNT(*) AS n FROM users');
    if (rows[0].n > 0) return res.status(400).json({ error: 'Setup già completato. Usa il login.' });
    const { username, email, password, full_name } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
    const hash = await bcrypt.hash(password, 12);
    await c.execute(
      "INSERT INTO users (username,email,password_hash,full_name,is_admin,can_access_finance,can_access_2compagnia,role) VALUES (?,?,?,?,1,1,1,'none')",
      [username, email, hash, full_name || username]
    );
    res.json({ ok: true, message: 'Amministratore creato con successo' });
  } catch (e) { errServer(res, e); }
});

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/auth/register', limitaTentativi('registrazione', 10, 15 * 60 * 1000), async (req, res) => {
  const { username, email, password, nome, cognome } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Username, email e password sono obbligatori' });
  if (!nome?.trim() || !cognome?.trim())
    return res.status(400).json({ error: 'Nome e cognome sono obbligatori' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La password deve avere almeno 6 caratteri' });
  try {
    const c    = await db();
    const hash = await bcrypt.hash(password, 12);
    const full_name = `${nome.trim()} ${cognome.trim()}`;
    const [result] = await c.execute(
      "INSERT INTO users (username,email,password_hash,full_name,nome,cognome,role) VALUES (?,?,?,?,?,?,'none')",
      [username.trim(), email.trim().toLowerCase(), hash, full_name, nome.trim(), cognome.trim()]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY')
      return res.status(400).json({ error: 'Username o email già registrati' });
    errServer(res, e);
  }
});

app.post('/api/auth/login', limitaTentativi('login', 15, 15 * 60 * 1000), async (req, res) => {
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
      is_admin: !!Number(user.is_admin)
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, cookieSessione(req));
    res.json({ token, user: payload });
  } catch (e) { errServer(res, e); }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// ── RECUPERO PASSWORD ─────────────────────────────────────────
// Il token viaggia solo nel link inviato per email e vive in chiaro solo lì:
// nel database ne resta l'impronta SHA-256, come per le password. Il link usa
// il frammento (#reset=…) invece della query string, così il token non finisce
// nei log del server né nell'intestazione Referer verso terzi.
const RESET_VALIDITA_MINUTI = 60;

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
app.post('/api/auth/password/forgot', limitaTentativi('reset-richiesta', 8, 15 * 60 * 1000), async (req, res) => {
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
      console.warn('   reset password: SMTP non configurato, email non inviata a', email);
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
app.get('/api/auth/password/reset/:token', limitaTentativi('reset-verifica', 30, 15 * 60 * 1000), async (req, res) => {
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
app.post('/api/auth/password/reset', limitaTentativi('reset-conferma', 15, 15 * 60 * 1000), async (req, res) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (!token) return res.status(400).json({ error: 'Link di reimpostazione mancante' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La password deve avere almeno 6 caratteri' });
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
      'SELECT id,username,email,full_name,nome,cognome,military_rank,platoon,academic_year,role,can_access_finance,can_access_2compagnia,is_admin FROM users WHERE id=?',
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
      is_admin: u.is_admin
    };
    const newToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', newToken, cookieSessione(req));
    res.json({ ...u, token: newToken });
  } catch (e) { errServer(res, e); }
});

// ── PROFILO ───────────────────────────────────────────────────
app.put('/api/profile', auth, async (req, res) => {
  const { nome, cognome, platoon, academic_year } = req.body;
  if (!nome?.trim() || !cognome?.trim())
    return res.status(400).json({ error: 'Nome e cognome obbligatori' });
  const full_name = `${nome.trim()} ${cognome.trim()}`;
  try {
    const c = await db();
    // military_rank non è modificabile dall'utente — rimane quello assegnato
    await c.execute(
      'UPDATE users SET nome=?, cognome=?, full_name=?, platoon=?, academic_year=? WHERE id=?',
      [nome.trim(), cognome.trim(), full_name, platoon||'', academic_year||'1° Anno', req.user.id]
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

app.post('/api/announcements', auth, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Il messaggio non può essere vuoto' });
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
app.listen(PORT, async () => {
  console.log(`\n⚔  Portale AU — Server avviato`);
  if (JWT_SECRET === 'portale_au_jwt_secret_CAMBIA_IN_PROD')
    console.warn('⚠  ATTENZIONE: JWT_SECRET di default. Imposta la variabile d\'ambiente JWT_SECRET in produzione!');
  if (!process.env.DB_PASS)
    console.warn('⚠  ATTENZIONE: credenziali database mancanti. Imposta DB_HOST/DB_USER/DB_PASS/DB_NAME come variabili d\'ambiente!');
  if (!mailer.emailConfigurata())
    console.warn('⚠  Recupero password: SMTP non configurato. Imposta SMTP_USER e SMTP_PASS per l\'invio delle email.');
  console.log(`   URL:  http://localhost:${PORT}`);
  console.log(`   DB:   ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}\n`);
  await initDB();
});
