import axios from 'axios';

const GRAPH_FB = (v) => `https://graph.facebook.com/${v || 'v21.0'}`;
const GRAPH_IG = (v) => `https://graph.instagram.com/${v || 'v21.0'}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class IGClient {
  constructor({ token, igUserId, version = 'v21.0', tokenType = null }) {
    this.token = token;
    this.igUserId = igUserId;
    this.version = version;
    this.tokenType = tokenType;
  }

  get graph() {
    return this.tokenType === 'ig' ? GRAPH_IG(this.version) : GRAPH_FB(this.version);
  }

  async _get(path, params = {}) {
    const { data } = await axios.get(`${this.graph}${path}`, {
      params: { access_token: this.token, ...params },
    });
    return data;
  }

  async _post(path, params = {}) {
    const { data } = await axios.post(`${this.graph}${path}`, null, {
      params: { access_token: this.token, ...params },
    });
    return data;
  }

  async resolveAccount() {
    if (this.tokenType !== 'fb') {
      try {
        const { data } = await axios.get(`${GRAPH_IG(this.version)}/me`, {
          params: { access_token: this.token, fields: 'user_id,username,account_type' },
        });
        if (data?.user_id || data?.id) {
          this.tokenType = 'ig';
          return {
            igUserId: String(data.user_id || data.id),
            igUsername: data.username,
            pageId: null,
            pageName: null,
          };
        }
      } catch { /* fall through to FB */ }
    }

    const { data: me } = await axios.get(`${GRAPH_FB(this.version)}/me/accounts`, {
      params: { access_token: this.token, fields: 'id,name,instagram_business_account' },
    });
    const page = me.data?.find(p => p.instagram_business_account?.id);
    if (!page) throw new Error('Token 無法找到 IG 商業帳號（FB Login 流程需綁粉專、IG Login 流程請確認 Token 是 IG token）');
    this.tokenType = 'fb';
    return {
      pageId: page.id,
      pageName: page.name,
      igUserId: page.instagram_business_account.id,
    };
  }

  async validateToken() {
    if (this.tokenType === 'ig') {
      const { data } = await axios.get(`${GRAPH_IG(this.version)}/me`, {
        params: { access_token: this.token, fields: 'id,username,account_type' },
      });
      return { type: 'ig', valid: true, ...data };
    }
    const { data } = await axios.get(`${GRAPH_FB(this.version)}/debug_token`, {
      params: { input_token: this.token, access_token: this.token },
    });
    return { type: 'fb', ...data.data };
  }

  async getProfile() {
    const fields = this.tokenType === 'ig'
      ? 'id,username,account_type,media_count,followers_count,follows_count,name,profile_picture_url'
      : 'id,username,name,profile_picture_url,followers_count,media_count';
    return this._get(`/${this.igUserId}`, { fields });
  }

  async getMedia({ limit = 25, after = null } = {}) {
    return this._get(`/${this.igUserId}/media`, {
      fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
      limit,
      ...(after ? { after } : {}),
    });
  }

  async getMediaInsights(mediaId, metrics = 'reach,likes,comments,shares,saved,total_interactions') {
    return this._get(`/${mediaId}/insights`, { metric: metrics });
  }

  async getAccountInsights({ period = 'day', metrics = 'reach,profile_views,accounts_engaged' } = {}) {
    return this._get(`/${this.igUserId}/insights`, {
      metric: metrics,
      period,
      metric_type: 'total_value',
    });
  }

  async getPublishingLimit() {
    return this._get(`/${this.igUserId}/content_publishing_limit`, {
      fields: 'config,quota_usage',
    });
  }

  async createImageContainer({ imageUrl, caption, altText, isCarouselItem = false }) {
    return this._post(`/${this.igUserId}/media`, {
      image_url: imageUrl,
      caption: isCarouselItem ? undefined : caption,
      alt_text: altText || undefined,
      is_carousel_item: isCarouselItem || undefined,
    });
  }

  async createReelContainer({ videoUrl, caption, shareToFeed = true }) {
    return this._post(`/${this.igUserId}/media`, {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      share_to_feed: shareToFeed,
    });
  }

  async createVideoCarouselItem({ videoUrl }) {
    return this._post(`/${this.igUserId}/media`, {
      media_type: 'VIDEO',
      video_url: videoUrl,
      is_carousel_item: true,
    });
  }

  async createCarouselContainer({ children, caption }) {
    return this._post(`/${this.igUserId}/media`, {
      media_type: 'CAROUSEL',
      children: children.join(','),
      caption,
    });
  }

  async createStoryContainer({ imageUrl, videoUrl }) {
    if (!imageUrl && !videoUrl) throw new Error('Story 需要 imageUrl 或 videoUrl');
    return this._post(`/${this.igUserId}/media`, {
      media_type: 'STORIES',
      ...(imageUrl ? { image_url: imageUrl } : { video_url: videoUrl }),
    });
  }

  async getContainerStatus(creationId) {
    return this._get(`/${creationId}`, { fields: 'status_code,status' });
  }

  async waitForContainer(creationId, { timeoutMs = 300000, intervalMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.getContainerStatus(creationId);
      if (s.status_code === 'FINISHED') return s;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
        throw new Error(`容器處理失敗：${s.status_code} - ${s.status || ''}`);
      }
      await sleep(intervalMs);
    }
    throw new Error('容器處理逾時');
  }

  async publish(creationId) {
    return this._post(`/${this.igUserId}/media_publish`, { creation_id: creationId });
  }

  async getMediaPermalink(mediaId) {
    return this._get(`/${mediaId}`, { fields: 'permalink' });
  }

  async postComment(mediaId, message) {
    return this._post(`/${mediaId}/comments`, { message });
  }

  async refreshToken() {
    const base = this.tokenType === 'ig' ? GRAPH_IG(this.version) : GRAPH_FB(this.version);
    const { data } = await axios.get(`${base}/refresh_access_token`, {
      params: { grant_type: 'ig_refresh_token', access_token: this.token },
    });
    return data;
  }

  async publishImagePost({ imageUrl, caption, altText }) {
    const c = await this.createImageContainer({ imageUrl, caption, altText });
    await this.waitForContainer(c.id, { timeoutMs: 60000 });
    return this.publish(c.id);
  }

  async publishReelPost({ videoUrl, caption, shareToFeed = true }) {
    const c = await this.createReelContainer({ videoUrl, caption, shareToFeed });
    await this.waitForContainer(c.id);
    return this.publish(c.id);
  }

  async publishStoryPost({ imageUrl, videoUrl }) {
    const c = await this.createStoryContainer({ imageUrl, videoUrl });
    await this.waitForContainer(c.id, { timeoutMs: 120000 });
    return this.publish(c.id);
  }

  async publishCarouselPost({ items, caption }) {
    const childIds = [];
    for (const item of items) {
      let c;
      if (item.type === 'image') {
        c = await this.createImageContainer({ imageUrl: item.url, isCarouselItem: true });
      } else if (item.type === 'video') {
        c = await this.createVideoCarouselItem({ videoUrl: item.url });
        await this.waitForContainer(c.id);
      } else {
        throw new Error(`輪播不支援的類型：${item.type}`);
      }
      childIds.push(c.id);
    }
    const parent = await this.createCarouselContainer({ children: childIds, caption });
    await this.waitForContainer(parent.id, { timeoutMs: 60000 });
    return this.publish(parent.id);
  }
}
