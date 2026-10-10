# Сборка: ставим devDependencies (typescript) и компилируем в dist/
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Финальный образ: без зависимостей вообще (runtime deps пустой), только
# скомпилированный JS + Node. Максимально лёгкий контейнер.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "dist/index.js"]
