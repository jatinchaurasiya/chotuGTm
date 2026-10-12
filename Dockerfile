FROM node:22-bookworm-slim AS base
WORKDIR /srv/chotu
COPY package.json package-lock.json* ./
RUN npm install --omit=dev 2>/dev/null || npm install --omit=dev
COPY . .
RUN npm run build || npx tsc -p tsconfig.json
EXPOSE 3000
CMD ["node", "dist/src/api/server.js"]
