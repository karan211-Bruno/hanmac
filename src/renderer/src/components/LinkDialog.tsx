import { X } from 'lucide-react'
import { useEffect, useState } from 'react'

interface Props {
  open: boolean
  initialUrl: string
  onClose: () => void
  onApply: (url: string | null) => void
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^(https?:|mailto:|tel:|#)/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export function LinkDialog({ open, initialUrl, onClose, onApply }: Props) {
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (open) setUrl(initialUrl)
  }, [open, initialUrl])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const apply = (): void => {
    const normalized = normalizeUrl(url)
    onApply(normalized || null)
    onClose()
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal link-modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <p className="modal-eyebrow">링크</p>
            <h2>링크 넣기</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title="닫기">
            <X size={17} />
          </button>
        </div>
        <div className="field">
          <label htmlFor="link-url">주소</label>
          <input
            id="link-url"
            autoFocus
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') apply()
            }}
            placeholder="https://example.com"
          />
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              onApply(null)
              onClose()
            }}
          >
            링크 삭제
          </button>
          <div className="spacer" />
          <button type="button" className="secondary-button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="primary-button" onClick={apply}>
            적용
          </button>
        </div>
      </div>
    </div>
  )
}
