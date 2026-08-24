import { arch, cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { defineEventHandler } from "h3";
import templateConfig from "../../../../template.config.json" with { type: "json" };
import { ok } from "../../utils/api-response";
import { getAppConfig } from "../../utils/runtime-config";
import { APP_VERSION } from "../../services/executor.service";

// 应用内部 API（契约 §8：应用内部 API 可自由扩展），用于「关于」页展示应用与系统信息。
export default defineEventHandler(() => {
  const cfg = getAppConfig();
  const cpuList = cpus();

  return ok({
    app: {
      appId: cfg.appName,
      appTitle: cfg.appTitle,
      version: APP_VERSION,
      gatewayPrefix: cfg.gatewayPrefix,
      accessMode: cfg.accessMode,
      servicePort: cfg.servicePort,
      runtime: "nitro",
      node: process.version,
      maintainer: templateConfig.maintainer,
      maintainerUrl: templateConfig.maintainerUrl,
      qqGroup: templateConfig.qqGroup,
      repoUrl: templateConfig.maintainerUrl
    },
    system: {
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      release: release(),
      cpu: {
        model: cpuList[0]?.model || "未知",
        cores: cpuList.length
      },
      totalmemMB: Math.round(totalmem() / 1048576),
      freememMB: Math.round(freemem() / 1048576),
      loadavg: loadavg(),
      uptimeSec: Math.floor(uptime()),
      processUptimeSec: Math.floor(process.uptime())
    }
  });
});
