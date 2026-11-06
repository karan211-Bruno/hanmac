import { Minus, Plus } from 'lucide-react'
import type { FileKind } from '../../../shared/types'

interface Props {
  name: string
  kind: FileKind
  path: string | null
  dirty: boolean
  pages: number
  chars: number
  words: number
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  onShowInFolder: () => void
}

const KIND_LABEL: Record<FileKind, string> = {
  hwp: 'HWP',
  hwpx: 'HWPX',
  html: 'HTML',
  text: 'TXT',
  markdown: 'MD',
  new: '새 문서'
}

export function StatusBar({
  name,
  kind,
  path,
  dirty,
  pages,
  chars,
  words,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onShowInFolder
}: Props) {
  const saveLabel = dirty ? '수정됨' : path ? '저장됨' : '새 문서'

  return (
    <footer className="statusbar">
      <div className="status-left">
        <span className={`status-kind ${kind}`}>{KIND_LABEL[kind]}</span>
        <button
          type="button"
          className="status-file"
          onClick={onShowInFolder}
          disabled={!path}
          title={path ?? '아직 저장되지 않은 문서입니다.'}
        >
          {name}
        </button>
        {kind === 'hwp' && <span className="status-note">텍스트만</span>}
      </div>

      <div className="status-center">
        <span>쪽 ≈ {pages}</span>
        <span>글자 {chars.toLocaleString('ko-KR')}</span>
        <span>단어 {words.toLocaleString('ko-KR')}</span>
      </div>

      <div className="status-right">
        <button type="button" onClick={onZoomOut} title="축소 (⌘-)">
          <Minus size={12} />
        </button>
        <button
          type="button"
          className="zoom-value"
          onClick={onZoomReset}
          title="100%로 보기 (⌘0)"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" onClick={onZoomIn} title="확대 (⌘+)">
          <Plus size={12} />
        </button>
        <span className={`save-state ${dirty ? 'dirty' : ''}`}>{saveLabel}</span>
      </div>
    </footer>
  )
}
