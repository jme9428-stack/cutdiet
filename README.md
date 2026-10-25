# 컷다이어트 (CutDiet)

유튜브 영상의 무음·NG 구간을 자동으로 찾아 컷편집 초안을 만들고, 캡컷 단축키로 다듬어 MP4·숏츠·EDL/FCPXML·자막(SRT)·챕터·썸네일로 내보내는 **브라우저 편집 도구**입니다.

- 영상은 어디에도 업로드되지 않습니다. 분석·렌더링·음성 인식 모두 사용자의 브라우저 안에서 처리됩니다.
- 서버가 없습니다. API 키도 없습니다. → **운영 비용 0원** (Vercel 무료 플랜 + 사용자 PC 연산)

## 기능

| 탭 | 하는 일 |
|---|---|
| 구간 목록 | 소리 크기로 무음 구간을 찾아 1차 컷. 프리셋(강의형/토크·인터뷰/브이로그), 세부 설정 |
| 타임라인 | 삭제 구간 건너뛰기 재생, 캡컷 단축키(J/K/L, Ctrl+B, Q/W, Delete, Ctrl+Z) |
| 챕터 | 편집 후 시간으로 환산된 유튜브 챕터 텍스트 |
| 배경음악 | 음악 파일 믹싱(음량·덕킹·페이드·반복), 미리듣기 동기화 |
| 꾸미기 | 자막 굽기(글꼴·색·외곽선·박스·위치), 자동 줌(점프컷 숨기기)·구간 줌, 페이드·디졸브, 효과음 5종(합성)+내 파일, 이미지·텍스트 오버레이. 미리보기 = 렌더 결과 |
| 숏츠 9:16 | 구간 선택 + 드래그 크롭 → 1080×1920 MP4 |
| 썸네일 프레임 | 목소리가 힘 있는 순간 12장 추출 → JPG/zip |
| AI 자막·NG | Whisper를 브라우저에서 실행 → SRT(편집 후/원본 시간), 추임새·반복(NG) 삭제 후보 |
| 내보내기 | MP4(캡컷·업로드용), EDL(프리미어·다빈치), FCPXML(파이널컷), FFmpeg 스크립트, 프로젝트(.json) |

## 두 개의 화면

| 주소 | 대상 | 특징 |
|---|---|---|
| `/` | 회원 | 3단계 안내, 설명 포함, 프리셋 3종 |
| `/pro.html` | 운영자(나만 사용) | 밀도 높은 화면, 큐 자동 처리(여러 영상 → 분석→MP4→숏츠→썸네일→프로젝트 저장), 채널 기본값 고정, 숫자키 탭 전환·단축키 변경, 편집 기록·통계(CSV) |

`pro.html`은 빌드 때 `scripts/make-pro.mjs`가 `index.html`에서 자동 생성합니다. 화면을 고칠 때는 `index.html`만 고치세요.

## Pro 엔진 (내 컴퓨터에 설치해서 쓰는 운영자용)

브라우저만으로는 넘기 힘든 벽(1시간이 넘는 영상, 느린 렌더, 저장 창, 음성 인식 속도)을 **내 컴퓨터의 작은 로컬 서버**가 대신 넘습니다. 설치해야 하는 프로그램은 **Node.js 하나**뿐이고 FFmpeg는 자동으로 받아집니다. 서버라고 해도 내 컴퓨터 안(127.0.0.1)에서만 돌고, 어디에도 연결되지 않으며, 비용이 없습니다.

| 엔진이 추가하는 것 | 설명 |
|---|---|
| FFmpeg 렌더 | 하드웨어 인코더(맥 VideoToolbox, 윈도우 NVENC/QuickSync/AMF) 자동 감지. 길이 제한 없음. 컷·크롭·자막 굽기·줌·페이드·효과음·배경음악(덕킹)까지 브라우저와 같은 결과물. 결과는 **출력 폴더에 바로 저장**(저장 창 없음) |
| 워치 폴더 | 지정한 폴더에 영상을 넣기만 하면 채널 기본값으로 분석→렌더→프로젝트 저장이 자동으로 돌아갑니다 (촬영 후 복사 → 끝) |
| 탐색기 파일 선택 | 파일을 브라우저로 끌어오지 않고 경로로 엽니다. 큰 파일도 메모리를 쓰지 않습니다. 최근 파일 목록 |
| 음성 인식 | 같은 Whisper를 CPU 전체 코어로 실행(브라우저 WASM보다 빠름). medium·large-v3-turbo 모델 선택 가능 |
| 썸네일·프로젝트·SRT | 전부 출력 폴더로. 큐 자동 처리와 결합하면 "폴더에 넣고 자고 일어나기"가 됩니다 |

### 설치 (처음 한 번, 10분)

1. **Node.js LTS** 설치: <https://nodejs.org> (20 이상).
2. 이 저장소 받기: GitHub에서 **Code → Download ZIP** 후 압축 해제(또는 `git clone`). 폴더 이름에 한글이 있어도 됩니다.
3. 실행:
   - **맥**: `start-engine.command` 더블클릭. "확인되지 않은 개발자" 경고가 뜨면 파일을 **우클릭 → 열기**. 실행 권한 오류가 나면 터미널에서 `chmod +x start-engine.command` 한 번.
   - **윈도우**: `start-engine.bat` 더블클릭. SmartScreen 경고가 뜨면 **추가 정보 → 실행**.
   - 처음에는 의존성 설치(1~3분)와 FFmpeg 내려받기(약 80MB)가 진행되고, 끝나면 브라우저에 `http://127.0.0.1:7797/pro.html` 이 열립니다.
4. 이후에는 같은 파일을 더블클릭하면 바로 켜집니다. **터미널 창을 닫으면 엔진이 꺼집니다.**

### 사용

- Pro 화면 상단 **로컬 엔진** 카드가 "연결됨"이면 준비된 것입니다. **영상 열기 (탐색기)** 로 파일을 고르면 ffmpeg가 분석하고, 이후 **MP4 만들기 / 숏츠 / 썸네일 / 프로젝트 저장**이 모두 엔진을 통해 출력 폴더로 저장됩니다.
- **출력 폴더**: 기본값은 `동영상(Movies)/컷다이어트`. 카드에서 바꿀 수 있습니다.
- **워치 폴더**: 폴더를 고르고 스위치를 켜면 2.5초마다 새 파일을 확인합니다. 복사가 끝난(크기 변화 없는) 파일만 처리하고, `_cut`·`_shorts`가 붙은 파일은 건너뜁니다. 자동 처리 결과를 손보려면 출력 폴더의 `.cutdiet.json`을 **프로젝트 불러오기**로 열고 원본을 **영상 열기**로 다시 열면 됩니다.
- **인코더**: 자동이 가장 빠른 하드웨어 인코더를 고릅니다. 화질 문제가 보이면 `x264`로 바꾸세요(느리지만 가장 안정적).
- **자막 굽기 글꼴**: 처음 실행 때 Google Fonts(노토 산스 KR, 검은고딕, 주아, 도현, 고딕 A1, IBM Plex Sans KR)를 `engine/fonts/`에 내려받습니다. 실패하면 시스템 글꼴로 대체됩니다.
- 엔진 설정·기록은 `engine/data/`에 저장되고, 음성 인식 모델은 `engine/data/models/`에 캐시됩니다.

### 엔진 없이 Pro만 쓸 때
`https://cutdiet.vercel.app/pro.html`에서도 큐·기본값·단축키·기록은 그대로 됩니다. **출력 폴더 지정**(크롬·엣지)을 하면 저장 창 없이 그 폴더에 쌓입니다. 엔진 카드에는 설치 안내만 표시됩니다.

### 안전
- 엔진은 `127.0.0.1`에만 바인딩되고, 같은 주소에서 연 페이지의 요청만 받습니다(다른 사이트가 보내는 요청은 차단). 영상은 토큰이 붙은 주소로만 스트리밍됩니다.
- 디졸브 전환은 엔진 렌더에서 지원하지 않습니다(브라우저 렌더 전용). 이미지 오버레이의 페이드도 엔진에서는 생략됩니다.

## 배포 (Vercel, 무료)

1. 이 저장소를 GitHub에 올립니다.
2. [vercel.com](https://vercel.com) → **Add New… → Project** → 이 저장소 Import.
3. Framework Preset이 **Vite**로 자동 인식됩니다. 환경변수는 **없습니다**. **Deploy**.
4. 끝. `https://<프로젝트명>.vercel.app` 링크를 회원에게 공유하면 됩니다.

`vercel.json`의 COOP/COEP 헤더는 음성 인식(WASM 멀티스레드)을 빠르게 하기 위한 것입니다. 지우지 마세요.

### 비용에 대해
- Vercel Hobby(무료): 월 100GB 전송량. 이 사이트는 첫 방문에 약 1MB, AI 자막 첫 실행 때 런타임 약 7MB(압축)를 받습니다. 음성 인식 모델(60~190MB)은 Hugging Face에서 사용자 브라우저로 직접 받으며 Vercel 전송량을 쓰지 않습니다.
- Hobby 플랜은 **비상업적 용도** 조건입니다. 유료 판매로 전환하면 Vercel Pro(월 $20) 또는 Cloudflare Pages(무료, 상업 허용)로 옮기세요. 코드는 그대로입니다.

## 개발

```bash
npm install --ignore-scripts   # 브라우저 전용이라 네이티브 빌드 불필요
npm run dev                    # http://localhost:5173
npm test                       # 로직 단위 테스트 (+ ffmpeg가 있으면 엔진 렌더 테스트)
npm run build                  # dist/ 생성
npm run engine:install         # engine/ 의존성 (ffmpeg-static)
npm run engine                 # 로컬 엔진 실행 → http://127.0.0.1:7797/pro.html
npm run test:engine            # 엔진 그래프·HTTP API 테스트
node tests/e2e_browser.mjs     # 헤드리스 크롬 E2E (Playwright 필요)
```

## 구조

```
index.html          화면과 스타일
src/main.js         편집기 본체 (무음 감지·타임라인·렌더링·내보내기)
src/transcribe.js   AI 자막·NG 탭 (오디오 추출 → 워커 호출 → SRT·후보)
src/asr.worker.js   Whisper 실행 워커 (@huggingface/transformers)
src/textlogic.js    자막 줄 나누기·SRT·추임새/반복 감지 (순수 함수)
src/decorate.js     꾸미기 탭 UI + 컴포지터(미리보기·렌더 공용)
src/fxlogic.js      줌·페이드·디졸브·오버레이·효과음 합성 (순수 함수)
src/cutlogic.js     무음 감지·구간 연산·EDL/FCPXML/FFmpeg 생성 (순수 함수, 브라우저·엔진·테스트 공용)
src/pro.js          Pro 레이어 (큐·기본값·출력 폴더·단축키·기록) + pro.css
src/prologic.js     Pro 순수 로직 (키맵·기록 통계·CSV)
src/engine.js       Pro ↔ 로컬 엔진 클라이언트 (훅 설치, 엔진 카드 UI)
engine/server.mjs   로컬 엔진 HTTP 서버 (정적 파일 + /api)
engine/lib/         ff(바이너리·프로브·인코더 감지) · analyze(엔벨로프) · graph(필터 그래프) · ass(자막) · asr(Whisper) · util(다이얼로그·설정) · fonts
scripts/make-pro.mjs index.html → pro.html 생성
start-engine.command / .bat  엔진 원클릭 실행
tests/              단위·E2E 테스트
```

## 브라우저 지원
- 모든 기능: 최신 Chrome·Edge(데스크톱). Chrome 113+ 이면 WebGPU 가속(실험) 선택 가능.
- Safari·Firefox: 분석·EDL/FCPXML 내보내기는 가능, MP4 렌더링은 지원 여부가 다름.

## 라이선스 메모
- [mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0), [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0), Whisper 모델 (MIT).
