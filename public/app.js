'use strict';

const API = 'https://sito-allievi-accademia-militare.onrender.com';
const DOC_TITLE_APP = 'Portale AU';
const DOC_TITLE_PUBLIC = 'Portale Allievi Ufficiali';
const SECTION_DOC_TITLES = {
  bacheca:'Bacheca annunci', comunicazioni:'Comunicazioni', calendario:'Calendario', liste:'Liste',
  strumenti:'Strumenti', 'strumento-locked':'Strumento bloccato',
  finanze:'Gestione finanze', voti:'Voti e registro', profilo:'Profilo', admin:'Gestione utenti'
};

// ── REGISTRO STRUMENTI ─────────────────────────────────────────────
// Sezione "Strumenti": elenco unico da cui derivano la voce di menu, la card
// nella pagina indice e la riga di permesso nella modale admin. Per aggiungere
// uno strumento basta una voce qui (+ il relativo campo permesso lato server).
const TOOLS = [
  {
    key:   'finanze',
    page:  'finanze',
    label: 'Gestione Finanze',
    icon:  '💰',
    desc:  'Entrate, uscite, investimenti e ricavi personali con grafici e storico transazioni.',
    perm:  'can_access_finance'
  }
];

function getTool(key){ return TOOLS.find(t => t.key === key) || null; }

// Un permesso è concesso se l'utente è admin oppure ha il flag corrispondente
function userHasPerm(field, user){
  const u = user || currentUser;
  if(!u) return false;
  if(u.is_admin) return true;
  return !!u[field];
}
function canUseTool(tool, user){ return userHasPerm(tool.perm, user); }

// ── REGISTRO PERMESSI (modale admin) ───────────────────────────────
// Unico elenco dei permessi assegnabili: schedario 2 Compagnia, strumenti,
// amministrazione. Nuovi permessi si aggiungono solo qui.
const PERMISSIONS = [
  { group:'Sezioni',        field:'can_access_2compagnia', label:'Schedario 2 Compagnia', icon:'🏛',
    desc:'Comunicazioni, Liste, Calendario e Registro Voti della 2 Compagnia.' },
  { group:'Sezioni',        field:'can_access_grades',     label:'Registro Voti',         icon:'🎓',
    desc:'Consultazione e inserimento di voti, punizioni, orario e note.' },
  ...TOOLS.map(t => ({
    group:'Strumenti', field:t.perm, label:t.label, icon:t.icon,
    desc:`Sblocca lo strumento "${t.label}" nella sezione Strumenti.`
  })),
  { group:'Amministrazione', field:'is_admin',             label:'Amministratore',        icon:'⭐',
    desc:'Accesso completo: gestione utenti, permessi e contenuti di tutti.' }
];

// ── STATE ──────────────────────────────────────────────────────────
let currentUser = null;
let token = localStorage.getItem('jwt') || '';
let transactions = [], txFilter = 'all', editingTxId = null, currentTxType = 'guadagno';
let finBarChart, finDonutChart;
let vdb = {
  subjects: { university:[], gym:[], military:[] },
  penalties: { consegna:[], rigore:[] },
  schedule: {}, notes: [],
  settings: { weight_uni:50, weight_acad:50, weight_gym:50, weight_mil:50, pen_consegna_rate:0.5 }
};
let allLists = [], currentListTab = 'custom', openListId = null;
let bachecaInterval = null;
let chatBadgeInterval = null;
let comChatInterval = null;
let currentComTab = 'chat';
let comChatMessages = [], comPosts = [];
let pendingComFile = null;
let _finSearchTimer = null;

const LIST_LABELS = {
  liberi_sab_pom:  'Liberi Uscenti Sabato Pomeriggio',
  liberi_sab_sera: 'Liberi Uscenti Sabato Sera',
  liberi_dom_pom:  'Liberi Uscenti Domenica Pomeriggio',
  messa:           'Lista Messa',
  parlatorio:      'Lista Parlatorio'
};

function parseListCustomFieldLabels(l) {
  if (!l || l.list_type !== 'custom') return [];
  const raw = l.custom_fields_json;
  if (raw == null || raw === '') return [];
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(p) ? p.map(x => String(x || '').trim()).filter(Boolean) : [];
  } catch (e) { return []; }
}

function parseCustomSignupNote(note) {
  if (note == null || typeof note !== 'string') return null;
  const t = note.trim();
  if (!t.startsWith('{')) return null;
  try {
    const o = JSON.parse(t);
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch (e) {}
  return null;
}

function csvEscCell(s) {
  return `"${String(s ?? '').replace(/"/g, '""')}"`;
}
const ROLE_LABELS = {
  'none':               'Allievo',
  'allievo_servizio':   'Allievo di Servizio',
  'capo_compagnia':     'Capo Compagnia',
  'vice_capo_compagnia':'Vice Capo Compagnia',
  'tenente':            'Tenente'
};
 
const ROLE_CLASSES = {
  'none':               'role-none',
  'allievo_servizio':   'role-servizio',
  'capo_compagnia':     'role-capo',
  'vice_capo_compagnia':'role-vice',
  'tenente':            'role-tenente'
};
 
const ROLES_WITH_WRITE = ['allievo_servizio','capo_compagnia','vice_capo_compagnia','tenente'];

// ── UTILS ──────────────────────────────────────────────────────────
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6) }
function fmt(n,d=2){ if(n==null||isNaN(n)) return '—'; return Number(n).toFixed(d) }
function fmtEur(n){ return '€ '+Number(n).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2}) }
function fmtDate(d){
  if(!d) return '—';
  const s = String(d).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '—';
  return new Date(s+'T12:00:00').toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'});
}
function fmtTime(d){
  if(!d) return '';
  const dt = new Date(d);
  return dt.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'});
}
function fmtDateTime(d){
  if(!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'})+' '+fmtTime(d);
}
function today(){ return new Date().toISOString().slice(0,10) }
function escHtml(s){ const d=document.createElement('div');d.textContent=s;return d.innerHTML }
function roleBadge(role, isAdmin) {
  if (isAdmin) return '<span class="role-badge role-admin">⭐ Amministratore</span>';
  const r = role || 'none';
  const label = ROLE_LABELS[r] || r;
  const cls = ROLE_CLASSES[r] || 'role-none';
  if (r === 'none') return '';
  const icons = { allievo_servizio:'🎯', capo_compagnia:'⚔', vice_capo_compagnia:'🛡', tenente:'🎖' };
  return `<span class="role-badge ${cls}">${icons[r]||''} ${label}</span>`;
}
 
function canWriteCom() {
  if (!currentUser) return false;
  return currentUser.is_admin || ROLES_WITH_WRITE.includes(currentUser.role);
}
 
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
}
function toast(msg,type='ok'){
  const t=document.getElementById('toast');
  t.textContent=(type==='ok'?'✓ ':type==='err'?'✗ ':'ℹ ')+msg;
  t.className='show '+type;
  clearTimeout(t._tm);
  t._tm=setTimeout(()=>t.className='',3800);
}
function scheduleFinSearch(){
  clearTimeout(_finSearchTimer);
  _finSearchTimer = setTimeout(() => { renderFinTx(); _finSearchTimer = null; }, 200);
}
function openModal(id){ document.getElementById(id).classList.add('open') }
function closeModal(id){ document.getElementById(id).classList.remove('open') }
document.querySelectorAll('.modal-overlay').forEach(o=>{
  o.addEventListener('click',e=>{ if(e.target===o) o.classList.remove('open') });
});

// ── API ────────────────────────────────────────────────────────────
async function api(method, path, body){
  const opts={method,headers:{'Content-Type':'application/json',...(token?{'Authorization':'Bearer '+token}:{})},credentials:'include'};
  if(body) opts.body=JSON.stringify(body);
  const r=await fetch(API+path,opts);
  const data=await r.json();
  if(!r.ok) throw new Error(data.error||'Errore server');
  return data;
}

// ── NAVIGATION ─────────────────────────────────────────────────────
function showLanding(){ document.title = DOC_TITLE_PUBLIC; _s('landing');_h('auth');_h('app') }
function showAuth(tab='login'){ document.title = DOC_TITLE_PUBLIC; _h('landing');_s('auth');_h('app'); switchAuthTab(tab) }
async function showApp(){
  document.title = DOC_TITLE_APP;
  _h('landing');_h('auth');_s('app');
  await refreshCurrentUser();
  applyPermissions();
  loadBacheca();
  startBachecaPolling();
  startChatBadgePolling();
}
function _s(id){ document.getElementById(id).classList.remove('hidden') }
function _h(id){ document.getElementById(id).classList.add('hidden') }

// ── BADGE MESSAGGI NON LETTI ──────────────────────────────────────
// Logica: salviamo in localStorage il created_at (ISO string) dell'ultimo
// messaggio che l'utente ha visto aprendo la pagina Comunicazioni.
// Ogni 12s controlliamo quanti messaggi hanno created_at più recente di quel valore.

function chatGetSavedTs(){ return localStorage.getItem('au-chat-ts') || '' }
function chatSaveTs(ts){ if(ts) localStorage.setItem('au-chat-ts', ts) }

function chatSetBadge(n){
  document.querySelectorAll('.chat-unread-badge').forEach(el => {
    if(n > 0){
      el.textContent = n > 99 ? '99+' : String(n);
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  });
}

async function chatCheckUnread(){
  if(!token) return;
  // Se comunicazioni è già aperta non serve contare
  const pg = document.getElementById('page-comunicazioni');
  if(pg && pg.classList.contains('active')){ chatSetBadge(0); return; }
  try {
    const msgs = await api('GET', '/api/comunicazioni/chat');
    if(!msgs || !msgs.length){ chatSetBadge(0); return; }
    const savedTs = chatGetSavedTs();
    if(!savedTs){
      // Prima volta: salviamo subito l'ultimo ts così non esplodono le notifiche
      chatSaveTs(msgs[msgs.length-1].created_at || '');
      chatSetBadge(0);
      return;
    }
    const unread = msgs.filter(m => (m.created_at || '') > savedTs).length;
    chatSetBadge(unread);
  } catch(e){ /* silenzioso */ }
}

function startChatBadgePolling(){
  stopChatBadgePolling();
  chatCheckUnread();                                         // subito al login
  chatBadgeInterval = setInterval(chatCheckUnread, 12000);  // poi ogni 12s
}
function stopChatBadgePolling(){
  if(chatBadgeInterval){ clearInterval(chatBadgeInterval); chatBadgeInterval = null; }
}
// ─────────────────────────────────────────────────────────────────

// Pagine che restano dentro lo schedario "2 Compagnia" (finanze è passata a Strumenti)
const COMPAGNIA_PAGES = ['comunicazioni','liste','calendario','voti'];

async function showPage(id, link){
  // Permessi sempre freschi dal server prima di decidere cosa mostrare
  await refreshCurrentUser();
  // Blocco accesso sezione 2 Compagnia per utenti non autorizzati
  if(COMPAGNIA_PAGES.includes(id) && !currentUser?.is_admin && !currentUser?.can_access_2compagnia){
    toast('Non hai i permessi per accedere a questa sezione','err');
    return;
  }
  // Strumenti: la voce è visibile a tutti, ma senza permesso si apre la
  // schermata dedicata di blocco invece dello strumento vero e proprio.
  const toolForPage = TOOLS.find(t => t.page === id);
  if(toolForPage && !canUseTool(toolForPage)){
    showToolLocked(toolForPage, link);
    return;
  }
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.sb-link').forEach(a=>a.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  if(link && link.isConnected) link.classList.add('active');
  if(toolForPage) markToolNavActive(toolForPage.key);
  const st = SECTION_DOC_TITLES[id];
  if(st) document.title = st+' · '+DOC_TITLE_APP;
  // Se l'utente apre comunicazioni: azzera badge e aggiorna ts salvato
  if(id === 'comunicazioni'){
    chatSetBadge(0);
    try {
      const msgs = await api('GET', '/api/comunicazioni/chat');
      if(msgs && msgs.length) chatSaveTs(msgs[msgs.length-1].created_at || '');
    } catch(e){}
  }
  if(id==='strumenti')      renderToolsGrid();
  if(id==='finanze')        loadFinanze();
  if(id==='voti')           loadVoti();
  if(id==='liste')          loadListe();
  if(id==='admin')          loadAdminUsers();
  if(id==='comunicazioni')  loadComunicazioni();
  if(id==='calendario')    loadCalendario();
  if(id==='profilo')        loadProfile();
}

// Ricarica currentUser dal server (permessi sempre freschi, nessun re-login)
async function refreshCurrentUser(){
  try {
    const data = await api('GET','/api/auth/me');
    currentUser = data;
    if(data.token){ token=data.token; localStorage.setItem('jwt',token); }
    applyPermissions();
  } catch(e){}
}

function applyPermissions(){
  if(!currentUser) return;
  const isAdmin = !!currentUser.is_admin;
  const has2Comp = isAdmin || !!currentUser.can_access_2compagnia;

  document.getElementById('sb-section-admin').style.display    = isAdmin  ? '' : 'none';
  document.getElementById('sb-nav-admin').style.display        = isAdmin  ? '' : 'none';
  document.getElementById('sb-section-compagnia').style.display = has2Comp ? '' : 'none';
  document.getElementById('sb-nav-compagnia').style.display     = has2Comp ? '' : 'none';

  // La sezione Strumenti è sempre visibile: cambia solo lo stato dei lucchetti
  renderToolsNav();

  const btnNew = document.getElementById('btnNewList');
  if(btnNew) btnNew.classList.remove('hidden');
  document.getElementById('sbUserName').textContent = currentUser.full_name||currentUser.username;
  document.getElementById('sbUserRank').textContent = currentUser.military_rank||'AU';
  const rbEl = document.getElementById('sbUserRole');
  if(rbEl) rbEl.innerHTML = roleBadge(currentUser.role, isAdmin);
}

// ── SEZIONE STRUMENTI ──────────────────────────────────────────────
// Tutti gli strumenti sono elencati a tutti gli utenti: chi non ha il permesso
// li vede comunque e, aprendoli, riceve una schermata di blocco dedicata.
function renderToolsNav(){
  const html = TOOLS.map(t => {
    const locked = !canUseTool(t);
    return `<a class="sb-link${locked?' sb-link-locked':''}" data-tool="${t.key}"
      onclick="openTool('${t.key}',this)" title="${locked?'Strumento non sbloccato':t.label}">
      <span class="sb-icon">${t.icon}</span>${escHtml(t.label)}${locked?' 🔒':''}</a>`;
  }).join('');
  const indice = `<a class="sb-link" onclick="showPage('strumenti',this)"><span class="sb-icon">🧰</span>Tutti gli Strumenti</a>`;
  ['sb-nav-strumenti','drawer-nav-strumenti'].forEach(id => {
    const nav = document.getElementById(id);
    if(!nav) return;
    nav.innerHTML = indice + html;
    if(id === 'drawer-nav-strumenti'){
      nav.querySelectorAll('a').forEach(a => a.addEventListener('click', closeDrawer));
    }
  });
}

function renderToolsGrid(){
  const grid = document.getElementById('toolsGrid');
  if(!grid) return;
  grid.innerHTML = TOOLS.map(t => {
    const ok = canUseTool(t);
    return `<div class="tool-card${ok?'':' tool-locked'}" onclick="openTool('${t.key}',null)">
      <div class="tool-card-icon">${ok?t.icon:'🔒'}</div>
      <div class="tool-card-name">${escHtml(t.label)}</div>
      <div class="tool-card-desc">${escHtml(t.desc)}</div>
      <div class="tool-card-state ${ok?'tool-state-on':'tool-state-off'}">${ok?'✓ Sbloccato':'🔒 Non sbloccato'}</div>
    </div>`;
  }).join('') || '<div style="color:var(--text3);font-family:var(--font-mono);font-size:.72rem;padding:1rem">Nessuno strumento disponibile.</div>';
}

// La nav Strumenti viene rigenerata a ogni refresh permessi: il riferimento al
// link cliccato può risultare staccato dal DOM, quindi l'evidenziazione va
// riapplicata cercando la voce per chiave.
function markToolNavActive(key){
  document.querySelectorAll('.sb-link').forEach(a=>a.classList.remove('active'));
  document.querySelectorAll(`.sb-link[data-tool="${key}"]`).forEach(a=>a.classList.add('active'));
}

function openTool(key, link){
  const t = getTool(key);
  if(!t){ toast('Strumento non trovato','err'); return Promise.resolve(); }
  return showPage(t.page, link);   // il gate su showPage devia sulla schermata di blocco
}

// Schermata dedicata: spiega che lo strumento non è sbloccato per questo utente
function showToolLocked(tool, link){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.sb-link').forEach(a=>a.classList.remove('active'));
  document.getElementById('page-strumento-locked').classList.add('active');
  if(link && link.isConnected) link.classList.add('active');
  markToolNavActive(tool.key);
  document.title = 'Strumento bloccato · '+DOC_TITLE_APP;
  document.getElementById('tl-breadcrumb').textContent = 'Strumenti · '+tool.label;
  document.getElementById('tl-icon').textContent = tool.icon;
  document.getElementById('tl-title').textContent = tool.label+' — non sbloccato';
  document.getElementById('tl-desc').innerHTML =
    `Lo strumento <strong>${escHtml(tool.label)}</strong> non è stato sbloccato per il tuo account.<br>`+
    `${escHtml(tool.desc)}<br><br>`+
    `Per ottenere l'accesso contatta un <strong>amministratore</strong>: potrà abilitarlo dalla gestione permessi.`;
  renderToolsGrid();
}

// ── AUTH ───────────────────────────────────────────────────────────
function switchAuthTab(tab){
  const isLogin=tab==='login';
  document.getElementById('formLogin').classList.toggle('hidden',!isLogin);
  document.getElementById('formRegister').classList.toggle('hidden',isLogin);
  document.getElementById('tabLogin').classList.toggle('active',isLogin);
  document.getElementById('tabRegister').classList.toggle('active',!isLogin);
  document.getElementById('authError').style.display='none';
}
async function doLogin(){
  const username=document.getElementById('loginUser').value.trim();
  const password=document.getElementById('loginPass').value;
  if(!username||!password){ showAuthError('Inserisci username e password'); return }
  try {
    const data=await api('POST','/api/auth/login',{username,password});
    token=data.token; localStorage.setItem('jwt',token); currentUser=data.user;
    await showApp(); toast('Benvenuto, '+(currentUser.full_name||currentUser.username));
  } catch(e){ showAuthError(e.message) }
}
async function doRegister(){
  const username = document.getElementById('regUser').value.trim();
  const email    = document.getElementById('regEmail').value.trim();
  const nome     = document.getElementById('regNome').value.trim();
  const cognome  = document.getElementById('regCognome').value.trim();
  const password = document.getElementById('regPass').value;
  const password2= document.getElementById('regPass2').value;
  if(!username||!email||!nome||!cognome||!password){ showAuthError('Compila tutti i campi obbligatori'); return }
  if(password!==password2){ showAuthError('Le password non coincidono'); return }
  if(password.length<6){ showAuthError('Password troppo corta (min 6 caratteri)'); return }
  try {
    await api('POST','/api/auth/register',{username,email,password,nome,cognome});
    toast('Account creato! Ora accedi.','info');
    switchAuthTab('login');
    document.getElementById('loginUser').value=username;
  } catch(e){ showAuthError(e.message) }
}
function showAuthError(msg){ const el=document.getElementById('authError');el.textContent='⚠ '+msg;el.style.display='block' }
async function doLogout(){ try{ fetch('/api/auth/logout',{method:'POST',credentials:'include'}) }catch(e){} token='';localStorage.removeItem('jwt');currentUser=null;stopBachecaPolling();stopChatBadgePolling();showLanding() }
async function tryAutoLogin(){
  if(!token) return;
  try {
    const data=await api('GET','/api/auth/me');
    currentUser=data;
    if(data.token){ token=data.token; localStorage.setItem('jwt',token); }
    await showApp();
  } catch { token='';localStorage.removeItem('jwt');showLanding() }
}
// ── PROFILO ────────────────────────────────────────────────────────
async function loadProfile(){
  if(!currentUser) return;
  document.getElementById('prof-avatar').textContent = getInitials(currentUser.full_name||currentUser.username);
  document.getElementById('prof-username').textContent = '@'+currentUser.username;
  document.getElementById('prof-email').textContent = currentUser.email||'—';
  document.getElementById('prof-role-badge').innerHTML = roleBadge(currentUser.role, currentUser.is_admin) ||
    '<span class="role-badge role-none">Allievo</span>';
  document.getElementById('prof-nome').value     = currentUser.nome||'';
  document.getElementById('prof-cognome').value  = currentUser.cognome||'';
  document.getElementById('prof-rank-display').textContent = currentUser.military_rank||'AU';
  document.getElementById('prof-platoon').value  = currentUser.platoon||'';
  document.getElementById('prof-year').value     = currentUser.academic_year||'1° Anno';
  const has2c = userHasPerm('can_access_2compagnia');
  document.getElementById('prof-perm-2comp').textContent  = has2c ? '✓ Abilitato' : '✗ Non abilitato';
  document.getElementById('prof-perm-2comp').className    = 'perm-indicator '+(has2c?'perm-ok':'perm-no');
  const hasFin = userHasPerm('can_access_finance');
  document.getElementById('prof-perm-finance').textContent = hasFin ? '✓ Sbloccato' : '✗ Non sbloccato';
  document.getElementById('prof-perm-finance').className   = 'perm-indicator '+(hasFin?'perm-ok':'perm-no');
  document.getElementById('prof-perm-grades').textContent  = currentUser.can_access_grades ? '✓ Abilitato' : '✗ Non abilitato';
  document.getElementById('prof-perm-grades').className    = 'perm-indicator '+(currentUser.can_access_grades?'perm-ok':'perm-no');
  document.getElementById('prof-perm-com').textContent     = canWriteCom() ? '✓ Abilitato' : '✗ Solo lettura';
  document.getElementById('prof-perm-com').className       = 'perm-indicator '+(canWriteCom()?'perm-ok':'perm-no');
}

async function saveProfile(){
  const nome          = document.getElementById('prof-nome').value.trim();
  const cognome       = document.getElementById('prof-cognome').value.trim();
  const platoon       = document.getElementById('prof-platoon').value.trim();
  const academic_year = document.getElementById('prof-year').value;
  if(!nome || !cognome){ toast('Nome e cognome obbligatori','err'); return; }
  try {
    await api('PUT','/api/profile',{nome,cognome,platoon,academic_year});
    const full_name = `${nome} ${cognome}`;
    Object.assign(currentUser, {nome,cognome,full_name,platoon,academic_year});
    applyPermissions();
    toast('Profilo aggiornato');
  } catch(e){ toast(e.message,'err') }
}

// ── BACHECA + POLLING ──────────────────────────────────────────────
function startBachecaPolling(){
  stopBachecaPolling();
  bachecaInterval=setInterval(async()=>{
    if(document.getElementById('page-bacheca').classList.contains('active')){
      try { const posts=await api('GET','/api/announcements'); renderFeed(posts) } catch {}
    }
  },15000);
}
function stopBachecaPolling(){ if(bachecaInterval){ clearInterval(bachecaInterval); bachecaInterval=null } }
 
async function loadBacheca(){
  try { renderFeed(await api('GET','/api/announcements')) } catch(e){ toast(e.message,'err') }
}
function renderFeed(posts){
  const feed=document.getElementById('feedList');
  if(!posts.length){ feed.innerHTML='<div style="text-align:center;padding:3rem;color:var(--text3);font-family:var(--font-mono);font-size:.72rem">Nessun annuncio. Sii il primo a pubblicare!</div>'; return }
  feed.innerHTML=posts.map(p=>`
    <div class="post-card">
      <div class="post-author">
        <span>⚔</span>
        <span>${p.military_rank?p.military_rank+' ':''}<strong>${escHtml(p.full_name||p.username)}</strong></span>
        ${roleBadge(p.role, p.is_admin)}
        <span class="post-rank">@${escHtml(p.username)}</span>
        <span class="post-time">${fmtDate(p.created_at?.slice(0,10))}</span>
      </div>
      <div class="post-content">${escHtml(p.content)}</div>
      ${(currentUser&&(p.author_id===currentUser.id||currentUser.is_admin))?`
        <div class="post-actions"><button class="btn btn-sm btn-red" onclick="deletePost(${p.id})">🗑 Elimina</button></div>`:''
      }
    </div>`).join('');
}
async function postAnnouncement(){
  const content=document.getElementById('postContent').value.trim();
  if(!content){ toast('Scrivi un messaggio','err'); return }
  try {
    await api('POST','/api/announcements',{content});
    document.getElementById('postContent').value='';
    toast('Annuncio pubblicato');
    loadBacheca();
  } catch(e){ toast(e.message,'err') }
}
async function deletePost(id){
  if(!confirm('Eliminare questo annuncio?')) return;
  try { await api('DELETE','/api/announcements/'+id); loadBacheca(); toast('Eliminato') }
  catch(e){ toast(e.message,'err') }
}
// ── COMUNICAZIONI ──────────────────────────────────────────────────
function startComPolling(){
  stopComPolling();
  comChatInterval = setInterval(async()=>{
    if(document.getElementById('page-comunicazioni').classList.contains('active') && currentComTab==='chat'){
      try {
        const msgs = await api('GET','/api/comunicazioni/chat');
        const prevLast = comChatMessages.length ? (comChatMessages[comChatMessages.length-1].created_at||'') : '';
        const newLast = msgs.length ? (msgs[msgs.length-1].created_at||'') : '';
        const changed = comChatMessages.length !== msgs.length || prevLast !== newLast;
        comChatMessages = msgs;
        renderComChat(msgs, changed);
      } catch {}
    }
  }, 3500);
}
function stopComPolling(){ if(comChatInterval){ clearInterval(comChatInterval); comChatInterval=null } }
 
async function loadComunicazioni(){
  startComPolling();
  switchComTab(currentComTab);
}
 
function switchComTab(tab, btn){
  currentComTab = tab;
  document.querySelectorAll('.com-tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.com-tab-btn').forEach(b=>b.classList.remove('active'));
  const panel = document.getElementById('com-'+tab);
  if(panel) panel.classList.add('active');
  // Se btn non è passato (chiamata programmatica), trova il bottone giusto dal DOM
  const activeBtn = btn || document.querySelector(`.com-tab-btn[data-tab="${tab}"]`);
  if(activeBtn) activeBtn.classList.add('active');
  if(tab==='chat')      loadComChat();
  if(tab==='ufficiali') loadComPosts();
}
 
async function loadComChat(){
  try {
    const msgs = await api('GET','/api/comunicazioni/chat');
    comChatMessages = msgs;
    renderComChat(msgs, true);
  } catch(e){ toast(e.message,'err') }
}
 
function renderComChat(msgs, scrollToBottom=false){
  const container = document.getElementById('chatMessages');
  if(!container) return;
 
  if(!msgs.length){
    container.innerHTML='<div class="chat-empty">Nessun messaggio. '+(canWriteCom()?'Scrivi il primo!':'Solo i ruoli autorizzati possono scrivere.')+'</div>';
    return;
  }
 
  let lastDate = null;
  container.innerHTML = msgs.map(m=>{
    const isOwn = currentUser && m.author_id === currentUser.id;
    const msgDate = m.created_at ? new Date(m.created_at).toLocaleDateString('it-IT') : '';
    let dateSep = '';
    if(msgDate !== lastDate){
      lastDate = msgDate;
      dateSep = `<div class="chat-date-sep"><span>${msgDate}</span></div>`;
    }
    const initials = getInitials(m.full_name||m.username);
    const canDel = currentUser && (m.author_id===currentUser.id || currentUser.is_admin);
    return `${dateSep}
    <div class="chat-row ${isOwn?'chat-row-own':''}">
      ${!isOwn?`<div class="chat-avatar">${escHtml(initials)}</div>`:''}
      <div class="chat-bubble-wrap">
        ${!isOwn?`<div class="chat-meta">${m.military_rank?escHtml(m.military_rank)+' ':''}<strong>${escHtml(m.full_name||m.username)}</strong> ${roleBadge(m.role,m.is_admin)}</div>`:''}
        <div class="chat-bubble ${isOwn?'chat-bubble-own':'chat-bubble-other'}">
          <span>${escHtml(m.content)}</span>
          ${canDel?`<button class="chat-del-btn" onclick="deleteComMsg('${m.id}')" title="Elimina">✕</button>`:''}
        </div>
        <div class="chat-time">${fmtTime(m.created_at)}</div>
      </div>
    </div>`;
  }).join('');
 
  if(scrollToBottom){
    container.scrollTop = container.scrollHeight;
  }
 
  // Mostra/nascondi input
  const inputArea = document.getElementById('chatInputArea');
  const lockedMsg = document.getElementById('chatLockedMsg');
  if(inputArea) inputArea.classList.toggle('hidden', !canWriteCom());
  if(lockedMsg) lockedMsg.classList.toggle('hidden', canWriteCom());
}
 
async function sendComMsg(){
  const input = document.getElementById('chatInput');
  const content = input.value.trim();
  if(!content) return;
  try {
    await api('POST','/api/comunicazioni/chat',{id:uid(),content});
    input.value = '';
    await loadComChat();
  } catch(e){ toast(e.message,'err') }
}
 
async function deleteComMsg(id){
  if(!confirm('Eliminare questo messaggio?')) return;
  try {
    await api('DELETE','/api/comunicazioni/chat/'+id);
    await loadComChat();
    toast('Messaggio eliminato');
  } catch(e){ toast(e.message,'err') }
}
 
async function loadComPosts(){
  try {
    const posts = await api('GET','/api/comunicazioni/posts');
    comPosts = posts;
    renderComPosts(posts);
  } catch(e){ toast(e.message,'err') }
}
 
function renderComPosts(posts){
  const el = document.getElementById('comPostsList');
  if(!el) return;
 
  // Mostra/nascondi pulsante nuovo comunicato
  const btnNew = document.getElementById('btnNewComPost');
  if(btnNew) btnNew.classList.toggle('hidden', !canWriteCom());
 
  if(!posts.length){
    el.innerHTML='<div style="text-align:center;padding:3rem;color:var(--text3);font-family:var(--font-mono);font-size:.72rem">Nessun comunicato ufficiale.</div>';
    return;
  }
 
  el.innerHTML = posts.map(p=>`
    <div class="com-post-card">
      <div class="com-post-header">
        <div>
          <div class="com-post-title">${escHtml(p.title||'Senza titolo')}</div>
          <div class="com-post-meta">
            <span>📅 ${fmtDateTime(p.created_at)}</span>
            <span>·</span>
            <span>${p.military_rank?escHtml(p.military_rank)+' ':''}<strong>${escHtml(p.full_name||p.username)}</strong></span>
            ${roleBadge(p.role,p.is_admin)}
          </div>
        </div>
        ${(currentUser&&(p.author_id===currentUser.id||currentUser.is_admin))?
          `<button class="btn btn-sm btn-red" onclick="deleteComPost('${p.id}')">🗑</button>`:''}
      </div>
      ${p.content?`<div class="com-post-content">${escHtml(p.content)}</div>`:''}
      ${p.file_name?`
        <div class="com-post-file">
          <span>📎 ${escHtml(p.file_name)}</span>
          <button class="btn btn-sm btn-gold" onclick="downloadComFile('${p.id}','${escHtml(p.file_name)}')">⬇ Scarica</button>
        </div>`:''
      }
    </div>`).join('');
}
 
function openComPostModal(){
  document.getElementById('comPostTitle').value='';
  document.getElementById('comPostContent').value='';
  document.getElementById('comPostFile').value='';
  document.getElementById('comFileInfo').textContent='';
  pendingComFile = null;
  openModal('comPostModal');
}
 
document.addEventListener('DOMContentLoaded', ()=>{
  const fileInput = document.getElementById('comPostFile');
  if(fileInput){
    fileInput.addEventListener('change', async (e)=>{
      const file = e.target.files[0];
      if(!file){ pendingComFile=null; document.getElementById('comFileInfo').textContent=''; return; }
      if(file.size > 5*1024*1024){ toast('File troppo grande (max 5MB)','err'); fileInput.value=''; return; }
      document.getElementById('comFileInfo').textContent='⏳ '+file.name;
      const reader = new FileReader();
      reader.onload = ev => {
        pendingComFile = {
          file_data: ev.target.result.split(',')[1],
          file_name: file.name,
          file_type: file.type
        };
        document.getElementById('comFileInfo').textContent='📎 '+file.name;
      };
      reader.readAsDataURL(file);
    });
  }
});
 
async function saveComPost(){
  const title   = document.getElementById('comPostTitle').value.trim();
  const content = document.getElementById('comPostContent').value.trim();
  if(!title && !content){ toast('Inserisci titolo o contenuto','err'); return; }
  try {
    const body = { id:uid(), title, content };
    if(pendingComFile) Object.assign(body, pendingComFile);
    await api('POST','/api/comunicazioni/posts', body);
    closeModal('comPostModal');
    toast('Comunicato pubblicato');
    await loadComPosts();
  } catch(e){ toast(e.message,'err') }
}
 
async function deleteComPost(id){
  if(!confirm('Eliminare questo comunicato?')) return;
  try {
    await api('DELETE','/api/comunicazioni/posts/'+id);
    toast('Comunicato eliminato');
    await loadComPosts();
  } catch(e){ toast(e.message,'err') }
}
 
async function downloadComFile(postId, fileName){
  try {
    const data = await api('GET','/api/comunicazioni/posts/'+postId+'/file');
    const link = document.createElement('a');
    link.href = 'data:'+data.file_type+';base64,'+data.file_data;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch(e){ toast(e.message,'err') }
}
 
// ── LISTE ──────────────────────────────────────────────────────────

async function loadListe(){
  try {
    allLists = await api('GET','/api/lists');
    // Se c'era una lista aperta, ricarica il dettaglio (con i signups)
    if(openListId){
      const detail = await api('GET','/api/lists/'+openListId);
      const idx = allLists.findIndex(l => l.id === openListId);
      if(idx >= 0) allLists[idx] = {...allLists[idx], ...detail, signup_count: detail.signups.length};
    }
    renderListContent();
    if(openListId) _applyOpenList();
  } catch(e){ toast(e.message,'err') }
}

function switchListTab(type, btn){
  currentListTab = type;
  openListId = null;
  document.querySelectorAll('#page-liste .tab-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  renderListContent();
}

function toggleAdminListPanel(){
  const p = document.getElementById('list-admin-panel');
  p.classList.toggle('hidden');
  if(!p.classList.contains('hidden')){
    document.getElementById('newListType').value = currentListTab;
    document.getElementById('newListDate').value = today();
    const ta = document.getElementById('newListCustomFields');
    if(ta) ta.value = '';
    updateNewListTypeUI();
  }
}

function updateNewListTypeUI(){
  const t = document.getElementById('newListType').value;
  const customSection = document.getElementById('newListCustomSection');
  if(customSection) customSection.classList.toggle('hidden', t !== 'custom');
}

async function createList(){
  const list_type          = document.getElementById('newListType').value;
  const list_date          = document.getElementById('newListDate').value;
  const notes              = document.getElementById('newListNotes').value.trim();
  const custom_name        = document.getElementById('newListCustomName')?.value.trim()  || '';
  const custom_fields      = (document.getElementById('newListCustomFields')?.value || '')
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if(!list_date){ toast('Seleziona una data','err'); return }
  if(list_type==='custom' && !custom_name){ toast('Inserisci il nome della lista','err'); return }
  try {
    await api('POST','/api/lists',{id:uid(),list_type,list_date,notes,custom_name,custom_fields});
    document.getElementById('list-admin-panel').classList.add('hidden');
    document.getElementById('newListNotes').value = '';
    if(document.getElementById('newListCustomName')) document.getElementById('newListCustomName').value = '';
    const ta = document.getElementById('newListCustomFields');
    if(ta) ta.value = '';
    toast('Lista creata');
    await loadListe();
  } catch(e){ toast(e.message,'err') }
}

async function deleteList(id){
  if(!confirm('Eliminare questa lista e tutte le iscrizioni?')) return;
  try {
    await api('DELETE','/api/lists/'+id);
    if(openListId===id) openListId=null;
    toast('Lista eliminata');
    await loadListe();
  } catch(e){ toast(e.message,'err') }
}

// ── render principale ──
function renderListContent(){
  const el = document.getElementById('list-content');
  const isAdmin = !!currentUser?.is_admin;

  let filtered;
  if(currentListTab === 'custom'){
    filtered = allLists.filter(l => l.list_type === 'custom');
  } else {
    filtered = allLists.filter(l => l.list_type === currentListTab);
  }

  if(!filtered.length){
    const hint = isAdmin ? ' — usa "Nuova Lista" per crearne una' : '.';
    el.innerHTML = `<div class="card" style="text-align:center;padding:3rem">
      <div style="font-size:2rem;margin-bottom:.8rem">📋</div>
      <div style="font-family:var(--font-display);font-size:1rem;color:var(--text2);margin-bottom:.4rem">${getListLabel(currentListTab)}</div>
      <div style="font-family:var(--font-mono);font-size:.72rem;color:var(--text3)">Nessuna lista creata per questa categoria${hint}</div>
    </div>`;
    return;
  }

  el.innerHTML = filtered.map(l => renderListCard(l, isAdmin)).join('');
  _applyOpenList();
}

function getListLabel(type, customName){
  if(type === 'custom') return customName || 'Lista Personalizzata';
  return LIST_LABELS[type] || type;
}

function renderListCard(l, isAdmin){
  const isParlatorio = l.list_type === 'parlatorio';
  const isMessa      = l.list_type === 'messa';
  const isCustom     = l.list_type === 'custom';
  const title        = isCustom ? (l.custom_name || 'Lista Personalizzata') : LIST_LABELS[l.list_type];
  const signups      = l.signups || [];
  const mySignup     = signups.find(s => s.user_id === currentUser?.id);
  const isSignedUp   = !!mySignup;
  const customLabels = parseListCustomFieldLabels(l);
  const fieldsHint   = customLabels.length ? customLabels.join(' · ') : '';

  return `<div class="list-card">
    <div class="list-card-header" onclick="toggleListCard('lbody-${l.id}')">
      <div>
        <div style="font-family:var(--font-display);font-size:.95rem;color:var(--text);letter-spacing:.06em">${escHtml(title)}</div>
        <div style="font-family:var(--font-mono);font-size:.72rem;color:var(--text2);margin-top:.25rem">
          📅 ${fmtDate(l.list_date)}${l.notes?` &nbsp;·&nbsp; <span style="color:var(--gold-hi,#e8c96a)">${escHtml(l.notes)}</span>`:''}
          ${isCustom&&fieldsHint?` &nbsp;·&nbsp; Campi: ${escHtml(fieldsHint)}`:''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:.8rem">
        <span class="badge badge-gold">${l.signup_count} iscritti</span>
        ${isAdmin?`<button class="btn btn-sm btn-red" onclick="event.stopPropagation();deleteList('${l.id}')">🗑</button>`:''}
        <span style="color:var(--text3);font-family:var(--font-mono)">▾</span>
      </div>
    </div>
    <div class="list-card-body" id="lbody-${l.id}">
      <div style="display:flex;gap:.6rem;margin-bottom:1rem;flex-wrap:wrap">
        ${renderSignupButton(l, isSignedUp, mySignup, isAdmin)}
      </div>
      ${isCustom&&customLabels.length?`<div class="alert alert-info" style="margin-bottom:.8rem">✏ Ogni allievo compila: <strong>${escHtml(customLabels.join(', '))}</strong></div>`:''}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem;flex-wrap:wrap;gap:.5rem">
        <div style="font-family:var(--font-mono);font-size:.65rem;color:var(--text3);letter-spacing:.12em;text-transform:uppercase">Iscritti (${l.signup_count})</div>
        ${l.signup_count>0?`<button class="btn btn-sm btn-green" onclick="event.stopPropagation();downloadListExcel('${l.id}')">⬇ Excel</button>`:''}
      </div>
      ${renderSignupRows(l, isAdmin)}
    </div>
  </div>`;
}

function renderSignupButton(l, isSignedUp, mySignup, isAdmin){
  const isParlatorio = l.list_type === 'parlatorio';
  const isMessa      = l.list_type === 'messa';
  const isCustom     = l.list_type === 'custom';

  if(!isSignedUp){
    if(isParlatorio)
      return `<button class="btn btn-gold" onclick="openParlatorioModal('${l.id}')">✋ Iscriviti (Parlatorio)</button>`;
    if(isMessa)
      return `<button class="btn btn-gold" onclick="openMessaModal('${l.id}')">✋ Iscriviti alla Messa</button>`;
    if(isCustom)
      return `<button class="btn btn-gold" onclick="openCustomSignupModal('${l.id}')">✋ Iscriviti</button>`;
    return `<button class="btn btn-gold" onclick="signupList('${l.id}')">✋ Iscriviti</button>`;
  }

  let extra = '';
  if(isParlatorio)
    extra = `<button class="btn btn-blue" onclick="openParlatorioModal('${l.id}',true)">👥 Gestisci parenti</button>`;

  return extra + `<button class="btn btn-red" onclick="unsignupList('${l.id}')">✗ Rimuovi iscrizione</button>`;
}

// ── FUNZIONI NOME ─────────────────────────────────────────────────
// Chiave di ordinamento: usa cognome direttamente
function getLastName(s){
  return (s.cognome||'').trim().toLowerCase() || (s.full_name||s.username||'').toLowerCase();
}

// Visualizzazione: "Cognome Nome" — uniforme per tutti
function displayName(s){
  const cog = (s.cognome||'').trim();
  const nom = (s.nome||'').trim();
  if(cog && nom) return `${cog} ${nom}`;
  if(cog)        return `${cog} ${(s.full_name||s.username||'').replace(cog,'').trim()}`.trim();
  return (s.full_name||s.username||'').trim();
}

// Per Excel: "Cognome Nome" senza gradi militari
function formatNameForList(s){
  const cog = (s.cognome||'').trim();
  const nom = (s.nome||'').trim();
  if(cog && nom) return `${cog} ${nom}`;
  if(cog)        return `${cog} ${(s.full_name||'').replace(cog,'').trim()}`.trim();
  return (s.full_name||s.username||'').trim();
}

// Scarica la lista come CSV apribile in Excel
function downloadListExcel(listId){
  const l = allLists.find(x => x.id === listId);
  if(!l){ toast('Lista non trovata','err'); return; }
  if(!l.signups || !l.signups.length){ toast('Nessun iscritto da scaricare','err'); return; }
  const title   = l.list_type==='custom' ? (l.custom_name||'Lista') : (LIST_LABELS[l.list_type]||l.list_type);
  const sorted  = [...l.signups].sort((a,b) =>
    getLastName(a).localeCompare(getLastName(b),'it',{sensitivity:'base'})
  );
  const isParlatorio = l.list_type === 'parlatorio';
  const isMessa      = l.list_type === 'messa';
  const isCustom     = l.list_type === 'custom';
  const customLabels = parseListCustomFieldLabels(l);
  let csv = '\uFEFF';
  if(isParlatorio)      csv += 'N°;Nominativo;Parenti\r\n';
  else if(isMessa)      csv += 'N°;Nominativo;Parente\r\n';
  else if(isCustom && customLabels.length){
    csv += 'N°;Nominativo;' + customLabels.map(lb => lb.replace(/;/g, ',')).join(';') + '\r\n';
  } else if(isCustom)   csv += 'N°;Nominativo;Nota\r\n';
  else                  csv += 'N°;Nominativo\r\n';
  sorted.forEach((s,i) => {
    const nome = formatNameForList(s);
    if(isParlatorio){
      const rels = (s.relatives||[]).map(r=>r.relative_name+(r.relative_relation?' ('+r.relative_relation+')':'')).join(' / ');
      csv += `${i+1};${csvEscCell(nome)};${csvEscCell(rels)}\r\n`;
    } else if(isMessa){
      const parente = s.relative_name ? s.relative_name+(s.relative_relation?' ('+s.relative_relation+')':'') : '';
      csv += `${i+1};${csvEscCell(nome)};${csvEscCell(parente)}\r\n`;
    } else if(isCustom && customLabels.length){
      const obj = parseCustomSignupNote(s.note) || {};
      const cols = customLabels.map(lb => csvEscCell(obj[lb] != null ? obj[lb] : ''));
      csv += `${i+1};${csvEscCell(nome)};${cols.join(';')}\r\n`;
    } else if(isCustom){
      const plain = parseCustomSignupNote(s.note) ? '' : (s.note || '');
      csv += `${i+1};${csvEscCell(nome)};${csvEscCell(plain)}\r\n`;
    } else {
      csv += `${i+1};${csvEscCell(nome)}\r\n`;
    }
  });
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${title}_${l.list_date||'lista'}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  toast('Lista scaricata ✓');
}

function renderSignupRows(l, isAdmin){
  // Ordina per cognome alfabeticamente
  const signups = [...(l.signups||[])].sort((a,b) =>
    getLastName(a).localeCompare(getLastName(b),'it',{sensitivity:'base'})
  );
  if(!signups.length) return '<div style="color:var(--text3);font-family:var(--font-mono);font-size:.72rem;padding:.5rem">Nessuno iscritto ancora.</div>';
  const isParlatorio = l.list_type === 'parlatorio';
  const isMessa      = l.list_type === 'messa';
  const isCustom     = l.list_type === 'custom';

  return signups.map((s,i) => {
    let detail = '';
    if(isCustom && s.note){
      const parsed = parseCustomSignupNote(s.note);
      if(parsed){
        detail = Object.keys(parsed).map(k =>
          `<div style="margin-left:.25rem;color:var(--text2);font-size:.72rem"><span style="color:var(--gold)">${escHtml(k)}:</span> ${escHtml(parsed[k])}</div>`
        ).join('');
      } else {
        detail = `<span style="color:var(--gold)">→ ${escHtml(s.note)}</span>`;
      }
    }
    if(isMessa && s.relative_name)
      detail = `<span style="color:var(--text2)">👥 ${escHtml(s.relative_name)}${s.relative_relation?' ('+escHtml(s.relative_relation)+')':''}</span>`;
    if(isParlatorio){
      const rels = s.relatives || [];
      if(rels.length){
        detail = `<div style="flex:0 0 100%;display:flex;flex-direction:column;gap:.15rem;padding:.25rem 0 .1rem 1.2rem">` +
          rels.map(r =>
            `<div style="color:var(--text2);font-size:.68rem">↳ <strong>${escHtml(r.relative_name)}</strong> (${escHtml(r.relative_relation||'—')})${r.relative_id_card?' &nbsp;·&nbsp; CI: <span style="color:var(--gold);font-family:var(--font-m)">' + escHtml(r.relative_id_card) + '</span>':''}</div>`
          ).join('') + `</div>`;
      }
    }

    return `<div class="signup-row" style="flex-wrap:wrap">
      <span style="color:var(--text3);width:22px">${i+1}.</span>
      <span style="color:var(--gold)">${s.military_rank?escHtml(s.military_rank)+' ':''}<strong>${escHtml(displayName(s))}</strong></span>
      ${detail}
      ${isAdmin?`<button class="btn btn-sm btn-red del-btn" onclick="removeSignup('${l.id}',${s.user_id})" style="margin-left:auto">✕</button>`:''}
    </div>`;
  }).join('');
}

// ── OPEN / CLOSE con stato ──
function _applyOpenList(){
  if(!openListId) return;
  const el = document.getElementById('lbody-'+openListId);
  if(el) el.classList.add('open');
}

async function loadListDetail(listId){
  try {
    const detail = await api('GET','/api/lists/'+listId);
    const idx = allLists.findIndex(l => l.id === listId);
    if(idx >= 0) allLists[idx] = {...allLists[idx], ...detail, signup_count: detail.signups.length};
    renderListContent();
    _applyOpenList();
  } catch(e){ toast(e.message,'err') }
}

function toggleListCard(id){
  const listId = id.replace('lbody-','');
  if(openListId === listId){
    openListId = null;
    const el = document.getElementById(id);
    if(el) el.classList.remove('open');
    return;
  }
  openListId = listId;
  const list = allLists.find(l => l.id === listId);
  if(list && !list.signups){
    loadListDetail(listId);
  } else {
    renderListContent();
    _applyOpenList();
  }
}

// ── ISCRIVITI ──
async function signupList(listId){
  try {
    await api('POST','/api/lists/'+listId+'/signup',{signup_id:uid()});
    toast('Iscritto!');
    openListId = listId;
    await loadListDetail(listId);
  } catch(e){ toast(e.message,'err') }
}

async function unsignupList(listId){
  if(!confirm('Rimuovere la tua iscrizione?')) return;
  try {
    await api('DELETE','/api/lists/'+listId+'/signup');
    toast('Iscrizione rimossa');
    openListId = listId;
    await loadListDetail(listId);
  } catch(e){ toast(e.message,'err') }
}

async function removeSignup(listId, userId){
  if(!confirm('Rimuovere questo iscritto?')) return;
  try {
    await api('DELETE','/api/lists/'+listId+'/signup/'+userId);
    toast('Iscritto rimosso');
    openListId = listId;
    await loadListDetail(listId);
  } catch(e){ toast(e.message,'err') }
}

// ── MESSA (iscrizione con parente opzionale) ──
function openMessaModal(listId){
  document.getElementById('messaListId').value = listId;
  document.getElementById('messaHasRelative').value = 'no';
  document.getElementById('messaRelativeFields').classList.add('hidden');
  document.getElementById('messaRelName').value    = '';
  document.getElementById('messaRelRelation').value= '';
  openModal('messaModal');
}
async function confirmMessaSignup(){
  const listId     = document.getElementById('messaListId').value;
  const hasRel     = document.getElementById('messaHasRelative').value === 'si';
  const rel_name   = document.getElementById('messaRelName').value.trim();
  const rel_rel    = document.getElementById('messaRelRelation').value.trim();
  if(hasRel && !rel_name){ toast('Inserisci il nome del parente','err'); return }
  try {
    await api('POST','/api/lists/'+listId+'/signup',{
      signup_id: uid(),
      relative_name:     hasRel ? rel_name : '',
      relative_relation: hasRel ? rel_rel  : ''
    });
    closeModal('messaModal');
    toast('Iscritto alla Messa!');
    openListId = listId;
    await loadListDetail(listId);
  } catch(e){ toast(e.message,'err') }
}

// ── LISTA PERSONALIZZATA (iscrizione con campi multipli) ──
let _customSignupListId = '';

function openCustomSignupModal(listId){
  _customSignupListId = listId;
  const list = allLists.find(l => l.id === listId);
  const labels = parseListCustomFieldLabels(list);
  const titleEl = document.getElementById('customSignupTitle');
  const introEl = document.getElementById('customSignupIntro');
  const host = document.getElementById('customSignupFieldsHost');
  if(titleEl) titleEl.textContent = '🎯 Iscrizione — ' + (list?.custom_name || 'Lista');
  if(introEl){
    introEl.classList.toggle('hidden', false);
    introEl.textContent = labels.length
      ? 'Compila tutti i campi richiesti dall\'organizzatore.'
      : 'Aggiungi una nota opzionale (lista senza campi strutturati).';
  }
  if(!host) return;
  if(labels.length){
    host.innerHTML = labels.map((lab, idx) => `
      <div class="form-group" style="margin-bottom:.65rem">
        <label>${escHtml(lab)} *</label>
        <input type="text" id="customFld_${idx}" placeholder="Inserisci…" autocomplete="off">
      </div>`).join('');
  } else {
    host.innerHTML = `
      <div class="form-group" style="margin-bottom:.8rem">
        <label>Nota (opzionale)</label>
        <textarea id="customSignupValueFree" rows="3" placeholder="Testo libero…"></textarea>
      </div>`;
  }
  openModal('customSignupModal');
}
async function confirmCustomSignup(){
  const list = allLists.find(l => l.id === _customSignupListId);
  const labels = parseListCustomFieldLabels(list);
  try {
    if(labels.length){
      const custom_values = {};
      for(let i = 0; i < labels.length; i++){
        const el = document.getElementById('customFld_'+i);
        const v = el ? el.value.trim() : '';
        if(!v){ toast('Compila: '+labels[i],'err'); return; }
        custom_values[labels[i]] = v;
      }
      await api('POST','/api/lists/'+_customSignupListId+'/signup',{signup_id:uid(), custom_values});
    } else {
      const note = document.getElementById('customSignupValueFree')?.value.trim() || '';
      await api('POST','/api/lists/'+_customSignupListId+'/signup',{signup_id:uid(), note: note || undefined});
    }
    closeModal('customSignupModal');
    toast('Iscritto!');
    openListId = _customSignupListId;
    await loadListDetail(_customSignupListId);
  } catch(e){ toast(e.message,'err') }
}

// ── PARLATORIO (multi-parente) ──
let _parlListId = '', _parlManage = false;
// Lista temporanea dei nuovi parenti da aggiungere
let _parlNewRelatives = [];

function openParlatorioModal(listId, manage=false){
  _parlListId     = listId;
  _parlManage     = manage;
  _parlNewRelatives = [];
  document.getElementById('parlatorioListId').value = listId;
  // Titolo
  document.getElementById('parlatorioModalTitle').textContent = manage ? '👥 Gestisci Parenti Parlatorio' : '👥 Iscrizione Parlatorio';
  // Sezione iscrizione (mostra solo se non già iscritto)
  const signupSection = document.getElementById('parlSignupSection');
  if(signupSection) signupSection.classList.toggle('hidden', manage);
  // Reset parenti
  renderParlNewRelatives();
  openModal('parlatorioModal');
}

function renderParlNewRelatives(){
  const el = document.getElementById('parlNewRelativesList');
  if(!el) return;
  if(!_parlNewRelatives.length){
    el.innerHTML = '<div style="color:var(--text3);font-family:var(--font-mono);font-size:.7rem;margin-bottom:.5rem">Nessun parente aggiunto. Premi + per aggiungere.</div>';
    return;
  }
  el.innerHTML = _parlNewRelatives.map((r,i)=>`
    <div style="display:flex;gap:.5rem;align-items:center;padding:.4rem 0;border-bottom:1px solid rgba(42,58,74,.4)">
      <span style="font-family:var(--font-mono);font-size:.72rem;color:var(--text)">${escHtml(r.name)} <span style="color:var(--text3)">(${escHtml(r.relation||'—')})</span>${r.id_card?'<span style="color:var(--text3)"> · CI: '+escHtml(r.id_card)+'</span>':''}</span>
      <button class="btn btn-sm btn-red" style="margin-left:auto" onclick="removeParlNewRelative(${i})">✕</button>
    </div>`).join('');
}

function addParlNewRelative(){
  const name    = document.getElementById('parlRelName').value.trim();
  const relation= document.getElementById('parlRelRelation').value.trim();
  const id_card = document.getElementById('parlRelIdCard').value.trim();
  if(!name){ toast('Inserisci il nome del parente','err'); return }
  _parlNewRelatives.push({name, relation, id_card});
  document.getElementById('parlRelName').value     = '';
  document.getElementById('parlRelRelation').value = '';
  document.getElementById('parlRelIdCard').value   = '';
  renderParlNewRelatives();
}

function removeParlNewRelative(i){
  _parlNewRelatives.splice(i,1);
  renderParlNewRelatives();
}

async function confirmParlatorioSignup(){
  try {
    // Step 1: Iscrivi (se non già iscritto)
    if(!_parlManage){
      await api('POST','/api/lists/'+_parlListId+'/signup',{signup_id:uid()});
    }
    // Step 2: Aggiungi tutti i parenti
    for(const r of _parlNewRelatives){
      await api('POST','/api/lists/'+_parlListId+'/relatives',{
        id: uid(),
        relative_name:     r.name,
        relative_relation: r.relation,
        relative_id_card:  r.id_card
      });
    }
    closeModal('parlatorioModal');
    toast(_parlManage ? 'Parenti aggiornati!' : 'Iscritto al parlatorio!');
    openListId = _parlListId;
    await loadListDetail(_parlListId);
  } catch(e){ toast(e.message,'err') }
}

// ── FINANZE ────────────────────────────────────────────────────────
const FIN_CATS={
  guadagno:['Stipendio','Freelance','Bonus','Altro'],
  spesa:['Casa','Alimentari','Trasporti','Abbonamenti','Salute','Ristoranti','Vestiario','Svago','Altro'],
  investimento:['ETF','Azioni','Obbligazioni','Criptovalute','Immobiliare','Altro'],
  ricavo:['Cedola','Dividendo','Affitto','Altro']
};
async function loadFinanze(){
  const locked=!currentUser?.can_access_finance&&!currentUser?.is_admin;
  document.getElementById('fin-locked').classList.toggle('hidden',!locked);
  document.getElementById('fin-content').classList.toggle('hidden',locked);
  if(locked) return;
  try { transactions=await api('GET','/api/finance'); refreshFinanze() } catch(e){ toast(e.message,'err') }
}
function refreshFinanze(){ computeFinKPI(); drawFinCharts(); renderFinTx() }
function computeFinKPI(){
  const now=new Date(),m=now.getMonth()+1,y=now.getFullYear();
  const mx=transactions.filter(t=>{ const d=new Date(t.date); return d.getMonth()+1===m&&d.getFullYear()===y });
  const totM=v=>mx.filter(t=>t.type===v).reduce((s,t)=>s+Number(t.amount),0);
  const tot=v=>transactions.filter(t=>t.type===v).reduce((s,t)=>s+Number(t.amount),0);
  const patrimonio=transactions.reduce((s,t)=>t.type==='guadagno'||t.type==='ricavo'?s+Number(t.amount):t.type==='spesa'?s-Number(t.amount):s,0);
  document.getElementById('f-patrimonio').textContent=fmtEur(patrimonio);
  document.getElementById('f-entrate').textContent=fmtEur(totM('guadagno')+totM('ricavo'));
  document.getElementById('f-uscite').textContent=fmtEur(totM('spesa'));
  document.getElementById('f-investimenti').textContent=fmtEur(tot('investimento'));
}
function getLast6Months(){
  const res=[];const now=new Date();
  for(let i=5;i>=0;i--){ const d=new Date(now.getFullYear(),now.getMonth()-i,1);res.push({m:d.getMonth()+1,y:d.getFullYear(),label:d.toLocaleDateString('it-IT',{month:'short',year:'2-digit'})}) }
  return res;
}
function drawFinCharts(){
  const months=getLast6Months(),labels=months.map(x=>x.label);
  function mf(type,m,y){ return transactions.filter(t=>t.type===type&&new Date(t.date).getMonth()+1===m&&new Date(t.date).getFullYear()===y).reduce((s,t)=>s+Number(t.amount),0) }
  const entrate=months.map(({m,y})=>mf('guadagno',m,y)+mf('ricavo',m,y));
  const uscite=months.map(({m,y})=>mf('spesa',m,y));
  const chartBase={responsive:true,maintainAspectRatio:true,plugins:{legend:{display:false}},scales:{x:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#4a5a6a',font:{size:10}}},y:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#4a5a6a',font:{size:10},callback:v=>'€'+v}}}};
  const bCtx=document.getElementById('finBarChart').getContext('2d');
  if(finBarChart) finBarChart.destroy();
  finBarChart=new Chart(bCtx,{type:'bar',data:{labels,datasets:[{label:'Entrate',data:entrate,backgroundColor:'rgba(45,122,79,.65)',borderRadius:4,borderSkipped:false},{label:'Uscite',data:uscite,backgroundColor:'rgba(139,46,46,.65)',borderRadius:4,borderSkipped:false}]},options:{...chartBase,plugins:{legend:{display:true,labels:{color:'#8a9ab0',font:{size:10}}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+': '+fmtEur(ctx.parsed.y)}}}}});
  const g=transactions.filter(t=>t.type==='guadagno').reduce((s,t)=>s+Number(t.amount),0);
  const sp=transactions.filter(t=>t.type==='spesa').reduce((s,t)=>s+Number(t.amount),0);
  const inv=transactions.filter(t=>t.type==='investimento').reduce((s,t)=>s+Number(t.amount),0);
  const rv=transactions.filter(t=>t.type==='ricavo').reduce((s,t)=>s+Number(t.amount),0);
  const dCtx=document.getElementById('finDonutChart').getContext('2d');
  if(finDonutChart) finDonutChart.destroy();
  finDonutChart=new Chart(dCtx,{type:'doughnut',data:{labels:['Guadagni','Spese','Investimenti','Ricavi'],datasets:[{data:[g,sp,inv,rv],backgroundColor:['rgba(45,122,79,.8)','rgba(139,46,46,.8)','rgba(42,95,168,.8)','rgba(184,115,51,.8)'],borderColor:'#111820',borderWidth:2,hoverOffset:4}]},options:{responsive:true,maintainAspectRatio:true,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.label+': '+fmtEur(ctx.parsed)}}},cutout:'60%'}});
}
function renderFinTx(){
  const q=(document.getElementById('finSearch')?.value||'').toLowerCase();
  let list=[...transactions].sort((a,b)=>new Date(b.date)-new Date(a.date));
  if(txFilter!=='all') list=list.filter(t=>t.type===txFilter);
  if(q) list=list.filter(t=>(t.desc||'').toLowerCase().includes(q)||(t.cat||'').toLowerCase().includes(q)||(t.note||'').toLowerCase().includes(q));
  const tbody=document.getElementById('finTxBody');
  document.getElementById('finEmpty').classList.toggle('hidden',list.length>0);
  tbody.innerHTML=list.map(t=>`
    <tr>
      <td>${fmtDate(t.date)}</td>
      <td style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.desc)}</td>
      <td><span class="tx-type-badge type-${t.type}">${{guadagno:'💵 Guadagno',spesa:'🛒 Spesa',investimento:'📈 Investimento',ricavo:'💸 Ricavo'}[t.type]}</span></td>
      <td style="color:var(--text3)">${t.cat||'—'}</td>
      <td style="color:var(--text3);max-width:100px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.note||'—'}</td>
      <td><span class="${{guadagno:'amount-pos',spesa:'amount-neg',investimento:'amount-blue',ricavo:'amount-amber'}[t.type]}" style="font-family:var(--font-mono)">${{guadagno:'+',ricavo:'+',spesa:'−',investimento:''}[t.type]}${fmtEur(t.amount)}</span></td>
      <td><button class="btn btn-sm del-btn" onclick="editTx('${t.id}')">✏</button><button class="btn btn-sm btn-red del-btn" onclick="deleteTx('${t.id}')">🗑</button></td>
    </tr>`).join('');
}
function setFinFilter(f,btn){ txFilter=f; document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); renderFinTx() }
function openTxModal(id=null){
  editingTxId=id;
  const t=id?transactions.find(x=>x.id===id):null;
  document.getElementById('txModalTitle').textContent=id?'Modifica Transazione':'Nuova Transazione';
  selectTxType(t?t.type:'guadagno');
  document.getElementById('tx-desc').value=t?t.desc:'';
  document.getElementById('tx-amount').value=t?t.amount:'';
  document.getElementById('tx-date').value=t?t.date:today();
  document.getElementById('tx-note').value=t?t.note:'';
  setTimeout(()=>{ if(t)document.getElementById('tx-cat').value=t.cat },10);
  openModal('txModal');
}
function closeTxModal(){ closeModal('txModal'); editingTxId=null }
function selectTxType(type){
  currentTxType=type;
  ['guadagno','spesa','investimento','ricavo'].forEach(t=>{
    const el=document.getElementById('opt-'+t);
    el.className='type-opt'+(t===type?' sel-'+(t==='guadagno'?'g':t==='spesa'?'s':t==='investimento'?'i':'r'):'');
  });
  document.getElementById('tx-cat').innerHTML=(FIN_CATS[type]||[]).map(c=>`<option>${c}</option>`).join('');
}
async function saveTx(){
  const desc=document.getElementById('tx-desc').value.trim();
  const amount=parseFloat(document.getElementById('tx-amount').value);
  const date=document.getElementById('tx-date').value;
  const cat=document.getElementById('tx-cat').value;
  const note=document.getElementById('tx-note').value.trim();
  if(!desc||!amount||!date){ toast('Compila tutti i campi obbligatori','err'); return }
  try {
    if(editingTxId){
      await api('PUT','/api/finance/'+editingTxId,{type:currentTxType,desc,amount,date,cat,note});
      toast('Transazione aggiornata');
    } else {
      await api('POST','/api/finance',{id:uid(),type:currentTxType,desc,amount,date,cat,note});
      toast('Transazione aggiunta');
    }
    closeTxModal(); loadFinanze();
  } catch(e){ toast(e.message,'err') }
}
function editTx(id){ openTxModal(id) }
async function deleteTx(id){
  if(!confirm('Eliminare questa transazione?')) return;
  try { await api('DELETE','/api/finance/'+id); loadFinanze(); toast('Eliminata') } catch(e){ toast(e.message,'err') }
}

// ── VOTI ───────────────────────────────────────────────────────────
async function loadVoti(){
  const locked=!currentUser?.can_access_grades&&!currentUser?.is_admin;
  document.getElementById('voti-locked').classList.toggle('hidden',!locked);
  document.getElementById('voti-content').classList.toggle('hidden',locked);
  if(locked) return;
  try {
    const data=await api('GET','/api/grades/all');
    vdb.subjects  = data.subjects  || {university:[],gym:[],military:[]};
    vdb.penalties = data.penalties || {consegna:[],rigore:[]};
    vdb.schedule  = data.schedule  || {};
    vdb.notes     = data.notes     || [];
    vdb.settings  = data.settings  || vdb.settings;
    if(data.cadet){
      document.getElementById('s-name').value    = data.cadet.name||'';
      document.getElementById('s-rank').value    = data.cadet.rank||'';
      document.getElementById('s-year').value    = data.cadet.year||'1° Anno';
      document.getElementById('s-platoon').value = data.cadet.platoon||'';
    }
    loadVotiSettings();
    refreshVoti();
  } catch(e){ toast(e.message,'err') }
}
function refreshVoti(){ renderSubjectAreaUni(); renderSubjectAreaGym(); renderSubjectAreaMil(); renderPunizioni(); renderSchedule(); renderNotes(); renderGraduatoria(); renderSubjectMgmt() }

// ── CALCOLI MEDIE ──────────────────────────────────────────────────
// Regole (rif. refactor registro voti):
//  1. Media Militare      = media aritmetica semplice fra materie militari e
//                           accertamenti universitari — gli accertamenti NON
//                           pesano per CFU anche se la materia ne ha di associati.
//  2. Media Universitaria = media ponderata per CFU dei soli Esami universitari:
//                           Σ(voto × CFU) / Σ(CFU).
//  3. Media Ginnica       = media delle prove di educazione fisica.
//  Media Finale = media aritmetica semplice delle tre medie sopra.
//  Le penalità restano registrabili e visibili ma NON entrano nel calcolo.

// Media aritmetica semplice di una lista di numeri
function meanOf(values){
  const v=(values||[]).filter(x=>x!=null&&!isNaN(x));
  if(!v.length) return null;
  return v.reduce((a,b)=>a+b,0)/v.length;
}
// Media aritmetica dei voti (nessun peso): usata per il voto di una materia
function arAvg(grades){ if(!grades||!grades.length) return null; return meanOf(grades.map(g=>Number(g.value))) }
// Media ponderata sui pesi del singolo voto — mantenuta per compatibilità
function wAvg(grades){
  if(!grades||!grades.length) return null;
  const t=grades.reduce((a,g)=>a+Number(g.value)*Number(g.weight||1),0);
  const w=grades.reduce((a,g)=>a+Number(g.weight||1),0);
  return w>0?t/w:null;
}
// Voto di una materia = media semplice dei suoi voti (di un dato tipo)
function subjAvg(s,gradeType){
  const gs=gradeType?(s.grades||[]).filter(g=>g.grade_type===gradeType):(s.grades||[]);
  return arAvg(gs);
}
function subjCredits(s){ const c=parseFloat(s.credits); return isNaN(c)?0:c }

// 2 · MEDIA UNIVERSITARIA — solo esami, ponderata per CFU della materia
function mediaUniversitaria(subjects){
  const subs=(subjects||vdb.subjects.university)
    .map(s=>({avg:subjAvg(s,'exam'), cfu:subjCredits(s)}))
    .filter(x=>x.avg!=null);
  if(!subs.length) return null;
  const totCfu=subs.reduce((a,x)=>a+x.cfu,0);
  // Se nessun CFU è valorizzato si degrada alla media semplice (retrocompatibilità)
  if(totCfu<=0) return meanOf(subs.map(x=>x.avg));
  const num=subs.reduce((a,x)=>a+x.avg*x.cfu,0);
  return num/totCfu;
}
// CFU effettivamente conteggiati nella media universitaria
function cfuConteggiati(subjects){
  return (subjects||vdb.subjects.university)
    .filter(s=>subjAvg(s,'exam')!=null)
    .reduce((a,s)=>a+subjCredits(s),0);
}
// Confronto: media aritmetica degli esami, ignorando i CFU
function mediaUniversitariaArit(subjects){
  return meanOf((subjects||vdb.subjects.university).map(s=>subjAvg(s,'exam')).filter(v=>v!=null));
}
// Media dei soli accertamenti universitari — peso uniforme, mai per CFU
function mediaAccertamentiUni(subjects){
  return meanOf((subjects||vdb.subjects.university).map(s=>subjAvg(s,'accertamento')).filter(v=>v!=null));
}
// Media delle sole materie militari — peso uniforme
function mediaMaterieMilitari(subjects){
  return meanOf((subjects||vdb.subjects.military).map(s=>subjAvg(s)).filter(v=>v!=null));
}
// 1 · MEDIA MILITARE — materie militari + accertamenti universitari, tutti con
// peso uniforme: ogni materia valutata conta esattamente una volta.
function mediaMilitare(){
  const vals=[];
  vdb.subjects.military.forEach(s=>{ const a=subjAvg(s); if(a!=null) vals.push(a) });
  vdb.subjects.university.forEach(s=>{ const a=subjAvg(s,'accertamento'); if(a!=null) vals.push(a) });
  return meanOf(vals);
}
// 3 · MEDIA GINNICA — media delle prove di educazione fisica
function mediaGinnica(subjects){
  return meanOf((subjects||vdb.subjects.gym).map(s=>subjAvg(s)).filter(v=>v!=null));
}
// MEDIA FINALE — media semplice delle tre medie di area disponibili.
// NB: non tiene conto dell'attitudine militare e non è influenzata dalle penalità.
function mediaFinale(mil,uni,gym){
  return meanOf([mil,uni,gym].filter(v=>v!=null));
}

// Le penalità restano calcolate e mostrate, ma non entrano più nel punteggio
function calcPenalties(){
  const rate=parseFloat(vdb.settings.pen_consegna_rate)||0.5;
  const c=vdb.penalties.consegna.reduce((a,p)=>a+p.days*rate,0);
  const r=vdb.penalties.rigore.reduce((a,p)=>a+3.5+p.days,0);
  return {consegnaPts:c,rigorePts:r,total:c+r};
}
function badgeGradeClass(v){ if(v>=27)return'badge-green'; if(v>=24)return'badge-gold'; if(v>=18)return'badge-amber'; return'badge-red' }

// GRADUATORIA
function renderGraduatoria(){
  const avgMil = mediaMilitare();
  const avgUni = mediaUniversitaria();
  const avgGym = mediaGinnica();
  const finalScore = mediaFinale(avgMil, avgUni, avgGym);   // penalità escluse
  const avgAccUni  = mediaAccertamentiUni();
  const avgMilSubj = mediaMaterieMilitari();
  const pen = calcPenalties();

  document.getElementById('g-media-mil').textContent = avgMil!=null ? fmt(avgMil) : '—';
  document.getElementById('g-media-uni').textContent = avgUni!=null ? fmt(avgUni) : '—';
  document.getElementById('g-media-gym').textContent = avgGym!=null ? fmt(avgGym) : '—';
  document.getElementById('g-final').textContent     = finalScore!=null ? fmt(finalScore) : '—';
  document.getElementById('g-penalties').textContent = fmt(pen.total);

  const allG=[];
  ['university','gym','military'].forEach(type=>{ vdb.subjects[type].forEach(s=>s.grades.forEach(g=>allG.push({...g,subjectName:s.name,stype:type}))) });
  document.getElementById('g-count-voti').textContent = allG.length;
  document.getElementById('g-count-cfu').textContent  = fmt(cfuConteggiati(),1);

  const presenti=[avgMil,avgUni,avgGym].filter(v=>v!=null).length;
  document.getElementById('g-formula-text').textContent =
    presenti ? `Media Finale = media semplice di ${presenti} ${presenti===1?'media':'medie'} di area su 3 · penalità escluse`
             : 'Nessun voto registrato';

  const maxVal=Math.max(avgMil||0,avgUni||0,avgGym||0,finalScore||0,1);
  const items=[
    {label:'Media Militare',        val:avgMil,     desc:'Materie militari + accertamenti uni — peso uniforme'},
    {label:'· Materie militari',    val:avgMilSubj, desc:'Componente della Media Militare'},
    {label:'· Accertamenti uni',    val:avgAccUni,  desc:'Componente della Media Militare — senza peso CFU'},
    {label:'Media Universitaria',   val:avgUni,     desc:'Soli esami universitari — Σ(voto × CFU) / Σ(CFU)'},
    {label:'Media Ginnica',         val:avgGym,     desc:'Prove di educazione fisica'},
    {label:'Media Finale',          val:finalScore, desc:'(Militare + Universitaria + Ginnica) / 3 — esclusa attitudine militare'}
  ].filter(x=>x.val!=null);
  document.getElementById('g-rank-detail').innerHTML=items.map(item=>`
    <div class="rank-row">
      <div style="width:190px;font-family:var(--font-mono);font-size:.8rem;color:var(--text2)">${item.label}</div>
      <div class="rank-bar-bg"><div class="rank-bar-fill" style="width:${(Math.abs(item.val)/maxVal*100).toFixed(1)}%"></div></div>
      <div style="width:65px;text-align:right;font-family:var(--font-mono);font-size:1rem;font-weight:600;color:var(--gold)">${fmt(item.val)}</div>
      <div style="font-family:var(--font-mono);font-size:.68rem;color:var(--text3);padding-left:.5rem">${item.desc}</div>
    </div>`).join('')||'<div style="color:var(--text3);padding:1rem;font-family:var(--font-mono);font-size:.72rem">Inserisci voti per visualizzare</div>';

  allG.sort((a,b)=>b.date>a.date?1:-1);
  document.getElementById('g-history').innerHTML=allG.length?`<table class="data-table"><thead><tr><th>Data</th><th>Materia</th><th>Area</th><th>Tipo</th><th>Voto</th><th>Descrizione</th></tr></thead><tbody>
  ${allG.map(g=>`<tr><td>${fmtDate(g.date)}</td><td>${escHtml(g.subjectName)}</td>
    <td><span class="badge badge-${g.stype==='university'?'gold':g.stype==='gym'?'blue':'green'}">${g.stype==='university'?'Uni':g.stype==='gym'?'Gin':'Mil'}</span></td>
    <td><span class="badge badge-${g.grade_type==='exam'?'gold':'purple'}">${g.stype==='gym'?'Es. Gin.':g.grade_type==='exam'?'Esame':'Accer.'}</span></td>
    <td><span class="badge ${badgeGradeClass(g.value)}">${g.value}</span></td>
    <td style="color:var(--text2)">${escHtml(g.description||'—')}</td></tr>`).join('')}
  </tbody></table>`:'<div style="color:var(--text3);padding:1rem;font-family:var(--font-mono);font-size:.72rem;text-align:center">Nessun voto</div>';
}

// RENDER TABLE VOTI
function buildGradeTable(grades,type){
  if(!grades.length) return '<div style="color:var(--text3);font-family:var(--font-mono);font-size:.7rem;padding:.4rem 0">Nessun voto inserito</div>';
  return `<table class="data-table"><thead><tr><th>Data</th><th>Voto</th><th>Peso</th><th>Descrizione</th><th></th></tr></thead><tbody>
  ${grades.map(g=>`<tr><td>${fmtDate(g.date)}</td><td><span class="badge ${badgeGradeClass(g.value)}">${g.value}</span></td><td style="color:var(--text3)">${g.weight}</td><td style="color:var(--text2)">${escHtml(g.description||'—')}</td><td><button class="btn btn-sm btn-red del-btn" onclick="deleteGrade('${g.id}','${type}')">✕</button></td></tr>`).join('')}
  </tbody></table>
  <div style="font-family:var(--font-mono);font-size:.65rem;color:var(--text2);padding:.5rem .3rem;display:flex;gap:1.5rem">
    <span>Media materia: <strong style="color:var(--gold)">${fmt(arAvg(grades))}</strong></span>
    <span style="color:var(--text3)">${grades.length} voto/i</span>
  </div>`;
}

// UNIVERSITÀ — esami + accertamenti separati per materia
function renderSubjectAreaUni(){
  const subjects=vdb.subjects.university;
  const pond=mediaUniversitaria(subjects), arit=mediaUniversitariaArit(subjects), acc=mediaAccertamentiUni(subjects);
  document.getElementById('u-weighted').textContent  = pond!=null?fmt(pond):'—';
  document.getElementById('u-arithmetic').textContent= arit!=null?fmt(arit):'—';
  document.getElementById('u-accert').textContent    = acc!=null?fmt(acc):'—';
  document.getElementById('u-list').innerHTML=subjects.length?subjects.map(s=>buildUniCard(s)).join(''):'<div style="color:var(--text3);font-family:var(--font-mono);font-size:.75rem;padding:1rem">Nessuna materia universitaria aggiunta.</div>';
}
function buildUniCard(s){
  const exams=s.grades.filter(g=>g.grade_type==='exam');
  const accerts=s.grades.filter(g=>g.grade_type==='accertamento');
  return `<div class="uni-subject-card">
    <div class="uni-subject-header">
      <div><div style="font-family:var(--font-display);font-size:.9rem;color:var(--text);letter-spacing:.05em">${escHtml(s.name)}</div><div style="font-family:var(--font-mono);font-size:.62rem;color:var(--text3);margin-top:.15rem">${s.credits} CFU — peso solo sugli esami</div></div>
      <div style="display:flex;gap:.6rem;font-family:var(--font-mono);font-size:.68rem;color:var(--text2)">
        <span>Esami: <strong style="color:var(--gold)">${exams.length?fmt(arAvg(exams)):'—'}</strong></span>
        <span style="color:var(--text3)">|</span>
        <span>Acc.: <strong style="color:var(--blue-light)">${accerts.length?fmt(arAvg(accerts)):'—'}</strong></span>
      </div>
    </div>
    <div class="uni-subject-section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <span style="font-family:var(--font-mono);font-size:.65rem;color:var(--gold);letter-spacing:.08em;text-transform:uppercase">📋 Esami (${exams.length})</span>
        <button class="btn btn-sm btn-gold" style="font-size:.58rem" onclick="openAddGradeModal('university','${s.id}','exam')">+ Esame</button>
      </div>
      ${buildGradeTable(exams,'university')}
    </div>
    <div class="uni-subject-section" style="border-top:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <span style="font-family:var(--font-mono);font-size:.65rem;color:var(--blue-light);letter-spacing:.08em;text-transform:uppercase">📝 Accertamenti (${accerts.length})</span>
        <button class="btn btn-sm btn-blue" style="font-size:.58rem" onclick="openAddGradeModal('university','${s.id}','accertamento')">+ Accertamento</button>
      </div>
      ${buildGradeTable(accerts,'university')}
    </div>
  </div>`;
}

// GINNASTICA — solo esami ginnici
function renderSubjectAreaGym(){
  const subjects=vdb.subjects.gym;
  const g=mediaGinnica(subjects);
  document.getElementById('gym-weighted').textContent = g!=null?fmt(g):'—';
  document.getElementById('gym-count').textContent    = subjects.reduce((a,s)=>a+(s.grades?s.grades.length:0),0);
  document.getElementById('gym-list').innerHTML=subjects.length?subjects.map(s=>`
    <div class="subject-section">
      <div class="subject-toggle" onclick="toggleSubject('${s.id}')">
        <div class="subject-toggle-name">${escHtml(s.name)}</div>
        <div class="subject-toggle-stats">
          <span>${s.grades.length} es. ginnico/i</span>
          <span style="color:var(--green-light)">${s.grades.length?fmt(arAvg(s.grades)):'—'}</span>
          <button class="btn btn-sm btn-green" style="font-size:.58rem" onclick="event.stopPropagation();openAddGradeModal('gym','${s.id}','exam')">+ Esame Gin.</button>
        </div>
      </div>
      <div class="subject-body" id="sbody-${s.id}">${buildGradeTable(s.grades,'gym')}</div>
    </div>`).join(''):'<div style="color:var(--text3);font-family:var(--font-mono);font-size:.75rem;padding:1rem">Nessuna disciplina ginnica aggiunta.</div>';
}

// MILITARE — solo accertamenti
function renderSubjectAreaMil(){
  const subjects=vdb.subjects.military;
  const propria=mediaMaterieMilitari(subjects), accUni=mediaAccertamentiUni(), totale=mediaMilitare();
  document.getElementById('mil-subjects').textContent    = propria!=null?fmt(propria):'—';
  document.getElementById('mil-accert-uni').textContent  = accUni!=null?fmt(accUni):'—';
  document.getElementById('mil-weighted').textContent    = totale!=null?fmt(totale):'—';
  document.getElementById('mil-list').innerHTML=subjects.length?subjects.map(s=>`
    <div class="subject-section">
      <div class="subject-toggle" onclick="toggleSubject('${s.id}')">
        <div class="subject-toggle-name">${escHtml(s.name)}</div>
        <div class="subject-toggle-stats">
          <span>${s.grades.length} accer.</span>
          <span style="color:var(--green-light)">${s.grades.length?fmt(arAvg(s.grades)):'—'}</span>
          <button class="btn btn-sm btn-green" style="font-size:.58rem" onclick="event.stopPropagation();openAddGradeModal('military','${s.id}','accertamento')">+ Accertamento</button>
        </div>
      </div>
      <div class="subject-body" id="sbody-${s.id}">${buildGradeTable(s.grades,'military')}</div>
    </div>`).join(''):'<div style="color:var(--text3);font-family:var(--font-mono);font-size:.75rem;padding:1rem">Nessuna materia militare aggiunta.</div>';
}

function toggleSubject(id){ const el=document.getElementById('sbody-'+id); if(el) el.classList.toggle('open') }

// MODALS VOTI
function openAddGradeModal(type,subjectId,gradeType){
  const s=vdb.subjects[type].find(x=>x.id===subjectId);
  document.getElementById('agType').value=type;
  document.getElementById('agSubjId').value=subjectId;
  document.getElementById('agGradeType').value=gradeType;
  const t={'university-exam':'Aggiungi Esame','university-accertamento':'Aggiungi Accertamento','gym-exam':'Aggiungi Esame Ginnico','military-accertamento':'Aggiungi Accertamento Militare'};
  document.getElementById('addGradeTitle').textContent=(t[type+'-'+gradeType]||'Aggiungi Voto')+' — '+s.name;
  document.getElementById('agValue').value='';
  document.getElementById('agWeight').value=s.credits||1;
  document.getElementById('agDate').value=today();
  document.getElementById('agDesc').value='';
  // Il peso resta memorizzato per lo storico ma non incide sulle medie:
  // i CFU che contano sono quelli della materia, e solo per gli esami uni.
  document.getElementById('agWeightLabel').textContent='Peso (solo archivio)';
  openModal('addGradeModal');
}
async function saveGrade(){
  const type=document.getElementById('agType').value;
  const subject_id=document.getElementById('agSubjId').value;
  const grade_type=document.getElementById('agGradeType').value;
  const value=parseFloat(document.getElementById('agValue').value);
  const weight=parseFloat(document.getElementById('agWeight').value)||1;
  const date=document.getElementById('agDate').value;
  const description=document.getElementById('agDesc').value.trim();
  if(isNaN(value)){ toast('Inserisci un voto valido','err'); return }
  try {
    const id=uid();
    await api('POST','/api/grades/grades',{id,subject_id,grade_type,value,weight,date,description});
    const s=vdb.subjects[type].find(x=>x.id===subject_id);
    s.grades.unshift({id,subject_id,grade_type,value,weight,date,description});
    closeModal('addGradeModal'); refreshVoti(); toast('Voto aggiunto');
  } catch(e){ toast(e.message,'err') }
}
async function deleteGrade(gradeId,type){
  if(!confirm('Eliminare questo voto?')) return;
  try {
    await api('DELETE','/api/grades/grades/'+gradeId);
    vdb.subjects[type].forEach(s=>{ s.grades=s.grades.filter(g=>g.id!==gradeId) });
    refreshVoti(); toast('Voto eliminato');
  } catch(e){ toast(e.message,'err') }
}
function openAddSubjectModal(type){
  document.getElementById('addSubjType').value=type;
  document.getElementById('addSubjName').value='';
  document.getElementById('addSubjCredits').value=type==='university'?6:1;
  document.getElementById('addSubjCfuLabel').textContent=type==='university'?'Crediti CFU':'Peso (1=normale)';
  openModal('addSubjModal');
}
async function addSubject(){
  const type=document.getElementById('addSubjType').value;
  const name=document.getElementById('addSubjName').value.trim();
  const credits=parseFloat(document.getElementById('addSubjCredits').value)||1;
  if(!name){ toast('Inserisci il nome','err'); return }
  try {
    const id=uid();
    await api('POST','/api/grades/subjects',{id,type,name,credits});
    vdb.subjects[type].push({id,type,name,credits,grades:[]});
    closeModal('addSubjModal'); refreshVoti(); toast('Materia aggiunta');
  } catch(e){ toast(e.message,'err') }
}
async function deleteSubject(id,type){
  if(!confirm('Eliminare questa materia e tutti i suoi voti?')) return;
  try {
    await api('DELETE','/api/grades/subjects/'+id);
    vdb.subjects[type]=vdb.subjects[type].filter(s=>s.id!==id);
    refreshVoti(); toast('Materia eliminata');
  } catch(e){ toast(e.message,'err') }
}

// PUNIZIONI
function renderPunizioni(){
  const pen=calcPenalties();
  document.getElementById('p-consegna').textContent=fmt(pen.consegnaPts);
  document.getElementById('p-rigore').textContent=fmt(pen.rigorePts);
  document.getElementById('p-total').textContent=fmt(pen.total);
  document.getElementById('consegnaRateLabel').textContent=vdb.settings.pen_consegna_rate||0.5;
  const rate=parseFloat(vdb.settings.pen_consegna_rate)||0.5;
  function renderList(type,elId){
    const el=document.getElementById(elId);
    const items=vdb.penalties[type];
    el.innerHTML=items.length?`<table class="data-table"><thead><tr><th>Data</th><th>Giorni</th><th>Penalità</th><th>Motivazione</th><th></th></tr></thead><tbody>
    ${items.map(p=>`<tr><td>${fmtDate(p.date)}</td><td>${p.days}</td>
      <td style="color:var(--red-light)">${type==='consegna'?'−'+fmt(p.days*rate)+' pt':'−'+fmt(3.5+p.days)+' pt'}</td>
      <td style="color:var(--text2)">${escHtml(p.reason||'—')}</td>
      <td><button class="btn btn-sm btn-red del-btn" onclick="deletePenalty('${p.id}','${type}')">✕</button></td>
    </tr>`).join('')}</tbody></table>`
    :'<div style="color:var(--text3);font-family:var(--font-mono);font-size:.72rem;padding:1rem;text-align:center">Nessuna registrata</div>';
  }
  renderList('consegna','p-consegna-list');
  renderList('rigore','p-rigore-list');
}
function openPenaltyModal(type){
  document.getElementById('penType').value=type;
  document.getElementById('penDate').value=today();
  document.getElementById('penDays').value=1;
  document.getElementById('penReason').value='';
  document.getElementById('penModalTitle').textContent=type==='consegna'?'📋 Aggiungi Consegna':'🔒 Aggiungi Rigore';
  document.getElementById('penDaysLabel').textContent=type==='consegna'?'Giorni di Consegna':'Giorni di Rigore';
  updatePenPreview();
  openModal('penModal');
}
function updatePenPreview(){
  const type=document.getElementById('penType').value;
  const days=parseInt(document.getElementById('penDays').value)||0;
  const rate=parseFloat(vdb.settings.pen_consegna_rate)||0.5;
  let pts=0,msg='';
  if(type==='consegna'){pts=days*rate;msg=`${days} giorno/i × ${rate} pt = −${pts.toFixed(2)} pt`}
  else{pts=3.5+days;msg=`Apertura (−3.5) + ${days} giorno/i × 1 pt = −${pts.toFixed(2)} pt`}
  document.getElementById('penPreview').textContent='⚠ Penalità prevista: '+msg;
}
async function savePenalty(){
  const type=document.getElementById('penType').value;
  const days=parseInt(document.getElementById('penDays').value)||1;
  const date=document.getElementById('penDate').value;
  const reason=document.getElementById('penReason').value.trim();
  try {
    const id=uid();
    await api('POST','/api/grades/penalties',{id,type,days,date,reason});
    vdb.penalties[type].unshift({id,type,days,date,reason});
    closeModal('penModal'); renderPunizioni(); renderGraduatoria(); toast('Punizione registrata');
  } catch(e){ toast(e.message,'err') }
}
async function deletePenalty(id,type){
  if(!confirm('Eliminare questa punizione?')) return;
  try {
    await api('DELETE','/api/grades/penalties/'+id);
    vdb.penalties[type]=vdb.penalties[type].filter(p=>p.id!==id);
    renderPunizioni(); renderGraduatoria(); toast('Eliminata');
  } catch(e){ toast(e.message,'err') }
}

// ORARIO
const DAYS=['Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'];
// Inizio lezioni 08:10, durata 45'. Prima pausa 5', poi pause 10' fino a pausa pranzo 13:40–14:10; ripresa 14:20, pause pomeriggio 5'.
const HOURS=['08:10','09:00','09:55','10:50','11:45','12:40','14:20','15:10','16:00','16:50','17:40','18:30'];
function renderSchedule(){
  const grid=document.getElementById('scheduleGrid');
  grid.style.gridTemplateColumns='76px repeat(6,1fr)';
  grid.style.gridTemplateRows=`auto repeat(${HOURS.length},50px)`;
  grid.innerHTML='';
  const mkC=(cls,txt)=>{ const c=document.createElement('div');c.className=cls;c.textContent=txt;return c };
  grid.appendChild(mkC('sched-cell hdr',''));
  DAYS.forEach(d=>grid.appendChild(mkC('sched-cell hdr',d)));
  HOURS.forEach(h=>{
    grid.appendChild(mkC('sched-cell tme',h));
    DAYS.forEach((d,di)=>{
      const entry=vdb.schedule[`${di}-${h}`];
      const cell=document.createElement('div');cell.className='sched-cell';cell.onclick=()=>openSchedModal(di,h);
      if(entry) cell.innerHTML=`<div class="sched-entry ${entry.type==='military'?'military':entry.type==='gym'?'gym':''}"><div style="font-weight:500">${escHtml(entry.subject)}</div>${entry.room?`<div style="opacity:.7">${escHtml(entry.room)}</div>`:''}</div>`;
      grid.appendChild(cell);
    });
  });
}
function openSchedModal(di,h){
  document.getElementById('sDayIdx').value=di;document.getElementById('sHour').value=h;
  const entry=vdb.schedule[`${di}-${h}`]||{};
  document.getElementById('sSubject').value=entry.subject||'';document.getElementById('sRoom').value=entry.room||'';document.getElementById('sType').value=entry.type||'university';
  document.getElementById('schedModalTitle').textContent=DAYS[di]+' — '+h;openModal('schedModal');
}
async function saveScheduleCell(){
  const day_index=parseInt(document.getElementById('sDayIdx').value);const hour=document.getElementById('sHour').value;
  const subject=document.getElementById('sSubject').value.trim();const room=document.getElementById('sRoom').value.trim();const type=document.getElementById('sType').value;
  if(!subject){deleteScheduleCell();return}
  try { await api('POST','/api/grades/schedule/upsert',{day_index,hour,subject,room,type}); vdb.schedule[`${day_index}-${hour}`]={subject,room,type}; closeModal('schedModal');renderSchedule();toast('Orario salvato') } catch(e){toast(e.message,'err')}
}
async function deleteScheduleCell(){
  const day_index=parseInt(document.getElementById('sDayIdx').value);const hour=document.getElementById('sHour').value;
  try { await api('POST','/api/grades/schedule/delete',{day_index,hour}); delete vdb.schedule[`${day_index}-${hour}`]; closeModal('schedModal');renderSchedule();toast('Cella rimossa') } catch(e){toast(e.message,'err')}
}
async function clearSchedule(){
  if(!confirm('Cancellare tutto l\'orario?')) return;
  try { await api('POST','/api/grades/schedule/clear'); vdb.schedule={};renderSchedule();toast('Orario svuotato') } catch(e){toast(e.message,'err')}
}

// NOTE
function renderNotes(){
  const sorted=[...vdb.notes].sort((a,b)=>{if(a.pinned&&!b.pinned)return -1;if(!a.pinned&&b.pinned)return 1;return b.created_at>a.created_at?1:-1});
  document.getElementById('notesList').innerHTML=sorted.length?sorted.map(n=>`
    <div class="note-card ${n.pinned?'pinned':''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.4rem">
        <div class="note-title">${n.pinned?'📌 ':''}${escHtml(n.title||'Senza titolo')}</div>
        <div style="display:flex;gap:.3rem">
          <button class="btn btn-sm" onclick="togglePin('${n.id}',${!n.pinned})">${n.pinned?'Sfissa':'📌 Fissa'}</button>
          <button class="btn btn-sm btn-red" onclick="deleteNote('${n.id}')">✕</button>
        </div>
      </div>
      <div class="note-body">${escHtml(n.body)}</div>
      <div class="note-date">${fmtDate(n.note_date||n.created_at?.slice(0,10))}</div>
    </div>`).join(''):'<div style="color:var(--text3);font-family:var(--font-mono);font-size:.75rem;text-align:center;padding:2rem">Nessuna nota</div>';
}
async function saveNote(){
  const title=document.getElementById('noteTitleInput').value.trim();
  const body=document.getElementById('noteBodyInput').value.trim();
  if(!body){toast('La nota è vuota','err');return}
  const pinned=document.getElementById('notePinInput').value==='true';
  try {
    const id=uid();
    await api('POST','/api/grades/notes',{id,title,body,pinned,date:today()});
    vdb.notes.unshift({id,title,body,pinned,note_date:today(),created_at:today()});
    document.getElementById('noteTitleInput').value='';document.getElementById('noteBodyInput').value='';
    renderNotes();toast('Nota salvata');
  } catch(e){toast(e.message,'err')}
}
async function togglePin(id,pinned){
  try { await api('PUT','/api/grades/notes/'+id,{pinned}); const n=vdb.notes.find(x=>x.id===id);if(n) n.pinned=pinned;renderNotes() } catch(e){toast(e.message,'err')}
}
async function deleteNote(id){
  if(!confirm('Eliminare questa nota?')) return;
  try { await api('DELETE','/api/grades/notes/'+id); vdb.notes=vdb.notes.filter(n=>n.id!==id);renderNotes();toast('Nota eliminata') } catch(e){toast(e.message,'err')}
}

// IMPOSTAZIONI VOTI
// I pesi di graduatoria non sono più configurabili (formula fissa), ma restano
// in vdb.settings e vengono rispediti invariati al server per non perdere i dati.
function loadVotiSettings(){
  const s=vdb.settings;
  document.getElementById('s-pen').value = s.pen_consegna_rate || 0.5;
}
async function saveVotiSettings(){
  const weight_uni =parseFloat(vdb.settings.weight_uni) ||50;
  const weight_acad=parseFloat(vdb.settings.weight_acad)||50;
  const weight_gym =parseFloat(vdb.settings.weight_gym) ||50;
  const weight_mil =parseFloat(vdb.settings.weight_mil) ||50;
  const pen_consegna_rate=parseFloat(document.getElementById('s-pen').value)||0.5;
  const full_name=document.getElementById('s-name').value.trim();
  const military_rank=document.getElementById('s-rank').value.trim();
  const academic_year=document.getElementById('s-year').value;
  const platoon=document.getElementById('s-platoon').value.trim();
  try {
    await api('PUT','/api/grades/settings',{weight_uni,weight_acad,weight_gym,weight_mil,pen_consegna_rate,full_name,military_rank,academic_year,platoon});
    Object.assign(vdb.settings,{weight_uni,weight_acad,weight_gym,weight_mil,pen_consegna_rate});
    renderGraduatoria();renderPunizioni();toast('Impostazioni salvate');
  } catch(e){toast(e.message,'err')}
}
function renderSubjectMgmt(){
  const types={university:'Università',gym:'Ginnastica',military:'Militare'};
  document.getElementById('subjectMgmt').innerHTML=Object.entries(types).map(([type,label])=>`
    <div>
      <div style="font-family:var(--font-display);font-size:.82rem;color:var(--gold);margin-bottom:.6rem">${label}</div>
      ${vdb.subjects[type].map(s=>`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid rgba(42,58,74,.4)">
          <span style="font-family:var(--font-body);font-size:.88rem;color:var(--text2)">${escHtml(s.name)} <span style="color:var(--text3);font-size:.75rem">(${s.credits})</span></span>
          <button class="btn btn-sm btn-red" onclick="deleteSubject('${s.id}','${type}')">✕</button>
        </div>`).join('')}
      <button class="btn btn-gold" style="margin-top:.6rem;font-size:.58rem" onclick="openAddSubjectModal('${type}')">+ Aggiungi</button>
    </div>`).join('');
}
function switchVotiTab(id,btn){
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('vtab-'+id).classList.add('active');
  if(btn) btn.classList.add('active');
  if(id==='impostazioni') renderSubjectMgmt();
  if(id==='graduatoria')  renderGraduatoria();
}

// ── ADMIN ──────────────────────────────────────────────────────────
// Cache degli utenti caricati: evita di riscaricare la lista ad ogni apertura
// della modale permessi.
let adminUsers = [];

async function loadAdminUsers(){
  try {
    const users=await api('GET','/api/admin/users');
    users.sort((a,b)=>Number(b.id)-Number(a.id));
    adminUsers = users;
    document.getElementById('adminUserBody').innerHTML=users.map(u=>`
      <tr>
        <td style="color:var(--text3)">${u.id}</td>
        <td>${escHtml(u.username)}</td>
        <td style="color:var(--text2)">${escHtml(u.cognome&&u.nome ? u.cognome+' '+u.nome : u.full_name||'—')}</td>
        <td>${roleBadge(u.role,u.is_admin)||'<span class="role-badge role-none">Allievo</span>'}</td>
        <td style="color:var(--text3);font-size:.65rem">${fmtDate(u.created_at?.slice(0,10))}</td>
        <td><div class="perm-summary">${permSummaryBadges(u)}</div></td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-gold" onclick="openUserPermModal(${u.id})">⚙ &nbsp;Permessi</button>
          <button class="btn btn-sm btn-red" onclick="deleteUser(${u.id},'${escHtml(u.username)}')">🗑</button>
        </td>
      </tr>`).join('');
  } catch(e){toast(e.message,'err')}
}

// Riepilogo compatto dei permessi attivi, dal registro PERMISSIONS
function permSummaryBadges(u){
  const attivi = PERMISSIONS.filter(p => !!u[p.field]);
  if(!attivi.length) return '<span style="font-family:var(--font-mono);font-size:.6rem;color:var(--text3)">Nessuno</span>';
  return attivi.map(p=>`<span class="badge badge-${p.field==='is_admin'?'gold':'green'}">${p.icon} ${escHtml(p.label)}</span>`).join('');
}

// ── MODALE PERMESSI UTENTE ─────────────────────────────────────────
// Punto centrale unico: dati utente + tutti i permessi assegnabili.
// Aggiungere una voce a PERMISSIONS (o a TOOLS) la fa comparire qui da sola.
function openUserPermModal(id){
  const u = adminUsers.find(x => Number(x.id) === Number(id));
  if(!u){ toast('Utente non trovato — aggiorna la lista','err'); return; }

  document.getElementById('upUserId').value = u.id;
  document.getElementById('upAvatar').textContent = getInitials(u.full_name||u.username);
  document.getElementById('upFullName').textContent = u.cognome&&u.nome ? `${u.cognome} ${u.nome}` : (u.full_name||u.username);
  document.getElementById('upMeta').innerHTML =
    `@${escHtml(u.username)} · ID ${u.id}<br>`+
    `${escHtml(u.email||'email non indicata')}<br>`+
    `Grado: ${escHtml(u.military_rank||'AU')} · Registrato il ${fmtDate(u.created_at?.slice(0,10))}`;

  document.getElementById('upRole').innerHTML = Object.entries(ROLE_LABELS)
    .map(([val,lbl])=>`<option value="${val}" ${u.role===val?'selected':''}>${lbl}</option>`).join('');

  // Righe permesso raggruppate
  const groups = [];
  PERMISSIONS.forEach(p=>{
    let g = groups.find(x=>x.name===p.group);
    if(!g){ g={name:p.group,items:[]}; groups.push(g); }
    g.items.push(p);
  });
  document.getElementById('upPermList').innerHTML = groups.map(g=>`
    <div class="perm-group-title">${escHtml(g.name)}</div>
    ${g.items.map(p=>`
      <div class="perm-row">
        <div style="min-width:0">
          <div class="perm-row-label">${p.icon} ${escHtml(p.label)}</div>
          <div class="perm-row-desc">${escHtml(p.desc)}</div>
        </div>
        <span class="perm-toggle ${u[p.field]?'perm-on':'perm-off'}" id="up-perm-${p.field}"
              data-on="${u[p.field]?1:0}" onclick="toggleUserPermRow('${p.field}')">${u[p.field]?'✓ Sì':'✗ No'}</span>
      </div>`).join('')}
  `).join('');

  openModal('userPermModal');
}

// Toggle locale: nulla viene salvato finché non si conferma
function toggleUserPermRow(field){
  const el = document.getElementById('up-perm-'+field);
  if(!el) return;
  const on = el.dataset.on === '1' ? 0 : 1;
  el.dataset.on = String(on);
  el.className = 'perm-toggle '+(on?'perm-on':'perm-off');
  el.textContent = on ? '✓ Sì' : '✗ No';
}

async function saveUserPermissions(){
  const id = document.getElementById('upUserId').value;
  if(!id) return;
  const payload = { role: document.getElementById('upRole').value };
  PERMISSIONS.forEach(p=>{
    const el = document.getElementById('up-perm-'+p.field);
    payload[p.field] = el ? el.dataset.on === '1' : false;
  });
  try {
    await api('PUT','/api/admin/users/'+id, payload);
    closeModal('userPermModal');
    await loadAdminUsers();
    toast("Permessi aggiornati — effettivi immediatamente per l'utente",'ok');
  } catch(e){ toast(e.message,'err') }
}

async function deleteUser(id,username){
  if(!confirm(`Eliminare l'utente ${username} e TUTTI i suoi dati?`)) return;
  try { await api('DELETE','/api/admin/users/'+id);loadAdminUsers();toast('Utente eliminato') } catch(e){toast(e.message,'err')}
}

// ── CALENDARIO ────────────────────────────────────────────────────
let calEvents = [];
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth(); // 0-based

const MESI = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const GIORNI = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
const CAL_COLORS = { gold:'var(--gold)', green:'var(--green-l)', red:'var(--red-l)', blue:'var(--blue-l)', amber:'var(--amber-l)' };

async function loadCalendario(){
  try {
    const data = await api('GET',`/api/calendar?month=${calMonth+1}&year=${calYear}`);
    calEvents = data;
    renderCalendario();
  } catch(e){ toast(e.message,'err'); }
}

function renderCalendario(){
  renderCalGrid();
  renderCalEventList();
}

function calNavMonth(dir){
  calMonth += dir;
  if(calMonth > 11){ calMonth=0; calYear++; }
  if(calMonth < 0) { calMonth=11; calYear--; }
  document.getElementById('calMonthLabel').textContent = MESI[calMonth]+' '+calYear;
  loadCalendario();
}

function renderCalGrid(){
  const grid = document.getElementById('calGrid');
  const firstDay = new Date(calYear, calMonth, 1);
  const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
  // Lunedì=0 come primo giorno
  let startDow = firstDay.getDay(); // 0=Dom
  startDow = startDow === 0 ? 6 : startDow - 1;

  let html = GIORNI.map(g=>`<div class="cal-dow">${g}</div>`).join('');
  for(let i=0;i<startDow;i++) html += '<div class="cal-day cal-day-empty"></div>';
  for(let d=1;d<=daysInMonth;d++){
    const dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayEvts = calEvents.filter(e=>e.event_date&&e.event_date.slice(0,10)===dateStr);
    const today = new Date(); const isToday = today.getDate()===d&&today.getMonth()===calMonth&&today.getFullYear()===calYear;
    const dots = dayEvts.map(e=>`<span class="cal-dot" style="background:${CAL_COLORS[e.color]||'var(--gold)'}"></span>`).join('');
    html += `<div class="cal-day${isToday?' cal-today':''}" onclick="openCalDay('${dateStr}')">
      <div class="cal-day-num">${d}</div>
      <div class="cal-dots">${dots}</div>
    </div>`;
  }
  grid.innerHTML = html;
}

function renderCalEventList(){
  const el = document.getElementById('calEventList');
  if(!calEvents.length){
    el.innerHTML='<div style="text-align:center;padding:2rem;color:var(--text3);font-family:var(--font-mono);font-size:.7rem">Nessun evento questo mese</div>';
    return;
  }
  const grouped = {};
  calEvents.forEach(e=>{
    const d = (e.event_date||'').slice(0,10);
    if(!grouped[d]) grouped[d]=[];
    grouped[d].push(e);
  });
  el.innerHTML = Object.keys(grouped).sort().map(date=>{
    const dt = new Date(date+'T12:00:00');
    const label = dt.toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long'});
    return `<div class="cal-event-group">
      <div class="cal-event-date">${label}</div>
      ${grouped[date].map(e=>`
        <div class="cal-event-card" style="border-left-color:${CAL_COLORS[e.color]||'var(--gold)'}">
          <div class="cal-event-header">
            <div>
              ${e.event_time?`<span class="cal-event-time">${e.event_time}</span>`:''}
              <span class="cal-event-title">${escHtml(e.title)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:.5rem">
              <span style="font-family:var(--font-mono);font-size:.58rem;color:var(--text3)">${escHtml(e.full_name||e.username)}</span>
              ${(currentUser&&(e.user_id===currentUser.id||currentUser.is_admin))?
                `<button class="btn btn-sm btn-red" onclick="deleteCalEvent('${e.id}')">✕</button>`:''}
            </div>
          </div>
          ${e.description?`<div class="cal-event-desc">${escHtml(e.description)}</div>`:''}
        </div>`).join('')}
    </div>`;
  }).join('');
}

function openCalDay(dateStr){
  document.getElementById('calEventDate').value = dateStr;
  openModal('calEventModal');
}

async function saveCalEvent(){
  const title       = document.getElementById('calEventTitle').value.trim();
  const event_date  = document.getElementById('calEventDate').value;
  const event_time  = document.getElementById('calEventTime').value;
  const description = document.getElementById('calEventDesc').value.trim();
  const color       = document.getElementById('calEventColor').value;
  if(!title){ toast('Inserisci un titolo','err'); return; }
  if(!event_date){ toast('Seleziona una data','err'); return; }
  try {
    await api('POST','/api/calendar',{id:uid(),title,event_date,event_time,description,color});
    closeModal('calEventModal');
    document.getElementById('calEventTitle').value='';
    document.getElementById('calEventTime').value='';
    document.getElementById('calEventDesc').value='';
    toast('Evento aggiunto');
    await loadCalendario();
  } catch(e){ toast(e.message,'err'); }
}

async function deleteCalEvent(id){
  if(!confirm('Eliminare questo evento?')) return;
  try {
    await api('DELETE','/api/calendar/'+id);
    toast('Evento eliminato');
    await loadCalendario();
  } catch(e){ toast(e.message,'err'); }
}

// ── INIT ───────────────────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !token) return;
  const pg = document.getElementById('page-comunicazioni');
  if (!pg || !pg.classList.contains('active') || currentComTab !== 'chat') return;
  loadComChat();
});
window.addEventListener('DOMContentLoaded',()=>{
  // Inizializza etichetta mese calendario
  const lbl = document.getElementById('calMonthLabel');
  if(lbl) lbl.textContent = MESI[calMonth]+' '+calYear;
  if(token){ tryAutoLogin() } else { showLanding() }
});
