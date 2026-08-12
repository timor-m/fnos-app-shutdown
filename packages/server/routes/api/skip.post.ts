import { defineEventHandler } from "h3";
import { ok } from "../../utils/api-response";
import { readConfig } from "../../services/config.service";
import { writeSkip } from "../../services/skip.service";
import { currentOrNextWindow, parseWindowTime } from "../../utils/local-time";

export default defineEventHandler(async () => {
  const { config } = await readConfig();

  const startMin = parseWindowTime(config.window.start) ?? 23 * 60;
  const endMin = parseWindowTime(config.window.end) ?? 8 * 60;

  // 契约 §5-B：skip_until 取当前或下一窗口的 end，由应用负责算对。
  const window = currentOrNextWindow(new Date(), startMin, endMin);
  const skip = await writeSkip(window.end);

  return ok({ skip });
});
