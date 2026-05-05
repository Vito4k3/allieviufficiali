'use strict';

const API = 'https://sito-allievi-accademia-militare.onrender.com';

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
let allLists = [], currentListTab = 'liberi_sab_pom';
let bachecaInterval = null;

const LIST_LABELS = {
  liberi_sab_pom:  'Liberi Uscenti Sabato Pomeriggio',
  liberi_sab_sera: 'Liberi Uscenti Sabato Sera',
  liberi_dom_pom:  'Liberi Uscenti Domenica Pomeriggio',
  messa:           'Lista Messa',
  parlatorio:      'Lista Parlatorio'
};

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
function today(){ return new Date().toISOString().slice(0,10) }
function escHtml(s){ const d=document.createElement('div');d.textContent=s;return d.innerHTML }

function toast(msg,type='ok'){
  const t=document.getElementById('toast');
  t.textContent=(type==='ok'?'✓ ':type==='err'?'✗ ':'ℹ ')+msg;
  t.className='show '+type;
  clearTimeout(t._tm);
  t._tm=setTimeout(()=>t.className='',3500);
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
function showLanding(){ _s('landing');_h('auth');_h('app') }
function showAuth(tab='login'){ _h('landing');_s('auth');_h('app'); switchAuthTab(tab) }
function showApp(){ _h('landing');_h('auth');_s('app'); applyPermissions(); loadBacheca(); startBachecaPolling() }
function _s(id){ document.getElementById(id).classList.remove('hidden') }
function _h(id){ document.getElementById(id).classList.add('hidden') }

async function showPage(id, link){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.sb-link').forEach(a=>a.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  if(link) link.classList.add('active');
  // Aggiorna sempre permessi dal server prima di caricare sezione
  await refreshCurrentUser();
  if(id==='finanze') loadFinanze();
  if(id==='voti')    loadVoti();
  if(id==='liste')   loadListe();
  if(id==='admin')   loadAdminUsers();
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
  document.getElementById('sb-section-admin').style.display = isAdmin ? '' : 'none';
  document.getElementById('sb-nav-admin').style.display     = isAdmin ? '' : 'none';
  const btnNew = document.getElementById('btnNewList');
  if(btnNew) btnNew.classList.toggle('hidden', !isAdmin);
  document.getElementById('sbUserName').textContent = currentUser.full_name||currentUser.username;
  document.getElementById('sbUserRank').textContent = currentUser.military_rank||'Allievo Ufficiale';
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
    showApp(); toast('Benvenuto, '+(currentUser.full_name||currentUser.username));
  } catch(e){ showAuthError(e.message) }
}
async function doRegister(){
  const username=document.getElementById('regUser').value.trim();
  const email=document.getElementById('regEmail').value.trim();
  const full_name=document.getElementById('regName').value.trim();
  const password=document.getElementById('regPass').value;
  const password2=document.getElementById('regPass2').value;
  if(!username||!email||!password){ showAuthError('Compila tutti i campi obbligatori'); return }
  if(password!==password2){ showAuthError('Le password non coincidono'); return }
  if(password.length<6){ showAuthError('Password troppo corta (min 6 caratteri)'); return }
  try {
    await api('POST','/api/auth/register',{username,email,password,full_name});
    toast('Account creato! Ora accedi.','info');
    switchAuthTab('login');
    document.getElementById('loginUser').value=username;
  } catch(e){ showAuthError(e.message) }
}
function showAuthError(msg){ const el=document.getElementById('authError');el.textContent='⚠ '+msg;el.style.display='block' }
async function doLogout(){ token='';localStorage.removeItem('jwt');currentUser=null;stopBachecaPolling();showLanding() }
async function tryAutoLogin(){
  if(!token) return;
  try {
    const data=await api('GET','/api/auth/me');
    currentUser=data;
    if(data.token){ token=data.token; localStorage.setItem('jwt',token); }
    showApp();
  } catch { token='';localStorage.removeItem('jwt');showLanding() }
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
        <span>⚔</span><span>${p.military_rank?p.military_rank+' ':''}<strong>${escHtml(p.full_name||p.username)}</strong></span>
        <span class="post-rank">@${p.username}</span>
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
  try { await api('POST','/api/announcements',{content}); document.getElementById('postContent').value=''; toast('Annuncio pubblicato'); loadBacheca() }
  catch(e){ toast(e.message,'err') }
}
async function deletePost(id){
  if(!confirm('Eliminare questo annuncio?')) return;
  try { await api('DELETE','/api/announcements/'+id); loadBacheca(); toast('Eliminato') } catch(e){ toast(e.message,'err') }
}

// ── LISTE ──────────────────────────────────────────────────────────
async function loadListe(){
  try {
    allLists=await api('GET','/api/lists');
    renderListContent();
  } catch(e){ toast(e.message,'err') }
}
function switchListTab(type, btn){
  currentListTab=type;
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  renderListContent();
}
function toggleAdminListPanel(){
  const p=document.getElementById('list-admin-panel');
  p.classList.toggle('hidden');
  if(!p.classList.contains('hidden')){
    // Pre-seleziona il tipo della tab corrente
    document.getElementById('newListType').value=currentListTab;
    document.getElementById('newListDate').value=today();
  }
}
async function createList(){
  const list_type=document.getElementById('newListType').value;
  const list_date=document.getElementById('newListDate').value;
  const notes=document.getElementById('newListNotes').value.trim();
  if(!list_date){ toast('Seleziona una data','err'); return }
  try {
    await api('POST','/api/lists',{id:uid(),list_type,list_date,notes});
    document.getElementById('list-admin-panel').classList.add('hidden');
    document.getElementById('newListNotes').value='';
    toast('Lista creata');
    await loadListe();
  } catch(e){ toast(e.message,'err') }
}
async function deleteList(id){
  if(!confirm('Eliminare questa lista e tutte le iscrizioni?')) return;
  try { await api('DELETE','/api/lists/'+id); toast('Lista eliminata'); await loadListe() }
  catch(e){ toast(e.message,'err') }
}

function renderListContent(){
  const el=document.getElementById('list-content');
  const filtered=allLists.filter(l=>l.list_type===currentListTab);
  const isAdmin=currentUser?.is_admin;
  if(!filtered.length){
    el.innerHTML=`<div class="card" style="text-align:center;padding:3rem">
      <div style="font-size:2rem;margin-bottom:.8rem">📋</div>
      <div style="font-family:var(--font-display);font-size:1rem;color:var(--text2);margin-bottom:.4rem">${LIST_LABELS[currentListTab]}</div>
      <div style="font-family:var(--font-mono);font-size:.72rem;color:var(--text3)">Nessuna lista creata per questa categoria${isAdmin?' — usa "Nuova Lista" per crearne una':'.'}</div>
    </div>`; return;
  }
  el.innerHTML=filtered.map(l=>{
    const mySignup=l.signups?.find(s=>s.user_id===currentUser?.id);
    const isSignedUp=!!mySignup;
    const isParlatorio=l.list_type==='parlatorio';
    return `<div class="list-card">
      <div class="list-card-header" onclick="toggleListCard('lbody-${l.id}')">
        <div>
          <div style="font-family:var(--font-display);font-size:.95rem;color:var(--text);letter-spacing:.06em">${LIST_LABELS[l.list_type]}</div>
          <div style="font-family:var(--font-mono);font-size:.62rem;color:var(--text3);margin-top:.15rem">📅 ${fmtDate(l.list_date)}${l.notes?' · '+escHtml(l.notes):''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:.8rem">
          <span class="badge badge-gold">${l.signup_count} iscritti</span>
          ${isAdmin?`<button class="btn btn-sm btn-red" onclick="event.stopPropagation();deleteList('${l.id}')">🗑</button>`:''}
          <span style="color:var(--text3);font-family:var(--font-mono);font-size:.8rem">▾</span>
        </div>
      </div>
      <div class="list-card-body" id="lbody-${l.id}">
        <div style="display:flex;gap:.6rem;margin-bottom:1rem;flex-wrap:wrap">
          ${!isSignedUp
            ? isParlatorio
              ? `<button class="btn btn-gold" onclick="openParlatorioModal('${l.id}')">✋ Iscriviti (Parlatorio)</button>`
              : `<button class="btn btn-gold" onclick="signupList('${l.id}')">✋ Iscriviti</button>`
            : `<button class="btn btn-red" onclick="unsignupList('${l.id}')">✗ Rimuovi iscrizione</button>`
          }
          ${isAdmin&&isSignedUp?`<button class="btn btn-sm" onclick="removeSignup('${l.id}',${currentUser.id})">Rimuovi (admin)</button>`:''}
        </div>
        <div style="font-family:var(--font-mono);font-size:.65rem;color:var(--text3);letter-spacing:.12em;text-transform:uppercase;margin-bottom:.5rem">Iscritti (${l.signup_count})</div>
        ${renderSignupList(l,isAdmin,isParlatorio)}
      </div>
    </div>`;
  }).join('');
}

function renderSignupList(l,isAdmin,isParlatorio){
  const signups=l.signups||[];
  if(!signups.length) return '<div style="color:var(--text3);font-family:var(--font-mono);font-size:.72rem;padding:.5rem">Nessuno iscritto ancora.</div>';
  return signups.map((s,i)=>`
    <div class="signup-row">
      <span style="color:var(--text3);width:22px">${i+1}.</span>
      <span style="color:var(--gold)">${escHtml(s.military_rank?s.military_rank+' ':'')}<strong>${escHtml(s.full_name||s.username)}</strong></span>
      ${isParlatorio&&s.relative_name?`<span style="color:var(--text2)">→ ${escHtml(s.relative_name)} (${escHtml(s.relative_relation||'—')})${s.relative_id_card?' · CI: '+escHtml(s.relative_id_card):''}</span>`:''}
      ${isAdmin?`<button class="btn btn-sm btn-red del-btn" onclick="removeSignup('${l.id}',${s.user_id})" style="margin-left:auto">✕</button>`:''}
    </div>`).join('');
}

async function loadListDetail(listId){
  try {
    const detail=await api('GET','/api/lists/'+listId);
    const idx=allLists.findIndex(l=>l.id===listId);
    if(idx>=0) allLists[idx]={...allLists[idx],...detail,signup_count:detail.signups.length};
    renderListContent();
  } catch(e){ toast(e.message,'err') }
}

function toggleListCard(id){
  const el=document.getElementById(id);
  if(!el) return;
  const isOpen=el.classList.contains('open');
  // Carica dettaglio se apre per la prima volta
  if(!isOpen){
    const listId=id.replace('lbody-','');
    const list=allLists.find(l=>l.id===listId);
    if(list&&!list.signups) loadListDetail(listId);
    else renderListContent();
  }
  el.classList.toggle('open',!isOpen);
}

async function signupList(listId){
  try {
    await api('POST','/api/lists/'+listId+'/signup',{signup_id:uid()});
    toast('Iscritto!');
    await loadListDetail(listId);
    document.getElementById('lbody-'+listId)?.classList.add('open');
  } catch(e){ toast(e.message,'err') }
}
async function unsignupList(listId){
  if(!confirm('Rimuovere la tua iscrizione?')) return;
  try {
    await api('DELETE','/api/lists/'+listId+'/signup');
    toast('Iscrizione rimossa');
    await loadListDetail(listId);
    document.getElementById('lbody-'+listId)?.classList.add('open');
  } catch(e){ toast(e.message,'err') }
}
async function removeSignup(listId,userId){
  if(!confirm('Rimuovere questo iscritto?')) return;
  try {
    await api('DELETE','/api/lists/'+listId+'/signup/'+userId);
    toast('Iscritto rimosso');
    await loadListDetail(listId);
    document.getElementById('lbody-'+listId)?.classList.add('open');
  } catch(e){ toast(e.message,'err') }
}
function openParlatorioModal(listId){
  document.getElementById('parlListId').value=listId;
  document.getElementById('parlName').value='';
  document.getElementById('parlRelation').value='';
  document.getElementById('parlIdCard').value='';
  openModal('parlatorioModal');
}
async function confirmParlatorioSignup(){
  const listId=document.getElementById('parlListId').value;
  const relative_name=document.getElementById('parlName').value.trim();
  const relative_relation=document.getElementById('parlRelation').value.trim();
  const relative_id_card=document.getElementById('parlIdCard').value.trim();
  if(!relative_name||!relative_relation){ toast('Inserisci nome e parentela del parente','err'); return }
  try {
    await api('POST','/api/lists/'+listId+'/signup',{signup_id:uid(),relative_name,relative_relation,relative_id_card});
    closeModal('parlatorioModal'); toast('Iscritto al parlatorio!');
    await loadListDetail(listId);
    document.getElementById('lbody-'+listId)?.classList.add('open');
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

// CALCOLI
function wAvg(grades){ if(!grades||!grades.length) return null; const t=grades.reduce((a,g)=>a+g.value*g.weight,0),w=grades.reduce((a,g)=>a+g.weight,0); return w>0?t/w:null }
function arAvg(grades){ if(!grades||!grades.length) return null; return grades.reduce((a,g)=>a+g.value,0)/grades.length }
function subjAvg(s){ return wAvg(s.grades) }
function areaExamAvg(subjects){
  const subs=subjects.map(s=>({...s,grades:s.grades.filter(g=>g.grade_type==='exam')})).filter(s=>s.grades.length);
  if(!subs.length) return null;
  const tp=subs.reduce((a,s)=>a+wAvg(s.grades)*s.credits,0),tc=subs.reduce((a,s)=>a+s.credits,0);
  return tc>0?tp/tc:null;
}
function areaAccertAvgUni(subjects){
  const subs=subjects.map(s=>({...s,grades:s.grades.filter(g=>g.grade_type==='accertamento')})).filter(s=>s.grades.length);
  if(!subs.length) return null;
  const tp=subs.reduce((a,s)=>a+wAvg(s.grades)*s.credits,0),tc=subs.reduce((a,s)=>a+s.credits,0);
  return tc>0?tp/tc:null;
}
function areaWAvg(subjects){
  const subs=subjects.filter(s=>s.grades&&s.grades.length);
  if(!subs.length) return null;
  const tp=subs.reduce((a,s)=>a+subjAvg(s)*s.credits,0),tc=subs.reduce((a,s)=>a+s.credits,0);
  return tc>0?tp/tc:null;
}
function areaArAvg(subjects){ const avgs=subjects.filter(s=>s.grades&&s.grades.length).map(s=>subjAvg(s)); if(!avgs.length) return null; return avgs.reduce((a,b)=>a+b,0)/avgs.length }
function calcPenalties(){
  const rate=parseFloat(vdb.settings.pen_consegna_rate)||0.5;
  const c=vdb.penalties.consegna.reduce((a,p)=>a+p.days*rate,0);
  const r=vdb.penalties.rigore.reduce((a,p)=>a+3.5+p.days,0);
  return {consegnaPts:c,rigorePts:r,total:c+r};
}
function badgeGradeClass(v){ if(v>=27)return'badge-green'; if(v>=24)return'badge-gold'; if(v>=18)return'badge-amber'; return'badge-red' }

// GRADUATORIA
function renderGraduatoria(){
  const avgUni=areaExamAvg(vdb.subjects.university);
  const avgAccUni=areaAccertAvgUni(vdb.subjects.university);
  const avgGym=areaWAvg(vdb.subjects.gym);
  const avgMil=areaWAvg(vdb.subjects.military);
  const pen=calcPenalties();
  const {weight_uni,weight_acad,weight_gym,weight_mil}=vdb.settings;
  const wG=parseFloat(weight_gym)||50,wM=parseFloat(weight_mil)||50;
  let acadComponents=[],acadWeights=[];
  if(avgGym!=null){acadComponents.push(avgGym);acadWeights.push(wG)}
  if(avgMil!=null){acadComponents.push(avgMil);acadWeights.push(wM)}
  if(avgAccUni!=null){acadComponents.push(avgAccUni);acadWeights.push(Math.max(wG,wM))}
  let avgAcad=null;
  if(acadComponents.length){ const total=acadComponents.reduce((a,v,i)=>a+v*acadWeights[i],0),wt=acadWeights.reduce((a,b)=>a+b,0); avgAcad=wt>0?total/wt:null }
  const wU=parseFloat(weight_uni)||50,wA=parseFloat(weight_acad)||50;
  let finalScore=null;
  if(avgUni!=null||avgAcad!=null){
    const parts=[],ws=[];
    if(avgUni!=null){parts.push(avgUni);ws.push(wU)}
    if(avgAcad!=null){parts.push(avgAcad);ws.push(wA)}
    const t=parts.reduce((a,v,i)=>a+v*ws[i],0),w=ws.reduce((a,b)=>a+b,0);
    finalScore=w>0?Math.max(0,t/w-pen.total):null;
  }
  document.getElementById('g-avg-uni').textContent  = avgUni!=null  ? fmt(avgUni)  : '—';
  document.getElementById('g-avg-acad').textContent = avgAcad!=null ? fmt(avgAcad) : '—';
  document.getElementById('g-penalties').textContent= fmt(pen.total);
  document.getElementById('g-final').textContent    = finalScore!=null ? fmt(finalScore) : '—';
  document.getElementById('g-formula-text').textContent=`Uni ${wU}% · Mil.Tot. ${wA}% · Penalità: −${fmt(pen.total)}`;
  const maxVal=Math.max(avgUni||0,avgAcad||0,avgGym||0,avgMil||0,1);
  const items=[
    {label:'Media Uni (Esami)',  val:avgUni,    desc:'Materie universitarie — esami pond. CFU'},
    {label:'Acc. Universitari',  val:avgAccUni, desc:'Accertamenti materie universitarie'},
    {label:'Media Ginnastica',   val:avgGym,    desc:'Esami ginnici ponderati'},
    {label:'Media Militare',     val:avgMil,    desc:'Accertamenti militari ponderati'},
    {label:'Media Mil. Totale',  val:avgAcad,   desc:'Combinazione: Gin + Mil + Acc.Uni'},
    {label:'Penalità totali',    val:pen.total>0?-pen.total:null, desc:`Consegna: −${fmt(pen.consegnaPts)} · Rigore: −${fmt(pen.rigorePts)}`}
  ].filter(x=>x.val!=null);
  document.getElementById('g-rank-detail').innerHTML=items.map(item=>`
    <div class="rank-row">
      <div style="width:170px;font-family:var(--font-mono);font-size:.72rem;color:var(--text2)">${item.label}</div>
      <div class="rank-bar-bg"><div class="rank-bar-fill" style="width:${(Math.abs(item.val)/maxVal*100).toFixed(1)}%${item.val<0?';background:var(--red)':''}"></div></div>
      <div style="width:55px;text-align:right;font-family:var(--font-mono);font-size:.82rem;color:${item.val<0?'var(--red-light)':'var(--gold)'}">${item.val<0?'−':'+'}${fmt(Math.abs(item.val))}</div>
      <div style="font-family:var(--font-mono);font-size:.6rem;color:var(--text3);padding-left:.5rem">${item.desc}</div>
    </div>`).join('')||'<div style="color:var(--text3);padding:1rem;font-family:var(--font-mono);font-size:.72rem">Inserisci voti per visualizzare</div>';
  const allG=[];
  ['university','gym','military'].forEach(type=>{ vdb.subjects[type].forEach(s=>s.grades.forEach(g=>allG.push({...g,subjectName:s.name,stype:type}))) });
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
    <span>Media pond.: <strong style="color:var(--gold)">${fmt(wAvg(grades))}</strong></span>
    <span>Media arit.: <strong style="color:var(--gold)">${fmt(arAvg(grades))}</strong></span>
  </div>`;
}

// UNIVERSITÀ — esami + accertamenti separati per materia
function renderSubjectAreaUni(){
  const subjects=vdb.subjects.university;
  const examG=subjects.map(s=>({...s,grades:s.grades.filter(g=>g.grade_type==='exam')}));
  document.getElementById('u-weighted').textContent  = areaExamAvg(subjects)!=null?fmt(areaExamAvg(subjects)):'—';
  document.getElementById('u-arithmetic').textContent= areaArAvg(examG)!=null?fmt(areaArAvg(examG)):'—';
  document.getElementById('u-list').innerHTML=subjects.length?subjects.map(s=>buildUniCard(s)).join(''):'<div style="color:var(--text3);font-family:var(--font-mono);font-size:.75rem;padding:1rem">Nessuna materia universitaria aggiunta.</div>';
}
function buildUniCard(s){
  const exams=s.grades.filter(g=>g.grade_type==='exam');
  const accerts=s.grades.filter(g=>g.grade_type==='accertamento');
  return `<div class="uni-subject-card">
    <div class="uni-subject-header">
      <div><div style="font-family:var(--font-display);font-size:.9rem;color:var(--text);letter-spacing:.05em">${escHtml(s.name)}</div><div style="font-family:var(--font-mono);font-size:.62rem;color:var(--text3);margin-top:.15rem">${s.credits} CFU</div></div>
      <div style="display:flex;gap:.6rem;font-family:var(--font-mono);font-size:.68rem;color:var(--text2)">
        <span>Esami: <strong style="color:var(--gold)">${exams.length?fmt(wAvg(exams)):'—'}</strong></span>
        <span style="color:var(--text3)">|</span>
        <span>Acc.: <strong style="color:var(--blue-light)">${accerts.length?fmt(wAvg(accerts)):'—'}</strong></span>
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
  document.getElementById('gym-weighted').textContent  = areaWAvg(subjects)!=null?fmt(areaWAvg(subjects)):'—';
  document.getElementById('gym-arithmetic').textContent= areaArAvg(subjects)!=null?fmt(areaArAvg(subjects)):'—';
  document.getElementById('gym-list').innerHTML=subjects.length?subjects.map(s=>`
    <div class="subject-section">
      <div class="subject-toggle" onclick="toggleSubject('${s.id}')">
        <div class="subject-toggle-name">${escHtml(s.name)}</div>
        <div class="subject-toggle-stats">
          <span>Peso ${s.credits}</span><span>${s.grades.length} es. ginnico/i</span>
          <span style="color:var(--green-light)">${s.grades.length?fmt(wAvg(s.grades)):'—'}</span>
          <button class="btn btn-sm btn-green" style="font-size:.58rem" onclick="event.stopPropagation();openAddGradeModal('gym','${s.id}','exam')">+ Esame Gin.</button>
        </div>
      </div>
      <div class="subject-body" id="sbody-${s.id}">${buildGradeTable(s.grades,'gym')}</div>
    </div>`).join(''):'<div style="color:var(--text3);font-family:var(--font-mono);font-size:.75rem;padding:1rem">Nessuna disciplina ginnica aggiunta.</div>';
}

// MILITARE — solo accertamenti
function renderSubjectAreaMil(){
  const subjects=vdb.subjects.military;
  document.getElementById('mil-weighted').textContent  = areaWAvg(subjects)!=null?fmt(areaWAvg(subjects)):'—';
  document.getElementById('mil-arithmetic').textContent= areaArAvg(subjects)!=null?fmt(areaArAvg(subjects)):'—';
  document.getElementById('mil-list').innerHTML=subjects.length?subjects.map(s=>`
    <div class="subject-section">
      <div class="subject-toggle" onclick="toggleSubject('${s.id}')">
        <div class="subject-toggle-name">${escHtml(s.name)}</div>
        <div class="subject-toggle-stats">
          <span>Peso ${s.credits}</span><span>${s.grades.length} accer.</span>
          <span style="color:var(--green-light)">${s.grades.length?fmt(wAvg(s.grades)):'—'}</span>
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
  document.getElementById('agWeightLabel').textContent=type==='university'?'Peso CFU':'Peso (1=norm.)';
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
const HOURS=['07:30','08:30','09:30','10:30','11:30','12:30','13:30','14:30','15:30','16:30','17:30','18:30'];
function renderSchedule(){
  const grid=document.getElementById('scheduleGrid');
  grid.style.gridTemplateColumns='70px repeat(6,1fr)';
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
function loadVotiSettings(){
  const s=vdb.settings;
  document.getElementById('s-wuni').value  = s.weight_uni  || 50;
  document.getElementById('s-wacad').value = s.weight_acad || 50;
  document.getElementById('s-wgym').value  = s.weight_gym  || 50;
  document.getElementById('s-wmil').value  = s.weight_mil  || 50;
  document.getElementById('s-pen').value   = s.pen_consegna_rate || 0.5;
}
async function saveVotiSettings(){
  const weight_uni=parseFloat(document.getElementById('s-wuni').value)||50;
  const weight_acad=parseFloat(document.getElementById('s-wacad').value)||50;
  const weight_gym=parseFloat(document.getElementById('s-wgym').value)||50;
  const weight_mil=parseFloat(document.getElementById('s-wmil').value)||50;
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
async function loadAdminUsers(){
  try {
    const users=await api('GET','/api/admin/users');
    document.getElementById('adminUserBody').innerHTML=users.map(u=>`
      <tr>
        <td style="color:var(--text3)">${u.id}</td>
        <td>${escHtml(u.username)}</td>
        <td style="color:var(--text2)">${escHtml(u.full_name||'—')}</td>
        <td style="color:var(--text3);font-size:.65rem">${fmtDate(u.created_at?.slice(0,10))}</td>
        <td><span class="perm-toggle ${u.can_access_finance?'perm-on':'perm-off'}" onclick="togglePerm(${u.id},'finance',${!u.can_access_finance})">${u.can_access_finance?'✓ Sì':'✗ No'}</span></td>
        <td><span class="perm-toggle ${u.can_access_grades?'perm-on':'perm-off'}" onclick="togglePerm(${u.id},'grades',${!u.can_access_grades})">${u.can_access_grades?'✓ Sì':'✗ No'}</span></td>
        <td><span class="perm-toggle ${u.is_admin?'perm-on':'perm-off'}" onclick="togglePerm(${u.id},'admin',${!u.is_admin})">${u.is_admin?'✓ Admin':'✗ No'}</span></td>
        <td><button class="btn btn-sm btn-red" onclick="deleteUser(${u.id},'${escHtml(u.username)}')">🗑</button></td>
      </tr>`).join('');
  } catch(e){toast(e.message,'err')}
}
async function togglePerm(id,field,val){
  try {
    const users=await api('GET','/api/admin/users');
    const u=users.find(x=>x.id===id);if(!u) return;
    const upd={
      can_access_finance: field==='finance'?val:u.can_access_finance,
      can_access_grades:  field==='grades' ?val:u.can_access_grades,
      is_admin:           field==='admin'  ?val:u.is_admin
    };
    await api('PUT','/api/admin/users/'+id,upd);
    loadAdminUsers();toast('Permessi aggiornati — effettivi immediatamente per l\'utente','ok');
  } catch(e){toast(e.message,'err')}
}
async function deleteUser(id,username){
  if(!confirm(`Eliminare l'utente ${username} e TUTTI i suoi dati?`)) return;
  try { await api('DELETE','/api/admin/users/'+id);loadAdminUsers();toast('Utente eliminato') } catch(e){toast(e.message,'err')}
}

// ── INIT ───────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded',()=>{
  if(token){ tryAutoLogin() } else { showLanding() }
});
