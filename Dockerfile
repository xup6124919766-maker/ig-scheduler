FROM node:24-slim

# ffmpeg 給 AI 影片首幀抽圖用
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 4567

CMD ["node", "server.js"]
