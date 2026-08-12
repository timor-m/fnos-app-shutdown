#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
BUILD_DIR="${ROOT_DIR}/.fnos-build/package"

mkdir -p "${DIST_DIR}"
rm -f "${DIST_DIR}/app.tgz"

tar -czf "${DIST_DIR}/app.tgz" -C "${BUILD_DIR}" app

node -e '
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.argv[1];
const appTgz = path.join(root, "dist", "app.tgz");
const manifestPath = path.join(root, ".fnos-build", "package", "manifest");
const checksum = crypto.createHash("md5").update(fs.readFileSync(appTgz)).digest("hex");
const lines = fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).map((line) => line.startsWith("checksum=") ? `checksum=${checksum}` : line);
fs.writeFileSync(manifestPath, lines.join("\n").replace(/\n*$/, "\n"));
' "${ROOT_DIR}"

echo "Generated: ${DIST_DIR}/app.tgz"
