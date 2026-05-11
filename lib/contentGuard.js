// 違禁詞清單 — 保養／醫療廣告法常見地雷
const DEFAULT_FORBIDDEN = [
  '療效', '根治', '永久', '保證', '100%', '無副作用',
  '絕對有效', '徹底治癒', '完全治癒', '立即見效',
  '神奇', '奇蹟', '萬能', '藥效', '醫療效果',
  '治療', '療程',
];

const extra = (process.env.FORBIDDEN_WORDS_EXTRA || '')
  .split(',').map(s => s.trim()).filter(Boolean);

export const FORBIDDEN_WORDS = [...DEFAULT_FORBIDDEN, ...extra];

export const checkForbiddenWords = (text) => {
  if (!text) return [];
  return FORBIDDEN_WORDS.filter(w => text.includes(w));
};

export const DAILY_POST_LIMIT = parseInt(process.env.DAILY_POST_LIMIT || '5', 10);

// 加入 ±maxMinutes 隨機誤差（毫秒），避免發文時間整齊到像機器人
export const jitterScheduledAt = (ts, maxMinutes = 5) => {
  const range = maxMinutes * 60 * 1000;
  const offset = Math.floor((Math.random() - 0.5) * 2 * range);
  return ts + offset;
};

// 取某個 ts 對應的台北日的 [startMs, endMs)
export const taipeiDayBounds = (ts) => {
  const taipeiDate = new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const startMs = new Date(`${taipeiDate}T00:00:00+08:00`).getTime();
  return { startMs, endMs: startMs + 86400000, label: taipeiDate };
};
