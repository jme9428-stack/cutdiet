# 컷다이어트 (CutDiet)

유튜브 영상의 무음·NG 구간을 자동으로 찾아 컷편집 초안을 만들고, 캡컷 단축키로 다듬어 MP4·숏츠·EDL/FCPXML·자막(SRT)·챕터·썸네일로 내보내는 **브라우저 편집 도구**입니다.

- 영상은 어디에도 업로드되지 않습니다. 분석·렌더링·음성 인식 모두 사용자의 브라우저 안에서 처리됩니다.
- 서버가 없습니다. API 키도 없습니다. → **운영 비용 0원** (Vercel 무료 플랜 + 사용자 PC 연산)

## 화면 구성 (캡컷과 같은 배치)

위: 파일 이름 · 불러오기/저장 · **내보내기**. 왼쪽 아이콘 줄: 컷 · 자막 · NG 정리 · 텍스트 · 오디오 · 효과 · 숏츠 · 내보내기 (가이드는 ?). 가운데: 미리보기와 재생 버튼. 오른쪽: 고른 클립의 속성(자막·텍스트·이미지·효과음·음악 — 글자, 글꼴, 크기, 시작/끝, 나누기, 삭제), 고른 게 없으면 프로젝트 요약. 아래: 트랙 타임라인. 넓지 않은 화면에서는 미리보기 → 타임라인 → 기능 순으로 쌓입니다.

- **나누기(S · Ctrl+B · ✂)**: 클립을 골라 두면 그 클립만, 아니면 재생 위치의 영상·자막·텍스트를 함께 둘로 나눕니다. 자막은 말이 끊기는 자연스러운 곳에서 나뉩니다.
- **자막 줄 나누기**: 자동 자막은 문장 끝·쉼·연결어미(-고·-서·-는데…)에서 끊고, "이런 | 스틱"처럼 꾸미는 말과 명사 사이는 끊지 않습니다. 고친 자막도 **문장 단위로 다시 나누기**로 다시 정리됩니다(한 줄 글자 수: 짧게·보통·길게).

## 기능

| 탭 | 하는 일 |
|---|---|
| 구간 목록 | 소리 크기로 무음 구간을 찾아 1차 컷. 프리셋(강의형/토크·인터뷰/브이로그), 세부 설정 |
| 타임라인 | 캡컷식 트랙: 자막 · 텍스트·이미지 레이어(겹치면 위로 쌓임) · NG 후보 · 영상 · 효과음 · 음악. 클립을 끌어 옮기고 양끝으로 길이 조절, 레이어 사이 이동, 선택 후 Delete, 트랙마다 숨기기·잠금·소리 끄기(내보내기에도 반영), 음악 시작 위치 이동. 영상이 화면 밖으로 나가면 오른쪽 아래 작은 화면으로 따라옴. 삭제 구간 건너뛰기 재생, 캡컷 단축키(Space, J/K/L, Ctrl+B, Q/W, Delete, Ctrl+Z), I/O 범위 찍고 Delete로 범위 삭제, 재생 속도 0.5~2배·음량·전체 화면(F) |
| 챕터 | 편집 후 시간으로 환산된 유튜브 챕터 텍스트 |
| 배경음악 | 음악 파일 믹싱(음량·덕킹·페이드·반복), 미리듣기 동기화 |
| 꾸미기 | 자막 굽기(한글 글꼴 35종·내 글꼴 파일, 색·외곽선·박스·위치·등장 효과), 자동 줌(점프컷 숨기기)·구간 줌, 페이드·디졸브, 색 보정(밝기·대비·채도), 효과음 5종(합성)+내 파일, 이미지·텍스트 오버레이. 미리보기에서 자막·텍스트·이미지를 끌어 옮기고 모서리로 크기 조절, 더블클릭으로 글자 수정. 미리보기 = 렌더 결과 |
| 숏츠 9:16 | 구간 선택 + 드래그 크롭 → 1080×1920 MP4 |
| 썸네일 프레임 | 목소리가 힘 있는 순간 12장 추출 → JPG/zip |
| AI 자막·NG | 자동 자막은 말소리만 쉼에서 나눠 겹침 없이 인식하고, 그 창들을 CPU 작업자 여러 개(이 PC는 3개)가 동시에 처리합니다(같은 200초 영상 204초→96초). 빠른 그래픽카드(NVIDIA·AMD·Apple·Intel Arc)는 GPU(fp16)로, 내장 Intel 그래픽은 CPU가 더 빨라 CPU로. 자막 없이도 영상을 열면 소리만으로 추임새(길게 끈 어·음)·말 버벅임(같은 소리로 다시 시작)·다시 말한 NG·짧게 끊긴 소리를 후보로 찾음(src/audiologic.js, 워커에서 10분 영상 약 2초). 자막을 만들면 단어 기준 후보로 더 정확하게 바뀜. 후보마다 듣기·시작/끝 수정·빼기 가능. Whisper를 브라우저에서 실행 → SRT(편집 후/원본 시간). 줄 단위 자막 편집(글자·시간·나누기·합치기·삭제·추가), SRT 불러오기, 찾아 바꾸기. 삭제 후보는 종류별로 켜고 끔: 추임새, 말 버벅임("그 그러니까"·말 꼬임), 다시 말한 NG, 웅얼거림(인식 안 된 소리). 삭제한 말은 자막 글자에서도 지움 |
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
- **자막 굽기 글꼴**: 처음 실행 때 기본 6종(노토 산스 KR, 검은고딕, 주아, 도현, 고딕 A1, IBM Plex Sans KR)을, 그 밖의 글꼴은 렌더에서 처음 쓸 때 `engine/fonts/`에 내려받습니다(WOFF는 libass가 읽도록 TTF/OTF로 풀어서 저장). LINE Seed·페이퍼로지와 사용자가 올린 글꼴 파일은 엔진 렌더에서 시스템 글꼴로 대체됩니다.
- **ffmpeg 버전**: 6.x(ffmpeg-static)와 7 이상(시스템 ffmpeg) 모두 지원합니다. 필터 스크립트 옵션을 버전에 맞춰 고릅니다.
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

## 배포 (Cloudflare Pages, 무료 · 상업 이용 가능)

Vercel 무료 플랜이 모자라거나 유료로 판매할 때 옮기는 곳입니다. 코드는 그대로 쓰며, Vercel과 동시에 둘 다 켜 둬도 됩니다.

1. [dash.cloudflare.com](https://dash.cloudflare.com) 로그인 → **Workers & Pages** → **Create** → **Pages** 탭(화면에 "Pages로 배포" 링크가 따로 있으면 그것) → **Connect to Git** → GitHub의 `cutdiet` 저장소 선택.
2. 빌드 설정: Framework preset **None**(또는 Vite), Build command `npm run build`, Build output directory `dist`. 환경변수는 없습니다(Node 버전은 `.node-version`의 22를 씁니다).
3. **Save and Deploy**. 이후 main에 push할 때마다 자동으로 다시 배포됩니다. 주소는 `https://<프로젝트명>.pages.dev`.
4. `https://<프로젝트명>.pages.dev/pro.html`은 Cloudflare가 `/pro`로 바꿔 보여 줍니다(같은 화면).

- COOP/COEP 헤더는 `public/_headers`가 맡습니다(빌드 때 `dist/_headers`로 복사). 지우지 마세요.
- Cloudflare Pages는 파일 하나가 25 MiB를 넘으면 올라가지 않습니다. 빌드가 끝날 때 `vite.config.js`가 검사해서, 넘는 파일이 있으면 빌드를 실패시킵니다.

### 비용에 대해
- **영상·음성 인식 모델·글꼴·음성 인식 실행 파일은 이 사이트에서 내려가지 않습니다.** 영상은 사용자 PC 안에서만 처리되고, 모델(60~190MB)은 Hugging Face, 글꼴은 Google Fonts·jsDelivr, 음성 인식 실행 파일(ONNX 런타임 WASM 약 6MB)은 jsDelivr에서 사용자 브라우저가 직접 받습니다. 빌드 결과물에는 이 실행 파일이 아예 들어가지 않습니다(`vite.config.js`, `src/asr.worker.js`).
- 그래서 사이트가 보내는 것은 첫 방문에 약 0.25MB(다시 방문하면 브라우저 캐시로 거의 0), 설명서 PDF 약 2.8MB 정도입니다.
- Vercel Hobby(무료): 월 전송량 100GB · 요청 100만 건. 넘으면 30일 동안 멈춥니다. 사용량은 대시보드의 **Usage**에서 확인합니다.
- Hobby 플랜은 **비상업적 용도** 조건입니다. 유료 판매로 전환하면 Vercel Pro(월 $20, 사용 크레딧 $20 포함) 또는 위의 Cloudflare Pages(무료, 상업 허용)로 옮기세요.

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
src/asr.worker.js   Whisper 실행 워커 (@huggingface/transformers) · 창 하나씩 받아 인식, 여러 개가 동시에 돎
src/asrplan.js      말소리만 골라 27초 이하 창으로 나누기(쉼에서 자름, 겹침 없음) · 단어 시간 되돌리기 · 경계 중복 제거 · GPU 사용 판단
src/audiologic.js   소리만으로 추임새·버벅임·다시 말한 NG 찾기 (MFCC·DTW, 순수 함수) + src/audioscan.worker.js
src/inspector.js    오른쪽 속성 창 (고른 클립 편집)
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
scripts/shots.mjs   회원 설명서용 실제 화면 캡처 (헤드리스 크롬)
scripts/manual-pdf.mjs docs/manual/manual.html → public/manual.pdf (사이트의 /manual.pdf)
docs/manual/        회원용 사용 설명서 원고(HTML)와 화면 캡처
start-engine.command / .bat  엔진 원클릭 실행
tests/              단위·E2E 테스트
```

회원용 PDF 설명서는 `https://cutdiet.vercel.app/manual.pdf` 로 배포되고, 가이드 탭에서도 열립니다. 내용을 고치려면 `docs/manual/manual.html`을 수정한 뒤 `node scripts/shots.mjs docs/manual/shots && node scripts/manual-pdf.mjs` 를 실행하고 푸시하세요.

## 브라우저 지원
- 모든 기능: 최신 Chrome·Edge(데스크톱). Chrome 113+ 이면 WebGPU 가속(실험) 선택 가능.
- Safari·Firefox: 분석·EDL/FCPXML 내보내기는 가능, MP4 렌더링은 지원 여부가 다름.

## 라이선스 메모
- [mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0), [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0), Whisper 모델 (MIT).
