import { createError, defineEventHandler, getRequestURL, sendProxy, setResponseHeader } from "h3";
import { extname } from "node:path";
import {
  isAssetRequest,
  readUiFile,
  readUiIndexHtml,
  stripGatewayPrefix
} from "../utils/ui-files";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);
  const appPath = stripGatewayPrefix(url.pathname);

  if (appPath.startsWith("/api/") || appPath === "/healthz") {
    throw createError({
      statusCode: 404,
      statusMessage: "Not Found"
    });
  }

  const viteDevServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (viteDevServerUrl) {
    return sendProxy(event, `${viteDevServerUrl}${url.pathname}${url.search}`);
  }

  const file = await readUiFile(appPath);
  if (!file) {
    if (isAssetRequest(appPath)) {
      throw createError({
        statusCode: 404,
        statusMessage: "Not Found"
      });
    }

    const html = await readUiIndexHtml();
    setResponseHeader(event, "content-type", "text/html; charset=utf-8");
    return html;
  }

  const ext = extname(appPath).toLowerCase();
  const contentType = contentTypes[ext] || "application/octet-stream";
  setResponseHeader(event, "content-type", contentType);
  return file;
});
