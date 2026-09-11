import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: { target: "es2022", assetsDir: "assets" },
  server: {
    port: 5174,
    proxy: { "/api": "http://127.0.0.1:4321" },
    fs: { allow: [resolve(here, "..")] },
  },
  preview: { port: 4174 },
});
