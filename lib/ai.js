import axios from 'axios';
import fs from 'fs';
import path from 'path';

const GEMINI_KEY = () => process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_GEN_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const GEMINI_FILES_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';

const VOICE_LEARN_PROMPT = `你是文案分析師。請仔細閱讀這個帳號的 IG 貼文集合，提取他的「文字 DNA」。

請分析並輸出 8 個面向（每項 2-3 句具體描述，引用實際句子當例子）：

1. **開頭習慣** — 他怎麼起頭？最常用的句型？
2. **句子節奏** — 長句 / 短句 / 換行頻率？讀起來什麼感覺？
3. **用詞偏好** — 口語/書面？英文夾雜？emoji 用法？特殊符號（如 ✦ ❤️）？
4. **情緒底色** — 療癒？犀利？溫柔？反思？親密？
5. **結尾習慣** — 怎麼收尾？會問問題還是給結論？
6. **慣用詞與口頭禪** — 列出 5-10 個他特別愛用的詞、片語、stop words
7. **主題傾向** — 聊什麼？常從什麼角度切入？
8. **禁區** — 他絕對不會用的詞、不會走的調性

請寫成「**可直接餵 AI 模仿**」的口吻指南，500-800 字。
直接寫指南內容，不要前言、不要評論、不要 markdown 標題。
從第 1 點開始連貫敘述，用編號分節。`;

const VIRAL_PROMPT = `你是 Instagram 爆款文案專家，專為短影片寫吸睛、會被收藏轉發的 Reels 文案。

【五大爆款公式（任選一個最契合的）】
1. **痛點共鳴**：「每次 ___ 都 ___」「你是不是也常常 ___」
2. **反差衝突**：「都以為 ___，結果 ___」「我以前覺得 ___，現在 ___」
3. **數字承諾**：「30 天我做了 ___，現在 ___」「3 個習慣讓我 ___」
4. **反直覺**：「別再 ___ 了，你應該 ___」「停！這樣 ___ 才對」
5. **故事開頭**：「凌晨 3 點，我 ___」「上週她跟我說 ___」

【你的任務】
仔細看這段影片：
- 在演什麼？主角在做什麼動作？
- 場景、情緒、視覺重點？
- 哪一秒最有戲？哪一句最有梗？
- 抓「最能勾情緒的那個點」當 hook

【文案結構】
1. 第一行：眼球 hook（≤25 字，必須讓人停滑）
2. 第 2-4 行：展開（共鳴／故事／反轉／數字）
3. 倒數第二行：價值點 or 痛快結論
4. 最後一行：CTA 或留問題給留言區

【寫作規範】
- 中文為主，可夾英文
- 80-160 字
- 短句多換行，**節奏感重要**
- 換行用 \\n
- ⛔ 不要 AI 味（避免「在這個快速變化的時代」「讓我們一起」「精選好物」這種爛詞）
- ⛔ 不要直接用「爆款」「獨家」「重磅」spam 詞
- ⛔ 不要叫人「追蹤我」「按讚分享」（CTA 用問句更自然）
- ✅ 寫得像真人在說話，有溫度有畫面

【Hashtag 規範】
- 8-15 個
- 混合大流量（#美妝 #保養 #日常）+ 精準受眾（#敏感肌 #自信養成 #28歲日常）
- 不要全是大 tag，要有長尾才會被同類觸及

【最終產出格式】嚴格 JSON，不要任何 markdown 包覆，不要前後綴文字：
{
  "caption": "完整文案內容（含 \\n 換行）",
  "hashtags": ["#tag1", "#tag2", ...]
}`;

const fileToBase64 = (filePath) => fs.readFileSync(filePath).toString('base64');

const guessMime = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  }[ext] || 'application/octet-stream';
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 上傳到 Gemini Files API（resumable upload），等檔案 ACTIVE 後回傳 file 物件
const uploadToGeminiFiles = async ({ filePath, mimeType, key }) => {
  const data = fs.readFileSync(filePath);
  const numBytes = data.length;

  const startRes = await axios({
    method: 'POST',
    url: `${GEMINI_FILES_URL}?key=${key}`,
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(numBytes),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    data: { file: { display_name: path.basename(filePath) } },
    maxBodyLength: Infinity,
  });
  const uploadUrl = startRes.headers['x-goog-upload-url'];
  if (!uploadUrl) throw new Error('Gemini Files API 沒回 upload URL');

  const upRes = await axios({
    method: 'POST',
    url: uploadUrl,
    headers: {
      'Content-Length': String(numBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    data,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 180000,
  });

  let file = upRes.data?.file;
  if (!file) throw new Error('Gemini Files API 上傳失敗');

  // 影片要等 Gemini 處理（state ACTIVE）
  for (let i = 0; i < 60 && file.state !== 'ACTIVE'; i++) {
    await sleep(2000);
    const check = await axios.get(`https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${key}`);
    file = check.data;
    if (file.state === 'FAILED') throw new Error('Gemini 處理影片失敗');
  }
  if (file.state !== 'ACTIVE') throw new Error('影片處理逾時（>2 分鐘）');
  return file;
};

export const generateCaption = async ({ filePath, brandHint, brandVoice, extraInstructions, mode = 'viral' }) => {
  const key = GEMINI_KEY();
  if (!key) throw new Error('未設定 GEMINI_API_KEY，請到 Railway 環境變數加');
  if (!fs.existsSync(filePath)) throw new Error('找不到素材檔案');

  const mime = guessMime(filePath);
  const stat = fs.statSync(filePath);
  const isVideo = mime.startsWith('video');

  let mediaPart;
  if (isVideo) {
    // 影片：走 Files API（不論大小都用，可靠）
    const f = await uploadToGeminiFiles({ filePath, mimeType: mime, key });
    mediaPart = { file_data: { mime_type: mime, file_uri: f.uri } };
  } else if (stat.size > 18 * 1024 * 1024) {
    // 大圖也走 Files API
    const f = await uploadToGeminiFiles({ filePath, mimeType: mime, key });
    mediaPart = { file_data: { mime_type: mime, file_uri: f.uri } };
  } else {
    // 小圖直接 inline base64
    mediaPart = { inline_data: { mime_type: mime, data: fileToBase64(filePath) } };
  }

  // 🧬 brand voice 是學來的「文字 DNA」，必須嚴格模仿
  const voiceBlock = brandVoice ? `

═══════════════════════════════════════════
【🧬 你必須嚴格模仿這個帳號的口吻 — 這是分析他既有貼文得到的指南】
═══════════════════════════════════════════
${brandVoice}
═══════════════════════════════════════════

⚠️ 上面這份「口吻指南」是強制規則。文案要讀起來「像他寫的」，不是像 AI 寫的。
- 嚴格模仿他的開頭、句子節奏、用詞、慣用語、結尾
- 不要違反他的禁區
- 五大爆款公式可以用，但要「他會用的方式」呈現
- 寧可平凡有真實感，也不要「模板感」` : '';

  const promptText = VIRAL_PROMPT
    + voiceBlock
    + (brandHint ? `\n\n【品牌補充】\n${brandHint}` : '')
    + (extraInstructions ? `\n\n【額外要求】\n${extraInstructions}` : '');

  const { data } = await axios.post(`${GEMINI_GEN_URL(GEMINI_MODEL)}?key=${key}`, {
    contents: [{ parts: [{ text: promptText }, mediaPart] }],
    generationConfig: { temperature: 1.0, maxOutputTokens: 1500, topP: 0.95 },
  }, { timeout: 180000 });

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
    isVideo,
  };
};

// 🧬 分析既有 IG 貼文，產出「文字 DNA」指南
export const learnVoiceFromPosts = async ({ captions, igUsername }) => {
  const key = GEMINI_KEY();
  if (!key) throw new Error('未設定 GEMINI_API_KEY');
  const valid = (captions || []).filter(c => c && c.trim().length > 20);
  if (valid.length < 5) throw new Error(`貼文太少（只 ${valid.length} 篇有文案），需至少 5 篇才能分析`);

  const corpus = valid.slice(0, 30).map((c, i) => `---貼文 ${i + 1}---\n${c.trim()}`).join('\n\n');
  const prompt = VOICE_LEARN_PROMPT + `\n\n【@${igUsername || '?'} 的 IG 貼文集合】\n\n${corpus}`;

  const { data } = await axios.post(`${GEMINI_GEN_URL(GEMINI_MODEL)}?key=${key}`, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 2500 },
  }, { timeout: 120000 });

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text.trim()) throw new Error('Gemini 沒回傳分析結果');
  return {
    voice: text.trim(),
    sampleCount: valid.length,
  };
};
