// Admin panel HTML — self-contained (inline CSS + vanilla JS), dark/purple Aura theme.
// All dynamic strings go through textContent, never innerHTML (XSS from account names).

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aura · admin</title>
<style>
  :root {
    --bg: #0f0f16; --panel: #17171f; --panel2: #1d1d28; --line: #2a2a3a;
    --text: #e8e8f0; --dim: #9a9ab0; --accent: #8b5cf6; --accent2: #a78bfa;
    --ok: #34d399; --warn: #fbbf24; --bad: #f87171;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: "Segoe UI", system-ui, sans-serif; min-height: 100vh;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 24px; letter-spacing: 0.5px; }
  h1 .dot { color: var(--accent); }
  .sub { color: var(--dim); margin-top: 4px; font-size: 13px; }
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 14px; padding: 20px; margin-top: 20px;
  }
  /* login */
  .login { max-width: 380px; margin: 12vh auto 0; }
  .login h1 { text-align: center; }
  .login .sub { text-align: center; }
  .login .card { margin-top: 24px; }
  label { display: block; font-size: 13px; color: var(--dim); margin-bottom: 6px; }
  input[type=password], input[type=text], input[type=number] {
    width: 100%; background: var(--panel2); border: 1px solid var(--line);
    border-radius: 8px; color: var(--text); padding: 10px 12px; font-size: 14px;
    outline: none;
  }
  input:focus { border-color: var(--accent); }
  .row { display: flex; gap: 10px; align-items: center; }
  .row input { flex: 1; }
  button {
    background: var(--accent); color: #fff; border: none; border-radius: 8px;
    padding: 10px 16px; font-size: 14px; cursor: pointer; font-weight: 600;
  }
  button:hover { background: var(--accent2); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.ghost { background: transparent; border: 1px solid var(--line); color: var(--dim); }
  button.ghost:hover { border-color: var(--accent); color: var(--text); }
  button.danger { background: transparent; border: 1px solid #5c2b2b; color: var(--bad); }
  button.danger:hover { background: #2b1414; border-color: var(--bad); }
  .err { color: var(--bad); font-size: 13px; margin-top: 12px; min-height: 18px; }
  .hidden { display: none !important; }
  /* header */
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .head .spacer { flex: 1; }
  /* table */
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  tr:hover td { background: var(--panel2); }
  .mono { font-family: Consolas, monospace; font-size: 12px; color: var(--dim); }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .pill.ok { background: rgba(52, 211, 153, 0.12); color: var(--ok); }
  .pill.warn { background: rgba(251, 191, 36, 0.12); color: var(--warn); }
  .pill.bad { background: rgba(248, 113, 113, 0.12); color: var(--bad); }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .actions button { padding: 5px 10px; font-size: 12px; border-radius: 6px; font-weight: 500; }
  .muted { color: var(--dim); font-size: 12px; }
  /* modal */
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.65);
    display: flex; align-items: center; justify-content: center; z-index: 50;
  }
  .modal { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; max-width: 520px; width: 92%; padding: 24px; }
  .modal h2 { font-size: 17px; margin-bottom: 6px; }
  .modal .warn-line { color: var(--warn); font-size: 13px; margin: 10px 0; }
  .kv { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-top: 12px; }
  .kv .k { color: var(--dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; }
  .kv .v { font-family: Consolas, monospace; font-size: 14px; word-break: break-all; margin: 4px 0 8px; }
  .modal .actions { margin-top: 16px; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -2px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--panel2); border: 1px solid var(--line); color: var(--text);
    padding: 10px 18px; border-radius: 10px; font-size: 13px; z-index: 100;
    opacity: 0; transition: opacity 0.25s;
  }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
  <div class="wrap">
    <div id="loginView" class="login hidden">
      <h1>Aura<span class="dot">.</span></h1>
      <div class="sub">admin panel · api.copal.run</div>
      <div class="card">
        <label for="pw">Admin password</label>
        <input id="pw" type="password" autocomplete="current-password" autofocus>
        <div style="margin-top:14px"><button id="loginBtn" style="width:100%">Unlock</button></div>
        <div id="loginErr" class="err"></div>
      </div>
    </div>

    <div id="panel" class="hidden">
      <div class="head">
        <div>
          <h1>Aura<span class="dot">.</span> <span style="font-weight:400;color:var(--dim);font-size:16px">admin</span></h1>
          <div class="sub">accounts · sessions · downloads</div>
        </div>
        <div class="spacer"></div>
        <button id="refreshBtn" class="ghost">Refresh</button>
        <button id="logoutBtn" class="ghost">Log out</button>
      </div>

      <div class="card">
        <div class="row">
          <input id="newName" type="text" placeholder="account name (who is this for?)">
          <input id="newBudget" type="number" min="1" value="100" style="max-width:90px" title="budget GB">
          <input id="newDays" type="number" min="1" value="30" style="max-width:80px" title="lifetime days">
          <button id="createBtn">Create account</button>
        </div>
        <div id="createErr" class="err"></div>
      </div>

      <div class="card">
        <div class="row">
          <input id="relFile" type="file" accept=".zip,application/zip" style="flex:2">
          <input id="relVer" type="text" placeholder="version (e.g. v0.2.6)" style="max-width:130px" title="version for the auto-updater">
          <button id="relBtn">Upload release</button>
          <a id="relLink" href="/dl/latest" target="_blank" rel="noopener" class="ghost" style="text-decoration:none;padding:10px 16px;border-radius:8px;border:1px solid var(--line);color:var(--dim);font-size:13px;white-space:nowrap">↗ win</a>
          <a id="relMacLink" href="/dl/latest-macos" target="_blank" rel="noopener" class="ghost" style="text-decoration:none;padding:10px 16px;border-radius:8px;border:1px solid var(--line);color:var(--dim);font-size:13px;white-space:nowrap">↗ mac</a>
        </div>
        <div id="relErr" class="err"></div>
        <div class="row" style="margin-top:10px">
          <input id="srcFile" type="file" accept=".zip,application/zip" style="flex:2">
          <button id="srcBtn" class="ghost">Publish source</button>
          <a id="srcLink" href="/dl/source" target="_blank" rel="noopener" class="ghost" style="text-decoration:none;padding:10px 16px;border-radius:8px;border:1px solid var(--line);color:var(--dim);font-size:13px;white-space:nowrap">↗ src</a>
        </div>
        <div id="srcErr" class="err"></div>
      </div>

      <div class="card" style="padding:0;overflow-x:auto">
        <table>
          <thead><tr>
            <th>Name</th><th>ID</th><th>Created</th><th>Expires</th><th>Budget</th><th>Status</th><th>Live</th><th>Actions</th>
          </tr></thead>
          <tbody id="rows"></tbody>
        </table>
        <div id="tableErr" class="err" style="padding:0 20px 16px"></div>
      </div>
    </div>
  </div>

  <div id="tokenModal" class="overlay hidden">
    <div class="modal">
      <h2>Account created</h2>
      <div class="warn-line">⚠ Copy these now — the token is shown <b>once</b> and never stored.</div>
      <div class="kv">
        <div class="k">account id</div>
        <div class="v" id="tokId"></div>
        <div class="k">api token</div>
        <div class="v" id="tokTok"></div>
        <div class="k">expires</div>
        <div class="v" id="tokExp"></div>
      </div>
      <div class="actions">
        <button id="copyIdBtn" class="ghost">Copy id</button>
        <button id="copyTokBtn">Copy token</button>
        <button id="closeModalBtn" class="ghost">Done</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function fmtDate(ts) {
    var d = new Date(ts * 1000);
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function api(path, opts) {
    return fetch(path, opts || {}).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
    });
  }

  /* ---------- login ---------- */
  $('loginBtn').addEventListener('click', doLogin);
  $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

  function doLogin() {
    var pw = $('pw').value;
    if (!pw) return;
    var b = $('loginBtn');
    b.disabled = true;
    b.innerHTML = '<span class="spinner"></span>';
    $('loginErr').textContent = '';
    api('/v1/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pw })
    }).then(function (r) {
      if (!r.ok) { $('loginErr').textContent = 'Wrong password, duh.'; return; }
      showPanel();
    }).catch(function () { $('loginErr').textContent = 'Network error.'; })
      .then(function () { b.disabled = false; b.textContent = 'Unlock'; });
  }

  /* ---------- panel ---------- */
  function showPanel() {
    $('loginView').classList.add('hidden');
    $('panel').classList.remove('hidden');
    loadAccounts();
  }

  function showLogin() {
    $('panel').classList.add('hidden');
    $('loginView').classList.remove('hidden');
    $('pw').value = '';
    $('pw').focus();
  }

  $('logoutBtn').addEventListener('click', function () {
    api('/v1/admin/logout', { method: 'POST' }).then(showLogin);
  });

  $('refreshBtn').addEventListener('click', loadAccounts);

  /* ---------- accounts ---------- */
  function loadAccounts() {
    $('refreshBtn').disabled = true;
    api('/v1/admin/accounts').then(function (r) {
      $('refreshBtn').disabled = false;
      if (!r.ok) {
        if (r.status === 401) { showLogin(); return; }
        $('tableErr').textContent = 'Failed to load: ' + (r.body && r.body.error || r.status);
        return;
      }
      render(r.body.accounts || []);
    });
  }

  function pill(disabled, expired, noCredit, past) {
    if (disabled) return '<span class="pill bad">disabled</span>';
    if (expired) return '<span class="pill bad">expired</span>';
    if (noCredit) return '<span class="pill warn">no credit</span>';
    if (past) return '<span class="pill warn">' + past + 'd left</span>';
    return '<span class="pill ok">active</span>';
  }

  function render(list) {
    var tb = $('rows');
    tb.textContent = '';
    if (!list.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'muted';
      td.textContent = 'No accounts yet. Create one above.';
      tr.appendChild(td);
      tb.appendChild(tr);
      return;
    }
    var now = Math.floor(Date.now() / 1000);
    list.forEach(function (a) {
      var past = a.expires_at <= now ? 0 : Math.floor((a.expires_at - now) / 86400);
      var tr = document.createElement('tr');

      var tdName = document.createElement('td');
      tdName.textContent = a.name;
      if (a.source === 'self') {
        var src = document.createElement('span');
        src.className = 'pill'; // reuse pill styling; textContent = safe
        src.style.fontSize = '10px';
        src.style.marginLeft = '6px';
        src.style.verticalAlign = '1px';
        src.textContent = 'self';
        tdName.appendChild(src);
      }

      var tdId = document.createElement('td');
      tdId.className = 'mono';
      tdId.textContent = a.id;

      var tdCreated = document.createElement('td');
      tdCreated.className = 'muted';
      tdCreated.textContent = fmtDate(a.created_at);

      var tdExp = document.createElement('td');
      tdExp.textContent = fmtDate(a.expires_at);
      if (a.expires_at <= now) tdExp.style.color = 'var(--bad)';

      var tdBudget = document.createElement('td');
      tdBudget.textContent = String(a.budget_gb) + ' GB';

      var tdStatus = document.createElement('td');
      tdStatus.innerHTML = pill(!!a.disabled, a.expires_at <= now, a.expires_at === 0, past); // static strings only

      var tdLive = document.createElement('td');
      tdLive.textContent = String(a.active_sessions);

      var tdActions = document.createElement('td');
      tdActions.className = 'actions';

      var bExt = mkBtn('+30d', function () { act(a.id, '/extend', { days: 30 }, 'Extended +30d'); });
      var bToggle = mkBtn(a.disabled ? 'Enable' : 'Disable', function () {
        act(a.id, a.disabled ? '/enable' : '/disable', {}, a.disabled ? 'Enabled' : 'Disabled');
      });
      bToggle.className = a.disabled ? 'ghost' : 'ghost danger';
      var bBudget = mkBtn('Budget', function () {
        var v = window.prompt('Budget GB for ' + a.name + ' (' + a.id + '):', String(a.budget_gb));
        if (v === null) return;
        var n = Number(v);
        if (!(n > 0)) { toast('Budget must be a positive number'); return; }
        act(a.id, '/budget', { budget_gb: n }, 'Budget set');
      });
      var bDel = mkBtn('Delete', function () {
        if (!window.confirm('Delete account "' + a.name + '" (' + a.id + ')?\\nThis kills its live sessions and cannot be undone.')) return;
        api('/v1/admin/accounts/' + a.id, { method: 'DELETE' }).then(function (r) {
          if (r.ok) { toast('Account deleted'); loadAccounts(); }
          else toast('Delete failed: ' + (r.body && r.body.error || r.status));
        });
      });
      bDel.className = 'danger';

      tdActions.appendChild(bExt);
      tdActions.appendChild(bToggle);
      tdActions.appendChild(bBudget);
      tdActions.appendChild(bDel);

      tr.appendChild(tdName); tr.appendChild(tdId); tr.appendChild(tdCreated);
      tr.appendChild(tdExp); tr.appendChild(tdBudget); tr.appendChild(tdStatus);
      tr.appendChild(tdLive); tr.appendChild(tdActions);
      tb.appendChild(tr);
    });
  }

  function mkBtn(label, onClick) {
    var b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function act(id, urlTail, payload, okMsg) {
    return api('/v1/admin/accounts/' + id + urlTail, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (r.ok) { toast(okMsg); loadAccounts(); }
      else toast('Failed: ' + (r.body && r.body.error || r.status));
    });
  }

  /* ---------- create ---------- */
  $('createBtn').addEventListener('click', createAccount);
  $('newName').addEventListener('keydown', function (e) { if (e.key === 'Enter') createAccount(); });

  function createAccount() {
    var name = $('newName').value.trim();
    if (!name) { $('createErr').textContent = 'Give the account a name first.'; return; }
    var budget = Number($('newBudget').value);
    var days = Number($('newDays').value);
    $('createBtn').disabled = true;
    $('createErr').textContent = '';
    api('/v1/admin/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name, budget_gb: budget > 0 ? budget : 100, days: days > 0 ? days : 30 })
    }).then(function (r) {
      if (!r.ok) { $('createErr').textContent = 'Create failed: ' + (r.body && r.body.error || r.status); return; }
      $('newName').value = '';
      showToken(r.body);
      loadAccounts();
    }).catch(function () { $('createErr').textContent = 'Network error.'; })
      .then(function () { $('createBtn').disabled = false; });
  }

  /* ---------- token modal ---------- */
  function showToken(body) {
    $('tokId').textContent = body.account_id;
    $('tokTok').textContent = body.token;
    $('tokExp').textContent = fmtDate(body.expires_at);
    $('tokenModal').classList.remove('hidden');
    $('copyTokBtn').focus();
  }
  $('closeModalBtn').addEventListener('click', function () { $('tokenModal').classList.add('hidden'); });
  $('tokenModal').addEventListener('click', function (e) { if (e.target === $('tokenModal')) $('tokenModal').classList.add('hidden'); });
  $('copyIdBtn').addEventListener('click', function () { copyText($('tokId').textContent, 'ID copied'); });
  $('copyTokBtn').addEventListener('click', function () { copyText($('tokTok').textContent, 'Token copied — now close this box'); });

  function copyText(txt, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast(msg); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast(msg); } catch (e) { toast('Copy failed — select it manually'); }
      document.body.removeChild(ta);
    }
  }

  /* ---------- release upload ---------- */
  $('relBtn').addEventListener('click', function () {
    var f = $('relFile').files[0];
    if (!f) { $('relErr').textContent = 'Pick a file first.'; return; }
    var fd = new FormData();
    fd.append('file', f, f.name);
    var ver = $('relVer').value.trim();
    if (ver) fd.append('version', ver);
    var b = $('relBtn');
    b.disabled = true;
    b.textContent = 'Uploading…';
    $('relErr').textContent = '';
    fetch('/v1/admin/release', { method: 'POST', body: fd }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
    }).then(function (r) {
      if (r.ok) toast('Release live at ' + r.body.url);
      else $('relErr').textContent = 'Upload failed: ' + (r.body && r.body.error || r.status);
    }).catch(function () { $('relErr').textContent = 'Network error.'; })
      .then(function () { b.disabled = false; b.textContent = 'Upload release'; });
  });

  /* ---------- source publish ---------- */
  $('srcBtn').addEventListener('click', function () {
    var f = $('srcFile').files[0];
    if (!f) { $('srcErr').textContent = 'Pick a file first.'; return; }
    var fd = new FormData();
    fd.append('file', f, f.name);
    fd.append('key', 'source');
    var b = $('srcBtn');
    b.disabled = true;
    b.textContent = 'Publishing…';
    $('srcErr').textContent = '';
    fetch('/v1/admin/release', { method: 'POST', body: fd }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
    }).then(function (r) {
      if (r.ok) toast('Source live at ' + r.body.url);
      else $('srcErr').textContent = 'Publish failed: ' + (r.body && r.body.error || r.status);
    }).catch(function () { $('srcErr').textContent = 'Network error.'; })
      .then(function () { b.disabled = false; b.textContent = 'Publish source'; });
  });

  /* ---------- boot ---------- */
  api('/v1/admin/me').then(function (r) {
    if (r.ok) showPanel(); else showLogin();
  });
})();
</script>
</body>
</html>
`;

export function serveAdminPage(): Response {
  return new Response(PAGE, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
