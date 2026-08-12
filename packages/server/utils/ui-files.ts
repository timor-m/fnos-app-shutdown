import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getAppConfig } from "./runtime-config";

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const builtPublicDir = normalize(join(runtimeDir, "../../public"));

function candidatePublicDirs() {
  return [
    join(process.cwd(), ".ui-dist"),
    join(process.cwd(), ".server-dist", "public"),
    builtPublicDir
  ];
}

export function isAssetRequest(pathname: string) {
  return pathname.startsWith("/assets/") || pathname === "/favicon.ico" || extname(pathname) !== "";
}

export function stripGatewayPrefix(pathname: string) {
  const { gatewayPrefix } = getAppConfig();

  if (pathname === gatewayPrefix) {
    return "/";
  }

  if (pathname.startsWith(`${gatewayPrefix}/`)) {
    return pathname.slice(gatewayPrefix.length);
  }

  return pathname;
}

export function resolveUiFile(pathname: string) {
  const safePath = normalize(stripGatewayPrefix(pathname)).replace(/^(\.\.(\/|\\|$))+/, "");

  for (const baseDir of candidatePublicDirs()) {
    const filePath = join(baseDir, safePath);
    if (existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

export async function readUiFile(pathname: string) {
  const filePath = resolveUiFile(pathname);
  if (!filePath) {
    return null;
  }

  return readFile(filePath);
}

export async function readUiIndexHtml() {
  for (const baseDir of candidatePublicDirs()) {
    const indexPath = join(baseDir, "index.html");
    if (existsSync(indexPath)) {
      return readFile(indexPath, "utf8");
    }
  }

  throw new Error("Unable to locate built UI index.html.");
}
