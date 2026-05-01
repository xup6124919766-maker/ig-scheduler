import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cron from 'node-cron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  insertClient, listClients, getClient, updateClient, deleteClient,
  insertPost, listPosts, getPost, getDuePosts, updatePostStatus, deletePost,
  purgeExpiredSessions,
} from './lib/db.js';
import { encrypt, decrypt } from './lib/crypto.js';
import { checkLogin, createSession, destroySession, requireAuth, setSessionCookie, clearSessionCookie, getCookie } from './lib/auth.js';
import { initTunnel, getPublicUrl, waitForTunnel } from './lib/tunnel.js';
import { IGClient } from './lib/ig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '4567', 10);
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v21.0';

const isRailway = !!process.env.RAILWAY_PUBLIC_DOMAIN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL
  || (isRailway ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

const uploadsDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
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

// 公開（不需登入）：login + media（IG 要抓）+ 靜態資源
app.use('/media', express.static(uploadsDir, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=3600'),
}));
app.use('/login.html', express.static(path.join(__dirname, 'public', 'login.html')));
app.use('/style.css', express.static(path.join(__dirname, 'public', 'style.css')));

// ─── 登入 ───
app.post('/api/login', (req, res) => {
  const { user, password } = req.body || {};
  try {
    if (!checkLogin(user, password)) return res.status(401).json({ error: '帳號或密碼錯誤' });
    const { id, expiresAt } = createSession(user);
    setSessionCookie(res, id, expiresAt);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  const sid = getCookie(req);
  if (sid) destroySession(sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ─── 以下全部要登入 ───
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
  res.json({ id });
});

app.patch('/api/clients/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, notes, status } = req.body || {};
  updateClient(id, { name, notes, status });
  res.json({ ok: true });
});

app.delete('/api/clients/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  deleteClient(id);
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
    const profile = await ig.getProfile();
    updateClient(id, {
      access_token_enc: encrypt(token),
      ig_user_id: acc.igUserId,
      ig_username: profile.username || acc.igUsername,
      page_id: acc.pageId,
      page_name: acc.pageName,
      token_type: ig.tokenType,
      token_refreshed_at: Date.now(),
    });
    res.json({ ok: true, profile, tokenType: ig.tokenType });
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
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
    res.json({ ok: true, expiresIn: r.expires_in });
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

app.get('/api/clients/:id/profile', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const ig = await ensureClientAccount(id);
    const profile = await ig.getProfile();
    res.json({ profile });
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
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
  res.json({ files });
});

// ─── 貼文排程 ───
app.get('/api/posts', (req, res) => {
  const clientId = req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  res.json({ posts: listPosts({ clientId, status: req.query.status || null }) });
});

app.post('/api/posts', (req, res) => {
  const { clientId, type, caption, mediaPaths, scheduledAt, shareToFeed } = req.body || {};
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
  });
  res.json({ id, post: getPost(id) });
});

app.get('/api/clients/:id/recent-media', async (req, res) => {
  try {
    const ig = await ensureClientAccount(parseInt(req.params.id, 10));
    const data = await ig.getMedia({ limit: 12 });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

app.get('/api/clients/:id/insights', async (req, res) => {
  try {
    const ig = await ensureClientAccount(parseInt(req.params.id, 10));
    const data = await ig.getAccountInsights({ period: req.query.period || 'day' });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

app.get('/api/clients/:id/limit', async (req, res) => {
  try {
    const ig = await ensureClientAccount(parseInt(req.params.id, 10));
    const data = await ig.getPublishingLimit();
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

app.delete('/api/posts/:id', (req, res) => {
  deletePost(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

app.post('/api/posts/:id/run', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const post = getPost(id);
  if (!post) return res.status(404).json({ error: '找不到貼文' });
  if (post.status !== 'pending') return res.status(400).json({ error: `狀態為 ${post.status}` });
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
  });
});

// ─── 排程 loop ───
const publishPost = async (post) => {
  console.log(`[publish] #${post.id} client=${post.client_id} type=${post.type}`);
  updatePostStatus(post.id, { status: 'publishing' });
  try {
    const ig = await ensureClientAccount(post.client_id);
    const base = await getPublicMediaBase();
    const toUrl = (p) => `${base}${p}`;

    let result;
    if (post.type === 'image') {
      result = await ig.publishImagePost({
        imageUrl: toUrl(post.media_paths[0]),
        caption: post.caption,
      });
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
      result = await ig.publishStoryPost(
        isVideo ? { videoUrl: toUrl(p) } : { imageUrl: toUrl(p) }
      );
    }

    let permalink = null;
    try {
      const meta = await ig.getMediaPermalink(result.id);
      permalink = meta.permalink;
    } catch {}

    updatePostStatus(post.id, {
      status: 'posted',
      ig_media_id: result.id,
      permalink,
      posted_at: Date.now(),
      error: null,
    });
    console.log(`[publish] #${post.id} 完成 mediaId=${result.id}`);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error(`[publish] #${post.id} 失敗：${msg}`);
    updatePostStatus(post.id, { status: 'failed', error: msg });
  }
};

const tickScheduler = async () => {
  const due = getDuePosts();
  for (const p of due) await publishPost(p);
};

const autoRefreshAllTokens = async () => {
  for (const c of listClients()) {
    const refreshedAt = c.token_refreshed_at || 0;
    const ageDays = (Date.now() - refreshedAt) / 86400000;
    if (refreshedAt && ageDays < 30) continue;
    const full = getClient(c.id);
    const ig = buildClient(full);
    if (!ig) continue;
    try {
      const r = await ig.refreshToken();
      updateClient(c.id, {
        access_token_enc: encrypt(r.access_token),
        token_refreshed_at: Date.now(),
      });
      console.log(`[token] 業主 #${c.id} ${c.name} token 已續期`);
    } catch (e) {
      console.warn(`[token] 業主 #${c.id} 續期失敗：`, e.response?.data?.error?.message || e.message);
    }
  }
};

app.listen(PORT, async () => {
  console.log(`\n🚀 ＩＧ排程器 啟動 :${PORT}`);
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
  cron.schedule('0 0 3 * * *', purgeExpiredSessions);
  console.log('⏰ 排程器運轉中（每 30 秒）\n');
});
