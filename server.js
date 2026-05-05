// ============================================================
//  ACCADEMIA MILITARE DI MODENA — Backend Server
//  Node.js + Express + MySQL
//  Avvio: npm install && node server.js
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
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB POOL ───────────────────────────────────────────────────
let pool;
async function db() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
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

// ── SETUP (primo avvio) ───────────────────────────────────────
// POST /api/setup  →  crea il primo admin se non esiste nessun utente
app.post('/api/setup', async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute('SELECT COUNT(*) AS n FROM users');
    if (rows[0].n > 0) return res.status(400).json({ error: 'Setup già completato. Usa il login.' });
    const { username, email, password, full_name } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
    const hash = await bcrypt.hash(password, 12);
    await c.execute(
      'INSERT INTO users (username,email,password_hash,full_name,is_admin,can_access_finance,can_access_grades) VALUES (?,?,?,?,1,1,1)',
      [username, email, hash, full_name || username]
    );
    res.json({ ok: true, message: 'Amministratore creato con successo' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password, full_name } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Username, email e password sono obbligatori' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La password deve avere almeno 6 caratteri' });
  try {
    const c    = await db();
    const hash = await bcrypt.hash(password, 12);
    const [result] = await c.execute(
      'INSERT INTO users (username,email,password_hash,full_name) VALUES (?,?,?,?)',
      [username.trim(), email.trim().toLowerCase(), hash, full_name?.trim() || '']
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
      can_access_finance: !!user.can_access_finance,
      can_access_grades:  !!user.can_access_grades,
      is_admin: !!user.is_admin
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 86400 * 1000 });
    res.json({ token, user: payload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(
      'SELECT id,username,email,full_name,military_rank,platoon,academic_year,can_access_finance,can_access_grades,is_admin FROM users WHERE id=?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utente non trovato' });
    const u = rows[0];
    u.can_access_finance = !!u.can_access_finance;
    u.can_access_grades  = !!u.can_access_grades;
    u.is_admin           = !!u.is_admin;
    res.json(u);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ANNUNCI ───────────────────────────────────────────────────
app.get('/api/announcements', auth, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(`
      SELECT a.id, a.content, a.created_at,
             u.id AS author_id, u.username, u.full_name, u.military_rank
      FROM announcements a
      JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at DESC
      LIMIT 100
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

// ── VOTI: carica tutto in un colpo ───────────────────────────
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
      schedule: schedMap,
      notes,
      settings: { ...settings, pen_consegna_rate: parseFloat(settings.pen_consegna_rate) }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── VOTI: materie ─────────────────────────────────────────────
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

// ── VOTI: singoli voti ────────────────────────────────────────
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

// ── VOTI: punizioni ───────────────────────────────────────────
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

// ── VOTI: orario ─────────────────────────────────────────────
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

// ── VOTI: note ────────────────────────────────────────────────
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

// ── VOTI: impostazioni ────────────────────────────────────────
app.put('/api/grades/settings', auth, requireGrades, async (req, res) => {
  const { weight_uni, weight_acad, weight_gym, weight_mil, pen_consegna_rate,
          full_name, military_rank, platoon, academic_year } = req.body;
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
    if (full_name !== undefined) {
      await c.execute(
        'UPDATE users SET full_name=?,military_rank=?,platoon=?,academic_year=? WHERE id=?',
        [full_name, military_rank || '', platoon || '', academic_year || '1° Anno', req.user.id]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ─────────────────────────────────────────────────────
app.get('/api/admin/users', auth, requireAdmin, async (req, res) => {
  try {
    const c = await db();
    const [rows] = await c.execute(
      'SELECT id,username,email,full_name,military_rank,can_access_finance,can_access_grades,is_admin,created_at FROM users ORDER BY created_at DESC'
    );
    rows.forEach(u => {
      u.can_access_finance = !!u.can_access_finance;
      u.can_access_grades  = !!u.can_access_grades;
      u.is_admin           = !!u.is_admin;
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id', auth, requireAdmin, async (req, res) => {
  const { can_access_finance, can_access_grades, is_admin } = req.body;
  try {
    const c = await db();
    await c.execute(
      'UPDATE users SET can_access_finance=?,can_access_grades=?,is_admin=? WHERE id=?',
      [can_access_finance ? 1 : 0, can_access_grades ? 1 : 0, is_admin ? 1 : 0, req.params.id]
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

// ── FALLBACK: SPA ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⚔  Accademia Modena — Server avviato`);
  console.log(`   URL:  http://localhost:${PORT}`);
  console.log(`   DB:   ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}\n`);
});
