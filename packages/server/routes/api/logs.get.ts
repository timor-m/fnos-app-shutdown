import { defineEventHandler, getQuery, setResponseStatus } from "h3";
import { fail, ok } from "../../utils/api-response";
import { listLogMonths, MONTH_PARAM_RE, readLogMonth } from "../../services/logs.service";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const month = query.month;

  if (month === undefined) {
    return ok({ months: await listLogMonths() });
  }

  // 校验格式，防路径穿越
  if (typeof month !== "string" || !MONTH_PARAM_RE.test(month)) {
    setResponseStatus(event, 400);
    return fail("month 参数非法：需为 YYYY-MM");
  }

  const offset = parseNonNegativeInt(query.offset, 0);
  const limit = parseNonNegativeInt(query.limit, DEFAULT_LIMIT);
  if (offset === null || limit === null) {
    setResponseStatus(event, 400);
    return fail("offset/limit 参数非法：需为非负整数");
  }

  // 契约 §3.4：只做原文返回，绝不解析内容。
  const page = await readLogMonth(month, offset, Math.min(limit, MAX_LIMIT));
  if (!page) {
    setResponseStatus(event, 404);
    return fail(`日志不存在：${month}`);
  }

  return ok({ month, totalLines: page.totalLines, offset: page.offset, lines: page.lines });
});

function parseNonNegativeInt(value: unknown, fallback: number): number | null {
  if (value === undefined) {
    return fallback;
  }

  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string" || !/^\d+$/.test(text)) {
    return null;
  }

  return Number(text);
}
