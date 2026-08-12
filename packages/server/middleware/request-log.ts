import { defineEventHandler, getRequestURL } from "h3";
import { writeLog } from "../utils/logger";

export default defineEventHandler((event) => {
  const startedAt = Date.now();
  const url = getRequestURL(event);

  event.node.res.on("finish", () => {
    void writeLog("info", "request", {
      method: event.method,
      path: url.pathname,
      statusCode: event.node.res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
});
