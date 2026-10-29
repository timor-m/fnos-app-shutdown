import { defineEventHandler, setResponseStatus } from "h3";
import { ok, fail } from "../../utils/api-response";
import { readWake } from "../../services/wake.service";
export default defineEventHandler(async (event) => {
  try { return ok(await readWake()); }
  catch (error) {
    setResponseStatus(event, 503);
    return fail(error instanceof Error ? error.message : "开机计划读取失败");
  }
});
