import { Clock3, FilePlus2, FileText, FolderOpen, Sparkles } from 'lucide-react'

interface Props {
  recent: string[]
  onNew: () => void
  onOpen: () => void
  onOpenRecent: (path: string) => void
  version: string
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function dirName(path: string): string {
  const parts = path.split(/[\\/]/)
  parts.pop()
  return parts.join('/')
}

function kindOf(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return extension === 'hwpx'
    ? 'HWPX'
    : extension === 'hwp'
      ? 'HWP'
      : extension === 'md' || extension === 'markdown'
        ? 'MD'
        : extension === 'html' || extension === 'htm'
          ? 'HTML'
          : 'TXT'
}

export function Welcome({ recent, onNew, onOpen, onOpenRecent, version }: Props) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-mark" aria-hidden="true">
          한
        </div>
        <p className="welcome-eyebrow">HANMAC DOCUMENTS</p>
        <h1>한맥 문서</h1>
        <p className="welcome-sub">
          한글 문서를 열고, 쓰고, HWPX로 저장하세요.
          <br />
          AI 도우미가 요약·교정·번역을 도와줍니다.
        </p>

        <div className="welcome-actions">
          <button type="button" className="primary-button" onClick={onNew}>
            <FilePlus2 size={17} />
            새 문서
          </button>
          <button type="button" className="secondary-button" onClick={onOpen}>
            <FolderOpen size={17} />
            파일 열기
          </button>
        </div>

        <div className="welcome-recent">
          <div className="welcome-section-title">
            <Clock3 size={13} />
            최근 문서
          </div>
          {recent.length === 0 ? (
            <p className="welcome-empty">
              최근 문서가 없습니다. <strong>.hwp</strong> 또는 <strong>.hwpx</strong> 파일을
              끌어다 놓아도 됩니다.
            </p>
          ) : (
            <ul>
              {recent.slice(0, 6).map((path) => (
                <li key={path}>
                  <button type="button" onClick={() => onOpenRecent(path)} title={path}>
                    <FileText size={15} />
                    <span className="recent-name">{fileName(path)}</span>
                    <span className="recent-dir">{dirName(path)}</span>
                    <span className="recent-kind">{kindOf(path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="welcome-footer">
          <span>HWP · HWPX · HTML · TXT · Markdown</span>
          <span className="welcome-ai">
            <Sparkles size={12} /> Ollama / OpenAI 호환
          </span>
          <span>v{version}</span>
        </div>
      </div>
    </div>
  )
}
