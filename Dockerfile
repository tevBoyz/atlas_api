# syntax=docker/dockerfile:1

# Node version must match .nvmrc and package.json "engines".
ARG NODE_VERSION=24.19.0

# ---- build: install all deps and compile TypeScript ----
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
# Git commit for the Sentry release (API-100-06), recorded in dist/build-info.json by postbuild.
# Pass it with `--build-arg GIT_COMMIT=$(git rev-parse HEAD)`; without it the release is unset.
ARG GIT_COMMIT=
RUN npm run build

# ---- deps: production dependencies only ----
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime: minimal image, non-root ----
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# The official Node image ships an unprivileged "node" user (uid 1000).
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
