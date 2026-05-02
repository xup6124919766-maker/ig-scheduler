import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { insertSession, getSession, deleteSession, findUserByUsername, touchUserLogin } from './db.js';

const SESSION_DAYS = 14;
const COOKIE_NAME = 'ig_sched_sid';

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
export const verifyPassword = (pw, hash) => {
  if (!hash) return false;
  try { return bcrypt.compareSync(pw, hash); } catch { return false; }
};

const getAdminEnvCreds = () => {
  const user = process.env.ADMIN_USER || 'admin';
  const passHash = process.env.ADMIN_PASS_HASH;
  const passPlain = process.env.ADMIN_PASS;
  if (passHash) return { user, passHash };
  if (passPlain) return { user, passHash: hashPassword(passPlain) };
  return null;
};

// 回傳 { username, role } 或 null
export const checkLogin = (username, password) => {
  if (!username || !password) return null;

  // 先找 DB（多用戶模式優先）
  const dbUser = findUserByUsername(username);
  if (dbUser) {
    if (verifyPassword(password, dbUser.password_hash)) {
      try { touchUserLogin(username); } catch {}
      return { username: dbUser.username, role: dbUser.role, id: dbUser.id };
    }
    return null;
  }

  // 沒有就 fallback 到 ENV admin（bootstrap / 緊急用）
  const env = getAdminEnvCreds();
  if (!env) throw new Error('未設定 ADMIN_PASS_HASH / ADMIN_PASS，且 users 表也沒帳號');
  if (username === env.user && verifyPassword(password, env.passHash)) {
    return { username: env.user, role: 'admin', id: 0 };
  }
  return null;
};

// 拿 user 角色（給 requireAuth 用）
export const getUserRole = (username) => {
  const dbUser = findUserByUsername(username);
  if (dbUser) return dbUser.role;
  const env = getAdminEnvCreds();
  if (env && username === env.user) return 'admin';
  return 'viewer';
};

export const createSession = (user) => {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_DAYS * 86400000;
  insertSession(id, user, expiresAt);
  return { id, expiresAt };
};

export const destroySession = (id) => deleteSession(id);

const parseCookies = (str) => {
  if (!str) return {};
  return Object.fromEntries(str.split(';').map(s => {
    const [k, ...v] = s.trim().split('=');
    return [k, v.join('=')];
  }));
};

export const requireAuth = (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[COOKIE_NAME];
  if (!sid) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '未登入' });
    return res.redirect('/login.html');
  }
  const sess = getSession(sid);
  if (!sess) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '已過期' });
    return res.redirect('/login.html');
  }
  req.user = sess.user;
  req.role = getUserRole(sess.user);
  next();
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.role)) {
    return res.status(403).json({ error: `權限不足（需要 ${roles.join(' / ')} 角色）` });
  }
  next();
};

export const setSessionCookie = (res, sessionId, expiresAt) => {
  const expires = new Date(expiresAt).toUTCString();
  const isProd = process.env.NODE_ENV === 'production';
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Expires=${expires}`];
  if (isProd) flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sessionId}; ${flags.join('; ')}`);
};

export const clearSessionCookie = (res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
};

export const getCookie = (req, name = COOKIE_NAME) => parseCookies(req.headers.cookie)[name];
