# Application image. Explicit hosted settings select durable Azure storage;
# demo describes disabled/simulated external providers, not storage durability.
FROM node:24.21.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:24.21.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
COPY migrations ./migrations
COPY assets/docs/content ./assets/docs/content
RUN mkdir -p .dne-private/evidence && chown -R node:node .dne-private
USER node
ENV DNE_APP_MODE=demo DNE_PORT=3000
EXPOSE 3000
CMD ["node", "dist/main.js"]
