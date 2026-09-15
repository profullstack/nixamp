# The hosted nixamp: the PWA, served by nixamp's own server.
#
# The same backend serves BackToSchool.help and carries live microphone audio.
# It also decodes each shared live translation once for all its listeners.
# FFmpeg is required even though the hosted library starts empty.
FROM oven/bun:1 AS build
WORKDIR /app

# electron is a devDependency of the desktop workspace and has no business in
# a web image; skipping its 200 MB runtime is the difference between a build
# that takes a minute and one that takes ten.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json bun.lock ./
COPY web/package.json web/package.json
COPY desktop/package.json desktop/package.json
COPY backtoschool/package.json backtoschool/package.json
COPY packages packages
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build && bun run web:build && bun run backtoschool:build

# The runtime's dependencies, installed once here rather than by bun's
# auto-install at first boot: auto-install reads `dependencies` only, and
# the ear (@huggingface/transformers, see src/speech.ts) is an OPTIONAL
# dependency so the CLI tarball stays pure JavaScript. Without this stage
# nixamp.com answered every transcribe with "cannot hear". --production
# leaves the compilers and bundlers out; the optional ones come along.
FROM oven/bun:1 AS deps
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json bun.lock ./
COPY web/package.json web/package.json
COPY desktop/package.json desktop/package.json
COPY backtoschool/package.json backtoschool/package.json
COPY packages packages
RUN bun install --frozen-lockfile --production

# The models, fetched once here rather than at the first ask after every
# deploy: the filesystem is thrown away each time, and the ear (80 MB) plus
# the German, Swedish, and Spanish translation pairs (about 100 MB each) are what a
# caption, a dictated line and a translated transcript wait for. See
# src/warm.ts; NIXAMP_MT_WARM names the pairs.
FROM oven/bun:1 AS models
WORKDIR /app
ENV NIXAMP_STT_CACHE=/app/models
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
RUN bun dist/warm.js

FROM oven/bun:1-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV NIXAMP_WEB_SITES='{"https://backtoschool.help":"/app/backtoschool/dist","https://www.backtoschool.help":"/app/backtoschool/dist"}'
# Where the models are: the ones baked in above, and anything asked for later.
ENV NIXAMP_STT_CACHE=/app/models

COPY --from=deps /app/node_modules ./node_modules
COPY --from=models /app/models ./models
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/backtoschool/dist ./backtoschool/dist
COPY --from=build /app/package.json ./package.json

# An empty library on purpose: /app/library holds nothing unless a volume is
# mounted there, so the server starts, serves the PWA, and says it has no
# tracks rather than pretending to.
#
# The port comes from PORT, which the platform sets.
# --no-key: this one is meant to be public. Everywhere else a key from the
# share link is required, and the hosted PWA has no library to guard anyway.
CMD ["bun", "dist/serve.js", "/app/library", "--host", "0.0.0.0", "--no-media", "--no-key", "--directory", "--no-publish", "--web", "/app/web/dist"]
