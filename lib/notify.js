import axios from 'axios';

// 通用 webhook 推送，支援 ntfy / Discord / Slack / 自訂端點
export const notify = async ({ title, message, level = 'info', metadata = {} } = {}) => {
  const url = process.env.WEBHOOK_URL;
  if (!url) return { skipped: true, reason: '未設定 WEBHOOK_URL' };

  const isNtfy = /ntfy\.sh/i.test(url);
  const isDiscord = /discord\.com\/api\/webhooks/i.test(url);
  const isSlack = /hooks\.slack\.com/i.test(url);

  try {
    if (isNtfy) {
      const priority = { error: 5, warn: 4, info: 3 }[level] || 3;
      const tags = { error: 'rotating_light', warn: 'warning', info: 'information_source' }[level] || 'bell';
      await axios.post(url, message, {
        headers: { Title: encodeURIComponent(title), Priority: priority, Tags: tags },
        timeout: 10000,
      });
    } else if (isDiscord) {
      const color = { error: 0xdc2626, warn: 0xd97706, info: 0x0891b2 }[level] || 0x6b7280;
      await axios.post(url, {
        embeds: [{
          title: title || 'IG 排程器通知',
          description: message,
          color,
          fields: Object.entries(metadata).slice(0, 6).map(([k, v]) => ({ name: k, value: String(v).slice(0, 200), inline: true })),
          timestamp: new Date().toISOString(),
        }],
      }, { timeout: 10000 });
    } else if (isSlack) {
      await axios.post(url, { text: `*${title || 'IG 排程器'}*\n${message}` }, { timeout: 10000 });
    } else {
      // 通用 JSON
      await axios.post(url, { title, message, level, metadata, timestamp: Date.now() }, { timeout: 10000 });
    }
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
};
