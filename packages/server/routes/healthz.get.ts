import { defineEventHandler } from "h3";
import { getAppConfig } from "../utils/runtime-config";

export default defineEventHandler(() => {
  const config = getAppConfig();

  return {
    ok: true,
    service: config.appName,
    runtime: "nitro"
  };
});
