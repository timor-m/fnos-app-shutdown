import { defineEventHandler, setResponseHeader, setResponseStatus } from "h3";
import { fail } from "../../../utils/api-response";
import { readExecutorScript } from "../../../services/executor.service";

// 契约 §3.5：返回脚本原始字节，不得转码/裁剪；
// 该端点必须允许匿名访问（部署一键命令在 SSH 中无登录 cookie），路由本身不做用户校验。
export default defineEventHandler(async (event) => {
  const script = await readExecutorScript();

  if (!script) {
    setResponseStatus(event, 404);
    return fail("执行器脚本不存在：包内缺少 assets/fnos-shutdown-executor.sh");
  }

  setResponseHeader(event, "content-type", "text/plain; charset=utf-8");
  return script;
});
