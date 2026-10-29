import { defineEventHandler, getHeader, readRawBody, setResponseStatus } from "h3";
import { ok, fail } from "../../utils/api-response";
import { saveWake } from "../../services/wake.service";
export default defineEventHandler(async (event) => {
  if (getHeader(event, "content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    setResponseStatus(event, 415); return fail("仅接受 application/json");
  }
  if (Number(getHeader(event, "content-length")) > 65536) {
    setResponseStatus(event, 413); return fail("请求超过 64 KiB");
  }
  try {
    const raw = await readRawBody(event, "utf8") || "";
    if (Buffer.byteLength(raw) > 65536) { setResponseStatus(event, 413); return fail("请求超过 64 KiB"); }
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || typeof body.revision !== "string") throw new Error("缺少配置版本，请刷新后重试");
    return ok(await saveWake(body));
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存失败";
    setResponseStatus(event, message.includes("其他窗口") ? 409 : 400);
    return fail(message);
  }
});
