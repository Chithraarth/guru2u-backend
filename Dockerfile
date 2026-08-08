# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build
# Strip devDependencies from the already-resolved node_modules (esbuild
# externalizes a handful of packages — e.g. firebase-admin — so they must
# still be present at runtime; everything else is bundled into dist/).
RUN npm prune --omit=dev --legacy-peer-deps

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3001
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
