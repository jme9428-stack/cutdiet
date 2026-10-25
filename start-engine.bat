@echo off
chcp 65001 >nul
rem 컷다이어트 Pro 엔진 실행 (Windows). 더블클릭하면: Node 확인 → 의존성 설치(처음 한 번) → 빌드(처음 한 번) → 엔진 시작 → 브라우저 열기
cd /d "%~dp0"
echo === 컷다이어트 Pro 엔진 ===
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 없습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  start https://nodejs.org/
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo Node.js 20 이상이 필요합니다. https://nodejs.org 에서 LTS로 업데이트하세요.
  pause
  exit /b 1
)
if not exist node_modules (
  echo [1/3] 앱 의존성 설치 중 (처음 한 번, 1~3분)...
  call npm install --no-audit --no-fund --ignore-scripts || (echo npm install 실패 & pause & exit /b 1)
)
if not exist engine\node_modules\ffmpeg-static\ffmpeg.exe (
  echo [2/3] 엔진 의존성(FFmpeg) 설치 중 (처음 한 번, 약 80MB)...
  pushd engine
  call npm install --no-audit --no-fund || (echo 엔진 설치 실패 & popd & pause & exit /b 1)
  popd
)
echo [3/3] 화면 빌드 중 (10~20초)...
call npm run build || (echo 빌드 실패 & pause & exit /b 1)
echo 엔진을 시작합니다. 이 창을 닫으면 엔진이 꺼집니다. (끄기: Ctrl+C)
node engine\server.mjs
pause
