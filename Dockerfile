FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY evals/package.json evals/package.json

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @sapiensq/web build

ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_PATH=/data/bank.sqlite
EXPOSE 3000
VOLUME ["/data"]

CMD ["pnpm", "--filter", "@sapiensq/api", "start"]
