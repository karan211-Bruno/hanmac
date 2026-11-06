import type { Editor } from '@tiptap/core'
import CharacterCount from '@tiptap/extension-character-count'
import Color from '@tiptap/extension-color'
import FontFamily from '@tiptap/extension-font-family'
import Highlight from '@tiptap/extension-highlight'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TextAlign from '@tiptap/extension-text-align'
import TextStyle from '@tiptap/extension-text-style'
import Underline from '@tiptap/extension-underline'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import DOMPurify from 'dompurify'
import { AlertCircle, Check, Info, Loader2, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { blocksToMarkdown, blocksToText, escapeHtml, textToHtml } from '../../shared/hwpxHtml'
import type {
  AiModelInfo,
  AiProvider,
  AiPublicSettings,
  AiSettingsPatch,
  ExportPayload,
  FileKind,
  MenuAction,
  OpenMeta,
  OpenResult
} from '../../shared/types'
import { AIPanel } from './components/AIPanel'
import { LinkDialog } from './components/LinkDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { StatusBar } from './components/StatusBar'
import { Titlebar } from './components/Titlebar'
import { Welcome } from './components/Welcome'
import { FontSize } from './editor/FontSize'
import { Indent } from './editor/Indent'
import { PageBreak } from './editor/PageBreak'
import { Toolbar } from './editor/Toolbar'
import type { AiAction } from './lib/ai'
import {
  errorMessage,
  siblingPath,
  standaloneHtml,
  titleFromName
} from './lib/document'
import { htmlToBlocks } from './lib/htmlToBlocks'

interface DocState {
  path: string | null
  name: string
  kind: FileKind
  meta: OpenMeta | null
}

interface Stats {
  pages: number
  chars: number
  words: number
}

type ToastTone = 'info' | 'success' | 'error'

interface ToastState {
  message: string
  tone: ToastTone
}

const FALLBACK_SETTINGS: AiPublicSettings = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'qwen2.5:7b',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini',
  hasApiKey: false,
  temperature: 0.3,
  systemPrompt:
    '당신은 한국어 문서 편집을 돕는 전문 어시스턴트입니다. 결과는 Markdown 기호 없이 일반 텍스트로만 출력하세요.'
}

const EMPTY_DOC: DocState = {
  path: null,
  name: '제목 없음',
  kind: 'new',
  meta: null
}

export default function App() {
  const [docState, setDocState] = useState<DocState>(EMPTY_DOC)
  const [dirty, setDirty] = useState(false)
  const [stats, setStats] = useState<Stats>({ pages: 1, chars: 0, words: 0 })
  const [hasSelection, setHasSelection] = useState(false)
  const [welcome, setWelcome] = useState(true)
  const [aiOpen, setAiOpen] = useState(true)
  const [aiRequest, setAiRequest] = useState<{ action: AiAction; nonce: number } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkInitial, setLinkInitial] = useState('')
  const [settings, setSettings] = useState<AiPublicSettings | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [dragging, setDragging] = useState(false)
  const [hwpNotice, setHwpNotice] = useState<string | null>(null)
  const [zoom, setZoom] = useState(() => {
    try {
      const stored = localStorage.getItem('hanmac.zoom.v2')
      if (!stored) return 1
      const value = Number(stored)
      if (!Number.isFinite(value) || value <= 0) return 1
      return Math.min(2, Math.max(0.5, value))
    } catch {
      return 1
    }
  })

  const dragDepth = useRef(0)
  const aiNonce = useRef(0)

  function updateEditorStats(current: Editor): void {
    const text = current.getText()
    const chars = text.length
    const words = text.trim() ? text.trim().split(/\s+/).length : 0
    const element = current.view.dom as HTMLElement
    const height = element.scrollHeight || 0
    const pages = Math.max(1, Math.ceil(height / 1000))
    setStats({ chars, words, pages })
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] }
      }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      FontFamily,
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: 'noopener noreferrer' }
      }),
      Placeholder.configure({
        placeholder: '여기에 입력하거나 HWP/HWPX 파일을 끌어다 놓으세요.'
      }),
      CharacterCount,
      Table.configure({ resizable: true, allowTableNodeSelection: true }),
      TableRow,
      TableHeader,
      TableCell,
      FontSize,
      Indent,
      PageBreak
    ],
    content: '<p></p>',
    editorProps: {
      attributes: {
        class: 'hanmac-editor',
        spellcheck: 'true'
      }
    },
    onUpdate: ({ editor: current }) => {
      setDirty(true)
      updateEditorStats(current)
    },
    onSelectionUpdate: ({ editor: current }) => {
      updateEditorStats(current)
      setHasSelection(!current.state.selection.empty)
    }
  })

  const showToast = (message: string, tone: ToastTone = 'info'): void => {
    setToast({ message, tone })
  }

  const refreshRecent = async (): Promise<void> => {
    try {
      setRecent(await window.hanmac.getRecent())
    } catch {
      // 최근 문서를 읽지 못해도 앱은 계속 동작한다.
    }
  }

  useEffect(() => {
    let active = true
    window.hanmac
      .getSettings()
      .then((value) => {
        if (active) setSettings(value)
      })
      .catch(() => {
        if (active) setSettings(FALLBACK_SETTINGS)
      })
    window.hanmac
      .getRecent()
      .then((value) => {
        if (active) setRecent(value)
      })
      .catch(() => undefined)
    window.hanmac
      .getVersion()
      .then((value) => {
        if (active) setVersion(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    window.hanmac.setTitle(docState.name, dirty)
  }, [docState.name, dirty])

  useEffect(() => {
    try {
      localStorage.setItem('hanmac.zoom.v2', String(zoom))
    } catch {
      // localStorage를 사용할 수 없으면 무시한다.
    }
  }, [zoom])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4200)
    return () => clearTimeout(timer)
  }, [toast])

  const ensureDiscard = async (): Promise<boolean> => {
    if (!dirty) return true
    try {
      return await window.hanmac.confirmDiscard()
    } catch {
      return false
    }
  }

  const applyOpenResult = (result: OpenResult): void => {
    if (!editor) return
    const rawHtml =
      result.kind === 'html'
        ? DOMPurify.sanitize(result.html, { USE_PROFILES: { html: true } })
        : result.html
    editor.commands.setContent(rawHtml || '<p></p>', false)
    setDocState({
      path: result.path,
      name: result.name,
      kind: result.kind,
      meta: result.meta
    })
    setDirty(false)
    setWelcome(false)
    setHwpNotice(result.meta.warning ?? null)
    setHasSelection(false)
    setTimeout(() => {
      updateEditorStats(editor)
      editor.commands.focus('start')
    }, 0)
    void refreshRecent()
  }

  const openDialog = async (): Promise<void> => {
    if (!(await ensureDiscard())) return
    setBusy('문서를 여는 중…')
    try {
      const result = await window.hanmac.openDialog()
      if (result) applyOpenResult(result)
    } catch (error) {
      showToast(errorMessage(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const openPath = async (path: string): Promise<void> => {
    if (!(await ensureDiscard())) return
    setBusy('문서를 여는 중…')
    try {
      applyOpenResult(await window.hanmac.openPath(path))
    } catch (error) {
      showToast(errorMessage(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const newDocument = async (): Promise<void> => {
    if (!(await ensureDiscard()) || !editor) return
    editor.commands.setContent('<p></p>', false)
    setDocState(EMPTY_DOC)
    setDirty(false)
    setWelcome(false)
    setHwpNotice(null)
    setHasSelection(false)
    setTimeout(() => {
      updateEditorStats(editor)
      editor.commands.focus('start')
    }, 0)
  }

  const saveHwpx = async (forceDialog: boolean): Promise<void> => {
    if (!editor) return
    const canSaveInPlace = docState.kind === 'hwpx' && !!docState.path
    const defaultPath = canSaveInPlace
      ? docState.path
      : siblingPath(docState.path, 'hwpx')

    setBusy('HWPX로 저장하는 중…')
    try {
      const blocks = htmlToBlocks(editor.getHTML())
      const result = await window.hanmac.saveHwpx({
        blocks,
        title: titleFromName(docState.name),
        defaultPath,
        forceDialog: forceDialog || !canSaveInPlace
      })
      if (!result) return
      setDocState((previous) => ({
        ...previous,
        path: result.path,
        name: result.name,
        kind: 'hwpx',
        meta: { format: 'HWPX' }
      }))
      setDirty(false)
      setHwpNotice(null)
      showToast(`HWPX로 저장했습니다 · ${result.name}`, 'success')
      void refreshRecent()
    } catch (error) {
      showToast(errorMessage(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const exportDocument = async (
    kind: 'html' | 'text' | 'markdown' | 'pdf'
  ): Promise<void> => {
    if (!editor) return
    setBusy('내보내는 중…')
    try {
      const title = titleFromName(docState.name)
      const blocks = htmlToBlocks(editor.getHTML())
      let payload: ExportPayload

      if (kind === 'html') {
        payload = {
          kind,
          title,
          html: standaloneHtml(title, editor.getHTML()),
          defaultPath: siblingPath(docState.path, 'html')
        }
      } else if (kind === 'markdown') {
        payload = {
          kind,
          title,
          text: blocksToMarkdown(blocks),
          defaultPath: siblingPath(docState.path, 'md')
        }
      } else if (kind === 'text') {
        payload = {
          kind,
          title,
          text: blocksToText(blocks),
          defaultPath: siblingPath(docState.path, 'txt')
        }
      } else {
        payload = {
          kind,
          title,
          html: editor.getHTML(),
          defaultPath: siblingPath(docState.path, 'pdf')
        }
      }

      const result = await window.hanmac.exportFile(payload)
      if (result) {
        const fileName = result.path.split(/[\\/]/).pop() ?? result.path
        showToast(`내보냈습니다 · ${fileName}`, 'success')
      }
    } catch (error) {
      showToast(errorMessage(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const insertAiText = (text: string, replace: boolean): void => {
    if (!editor || !text.trim()) return
    const chain = editor.chain().focus()
    if (replace && !editor.state.selection.empty) chain.deleteSelection()
    chain.insertContent(textToHtml(text.trim())).run()
    setDirty(true)
    setTimeout(() => updateEditorStats(editor), 0)
  }

  const openLinkDialog = (): void => {
    if (!editor) return
    const href = (editor.getAttributes('link').href as string | undefined) ?? ''
    setLinkInitial(href)
    setLinkOpen(true)
  }

  const applyLink = (url: string | null): void => {
    if (!editor) return
    if (!url) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    if (editor.state.selection.empty) {
      const label = url.replace(/^https?:\/\//, '')
      editor
        .chain()
        .focus()
        .insertContent(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`)
        .run()
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  const triggerAi = (action: AiAction): void => {
    aiNonce.current += 1
    setAiOpen(true)
    setAiRequest({ action, nonce: aiNonce.current })
  }

  const handleMenuAction = (action: MenuAction): void => {
    switch (action.type) {
      case 'new':
        void newDocument()
        break
      case 'open':
        void openDialog()
        break
      case 'open-path':
        if (action.path) void openPath(action.path)
        break
      case 'save':
        void saveHwpx(false)
        break
      case 'save-as':
        void saveHwpx(true)
        break
      case 'export-html':
        void exportDocument('html')
        break
      case 'export-text':
        void exportDocument('text')
        break
      case 'export-markdown':
        void exportDocument('markdown')
        break
      case 'export-pdf':
        void exportDocument('pdf')
        break
      case 'undo':
        editor?.chain().focus().undo().run()
        break
      case 'redo':
        editor?.chain().focus().redo().run()
        break
      case 'bold':
        editor?.chain().focus().toggleBold().run()
        break
      case 'italic':
        editor?.chain().focus().toggleItalic().run()
        break
      case 'underline':
        editor?.chain().focus().toggleUnderline().run()
        break
      case 'strike':
        editor?.chain().focus().toggleStrike().run()
        break
      case 'align-left':
        editor?.chain().focus().setTextAlign('left').run()
        break
      case 'align-center':
        editor?.chain().focus().setTextAlign('center').run()
        break
      case 'align-right':
        editor?.chain().focus().setTextAlign('right').run()
        break
      case 'align-justify':
        editor?.chain().focus().setTextAlign('justify').run()
        break
      case 'bullet-list':
        editor?.chain().focus().toggleBulletList().run()
        break
      case 'ordered-list':
        editor?.chain().focus().toggleOrderedList().run()
        break
      case 'blockquote':
        editor?.chain().focus().toggleBlockquote().run()
        break
      case 'insert-table':
        editor
          ?.chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run()
        break
      case 'link':
        openLinkDialog()
        break
      case 'clear-format':
        editor?.chain().focus().unsetAllMarks().clearNodes().run()
        break
      case 'zoom-in':
        setZoom((value) => Math.min(2, Math.round((value + 0.1) * 100) / 100))
        break
      case 'zoom-out':
        setZoom((value) => Math.max(0.5, Math.round((value - 0.1) * 100) / 100))
        break
      case 'zoom-reset':
        setZoom(1)
        break
      case 'toggle-ai':
        setAiOpen((value) => !value)
        break
      case 'ai-settings':
        setSettingsOpen(true)
        break
      case 'ai-summarize':
        triggerAi('summarize')
        break
      case 'ai-refine':
        triggerAi('refine')
        break
      case 'ai-translate':
        triggerAi('translate-en')
        break
      case 'ai-continue':
        triggerAi('continue')
        break
    }
  }

  const actionRef = useRef<(action: MenuAction) => void>(() => undefined)
  actionRef.current = handleMenuAction

  useEffect(() => {
    const unsubscribe = window.hanmac.onMenuAction((action) => actionRef.current(action))
    return unsubscribe
  }, [])

  const saveSettings = async (patch: AiSettingsPatch): Promise<void> => {
    const updated = await window.hanmac.setSettings(patch)
    setSettings(updated)
    showToast('AI 설정을 저장했습니다.', 'success')
  }

  const loadModels = (provider: AiProvider): Promise<AiModelInfo[]> => {
    return window.hanmac.aiModels(provider)
  }

  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    dragDepth.current += 1
    setDragging(true)
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragging(false)
    }
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    if (!(await ensureDiscard())) return

    setBusy('문서를 여는 중…')
    try {
      const result = await window.hanmac.parseBuffer(await file.arrayBuffer(), file.name)
      applyOpenResult(result)
    } catch (error) {
      showToast(errorMessage(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
    >
      <Titlebar
        name={docState.name}
        kind={docState.kind}
        dirty={dirty}
        path={docState.path}
        aiOpen={aiOpen}
        onNew={() => void newDocument()}
        onOpen={() => void openDialog()}
        onSave={() => void saveHwpx(false)}
        onSaveAs={() => void saveHwpx(true)}
        onExport={(kind) => void exportDocument(kind)}
        onToggleAi={() => setAiOpen((value) => !value)}
        onSettings={() => setSettingsOpen(true)}
      />

      {editor && (
        <Toolbar
          editor={editor}
          aiOpen={aiOpen}
          onToggleAi={() => setAiOpen((value) => !value)}
          onOpenLink={openLinkDialog}
        />
      )}

      <div className="workspace">
        <main className="canvas">
          {welcome && (
            <Welcome
              recent={recent}
              onNew={() => void newDocument()}
              onOpen={() => void openDialog()}
              onOpenRecent={(path) => void openPath(path)}
              version={version}
            />
          )}

          {!welcome && hwpNotice && (
            <div className="notice">
              <Info size={15} />
              <span>{hwpNotice}</span>
              <button type="button" onClick={() => setHwpNotice(null)} title="안내 닫기">
                <X size={13} />
              </button>
            </div>
          )}

          <div
            className="page"
            style={{ zoom, display: welcome ? 'none' : undefined }}
          >
            <EditorContent editor={editor} />
          </div>
        </main>

        <AIPanel
          open={aiOpen}
          settings={settings}
          request={aiRequest}
          getSelection={() => {
            if (!editor) return ''
            const { from, to } = editor.state.selection
            return editor.state.doc.textBetween(from, to, '\n', ' ')
          }}
          getDocumentText={() => editor?.getText({ blockSeparator: '\n' }) ?? ''}
          hasSelection={hasSelection}
          onInsert={insertAiText}
          onOpenSettings={() => setSettingsOpen(true)}
          onClose={() => setAiOpen(false)}
          onToast={showToast}
        />
      </div>

      <StatusBar
        name={docState.name}
        kind={docState.kind}
        path={docState.path}
        dirty={dirty}
        pages={stats.pages}
        chars={stats.chars}
        words={stats.words}
        zoom={zoom}
        onZoomIn={() => setZoom((value) => Math.min(2, Math.round((value + 0.1) * 100) / 100))}
        onZoomOut={() =>
          setZoom((value) => Math.max(0.5, Math.round((value - 0.1) * 100) / 100))
        }
        onZoomReset={() => setZoom(1)}
        onShowInFolder={() => {
          if (docState.path) void window.hanmac.showItemInFolder(docState.path)
        }}
      />

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={saveSettings}
        onModels={loadModels}
      />

      <LinkDialog
        open={linkOpen}
        initialUrl={linkInitial}
        onClose={() => setLinkOpen(false)}
        onApply={applyLink}
      />

      {busy && (
        <div className="busy-overlay">
          <div className="busy-card">
            <Loader2 size={18} className="spin" />
            <span>{busy}</span>
          </div>
        </div>
      )}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <Upload size={30} />
            <strong>파일을 놓아 열기</strong>
            <span>HWP · HWPX · HTML · TXT · Markdown</span>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.tone}`} role="status">
          {toast.tone === 'success' ? (
            <Check size={15} />
          ) : toast.tone === 'error' ? (
            <AlertCircle size={15} />
          ) : (
            <Info size={15} />
          )}
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} title="닫기">
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
