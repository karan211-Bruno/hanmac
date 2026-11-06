import {
  Download,
  FileCode2,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  FileType2,
  FolderOpen,
  Save,
  Settings,
  Sparkles
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ExportKind, FileKind } from '../../../shared/types'

interface Props {
  name: string
  kind: FileKind
  dirty: boolean
  path: string | null
  aiOpen: boolean
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onExport: (kind: ExportKind) => void
  onToggleAi: () => void
  onSettings: () => void
}

const KIND_LABEL: Record<FileKind, string> = {
  hwp: 'HWP',
  hwpx: 'HWPX',
  html: 'HTML',
  text: 'TXT',
  markdown: 'MD',
  new: '새 문서'
}

export function Titlebar({
  name,
  kind,
  dirty,
  path,
  aiOpen,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onExport,
  onToggleAi,
  onSettings
}: Props) {
  const [exportOpen, setExportOpen] = useState(false)
  const exportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!exportOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!exportRef.current?.contains(event.target as Node)) setExportOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [exportOpen])

  return (
    <header className="titlebar">
      <div className="app-mark" aria-hidden="true">
        한
      </div>
      <div className="doc-title">
        <span className="doc-name" title={path ?? name}>
          {name}
        </span>
        <span className={`kind-badge ${kind}`}>{KIND_LABEL[kind]}</span>
        {dirty && <span className="dirty-dot" title="저장되지 않은 변경 사항" />}
      </div>
      <div className="titlebar-actions">
        <button type="button" title="새 문서 (⌘N)" aria-label="새 문서 (⌘N)" onClick={onNew}>
          <FilePlus2 size={16} />
        </button>
        <button type="button" title="열기 (⌘O)" aria-label="열기 (⌘O)" onClick={onOpen}>
          <FolderOpen size={16} />
        </button>
        <button type="button" title="저장 (⌘S)" aria-label="저장 (⌘S)" onClick={onSave}>
          <Save size={16} />
        </button>
        <div className="tool-menu-wrap" ref={exportRef}>
          <button
            type="button"
            className={exportOpen ? 'active' : ''}
            title="다른 이름으로 저장 · 내보내기"
            aria-label="다른 이름으로 저장 · 내보내기"
            onClick={() => setExportOpen((value) => !value)}
          >
            <Download size={16} />
          </button>
          {exportOpen && (
            <div className="tool-menu titlebar-menu">
              <button
                type="button"
                onClick={() => {
                  setExportOpen(false)
                  onSaveAs()
                }}
              >
                <Save size={14} /> HWPX 다른 이름으로 저장…
              </button>
              <div className="tool-menu-separator" />
              <button
                type="button"
                onClick={() => {
                  setExportOpen(false)
                  onExport('pdf')
                }}
              >
                <FileSpreadsheet size={14} /> PDF로 내보내기…
              </button>
              <button
                type="button"
                onClick={() => {
                  setExportOpen(false)
                  onExport('html')
                }}
              >
                <FileCode2 size={14} /> HTML로 내보내기…
              </button>
              <button
                type="button"
                onClick={() => {
                  setExportOpen(false)
                  onExport('markdown')
                }}
              >
                <FileType2 size={14} /> Markdown으로 내보내기…
              </button>
              <button
                type="button"
                onClick={() => {
                  setExportOpen(false)
                  onExport('text')
                }}
              >
                <FileText size={14} /> 텍스트(TXT)로 내보내기…
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          className={aiOpen ? 'active' : ''}
          title="AI 도우미 (⌘⇧A)"
          aria-label="AI 도우미 (⌘⇧A)"
          onClick={onToggleAi}
        >
          <Sparkles size={16} />
        </button>
        <button type="button" title="AI 설정" aria-label="AI 설정" onClick={onSettings}>
          <Settings size={16} />
        </button>
      </div>
    </header>
  )
}
