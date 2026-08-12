import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../../../package.json" with { type: "json" };
import { getStatusFilePath } from "../utils/data-paths";

// 应用包内版本 = executor SCRIPT_VERSION（契约 §3.5 版本同步规则）。
export const APP_VERSION: string = packageJson.version;

export type ExecutorStatusFile = {
  script_version?: string;
  last_trigger?: string;
  last_action?: string;
  config_fallback?: boolean;
  monitoring?: boolean;
  [key: string]: unknown;
};

// 契约 §3.3 应用派生状态（部署页四态），谓词逐字实现：
//   undeployed：status.json 不存在（损坏按不存在处理，§6）
//   outdated ：存在且 script_version != 应用包内版本
//   stalled  ：存在且版本一致但 now - last_trigger > 20 分钟
//   ok       ：其余
export type ExecutorState = "undeployed" | "outdated" | "stalled" | "ok";

const STALL_THRESHOLD_MS = 20 * 60 * 1000;

export type ExecutorStatusResult = {
  state: ExecutorState;
  status: ExecutorStatusFile | null;
  appVersion: string;
};

export async function readExecutorStatus(now = new Date()): Promise<ExecutorStatusResult> {
  let raw: string;
  try {
    raw = await readFile(getStatusFilePath(), "utf8");
  } catch {
    return { state: "undeployed", status: null, appVersion: APP_VERSION };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // §6：status.json 损坏 → 判定 🔴 未部署
    return { state: "undeployed", status: null, appVersion: APP_VERSION };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "undeployed", status: null, appVersion: APP_VERSION };
  }

  const status = parsed as ExecutorStatusFile;

  // §7 向后兼容：容忍缺失字段，按 §3.3 谓词降级判定。
  if (status.script_version !== APP_VERSION) {
    return { state: "outdated", status, appVersion: APP_VERSION };
  }

  const lastTriggerMs = typeof status.last_trigger === "string"
    ? Date.parse(status.last_trigger)
    : Number.NaN;

  if (Number.isNaN(lastTriggerMs) || now.getTime() - lastTriggerMs > STALL_THRESHOLD_MS) {
    return { state: "stalled", status, appVersion: APP_VERSION };
  }

  return { state: "ok", status, appVersion: APP_VERSION };
}

const runtimeDir = dirname(fileURLToPath(import.meta.url));

// 契约 §3.5：包内路径 app/server/assets/fnos-shutdown-executor.sh。
// 候选路径按顺序找：① 构建产物相对位置 ② 源码相对位置 ③ cwd 兜底。
// 注意：nitro 构建后本模块位于 .server-dist/server/_chunks/（打包后 app/server/server/_chunks/），
// 上溯两级恰为 .server-dist/（打包后 app/server/）。
function candidateScriptPaths() {
  return [
    // ① 构建产物/包内：.server-dist/server/_chunks → .server-dist/assets
    //    （打包后 .server-dist 复制为 app/server，即契约路径 app/server/assets）
    join(runtimeDir, "../../assets/fnos-shutdown-executor.sh"),
    // ② 源码：packages/server/services → packages/server/assets
    join(runtimeDir, "../assets/fnos-shutdown-executor.sh"),
    // ③ cwd 兜底：仓库根目录本地开发 / 构建产物本地运行
    join(process.cwd(), "packages/server/assets/fnos-shutdown-executor.sh"),
    join(process.cwd(), ".server-dist/assets/fnos-shutdown-executor.sh"),
    join(process.cwd(), "assets/fnos-shutdown-executor.sh")
  ];
}

export function resolveExecutorScriptPath(): string | null {
  for (const candidate of candidateScriptPaths()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function readExecutorScript(): Promise<Buffer | null> {
  const filePath = resolveExecutorScriptPath();
  if (!filePath) {
    return null;
  }

  // 原始字节返回，不得转码/裁剪（§3.5）。
  return readFile(filePath);
}
