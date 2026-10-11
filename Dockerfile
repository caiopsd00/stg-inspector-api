FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server ./server
COPY contracts ./contracts
COPY tests ./tests
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer fonts-liberation && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY database ./database
COPY template/inspecao-final-assinatura.docx ./template/inspecao-final-assinatura.docx
RUN mkdir -p storage && chown -R node:node /app
USER node
EXPOSE 3333
CMD ["node","dist/server/index.js"]
