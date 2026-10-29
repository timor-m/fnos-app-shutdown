import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../utils/data-paths";
import { resolveExecutorScriptPath } from "./executor.service";

export const DEFAULT_WAKE = { version: 1, enabled: false, device: "auto", alarm_policy: "preserve", plans: [] };
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");

// A single signed runtime supplies validation and previews to both processes.
export function wakeRuntime(mode: "inspect" | "validate", config: unknown): Promise<any> {
  const script = resolveExecutorScriptPath();
  if (!script) return Promise.reject(new Error("找不到开机执行器脚本"));
  return new Promise((resolve, reject) => {
    const child = execFile("/bin/bash", [script, `--wake-${mode}`], {
      timeout: 10_000, maxBuffer: 512 * 1024
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || "开机支持检测失败；请确认系统提供 /usr/bin/python3（3.8+）"));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("开机执行器返回了无效数据")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(config));
  });
}

async function current() {
  try {
    const handle = await open(join(getDataDir(), "wake.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536) throw new Error("开机配置必须为不超过 64 KiB 的普通文件");
      const raw = await handle.readFile("utf8");
      return { raw, revision: digest(raw) };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { raw: JSON.stringify(DEFAULT_WAKE), revision: "missing" };
  }
}

export async function readWake() {
  const { raw, revision } = await current();
  let config: unknown, configError: string | null = null;
  try {
    if (Buffer.byteLength(raw) > 65536) throw new Error("开机配置超过 64 KiB");
    config = await wakeRuntime("validate", JSON.parse(raw));
  } catch (error) {
    configError = error instanceof Error ? error.message : "配置损坏";
    config = DEFAULT_WAKE;
  }
  return { ...await wakeRuntime("inspect", config), revision, config_error: configError };
}

// Serialize compare-and-save so concurrent tabs cannot both pass the revision check.
let saving = Promise.resolve();
export function saveWake(body: { revision?: string; config?: unknown }) {
  const task = saving.then(async () => {
    const config = await wakeRuntime("validate", body.config);
    const before = await current();
    if (body.revision !== before.revision) throw new Error("配置已被其他窗口修改，请刷新后重试");
    const directory = getDataDir();
    await mkdir(directory, { recursive: true });
    const path = join(directory, "wake.json");
    const temporary = join(directory, `.wake-${randomUUID()}.tmp`);
    const raw = JSON.stringify(config, null, 2) + "\n";
    const handle = await open(temporary, "wx", 0o644);
    try {
      await handle.writeFile(raw, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
    return readWake();
  });
  saving = task.then(() => {}, () => {});
  return task;
}
