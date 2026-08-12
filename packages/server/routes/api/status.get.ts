import { defineEventHandler } from "h3";
import { ok } from "../../utils/api-response";
import { readConfig } from "../../services/config.service";
import { readExecutorStatus } from "../../services/executor.service";
import { readSkip } from "../../services/skip.service";
import { currentOrNextWindow, parseWindowTime, toLocalIso } from "../../utils/local-time";

export default defineEventHandler(async () => {
  const now = new Date();
  const [{ config }, executor, skip] = await Promise.all([
    readConfig(),
    readExecutorStatus(now),
    readSkip(now)
  ]);

  const startMin = parseWindowTime(config.window.start) ?? 23 * 60;
  const endMin = parseWindowTime(config.window.end) ?? 8 * 60;
  const window = currentOrNextWindow(now, startMin, endMin);

  return ok({
    executor: {
      state: executor.state,
      status: executor.status,
      appVersion: executor.appVersion
    },
    skip,
    config: {
      enabled: config.enabled,
      window: config.window,
      checkIntervalSec: config.check_interval_sec,
      maxChecks: config.max_checks
    },
    tonight: {
      windowStart: toLocalIso(window.start),
      windowEnd: toLocalIso(window.end),
      inWindow: window.inWindow,
      monitoring: executor.status?.monitoring === true
    }
  });
});
