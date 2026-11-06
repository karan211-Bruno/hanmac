import type { AiChatRequest, AiChunk, AiModelInfo, AiProvider } from '../shared/types'
import type { FullAiSettings } from './store'

export async function listModels(
  provider: AiProvider,
  settings: FullAiSettings
): Promise<AiModelInfo[]> {
  if (provider === 'ollama') {
    const base = trimTrailingSlash(settings.ollamaBaseUrl)
    const response = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw await responseError(response, 'Ollama')
    const data = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>
    }
    return (data.models ?? [])
      .map((model) => model.name ?? model.model ?? '')
      .filter((name) => name.length > 0)
      .map((name) => ({ id: name, label: name }))
  }

  const base = trimTrailingSlash(settings.openaiBaseUrl)
  const headers: Record<string, string> = {}
  if (settings.openaiApiKey) headers.Authorization = `Bearer ${settings.openaiApiKey}`
  const response = await fetch(`${base}/models`, {
    headers,
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw await responseError(response, 'AI')
  const data = (await response.json()) as { data?: Array<{ id?: string }> }
  return (data.data ?? [])
    .map((model) => model.id ?? '')
    .filter((id) => id.length > 0)
    .map((id) => ({ id, label: id }))
}

export async function chat(
  request: AiChatRequest,
  settings: FullAiSettings,
  send: (chunk: AiChunk) => void,
  signal: AbortSignal
): Promise<string> {
  const messages = [...request.messages]
  if (!messages.some((message) => message.role === 'system') && settings.systemPrompt.trim()) {
    messages.unshift({ role: 'system', content: settings.systemPrompt })
  }

  const model =
    request.model ||
    (settings.provider === 'ollama' ? settings.ollamaModel : settings.openaiModel)
  const temperature = clampTemperature(request.temperature ?? settings.temperature)

  if (settings.provider === 'ollama') {
    return chatOllama(request, messages, model, temperature, settings, send, signal)
  }
  return chatOpenAI(request, messages, model, temperature, settings, send, signal)
}

async function chatOllama(
  request: AiChatRequest,
  messages: AiChatRequest['messages'],
  model: string,
  temperature: number,
  settings: FullAiSettings,
  send: (chunk: AiChunk) => void,
  signal: AbortSignal
): Promise<string> {
  const base = trimTrailingSlash(settings.ollamaBaseUrl)
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      options: { temperature }
    }),
    signal
  })

  if (!response.ok) throw await responseError(response, 'Ollama')
  if (!response.body) throw new Error('Ollama 응답 스트림을 받지 못했습니다.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: {
      message?: { content?: string }
      response?: string
      done?: boolean
      error?: string
    }
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }
    if (parsed.error) throw new Error(parsed.error)
    const delta = parsed.message?.content ?? parsed.response ?? ''
    if (delta) {
      full += delta
      send({ requestId: request.requestId, delta })
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      handleLine(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  handleLine(buffer)

  return full
}

async function chatOpenAI(
  request: AiChatRequest,
  messages: AiChatRequest['messages'],
  model: string,
  temperature: number,
  settings: FullAiSettings,
  send: (chunk: AiChunk) => void,
  signal: AbortSignal
): Promise<string> {
  const base = trimTrailingSlash(settings.openaiBaseUrl)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.openaiApiKey) headers.Authorization = `Bearer ${settings.openaiApiKey}`

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, stream: true, temperature }),
    signal
  })

  if (!response.ok) throw await responseError(response, 'AI')

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown }; text?: string }>
      error?: { message?: string } | string
    }
    if (data.error) {
      throw new Error(
        typeof data.error === 'string' ? data.error : data.error.message ?? 'AI 요청에 실패했습니다.'
      )
    }
    const text = contentOf(data.choices?.[0]?.message?.content) || data.choices?.[0]?.text || ''
    if (text) send({ requestId: request.requestId, delta: text })
    return text
  }

  if (!response.body) throw new Error('AI 응답 스트림을 받지 못했습니다.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  const handleLine = (rawLine: string): void => {
    let line = rawLine.trim()
    if (!line || line.startsWith(':')) return
    if (line.startsWith('data:')) line = line.slice(5).trim()
    if (!line || line === '[DONE]') return
    let parsed: {
      choices?: Array<{ delta?: { content?: unknown }; text?: string }>
      error?: { message?: string } | string
    }
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (parsed.error) {
      throw new Error(
        typeof parsed.error === 'string' ? parsed.error : parsed.error.message ?? 'AI 요청에 실패했습니다.'
      )
    }
    const delta = contentOf(parsed.choices?.[0]?.delta?.content) || parsed.choices?.[0]?.text || ''
    if (delta) {
      full += delta
      send({ requestId: request.requestId, delta })
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      handleLine(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  handleLine(buffer)

  return full
}

function contentOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && 'text' in item) {
          const text = (item as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

async function responseError(response: Response, label: string): Promise<Error> {
  let detail = ''
  try {
    const text = await response.text()
    try {
      const json = JSON.parse(text) as {
        error?: { message?: string } | string
        message?: string
      }
      detail =
        typeof json.error === 'string'
          ? json.error
          : json.error?.message ?? json.message ?? text
    } catch {
      detail = text
    }
  } catch {
    // 무시
  }

  const hint =
    response.status === 401
      ? ' API 키를 확인해 주세요.'
      : response.status === 404
        ? ' 모델 이름과 주소를 확인해 주세요.'
        : response.status === 0
          ? ' 서버가 실행 중인지 확인해 주세요.'
          : ''
  const suffix = detail ? `\n${String(detail).slice(0, 300)}` : ''
  return new Error(`${label} 요청에 실패했습니다. (${response.status})${hint}${suffix}`)
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function clampTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0.3
  return Math.max(0, Math.min(2, value))
}
