// 把 FB Graph API 的錯誤訊息翻成中文人話
const PATTERNS = [
  // Token / 權限類
  { re: /Invalid OAuth access token|access token.*invalid|Session has expired/i,
    msg: 'Token 已失效或過期，請到「業主管理」重新設定 Token' },
  { re: /(?:not authorized|insufficient[\s_]?permission|requires.*permission|missing.*permission)/i,
    msg: 'Token 權限不足，可能少了 instagram_content_publish 或 pages_show_list' },
  { re: /User has not authorized application/i,
    msg: '使用者未授權此 App，請到 FB 設定授權給「發文＋影片 排程器」' },

  // 圖片 / 影片格式類
  { re: /aspect ratio is not supported|Unsupported aspect ratio/i,
    msg: '圖片/影片比例不符 IG 規定（接受 1:1、4:5、1.91:1，Reels 限 9:16）' },
  { re: /image size|file size.*too large|exceed.*size|payload.*too large/i,
    msg: '檔案過大（IG 圖片上限 8 MB、影片 1 GB）' },
  { re: /Unsupported.*format|Format.*not supported|Invalid.*image type|MIME type/i,
    msg: '檔案格式不支援（IG 接受 JPEG / MP4 / MOV，不接受 PNG）' },
  { re: /video.*duration|Video.*too long|too short/i,
    msg: 'Reels 影片長度需 3 秒-15 分鐘' },
  { re: /resolution|too small|min.*width|min.*height/i,
    msg: '圖片解析度過低（IG 建議至少 1080×1080）' },

  // 額度類
  { re: /content publishing limit|publishing.*limit.*reach|exceed.*publish/i,
    msg: '已達 24 小時 100 篇的 IG 發文上限' },
  { re: /rate limit|Too many.*request/i,
    msg: 'API 呼叫太頻繁，請稍等幾分鐘' },

  // 帳號類
  { re: /Application does not have permission|app.*not.*permitted/i,
    msg: 'App 權限不足，請檢查 Meta Developer 上的 App 設定' },
  { re: /Cannot find.*Instagram|no.*Instagram.*account|instagram.*not.*found/i,
    msg: '找不到綁定的 IG 商業帳號（IG 必須是商業/創作者，且綁 FB 粉專）' },
  { re: /Page.*not.*found|page.*permission/i,
    msg: '無法存取 FB 粉專，可能粉專沒授權給此 App' },

  // 媒體 URL 類
  { re: /image_url|video_url.*invalid|cannot.*download.*media|fetch.*media|URL.*not.*accessible/i,
    msg: '素材 URL 無法被 IG 抓取（檢查工具是不是線上、或 cloudflared 是不是斷了）' },

  // 容器 / 處理失敗
  { re: /container.*processing.*failed|EXPIRED|media.*processing/i,
    msg: '媒體上傳處理失敗，IG 可能拒絕了該檔案，請換一個再試' },
];

export const translateIGError = (raw) => {
  if (!raw) return raw;
  const msg = String(raw);
  for (const p of PATTERNS) {
    if (p.re.test(msg)) return `${p.msg}\n（原因：${msg.slice(0, 120)}）`;
  }
  return msg;
};

// 取原始錯誤字串（含 axios response wrap，未翻譯）
export const rawErrMsg = (e) =>
  e?.response?.data?.error?.message || e?.response?.data?.message || e?.message || String(e || '');

// 取錯誤訊息（含 axios response wrap）
export const errMsg = (e) => translateIGError(rawErrMsg(e));

// 真正「永久」的失敗 — 自動重試也救不了，需要人介入（重設 token / 換素材 / 等明天）
const PERMANENT = [
  /Invalid OAuth access token|access token.*invalid|Session has expired|session has been invalidated/i,
  /not authorized|insufficient[\s_]?permission|requires?.*permission|permission.*requir|missing.*permission|_publish.*permission|permission.*_publish/i,
  /User has not authorized application/i,
  /aspect ratio|file size.*too large|exceed.*size|payload.*too large/i,
  /Unsupported.*format|Format.*not supported|Invalid.*image type|MIME type|image format is not supported/i,
  /video.*duration|Video.*too long|too short|resolution|min.*width|min.*height/i,
  /content publishing limit|publishing.*limit.*reach|exceed.*publish/i,
  /Application does not have permission|app.*not.*permitted/i,
  /Cannot find.*Instagram|no.*Instagram.*account|instagram.*not.*found/i,
];

// 判斷錯誤是否「暫時性」→ 值得自動退避重試
// 策略：明確永久的不重試；其餘（含 FB 偶發的裸 "Authorization Error"、rate limit、5xx、
//       媒體抓取逾時、網路錯）一律當暫時性，靠呼叫端的重試上限把關，避免一次抖動就永久陣亡。
export const isTransientPublishError = (e) => {
  const raw = String(rawErrMsg(e));
  if (PERMANENT.some(re => re.test(raw))) return false;
  return true;
};
