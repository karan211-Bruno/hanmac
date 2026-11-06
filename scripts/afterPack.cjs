'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * electron-builder 26.x는 macOS 헬퍼 앱 이름을 제품명으로 바꾸지만
 * Electron 메인 바이너리는 여전히 `Electron Helper`를 찾습니다.
 * macOS 26+ arm64에서 앱이 SIGTRAP(133)으로 즉시 종료되는 문제를 피하려면
 * 헬퍼 앱/실행 파일 이름을 원래대로 되돌려야 합니다.
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
exports.default = async function afterPack(context) {
  if (context.packager.platform.name !== 'mac') return

  const product = context.packager.appInfo.productFilename
  const frameworks = path.join(
    context.appOutDir,
    `${product}.app`,
    'Contents',
    'Frameworks'
  )
  if (!fs.existsSync(frameworks)) return

  const suffixes = ['', ' (GPU)', ' (Plugin)', ' (Renderer)']

  for (const suffix of suffixes) {
    const sourceApp = path.join(frameworks, `${product} Helper${suffix}.app`)
    const targetApp = path.join(frameworks, `Electron Helper${suffix}.app`)
    if (!fs.existsSync(sourceApp)) continue
    if (fs.existsSync(targetApp)) {
      fs.rmSync(targetApp, { recursive: true, force: true })
    }
    fs.renameSync(sourceApp, targetApp)

    const macos = path.join(targetApp, 'Contents', 'MacOS')
    const sourceBin = path.join(macos, `${product} Helper${suffix}`)
    const targetBin = path.join(macos, `Electron Helper${suffix}`)
    if (fs.existsSync(sourceBin) && !fs.existsSync(targetBin)) {
      fs.renameSync(sourceBin, targetBin)
    }

    // 헬퍼 번들의 CFBundleExecutable도 새 실행 파일 이름과 맞춘다.
    const plist = path.join(targetApp, 'Contents', 'Info.plist')
    if (fs.existsSync(plist) && fs.existsSync(targetBin)) {
      const { execFileSync } = require('node:child_process')
      try {
        execFileSync('/usr/libexec/PlistBuddy', [
          '-c',
          `Set :CFBundleExecutable ${path.basename(targetBin)}`,
          plist
        ])
      } catch {
        // PlistBuddy를 쓸 수 없는 환경은 건너뛴다.
      }
    }
  }
}
