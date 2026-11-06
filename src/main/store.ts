import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AiProvider, AiPublicSettings, AiSettingsPatch } from '../shared/types'

interface StoredSettings {
  provider: AiProvider
  ollamaBaseUrl: string
  ollamaModel: string
  openaiBaseUrl: string
  openaiModel: string
  openaiApiKeyEnc?: string
  openaiApiKeyPlain?: string
  temperature: number
  systemPrompt: string
  recent: string[]
  zoom: number
}

export interface FullAiSettings extends AiPublicSettings {
  openaiApiKey: string
}

const DEFAULT_SYSTEM_PROMPT =
  '당신은 한국어 문서 편집을 돕는 전문 어시스턴트입니다. 사용자의 요청에 따라 요약, 교정, 번역, 이어쓰기를 수행합니다. 결과는 Markdown 기호 없이 일반 텍스트로만 출력하고, 설명이나 인사말을 덧붙이지 마세요.'

const DEFAULTS: StoredSettings = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'qwen2.5:7b',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini',
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  recent: [],
  zoom: 1
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function readStored(): StoredSettings {
  try {
    const path = settingsPath()
    if (!existsSync(path)) return { ...DEFAULTS, recent: [] }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredSettings>
    return {
      ...DEFAULTS,
      ...parsed,
      recent: Array.isArray(parsed.recent) ? parsed.recent.filter((item) => typeof item === 'string') : [],
      temperature:
        typeof parsed.temperature === 'number'
          ? Math.max(0, Math.min(2, parsed.temperature))
          : DEFAULTS.temperature
    }
  } catch {
    return { ...DEFAULTS, recent: [] }
  }
}

function writeStored(settings: StoredSettings): void {
  try {
    mkdirSync(dirname(settingsPath()), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
  } catch (error) {
    console.error('설정을 저장하지 못했습니다.', error)
  }
}

function decryptApiKey(settings: StoredSettings): string {
  if (settings.openaiApiKeyEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(settings.openaiApiKeyEnc, 'base64'))
    } catch {
      return ''
    }
  }
  return settings.openaiApiKeyPlain ?? ''
}

export function getFullSettings(): FullAiSettings {
  const stored = readStored()
  return {
    provider: stored.provider,
    ollamaBaseUrl: stored.ollamaBaseUrl,
    ollamaModel: stored.ollamaModel,
    openaiBaseUrl: stored.openaiBaseUrl,
    openaiModel: stored.openaiModel,
    temperature: stored.temperature,
    systemPrompt: stored.systemPrompt,
    hasApiKey: decryptApiKey(stored).length > 0,
    openaiApiKey: decryptApiKey(stored)
  }
}

export function getPublicSettings(): AiPublicSettings {
  const { openaiApiKey: _key, ...publicSettings } = getFullSettings()
  return publicSettings
}

export function updateSettings(patch: AiSettingsPatch): AiPublicSettings {
  const stored = readStored()

  if (patch.provider === 'ollama' || patch.provider === 'openai') {
    stored.provider = patch.provider
  }
  if (typeof patch.ollamaBaseUrl === 'string') stored.ollamaBaseUrl = patch.ollamaBaseUrl.trim()
  if (typeof patch.ollamaModel === 'string') stored.ollamaModel = patch.ollamaModel.trim()
  if (typeof patch.openaiBaseUrl === 'string') stored.openaiBaseUrl = patch.openaiBaseUrl.trim()
  if (typeof patch.openaiModel === 'string') stored.openaiModel = patch.openaiModel.trim()
  if (typeof patch.systemPrompt === 'string') stored.systemPrompt = patch.systemPrompt
  if (typeof patch.temperature === 'number' && Number.isFinite(patch.temperature)) {
    stored.temperature = Math.max(0, Math.min(2, patch.temperature))
  }

  if (patch.clearApiKey) {
    delete stored.openaiApiKeyEnc
    delete stored.openaiApiKeyPlain
  } else if (typeof patch.openaiApiKey === 'string' && patch.openaiApiKey.trim().length > 0) {
    const key = patch.openaiApiKey.trim()
    if (safeStorage.isEncryptionAvailable()) {
      stored.openaiApiKeyEnc = safeStorage.encryptString(key).toString('base64')
      delete stored.openaiApiKeyPlain
    } else {
      stored.openaiApiKeyPlain = key
      delete stored.openaiApiKeyEnc
    }
  }

  writeStored(stored)
  return getPublicSettings()
}

export function getRecent(): string[] {
  return readStored().recent
}

export function addRecent(path: string): string[] {
  const stored = readStored()
  const next = [path, ...stored.recent.filter((item) => item !== path)].slice(0, 12)
  stored.recent = next
  writeStored(stored)
  return next
}

export function getZoom(): number {
  const zoom = readStored().zoom
  return Number.isFinite(zoom) ? Math.max(0.5, Math.min(2, zoom)) : 1
}

export function setZoom(zoom: number): void {
  const stored = readStored()
  stored.zoom = Math.max(0.5, Math.min(2, zoom))
  writeStored(stored)
}
