# syntax=docker/dockerfile:1
# Multi-stage build. The same image runs the API (default) or the worker (command override in docker-compose.yml).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/server/main.js"]
