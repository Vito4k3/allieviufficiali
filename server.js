// ============================================================
//  ACCADEMIA MILITARE DI MODENA — Backend Server
//  Node.js + Express + MySQL
// ============================================================
'use strict';

const express      = require('express');
const mysql        = require('mysql2/promise');
const bcrypt       = require('bcrypt');
const jwt          = require('jsonwebtoken');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const path         = require('path');

const app = express();

// ── CONFIG ────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'accademia_modena_jwt_secret_2024_CAMBIA_IN_PROD';
const PORT       = parseInt(process.env.PORT || '3000');

const DB_CONFIG = {
  host             : process.env.DB_HOST || 'sql7.freesqldatabase.com',
  port             : parseInt(process.env.DB_PORT || '3306'),
  user             : process.env.DB_USER || 'sql7824955',
  password         : process.env.DB_PASS || '5Nfb39Cmdz',
  database         : process.env.DB_NAME || 'sql7824955',
  waitForConnections: true,
  connectionLimit  : 52,
  charset          : 'utf8mb4'
};

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB POOL ───────────────────────────────────────────────────
let pool;
async function db() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

// ── DB INIT ───────────────────────────────────────────────────
async function initDB() {
  try {
    const c = await db();

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
        UNIQUE KEY unique_signup (list_id, user_id)
      )
    `);

    // Aggiungi colonna note se non esiste (per chi ha già la tabella)
    try {
      await c.execute("ALTER TABLE list_signups ADD COLUMN note VARCHAR(500)");
    } catch(e) { /* colonna già esistente */ }

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
  return res.status(403).json({ error: 'Accesso alla sezione Finanze non autorizzato' });
}

function requireGrades(req, res, next) {
  if (req.user.is_admin || req.user.can_access_grades) return next();
  return res.status(403).json({ error: 'Accesso alla sezione Voti non autorizzato' });
}

function requireAdmin(req, res, next) {
  if (req.user.is_admin) return next();
  return res.status(403).json({ error: 'Solo gli amministratori possono eseguire questa operazione' });
}

const ROLES_WITH_COM_WRITE = ['allievo_servizio', 'capo_compagnia', 'vice_capo_compagnia', 'tenente'];

function canWriteComunicazioni(user) {
  return user.is_admin || ROLES_WITH_COM_WRITE.includes(user.role);
}

// ── SETUP ─────────────────────────────────────────────────────
app.post('/api/setup', async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute('SELECT COUNT(*) AS n FROM users');
    if (rows[0].n > 0) return res.status(400).json({ error: 'Setup già completato. Usa il login.' });
    const { username, email, password, full_name } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
    const hash = await bcrypt.hash(password, 12);
    await c.execute(
      "INSERT INTO users (username,email,password_hash,full_name,is_admin,can_access_finance,can_access_grades,role) VALUES (?,?,?,?,1,1,1,'none')",
      [username, email, hash, full_name || username]
    );
    res.json({ ok: true, message: 'Amministratore creato con successo' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
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
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
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
      military_rank: user.military_rank,
      role: user.role || 'none',
      can_access_finance: !!Number(user.can_access_finance),
      can_access_grades:  !!Number(user.can_access_grades),
      is_admin: !!Number(user.is_admin)
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 86400 * 1000 });
    res.json({ token, user: payload });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(
      'SELECT id,username,email,full_name,nome,cognome,military_rank,platoon,academic_year,role,can_access_finance,can_access_grades,is_admin FROM users WHERE id=?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utente non trovato' });
    const u = rows[0];
    u.can_access_finance = !!Number(u.can_access_finance);
    u.can_access_grades  = !!Number(u.can_access_grades);
    u.is_admin           = !!Number(u.is_admin);
    u.role               = u.role || 'none';
    // Riemetti il JWT con i permessi aggiornati dal DB (altrimenti restano quelli del login)
    const payload = {
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      military_rank: u.military_rank,
      role: u.role,
      can_access_finance: u.can_access_finance,
      can_access_grades: u.can_access_grades,
      is_admin: u.is_admin
    };
    const newToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', newToken, { httpOnly: true, maxAge: 7 * 86400 * 1000 });
    res.json({ ...u, token: newToken });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROFILO ───────────────────────────────────────────────────
app.put('/api/profile', auth, async (req, res) => {
  const { nome, cognome, military_rank, platoon, academic_year } = req.body;
  if (!nome?.trim() || !cognome?.trim())
    return res.status(400).json({ error: 'Nome e cognome obbligatori' });
  const full_name = `${nome.trim()} ${cognome.trim()}`;
  try {
    const c = await db();
    await c.execute(
      'UPDATE users SET nome=?, cognome=?, full_name=?, military_rank=?, platoon=?, academic_year=? WHERE id=?',
      [nome.trim(), cognome.trim(), full_name, military_rank||'', platoon||'', academic_year||'1° Anno', req.user.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ANNUNCI ───────────────────────────────────────────────────
app.get('/api/announcements', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(`
      SELECT a.id, a.content, a.created_at,
             u.id AS author_id, u.username, u.full_name, u.military_rank, u.role, u.is_admin
      FROM announcements a
      JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at DESC LIMIT 100
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    res.json({ ok: true, id: result.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── COMUNICAZIONI: CHAT ───────────────────────────────────────
app.get('/api/comunicazioni/chat', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(`
      SELECT m.id, m.content, m.created_at,
             u.id AS author_id, u.username, u.full_name, u.military_rank, u.role, u.is_admin
      FROM comunicazioni_chat m
      JOIN users u ON m.user_id = u.id
      ORDER BY m.created_at ASC LIMIT 300
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comunicazioni/chat', auth, async (req, res) => {
  if (!canWriteComunicazioni(req.user))
    return res.status(403).json({ error: 'Non hai i permessi per scrivere in Comunicazioni' });
  const { id, content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Messaggio vuoto' });
  try {
    const c = await db();
    await c.execute('INSERT INTO comunicazioni_chat (id,user_id,content) VALUES (?,?,?)',
      [id, req.user.id, content.trim()]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/comunicazioni/chat/:id', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute('SELECT user_id FROM comunicazioni_chat WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Messaggio non trovato' });
    if (rows[0].user_id !== req.user.id && !req.user.is_admin)
      return res.status(403).json({ error: 'Non puoi eliminare questo messaggio' });
    await c.execute('DELETE FROM comunicazioni_chat WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── COMUNICAZIONI: COMUNICATI UFFICIALI ───────────────────────
app.get('/api/comunicazioni/posts', auth, async (req, res) => {
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/comunicazioni/posts/:id/file', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(
      'SELECT file_name,file_data,file_type FROM comunicazioni_posts WHERE id=?',
      [req.params.id]
    );
    if (!rows.length || !rows[0].file_data)
      return res.status(404).json({ error: 'File non trovato' });
    res.json({ file_name: rows[0].file_name, file_data: rows[0].file_data, file_type: rows[0].file_type });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comunicazioni/posts', auth, async (req, res) => {
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/comunicazioni/posts/:id', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute('SELECT user_id FROM comunicazioni_posts WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Comunicato non trovato' });
    if (rows[0].user_id !== req.user.id && !req.user.is_admin)
      return res.status(403).json({ error: 'Non puoi eliminare questo comunicato' });
    await c.execute('DELETE FROM comunicazioni_posts WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FINANZE ───────────────────────────────────────────────────
app.get('/api/finance', auth, requireFinance, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(
      'SELECT id,type,description AS `desc`,amount,date,category AS cat,note FROM finance_transactions WHERE user_id=? ORDER BY date DESC',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/finance/:id', auth, requireFinance, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM finance_transactions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── VOTI ──────────────────────────────────────────────────────
app.get('/api/grades/all', auth, requireGrades, async (req, res) => {
  try {
    const c  = await db();
    const id = req.user.id;
    const [[cadetRow]]   = await c.execute('SELECT full_name,military_rank AS `rank`,platoon,academic_year AS `year` FROM users WHERE id=?', [id]);
    const [subjects]     = await c.execute('SELECT * FROM subjects WHERE user_id=? ORDER BY sort_order,name', [id]);
    const [gradesRaw]    = await c.execute('SELECT * FROM grades WHERE user_id=? ORDER BY date DESC', [id]);
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/grades/subjects', auth, requireGrades, async (req, res) => {
  const { id, type, name, credits } = req.body;
  try {
    const c = await db();
    await c.execute('INSERT INTO subjects (id,user_id,type,name,credits) VALUES (?,?,?,?,?)',
      [id, req.user.id, type, name, credits || 1]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/grades/subjects/:id', auth, requireGrades, async (req, res) => {
  const { name, credits } = req.body;
  try {
    const c = await db();
    await c.execute('UPDATE subjects SET name=?,credits=? WHERE id=? AND user_id=?',
      [name, credits, req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/grades/subjects/:id', auth, requireGrades, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM grades   WHERE subject_id=? AND user_id=?', [req.params.id, req.user.id]);
    await c.execute('DELETE FROM subjects WHERE id=?         AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/grades/grades', auth, requireGrades, async (req, res) => {
  const { id, subject_id, grade_type, value, weight, date, description } = req.body;
  try {
    const c = await db();
    await c.execute(
      'INSERT INTO grades (id,subject_id,user_id,grade_type,value,weight,date,description) VALUES (?,?,?,?,?,?,?,?)',
      [id, subject_id, req.user.id, grade_type || 'exam', value, weight || 1, date || null, description || '']
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/grades/grades/:id', auth, requireGrades, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM grades WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/grades/penalties', auth, requireGrades, async (req, res) => {
  const { id, type, days, date, reason } = req.body;
  try {
    const c = await db();
    await c.execute('INSERT INTO penalties (id,user_id,type,days,date,reason) VALUES (?,?,?,?,?,?)',
      [id, req.user.id, type, days, date || null, reason || '']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/grades/penalties/:id', auth, requireGrades, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM penalties WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/grades/schedule/upsert', auth, requireGrades, async (req, res) => {
  const { day_index, hour, subject, room, type } = req.body;
  try {
    const c = await db();
    await c.execute(`
      INSERT INTO schedule_entries (user_id,day_index,hour,subject,room,type)
      VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE subject=VALUES(subject), room=VALUES(room), type=VALUES(type)
    `, [req.user.id, day_index, hour, subject, room || '', type]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/grades/schedule/delete', auth, requireGrades, async (req, res) => {
  const { day_index, hour } = req.body;
  try {
    const c = await db();
    await c.execute('DELETE FROM schedule_entries WHERE user_id=? AND day_index=? AND hour=?',
      [req.user.id, day_index, hour]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/grades/schedule/clear', auth, requireGrades, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM schedule_entries WHERE user_id=?', [req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/grades/notes', auth, requireGrades, async (req, res) => {
  const { id, title, body, pinned, date } = req.body;
  try {
    const c = await db();
    await c.execute('INSERT INTO notes (id,user_id,title,body,pinned,note_date) VALUES (?,?,?,?,?,?)',
      [id, req.user.id, title || '', body, pinned ? 1 : 0, date || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/grades/notes/:id', auth, requireGrades, async (req, res) => {
  const { pinned } = req.body;
  try {
    const c = await db();
    await c.execute('UPDATE notes SET pinned=? WHERE id=? AND user_id=?',
      [pinned ? 1 : 0, req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/grades/notes/:id', auth, requireGrades, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM notes WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/grades/settings', auth, requireGrades, async (req, res) => {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LISTE ─────────────────────────────────────────────────────
app.get('/api/lists', auth, async (req, res) => {
  try {
    const c = await db();
    const [lists] = await c.execute(`
      SELECT l.*, COUNT(s.id) AS signup_count
      FROM lists l LEFT JOIN list_signups s ON l.id=s.list_id
      GROUP BY l.id ORDER BY l.list_date DESC, l.created_at DESC
    `);
    res.json(lists);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/lists', auth, async (req, res) => {
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/lists/:id', auth, requireAdmin, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM list_signups WHERE list_id=?', [req.params.id]);
    await c.execute('DELETE FROM lists WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/lists/:id', auth, async (req, res) => {
  try {
    const c = await db();
    const [lists] = await c.execute('SELECT * FROM lists WHERE id=?', [req.params.id]);
    if (!lists.length) return res.status(404).json({ error: 'Lista non trovata' });
    const [signups] = await c.execute(`
      SELECT s.*, u.username, u.full_name, u.nome, u.cognome, u.military_rank
      FROM list_signups s JOIN users u ON s.user_id=u.id
      WHERE s.list_id=? ORDER BY s.created_at ASC
    `, [req.params.id]);
    // Carica i parenti parlatorio per ogni iscritto
    const [allRelatives] = await c.execute(
      'SELECT * FROM list_relatives WHERE list_id=? ORDER BY created_at ASC',
      [req.params.id]
    );
    // Associa i parenti all'iscritto corrispondente
    const signupsWithRelatives = signups.map(s => ({
      ...s,
      relatives: allRelatives.filter(r => r.user_id === s.user_id)
    }));
    res.json({ ...lists[0], signups: signupsWithRelatives });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/lists/:id/signup', auth, async (req, res) => {
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
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/lists/:id/signup', auth, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM list_signups WHERE list_id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/lists/:listId/signup/:userId', auth, requireAdmin, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM list_signups WHERE list_id=? AND user_id=?', [req.params.listId, req.params.userId]);
    // Rimuove anche i parenti parlatorio
    await c.execute('DELETE FROM list_relatives WHERE list_id=? AND user_id=?', [req.params.listId, req.params.userId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PARENTI PARLATORIO ────────────────────────────────────────────
app.post('/api/lists/:id/relatives', auth, async (req, res) => {
  const { id, relative_name, relative_relation, relative_id_card } = req.body;
  if (!relative_name?.trim()) return res.status(400).json({ error: 'Nome parente obbligatorio' });
  try {
    const c = await db();
    await c.execute(
      'INSERT INTO list_relatives (id,list_id,user_id,relative_name,relative_relation,relative_id_card) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, req.user.id, relative_name.trim(), relative_relation || null, relative_id_card || null]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/lists/:id/relatives/:relId', auth, async (req, res) => {
  try {
    const c = await db();
    await c.execute('DELETE FROM list_relatives WHERE id=? AND user_id=?', [req.params.relId, req.user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CALENDARIO ────────────────────────────────────────────────
app.get('/api/calendar', auth, async (req, res) => {
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
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/calendar', auth, async (req, res) => {
  const { id, title, event_date, event_time, description, color } = req.body;
  if(!title?.trim() || !event_date) return res.status(400).json({ error: 'Titolo e data obbligatori' });
  try {
    const c = await db();
    await c.execute(
      'INSERT INTO calendar_events (id,user_id,title,event_date,event_time,description,color) VALUES (?,?,?,?,?,?,?)',
      [id, req.user.id, title.trim(), event_date, event_time||null, description||null, color||'gold']
    );
    res.json({ ok: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.delete('/api/calendar/:id', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute('SELECT user_id FROM calendar_events WHERE id=?', [req.params.id]);
    if(!rows.length) return res.status(404).json({ error: 'Evento non trovato' });
    if(rows[0].user_id !== req.user.id && !req.user.is_admin)
      return res.status(403).json({ error: 'Non puoi eliminare questo evento' });
    await c.execute('DELETE FROM calendar_events WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// ── ADMIN ─────────────────────────────────────────────────────
app.get('/api/admin/users', auth, requireAdmin, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(
      'SELECT id,username,email,full_name,nome,cognome,military_rank,role,can_access_finance,can_access_grades,is_admin,created_at FROM users ORDER BY cognome ASC, nome ASC'
    );
    rows.forEach(u => {
      u.can_access_finance = !!u.can_access_finance;
      u.can_access_grades  = !!u.can_access_grades;
      u.is_admin           = !!u.is_admin;
      u.role               = u.role || 'none';
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id', auth, requireAdmin, async (req, res) => {
  const { can_access_finance, can_access_grades, is_admin, role } = req.body;
  try {
    const c = await db();
    await c.execute(
      'UPDATE users SET can_access_finance=?,can_access_grades=?,is_admin=?,role=? WHERE id=?',
      [can_access_finance ? 1 : 0, can_access_grades ? 1 : 0, is_admin ? 1 : 0, role || 'none', req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', auth, requireAdmin, async (req, res) => {
  if (String(req.params.id) === String(req.user.id))
    return res.status(400).json({ error: 'Non puoi eliminare il tuo stesso account' });
  try {
    const c = await db();
    await c.execute('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FALLBACK SPA ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n⚔  Accademia Modena — Server avviato`);
  console.log(`   URL:  http://localhost:${PORT}`);
  console.log(`   DB:   ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}\n`);
  await initDB();
});
