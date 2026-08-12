import { join } from "node:path";

// 契约 §3.0：DATA_DIR 为应用数据根目录；生产环境 cmd/main 会设置
// STORAGE_DIR=${TRIM_PKGVAR}/data，正好等于契约 DATA_DIR。
// 本地开发未设置 STORAGE_DIR 时回退 <cwd>/data。
export function getDataDir() {
  return process.env.STORAGE_DIR || join(process.cwd(), "data");
}

// 契约 §3.0：EXEC_DIR=$DATA_DIR/executor（应用对该目录只读）。
export function getExecDir() {
  return join(getDataDir(), "executor");
}

export function getConfigFilePath() {
  return join(getDataDir(), "config.json");
}

export function getSkipFilePath() {
  return join(getDataDir(), "skip.json");
}

export function getStatusFilePath() {
  return join(getExecDir(), "status.json");
}
