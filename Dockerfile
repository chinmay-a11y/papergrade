# Node 24 for the built-in node:sqlite module. All deps are pure JS (no native build).
FROM node:24-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3400
EXPOSE 3400
CMD ["node", "server.js"]
