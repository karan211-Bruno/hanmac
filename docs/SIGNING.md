# macOS 배포: Developer ID 서명과 공증

이 문서는 `한맥 문서`를 **Mac App Store를 거치지 않고** DMG/ZIP으로 배포할 때 필요한
Apple Developer ID 서명과 공증(notarization) 절차를 설명합니다.

현재 `electron-builder.yml`은 로컬 개발용으로 `mac.identity: null`(서명 생략)입니다.
배포용 빌드는 [`scripts/release-mac.sh`](../scripts/release-mac.sh)가 서명·공증 옵션을
명령줄에서 덮어쓰므로, 로컬 빌드 설정을 바꾸지 않아도 됩니다.

> 요약: **Apple Developer Program(연 $99) → Developer ID Application 인증서 → 공증 자격 증명 →
> `./scripts/release-mac.sh` → `spctl`/`stapler` 검증**

<br />

## 0. 현재 이 Mac의 상태

```bash
security find-identity -v -p codesigning
xcrun notarytool --version
```

- 인증서가 `0 valid identities found`로 나오면 아직 Developer ID 인증서가 없는 상태입니다.
- `notarytool`은 Xcode 13+ 또는 최신 Command Line Tools에 포함됩니다.
  이 프로젝트는 Command Line Tools만으로도 네이티브 앱을 빌드하지만,
  인증서 생성은 **Keychain Access + developer.apple.com**으로 Xcode 없이 진행할 수 있습니다.

<br />

## 1. Apple Developer Program 가입

1. <https://developer.apple.com/programs/>에서 **Apple Developer Program**에 가입합니다.
   - 개인은 연 99 USD입니다.
   - 회사/법인은 D-U-N-S 번호가 필요할 수 있습니다.
2. 가입 승인 후 <https://developer.apple.com/account>의 **Membership details**에서
   **Team ID**(예: `ABCDE12345`)를 확인합니다.

> Developer ID는 Mac App Store 배포용이 아닙니다. 이 앱처럼 웹사이트/DMG로 직접 배포할 때 사용합니다.

<br />

## 2. Developer ID Application 인증서 만들기

### 방법 A — Xcode 사용 (Xcode가 설치된 경우)

1. Xcode → **Settings** → **Accounts** → Apple ID 추가
2. **Manage Certificates…** → `+` → **Developer ID Application**
3. 인증서가 로그인 키체인에 자동 설치됩니다.

### 방법 B — Xcode 없이 (Keychain Access 사용)

1. **Keychain Access** 실행 → 메뉴 **Keychain Access → Certificate Assistant →
   Request a Certificate From a Certificate Authority…**
2. 이메일과 이름을 입력하고 **Saved to disk** 선택 → CSR 파일 저장
   - 키 쌍 정보를 지정하는 옵션이 있으면 **2048-bit RSA**를 사용합니다.
3. <https://developer.apple.com/account/resources/certificates/list> 접속
4. `+` → **Developer ID Application** 선택 → CSR 업로드 → 인증서 생성
5. `.cer` 파일을 다운로드하고 더블클릭해 **login 키체인**에 설치
   - CSR을 만든 Mac의 private key와 함께 설치되어야 합니다.

> **Developer ID Installer**가 아니라 반드시 **Developer ID Application**입니다.
> Installer는 `.pkg` 설치 관리자 서명용입니다.

### 인증서 확인

```bash
security find-identity -v -p codesigning
```

다음처럼 보여야 합니다.

```text
1) XXXXXXXX... "Developer ID Application: 홍길동 (ABCDE12345)"
   1 valid identities found
```

인증서 이름 전체(따옴표 안)를 `CSC_NAME`으로 사용할 수 있습니다.

### 인증서 백업

Keychain Access에서 인증서와 private key를 선택 → **Export Items…** → `.p12`로 저장합니다.
CI에서 사용하려면 이 `.p12`를 base64로 인코딩해 `CSC_LINK` 시크릿으로 넣습니다.
`.p12`와 비밀번호는 절대 저장소에 커밋하지 마세요.

<br />

## 3. 공증 자격 증명 준비

공증은 Apple 서버에 앱을 제출하는 과정입니다. 다음 세 가지 방법 중 하나를 사용합니다.

### 방법 A — Apple ID + 앱 전용 암호 (로컬에서 가장 간단)

1. <https://appleid.apple.com> → **Sign-In and Security** → **App-Specific Passwords**
2. 새 암호를 만들고 `xxxx-xxxx-xxxx-xxxx` 형식의 값을 저장합니다.
   - **Apple ID 로그인 암호가 아닙니다.**
3. 키체인에 공증 프로필을 저장합니다.

```bash
xcrun notarytool store-credentials "hanmac-notary" \
  --apple-id "you@example.com" \
  --team-id "ABCDE12345" \
  --password "xxxx-xxxx-xxxx-xxxx"
```

이후 빌드할 때:

```bash
export APPLE_KEYCHAIN_PROFILE="hanmac-notary"
# scripts/release-mac.sh가 필요하면 APPLE_KEYCHAIN을 자동으로 지정합니다.
./scripts/release-mac.sh
```

### 방법 B — 환경 변수로 직접 전달

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
./scripts/release-mac.sh
```

### 방법 C — App Store Connect API 키 (CI 권장)

1. App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API**
2. **Team Keys**에서 키 생성 (역할: Developer 이상)
3. `.p8` 파일은 **한 번만** 다운로드할 수 있으므로 안전하게 보관합니다.
4. Key ID와 Issuer ID를 기록합니다.

```bash
# electron-builder 26은 APPLE_API_KEY에 base64로 인코딩한 .p8 내용을 넣는 방식을 사용합니다.
export APPLE_API_KEY="$(base64 -i AuthKey_XXXXXXXXXX.p8 | tr -d '\n')"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
./scripts/release-mac.sh
```

> API 키는 만료되지 않고 2단계 인증이 필요 없어 CI에 적합합니다.
> 로컬 키체인 프로필(`APPLE_KEYCHAIN_PROFILE`)은 CI로 복사되지 않으므로 CI에서는 API 키를 사용하세요.

<br />

## 4. 이 프로젝트의 서명·공증 설정

`scripts/release-mac.sh`는 기존 `electron-builder.yml`의 `identity: null`을 유지한 채,
빌드 명령에서 다음 값을 덮어씁니다.

| 옵션 | 값 | 이유 |
| --- | --- | --- |
| `mac.identity` | Developer ID Application 인증서 | 실제 서명 |
| `mac.hardenedRuntime` | `true` | 공증 필수 조건 |
| `mac.gatekeeperAssess` | `false` | 서명 직후(공증 전) `spctl` 검사가 실패하는 것을 방지 |
| `mac.notarize` | `true` | electron-builder 26의 공증 단계 활성화 |
| `mac.entitlements` | `build/entitlements.mac.plist` | V8 JIT 허용 |
| `mac.entitlementsInherit` | `build/entitlements.mac.inherit.plist` | 렌더러/GPU/유틸리티 헬퍼에 동일 적용 |

`build/entitlements.mac.plist`에는 Electron에 필요한 최소 권한만 넣었습니다.

- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`

> electron-builder **27 이상**에서는 `hardenedRuntime`, `entitlements`, `entitlementsInherit`가
> `mac.sign` 아래로 이동합니다. 이 프로젝트는 현재 `26.15.3` 기준이므로 위 경로를 사용합니다.
> 업그레이드할 때는 설정 위치를 함께 바꾸세요. `notarize`는 계속 `mac` 아래에 있습니다.

앱이 샌드박스가 아니므로 네트워크/파일 접근 엔타이틀먼트는 추가하지 않았습니다.
서드파티 네이티브 플러그인을 나중에 넣어 서명 오류가 나면 그때
`com.apple.security.cs.disable-library-validation` 등을 검토하세요. 기본적으로는 넣지 않는 것이 안전합니다.

### `afterPack`과 서명 순서

`scripts/afterPack.cjs`는 패키징 직후 `한맥 문서 Helper…` 앱/바이너리 이름을
`Electron Helper…`로 되돌리고 `CFBundleExecutable`을 맞춥니다.
electron-builder는 **afterPack 이후에** 코드 서명을 수행하므로, 이름이 바뀐 헬퍼까지
최종 서명에 포함됩니다. 이 순서 덕분에 macOS 26+의 SIGTRAP(133) 문제와 서명 검증을
동시에 만족합니다.

<br />

## 5. 배포 빌드 실행

```bash
cd "/Users/newborn/Documents/기본 프로젝트/HanMac-Electron"

# 인증서 이름을 직접 지정하려면 (생략 시 첫 Developer ID Application 인증서 사용)
export CSC_NAME="Developer ID Application: 홍길동 (ABCDE12345)"

# 공증 자격 증명은 3장에서 선택한 방법 중 하나를 설정
export APPLE_KEYCHAIN_PROFILE="hanmac-notary"

./scripts/release-mac.sh
```

스크립트가 하는 일:

1. `notarytool` 사용 가능 여부 확인
2. Developer ID Application 인증서 확인
3. 공증 자격 증명 확인
4. `npm run build`
5. `electron-builder --mac`에 서명·공증 옵션을 덮어씌워 DMG/ZIP 생성
6. 생성된 `.app`에 `codesign --verify`, `stapler validate`, `spctl --assess` 실행

결과물은 기존과 같은 `release/`에 생성됩니다.

```text
release/HanMac-Electron-0.1.0-arm64.dmg
release/HanMac-Electron-0.1.0-x64.dmg
release/한맥 문서-0.1.0-arm64-mac.zip
release/한맥 문서-0.1.0-mac.zip
```

<br />

## 6. 서명·공증 검증

### 앱 번들

```bash
APP="release/mac-arm64/한맥 문서.app"

codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dvvv "$APP" 2>&1 | grep -E "Authority|TeamIdentifier|Runtime"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP"
```

정상이라면 다음이 보입니다.

```text
Authority=Developer ID Application: 홍길동 (ABCDE12345)
TeamIdentifier=ABCDE12345
Runtime Version=...
source=Notarized Developer ID
```

- `codesign --verify`가 실패하면 중첩 프레임워크/헬퍼 서명을 확인합니다.
- `stapler validate`가 실패하면 공증 단계가 실행되지 않았거나 티켓이 붙지 않은 것입니다.
- `spctl`이 `rejected`이면 공증/스테이플링이 완료되지 않은 것입니다.

### DMG 자체의 공증 (선택이지만 권장)

electron-builder 26은 **DMG를 만들기 전에 `.app`을 공증하고 스테이플링**합니다.
따라서 DMG 안의 앱은 바로 실행할 수 있습니다. 다만 DMG 파일 자체를 검사하는 정책이
있는 배포 환경이라면 DMG도 별도로 공증할 수 있습니다.

```bash
xcrun notarytool submit "release/HanMac-Electron-0.1.0-arm64.dmg" \
  --keychain-profile "hanmac-notary" --wait
xcrun stapler staple "release/HanMac-Electron-0.1.0-arm64.dmg"
xcrun stapler validate "release/HanMac-Electron-0.1.0-arm64.dmg"
```

> 키체인 프로필을 쓰지 않고 `APPLE_ID` 방식을 썼다면 `--keychain-profile` 대신
> `--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"`를 사용합니다.

x64 DMG도 같은 방식으로 처리합니다.

### ZIP

ZIP 안의 `.app`은 이미 스테이플링되어 있습니다. ZIP을 풀어 앱을 실행한 뒤
`spctl`/`stapler validate`로 확인할 수 있습니다.

<br />

## 7. GitHub Actions 예시

CI에서는 `.p12` 인증서와 API 키를 시크릿으로 주입합니다.

```yaml
name: release-mac
on: workflow_dispatch

jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Build, sign, notarize
        env:
          CSC_LINK: ${{ secrets.MAC_CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CSC_KEY_PASSWORD }}
          CSC_NAME: ${{ secrets.MAC_CSC_NAME }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
        run: |
          npx electron-builder --mac \
            "-c.mac.identity=$CSC_NAME" \
            -c.mac.hardenedRuntime=true \
            -c.mac.gatekeeperAssess=false \
            -c.mac.notarize=true \
            -c.mac.entitlements=build/entitlements.mac.plist \
            -c.mac.entitlementsInherit=build/entitlements.mac.inherit.plist
```

필요한 시크릿:

| 시크릿 | 값 |
| --- | --- |
| `MAC_CSC_LINK` | `.p12`를 base64로 인코딩한 값 |
| `MAC_CSC_KEY_PASSWORD` | `.p12` 비밀번호 |
| `MAC_CSC_NAME` | `Developer ID Application: 이름 (TEAMID)` |
| `APPLE_API_KEY` | `.p8`를 base64로 인코딩한 값 |
| `APPLE_API_KEY_ID` | App Store Connect Key ID |
| `APPLE_API_ISSUER` | Issuer ID |

> CI에서 `CSC_LINK`를 쓰더라도 기본 설정의 `identity: null`을 반드시
> `-c.mac.identity="$CSC_NAME"`으로 덮어써야 합니다. 그렇지 않으면 서명이 생략됩니다.
> 인증서를 미리 임시 키체인에 import하는 방식이라면 `scripts/release-mac.sh`를 그대로 써도 됩니다.

<br />

## 8. 자주 나는 오류

| 증상 | 원인 / 해결 |
| --- | --- |
| `0 valid identities found` | 인증서 또는 private key가 없음. `.cer` 설치 + CSR을 만든 키체인 확인 |
| `errSecInternalComponent` | 키체인 잠김/접근 권한. Keychain Access에서 `codesign` 접근 허용, 또는 `security unlock-keychain` |
| `notarytool` 401 | Apple ID 암호를 넣은 경우. **앱 전용 암호** 사용, Team ID 확인 |
| `The specified item could not be found in the keychain` | `APPLE_KEYCHAIN` 경로 오류. `security list-keychains`로 확인 |
| `code object is not signed at all` | 중첩 헬퍼/프레임워크 서명 누락. `codesign --verify --deep --strict`로 위치 확인 |
| `The app is damaged and can't be opened` | 서명/공증/스테이플링 누락 또는 quarantine. `spctl`로 확인 후 재빌드 |
| Hardened Runtime에서 즉시 종료 | JIT 엔타이틀먼트 누락. `build/entitlements.mac.plist` 확인 |
| `hdiutil: create failed - ... resource ...` | 일시적 DMG 생성 실패. 재시도하고, `hdiutil info`로 마운트된 이미지 정리 |
| `spctl`은 통과하지만 다른 Mac에서 차단 | DMG/ZIP 전송 시 quarantine, 또는 오래된 Gatekeeper 캐시. 재부팅/재다운로드로 확인 |

<br />

## 9. 보안 주의

- `.p12`, `.p8`, 앱 전용 암호, API 키를 저장소에 커밋하지 마세요.
  `.gitignore`에 `*.p12`, `*.p8`, `*.cer`, `*.mobileprovision`을 추가해 두었습니다.
- `.p12`는 비밀번호가 있는 안전한 저장소(1Password 등)에 백업하세요.
- 인증서가 유출되면 developer.apple.com에서 즉시 폐기(Revoke)하고 새로 발급합니다.
- 공증은 앱 번들을 Apple 서버에 업로드합니다. 민감한 정보가 포함된 빌드는 공증하지 않거나
  배포 정책을 별도로 검토하세요.
- 로컬 빌드(`npm run dist`)는 여전히 **서명되지 않은** 개발용입니다. 이 파일을 그대로
  배포하지 마세요. 배포에는 반드시 `./scripts/release-mac.sh`를 사용하세요.

<br />

## 참고

- Apple: [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- electron-builder: [macOS Notarization](https://www.electron.build/docs/features/code-signing/notarization)
- electron-builder: [Code Signing](https://www.electron.build/docs/features/code-signing/)
