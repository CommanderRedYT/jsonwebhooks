FROM node:23-alpine AS base

WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM base AS runner

WORKDIR /app

COPY src/ ./src
COPY tsconfig.json ./

RUN yarn start
