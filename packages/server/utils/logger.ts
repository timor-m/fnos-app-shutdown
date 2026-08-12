import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getAppConfig } from "./runtime-config";

type LogLevel = "info" | "warn" | "error";

export async function writeLog(level: LogLevel, message: string, extra?: Record<string, unknown>) {
  const config = getAppConfig();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    extra: extra || {}
  });

  try {
    const filePath = `${config.logDir}/app.log`;
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${line}\n`, "utf8");
  } catch {
    // Ignore filesystem write failures in template mode.
  }
}
