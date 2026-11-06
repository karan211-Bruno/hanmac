# 한맥 문서 (HanMac Electron)

한글 문서를 열고, 쓰고, **HWPX로 저장**하는 macOS 데스크톱 워드프로세서입니다.
Electron · React · TipTap(ProseMirror) 기반이며, 기존 Swift/AppKit 버전의 `HanMac` 앱과 별도로 동작합니다.

<br />

## 주요 기능

| 영역 | 지원 내용 |
| --- | --- |
| 문서 열기 | **HWP 5.0+**(본문 텍스트), **HWPX**, HTML, TXT, Markdown |
| 편집 | 제목/본문, 글꼴·크기·색·형광펜, 굵게/기울임/밑줄/취소선, 정렬, 들여쓰기, 인용, 목록, 표, 링크, 페이지 나누기 |
| 저장 | **HWPX**(기본), HTML, TXT, Markdown, PDF 내보내기 |
| AI 도우미 | 요약·윤문·격식체·간결화·영한/한영 번역·이어쓰기·사용자 지시, 스트리밍, 선택 영역 교체/삽입 |
| 데스크톱 | 네이티브 메뉴, 최근 문서, 드래그 앤 드롭, 확대/축소, 미저장 변경 경고, macOS 파일 연결 |

> **HWP는 읽기 전용입니다.** 원본 `.hwp` 파일을 덮어쓰지 않습니다. HWP를 연 뒤 저장하면 항상 HWPX 저장 대화상자가 열립니다.

> Markdown은 현재 **일반 텍스트로** 엽니다. Markdown 문법을 서식으로 변환하지 않으며,
> 내보내기는 제목·목록·표 등 지원 블록을 Markdown으로 변환합니다.

<br />

## 요구 사항

- macOS 12 이상 (Apple Silicon / Intel)
- Node.js **20 이상** (개발 빌드 기준 Node 26에서 검증)
- npm 10 이상
- AI 기능을 쓰려면 [Ollama](https://ollama.com) 또는 OpenAI 호환 API

<br />

## 시작하기

```bash
cd "HanMac-Electron"
npm install
npm run dev
```

첫 실행 시 환영 화면에서 문서를 열거나 새 문서를 만들 수 있습니다.
왼쪽 위 **열기** 버튼, `⌘O`, 파일 드래그 앤 드롭을 모두 지원합니다.

### 빌드 및 패키징

```bash
npm run typecheck     # 메인/프리로드/렌더러 타입 검사
npm run build         # out/ 에 프로덕션 번들 생성
npm run test:formats  # HWP 파서 + HWPX 왕복 테스트
npm run pack          # release/ 에 .app 디렉터리 생성 (서명 없음)
npm run dist          # release/ 에 DMG/ZIP 생성 (서명 없음)
npm run release:mac   # Developer ID 서명 + 공증 (인증서/자격 증명 필요)
```

패키징 설정은 [`electron-builder.yml`](./electron-builder.yml)에 있습니다.
로컬 빌드는 `identity: null`로 코드 서명을 생략합니다.
배포용 서명·공증 절차는 [`docs/SIGNING.md`](./docs/SIGNING.md)와
[`scripts/release-mac.sh`](./scripts/release-mac.sh)를 참고하세요.

> **macOS 26+ arm64 참고:** electron-builder 26.x가 헬퍼 앱 이름을 제품명으로 바꾸면서
> Electron 메인 바이너리가 헬퍼를 찾지 못해 앱이 SIGTRAP(133)으로 종료되는 문제가 있습니다.
> [`scripts/afterPack.cjs`](./scripts/afterPack.cjs)가 패키징 직후 헬퍼 이름을
> `Electron Helper…`로 되돌려 이 문제를 회피합니다. `npm run pack`/`npm run dist` 시 자동 실행됩니다.
> 로컬 빌드는 서명이 없으므로 다른 Mac으로 복사하면 Gatekeeper가 차단할 수 있습니다.

<br />

## HWP 가져오기 — 지원 범위와 한계

`.hwp`는 한글 5.0의 **CFB(OLE) 복합 파일**을 직접 파싱합니다. 별도의 외부 바이너리나
한컴 소프트웨어를 사용하지 않으며, 공개된 파일 구조를 바탕으로 구현했습니다.

지원:

- CFB 컨테이너, FAT/MiniFAT/DIFAT, 미니 스트림
- `FileHeader` 버전·압축·암호 플래그
- `BodyText/SectionN` 레코드 스트림
- raw-deflate 및 zlib 압축 해제
- `PARA_TEXT`(0x43) 본문, 탭·줄바꿈·제어 문자 처리
- 본문이 없을 때 `PrvText` 미리보기로 대체

지원하지 않음:

- 글자/문단 서식, 표, 그림, 각주, 머리말/꼬리말, 수식, 차트, OLE 개체
- 암호가 설정된 HWP (한글에서 암호 해제 후 저장 필요)
- HWP 3.x/4.x 및 배포용 문서

HWP를 열면 상단에 텍스트 전용 안내가 표시되고, 상태 표시줄에 `텍스트만` 배지가 나타납니다.
원본은 절대 수정되지 않으며, 저장은 HWPX로 리다이렉트됩니다.

<br />

## HWPX 읽기/쓰기

HWPX는 OWPML(Open Word-Processing Markup Language) 패키지입니다.
이 앱은 ZIP 컨테이너와 XML을 직접 읽고 씁니다.

가져오기:

- `Contents/header.xml`의 글꼴, `charPr`, `paraPr`, `borderFill`
- 문단 정렬, 제목 수준, 들여쓰기, 페이지 나누기
- 굵게/기울임/밑줄/취소선/색/형광펜/글꼴/크기
- 표(행·열, 셀 병합, 셀 배경색, 셀 내부 문단)
- 여러 `Contents/sectionN.xml`

내보내기:

- `mimetype`을 첫 항목으로 하고 `STORE` 압축
- `version.xml`, `META-INF/container.xml`, `META-INF/manifest.xml`
- `Contents/content.hpf`, `Contents/header.xml`, `Contents/section0.xml`
- 사용된 글꼴/글자 모양/문단 모양/테두리 채우기를 동적으로 등록
- A4 용지, 표, 페이지 나누기(`pageBreak="1"`)

알려진 제약:

- 목록은 OWPML의 구조적 목록 대신 **`•`, `◦`, `▪`, `1.` 접두 텍스트**로 저장됩니다.
  다시 열면 목록 노드가 아닌 일반 문단으로 보입니다.
- 이미지·도형·각주·머리말/꼬리말·필드·메모는 내보내지 않습니다.
- HWPX 출력은 최소 구조를 사용합니다. **한컴오피스에서의 완전한 상호 운용성은 아직 검증되지 않았습니다.**
  왕복 테스트(`npm run test:formats`)는 이 앱의 리더/라이터 기준으로 통과하며,
  별도로 구현된 네이티브 Swift `HanMac` HWPX 리더에서도 본문·표 셀 텍스트·목록 접두가 정상 추출되는 것을 확인했습니다.
  다만 한컴오피스에서의 글꼴·표·페이지 나누기 표시는 추가 검증이 필요합니다.
- 중요한 문서에 사용하기 전에 한컴오피스에서 HWPX를 열어 표·페이지 나누기·글꼴이 의도대로 보이는지 확인하세요.

<br />

## AI 도우미 설정

AI 패널은 **Ollama**와 **OpenAI 호환 API**를 지원합니다.

### Ollama (로컬, 기본값)

```bash
ollama serve
ollama pull qwen2.5:7b
```

- 기본 주소: `http://localhost:11434`
- 기본 모델: `qwen2.5:7b`
- 모델 목록은 `GET /api/tags`, 대화는 `POST /api/chat` 스트리밍 사용

### OpenAI 호환 API

설정에서 공급자를 **OpenAI 호환**으로 바꾸고 입력합니다.

- Base URL 예: `https://api.openai.com/v1`
- 모델 예: `gpt-4o-mini`
- API 키는 메인 프로세스의 Electron `safeStorage`로 암호화해 저장하며,
  렌더러에는 `hasApiKey` 여부만 전달합니다.
- `Authorization: Bearer` 헤더를 사용합니다. Azure OpenAI의 `api-key` 헤더 방식은 현재 지원하지 않습니다.
- `/models`로 모델 목록을 조회하고 `/chat/completions`로 스트리밍합니다.

### 개인정보

- AI 요청은 사용자가 설정한 공급자에게만 전송됩니다.
- 선택 영역이 있으면 선택 텍스트를, 없으면 현재 문서 앞부분을 최대 약 14,000자까지 보냅니다.
- 앱 자체의 분석/텔레메트리는 없습니다.
- 민감한 문서는 로컬 Ollama 사용을 권장합니다.

<br />

## 단축키

| 단축키 | 동작 |
| --- | --- |
| `⌘N` | 새 문서 |
| `⌘O` | 열기 |
| `⌘S` | HWPX로 저장 |
| `⌘⇧S` | 다른 이름으로 저장 |
| `⌘Z` / `⌘⇧Z` | 실행 취소 / 다시 실행 |
| `⌘B` / `⌘I` / `⌘U` | 굵게 / 기울임 / 밑줄 |
| `⌘⇧X` | 취소선 |
| `⌘+` / `⌘-` / `⌘0` | 확대 / 축소 / 100% |
| `⌘⇧A` | AI 패널 열기/닫기 |

<br />

## 프로젝트 구조

```text
HanMac-Electron/
├── src/
│   ├── main/                 # Electron 메인 프로세스
│   │   ├── index.ts          # 창, 메뉴, IPC, 열기/저장, PDF
│   │   ├── ai.ts             # Ollama / OpenAI 호환 스트리밍
│   │   ├── store.ts          # 설정, 최근 문서, safeStorage
│   │   └── formats/
│   │       ├── hwp.ts        # HWP 5.0 CFB/레코드 파서
│   │       └── hwpx.ts       # HWPX 리더/라이터
│   ├── preload/              # contextBridge API
│   ├── shared/               # 공용 타입, 블록→HTML 변환
│   └── renderer/             # React + TipTap UI
│       └── src/
│           ├── App.tsx
│           ├── components/   # Titlebar, Toolbar, AIPanel, 모달
│           ├── editor/       # FontSize, PageBreak 확장
│           ├── lib/          # HTML↔블록, 문서 유틸, AI 유틸
│           └── styles.css
├── scripts/test-formats.ts   # 형식 회귀 테스트
├── scripts/afterPack.cjs     # macOS 26 헬퍼 이름 복원 (패키징 훅)
├── scripts/release-mac.sh    # 배포용 서명·공증 빌드
├── docs/SIGNING.md           # Developer ID 서명·공증 절차
├── resources/icon.png
├── build/icon.icns
├── build/entitlements.mac.plist
├── build/entitlements.mac.inherit.plist
└── electron-builder.yml
```

<br />

## 설계 메모

- **HWP는 원본 보존**: 열기 결과의 `kind`가 `hwp`이면 저장 시 항상 새 HWPX 경로를 묻습니다.
- **HWPX 저장 단위**: 렌더러가 TipTap HTML을 `HwpxBlock[]`로 변환하고, 메인 프로세스가
  OWPML 패키지를 생성합니다. 렌더러는 파일 시스템에 직접 접근하지 않습니다.
- **보안**: `contextIsolation: true`, `nodeIntegration: false`. 파일·AI·설정 IPC만 노출합니다.
- **AI 키**: `safeStorage` 암호화 후 `settings.json`에 저장. 복호화는 메인 프로세스에서만 수행합니다.
- **줌**: `hanmac.zoom.v2`에 저장하며 기본값은 100%입니다.
- **네이티브 버전과 공존**: 이 프로젝트는 `HanMac` Swift 앱을 수정하지 않습니다.

<br />

## 라이선스

MIT. 한글(HWP/HWPX)은 한컴오피스의 상표입니다. 이 프로젝트는 한컴오피스와 제휴하거나
한컴의 코드를 사용하지 않으며, 공개된 문서 형식 정보를 바탕으로 독립 구현되었습니다.
