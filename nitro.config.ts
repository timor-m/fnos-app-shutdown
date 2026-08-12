import templateConfig from "./template.config.json" with { type: "json" };

export default defineNitroConfig({
  preset: "node-middleware",
  baseURL: `${templateConfig.gatewayPrefix}/`,
  serverDir: "packages/server",
  output: {
    dir: ".server-dist"
  },
  publicAssets: [
    {
      dir: ".ui-dist"
    }
  ],
  runtimeConfig: {
    appName: templateConfig.appName,
    appTitle: templateConfig.appTitle,
    appPort: templateConfig.localDevPort,
    logLevel: templateConfig.logLevel,
    logDir: `/var/apps/${templateConfig.appName}/var/log`,
    storageDir: `/var/apps/${templateConfig.appName}/var/data`
  },
  routeRules: {
    "/": {
      prerender: false
    },
    "/healthz": {
      headers: {
        "cache-control": "no-store"
      }
    }
  }
});
