import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import templateConfig from "../../template.config.json" with { type: "json" };

const appPort = Number(process.env.APP_PORT || templateConfig.localDevPort);
const webPort = Number(process.env.WEB_PORT || appPort + 1);
const gatewayPrefix = templateConfig.gatewayPrefix;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: `${gatewayPrefix}/`,
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      [`${gatewayPrefix}/api`]: `http://127.0.0.1:${appPort}`,
      [`${gatewayPrefix}/healthz`]: `http://127.0.0.1:${appPort}`
    }
  },
  build: {
    outDir: fileURLToPath(new URL("../../.ui-dist", import.meta.url)),
    emptyOutDir: true
  }
});
