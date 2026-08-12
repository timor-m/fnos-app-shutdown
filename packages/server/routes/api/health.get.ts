import { defineEventHandler } from "h3";
import { ok } from "../../utils/api-response";
import { getAppConfig } from "../../utils/runtime-config";

export default defineEventHandler(() => {
  const config = getAppConfig();

  return ok({
    service: config.appName,
    runtime: "nitro",
    accessMode: config.accessMode,
    gatewayPrefix: config.gatewayPrefix,
    port: config.appPort
  });
});
