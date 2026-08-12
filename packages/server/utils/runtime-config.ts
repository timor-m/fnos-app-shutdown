import templateConfig from "../../../template.config.json" with { type: "json" };

export type AppRuntimeConfig = {
  appName: string;
  appTitle: string;
  accessMode: "gateway" | "port";
  gatewayPrefix: string;
  appPort: number | null;
  /** 安装/设置向导配置的直连端口（SERVICE_PORT）；0/未设置 = 未启用 */
  servicePort: number | null;
  logLevel: string;
  logDir: string;
  storageDir: string;
};

export function getAppConfig(): AppRuntimeConfig {
  const appName = process.env.APP_NAME || templateConfig.appName;

  return {
    appName,
    appTitle: process.env.APP_TITLE || templateConfig.appTitle,
    accessMode: process.env.FNOS_SOCKET_PATH ? "gateway" : "port",
    gatewayPrefix: process.env.GATEWAY_PREFIX || templateConfig.gatewayPrefix,
    appPort: process.env.FNOS_SOCKET_PATH
      ? null
      : Number(process.env.NITRO_PORT || process.env.PORT || templateConfig.localDevPort),
    servicePort: Number(process.env.SERVICE_PORT || 0) || null,
    logLevel: process.env.LOG_LEVEL || templateConfig.logLevel,
    logDir: process.env.LOG_DIR || `/var/apps/${appName}/var/log`,
    storageDir: process.env.STORAGE_DIR || `/var/apps/${appName}/var/data`
  };
}
