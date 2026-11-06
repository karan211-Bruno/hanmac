import { Check, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  AiModelInfo,
  AiProvider,
  AiPublicSettings,
  AiSettingsPatch
} from '../../../shared/types'
import { errorMessage } from '../lib/document'

interface Props {
  open: boolean
  settings: AiPublicSettings | null
  onClose: () => void
  onSave: (patch: AiSettingsPatch) => Promise<void>
  onModels: (provider: AiProvider) => Promise<AiModelInfo[]>
}

export function SettingsDialog({ open, settings, onClose, onSave, onModels }: Props) {
  const [provider, setProvider] = useState<AiProvider>('ollama')
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState('http://localhost:11434')
  const [ollamaModel, setOllamaModel] = useState('qwen2.5:7b')
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('https://api.openai.com/v1')
  const [openaiModel, setOpenaiModel] = useState('gpt-4o-mini')
  const [temperature, setTemperature] = useState(0.3)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [models, setModels] = useState<AiModelInfo[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!open || !settings) return
    setProvider(settings.provider)
    setOllamaBaseUrl(settings.ollamaBaseUrl)
    setOllamaModel(settings.ollamaModel)
    setOpenaiBaseUrl(settings.openaiBaseUrl)
    setOpenaiModel(settings.openaiModel)
    setTemperature(settings.temperature)
    setSystemPrompt(settings.systemPrompt)
    setApiKey('')
    setClearKey(false)
    setModels([])
    setTestResult(null)
  }, [open, settings])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const loadModels = async (): Promise<void> => {
    setLoadingModels(true)
    setTestResult(null)
    try {
      const list = await onModels(provider)
      setModels(list)
      setTestResult({
        ok: true,
        message:
          list.length > 0
            ? `${list.length}개 모델을 찾았습니다.`
            : '연결은 되었지만 모델 목록이 비어 있습니다.'
      })
      if (provider === 'ollama' && !ollamaModel && list[0]) setOllamaModel(list[0].id)
      if (provider === 'openai' && !openaiModel && list[0]) setOpenaiModel(list[0].id)
    } catch (error) {
      setTestResult({ ok: false, message: errorMessage(error) })
    } finally {
      setLoadingModels(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setTestResult(null)
    try {
      await onSave({
        provider,
        ollamaBaseUrl,
        ollamaModel,
        openaiBaseUrl,
        openaiModel,
        temperature,
        systemPrompt,
        ...(apiKey.trim() ? { openaiApiKey: apiKey.trim() } : {}),
        ...(clearKey ? { clearApiKey: true } : {})
      })
      onClose()
    } catch (error) {
      setTestResult({ ok: false, message: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal settings-modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <p className="modal-eyebrow">AI</p>
            <h2>AI 설정</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title="닫기">
            <X size={17} />
          </button>
        </div>

        <div className="provider-tabs">
          <button
            type="button"
            className={provider === 'ollama' ? 'active' : ''}
            onClick={() => {
              setProvider('ollama')
              setModels([])
              setTestResult(null)
            }}
          >
            Ollama · 로컬
          </button>
          <button
            type="button"
            className={provider === 'openai' ? 'active' : ''}
            onClick={() => {
              setProvider('openai')
              setModels([])
              setTestResult(null)
            }}
          >
            OpenAI 호환
          </button>
        </div>

        {provider === 'ollama' ? (
          <>
            <div className="field">
              <label htmlFor="ollama-base">서버 주소</label>
              <input
                id="ollama-base"
                value={ollamaBaseUrl}
                onChange={(event) => setOllamaBaseUrl(event.target.value)}
                placeholder="http://localhost:11434"
              />
            </div>
            <div className="field">
              <label htmlFor="ollama-model">모델</label>
              <div className="field-row">
                <input
                  id="ollama-model"
                  list="ollama-model-list"
                  value={ollamaModel}
                  onChange={(event) => setOllamaModel(event.target.value)}
                  placeholder="qwen2.5:7b"
                />
                <button
                  type="button"
                  className="secondary-button small"
                  onClick={() => void loadModels()}
                  disabled={loadingModels}
                >
                  {loadingModels ? <Loader2 size={14} className="spin" /> : null}
                  모델 불러오기
                </button>
                <datalist id="ollama-model-list">
                  {models.map((model) => (
                    <option key={model.id} value={model.id} />
                  ))}
                </datalist>
              </div>
              <p className="field-hint">
                Ollama가 실행 중이어야 합니다. 터미널에서 <code>ollama serve</code>로 시작할 수
                있습니다.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="openai-base">Base URL</label>
              <input
                id="openai-base"
                value={openaiBaseUrl}
                onChange={(event) => setOpenaiBaseUrl(event.target.value)}
                placeholder="https://api.openai.com/v1"
              />
              <p className="field-hint">
                OpenAI, Azure OpenAI, GitHub Models, LM Studio 등 OpenAI 호환
                <code> /chat/completions</code> 엔드포인트를 사용할 수 있습니다.
              </p>
            </div>
            <div className="field">
              <label htmlFor="openai-model">모델</label>
              <div className="field-row">
                <input
                  id="openai-model"
                  list="openai-model-list"
                  value={openaiModel}
                  onChange={(event) => setOpenaiModel(event.target.value)}
                  placeholder="gpt-4o-mini"
                />
                <button
                  type="button"
                  className="secondary-button small"
                  onClick={() => void loadModels()}
                  disabled={loadingModels}
                >
                  {loadingModels ? <Loader2 size={14} className="spin" /> : null}
                  모델 불러오기
                </button>
                <datalist id="openai-model-list">
                  {models.map((model) => (
                    <option key={model.id} value={model.id} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="field">
              <label htmlFor="openai-key">API 키</label>
              <input
                id="openai-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  settings?.hasApiKey ? '저장된 키 사용 중 — 변경하려면 입력' : 'sk-…'
                }
                disabled={clearKey}
                autoComplete="off"
              />
              {settings?.hasApiKey && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={clearKey}
                    onChange={(event) => setClearKey(event.target.checked)}
                  />
                  저장된 키 삭제
                </label>
              )}
              <p className="field-hint">
                키는 macOS safeStorage로 암호화해 저장하며, 렌더러로 다시 전달하지 않습니다.
              </p>
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="system-prompt">시스템 프롬프트</label>
          <textarea
            id="system-prompt"
            rows={4}
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="temperature">
            창의성 <span className="field-value">{temperature.toFixed(2)}</span>
          </label>
          <input
            id="temperature"
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={temperature}
            onChange={(event) => setTemperature(Number(event.target.value))}
          />
          <p className="field-hint">
            낮을수록 일관적이고, 높을수록 다양한 표현을 만듭니다. 문서 교정에는 0.2~0.4를
            권장합니다.
          </p>
        </div>

        {testResult && (
          <div className={`test-result ${testResult.ok ? 'ok' : 'error'}`}>
            {testResult.ok && <Check size={14} />}
            <span>{testResult.message}</span>
          </div>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void loadModels()}
            disabled={loadingModels}
          >
            연결 테스트
          </button>
          <div className="spacer" />
          <button type="button" className="secondary-button" onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? <Loader2 size={15} className="spin" /> : null}
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
