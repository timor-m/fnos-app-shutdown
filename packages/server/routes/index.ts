import { defineEventHandler, getRequestURL, sendProxy, setResponseHeader } from "h3";
import { readUiIndexHtml } from "../utils/ui-files";

export default defineEventHandler(async (event) => {
  const viteDevServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (viteDevServerUrl) {
    return sendProxy(event, `${viteDevServerUrl}${getRequestURL(event).pathname}${getRequestURL(event).search}`);
  }

  const html = await readUiIndexHtml();
  setResponseHeader(event, "content-type", "text/html; charset=utf-8");
  return html;
});
