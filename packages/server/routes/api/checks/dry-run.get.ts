import { execFile } from "node:child_process";
import { defineEventHandler, setResponseStatus } from "h3";
import { ok, fail } from "../../../utils/api-response";
import { resolveExecutorScriptPath } from "../../../services/executor.service";
import { getDataDir } from "../../../utils/data-paths";
import { toLocalIso } from "../../../utils/local-time";

// 应用内部 API（契约 §8）：执行包内 executor 脚本的 --dry-run（§4.1 零副作用、任意用户可跑），
// 解析 stdout 得到逐项检查结果。十五项检查逻辑只存在于脚本中，此处不做任何重新实现。

const CHECK_NAMES = [
  "cpu",
  "load",
  "users",
  "ssh",
  "disk_io",
  "network",
  "min_uptime",
  "smb_sessions",
  "tcp_sessions",
  "download_active",
  "vm_running",
  "process_running",
  "disk_scrub",
  "host_online",
  "calendar_rules"
] as const;
type CheckName = (typeof CHECK_NAMES)[number];

// dry_run() 逐项行格式：  [cpu     ] PASS <detail>（[%-8s] %-4s %s）
const CHECK_LINE_RE =
  /^\s*\[(cpu|load|users|ssh|disk_io|network|min_uptime|smb_sessions|tcp_sessions|download_active|vm_running|process_running|disk_scrub|host_online|calendar_rules)\s*\]\s+(PASS|BUSY|SKIP|FAIL)\s*(.*)$/;
const OVERALL_PASS_RE = /^总体: 全部启用检查通过/m;
const OVERALL_LINE_RE = /^总体: /m;

const EXEC_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

function runDryRun(scriptPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // DATA_DIR 对齐应用自身数据根：生产 STORAGE_DIR 即契约 DATA_DIR，
    // dev 回退 <cwd>/data，使 dry-run 读到的 config/skip 与页面一致。
    const env = { ...process.env, FNOS_SHUTDOWN_DATA_DIR: getDataDir() };
    execFile(
      "bash",
      [scriptPath, "--dry-run"],
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, env },
      (err, stdout, stderr) => {
        if (err) {
          const timedOut = err.killed || err.signal === "SIGTERM";
          const detail = timedOut
            ? `执行超时（>${EXEC_TIMEOUT_MS / 1000}s）`
            : stderr.trim() || err.message;
          reject(new Error(`dry-run 执行失败：${detail}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

interface ParsedCheck {
  name: CheckName;
  enabled: boolean;
  result: "pass" | "busy" | "skip" | "fail";
  detail: string;
}

function parseDryRunOutput(stdout: string): {
  overall: "pass" | "fail";
  checks: ParsedCheck[];
} {
  const byName = new Map<CheckName, ParsedCheck>();
  for (const line of stdout.split("\n")) {
    const m = CHECK_LINE_RE.exec(line);
    if (!m) continue;
    const result = m[2].toLowerCase() as ParsedCheck["result"];
    byName.set(m[1] as CheckName, {
      name: m[1] as CheckName,
      enabled: result !== "skip",
      result,
      detail: m[3].trim()
    });
  }
  // 十五项缺一不可，否则视为输出格式变化导致的解析失败
  const checks = CHECK_NAMES.map((n) => byName.get(n));
  if (checks.some((c) => c === undefined) || !OVERALL_LINE_RE.test(stdout)) {
    throw new Error("dry-run 输出解析失败（脚本输出格式与预期不符）");
  }
  return {
    overall: OVERALL_PASS_RE.test(stdout) ? "pass" : "fail",
    checks: checks as ParsedCheck[]
  };
}

export default defineEventHandler(async (event) => {
  const scriptPath = resolveExecutorScriptPath();
  if (!scriptPath) {
    setResponseStatus(event, 502);
    return fail("应用包内未找到执行器脚本（fnos-shutdown-executor.sh）");
  }

  let stdout: string;
  try {
    stdout = await runDryRun(scriptPath);
  } catch (err) {
    setResponseStatus(event, 502);
    return fail(err instanceof Error ? err.message : "dry-run 执行失败");
  }

  try {
    const { overall, checks } = parseDryRunOutput(stdout);
    return ok({ overall, checks, ranAt: toLocalIso(new Date()) });
  } catch (err) {
    setResponseStatus(event, 502);
    return fail(err instanceof Error ? err.message : "dry-run 输出解析失败");
  }
});
