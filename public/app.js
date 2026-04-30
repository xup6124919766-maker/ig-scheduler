const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  type: 'image',
  files: [],
  filter: 'all',
  clientId: null,
  clients: [],
  showAllClients: false,
};

// ─── Tabs ───
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach(b => b.classList.remove('active'));
    $$('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'list') loadPosts();
    if (btn.dataset.tab === 'clients') loadClients();
  });
});

$('#logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

// ─── Type segment ───
document.querySelectorAll('.seg-btn').forEach(b => {
  b.addEventListener('click', () => {
    $$('.seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.type = b.dataset.type;
    $('#reel-options').style.display = state.type === 'reel' ? '' : 'none';
    if (state.type === 'reel' && state.files.length > 1) state.files = state.files.slice(0, 1);
    if (state.type === 'image' && state.files.length > 1) state.files = state.files.slice(0, 1);
    if (state.type === 'carousel' && state.files.length > 10) state.files = state.files.slice(0, 10);
    renderPreview();
  });
});

// ─── Dropzone ───
const dz = $('#dropzone');
const fi = $('#file-input');
dz.addEventListener('click', () => fi.click());
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', async (e) => {
  e.preventDefault();
  dz.classList.remove('drag');
  await handleFiles(e.dataTransfer.files);
});
fi.addEventListener('change', async (e) => {
  await handleFiles(e.target.files);
  fi.value = '';
});

async function handleFiles(fileList) {
  const arr = Array.from(fileList);
  if (!arr.length) return;
  const fd = new FormData();
  arr.forEach(f => fd.append('files', f));
  dz.querySelector('p').textContent = '上傳中…';
  try {
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const json = await r.json();
    state.files = state.files.concat(json.files);
    if (state.type === 'image') state.files = state.files.slice(-1);
    if (state.type === 'reel') state.files = state.files.filter(f => f.mimeType?.startsWith('video')).slice(-1);
    if (state.type === 'carousel') state.files = state.files.slice(0, 10);
    renderPreview();
  } catch (e) {
    alert('上傳失敗：' + e.message);
  }
  dz.querySelector('p').innerHTML = '把圖片 / 影片拖進來，或 <span class="link">點此選取檔案</span>';
}

function renderPreview() {
  const root = $('#preview');
  root.innerHTML = '';
  state.files.forEach((f, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'chip-img';
    const isVideo = f.mimeType?.startsWith('video');
    wrap.innerHTML = `
      ${isVideo ? `<video src="${f.url}" muted></video>` : `<img src="${f.url}">`}
      <button class="x" data-i="${i}">×</button>
      <span class="badge">${isVideo ? '影片' : '圖'}</span>
    `;
    root.appendChild(wrap);
  });
  root.querySelectorAll('.x').forEach(b => {
    b.addEventListener('click', () => {
      state.files.splice(parseInt(b.dataset.i, 10), 1);
      renderPreview();
    });
  });
}

// ─── Caption + time ───
const cap = $('#caption');
const capCount = $('#cap-count');
cap.addEventListener('input', () => capCount.textContent = cap.value.length);

const tInput = $('#schedule-time');
const localISO = (d) => {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 16);
};
tInput.value = localISO(new Date(Date.now() + 60 * 60 * 1000));

$('#now-btn').addEventListener('click', () => tInput.value = localISO(new Date(Date.now() + 60000)));
$('#plus-1h').addEventListener('click', () => tInput.value = localISO(new Date(Date.now() + 3600000)));
$('#plus-1d').addEventListener('click', () => tInput.value = localISO(new Date(Date.now() + 86400000)));

$('#submit-btn').addEventListener('click', async () => {
  if (!state.clientId) return alert('請先在右上選擇業主');
  if (!state.files.length) return alert('請先上傳素材');
  if (!tInput.value) return alert('請選排程時間');
  if (state.type === 'reel' && !state.files[0].mimeType?.startsWith('video')) return alert('Reels 必須是影片檔');

  const payload = {
    clientId: state.clientId,
    type: state.type,
    caption: cap.value,
    mediaPaths: state.files.map(f => f.url),
    scheduledAt: new Date(tInput.value).toISOString(),
    shareToFeed: $('#share-to-feed').checked,
  };
  const r = await fetch('/api/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await r.json();
  if (!r.ok) return alert('排程失敗：' + json.error);
  state.files = []; cap.value = ''; capCount.textContent = '0'; renderPreview();
  document.querySelector('[data-tab="list"]').click();
});

// ─── Posts ───
document.querySelectorAll('.chip').forEach(c => {
  c.addEventListener('click', () => {
    if (!c.dataset.filter) return;
    $$('.chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    state.filter = c.dataset.filter;
    loadPosts();
  });
});
$('#all-clients').addEventListener('change', (e) => {
  state.showAllClients = e.target.checked;
  loadPosts();
});
$('#reload-list').addEventListener('click', loadPosts);

async function loadPosts() {
  const params = new URLSearchParams();
  if (state.filter !== 'all') params.set('status', state.filter);
  if (!state.showAllClients && state.clientId) params.set('client_id', state.clientId);
  const r = await fetch('/api/posts?' + params);
  const { posts } = await r.json();
  const root = $('#post-list');
  if (!posts.length) {
    root.innerHTML = '<div class="muted small" style="padding:20px;text-align:center">沒有貼文</div>';
    return;
  }
  root.innerHTML = posts.map(p => {
    const time = new Date(p.scheduled_at).toLocaleString('zh-TW');
    const thumbs = p.media_paths.slice(0, 3).map(m => {
      const isVid = /\.(mp4|mov|m4v)$/i.test(m);
      return isVid ? `<video class="thumb" src="${m}" muted></video>` : `<img class="thumb" src="${m}">`;
    }).join('');
    const more = p.media_paths.length > 3 ? `<div class="thumb muted" style="display:flex;align-items:center;justify-content:center">+${p.media_paths.length - 3}</div>` : '';
    return `
      <div class="post-item" data-id="${p.id}">
        <div class="thumbs">${thumbs}${more}</div>
        <div class="body">
          <div class="meta">
            <span class="tag ${p.status}">${labelStatus(p.status)}</span>
            <span>${labelType(p.type)}</span>
            <span class="muted">@${p.ig_username || p.client_name || '?'}</span>
            <span>🕐 ${time}</span>
            ${p.permalink ? `<a href="${p.permalink}" target="_blank">📎 開啟貼文</a>` : ''}
          </div>
          <div class="caption">${escapeHtml(p.caption || '（無文案）')}</div>
          ${p.error ? `<div class="msg err">⚠️ ${escapeHtml(p.error)}</div>` : ''}
          <div class="actions">
            ${p.status === 'pending' ? `
              <button class="ghost" data-act="run" data-id="${p.id}">▶ 立即發送</button>
              <button class="ghost" data-act="del" data-id="${p.id}">取消</button>
            ` : ''}
            ${p.status === 'failed' ? `<button class="ghost" data-act="del" data-id="${p.id}">刪除</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  root.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', async () => {
      const id = b.dataset.id;
      if (b.dataset.act === 'run') {
        if (!confirm('要立即發送嗎？')) return;
        await fetch(`/api/posts/${id}/run`, { method: 'POST' });
      } else {
        if (!confirm('確定取消這篇排程？')) return;
        await fetch(`/api/posts/${id}`, { method: 'DELETE' });
      }
      loadPosts();
    });
  });
}

const labelStatus = (s) => ({ pending: '⏳ 待發送', publishing: '📤 發送中', posted: '✅ 已發送', failed: '❌ 失敗' }[s] || s);
const labelType = (t) => ({ image: '🖼️ 單圖', carousel: '🎞️ 輪播', reel: '🎬 Reels' }[t] || t);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ─── Clients ───
$('#add-client-btn').addEventListener('click', async () => {
  const name = $('#new-client-name').value.trim();
  if (!name) return alert('請輸入業主名稱');
  const notes = $('#new-client-notes').value.trim();
  const r = await fetch('/api/clients', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, notes }),
  });
  if (!r.ok) return alert((await r.json()).error);
  $('#new-client-name').value = ''; $('#new-client-notes').value = '';
  await loadClients();
});

async function loadClients() {
  const r = await fetch('/api/clients');
  const { clients } = await r.json();
  state.clients = clients;
  renderClientSwitcher();
  renderClientList();
}

function renderClientSwitcher() {
  const sel = $('#client-select');
  if (!state.clients.length) {
    sel.innerHTML = '<option value="">尚未新增業主</option>';
    state.clientId = null;
    $('#no-client-warn').style.display = '';
    $('#compose-card').style.display = 'none';
    return;
  }
  $('#no-client-warn').style.display = 'none';
  $('#compose-card').style.display = '';
  sel.innerHTML = state.clients.map(c => {
    const tag = c.has_token ? '🟢' : '🔴';
    const handle = c.ig_username ? `@${c.ig_username}` : '未連線';
    return `<option value="${c.id}">${tag} ${escapeHtml(c.name)} · ${handle}</option>`;
  }).join('');
  if (!state.clientId || !state.clients.find(c => c.id === state.clientId)) {
    state.clientId = state.clients[0].id;
  }
  sel.value = state.clientId;
}

$('#client-select').addEventListener('change', (e) => {
  state.clientId = parseInt(e.target.value, 10) || null;
  refreshStatusBar();
});

function renderClientList() {
  const root = $('#client-list');
  if (!state.clients.length) {
    root.innerHTML = '<div class="card muted small" style="text-align:center">還沒有業主，請在上方新增</div>';
    return;
  }
  root.innerHTML = state.clients.map(c => `
    <div class="card client-row" data-id="${c.id}">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div>
          <h3 style="margin:0">${escapeHtml(c.name)}</h3>
          <div class="muted small">
            ${c.has_token ? `🟢 已連線 @${c.ig_username || '?'}` : '🔴 尚未設定 Token'}
            ${c.page_name ? ` · 粉專：${escapeHtml(c.page_name)}` : ''}
            · 待發送 ${c.pending_count}
          </div>
          ${c.notes ? `<div class="muted small" style="margin-top:4px">📝 ${escapeHtml(c.notes)}</div>` : ''}
          ${c.token_refreshed_at ? `<div class="muted small">Token 上次刷新：${new Date(c.token_refreshed_at).toLocaleDateString('zh-TW')}</div>` : ''}
        </div>
        <div class="row">
          <button class="primary small" data-act="set-token" data-id="${c.id}" data-name="${escapeHtml(c.name)}">${c.has_token ? '更換 Token' : '設定 Token'}</button>
          ${c.has_token ? `<button class="ghost small" data-act="refresh" data-id="${c.id}">續期</button>` : ''}
          <button class="ghost small" data-act="delete" data-id="${c.id}" data-name="${escapeHtml(c.name)}">刪除</button>
        </div>
      </div>
    </div>
  `).join('');

  root.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => handleClientAction(b.dataset));
  });
}

async function handleClientAction({ act, id, name }) {
  if (act === 'set-token') {
    openTokenModal(id, name);
  } else if (act === 'refresh') {
    const r = await fetch(`/api/clients/${id}/refresh-token`, { method: 'POST' });
    const json = await r.json();
    if (r.ok) alert(`✅ 已續期 ${Math.round(json.expiresIn / 86400)} 天`);
    else alert('❌ ' + json.error);
    loadClients();
  } else if (act === 'delete') {
    if (!confirm(`確定刪除業主「${name}」？所有排程貼文也會一併刪除`)) return;
    await fetch(`/api/clients/${id}`, { method: 'DELETE' });
    loadClients();
  }
}

let tokenModalClientId = null;
function openTokenModal(id, name) {
  tokenModalClientId = id;
  $('#token-modal-target').textContent = `業主：${name}`;
  $('#token-modal-input').value = '';
  $('#token-modal-msg').textContent = '';
  $('#token-modal').style.display = 'flex';
  setTimeout(() => $('#token-modal-input').focus(), 50);
}
$('#token-modal-cancel').addEventListener('click', () => $('#token-modal').style.display = 'none');
$('#token-modal-save').addEventListener('click', async () => {
  const token = $('#token-modal-input').value.trim();
  if (!token) return;
  const msg = $('#token-modal-msg');
  msg.textContent = '驗證中…'; msg.className = 'msg muted';
  const r = await fetch(`/api/clients/${tokenModalClientId}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const json = await r.json();
  if (r.ok) {
    msg.textContent = `✅ 已連線 @${json.profile.username}`;
    msg.className = 'msg ok';
    await loadClients();
    setTimeout(() => $('#token-modal').style.display = 'none', 800);
  } else {
    msg.textContent = '❌ ' + json.error;
    msg.className = 'msg err';
  }
});

async function refreshStatusBar() {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) {
      if (r.status === 401) { location.href = '/login.html'; return; }
      throw new Error();
    }
    const s = await r.json();
    const here = state.clients.find(c => c.id === state.clientId);
    const dot = here?.has_token ? 'ok' : 'warn';
    const txt = here
      ? `<span class="dot ${dot}"></span>${here.has_token ? '@' + (here.ig_username || '?') : '未連線'} · 全部待發 ${s.pendingTotal}`
      : `<span class="dot err"></span>未選業主`;
    $('#status-bar').innerHTML = txt;
  } catch (e) {
    $('#status-bar').textContent = '⚠️ 後端未連上';
  }
}

(async function init() {
  await loadClients();
  refreshStatusBar();
  loadPosts();
  setInterval(() => { refreshStatusBar(); loadClients(); }, 20000);
})();
