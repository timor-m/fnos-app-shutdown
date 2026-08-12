#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="${ROOT_DIR}/.fnos-build/package"
DIST_DIR="${ROOT_DIR}/dist"

FNPACK_BIN="${ROOT_DIR}/tools/fnpack"

if [ ! -x "${FNPACK_BIN}" ]; then
  if command -v fnpack >/dev/null 2>&1; then
    FNPACK_BIN="$(command -v fnpack)"
  else
    echo "fnpack is not installed."
    echo "You can place a local binary at tools/fnpack, then rerun: npm run pack:fpk"
    exit 1
  fi
fi

mkdir -p "${DIST_DIR}"
(
  cd "${ROOT_DIR}"
  "${FNPACK_BIN}" build --directory "${PACKAGE_DIR}"
)

# 文件名带版本号：fnos-app-shutdown-0.3.2.fpk（版本源 package.json，与 manifest/SCRIPT_VERSION 一致）
VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
shopt -s nullglob
for f in "${ROOT_DIR}"/*.fpk; do
  base="$(basename "${f}" .fpk)"
  mv "${f}" "${DIST_DIR}/${base}-${VERSION}.fpk"
done

echo "Generated fpk files in ${DIST_DIR}"
