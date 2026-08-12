#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const rootDir = resolve(dirname(new URL(import.meta.url).pathname), "..");
const toolsDir = join(rootDir, "tools");
const version = process.env.FNPACK_VERSION || "1.2.3";
const force = process.env.FNPACK_FORCE === "1";

const platformMap = {
  darwin: {
    arm64: "darwin-arm64",
    x64: "darwin-amd64"
  },
  linux: {
    arm64: "linux-arm64",
    x64: "linux-amd64"
  },
  win32: {
    x64: "windows-amd64"
  }
};

const target = platformMap[process.platform]?.[process.arch];

if (!target) {
  throw new Error(`Unsupported platform for fnpack download: ${process.platform}/${process.arch}`);
}

mkdirSync(toolsDir, { recursive: true });

const filename = process.platform === "win32" ? "fnpack.exe" : "fnpack";
const outputPath = join(toolsDir, filename);
const versionPath = join(toolsDir, "fnpack.version");

if (
  existsSync(outputPath)
  && existsSync(versionPath)
  && readFileSync(versionPath, "utf8").trim() === version
  && !force
) {
  console.log(`fnpack ${version} already exists: ${outputPath}`);
  process.exit(0);
}

const downloadUrl = `https://static2.fnnas.com/fnpack/fnpack-${version}-${target}`;
console.log(`Downloading fnpack ${version} from ${downloadUrl}`);

const response = await fetch(downloadUrl);
if (!response.ok || !response.body) {
  throw new Error(`Failed to download fnpack: ${response.status} ${response.statusText}`);
}

const buffer = Buffer.from(await response.arrayBuffer());
writeFileSync(outputPath, buffer);
writeFileSync(versionPath, `${version}\n`, "utf8");

if (process.platform !== "win32") {
  chmodSync(outputPath, 0o755);
}

console.log(`Saved fnpack to ${outputPath}`);
