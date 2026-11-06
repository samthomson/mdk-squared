# mdk² — build the UI, then the all-in-one app image (kernel + worker +
# mocks + fastify + UI in one process; see PLAN.md for the topology note).
FROM node:24-slim AS uibuild
WORKDIR /srv/ui
COPY ui/package.json ui/package-lock.json* ./
RUN npm install
COPY ui/ ./
RUN npm run build

FROM node:24-slim
WORKDIR /srv/app
COPY app/package.json app/package-lock.json* ./
RUN npm install
COPY app/ ./
COPY worker/ /srv/worker/
COPY --from=uibuild /srv/ui/dist /srv/ui/dist
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
