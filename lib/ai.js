import axios from 'axios';
import fs from 'fs';
import path from 'path';

const GEMINI_KEY = () => process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const SYSTEM_PROMPT = `你是專業的 Instagram 文案編輯，要為這張圖/這支影片寫一則 IG 貼文。

【規範】
- 中文為主
- 開頭一句要抓住眼球（懸念、共鳴、問題、反轉擇一）
- 內文 3-5 句，有節奏，每 1-2 句換行
- 結尾留 CTA 或問句
- 字數 80-150 字
- 自然、口語、不像廣告
- 別開頭就放 hashtag

【產出格式】（嚴格 JSON，**只回 JSON 不要任何前後綴**）：
{
  "caption": "完整文案內容（含換行 \\n）",
  "hashtags": ["#標籤1", "#標籤2", "#標籤3", ...]  // 8-15 個 IG 熱門 hashtag，相關＋一些大流量
}`;

const fileToBase64 = (filePath) => {
  const buf = fs.readFileSync(filePath);
  return buf.toString('base64');
};

const guessMime = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  }[ext] || 'application/octet-stream';
};

export const generateCaption = async ({ filePath, brandHint, extraInstructions }) => {
  const key = GEMINI_KEY();
  if (!key) throw new Error('未設定 GEMINI_API_KEY，請到 Railway 環境變數加');
  if (!fs.existsSync(filePath)) throw new Error('找不到素材檔案');

  const mime = guessMime(filePath);
  if (mime.startsWith('video')) {
    // 影片太大不能直接 inline，先回較通用文案
    const stat = fs.statSync(filePath);
    if (stat.size > 15 * 1024 * 1024) {
      return {
        caption: '（影片貼文 — 文案請手動撰寫，AI 暫不支援大影片解讀）\n',
        hashtags: [],
        notice: '影片超過 15 MB，AI 無法分析，請手動寫文案',
      };
    }
  }

  const base64 = fileToBase64(filePath);
  const userParts = [
    { text: SYSTEM_PROMPT + (brandHint ? `\n\n【品牌風格】${brandHint}` : '') + (extraInstructions ? `\n\n【額外要求】${extraInstructions}` : '') },
    { inline_data: { mime_type: mime, data: base64 } },
  ];

  const { data } = await axios.post(`${GEMINI_URL(GEMINI_MODEL)}?key=${key}`, {
    contents: [{ parts: userParts }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 1024 },
  }, { timeout: 60000 });

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  let parsed;
  try {
    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0];
    parsed = JSON.parse(jsonStr);
  } catch {
    parsed = { caption: text.trim(), hashtags: [] };
  }
  return {
    caption: parsed.caption || '',
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
  };
};
