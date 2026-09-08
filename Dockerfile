# The hosted nixamp: the PWA, served by nixamp's own server.
#
# Nothing about this image needs ffmpeg. The deployment has no library to play
# — it hands out the player, and the player either opens your files in the
# browser or points itself at the nixamp on your own machine.
FROM oven/bun:1 AS build
WORKDIR /app

# electron is a devDependency of the desktop workspace and has no business in
# a web image; skipping its 200 MB runtime is the difference between a build
# that takes a minute and one that takes ten.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json bun.lock ./
COPY web/package.json web/package.json
COPY desktop/package.json desktop/package.json
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build && bun run web:build

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/package.json ./package.json

# An empty library on purpose: /app/library holds nothing unless a volume is
# mounted there, so the server starts, serves the PWA, and says it has no
# tracks rather than pretending to.
#
# The port comes from PORT, which the platform sets.
# --no-key: this one is meant to be public. Everywhere else a key from the
# share link is required, and the hosted PWA has no library to guard anyway.
CMD ["bun", "dist/serve.js", "/app/library", "--host", "0.0.0.0", "--no-media", "--no-key", "--web", "/app/web/dist"]
