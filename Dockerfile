FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Remove dev deps after build
RUN npm prune --production

CMD ["node", "dist/index.js"]
