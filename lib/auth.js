import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { insertSession, getSession, deleteSession } from './db.js';

const SESSION_DAYS = 14;
const COOKIE_NAME = 'ig_sched_sid';

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
export const verifyPassword = (pw, hash) => {
  if (!hash) return false;
  try { return bcrypt.compareSync(pw, hash); } catch { return false; }
};

const getAdminCreds = () => {
  const user = process.env.ADMIN_USER || 'admin';
  const passHash = process.env.ADMIN_PASS_HASH;
  const passPlain = process.env.ADMIN_PASS;
  if (passHash) return { user, passHash };
  if (passPlain) return { user, passHash: hashPassword(passPlain) };
  return null;
};

export const checkLogin = (user, password) => {
  const c = getAdminCreds();
  if (!c) throw new Error('未設定 ADMIN_PASS_HASH 或 ADMIN_PASS 環境變數');
  if (user !== c.user) return false;
  return verifyPassword(password, c.passHash);
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
