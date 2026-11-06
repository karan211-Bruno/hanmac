import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { parseHwp, HwpError } from './formats/hwp'
import { buildHwpx, parseHwpx, HwpxError } from './formats/hwpx'
import { chat, listModels } from './ai'
import {
  addRecent,
  getFullSettings,
  getPublicSettings,
  getRecent,
  updateSettings
} from './store'
import { blocksToHtml, blocksToText, escapeHtml, textToHtml } from '../shared/hwpxHtml'
import type {
  AiChatRequest,
  AiChunk,
  AiProvider,
  ExportPayload,
  ExportResult,
  MenuAction,
  OpenMeta,
  OpenResult,
  SaveHwpxPayload,
  SaveResult
} from '../shared/types'

app.setName('한맥 문서')

let mainWindow: BrowserWindow | null = null
let pendingOpenPath: string | null = null
let isDirty = false

const aiControllers = new Map<string, AbortController>()

app.on('open-file', (event, path) => {
  event.preventDefault()
  if (mainWindow) {
    mainWindow.webContents.send('menu:action', { type: 'open-path', path } satisfies MenuAction)
    mainWindow.show()
    mainWindow.focus()
  } else {
    pendingOpenPath = path
  }
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    const path = fileFromArgv(argv)
    if (path) mainWindow.webContents.send('menu:action', { type: 'open-path', path })
  })

  app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: '한맥 문서',
      applicationVersion: app.getVersion(),
      copyright: 'HWPX · HWP 텍스트 · AI 문서 도우미'
    })

    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '../../resources/icon.png')
    if (process.platform === 'darwin' && existsSync(iconPath)) {
      app.dock?.setIcon(iconPath)
    }

    registerIpc()
    createWindow()
    buildMenu()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    for (const controller of aiControllers.values()) controller.abort()
  })
}

function createWindow(): void {
  isDirty = false
  const win = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#ece9e1',
    title: '한맥 문서',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow = win
  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  win.on('close', (event) => {
    if (!isDirty) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['닫기', '취소'],
      defaultId: 1,
      cancelId: 1,
      message: '저장하지 않은 변경 사항이 있습니다.',
      detail: '그래도 창을 닫을까요? 취소를 누르고 먼저 저장할 수 있습니다.'
    })
    if (choice !== 0) event.preventDefault()
  })

  win.on('closed', () => {
    mainWindow = null
    isDirty = false
  })

  win.webContents.on('did-finish-load', () => {
    const path = pendingOpenPath ?? fileFromArgv(process.argv)
    if (path) {
      pendingOpenPath = null
      win.webContents.send('menu:action', { type: 'open-path', path } satisfies MenuAction)
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// MARK: - IPC

function registerIpc(): void {
  ipcMain.handle('dialog:open', async (): Promise<OpenResult | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '문서 열기',
      properties: ['openFile'],
      filters: [
        { name: '한글 문서', extensions: ['hwp', 'hwpx'] },
        {
          name: '지원하는 모든 문서',
          extensions: ['hwp', 'hwpx', 'html', 'htm', 'txt', 'md', 'markdown']
        },
        { name: '모든 파일', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return openFile(result.filePaths[0])
  })

  ipcMain.handle('file:open-path', async (_event, path: string): Promise<OpenResult> => {
    return openFile(path)
  })

  ipcMain.handle(
    'file:parse-buffer',
    async (_event, data: ArrayBuffer, name: string): Promise<OpenResult> => {
      const buffer = Buffer.from(data)
      return parseBuffer(buffer, name)
    }
  )

  ipcMain.handle(
    'file:save-hwpx',
    async (_event, payload: SaveHwpxPayload): Promise<SaveResult | null> => {
      const buffer = await buildHwpx(payload.blocks, payload.title)
      let target = payload.defaultPath ?? null
      if (target && /\.hwp$/i.test(target)) target = null

      if (!target || payload.forceDialog) {
        if (!mainWindow) return null
        const result = await dialog.showSaveDialog(mainWindow, {
          title: 'HWPX로 저장',
          defaultPath: target ?? `${safeFileName(payload.title) || '제목 없음'}.hwpx`,
          filters: [{ name: '한글 문서 (HWPX)', extensions: ['hwpx'] }]
        })
        if (result.canceled || !result.filePath) return null
        target = result.filePath
      }

      if (!/\.hwpx$/i.test(target)) target += '.hwpx'
      await writeFile(target, buffer)
      addRecent(target)
      buildMenu()
      return { path: target, name: basename(target) }
    }
  )

  ipcMain.handle(
    'file:export',
    async (_event, payload: ExportPayload): Promise<ExportResult | null> => {
      if (!mainWindow) return null
      const extension =
        payload.kind === 'html'
          ? 'html'
          : payload.kind === 'markdown'
            ? 'md'
            : payload.kind === 'pdf'
              ? 'pdf'
              : 'txt'
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '내보내기',
        defaultPath:
          payload.defaultPath ??
          `${safeFileName(payload.title) || '제목 없음'}.${extension}`,
        filters: [
          {
            name:
              payload.kind === 'html'
                ? 'HTML 문서'
                : payload.kind === 'markdown'
                  ? 'Markdown 문서'
                  : payload.kind === 'pdf'
                    ? 'PDF 문서'
                    : '텍스트 문서',
            extensions: [extension]
          }
        ]
      })
      if (result.canceled || !result.filePath) return null
      if (/\.hwp$/i.test(result.filePath)) {
        await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['확인'],
          defaultId: 0,
          message: 'HWP 파일은 덮어쓸 수 없습니다.',
          detail: '원본 HWP를 보존하기 위해 다른 이름이나 확장자를 선택해 주세요.'
        })
        return null
      }
      const target = result.filePath

      if (payload.kind === 'pdf') {
        await exportPdf(target, payload.title, payload.html ?? '')
      } else {
        const content =
          payload.kind === 'html'
            ? payload.html ?? ''
            : payload.kind === 'markdown'
              ? payload.text ?? ''
              : payload.text ?? ''
        await writeFile(target, content, 'utf8')
      }

      addRecent(target)
      buildMenu()
      return { path: target }
    }
  )

  ipcMain.handle('app:get-settings', () => getPublicSettings())
  ipcMain.handle('app:set-settings', (_event, patch) => updateSettings(patch))
  ipcMain.handle('app:get-recent', () => getRecent())
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('ai:models', async (_event, provider: AiProvider) => {
    return listModels(provider, getFullSettings())
  })

  ipcMain.handle('ai:chat', async (event, request: AiChatRequest): Promise<string> => {
    const controller = new AbortController()
    aiControllers.set(request.requestId, controller)
    const send = (chunk: AiChunk): void => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', chunk)
    }

    try {
      const text = await chat(request, getFullSettings(), send, controller.signal)
      send({ requestId: request.requestId, done: true })
      return text
    } catch (error) {
      if (controller.signal.aborted) {
        send({ requestId: request.requestId, done: true, aborted: true })
        return ''
      }
      const message = error instanceof Error ? error.message : String(error)
      send({ requestId: request.requestId, error: message, done: true })
      throw new Error(message)
    } finally {
      aiControllers.delete(request.requestId)
    }
  })

  ipcMain.handle('ai:cancel', (_event, requestId: string) => {
    aiControllers.get(requestId)?.abort()
  })

  ipcMain.handle('dialog:confirm-discard', async (): Promise<boolean> => {
    if (!mainWindow) return true
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['저장 안 함', '취소'],
      defaultId: 1,
      cancelId: 1,
      message: '저장하지 않은 변경 사항이 있습니다.',
      detail: '계속하면 현재 문서의 변경 사항이 사라집니다.'
    })
    return result.response === 0
  })

  ipcMain.handle('shell:show-item', (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.on('window:set-title', (event, title: string, dirty: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    isDirty = dirty
    win.setTitle(`${title}${dirty ? ' — 수정됨' : ''} — 한맥 문서`)
    win.setDocumentEdited(dirty)
  })
}

// MARK: - 파일 열기

async function openFile(path: string): Promise<OpenResult> {
  const buffer = await readFile(path)
  const result = await parseBuffer(buffer, basename(path), extname(path).toLowerCase())
  result.path = path
  addRecent(path)
  buildMenu()
  return result
}

async function parseBuffer(
  buffer: Buffer,
  name: string,
  extension = extname(name).toLowerCase()
): Promise<OpenResult> {
  const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
  const isCfb =
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0

  if (isCfb || extension === '.hwp') {
    try {
      const parsed = parseHwp(buffer)
      const meta: OpenMeta = {
        format: parsed.version.startsWith('3.') ? 'HWP 3.0' : 'HWP 5.0',
        version: parsed.version,
        compressed: parsed.compressed,
        encrypted: parsed.encrypted,
        sections: parsed.sections,
        chars: parsed.text.length,
        usedPreview: parsed.usedPreview,
        warning: parsed.usedPreview
          ? '배포용(ViewText) 또는 특수 HWP 문서여서 미리보기 텍스트로 불러왔습니다. 저장은 HWPX 형식으로 됩니다.'
          : '구형 HWP 문서를 서식·표와 함께 불러왔습니다. 편집 후 저장하면 표준 HWPX 형식으로 저장됩니다.'
      }
      return {
        path: null,
        name,
        kind: 'hwp',
        html: blocksToHtml(parsed.blocks),
        text: parsed.text,
        meta
      }
    } catch (error) {
      if (error instanceof HwpError) throw new Error(error.message)
      throw error
    }
  }

  if (isZip || extension === '.hwpx') {
    try {
      const parsed = await parseHwpx(buffer)
      const text = blocksToText(parsed.blocks)
      return {
        path: null,
        name,
        kind: 'hwpx',
        html: blocksToHtml(parsed.blocks),
        text,
        meta: {
          format: 'HWPX',
          sections: parsed.sections,
          chars: text.length
        }
      }
    } catch (error) {
      if (error instanceof HwpxError) throw new Error(error.message)
      throw error
    }
  }

  if (extension === '.html' || extension === '.htm') {
    const html = decodeText(buffer)
    const text = stripHtml(html)
    return {
      path: null,
      name,
      kind: 'html',
      html,
      text,
      meta: { format: 'HTML', chars: text.length }
    }
  }

  if (extension === '.md' || extension === '.markdown') {
    const text = decodeText(buffer)
    return {
      path: null,
      name,
      kind: 'markdown',
      html: textToHtml(text),
      text,
      meta: { format: 'Markdown', chars: text.length }
    }
  }

  if (extension === '.txt' || extension === '') {
    const text = decodeText(buffer)
    return {
      path: null,
      name,
      kind: 'text',
      html: textToHtml(text),
      text,
      meta: { format: '텍스트', chars: text.length }
    }
  }

  throw new Error(`지원하지 않는 파일 형식입니다: ${extension || name}`)
}

function decodeText(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8')
  const replacementCount = (utf8.match(/\uFFFD/g) ?? []).length
  if (replacementCount === 0) return utf8
  try {
    return new TextDecoder('euc-kr').decode(buffer)
  } catch {
    return utf8
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 80)
}

function fileFromArgv(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    if (!/\.(hwp|hwpx|html?|txt|md|markdown)$/i.test(arg)) continue
    if (existsSync(arg)) return arg
  }
  return null
}

// MARK: - PDF

async function exportPdf(target: string, title: string, bodyHtml: string): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    width: 794,
    height: 1123,
    webPreferences: {
      sandbox: true,
      contextIsolation: true
    }
  })
  try {
    const document = pdfDocument(title, bodyHtml)
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      preferCSSPageSize: true
    })
    await writeFile(target, pdf)
  } finally {
    win.destroy()
  }
}

function pdfDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 20mm 20mm 22mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Apple SD Gothic Neo", "AppleMyungjo", "Georgia", serif;
    font-size: 11pt;
    line-height: 1.78;
    color: #1f1d1a;
    word-break: keep-all;
    overflow-wrap: break-word;
  }
  h1 { font-size: 20pt; line-height: 1.35; margin: 1.1em 0 .5em; }
  h2 { font-size: 16pt; line-height: 1.4; margin: 1.1em 0 .5em; }
  h3 { font-size: 13pt; line-height: 1.45; margin: 1em 0 .4em; }
  h4, h5, h6 { font-size: 11.5pt; margin: 1em 0 .4em; }
  p { margin: 0 0 .55em; }
  ul, ol { padding-left: 1.4em; margin: .4em 0 .7em; }
  li p { margin: 0; }
  table { border-collapse: collapse; width: 100%; margin: .9em 0; table-layout: fixed; }
  td, th { border: 1px solid #8d877c; padding: 6px 8px; vertical-align: top; }
  th { background: #f2eee4; }
  blockquote { border-left: 3px solid #a8432f; margin: 1em 0; padding: .1em 0 .1em 1em; color: #4b463e; }
  img { max-width: 100%; height: auto; }
  mark { background: #fff1a8; }
  hr { border: none; border-top: 1px solid #cfc8ba; margin: 1.4em 0; }
  a { color: #2f6b57; text-decoration: underline; }
  .page-break { page-break-after: always; height: 0; }
  .tableWrapper { overflow: visible; }
</style>
</head>
<body>${body}</body>
</html>`
}

// MARK: - 메뉴

function send(action: MenuAction): void {
  mainWindow?.webContents.send('menu:action', action)
}

function buildMenu(): void {
  const recent = getRecent()
  const recentSubmenu: MenuItemConstructorOptions[] =
    recent.length > 0
      ? recent.map((path) => ({
          label: basename(path),
          sublabel: dirname(path),
          click: () => send({ type: 'open-path', path })
        }))
      : [{ label: '최근 문서 없음', enabled: false }]

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: '파일',
      submenu: [
        {
          label: '새 문서',
          accelerator: 'CmdOrCtrl+N',
          click: () => send({ type: 'new' })
        },
        {
          label: '열기…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send({ type: 'open' })
        },
        { type: 'separator' },
        {
          label: '저장',
          accelerator: 'CmdOrCtrl+S',
          click: () => send({ type: 'save' })
        },
        {
          label: '다른 이름으로 저장…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => send({ type: 'save-as' })
        },
        { type: 'separator' },
        {
          label: '내보내기',
          submenu: [
            { label: 'HTML…', click: () => send({ type: 'export-html' }) },
            { label: '텍스트…', click: () => send({ type: 'export-text' }) },
            { label: 'Markdown…', click: () => send({ type: 'export-markdown' }) },
            { label: 'PDF…', click: () => send({ type: 'export-pdf' }) }
          ]
        },
        { type: 'separator' },
        { label: '최근 문서', submenu: recentSubmenu },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: '편집',
      submenu: [
        { label: '실행 취소', accelerator: 'CmdOrCtrl+Z', click: () => send({ type: 'undo' }) },
        {
          label: '다시 실행',
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => send({ type: 'redo' })
        },
        { type: 'separator' },
        { role: 'cut', label: '잘라내기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '모두 선택' }
      ]
    },
    {
      label: '서식',
      submenu: [
        {
          label: '굵게',
          accelerator: 'CmdOrCtrl+B',
          registerAccelerator: false,
          click: () => send({ type: 'bold' })
        },
        {
          label: '기울임',
          accelerator: 'CmdOrCtrl+I',
          registerAccelerator: false,
          click: () => send({ type: 'italic' })
        },
        {
          label: '밑줄',
          accelerator: 'CmdOrCtrl+U',
          registerAccelerator: false,
          click: () => send({ type: 'underline' })
        },
        {
          label: '취소선',
          accelerator: 'CmdOrCtrl+Shift+X',
          registerAccelerator: false,
          click: () => send({ type: 'strike' })
        },
        { type: 'separator' },
        { label: '왼쪽 정렬', click: () => send({ type: 'align-left' }) },
        { label: '가운데 정렬', click: () => send({ type: 'align-center' }) },
        { label: '오른쪽 정렬', click: () => send({ type: 'align-right' }) },
        { label: '양쪽 정렬', click: () => send({ type: 'align-justify' }) },
        { type: 'separator' },
        { label: '글머리 기호', click: () => send({ type: 'bullet-list' }) },
        { label: '번호 매기기', click: () => send({ type: 'ordered-list' }) },
        { label: '인용', click: () => send({ type: 'blockquote' }) },
        { type: 'separator' },
        { label: '표 삽입', click: () => send({ type: 'insert-table' }) },
        { label: '링크…', click: () => send({ type: 'link' }) },
        { label: '서식 지우기', click: () => send({ type: 'clear-format' }) }
      ]
    },
    {
      label: '보기',
      submenu: [
        {
          label: '확대',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => send({ type: 'zoom-in' })
        },
        {
          label: '축소',
          accelerator: 'CmdOrCtrl+-',
          click: () => send({ type: 'zoom-out' })
        },
        {
          label: '100%로 보기',
          accelerator: 'CmdOrCtrl+0',
          click: () => send({ type: 'zoom-reset' })
        },
        { type: 'separator' },
        {
          label: 'AI 패널',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => send({ type: 'toggle-ai' })
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
        ...(app.isPackaged
          ? []
          : [
              {
                label: '개발자 도구',
                accelerator: 'Alt+CmdOrCtrl+I',
                role: 'toggleDevTools' as const
              }
            ])
      ]
    },
    {
      label: 'AI',
      submenu: [
        { label: 'AI 패널 열기/닫기', click: () => send({ type: 'toggle-ai' }) },
        { label: 'AI 설정…', click: () => send({ type: 'ai-settings' }) },
        { type: 'separator' },
        { label: '요약', click: () => send({ type: 'ai-summarize' }) },
        { label: '다듬기', click: () => send({ type: 'ai-refine' }) },
        { label: '번역', click: () => send({ type: 'ai-translate' }) },
        { label: '이어쓰기', click: () => send({ type: 'ai-continue' }) }
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: '한맥 문서 정보',
          click: () => app.showAboutPanel()
        },
        {
          label: 'HWP/HWPX 안내',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: 'HWP/HWPX 안내',
              message: 'HWP 및 HWPX 문서 지원 안내',
              detail:
                '구형 .hwp(HWP 5.0/3.0)와 표준 .hwpx 문서를 서식·표와 함께 읽어들입니다. 편집 후 저장할 때는 원본 .hwp를 덮어쓰지 않고 표준 HWPX 형식으로 저장합니다.'
            })
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
