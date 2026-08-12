import { defineEventHandler } from "h3";
import { ok } from "../../utils/api-response";
import { deleteSkip } from "../../services/skip.service";

export default defineEventHandler(async () => {
  // 不存在也算成功（幂等），deleted 表示本次是否真的删掉了文件。
  const deleted = await deleteSkip();
  return ok({ deleted });
});
