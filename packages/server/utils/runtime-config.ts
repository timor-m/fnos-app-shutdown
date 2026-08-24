import templateConfig from "../../../template.config.json" with { type: "json" };
import { isAbsolute } from "node:path";

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
  /** fnOS 传入的实际应用数据目录；缺失时不得猜测系统盘路径。 */
  storageDir: string | null;
};

export function getAppConfig(): AppRuntimeConfig {
  const appName = process.env.APP_NAME || templateConfig.appName;
  const storageDir = process.env.STORAGE_DIR;

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
    storageDir: storageDir && isAbsolute(storageDir) ? storageDir : null
  };
}
