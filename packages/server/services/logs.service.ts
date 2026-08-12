import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getExecDir } from "../utils/data-paths";

// 契约 §3.4：executor/YYYY-MM.log 按月滚动；应用只读原文展示，
// 禁止结构化解析——此处只做文件名列举与行分页，绝不解析内容。

const MONTH_FILE_RE = /^(\d{4})-(0[1-9]|1[0-2])\.log$/;
export const MONTH_PARAM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function listLogMonths(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(getExecDir());
  } catch {
    // EXEC_DIR 不存在（executor 未部署/未运行）→ 空列表
    return [];
  }

  // 读取侧忽略 *.tmp（§3.0）；只认 YYYY-MM.log。
  return entries
    .filter((name) => MONTH_FILE_RE.test(name))
    .map((name) => name.slice(0, 7))
    .sort()
    .reverse();
}

export type LogPage = {
  totalLines: number;
  offset: number;
  lines: string[];
};

export async function readLogMonth(month: string, offset: number, limit: number): Promise<LogPage | null> {
  // month 必须先经 MONTH_PARAM_RE 校验（路由层），这里再兜底防路径穿越。
  if (!MONTH_PARAM_RE.test(month)) {
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(join(getExecDir(), `${month}.log`), "utf8");
  } catch {
    return null;
  }

  const allLines = raw.split("\n");
  // 文件以换行结尾时去掉末尾空行
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  return {
    totalLines: allLines.length,
    offset,
    lines: allLines.slice(offset, offset + limit)
  };
}
