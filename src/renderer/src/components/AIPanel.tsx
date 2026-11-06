import {
  Briefcase,
  Copy,
  Languages,
  Loader2,
  PenLine,
  Plus,
  Replace,
  Scissors,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  X
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AiPublicSettings } from '../../../shared/types'
import { actionInstruction, truncateContext, type AiAction } from '../lib/ai'
import { errorMessage } from '../lib/document'

interface Props {
  open: boolean
  settings: AiPublicSettings | null
  request: { action: AiAction; nonce: number } | null
  getSelection: () => string
  getDocumentText: () => string
  hasSelection: boolean
  onInsert: (text: string, replace: boolean) => void
  onOpenSettings: () => void
  onClose: () => void
  onToast: (message: string, tone: 'info' | 'success' | 'error') => void
}

const ACTIONS: Array<{ id: AiAction; label: string; icon: ReactNode }> = [
  { id: 'summarize', label: '요약', icon: <Sparkles size={14} /> },
  { id: 'refine', label: '다듬기', icon: <Wand2 size={14} /> },
  { id: 'formal', label: '격식체', icon: <Briefcase size={14} /> },
  { id: 'concise', label: '간결하게', icon: <Scissors size={14} /> },
  { id: 'translate-en', label: '영어로', icon: <Languages size={14} /> },
  { id: 'translate-ko', label: '한국어로', icon: <Languages size={14} /> },
  { id: 'continue', label: '이어쓰기', icon: <PenLine size={14} /> }
]

export function AIPanel({
  open,
  settings,
  request,
  getSelection,
  getDocumentText,
  hasSelection,
  onInsert,
  onOpenSettings,
  onClose,
  onToast
}: Props) {
  const [prompt, setPrompt] = useState('')
  const [useSelection, setUseSelection] = useState(true)
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [lastAction, setLastAction] = useState<AiAction | null>(null)
  const activeIdRef = useRef<string | null>(null)

  useEffect(() => {
    return window.hanmac.onAiChunk((chunk) => {
      if (chunk.requestId !== activeIdRef.current) return
      if (chunk.delta) setResult((previous) => previous + chunk.delta)
      if (chunk.error) {
        setError(chunk.error)
        setStreaming(false)
      }
      if (chunk.done) setStreaming(false)
    })
  }, [])

  const run = async (action: AiAction, customPrompt?: string): Promise<void> => {
    if (!settings) {
      onOpenSettings()
      return
    }
    if (streaming) return

    const selection = getSelection()
    const source = useSelection && selection.trim() ? selection : getDocumentText()
    if (!source.trim()) {
      onToast('문서에 내용이 없습니다.', 'info')
      return
    }

    const instruction = customPrompt?.trim() || actionInstruction(action)
    if (!instruction) return

    const requestId = crypto.randomUUID()
    activeIdRef.current = requestId
    setResult('')
    setError(null)
    setStreaming(true)
    setLastAction(action)

    try {
      const text = await window.hanmac.aiChat({
        requestId,
        messages: [
          {
            role: 'user',
            content: `${instruction}\n\n---\n${truncateContext(source)}`
          }
        ],
        temperature: settings.temperature
      })
      setResult((previous) => previous || text)
    } catch (caught) {
      setError((previous) => previous ?? errorMessage(caught))
    } finally {
      if (activeIdRef.current === requestId) activeIdRef.current = null
      setStreaming(false)
    }
  }

  const runRef = useRef(run)
  runRef.current = run

  useEffect(() => {
    if (!request) return
    void runRef.current(request.action)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce])

  const cancel = (): void => {
    if (activeIdRef.current) {
      void window.hanmac.aiCancel(activeIdRef.current)
      activeIdRef.current = null
    }
    setStreaming(false)
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(result)
      onToast('복사했습니다.', 'success')
    } catch {
      onToast('복사하지 못했습니다.', 'error')
    }
  }

  const modelName = settings
    ? settings.provider === 'ollama'
      ? settings.ollamaModel
      : settings.openaiModel
    : ''
  const providerName = settings
    ? settings.provider === 'ollama'
      ? 'Ollama'
      : 'OpenAI 호환'
    : '설정 필요'

  return (
    <aside className={`ai-panel ${open ? 'open' : 'closed'}`} aria-hidden={!open}>
      <div className="ai-head">
        <div className="ai-title">
          <Sparkles size={16} />
          <span>AI 도우미</span>
        </div>
        <div className="ai-head-actions">
          <button type="button" onClick={onOpenSettings} title="AI 설정">
            <Settings size={15} />
          </button>
          <button type="button" onClick={onClose} title="AI 패널 닫기">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="ai-body">
        {!settings ? (
          <div className="ai-setup">
            <div className="ai-setup-icon">
              <Sparkles size={22} />
            </div>
            <h3>AI 설정이 필요합니다</h3>
            <p>Ollama 또는 OpenAI 호환 API를 연결하면 요약·교정·번역을 사용할 수 있습니다.</p>
            <button type="button" className="primary-button" onClick={onOpenSettings}>
              AI 설정 열기
            </button>
          </div>
        ) : (
          <>
            <div className="ai-provider">
              <span className={`provider-dot ${settings.provider}`} />
              <span className="provider-name">{providerName}</span>
              <span className="ai-model" title={modelName}>
                {modelName || '모델 없음'}
              </span>
            </div>

            <div className="ai-actions">
              {ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={`ai-chip ${lastAction === action.id && (streaming || result) ? 'active' : ''}`}
                  onClick={() => void run(action.id)}
                  disabled={streaming}
                >
                  {action.icon}
                  {action.label}
                </button>
              ))}
            </div>

            <label className="ai-toggle">
              <input
                type="checkbox"
                checked={useSelection}
                onChange={(event) => setUseSelection(event.target.checked)}
              />
              <span>선택 영역 사용</span>
              <span className={`ai-selection-state ${hasSelection ? 'has' : ''}`}>
                {hasSelection ? '선택됨' : '선택 없음'}
              </span>
            </label>

            <div className="ai-prompt">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    if (prompt.trim() && !streaming) {
                      void run('custom', prompt)
                    }
                  }
                }}
                placeholder="AI에게 무엇을 할까요? 예: 이 문단을 더 정중하게 고쳐 줘."
                rows={3}
              />
              <button
                type="button"
                className="ai-send"
                title="보내기 (⌘↵)"
                disabled={streaming || !prompt.trim()}
                onClick={() => void run('custom', prompt)}
              >
                <Send size={14} />
              </button>
            </div>

            {(streaming || result || error) && (
              <div className={`ai-result ${error ? 'error' : ''}`}>
                <div className="ai-result-head">
                  <span>
                    {error ? '오류' : streaming ? '생성 중…' : '결과'}
                  </span>
                  {streaming ? (
                    <button type="button" onClick={cancel}>
                      <Square size={11} />
                      중지
                    </button>
                  ) : result ? (
                    <button type="button" onClick={() => void copy()}>
                      <Copy size={13} />
                      복사
                    </button>
                  ) : null}
                </div>

                <div className="ai-result-text">
                  {error ?? result}
                  {streaming && <span className="ai-cursor" />}
                  {streaming && !result && !error && (
                    <span className="ai-thinking">
                      <Loader2 size={13} className="spin" />
                      모델이 응답을 준비하고 있습니다…
                    </span>
                  )}
                </div>

                {!streaming && (result || error) && (
                  <div className="ai-result-actions">
                    <button
                      type="button"
                      onClick={() => onInsert(result, false)}
                      disabled={!result}
                      title="커서 위치에 삽입"
                    >
                      <Plus size={13} />
                      삽입
                    </button>
                    <button
                      type="button"
                      onClick={() => onInsert(result, true)}
                      disabled={!result || !hasSelection}
                      title="선택한 텍스트를 결과로 교체"
                    >
                      <Replace size={13} />
                      선택 영역 교체
                    </button>
                    <button
                      type="button"
                      className="icon-only"
                      onClick={() => {
                        setResult('')
                        setError(null)
                        setLastAction(null)
                      }}
                      title="결과 지우기"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="ai-hint">
              결과는 참고용입니다. 중요한 내용은 직접 확인하세요.
              <br />
              선택 영역이 없으면 문서 전체를 사용합니다.
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
