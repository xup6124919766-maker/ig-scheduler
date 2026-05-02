import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cron from 'node-cron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  db,
  insertClient, listClients, getClient, updateClient, deleteClient,
  insertPost, listPosts, getPost, getDuePosts, updatePostStatus, deletePost,
  purgeExpiredSessions,
  listLogs, purgeOldLogs, claimPost, incrementRetry,
  getOldPostedMediaPaths, getActiveMediaFilenames,
} from './lib/db.js';
import { encrypt, decrypt } from './lib/crypto.js';
import { checkLogin, createSession, destroySession, requireAuth, setSessionCookie, clearSessionCookie, getCookie } from './lib/auth.js';
import { initTunnel, getPublicUrl, waitForTunnel } from './lib/tunnel.js';
import { IGClient } from './lib/ig.js';
import { logInfo, logWarn, logError } from './lib/log.js';
import { errMsg as translateErr } from './lib/errors.js';
import { generateCaption } from './lib/ai.js';
import { notify } from './lib/notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '4567', 10);
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v21.0';

const isRailway = !!process.env.RAILWAY_PUBLIC_DOMAIN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL
  || (isRailway ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

const uploadsDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
app.set('trust proxy', 1); // for x-forwarded-for behind Railway proxy
app.use(express.json({ limit: '10mb' }));

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^\w.\-]/g, '_');
    cb(null, `${ts}_${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ─── 公開：health / login 頁面 / media（IG 抓素材要用）/ login.css ───
app.get('/healthz', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, time: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use('/media', express.static(uploadsDir, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=3600'),
}));
app.use('/login.html', express.static(path.join(__dirname, 'public', 'login.html')));
app.use('/style.css', express.static(path.join(__dirname, 'public', 'style.css')));

// ─── 登入 rate-limit ───
const loginAttempts = new Map(); // ip → { fails, lockUntil }
const LOGIN_MAX_FAILS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const clientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

app.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  const a = loginAttempts.get(ip) || { fails: 0, lockUntil: 0 };
  if (a.lockUntil > now) {
    const mins = Math.ceil((a.lockUntil - now) / 60000);
    logWarn({ source: 'auth', action: 'locked', message: `IP ${ip} 鎖定中 (剩 ${mins} 分)` });
    return res.status(429).json({ error: `登入嘗試太多，已鎖定 ${mins} 分鐘` });
  }
  const { user, password } = req.body || {};
  try {
    if (!checkLogin(user, password)) {
      a.fails += 1;
      if (a.fails >= LOGIN_MAX_FAILS) {
        a.lockUntil = now + LOGIN_LOCK_MS;
        a.fails = 0;
        logError({ source: 'auth', action: 'lockout', message: `IP ${ip} 達失敗上限，鎖 15 分鐘` });
        notify({ title: '🚨 登入嘗試異常', message: `IP ${ip} 失敗 10 次已鎖定`, level: 'error' }).catch(() => {});
      }
      loginAttempts.set(ip, a);
      logWarn({ source: 'auth', action: 'fail', actor: user || '?', message: `登入失敗 from ${ip}` });
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }
    loginAttempts.delete(ip);
    const { id, expiresAt } = createSession(user);
    setSessionCookie(res, id, expiresAt);
    logInfo({ source: 'auth', action: 'login', actor: user, message: `成功登入 from ${ip}` });
    res.json({ ok: true });
  } catch (e) {
    logError({ source: 'auth', action: 'login_error', message: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  const sid = getCookie(req);
  if (sid) destroySession(sid);
  clearSessionCookie(res);
  logInfo({ source: 'auth', action: 'logout', actor: req.user || '?' });
  res.json({ ok: true });
});

// ─── 以下要登入 ───
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

const buildClient = (clientRow) => {
  if (!clientRow?.access_token_enc) return null;
  const token = decrypt(clientRow.access_token_enc);
  return new IGClient({
    token,
    igUserId: clientRow.ig_user_id,
    tokenType: clientRow.token_type || 'fb',
    version: GRAPH_VERSION,
  });
};

const ensureClientAccount = async (clientId) => {
  const c = getClient(clientId);
  if (!c) throw new Error('找不到業主');
  const ig = buildClient(c);
  if (!ig) throw new Error('該業主尚未設定 token');
  if (!c.ig_user_id) {
    const acc = await ig.resolveAccount();
    updateClient(c.id, {
      ig_user_id: acc.igUserId,
      ig_username: acc.igUsername || c.ig_username,
      page_id: acc.pageId,
      page_name: acc.pageName,
      token_type: ig.tokenType,
    });
    ig.igUserId = acc.igUserId;
  }
  return ig;
};

const getPublicMediaBase = async () => {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return waitForTunnel(45000);
};

const errMsg = translateErr;

// ─── 業主管理 ───
app.get('/api/clients', (_req, res) => {
  const rows = listClients().map(c => ({
    ...c,
    has_token: !!getClient(c.id).access_token_enc,
    pending_count: listPosts({ clientId: c.id, status: 'pending' }).length,
  }));
  res.json({ clients: rows });
});

app.post('/api/clients', (req, res) => {
  const { name, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: '缺少名稱' });
  const id = insertClient({ name, notes });
  logInfo({ source: 'client', action: 'create', clientId: id, actor: req.user, message: `新增業主「${name}」` });
  res.json({ id });
});

app.patch('/api/clients/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, notes, status } = req.body || {};
  updateClient(id, { name, notes, status });
  logInfo({ source: 'client', action: 'update', clientId: id, actor: req.user });
  res.json({ ok: true });
});

app.delete('/api/clients/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = getClient(id);
  deleteClient(id);
  logWarn({ source: 'client', action: 'delete', clientId: id, actor: req.user, message: `刪除業主「${c?.name || id}」` });
  res.json({ ok: true });
});

app.post('/api/clients/:id/token', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: '缺少 token' });
  try {
    const ig = new IGClient({ token, version: GRAPH_VERSION });
    const acc = await ig.resolveAccount();
    ig.igUserId = acc.igUserId;

    // 🎯 如果拿到 page token，改用 page token（永不過期）
    let tokenToStore = token;
    if (acc.pageToken) {
      tokenToStore = acc.pageToken;
      ig.token = acc.pageToken;
    }
    const profile = await ig.getProfile();

    updateClient(id, {
      access_token_enc: encrypt(tokenToStore),
      ig_user_id: acc.igUserId,
      ig_username: profile.username || acc.igUsername,
      page_id: acc.pageId,
      page_name: acc.pageName,
      token_type: ig.tokenType,
      token_refreshed_at: Date.now(),
    });
    const upgraded = acc.pageToken ? '（已升級為永不過期 Page Token ✨）' : '';
    logInfo({ source: 'client', action: 'set_token', clientId: id, actor: req.user,
      message: `綁定 IG @${profile.username} (type=${ig.tokenType}) ${upgraded}` });
    res.json({ ok: true, profile, tokenType: ig.tokenType, permanent: !!acc.pageToken });
  } catch (e) {
    const msg = errMsg(e);
    logError({ source: 'client', action: 'set_token_fail', clientId: id, actor: req.user, message: msg });
    res.status(400).json({ error: msg });
  }
});

// 把現有 user token 升級為永不過期的 page token
app.post('/api/clients/:id/upgrade-token', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = getClient(id);
  if (!c) return res.status(404).json({ error: '找不到業主' });
  if (c.token_type === 'fb_page') {
    return res.json({ ok: true, alreadyPermanent: true, message: '已經是永久 token' });
  }
  const ig = buildClient(c);
  if (!ig) return res.status(400).json({ error: '尚未設定 token' });
  try {
    const acc = await ig.resolveAccount();
    if (!acc.pageToken) {
      return res.status(400).json({ error: 'Token 沒拿到 page token，可能是 IG Login token 或 user token 不是長效版本' });
    }
    updateClient(id, {
      access_token_enc: encrypt(acc.pageToken),
      token_type: 'fb_page',
      token_refreshed_at: Date.now(),
    });
    logInfo({ source: 'client', action: 'upgrade_token', clientId: id, actor: req.user,
      message: `${c.name} 升級為永久 Page Token ✨` });
    res.json({ ok: true, permanent: true });
  } catch (e) {
    const msg = errMsg(e);
    logError({ source: 'client', action: 'upgrade_token_fail', clientId: id, actor: req.user, message: msg });
    res.status(400).json({ error: msg });
  }
});

app.post('/api/clients/:id/refresh-token', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = getClient(id);
  const ig = buildClient(c);
  if (!ig) return res.status(400).json({ error: '尚未設定 token' });
  try {
    const r = await ig.refreshToken();
    updateClient(id, {
      access_token_enc: encrypt(r.access_token),
      token_refreshed_at: Date.now(),
    });
    logInfo({ source: 'client', action: 'refresh_token', clientId: id, actor: req.user, message: `已續期 ${Math.round(r.expires_in / 86400)} 天` });
    res.json({ ok: true, expiresIn: r.expires_in });
  } catch (e) {
    const msg = errMsg(e);
    logError({ source: 'client', action: 'refresh_token_fail', clientId: id, actor: req.user, message: msg });
    res.status(400).json({ error: msg });
  }
});

app.get('/api/clients/:id/profile', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const ig = await ensureClientAccount(id);
    const profile = await ig.getProfile();
    res.json({ profile });
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

app.get('/api/clients/:id/recent-media', async (req, res) => {
  try {
    const ig = await ensureClientAccount(parseInt(req.params.id, 10));
    const limit = Math.min(parseInt(req.query.limit, 10) || 12, 50);
    const data = await ig.getMedia({ limit });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

app.get('/api/clients/:id/insights', async (req, res) => {
  try {
    const ig = await ensureClientAccount(parseInt(req.params.id, 10));
    const data = await ig.getAccountInsights({ period: req.query.period || 'day' });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

app.get('/api/clients/:id/limit', async (req, res) => {
  try {
    const ig = await ensureClientAccount(parseInt(req.params.id, 10));
    const data = await ig.getPublishingLimit();
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

// ─── 上傳 ───
app.post('/api/upload', upload.array('files', 10), (req, res) => {
  const files = (req.files || []).map(f => ({
    filename: f.filename,
    originalName: f.originalname,
    size: f.size,
    mimeType: f.mimetype,
    url: `/media/${f.filename}`,
  }));
  if (files.length) {
    logInfo({ source: 'upload', actor: req.user,
      message: `上傳 ${files.length} 個檔案，共 ${Math.round(files.reduce((s, f) => s + f.size, 0) / 1024)} KB` });
  }
  res.json({ files });
});

// ─── 貼文排程 ───
app.get('/api/posts', (req, res) => {
  const clientId = req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  res.json({ posts: listPosts({ clientId, status: req.query.status || null }) });
});

app.post('/api/posts', (req, res) => {
  const { clientId, type, caption, mediaPaths, scheduledAt, shareToFeed, firstComment } = req.body || {};
  if (!clientId || !type || !Array.isArray(mediaPaths) || !mediaPaths.length || !scheduledAt) {
    return res.status(400).json({ error: '缺欄位 clientId / type / mediaPaths / scheduledAt' });
  }
  if (!['image', 'reel', 'carousel', 'story'].includes(type)) {
    return res.status(400).json({ error: 'type 必須是 image / reel / carousel / story' });
  }
  if (type === 'story' && mediaPaths.length !== 1) {
    return res.status(400).json({ error: 'Story 只能有 1 個素材' });
  }
  if (!getClient(clientId)) return res.status(400).json({ error: '業主不存在' });
  const id = insertPost({
    clientId, type, caption: caption || '', mediaPaths,
    scheduledAt: new Date(scheduledAt).getTime(),
    shareToFeed: shareToFeed === false ? 0 : 1,
    firstComment: type === 'story' ? null : (firstComment || null),
  });
  logInfo({ source: 'post', action: 'create', clientId, postId: id, actor: req.user,
    message: `排程 ${type} 於 ${new Date(scheduledAt).toLocaleString('zh-TW')}` });
  res.json({ id, post: getPost(id) });
});

// ─── AI 文案 ───
app.post('/api/ai/caption', async (req, res) => {
  const { mediaPath, brandHint, extraInstructions } = req.body || {};
  if (!mediaPath || !mediaPath.startsWith('/media/')) {
    return res.status(400).json({ error: '缺 mediaPath' });
  }
  const filename = mediaPath.replace('/media/', '');
  const filePath = path.join(uploadsDir, filename);
  try {
    const r = await generateCaption({ filePath, brandHint, extraInstructions });
    logInfo({ source: 'ai', action: 'caption_generate', actor: req.user,
      message: `AI 產文案 ${r.caption.length} 字 + ${r.hashtags.length} hashtags` });
    res.json(r);
  } catch (e) {
    logError({ source: 'ai', action: 'caption_fail', actor: req.user, message: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/posts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = getPost(id);
  deletePost(id);
  if (p) logInfo({ source: 'post', action: 'cancel', clientId: p.client_id, postId: id, actor: req.user });
  res.json({ ok: true });
});

app.post('/api/posts/:id/duplicate', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const src = getPost(id);
  if (!src) return res.status(404).json({ error: '找不到原貼文' });
  const newId = insertPost({
    clientId: src.client_id,
    type: src.type,
    caption: src.caption,
    mediaPaths: src.media_paths,
    scheduledAt: Date.now() + 60 * 60 * 1000, // 預設 1 小時後
    shareToFeed: src.share_to_feed,
  });
  logInfo({ source: 'post', action: 'duplicate', clientId: src.client_id, postId: newId, actor: req.user,
    message: `從 #${id} 複製` });
  res.json({ id: newId, post: getPost(newId) });
});

app.post('/api/posts/:id/retry', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = getPost(id);
  if (!p) return res.status(404).json({ error: '找不到貼文' });
  if (p.status !== 'failed') return res.status(400).json({ error: `狀態為 ${p.status}，無法重試` });
  db.prepare("UPDATE posts SET status='pending', error=NULL, scheduled_at=? WHERE id=?")
    .run(Date.now(), id);
  logInfo({ source: 'post', action: 'retry', clientId: p.client_id, postId: id, actor: req.user });
  res.json({ ok: true });
});

app.post('/api/posts/reorder', (req, res) => {
  const { clientId, orderedIds } = req.body || {};
  if (!clientId || !Array.isArray(orderedIds) || !orderedIds.length) {
    return res.status(400).json({ error: '缺欄位 clientId / orderedIds' });
  }
  const pending = listPosts({ clientId, status: 'pending' }).sort((a, b) => a.scheduled_at - b.scheduled_at);
  if (orderedIds.length !== pending.length) {
    return res.status(400).json({ error: `排程中有 ${pending.length} 篇，但你給了 ${orderedIds.length} 個 id` });
  }
  const slots = pending.map(p => p.scheduled_at);
  orderedIds.forEach((id, i) => {
    const target = pending.find(p => p.id === id);
    if (!target) throw new Error(`找不到 post #${id}`);
    if (target.scheduled_at !== slots[i]) {
      db.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ? AND status = ?')
        .run(slots[i], id, 'pending');
    }
  });
  logInfo({ source: 'post', action: 'reorder', clientId, actor: req.user, message: `重排 ${orderedIds.length} 篇` });
  res.json({ ok: true, posts: listPosts({ clientId, status: 'pending' }) });
});

app.post('/api/posts/:id/run', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const post = getPost(id);
  if (!post) return res.status(404).json({ error: '找不到貼文' });
  if (post.status !== 'pending') return res.status(400).json({ error: `狀態為 ${post.status}` });
  logInfo({ source: 'post', action: 'manual_trigger', clientId: post.client_id, postId: id, actor: req.user });
  publishPost(post).catch(() => {});
  res.json({ ok: true });
});

app.get('/api/status', (_req, res) => {
  const clients = listClients();
  res.json({
    publicUrl: PUBLIC_BASE_URL || getPublicUrl(),
    clientCount: clients.length,
    pendingTotal: listPosts({ status: 'pending' }).length,
    isRailway,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    serverTime: Date.now(),
  });
});

// ─── LOG ───
app.get('/api/logs', (req, res) => {
  const logs = listLogs({
    level: req.query.level || null,
    source: req.query.source || null,
    clientId: req.query.client_id ? parseInt(req.query.client_id, 10) : null,
    limit: parseInt(req.query.limit, 10) || 200,
    sinceTs: req.query.since ? parseInt(req.query.since, 10) : null,
  });
  res.json({ logs });
});

// ─── 排程 loop ───
const publishPost = async (post) => {
  if (!claimPost(post.id)) {
    return; // 別的 worker 已經拿走
  }
  logInfo({ source: 'scheduler', action: 'publish_start', clientId: post.client_id, postId: post.id,
    message: `開始發送 type=${post.type}` });
  try {
    const ig = await ensureClientAccount(post.client_id);
    const base = await getPublicMediaBase();
    const toUrl = (p) => `${base}${p}`;

    let result;
    if (post.type === 'image') {
      result = await ig.publishImagePost({ imageUrl: toUrl(post.media_paths[0]), caption: post.caption });
    } else if (post.type === 'reel') {
      result = await ig.publishReelPost({
        videoUrl: toUrl(post.media_paths[0]),
        caption: post.caption,
        shareToFeed: !!post.share_to_feed,
      });
    } else if (post.type === 'carousel') {
      const items = post.media_paths.map(p => ({
        type: /\.(mp4|mov|m4v)$/i.test(p) ? 'video' : 'image',
        url: toUrl(p),
      }));
      result = await ig.publishCarouselPost({ items, caption: post.caption });
    } else if (post.type === 'story') {
      const p = post.media_paths[0];
      const isVideo = /\.(mp4|mov|m4v)$/i.test(p);
      result = await ig.publishStoryPost(isVideo ? { videoUrl: toUrl(p) } : { imageUrl: toUrl(p) });
    }

    let permalink = null;
    try { permalink = (await ig.getMediaPermalink(result.id)).permalink; } catch {}

    updatePostStatus(post.id, {
      status: 'posted', ig_media_id: result.id, permalink, posted_at: Date.now(), error: null,
    });
    logInfo({ source: 'scheduler', action: 'publish_ok', clientId: post.client_id, postId: post.id,
      message: `已發送 mediaId=${result.id}`, metadata: { permalink } });

    // hashtag 首則留言
    if (post.first_comment) {
      try {
        await ig.postComment(result.id, post.first_comment);
        logInfo({ source: 'scheduler', action: 'comment_ok', clientId: post.client_id, postId: post.id,
          message: `首則留言已發 (${post.first_comment.length} 字)` });
      } catch (e) {
        logWarn({ source: 'scheduler', action: 'comment_fail', clientId: post.client_id, postId: post.id,
          message: `首則留言失敗（不影響貼文）：${errMsg(e)}` });
      }
    }
  } catch (e) {
    const msg = errMsg(e);
    incrementRetry(post.id);
    updatePostStatus(post.id, { status: 'failed', error: msg });
    logError({ source: 'scheduler', action: 'publish_fail', clientId: post.client_id, postId: post.id,
      message: msg, metadata: { type: post.type } });
    notify({
      title: `❌ 貼文發送失敗 #${post.id}`,
      message: msg,
      level: 'error',
      metadata: { client_id: post.client_id, type: post.type, post_id: post.id },
    }).catch(() => {});
  }
};

const tickScheduler = async () => {
  const due = getDuePosts();
  for (const p of due) await publishPost(p);
};

const autoRefreshAllTokens = async () => {
  for (const c of listClients()) {
    // 🎯 fb_page token 永不過期，跳過
    if (c.token_type === 'fb_page') continue;
    const refreshedAt = c.token_refreshed_at || 0;
    const ageDays = (Date.now() - refreshedAt) / 86400000;
    if (refreshedAt && ageDays < 30) continue;
    const full = getClient(c.id);
    const ig = buildClient(full);
    if (!ig) continue;
    try {
      const r = await ig.refreshToken();
      updateClient(c.id, { access_token_enc: encrypt(r.access_token), token_refreshed_at: Date.now() });
      logInfo({ source: 'scheduler', action: 'token_refresh', clientId: c.id,
        message: `${c.name} token 已自動續期 ${Math.round(r.expires_in / 86400)} 天` });
    } catch (e) {
      const msg = errMsg(e);
      logError({ source: 'scheduler', action: 'token_refresh_fail', clientId: c.id, message: msg });
      notify({ title: `⚠️ Token 續期失敗：${c.name}`, message: msg, level: 'error',
        metadata: { client_id: c.id } }).catch(() => {});
    }
  }
};

const cleanupOldUploads = () => {
  try {
    const active = getActiveMediaFilenames();
    const files = fs.readdirSync(uploadsDir);
    let deleted = 0;
    let bytes = 0;
    for (const f of files) {
      if (active.has(f)) continue;
      const stat = fs.statSync(path.join(uploadsDir, f));
      if (Date.now() - stat.mtimeMs < 7 * 86400000) continue; // 7 天內的留著
      bytes += stat.size;
      fs.unlinkSync(path.join(uploadsDir, f));
      deleted++;
    }
    if (deleted) {
      logInfo({ source: 'scheduler', action: 'cleanup',
        message: `清理 ${deleted} 個過期上傳檔（${Math.round(bytes / 1024 / 1024)} MB）` });
    }
  } catch (e) {
    logError({ source: 'scheduler', action: 'cleanup_fail', message: e.message });
  }
};

app.listen(PORT, async () => {
  console.log(`\n🚀 ＩＧ排程器 啟動 :${PORT}`);
  logInfo({ source: 'system', action: 'boot', message: `Server up :${PORT}` });
  if (PUBLIC_BASE_URL) {
    console.log(`🌐 公開網址：${PUBLIC_BASE_URL}`);
  } else {
    console.log(`🌐 本機模式 → 啟動 cloudflared tunnel`);
    initTunnel(PORT);
    try {
      const url = await waitForTunnel(45000);
      console.log(`🌐 Tunnel：${url}`);
    } catch (e) {
      console.error('⚠️ tunnel 啟動失敗：', e.message);
    }
  }
  await autoRefreshAllTokens();
  cron.schedule('*/30 * * * * *', tickScheduler);
  cron.schedule('0 0 4 * * *', autoRefreshAllTokens);
  cron.schedule('0 0 3 * * *', () => { purgeExpiredSessions(); purgeOldLogs(30); cleanupOldUploads(); });
  console.log('⏰ 排程器運轉中（每 30 秒）\n');
});
