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
npm test                       # 로직 단위 테스트
npm run build                  # dist/ 생성
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
src/pro.js          Pro 레이어 (큐·기본값·단축키·기록) + pro.css
src/prologic.js     Pro 순수 로직 (키맵·기록 통계·CSV)
scripts/make-pro.mjs index.html → pro.html 생성
tests/              단위 테스트 (npm test)
```

## 브라우저 지원
- 모든 기능: 최신 Chrome·Edge(데스크톱). Chrome 113+ 이면 WebGPU 가속(실험) 선택 가능.
- Safari·Firefox: 분석·EDL/FCPXML 내보내기는 가능, MP4 렌더링은 지원 여부가 다름.

## 라이선스 메모
- [mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0), [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0), Whisper 모델 (MIT).
