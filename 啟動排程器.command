#!/bin/bash
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "📦 第一次啟動，安裝套件…"
  npm install
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "✅ 已建立 .env（之後可在「設定」分頁貼 Token，不用改檔案）"
fi

PORT=$(grep '^PORT=' .env | cut -d= -f2)
PORT=${PORT:-4567}

(sleep 4 && open "http://localhost:$PORT") &
node server.js
