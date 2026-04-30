import axios from 'axios';

const GRAPH = (v) => `https://graph.facebook.com/${v || 'v21.0'}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const get = async (token, version, path, params = {}) => {
  const { data } = await axios.get(`${GRAPH(version)}${path}`, {
    params: { access_token: token, ...params },
  });
  return data;
};

const post = async (token, version, path, params = {}) => {
  const { data } = await axios.post(`${GRAPH(version)}${path}`, null, {
    params: { access_token: token, ...params },
  });
  return data;
};

export class IGClient {
  constructor({ token, igUserId, version = 'v21.0' }) {
    this.token = token;
    this.igUserId = igUserId;
    this.version = version;
  }

  async resolveAccount() {
    const me = await get(this.token, this.version, '/me/accounts', { fields: 'id,name,instagram_business_account' });
    const page = me.data?.find(p => p.instagram_business_account?.id);
    if (!page) throw new Error('找不到綁定 Instagram 商業帳號的 FB 粉專');
    return {
      pageId: page.id,
      pageName: page.name,
      igUserId: page.instagram_business_account.id,
    };
  }

  async getProfile() {
    return get(this.token, this.version, `/${this.igUserId}`, {
      fields: 'id,username,name,profile_picture_url,followers_count,media_count',
    });
  }

  async createImageContainer({ imageUrl, caption, isCarouselItem = false }) {
    return post(this.token, this.version, `/${this.igUserId}/media`, {
      image_url: imageUrl,
      caption: isCarouselItem ? undefined : caption,
      is_carousel_item: isCarouselItem || undefined,
    });
  }

  async createReelContainer({ videoUrl, caption, shareToFeed = true }) {
    return post(this.token, this.version, `/${this.igUserId}/media`, {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      share_to_feed: shareToFeed,
    });
  }

  async createVideoCarouselItem({ videoUrl }) {
    return post(this.token, this.version, `/${this.igUserId}/media`, {
      media_type: 'VIDEO',
      video_url: videoUrl,
      is_carousel_item: true,
    });
  }

  async createCarouselContainer({ children, caption }) {
    return post(this.token, this.version, `/${this.igUserId}/media`, {
      media_type: 'CAROUSEL',
      children: children.join(','),
      caption,
    });
  }

  async getContainerStatus(creationId) {
    return get(this.token, this.version, `/${creationId}`, {
      fields: 'status_code,status',
    });
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
    return post(this.token, this.version, `/${this.igUserId}/media_publish`, {
      creation_id: creationId,
    });
  }

  async getMediaPermalink(mediaId) {
    return get(this.token, this.version, `/${mediaId}`, { fields: 'permalink' });
  }

  async refreshToken() {
    const { data } = await axios.get(`${GRAPH(this.version)}/refresh_access_token`, {
      params: { grant_type: 'ig_refresh_token', access_token: this.token },
    });
    return data;
  }

  async exchangeShortToLongToken(appId, appSecret, shortToken) {
    const { data } = await axios.get(`${GRAPH(this.version)}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortToken,
      },
    });
    return data;
  }

  async publishImagePost({ imageUrl, caption }) {
    const c = await this.createImageContainer({ imageUrl, caption });
    await this.waitForContainer(c.id, { timeoutMs: 60000 });
    const r = await this.publish(c.id);
    return r;
  }

  async publishReelPost({ videoUrl, caption, shareToFeed = true }) {
    const c = await this.createReelContainer({ videoUrl, caption, shareToFeed });
    await this.waitForContainer(c.id);
    const r = await this.publish(c.id);
    return r;
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
