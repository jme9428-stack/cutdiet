#!/bin/bash
# 컷다이어트 Pro 엔진 실행 (macOS/Linux). 더블클릭하면: Node 확인 → 의존성 설치(처음 한 번) → 빌드(처음 한 번) → 엔진 시작 → 브라우저 열기
cd "$(dirname "$0")"
echo "=== 컷다이어트 Pro 엔진 ==="
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 없습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요."
  open "https://nodejs.org/" 2>/dev/null || xdg-open "https://nodejs.org/" 2>/dev/null
  read -r -p "엔터를 누르면 닫힙니다"; exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then echo "Node.js 20 이상이 필요합니다 (현재 $(node -v)). https://nodejs.org 에서 LTS로 업데이트하세요."; read -r -p "엔터를 누르면 닫힙니다"; exit 1; fi
if [ ! -d node_modules ]; then echo "[1/3] 앱 의존성 설치 중 (처음 한 번, 1~3분)…"; npm install --no-audit --no-fund --ignore-scripts || { echo "npm install 실패"; read -r -p "엔터"; exit 1; }; fi
if [ ! -f engine/node_modules/ffmpeg-static/ffmpeg ]; then echo "[2/3] 엔진 의존성(FFmpeg) 설치 중 (처음 한 번, 약 80MB)…"; (cd engine && npm install --no-audit --no-fund) || { echo "엔진 설치 실패"; read -r -p "엔터"; exit 1; }; fi
if [ ! -f dist/pro.html ] || [ -n "$(find src index.html -newer dist/pro.html 2>/dev/null | head -1)" ]; then echo "[3/3] 화면 빌드 중…"; npm run build || { echo "빌드 실패"; read -r -p "엔터"; exit 1; }; fi
echo "엔진을 시작합니다. 이 창을 닫으면 엔진이 꺼집니다. (끄기: Ctrl+C)"
node engine/server.mjs
read -r -p "엔진이 종료됐습니다. 엔터를 누르면 닫힙니다"
