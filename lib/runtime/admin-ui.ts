/**
 * Agent Hub Admin UI — single-page admin dashboard served at /admin.
 *
 * Features:
 * - Agency/agent selection
 * - Per-agent memory browser (view/edit/delete)
 * - Mutation journal viewer
 * - Context pins viewer
 * - Workspace manifest editor
 * - Tool call inspector (agent conversation history)
 */

export function getAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Hub Admin</title>
<script src="https://www.gstatic.com/firebasejs/11.6.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/11.6.0/firebase-auth-compat.js"></script>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --border: #30363d;
    --text: #e6edf3; --text2: #8b949e; --accent: #58a6ff; --green: #3fb950;
    --red: #f85149; --yellow: #d29922; --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--font); background: var(--bg); color: var(--text); font-size: 14px; }
  .app { display: flex; height: 100vh; }
  .sidebar { width: 260px; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
  .sidebar h1 { font-size: 16px; padding: 16px; border-bottom: 1px solid var(--border); }
  .sidebar h1 span { color: var(--text2); font-weight: normal; font-size: 12px; }
  .sidebar-section { padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .sidebar-section label { display: block; font-size: 11px; text-transform: uppercase; color: var(--text2); margin-bottom: 6px; letter-spacing: 0.5px; }
  .sidebar-section select, .sidebar-section input { width: 100%; padding: 6px 8px; background: var(--bg3); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-size: 13px; }
  .nav { flex: 1; overflow-y: auto; padding: 8px 0; }
  .nav-item { display: block; width: 100%; padding: 8px 16px; background: none; border: none; color: var(--text2); text-align: left; cursor: pointer; font-size: 13px; font-family: var(--font); }
  .nav-item:hover { background: var(--bg3); color: var(--text); }
  .nav-item.active { background: var(--bg3); color: var(--accent); border-left: 2px solid var(--accent); }
  .main { flex: 1; overflow-y: auto; padding: 24px; }
  .panel { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 16px; }
  .panel-header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .panel-header h2 { font-size: 14px; font-weight: 600; }
  .panel-body { padding: 16px; }
  .panel-body.no-pad { padding: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
  th { color: var(--text2); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; background: var(--bg); }
  td { vertical-align: top; }
  .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
  .badge-green { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-red { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge-yellow { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .badge-blue { background: rgba(88,166,255,0.15); color: var(--accent); }
  .btn { padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg3); color: var(--text); cursor: pointer; font-size: 12px; font-family: var(--font); }
  .btn:hover { background: var(--border); }
  .btn-primary { background: rgba(88,166,255,0.15); border-color: var(--accent); color: var(--accent); }
  .btn-danger { background: rgba(248,81,73,0.1); border-color: var(--red); color: var(--red); }
  .btn-sm { padding: 3px 8px; font-size: 11px; }
  .empty { color: var(--text2); font-style: italic; padding: 24px; text-align: center; }
  .status { display: flex; align-items: center; gap: 8px; padding: 12px 16px; font-size: 12px; color: var(--text2); border-top: 1px solid var(--border); }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .dot-green { background: var(--green); }
  .dot-red { background: var(--red); }
  .dot-yellow { background: var(--yellow); }
  .form-row { display: flex; gap: 8px; margin-bottom: 8px; }
  .form-row input, .form-row textarea { flex: 1; padding: 6px 8px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-family: var(--font); font-size: 13px; }
  .form-row textarea { min-height: 60px; resize: vertical; }
  .json-view { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; font-family: 'SF Mono', monospace; font-size: 12px; color: var(--text2); max-height: 300px; overflow-y: auto; }
  .tool-call { border: 1px solid var(--border); border-radius: 4px; margin-bottom: 8px; overflow: hidden; }
  .tool-call-header { padding: 8px 12px; background: var(--bg); display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
  .tool-call-header:hover { background: var(--bg3); }
  .tool-call-body { padding: 12px; border-top: 1px solid var(--border); display: none; }
  .tool-call.expanded .tool-call-body { display: block; }
  .message { padding: 12px; border-bottom: 1px solid var(--border); }
  .message:last-child { border-bottom: none; }
  .message-role { font-size: 11px; text-transform: uppercase; color: var(--text2); margin-bottom: 4px; letter-spacing: 0.5px; }
  .message-role.user { color: var(--accent); }
  .message-role.assistant { color: var(--green); }
  .message-role.system { color: var(--yellow); }
  .message-content { font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .tabs { display: flex; border-bottom: 1px solid var(--border); }
  .tab { padding: 8px 16px; background: none; border: none; color: var(--text2); cursor: pointer; font-size: 13px; font-family: var(--font); border-bottom: 2px solid transparent; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toast { position: fixed; bottom: 20px; right: 20px; padding: 10px 16px; border-radius: 6px; font-size: 13px; z-index: 100; animation: fadeIn 0.2s; }
  .toast-success { background: rgba(63,185,80,0.9); color: #fff; }
  .toast-error { background: rgba(248,81,73,0.9); color: #fff; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  .truncate { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .config-field { margin-bottom: 16px; }
  .config-field label { display: block; font-size: 12px; color: var(--text2); margin-bottom: 4px; }
  .config-field textarea { width: 100%; min-height: 80px; padding: 8px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-family: 'SF Mono', monospace; font-size: 12px; resize: vertical; }
  .config-field .hint { font-size: 11px; color: var(--text2); margin-top: 4px; }
</style>
</head>
<body>
<div class="app">
  <div class="sidebar">
    <h1>Agent Hub <span>Admin</span></h1>
    <div class="sidebar-section">
      <label>Agency</label>
      <select id="agencySelect" onchange="onAgencyChange()"><option value="">Sign in first</option></select>
    </div>
    <div class="sidebar-section">
      <label>Agent</label>
      <select id="agentSelect" onchange="onAgentChange()"><option value="">Select agency first</option></select>
    </div>
    <div class="nav">
      <button class="nav-item active" data-view="discover" onclick="switchView('discover')">Discover</button>
      <div style="border-top:1px solid var(--border);margin:4px 0"></div>
      <button class="nav-item" data-view="memories" onclick="switchView('memories')">Memories</button>
      <button class="nav-item" data-view="journal" onclick="switchView('journal')">Mutation Journal</button>
      <button class="nav-item" data-view="pins" onclick="switchView('pins')">Context Pins</button>
      <button class="nav-item" data-view="workspace" onclick="switchView('workspace')">Workspace Config</button>
      <button class="nav-item" data-view="inspector" onclick="switchView('inspector')">Tool Inspector</button>
      <button class="nav-item" data-view="usage" onclick="switchView('usage')">Usage & Limits</button>
      <button class="nav-item" data-view="replay" onclick="switchView('replay')">Replay</button>
      <button class="nav-item" data-view="state" onclick="switchView('state')">Agent State</button>
    </div>
    <div class="status" id="statusBar">
      <div class="dot dot-yellow"></div>
      <span>Not signed in</span>
    </div>
    <div style="padding:8px 16px;border-top:1px solid var(--border)">
      <button class="btn btn-sm" onclick="doSignOut()" style="width:100%">Sign Out</button>
    </div>
  </div>
  <div class="main" id="mainContent">
    <div class="empty"><div class="spinner"></div> Connecting...</div>
  </div>
</div>

<script>
// --- Firebase config (detected from URL: dev vs prod) ---
var auth = null;
try {
  var FIREBASE_CONFIGS = {
    dev: {
      apiKey: 'AIzaSyBbta_ee3DWNg2Vt81zVJKrmAsOnZTdCt0',
      authDomain: 'co2-target-asset-tracking-dev.firebaseapp.com',
      projectId: 'co2-target-asset-tracking-dev',
    },
    prod: {
      apiKey: 'AIzaSyDrGUku6S-PkwZ39_4q00-HnmrsEelwSW8',
      authDomain: 'co2-target-asset-tracking.firebaseapp.com',
      projectId: 'co2-target-asset-tracking',
    },
  };
  var isDev = location.hostname.includes('dev.');
  var fbConfig = isDev ? FIREBASE_CONFIGS.dev : FIREBASE_CONFIGS.prod;
  firebase.initializeApp(fbConfig);
  auth = firebase.auth();
} catch(e) {
  console.error('Firebase init failed:', e);
}

const BASE = location.origin;
let idToken = '';
let currentUser = null;
let currentAgency = '';
let currentAgent = '';
let currentView = 'discover';

// --- API helpers ---
async function api(method, path, body) {
  // Refresh token if needed
  if (currentUser) {
    idToken = await currentUser.getIdToken();
  }
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers['Authorization'] = 'Bearer ' + idToken;
  // Fallback: also send as X-SECRET for backwards compat with key-based auth
  const keyParam = new URLSearchParams(location.search).get('key');
  if (keyParam) headers['X-SECRET'] = keyParam;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  if (!res.ok) throw new Error(res.status + ': ' + (await res.text()));
  return res.json();
}

async function action(type, payload = {}) {
  return api('POST', '/agency/' + currentAgency + '/agent/' + currentAgent + '/action', { type, ...payload });
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function setStatus(color, text) {
  document.getElementById('statusBar').innerHTML = '<div class="dot dot-' + color + '"></div><span>' + text + '</span>';
}

// --- Auth ---
function showSignIn() {
  document.getElementById('agencySelect').innerHTML = '<option value="">Sign in first</option>';
  document.getElementById('mainContent').innerHTML = '<div class="panel" style="max-width:400px;margin:80px auto">' +
    '<div class="panel-header"><h2>Sign In</h2></div><div class="panel-body">' +
    '<p style="color:var(--text2);margin-bottom:12px">Sign in with your CO2 account.</p>' +
    '<div class="form-row"><input id="emailInput" type="email" placeholder="Email" autofocus></div>' +
    '<div class="form-row"><input id="passInput" type="password" placeholder="Password"></div>' +
    '<div id="authError" style="color:var(--red);font-size:12px;margin-bottom:8px;display:none"></div>' +
    '<div class="form-row"><button class="btn btn-primary" onclick="doSignIn()" id="signInBtn">Sign In</button></div>' +
    '</div></div>';
  document.getElementById('passInput')?.addEventListener('keydown', function(e) { if (e.key === 'Enter') doSignIn(); });
}

async function doSignIn() {
  var email = document.getElementById('emailInput')?.value?.trim();
  var pass = document.getElementById('passInput')?.value;
  if (!email || !pass) return toast('Email and password required', 'error');
  var btn = document.getElementById('signInBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in...'; }
  var errEl = document.getElementById('authError');
  if (errEl) errEl.style.display = 'none';
  try {
    if (!auth) throw new Error('Firebase not available. Use ?key=YOUR_SECRET instead.');
    await auth.signInWithEmailAndPassword(email, pass);
    // onAuthStateChanged will handle the rest
  } catch (e) {
    if (errEl) { errEl.textContent = e.message.replace('Firebase: ', ''); errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
  }
}

function doSignOut() {
  if (auth) auth.signOut();
  else { currentUser = null; idToken = ''; showSignIn(); }
}

// Firebase auth state listener
if (auth) {
  auth.onAuthStateChanged(async function(user) {
    if (user) {
      currentUser = user;
      idToken = await user.getIdToken();
      setStatus('green', user.email);
      init();
    } else {
      currentUser = null;
      idToken = '';
      setStatus('yellow', 'Not signed in');
      var keyParam = new URLSearchParams(location.search).get('key');
      if (keyParam) {
        init();
      } else {
        showSignIn();
      }
    }
  });
} else {
  // Firebase failed to load — fall back immediately
  showSignIn();
}

async function init() {
  try {
    const agenciesRes = await api('GET', '/agencies');
    const agencies = Array.isArray(agenciesRes) ? agenciesRes : (agenciesRes.agencies || []);
    const sel = document.getElementById('agencySelect');
    sel.innerHTML = '<option value="">Select agency...</option>';
    agencies.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id || a.name || a;
      opt.textContent = a.name || a.id || a;
      sel.appendChild(opt);
    });
    setStatus('green', currentUser ? currentUser.email : 'Connected');
    loadView();
  } catch (e) {
    if (e.message.includes('401') || e.message.includes('403')) {
      toast('Access denied', 'error');
      if (currentUser) { auth.signOut(); }
      else { showSignIn(); }
    } else {
      setStatus('red', 'Error: ' + e.message);
    }
  }
}

async function onAgencyChange() {
  currentAgency = document.getElementById('agencySelect').value;
  currentAgent = '';
  if (!currentAgency) return;
  try {
    const agentsRes = await api('GET', '/agency/' + currentAgency + '/agents');
    const agentList = Array.isArray(agentsRes) ? agentsRes : (agentsRes.agents || []);
    const sel = document.getElementById('agentSelect');
    sel.innerHTML = '<option value="">Select agent...</option>';
    agentList.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id || a.name || a;
      opt.textContent = (a.name || a.id || a) + (a.agentType ? ' (' + a.agentType + ')' : '');
      sel.appendChild(opt);
    });
  } catch (e) {
    toast('Failed to load agents: ' + e.message, 'error');
  }
}

async function onAgentChange() {
  currentAgent = document.getElementById('agentSelect').value;
  if (!currentAgent) return;
  setStatus('green', 'Agent: ' + currentAgent.slice(0, 8) + '...');
  loadView();
}

// --- Views ---
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  loadView();
}

async function loadView() {
  // Discover view works without agent selection
  if (currentView === 'discover') {
    await loadDiscover();
    return;
  }
  if (!currentAgency || !currentAgent) {
    document.getElementById('mainContent').innerHTML = '<div class="empty">Select an agency and agent above to inspect it.</div>';
    return;
  }
  const main = document.getElementById('mainContent');
  main.innerHTML = '<div class="empty"><div class="spinner"></div> Loading...</div>';
  try {
    switch (currentView) {
      case 'memories': await loadMemories(); break;
      case 'journal': await loadJournal(); break;
      case 'pins': await loadPins(); break;
      case 'workspace': await loadWorkspace(); break;
      case 'inspector': await loadInspector(); break;
      case 'usage': await loadUsage(); break;
      case 'replay': await loadReplay(); break;
      case 'state': await loadState(); break;
    }
  } catch (e) {
    main.innerHTML = '<div class="panel"><div class="panel-body"><div class="empty">Error: ' + esc(e.message) + '</div></div></div>';
  }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// --- Discover ---
async function loadDiscover() {
  var main = document.getElementById('mainContent');
  main.innerHTML = '<div class="empty"><div class="spinner"></div> Loading...</div>';

  try {
    // Use D1-backed admin API for instant cross-agent queries
    var statsRes = await api('GET', '/admin/api/stats');
    var activityRes = await api('GET', '/admin/api/activity');
    var agents = activityRes.agents || [];

    var html = '';

    // Stats bar
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:16px">';
    html += '<div style="padding:12px;background:var(--bg2);border:1px solid var(--border);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Total Agents</div><div style="font-size:24px;font-weight:600">' + (statsRes.total_agents || 0).toLocaleString() + '</div></div>';
    html += '<div style="padding:12px;background:var(--bg2);border:1px solid var(--border);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Active (24h)</div><div style="font-size:24px;font-weight:600">' + (statsRes.active_24h || 0) + '</div></div>';
    html += '<div style="padding:12px;background:var(--bg2);border:1px solid var(--border);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Messages</div><div style="font-size:24px;font-weight:600">' + (statsRes.total_messages || 0).toLocaleString() + '</div></div>';
    html += '<div style="padding:12px;background:var(--bg2);border:1px solid var(--border);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Memories</div><div style="font-size:24px;font-weight:600">' + (statsRes.total_memories || 0).toLocaleString() + '</div></div>';
    html += '</div>';

    if (agents.length === 0 && !statsRes.error) {
      html += '<div class="panel"><div class="panel-body"><div class="empty">No agent activity recorded yet. Activity is indexed as agents are used.</div></div></div>';
    } else if (statsRes.error) {
      html += '<div class="panel"><div class="panel-body"><div class="empty">D1 admin index not configured. Deploy with ADMIN_DB binding to enable discovery.</div></div></div>';
    }

    // Recent agents
    if (agents.length > 0) {
      html += '<div class="panel"><div class="panel-header"><h2>Recent Agents</h2><button class="btn btn-sm" onclick="loadDiscover()">Refresh</button></div>';
      html += '<div class="panel-body no-pad">';
      html += '<table><tr><th>Agent</th><th>Agency</th><th>Type</th><th>Messages</th><th>Memories</th><th>Last Active</th><th></th></tr>';
      agents.forEach(function(a) {
        html += '<tr>';
        html += '<td class="mono" style="font-size:12px">' + esc((a.agent_id || '').slice(0, 12)) + '...</td>';
        html += '<td>' + esc(a.agency_id || '') + '</td>';
        html += '<td><span class="badge badge-blue">' + esc(a.agent_type || '-') + '</span></td>';
        html += '<td>' + (a.message_count || 0) + '</td>';
        html += '<td>' + (a.memory_count || 0) + '</td>';
        html += '<td class="mono" style="font-size:11px;color:var(--text2)">' + (a.last_active_at ? new Date(a.last_active_at).toLocaleString() : '-') + '</td>';
        html += '<td><button class="btn btn-sm" onclick="selectAgent(&apos;' + esc(a.agency_id || '') + '&apos;,&apos;' + esc(a.agent_id || '') + '&apos;)">Inspect</button></td>';
        html += '</tr>';
      });
      html += '</table></div></div>';
    }

    main.innerHTML = html;
  } catch(e) {
    main.innerHTML = '<div class="panel"><div class="panel-body"><div class="empty">Error: ' + esc(e.message) + '</div></div></div>';
  }
}

function selectAgent(agency, agent) {
  currentAgency = agency;
  currentAgent = agent;
  document.getElementById('agencySelect').value = agency;
  // Trigger agent list load then select the agent
  onAgencyChange().then(function() {
    document.getElementById('agentSelect').value = agent;
    currentAgent = agent;
    setStatus('green', 'Agent: ' + agent.slice(0, 8) + '...');
    switchView('memories');
  });
}

// --- Memories ---
async function loadMemories() {
  const data = await action('browseMemories');
  const main = document.getElementById('mainContent');
  let html = '<div class="panel"><div class="panel-header"><h2>Memories (' + data.count + ')</h2><button class="btn btn-primary btn-sm" onclick="showAddMemory()">+ Add</button></div>';
  html += '<div class="panel-body no-pad">';
  if (data.count === 0) {
    html += '<div class="empty">No memories stored for this agent.</div>';
  } else {
    html += '<table><tr><th>Key</th><th>Value</th><th>Updated</th><th></th></tr>';
    data.memories.forEach(m => {
      html += '<tr><td class="mono">' + esc(m.key) + '</td><td class="truncate">' + esc(m.value) + '</td>';
      html += '<td class="mono" style="font-size:11px;color:var(--text2)">' + new Date(m.updatedAt).toLocaleString() + '</td>';
      html += '<td><button class="btn btn-sm" onclick="editMemory(&apos;'+esc(m.key)+'&apos;,&apos;'+esc(m.value)+'&apos;)" title="Edit">Edit</button> ';
      html += '<button class="btn btn-danger btn-sm" onclick="delMemory(&apos;'+esc(m.key)+'&apos;)" title="Delete">Del</button></td></tr>';
    });
    html += '</table>';
  }
  html += '</div></div>';
  html += '<div id="memoryForm"></div>';
  main.innerHTML = html;
}

function showAddMemory(key, value) {
  const el = document.getElementById('memoryForm');
  el.innerHTML = '<div class="panel"><div class="panel-header"><h2>' + (key ? 'Edit' : 'Add') + ' Memory</h2></div><div class="panel-body">' +
    '<div class="form-row"><input id="memKey" placeholder="Key" value="' + esc(key || '') + '" ' + (key ? 'readonly' : '') + '></div>' +
    '<div class="form-row"><textarea id="memVal" placeholder="Value">' + esc(value || '') + '</textarea></div>' +
    '<div class="form-row"><button class="btn btn-primary" onclick="saveMemory()">Save</button> <button class="btn" onclick="document.getElementById(&apos;memoryForm&apos;).innerHTML=&apos;&apos;">Cancel</button></div>' +
    '</div></div>';
}

function editMemory(key, value) { showAddMemory(key, value); }

async function saveMemory() {
  const key = document.getElementById('memKey').value.trim();
  const value = document.getElementById('memVal').value.trim();
  if (!key || !value) return toast('Key and value required', 'error');
  await action('setMemory', { key, value });
  toast('Memory saved: ' + key);
  loadMemories();
}

async function delMemory(key) {
  if (!confirm('Delete memory "' + key + '"?')) return;
  await action('deleteMemory', { key });
  toast('Memory deleted: ' + key);
  loadMemories();
}

// --- Journal ---
async function loadJournal() {
  const data = await action('browseJournal');
  const main = document.getElementById('mainContent');
  let html = '<div class="panel"><div class="panel-header"><h2>Mutation Journal (' + data.count + ')</h2><button class="btn btn-sm" onclick="loadJournal()">Refresh</button></div>';
  html += '<div class="panel-body no-pad">';
  if (data.count === 0) {
    html += '<div class="empty">No journal entries. Entries are created when the agent performs mutations.</div>';
  } else {
    html += '<table><tr><th>#</th><th>Entry</th></tr>';
    data.entries.forEach((e, i) => {
      html += '<tr><td class="mono" style="color:var(--text2)">' + (i+1) + '</td><td class="mono">' + esc(e) + '</td></tr>';
    });
    html += '</table>';
  }
  html += '</div></div>';
  main.innerHTML = html;
}

// --- Pins ---
async function loadPins() {
  const data = await action('browsePins');
  const main = document.getElementById('mainContent');
  let html = '<div class="panel"><div class="panel-header"><h2>Context Pins (' + data.count + ')</h2><button class="btn btn-sm" onclick="loadPins()">Refresh</button></div>';
  html += '<div class="panel-body no-pad">';
  if (data.count === 0) {
    html += '<div class="empty">No pinned context. Pins are set when the agent encounters important state.</div>';
  } else {
    html += '<table><tr><th>Label</th><th>Content</th></tr>';
    Object.entries(data.pins).forEach(([k, v]) => {
      html += '<tr><td class="mono">' + esc(k) + '</td><td class="mono" style="white-space:pre-wrap">' + esc(v) + '</td></tr>';
    });
    html += '</table>';
  }
  html += '</div></div>';
  main.innerHTML = html;
}

// --- Workspace Config ---
async function loadWorkspace() {
  const data = await action('browseWorkspaceConfig');
  const main = document.getElementById('mainContent');
  let html = '<div class="panel"><div class="panel-header"><h2>Workspace Configuration</h2><button class="btn btn-sm" onclick="loadWorkspace()">Refresh</button></div>';
  html += '<div class="panel-body">';

  // Resolved summary
  html += '<div style="margin-bottom:16px;padding:12px;background:var(--bg);border-radius:4px">';
  html += '<strong style="color:var(--text2);font-size:11px;text-transform:uppercase">Resolved Config</strong><br>';
  const rc = data.resolvedConfig;
  html += '<span class="badge badge-blue">' + (rc.guidance ? 'Guidance set' : 'No guidance') + '</span> ';
  html += '<span class="badge badge-blue">' + (rc.terminology ? Object.keys(rc.terminology).length + ' terms' : '0 terms') + '</span> ';
  html += '<span class="badge ' + (rc.blockedActions?.length ? 'badge-red' : 'badge-blue') + '">' + (rc.blockedActions?.length || 0) + ' blocked</span> ';
  html += '<span class="badge badge-green">' + (rc.virtualToolCount || 0) + ' virtual tools</span> ';
  html += '<span class="badge badge-green">' + (rc.toolHookCount || 0) + ' tool hooks</span>';
  html += '</div>';

  // Editable fields
  const fields = [
    { key: 'WORKSPACE_GUIDANCE', label: 'Guidance', hint: 'Free-text guidance injected into agent system prompt' },
    { key: 'WORKSPACE_TERMINOLOGY', label: 'Terminology (JSON)', hint: '{"term": "definition"} — domain-specific vocabulary' },
    { key: 'WORKSPACE_BLOCKED_ACTIONS', label: 'Blocked Actions', hint: 'Comma-separated action IDs the agent must refuse' },
    { key: 'WORKSPACE_VIRTUAL_TOOLS', label: 'Virtual Tools (JSON)', hint: '[{"name":"...", "description":"...", "response":"..."}]' },
    { key: 'WORKSPACE_TOOL_HOOKS', label: 'Tool Hooks (JSON)', hint: '[{"tool":"...", "before":"...", "after":"..."}]' },
  ];

  fields.forEach(f => {
    const val = data.individualVars[f.key] || '';
    html += '<div class="config-field"><label>' + f.label + '</label>';
    html += '<textarea id="ws_' + f.key + '" rows="3">' + esc(typeof val === 'string' ? val : JSON.stringify(val, null, 2)) + '</textarea>';
    html += '<div class="hint">' + f.hint + '</div></div>';
  });

  html += '<button class="btn btn-primary" onclick="saveWorkspace()">Save All</button> ';
  html += '<button class="btn" onclick="loadWorkspace()">Reset</button>';
  html += '</div></div>';

  // Manifest JSON
  if (data.manifest) {
    html += '<div class="panel"><div class="panel-header"><h2>Raw Manifest</h2></div>';
    html += '<div class="panel-body"><div class="json-view">' + esc(JSON.stringify(data.manifest, null, 2)) + '</div></div></div>';
  }

  main.innerHTML = html;
}

async function saveWorkspace() {
  const fields = ['WORKSPACE_GUIDANCE', 'WORKSPACE_TERMINOLOGY', 'WORKSPACE_BLOCKED_ACTIONS', 'WORKSPACE_VIRTUAL_TOOLS', 'WORKSPACE_TOOL_HOOKS'];
  let saved = 0;
  for (const key of fields) {
    const el = document.getElementById('ws_' + key);
    if (!el) continue;
    const val = el.value.trim();
    if (val) {
      await api('PUT', '/agency/' + currentAgency + '/vars/' + key, { value: val });
      saved++;
    } else {
      try { await api('DELETE', '/agency/' + currentAgency + '/vars/' + key); } catch(e) {}
    }
  }
  toast('Saved ' + saved + ' workspace vars');
  loadWorkspace();
}

// --- Tool Inspector ---
async function loadInspector() {
  const state = await api('GET', '/agency/' + currentAgency + '/agent/' + currentAgent + '/state');
  const main = document.getElementById('mainContent');
  const messages = state.messages || [];

  // Extract tool calls from messages
  const toolCalls = [];
  messages.forEach((msg, i) => {
    if (msg.role === 'assistant' && msg.tool_calls) {
      msg.tool_calls.forEach(tc => {
        toolCalls.push({ index: i, ...tc });
      });
    }
    // Also check for tool_use content blocks (Anthropic format)
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      msg.content.forEach(block => {
        if (block.type === 'tool_use') {
          toolCalls.push({ index: i, id: block.id, function: { name: block.name, arguments: JSON.stringify(block.input) } });
        }
      });
    }
  });

  // Tool results
  const toolResults = {};
  messages.forEach(msg => {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResults[msg.tool_call_id] = msg.content;
    }
  });

  let html = '<div class="panel"><div class="panel-header"><h2>Tool Inspector (' + toolCalls.length + ' calls)</h2>';
  html += '<button class="btn btn-sm" onclick="loadInspector()">Refresh</button></div>';

  if (toolCalls.length === 0) {
    html += '<div class="panel-body"><div class="empty">No tool calls in this conversation.</div></div>';
  } else {
    html += '<div class="panel-body">';
    toolCalls.forEach((tc, i) => {
      const name = tc.function?.name || tc.name || 'unknown';
      const args = tc.function?.arguments || (tc.input ? JSON.stringify(tc.input) : '{}');
      const result = toolResults[tc.id];
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      const isTruncated = resultStr && resultStr.length > 500;

      html += '<div class="tool-call" onclick="this.classList.toggle(&apos;expanded&apos;)">';
      html += '<div class="tool-call-header">';
      html += '<span><span class="badge badge-blue">' + esc(name) + '</span> <span class="mono" style="color:var(--text2);font-size:11px">#' + (i+1) + '</span></span>';
      html += '<span style="color:var(--text2);font-size:11px">' + (result !== undefined ? (typeof result === 'string' && result.includes('error') ? '<span class="badge badge-red">error</span>' : '<span class="badge badge-green">ok</span>') : '<span class="badge badge-yellow">pending</span>') + '</span>';
      html += '</div>';
      html += '<div class="tool-call-body">';
      html += '<div style="margin-bottom:8px"><strong style="font-size:11px;color:var(--text2)">ARGUMENTS</strong></div>';
      html += '<div class="json-view">' + esc(formatJson(args)) + '</div>';
      if (result !== undefined) {
        html += '<div style="margin:8px 0"><strong style="font-size:11px;color:var(--text2)">RESULT</strong></div>';
        html += '<div class="json-view">' + esc(isTruncated ? resultStr.slice(0, 500) + '\\n... (' + resultStr.length + ' chars)' : (resultStr || '(empty)')) + '</div>';
      }
      html += '</div></div>';
    });
    html += '</div>';
  }
  html += '</div>';

  // Conversation timeline
  html += '<div class="panel"><div class="panel-header"><h2>Conversation (' + messages.length + ' messages)</h2></div>';
  html += '<div class="panel-body no-pad">';
  messages.forEach(msg => {
    const role = msg.role || 'unknown';
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map(b => b.text || b.type || '').join('\\n');
    }
    if (content.length > 500) content = content.slice(0, 500) + '... (' + (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)).length + ' chars)';
    html += '<div class="message"><div class="message-role ' + role + '">' + role + '</div>';
    html += '<div class="message-content">' + esc(content || '(tool call)') + '</div></div>';
  });
  html += '</div></div>';

  main.innerHTML = html;
}

function formatJson(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch(e) { return s; }
}

// --- Usage & Limits ---
async function loadUsage() {
  let rateData, fallbackData;
  try { rateData = await action('browseUsage'); } catch(e) { rateData = null; }
  try { fallbackData = await action('browseFallbackState'); } catch(e) { fallbackData = null; }
  const main = document.getElementById('mainContent');
  let html = '';

  // Rate limiting
  html += '<div class="panel"><div class="panel-header"><h2>Rate Limiting</h2><button class="btn btn-sm" onclick="loadUsage()">Refresh</button></div>';
  html += '<div class="panel-body">';
  if (!rateData) {
    html += '<div class="empty">Rate limiting plugin not active on this agent.</div>';
  } else {
    const cw = rateData.currentWindow;
    const cc = rateData.currentConversation;
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:16px">';
    // Token usage
    const tokenPct = cw.tokensLimit > 0 ? Math.round((cw.tokensUsed / cw.tokensLimit) * 100) : 0;
    const tokenColor = tokenPct > 80 ? 'var(--red)' : tokenPct > 50 ? 'var(--yellow)' : 'var(--green)';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Tokens This Hour</div>';
    html += '<div style="font-size:20px;font-weight:600;color:' + tokenColor + '">' + (cw.tokensUsed || 0).toLocaleString() + '</div>';
    html += '<div style="font-size:11px;color:var(--text2)">of ' + (cw.tokensLimit || 0).toLocaleString() + ' (' + tokenPct + '%)</div></div>';
    // Conversations
    const convoPct = cw.conversationsLimit > 0 ? Math.round((cw.conversationsUsed / cw.conversationsLimit) * 100) : 0;
    const convoColor = convoPct > 80 ? 'var(--red)' : convoPct > 50 ? 'var(--yellow)' : 'var(--green)';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Conversations This Hour</div>';
    html += '<div style="font-size:20px;font-weight:600;color:' + convoColor + '">' + (cw.conversationsUsed || 0) + '</div>';
    html += '<div style="font-size:11px;color:var(--text2)">of ' + (cw.conversationsLimit || 0) + ' (' + convoPct + '%)</div></div>';
    // Current conversation
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">This Conversation</div>';
    html += '<div style="font-size:20px;font-weight:600">' + (cc.tokensUsed || 0).toLocaleString() + '</div>';
    html += '<div style="font-size:11px;color:var(--text2)">of ' + (cc.tokensLimit || 0).toLocaleString() + ' limit</div></div>';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Status</div>';
    html += '<div style="font-size:14px;font-weight:600">' + (rateData.enabled ? '<span class="badge badge-green">Enabled</span>' : '<span class="badge badge-yellow">Disabled</span>') + '</div></div>';
    html += '</div>';
    // 24h history
    if (rateData.history24h && rateData.history24h.length > 0) {
      html += '<table><tr><th>Hour</th><th>Tokens</th><th>Conversations</th></tr>';
      rateData.history24h.forEach(function(h) {
        html += '<tr><td class="mono" style="font-size:11px">' + h.hour + '</td><td>' + (h.tokens || 0).toLocaleString() + '</td><td>' + (h.conversations || 0) + '</td></tr>';
      });
      html += '</table>';
    }
    html += '<div style="margin-top:12px"><button class="btn btn-danger btn-sm" onclick="resetUsage()">Reset Current Window</button></div>';
  }
  html += '</div></div>';

  // Model fallback
  html += '<div class="panel"><div class="panel-header"><h2>Model Fallback</h2></div>';
  html += '<div class="panel-body">';
  if (!fallbackData) {
    html += '<div class="empty">Model fallback plugin not active on this agent.</div>';
  } else {
    const cs = fallbackData.currentState;
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Fallback Status</div>';
    html += '<div style="font-size:14px;font-weight:600">' + (cs.active ? '<span class="badge badge-yellow">Active: ' + esc(cs.reason || '') + '</span>' : '<span class="badge badge-green">Primary Model</span>') + '</div></div>';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Fallback Model</div>';
    html += '<div style="font-size:13px;font-weight:600 mono">' + esc(fallbackData.fallbackModel) + '</div></div>';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Token Threshold</div>';
    html += '<div style="font-size:20px;font-weight:600">' + (fallbackData.tokenThreshold || 0).toLocaleString() + '</div>';
    html += '<div style="font-size:11px;color:var(--text2)">Current: ' + (cs.totalTokens || 0).toLocaleString() + '</div></div>';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Consecutive Errors</div>';
    html += '<div style="font-size:20px;font-weight:600">' + (cs.consecutiveErrors || 0) + '</div></div>';
    html += '</div>';
  }
  html += '</div></div>';

  main.innerHTML = html;
}

async function resetUsage() {
  if (!confirm('Reset usage counters for the current hour?')) return;
  await action('resetUsage');
  toast('Usage counters reset');
  loadUsage();
}

// --- Replay ---
async function loadReplay() {
  let runsData;
  try { runsData = await action('browseRuns'); } catch(e) { runsData = null; }
  const main = document.getElementById('mainContent');
  let html = '';

  html += '<div class="panel"><div class="panel-header"><h2>Conversation Runs</h2>';
  html += '<span><button class="btn btn-primary btn-sm" onclick="saveCurrentRun()">Save Current</button> ';
  html += '<button class="btn btn-sm" onclick="loadReplay()">Refresh</button></span></div>';
  html += '<div class="panel-body no-pad">';

  if (!runsData || !runsData.runs || runsData.runs.length === 0) {
    html += '<div class="empty">No saved runs. Enable auto-save with HISTORY_ENABLED=true, or click "Save Current" to snapshot the active conversation.</div>';
  } else {
    html += '<table><tr><th>ID</th><th>Name</th><th>Messages</th><th>Tool Calls</th><th>Created</th><th></th></tr>';
    runsData.runs.forEach(function(r) {
      html += '<tr><td class="mono">' + r.id + '</td>';
      html += '<td>' + esc(r.name) + '</td>';
      html += '<td>' + r.messageCount + '</td>';
      html += '<td>' + r.toolCallCount + '</td>';
      html += '<td class="mono" style="font-size:11px;color:var(--text2)">' + new Date(r.createdAt).toLocaleString() + '</td>';
      html += '<td><button class="btn btn-sm" onclick="viewRun(' + r.id + ')">View</button> ';
      html += '<button class="btn btn-danger btn-sm" onclick="deleteRun(' + r.id + ')">Del</button></td></tr>';
    });
    html += '</table>';
  }
  html += '</div></div>';
  html += '<div id="replayDetail"></div>';
  main.innerHTML = html;
}

async function saveCurrentRun() {
  var name = prompt('Run name (leave empty for auto):');
  var payload = name ? { name: name } : {};
  try {
    var result = await action('saveRun', payload);
    if (result.error) { toast(result.error, 'error'); return; }
    toast('Saved: ' + (result.saved || 'ok'));
    loadReplay();
  } catch(e) { toast('Failed: ' + e.message, 'error'); }
}

async function deleteRun(id) {
  if (!confirm('Delete run #' + id + '?')) return;
  await action('deleteRun', { id: id });
  toast('Deleted run #' + id);
  loadReplay();
}

async function viewRun(id) {
  var data = await action('loadRun', { id: id });
  if (data.error) { toast(data.error, 'error'); return; }
  var el = document.getElementById('replayDetail');
  var html = '<div class="panel"><div class="panel-header"><h2>Run: ' + esc(data.name) + '</h2>';
  html += '<span class="mono" style="font-size:11px;color:var(--text2)">' + data.messageCount + ' messages, ' + data.toolCallCount + ' tool calls, ' + new Date(data.createdAt).toLocaleString() + '</span></div>';

  // Tool calls timeline
  if (data.toolCalls && data.toolCalls.length > 0) {
    html += '<div class="panel-body"><strong style="font-size:11px;color:var(--text2);text-transform:uppercase">Tool Calls</strong>';
    data.toolCalls.forEach(function(tc, i) {
      html += '<div class="tool-call" onclick="this.classList.toggle(&apos;expanded&apos;)">';
      html += '<div class="tool-call-header"><span><span class="badge badge-blue">' + esc(tc.name) + '</span> <span class="mono" style="color:var(--text2);font-size:11px">#' + (i+1) + '</span></span></div>';
      html += '<div class="tool-call-body"><div class="json-view">' + esc(formatJson(tc.args || '{}')) + '</div></div>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Messages
  html += '<div class="panel-body no-pad">';
  html += '<div style="padding:8px 12px;border-bottom:1px solid var(--border)"><strong style="font-size:11px;color:var(--text2);text-transform:uppercase">Conversation</strong></div>';
  (data.messages || []).forEach(function(msg) {
    var role = msg.role || 'unknown';
    var content = '';
    if (typeof msg.content === 'string') { content = msg.content; }
    else if (Array.isArray(msg.content)) { content = msg.content.map(function(b) { return b.text || b.type || ''; }).join('\\n'); }
    if (content.length > 500) content = content.slice(0, 500) + '...';
    html += '<div class="message"><div class="message-role ' + role + '">' + role + '</div>';
    html += '<div class="message-content">' + esc(content || '(tool call)') + '</div></div>';
  });
  html += '</div></div>';
  el.innerHTML = html;
}

// --- Agent State ---
async function loadState() {
  const state = await api('GET', '/agency/' + currentAgency + '/agent/' + currentAgent + '/state');
  const main = document.getElementById('mainContent');
  let html = '<div class="panel"><div class="panel-header"><h2>Agent State</h2><button class="btn btn-sm" onclick="loadState()">Refresh</button></div>';
  html += '<div class="panel-body">';

  // Summary
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:16px">';
  html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Messages</div><div style="font-size:20px;font-weight:600">' + (state.messages?.length || 0) + '</div></div>';
  html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Agent Type</div><div style="font-size:14px;font-weight:600">' + esc(state.agentType || state.info?.agentType || '-') + '</div></div>';
  html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Run State</div><div style="font-size:14px;font-weight:600">' + esc(state.runState || '-') + '</div></div>';
  html += '</div>';

  // Raw state
  html += '<div class="json-view" style="max-height:500px">' + esc(JSON.stringify(state, null, 2)) + '</div>';
  html += '</div></div>';
  main.innerHTML = html;
}

// Boot — Firebase onAuthStateChanged handles init.
// Fallback: if Firebase doesn't fire within 3s (e.g. blocked by ad-blocker),
// show sign-in or try legacy key auth.
setTimeout(function() {
  if (!currentUser && !document.getElementById('emailInput')) {
    var keyParam = new URLSearchParams(location.search).get('key');
    if (keyParam) { init(); } else { showSignIn(); }
  }
}, 3000);
</script>
</body>
</html>`;
}
