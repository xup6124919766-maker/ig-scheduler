import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';

const getClient = () => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('未設定 ANTHROPIC_API_KEY，請到 Railway 環境變數加');
  return new Anthropic({ apiKey: key });
};

const VIRAL_SYSTEM = `你是 Instagram 爆款文案專家，專為短影片寫吸睛、會被收藏轉發的 Reels 文案。

【五大爆款公式（任選一個最契合的）】
1. **痛點共鳴**：「每次 ___ 都 ___」「你是不是也常常 ___」
2. **反差衝突**：「都以為 ___，結果 ___」「我以前覺得 ___，現在 ___」
3. **數字承諾**：「30 天我做了 ___，現在 ___」「3 個習慣讓我 ___」
4. **反直覺**：「別再 ___ 了，你應該 ___」「停！這樣 ___ 才對」
5. **故事開頭**：「凌晨 3 點，我 ___」「上週她跟我說 ___」

【你的任務】
仔細看附上的圖/影片首幀：
- 在演什麼？主角在做什麼動作？
- 場景、情緒、視覺重點？
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

const guessMime = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  }[ext] || 'application/octet-stream';
};

// ffmpeg 抽影片第 1 秒的一張 jpg（自動處理）
const extractVideoFrame = (videoPath) => new Promise((resolve, reject) => {
  const out = path.join(os.tmpdir(), `frame_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  const args = ['-y', '-ss', '00:00:01', '-i', videoPath, '-vframes', '1', '-q:v', '4', out];
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => stderr += d);
  proc.on('error', e => reject(new Error(`ffmpeg 沒裝：${e.message}`)));
  proc.on('close', code => {
    if (code === 0 && fs.existsSync(out)) resolve(out);
    else reject(new Error(`ffmpeg 抽幀失敗 (code ${code}): ${stderr.slice(-300)}`));
  });
});

const fileToBase64 = (filePath) => fs.readFileSync(filePath).toString('base64');

const parseAIJson = (text) => {
  try {
    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0];
    return JSON.parse(jsonStr);
  } catch {
    return { caption: text.trim(), hashtags: [] };
  }
};

export const generateCaption = async ({ filePath, brandHint, brandVoice, extraInstructions }) => {
  const client = getClient();
  if (!fs.existsSync(filePath)) throw new Error('找不到素材檔案');

  const mime = guessMime(filePath);
  const isVideo = mime.startsWith('video');

  let imagePath = filePath;
  let cleanup = null;
  if (isVideo) {
    imagePath = await extractVideoFrame(filePath);
    cleanup = () => { try { fs.unlinkSync(imagePath); } catch {} };
  }

  const imageMime = isVideo ? 'image/jpeg' : mime;
  const imageBase64 = fileToBase64(imagePath);

  // 系統 prompt + 口吻 DNA 套上 prompt caching（不變的部分免重複算 token）
  const systemBlocks = [{ type: 'text', text: VIRAL_SYSTEM, cache_control: { type: 'ephemeral' } }];
  if (brandVoice) {
    systemBlocks.push({
      type: 'text',
      text: `\n\n═══════════════════════════════════════════\n【🧬 你必須嚴格模仿這個帳號的口吻 — 這是分析他既有貼文得到的指南】\n═══════════════════════════════════════════\n${brandVoice}\n═══════════════════════════════════════════\n\n⚠️ 上面這份「口吻指南」是強制規則。文案要讀起來「像他寫的」，不是像 AI 寫的。嚴格模仿他的開頭、句子節奏、用詞、慣用語、結尾。不要違反他的禁區。寧可平凡有真實感，也不要「模板感」。`,
      cache_control: { type: 'ephemeral' },
    });
  }
  if (brandHint) {
    systemBlocks.push({ type: 'text', text: `\n\n【品牌補充】\n${brandHint}` });
  }

  const userText = `${isVideo ? '附上影片第 1 秒的縮圖。' : '附上要寫文案的圖片。'}${extraInstructions ? `\n\n【這次特別要求】${extraInstructions}` : ''}\n\n直接回 JSON，不要前後綴。`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      system: systemBlocks,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: imageMime, data: imageBase64 } },
          { type: 'text', text: userText },
        ],
      }],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    const parsed = parseAIJson(text);
    return {
      caption: parsed.caption || '',
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
      isVideo,
      cacheStats: {
        cacheReadTokens: response.usage?.cache_read_input_tokens || 0,
        cacheWriteTokens: response.usage?.cache_creation_input_tokens || 0,
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
      },
    };
  } finally {
    if (cleanup) cleanup();
  }
};

// 🧬 分析既有 IG 貼文 → 產文字 DNA
const VOICE_LEARN_SYSTEM = `你是文案分析師。請仔細閱讀這個帳號的 IG 貼文集合，提取他的「文字 DNA」。

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

export const learnVoiceFromPosts = async ({ captions, igUsername }) => {
  const client = getClient();
  const valid = (captions || []).filter(c => c && c.trim().length > 20);
  if (valid.length < 5) throw new Error(`貼文太少（只 ${valid.length} 篇有文案），需至少 5 篇才能分析`);

  const corpus = valid.slice(0, 30).map((c, i) => `---貼文 ${i + 1}---\n${c.trim()}`).join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',  // 分析用更強的模型
    max_tokens: 3000,
    system: VOICE_LEARN_SYSTEM,
    messages: [{
      role: 'user',
      content: `【@${igUsername || '?'} 的 IG 貼文集合】\n\n${corpus}`,
    }],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  if (!text) throw new Error('AI 沒回傳分析結果');
  return {
    voice: text,
    sampleCount: valid.length,
  };
};
