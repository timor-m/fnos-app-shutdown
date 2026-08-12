import { readFile, rm } from "node:fs/promises";
import { writeFileAtomic } from "../utils/atomic-file";
import { getSkipFilePath } from "../utils/data-paths";
import { toLocalIso } from "../utils/local-time";

// 契约 §3.2：skip.json。文件不存在 → 无跳过；now ≥ skip_until → 无跳过（自然过期）；
// 解析失败 → 视为跳过生效（fail-safe：宁可不关机）。
export type SkipFileContent = {
  skip_until: string;
  reason?: string;
  created?: string;
};

export type SkipInfo = {
  exists: boolean;
  active: boolean;
  // 文件存在但解析失败/字段非法 → fail-safe 生效。
  corrupted: boolean;
  skipUntil: string | null;
  reason: string | null;
  created: string | null;
};

const NO_SKIP: SkipInfo = {
  exists: false,
  active: false,
  corrupted: false,
  skipUntil: null,
  reason: null,
  created: null
};

function corruptedSkip(): SkipInfo {
  return { ...NO_SKIP, exists: true, active: true, corrupted: true };
}

export async function readSkip(now = new Date()): Promise<SkipInfo> {
  let raw: string;
  try {
    raw = await readFile(getSkipFilePath(), "utf8");
  } catch {
    return NO_SKIP;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return corruptedSkip();
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return corruptedSkip();
  }

  const content = parsed as Record<string, unknown>;
  const skipUntil = typeof content.skip_until === "string" ? content.skip_until : null;
  const untilMs = skipUntil ? Date.parse(skipUntil) : Number.NaN;

  if (!skipUntil || Number.isNaN(untilMs)) {
    return corruptedSkip();
  }

  return {
    exists: true,
    active: now.getTime() < untilMs,
    corrupted: false,
    skipUntil,
    reason: typeof content.reason === "string" ? content.reason : null,
    created: typeof content.created === "string" ? content.created : null
  };
}

export async function writeSkip(skipUntil: Date): Promise<SkipFileContent> {
  const content: SkipFileContent = {
    skip_until: toLocalIso(skipUntil),
    reason: "manual",
    created: toLocalIso(new Date())
  };

  await writeFileAtomic(getSkipFilePath(), `${JSON.stringify(content, null, 2)}\n`);
  return content;
}

// 取消跳过 = 删除文件；不存在也算成功（幂等）。
export async function deleteSkip(): Promise<boolean> {
  try {
    await rm(getSkipFilePath());
    return true;
  } catch {
    return false;
  }
}
