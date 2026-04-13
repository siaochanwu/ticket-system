# 構建階段
FROM node:20-alpine AS build

WORKDIR /app

# 先複製 package 檔案以利用 Docker layer 快取
COPY package*.json ./
COPY prisma ./prisma/

# 安裝依賴
RUN npm ci

# 複製其餘原始碼
COPY . .

# 產生 Prisma Client
RUN npx prisma generate

# 編譯 TypeScript
RUN npm run build

# 執行階段
FROM node:20-alpine

WORKDIR /app

# 安裝 Prisma 在 Alpine 上執行所需的系統套件
RUN apk add --no-cache openssl libc6-compat

# 從構建階段複製必要檔案
COPY --from=build /app/package*.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules ./node_modules

# 設定環境變數
ENV NODE_ENV=production
ENV PORT=3000

# 啟動應用程式
# 注意：這裡使用 node 執行編譯後的 JS
CMD npx prisma migrate deploy && node dist/app.js