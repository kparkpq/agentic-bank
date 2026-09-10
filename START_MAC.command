#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null || ! command -v pnpm >/dev/null; then
  echo 'Node.js 24와 pnpm 설치가 필요합니다. START_HERE_KO.md를 확인하세요.'
  read -r -p 'Enter를 눌러 종료합니다.'
  exit 1
fi
pnpm install --frozen-lockfile
pnpm start
