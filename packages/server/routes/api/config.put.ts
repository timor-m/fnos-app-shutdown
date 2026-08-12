import { defineEventHandler, readRawBody, setResponseStatus } from "h3";
import { fail, ok } from "../../utils/api-response";
import { validateConfig, writeConfig } from "../../services/config.service";

export default defineEventHandler(async (event) => {
  const raw = await readRawBody(event, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    setResponseStatus(event, 400);
    return fail("请求体不是合法的 JSON");
  }

  // 契约 §3.1 写入规则：写入前完整校验，非法输入拒绝并提示，不得落盘。
  const errors: string[] = [];
  const config = validateConfig(parsed, (path, problem) => {
    errors.push(`${path}: ${problem}`);
  });

  if (errors.length > 0) {
    setResponseStatus(event, 400);
    return fail(`配置校验未通过：${errors.join("；")}`);
  }

  await writeConfig(config);
  return ok({ config });
});
