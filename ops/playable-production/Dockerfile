FROM node:26.3.1-bookworm-slim@sha256:9898bb74f4ee319780e87819df703b3633113bc3422f151fd11155cf974a2749 AS dependencies
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev --ignore-scripts
COPY tests/compatibility/package.json tests/compatibility/package-lock.json ./tests/compatibility/
RUN cd tests/compatibility && npm ci --omit=dev --ignore-scripts
COPY companion/package.json companion/package-lock.json ./companion/
RUN cd companion && npm ci
COPY companion/build.mjs ./companion/
COPY companion/src ./companion/src
RUN cd companion && npm run build

FROM node:26.3.1-bookworm-slim@sha256:9898bb74f4ee319780e87819df703b3633113bc3422f151fd11155cf974a2749
RUN groupadd --gid 10001 agentcity && useradd --uid 10001 --gid 10001 --no-create-home agentcity \
 && install -d -o 10001 -g 10001 -m 0700 /app/.local /app/.local/backend /app/.local/playable-world /run/agentcity-runtime /run/agentcity-owner
WORKDIR /app
COPY --from=dependencies /app/backend/node_modules ./backend/node_modules
COPY --from=dependencies /app/tests/compatibility/node_modules ./tests/compatibility/node_modules
COPY --from=dependencies /app/companion/dist ./companion/dist
COPY backend/package.json ./backend/package.json
COPY backend/src ./backend/src
COPY contracts/abi ./contracts/abi
COPY companion/player-wallet.html ./companion/player-wallet.html
COPY scripts/playable_worker.mjs scripts/playable_testnet_setup.mjs scripts/playable_wallet_enroll.mjs ./scripts/
COPY ops/playable-production/entrypoint.mjs ./ops/playable-production/entrypoint.mjs
USER 10001:10001
ENV NODE_ENV=production
ENTRYPOINT ["node", "/app/ops/playable-production/entrypoint.mjs"]
CMD ["console"]
