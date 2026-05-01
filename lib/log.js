import { insertLog } from './db.js';

const isProd = process.env.NODE_ENV === 'production';
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m',
  green: '\x1b[32m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

const colorFor = (level) => ({ error: C.red, warn: C.yellow, info: C.cyan, debug: C.gray }[level] || '');

export const log = ({ level = 'info', source, action, clientId, postId, actor, message, metadata }) => {
  try {
    insertLog({ level, source, action, clientId, postId, actor, message, metadata });
  } catch (e) {
    console.error('[log] insert failed:', e.message);
  }
  if (!isProd || level !== 'debug') {
    const ts = new Date().toISOString().slice(11, 19);
    const tag = `${source}${action ? '/' + action : ''}`;
    const ctx = [
      clientId ? `c#${clientId}` : null,
      postId ? `p#${postId}` : null,
      actor ? `by:${actor}` : null,
    ].filter(Boolean).join(' ');
    const color = colorFor(level);
    console.log(`${C.gray}${ts}${C.reset} ${color}[${level.toUpperCase()}]${C.reset} ${tag} ${ctx} ${message || ''}`);
  }
};

export const logInfo = (params) => log({ ...params, level: 'info' });
export const logWarn = (params) => log({ ...params, level: 'warn' });
export const logError = (params) => log({ ...params, level: 'error' });
