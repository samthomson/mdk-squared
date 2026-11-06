# mdk² — all-in-one image: kernel + worker + mocks + fastify + UI.
# (The wn/wnd binaries for White Noise group control are NOT built here —
# Rust-in-Docker is slow and brittle. Mount prebuilt binaries at
# /usr/local/bin if you need chat control on the server; without them the
# app runs everything else and marmot falls back.)
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
