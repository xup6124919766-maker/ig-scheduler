import crypto from 'crypto';

const getKey = () => {
  const k = process.env.ENCRYPTION_KEY;
  if (!k || k.length < 32) {
    throw new Error('ENCRYPTION_KEY 必須是 32 字元以上字串（建議 64 字元 hex）');
  }
  return crypto.createHash('sha256').update(k).digest();
};

export const encrypt = (plaintext) => {
  if (!plaintext) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
};

export const decrypt = (encB64) => {
  if (!encB64) return null;
  const buf = Buffer.from(encB64, 'base64');
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const enc = buf.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
};

export const generateKey = () =>
  crypto.randomBytes(32).toString('hex');
