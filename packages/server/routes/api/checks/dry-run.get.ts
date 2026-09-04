import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
const INSTALLED_EXECUTOR = "/usr/local/sbin/fnos-shutdown-executor.sh";

function execDryRun(command: string, args: string[], env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
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

async function runDryRun(scriptPath: string): Promise<{
  stdout: string;
  executionMode: "privileged" | "unprivileged";
}> {
  // 部署完成后，sudoers 只允许这一条无参数固定命令。数据目录由 root:root 600
  // 的 /etc/fnos-shutdown-data-dir 提供，应用不能通过参数或环境变量改变 root 读取范围。
  if (existsSync(INSTALLED_EXECUTOR)) {
    try {
      const stdout = await execDryRun("sudo", ["-n", INSTALLED_EXECUTOR, "--privileged-dry-run"]);
      return { stdout, executionMode: "privileged" };
    } catch {
      // 未重新部署 sudoers、旧执行器不认识新参数等场景保持功能可用；UI 会明确标记
      // 低权限模式，避免把 SMB/libvirt/btrfs 的权限失败误认为真实 cron 结果。
    }
  }

  const env = { ...process.env, FNOS_SHUTDOWN_DATA_DIR: getDataDir() };
  const stdout = await execDryRun("bash", [scriptPath, "--dry-run"], env);
  return { stdout, executionMode: "unprivileged" };
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
  let executionMode: "privileged" | "unprivileged";
  try {
    ({ stdout, executionMode } = await runDryRun(scriptPath));
  } catch (err) {
    setResponseStatus(event, 502);
    return fail(err instanceof Error ? err.message : "dry-run 执行失败");
  }

  try {
    const { overall, checks } = parseDryRunOutput(stdout);
    return ok({ overall, checks, executionMode, ranAt: toLocalIso(new Date()) });
  } catch (err) {
    setResponseStatus(event, 502);
    return fail(err instanceof Error ? err.message : "dry-run 输出解析失败");
  }
});
