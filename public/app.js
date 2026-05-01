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
    if (btn.dataset.tab === 'planner') loadPlanner();
    if (btn.dataset.tab === 'logs') loadLogs();
  });
});

$('#logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

// ─── Compose: type segment ───
const TYPE_HINTS = {
  image: '單張圖片：JPEG（IG 不接受 PNG，建議用 JPG）',
  carousel: '輪播：2–10 張，可混合圖片+影片',
  reel: 'Reels：MP4/MOV、3 秒–15 分、9:16 直立最佳，最大 1 GB',
  story: '限時動態：圖片或影片、9:16，發出後 24 小時自動消失（無 caption）',
};

document.querySelectorAll('.seg-btn').forEach(b => {
  b.addEventListener('click', () => {
    $$('.seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.type = b.dataset.type;
    $('#reel-options').style.display = state.type === 'reel' ? '' : 'none';
    $('#type-hint').textContent = TYPE_HINTS[state.type] || '';
    if (state.type === 'story') {
      $('#caption').disabled = true;
      $('#caption').placeholder = '限時動態無 caption';
    } else {
      $('#caption').disabled = false;
      $('#caption').placeholder = '寫文案…可包含 @標註 與 #hashtag';
    }
    if (state.type === 'reel' && state.files.length > 1) state.files = state.files.slice(0, 1);
    if (state.type === 'image' && state.files.length > 1) state.files = state.files.slice(0, 1);
    if (state.type === 'story' && state.files.length > 1) state.files = state.files.slice(0, 1);
    if (state.type === 'carousel' && state.files.length > 10) state.files = state.files.slice(0, 10);
    renderPreview();
  });
});
$('#type-hint').textContent = TYPE_HINTS.image;

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
  const orig = dz.querySelector('p').innerHTML;
  dz.querySelector('p').textContent = '上傳中…';
  try {
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const json = await r.json();
    state.files = state.files.concat(json.files);
    if (state.type === 'image') state.files = state.files.slice(-1);
    if (state.type === 'reel') state.files = state.files.filter(f => f.mimeType?.startsWith('video')).slice(-1);
    if (state.type === 'story') state.files = state.files.slice(-1);
    if (state.type === 'carousel') state.files = state.files.slice(0, 10);
    renderPreview();
  } catch (e) {
    alert('上傳失敗：' + e.message);
  }
  dz.querySelector('p').innerHTML = orig;
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
$('#plus-3d').addEventListener('click', () => tInput.value = localISO(new Date(Date.now() + 3 * 86400000)));

$('#submit-btn').addEventListener('click', async () => {
  if (!state.clientId) return alert('請先在右上選擇業主');
  if (!state.files.length) return alert('請先上傳素材');
  if (!tInput.value) return alert('請選排程時間');
  if (state.type === 'reel' && !state.files[0].mimeType?.startsWith('video')) return alert('Reels 必須是影片檔');
  if (state.type === 'story' && state.files.length !== 1) return alert('限時動態只能 1 個素材');

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
  document.querySelector('[data-tab="planner"]').click();
});

// ─── Posts list ───
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
    root.innerHTML = `<div class="empty-state mini"><div class="empty-icon">📭</div><p class="subtle">沒有符合的貼文</p></div>`;
    return;
  }
  root.innerHTML = posts.map(p => {
    const time = new Date(p.scheduled_at).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' });
    const thumbs = p.media_paths.slice(0, 3).map(m => {
      const isVid = /\.(mp4|mov|m4v)$/i.test(m);
      return isVid ? `<video class="thumb" src="${m}" muted></video>` : `<img class="thumb" src="${m}">`;
    }).join('');
    const more = p.media_paths.length > 3 ? `<div class="thumb subtle" style="display:flex;align-items:center;justify-content:center">+${p.media_paths.length - 3}</div>` : '';
    return `
      <div class="post-item">
        <div class="thumbs">${thumbs}${more}</div>
        <div class="body">
          <div class="meta">
            <span class="tag ${p.status}">${labelStatus(p.status)}</span>
            <span>${labelType(p.type)}</span>
            <span class="subtle">@${p.ig_username || p.client_name || '?'}</span>
            <span>🕐 ${time}</span>
            ${p.permalink ? `<a href="${p.permalink}" target="_blank">📎 IG 貼文</a>` : ''}
          </div>
          <div class="caption">${escapeHtml(p.caption || '（無文案）')}</div>
          ${p.error ? `<div class="msg err">⚠️ ${escapeHtml(p.error)}</div>` : ''}
          <div class="actions">
            ${p.status === 'pending' ? `
              <button class="ghost small" data-act="run" data-id="${p.id}">▶ 立即發送</button>
              <button class="ghost small" data-act="dup" data-id="${p.id}">📋 複製</button>
              <button class="ghost small" data-act="del" data-id="${p.id}">取消</button>
            ` : ''}
            ${p.status === 'posted' ? `<button class="ghost small" data-act="dup" data-id="${p.id}">📋 複製為新貼文</button>` : ''}
            ${p.status === 'failed' ? `
              <button class="ghost small" data-act="retry" data-id="${p.id}">🔄 重試</button>
              <button class="ghost small" data-act="dup" data-id="${p.id}">📋 複製</button>
              <button class="ghost small" data-act="del" data-id="${p.id}">刪除</button>
            ` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  root.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const act = b.dataset.act;
      if (act === 'run') {
        if (!confirm('要立即發送嗎？')) return;
        await fetch(`/api/posts/${id}/run`, { method: 'POST' });
      } else if (act === 'retry') {
        if (!confirm('重試這篇貼文？將立刻重新發送')) return;
        const r = await fetch(`/api/posts/${id}/retry`, { method: 'POST' });
        if (!r.ok) alert((await r.json()).error || '重試失敗');
      } else if (act === 'dup') {
        const r = await fetch(`/api/posts/${id}/duplicate`, { method: 'POST' });
        if (r.ok) alert('已複製為新貼文（預設 1 小時後排程，可去調時間）');
        else alert((await r.json()).error || '複製失敗');
      } else if (act === 'del') {
        if (!confirm('確定？')) return;
        await fetch(`/api/posts/${id}`, { method: 'DELETE' });
      }
      loadPosts();
    });
  });
}

// ─── Logs ───
let logAutoTimer = null;
let logFilters = { level: '', source: '' };

document.querySelectorAll('[data-log-level]').forEach(c => {
  c.addEventListener('click', () => {
    document.querySelectorAll('[data-log-level]').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    logFilters.level = c.dataset.logLevel;
    loadLogs();
  });
});
$('#log-source').addEventListener('change', e => { logFilters.source = e.target.value; loadLogs(); });
$('#reload-logs').addEventListener('click', loadLogs);
$('#log-auto-refresh').addEventListener('change', e => {
  if (e.target.checked) startLogAuto();
  else stopLogAuto();
});

function startLogAuto() {
  stopLogAuto();
  logAutoTimer = setInterval(() => {
    if ($('#tab-logs').classList.contains('active')) loadLogs();
  }, 5000);
}
function stopLogAuto() {
  if (logAutoTimer) clearInterval(logAutoTimer);
  logAutoTimer = null;
}

async function loadLogs() {
  const params = new URLSearchParams();
  if (logFilters.level) params.set('level', logFilters.level);
  if (logFilters.source) params.set('source', logFilters.source);
  params.set('limit', '300');
  const r = await fetch('/api/logs?' + params);
  if (!r.ok) return;
  const { logs } = await r.json();
  const root = $('#log-list');
  if (!logs.length) {
    root.innerHTML = `<div class="empty-state mini"><div class="empty-icon">📭</div><p class="subtle">沒有日誌</p></div>`;
    return;
  }
  root.innerHTML = logs.map(l => {
    const t = new Date(l.ts);
    const time = t.toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const ctx = [
      l.client_id ? `c#${l.client_id}` : null,
      l.post_id ? `p#${l.post_id}` : null,
      l.actor ? `@${l.actor}` : null,
    ].filter(Boolean).join(' ');
    const meta = l.metadata ? `<div class="log-meta">${escapeHtml(JSON.stringify(l.metadata))}</div>` : '';
    return `
      <div class="log-row log-${l.level}">
        <span class="log-time">${time}</span>
        <span class="log-badge log-${l.level}">${l.level.toUpperCase()}</span>
        <span class="log-tag">${escapeHtml(l.source)}${l.action ? '/' + escapeHtml(l.action) : ''}</span>
        <span class="log-ctx subtle">${escapeHtml(ctx)}</span>
        <div class="log-msg">${escapeHtml(l.message || '')}</div>
        ${meta}
      </div>`;
  }).join('');
}

if ($('#log-auto-refresh').checked) startLogAuto();

const labelStatus = (s) => ({ pending: '⏳ 待發送', publishing: '📤 發送中', posted: '✅ 已發送', failed: '❌ 失敗' }[s] || s);
const labelType = (t) => ({ image: '🖼️ 單圖', carousel: '🎞️ 輪播', reel: '🎬 Reels', story: '⚡ Story' }[t] || t);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ─── Planner ───
let plannerSortable = null;

async function loadPlanner() {
  if (!state.clientId) {
    $('#planner-profile').innerHTML = `<div class="empty-state mini"><div class="empty-icon">👋</div><p class="subtle">請先選擇業主</p></div>`;
    $('#grid-pending').innerHTML = '';
    $('#grid-posted').innerHTML = '';
    return;
  }

  const client = state.clients.find(c => c.id === state.clientId);
  let profileHtml = '';
  try {
    const pr = await fetch(`/api/clients/${state.clientId}/profile`);
    if (pr.ok) {
      const { profile } = await pr.json();
      profileHtml = renderProfileCard(profile);
    }
  } catch {}
  if (!profileHtml && client) {
    profileHtml = renderProfileCard({
      username: client.ig_username || '?',
      name: client.name,
      followers_count: '?', media_count: '?',
    });
  }
  $('#planner-profile').innerHTML = profileHtml;

  // pending
  const pendR = await fetch(`/api/posts?client_id=${state.clientId}&status=pending`);
  const { posts: pending } = await pendR.json();
  pending.sort((a, b) => b.scheduled_at - a.scheduled_at); // latest first (top-left = newest IG)
  $('#pending-count').textContent = `${pending.length} 篇`;
  const pgrid = $('#grid-pending');
  if (pending.length) {
    pgrid.style.display = '';
    $('#grid-pending-empty').style.display = 'none';
    pgrid.innerHTML = pending.map((p, i) => renderPendingCell(p, i)).join('');
  } else {
    pgrid.style.display = 'none';
    pgrid.innerHTML = '';
    $('#grid-pending-empty').style.display = '';
  }

  if (plannerSortable) plannerSortable.destroy();
  plannerSortable = new Sortable(pgrid, {
    animation: 200,
    ghostClass: 'dragging',
    onEnd: async () => {
      const ids = Array.from(pgrid.children).map(el => parseInt(el.dataset.id, 10));
      // displayed order is latest-first; backend wants ascending order = reverse
      const orderedIds = ids.reverse();
      const r = await fetch('/api/posts/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: state.clientId, orderedIds }),
      });
      if (!r.ok) {
        alert('排序失敗：' + ((await r.json()).error || ''));
      }
      loadPlanner();
    },
  });

  // posted - from IG
  try {
    const mr = await fetch(`/api/clients/${state.clientId}/recent-media?limit=24`);
    const md = await mr.json();
    const items = md.data || [];
    $('#posted-count').textContent = `${items.length} 篇`;
    $('#grid-posted').innerHTML = items.map(renderPostedCell).join('');
  } catch (e) {
    $('#grid-posted').innerHTML = `<div class="msg err">無法載入：${escapeHtml(e.message)}</div>`;
  }
}

function renderProfileCard(profile) {
  const avatar = profile.profile_picture_url
    ? `<img src="${profile.profile_picture_url}" referrerpolicy="no-referrer" onerror="this.style.display='none';this.parentElement.innerHTML='<div class=&quot;placeholder&quot;>📸</div>'">`
    : `<div class="placeholder">📸</div>`;
  return `
    <div class="ig-profile-card">
      <div class="avatar-wrap">${avatar}</div>
      <div class="info">
        <div class="uname">@${escapeHtml(profile.username || '?')}</div>
        <div class="name">${escapeHtml(profile.name || '')}</div>
        <div class="stats">
          <div class="stat"><span class="num">${profile.media_count ?? '?'}</span> <span class="lbl">貼文</span></div>
          <div class="stat"><span class="num">${(profile.followers_count ?? '?').toLocaleString?.() ?? profile.followers_count ?? '?'}</span> <span class="lbl">粉絲</span></div>
          <div class="stat"><span class="num">${(profile.follows_count ?? '?').toLocaleString?.() ?? profile.follows_count ?? '?'}</span> <span class="lbl">追蹤中</span></div>
        </div>
      </div>
    </div>
  `;
}

function renderPendingCell(p, displayIdx) {
  const total = $('#pending-count').textContent.match(/\d+/)?.[0] || '0';
  const orderNum = parseInt(total, 10) - displayIdx; // 1 = will post first
  const url = p.media_paths[0];
  const isVid = /\.(mp4|mov|m4v)$/i.test(url);
  const when = new Date(p.scheduled_at);
  const now = new Date();
  const sameDay = when.toDateString() === now.toDateString();
  const whenLabel = sameDay
    ? `今 ${when.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`
    : when.toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const typeIcon = { image: '', carousel: '🎞️', reel: '🎬', story: '⚡' }[p.type] || '';
  return `
    <div class="ig-cell pending" data-id="${p.id}" title="點兩下看細節">
      ${isVid ? `<video src="${url}" muted></video>` : `<img src="${url}">`}
      <div class="pending-overlay">
        <span class="when">${whenLabel}${typeIcon ? ' ' + typeIcon : ''}</span>
        <span class="order">${orderNum}</span>
      </div>
    </div>`;
}

function renderPostedCell(m) {
  const isVid = m.media_type === 'VIDEO' || m.media_type === 'REELS';
  const isCar = m.media_type === 'CAROUSEL_ALBUM';
  const icon = isCar ? '🎞️' : isVid ? '▶️' : '';
  const thumb = m.thumbnail_url || m.media_url;
  return `
    <a href="${m.permalink}" target="_blank" class="ig-cell posted" title="${escapeHtml((m.caption || '').slice(0, 80))}">
      <img src="${thumb}" referrerpolicy="no-referrer" loading="lazy">
      ${icon ? `<div class="type-icon">${icon}</div>` : ''}
      <div class="like-info">
        <span>❤️ ${m.like_count ?? '?'}</span>
        <span>💬 ${m.comments_count ?? '?'}</span>
      </div>
    </a>`;
}

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
  if (!r.ok) {
    if (r.status === 401) { location.href = '/login.html'; return; }
    return;
  }
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
  if ($('#tab-planner').classList.contains('active')) loadPlanner();
});

function renderClientList() {
  const root = $('#client-list');
  if (!state.clients.length) {
    root.innerHTML = `<div class="card empty-state"><div class="empty-icon">👤</div><p class="subtle">還沒有業主，請在上方新增</p></div>`;
    return;
  }
  root.innerHTML = state.clients.map(c => {
    const init = (c.name || '?').slice(0, 1);
    return `
      <div class="card client-row" data-id="${c.id}">
        <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:nowrap;gap:14px">
          <div class="client-info" style="min-width:0;flex:1">
            <div class="client-avatar">${escapeHtml(init)}</div>
            <div style="min-width:0;flex:1">
              <h3 style="margin:0">${escapeHtml(c.name)}</h3>
              <div class="subtle small">
                ${c.has_token ? `🟢 已連線 @${c.ig_username || '?'}` : '🔴 尚未設定 Token'}
                ${c.page_name ? ` · ${escapeHtml(c.page_name)}` : ''}
                · 排程中 ${c.pending_count}
              </div>
              ${c.notes ? `<div class="subtle small" style="margin-top:2px">📝 ${escapeHtml(c.notes)}</div>` : ''}
            </div>
          </div>
          <div class="row" style="flex-wrap:nowrap">
            <button class="primary small" data-act="set-token" data-id="${c.id}" data-name="${escapeHtml(c.name)}">${c.has_token ? '更換 Token' : '設定 Token'}</button>
            ${c.has_token ? `<button class="ghost small" data-act="refresh" data-id="${c.id}">續期</button>` : ''}
            ${c.has_token ? `<button class="ghost small" data-act="insights" data-id="${c.id}" data-name="${escapeHtml(c.name)}">📊 洞察</button>` : ''}
            <button class="ghost small" data-act="delete" data-id="${c.id}" data-name="${escapeHtml(c.name)}">刪除</button>
          </div>
        </div>
      </div>`;
  }).join('');

  root.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => handleClientAction(b.dataset));
  });
}

async function handleClientAction({ act, id, name }) {
  if (act === 'set-token') openTokenModal(id, name);
  else if (act === 'refresh') {
    const r = await fetch(`/api/clients/${id}/refresh-token`, { method: 'POST' });
    const json = await r.json();
    if (r.ok) alert(`✅ 已續期 ${Math.round(json.expiresIn / 86400)} 天`);
    else alert('❌ ' + json.error);
    loadClients();
  } else if (act === 'insights') openInsightsModal(id, name);
  else if (act === 'delete') {
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

async function openInsightsModal(id, name) {
  const m = $('#insights-modal');
  $('#insights-title').textContent = `📊 ${name} — 帳號洞察`;
  $('#insights-body').innerHTML = '<div class="subtle">載入中…</div>';
  m.style.display = 'flex';

  const [limitR, mediaR] = await Promise.all([
    fetch(`/api/clients/${id}/limit`).then(r => r.json()).catch(e => ({ error: e.message })),
    fetch(`/api/clients/${id}/recent-media`).then(r => r.json()).catch(e => ({ error: e.message })),
  ]);

  const limitHtml = limitR.error
    ? `<div class="msg err">⚠️ 額度查詢失敗：${escapeHtml(limitR.error)}</div>`
    : (() => {
        const cfg = limitR.data?.[0]?.config || {};
        const usage = limitR.data?.[0]?.quota_usage || 0;
        const max = cfg.quota_total || 100;
        const pct = Math.round((usage / max) * 100);
        const color = pct > 80 ? 'err' : pct > 50 ? 'warn' : 'ok';
        return `<div class="quota-bar"><span class="dot ${color}"></span> 24h 發文額度：<strong>${usage}/${max}</strong>（${pct}%）</div>`;
      })();

  const mediaHtml = mediaR.error
    ? `<div class="msg err">⚠️ ${escapeHtml(mediaR.error)}</div>`
    : `<div class="recent-grid">${(mediaR.data || []).slice(0, 12).map(m => {
        const isVid = m.media_type === 'VIDEO' || m.media_type === 'REELS';
        return `<a href="${m.permalink}" target="_blank" class="recent-cell">
          <img src="${m.thumbnail_url || m.media_url}" referrerpolicy="no-referrer" loading="lazy">
          <div class="recent-meta">
            <span>${m.media_type === 'CAROUSEL_ALBUM' ? '🎞️' : isVid ? '🎬' : '🖼️'}</span>
            <span>❤️ ${m.like_count ?? '?'}</span>
            <span>💬 ${m.comments_count ?? '?'}</span>
          </div>
        </a>`;
      }).join('')}</div>`;

  $('#insights-body').innerHTML = `
    <h4 style="margin:0 0 8px">發文額度</h4>
    ${limitHtml}
    <h4 style="margin:18px 0 8px">近期 12 篇貼文</h4>
    ${mediaHtml}
  `;
}
$('#insights-close').addEventListener('click', () => $('#insights-modal').style.display = 'none');

// close modals on backdrop click
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', (e) => { if (e.target === m) m.style.display = 'none'; });
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
      ? `<span class="dot ${dot}"></span>${here.has_token ? '@' + (here.ig_username || '?') : '未連線'} · 待發 ${s.pendingTotal}`
      : `<span class="dot err"></span>未選業主`;
    $('#status-bar').innerHTML = txt;
  } catch (e) {
    $('#status-bar').innerHTML = '<span class="dot err"></span>後端未連上';
  }
}

(async function init() {
  await loadClients();
  refreshStatusBar();
  loadPosts();
  setInterval(() => { refreshStatusBar(); loadClients(); }, 30000);
})();
