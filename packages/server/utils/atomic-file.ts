import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

// 契约 §3.0 写入协议：写同目录 <目标名>.tmp → fsync → rename。
// 同目录 rename 保证原子性，对端永远只读到完整文件。
export async function writeFileAtomic(filePath: string, content: string) {
  await mkdir(dirname(filePath), { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tmpPath, filePath);
}
