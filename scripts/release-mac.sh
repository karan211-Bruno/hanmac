#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "오류: $*" >&2
  exit 1
}

# notarytool은 Xcode 13+ 또는 최신 Command Line Tools에 포함되어 있습니다.
if ! xcrun notarytool --version >/dev/null 2>&1; then
  fail "notarytool을 사용할 수 없습니다. Xcode 또는 Command Line Tools를 업데이트하세요."
fi

# 1) Developer ID Application 인증서 찾기
IDENTITY="${CSC_NAME:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null |
    awk -F'"' '/Developer ID Application/ {print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
  fail "Developer ID Application 인증서를 찾지 못했습니다. docs/SIGNING.md를 참고하세요."
fi

# 2) 공증 자격 증명 확인 (APPLE_ID / 키체인 프로필 / API 키 중 하나)
if [[ -n "${APPLE_ID:-}" ]]; then
  [[ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] ||
    fail "APPLE_APP_SPECIFIC_PASSWORD가 필요합니다."
  [[ -n "${APPLE_TEAM_ID:-}" ]] || fail "APPLE_TEAM_ID가 필요합니다."
elif [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  if [[ -z "${APPLE_KEYCHAIN:-}" ]]; then
    export APPLE_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
  fi
elif [[ -n "${APPLE_API_KEY:-}" ]]; then
  [[ -n "${APPLE_API_KEY_ID:-}" ]] || fail "APPLE_API_KEY_ID가 필요합니다."
  [[ -n "${APPLE_API_ISSUER:-}" ]] || fail "APPLE_API_ISSUER가 필요합니다."
else
  fail "공증 자격 증명이 없습니다. APPLE_ID 계열, APPLE_KEYCHAIN_PROFILE, 또는 APPLE_API_KEY 계열을 설정하세요."
fi

echo "서명 인증서: $IDENTITY"
echo "빌드·서명·공증을 시작합니다…"

npm run build
npx electron-builder --mac \
  "-c.mac.identity=$IDENTITY" \
  -c.mac.hardenedRuntime=true \
  -c.mac.gatekeeperAssess=false \
  -c.mac.notarize=true \
  -c.mac.entitlements=build/entitlements.mac.plist \
  -c.mac.entitlementsInherit=build/entitlements.mac.inherit.plist

echo "서명·공증 검증…"
for app in "release/mac-arm64/한맥 문서.app" "release/mac/한맥 문서.app"; do
  [[ -d "$app" ]] || continue
  codesign --verify --deep --strict --verbose=2 "$app"
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=4 "$app"
done

echo "완료: release/의 DMG/ZIP"
