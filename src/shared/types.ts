// 메인 프로세스, 프리로드, 렌더러가 공유하는 타입.

export type FileKind = 'hwp' | 'hwpx' | 'html' | 'text' | 'markdown' | 'new'

export interface OpenMeta {
  format: string
  version?: string
  compressed?: boolean
  encrypted?: boolean
  sections?: number
  chars?: number
  usedPreview?: boolean
  warning?: string
}

export interface OpenResult {
  path: string | null
  name: string
  kind: FileKind
  html: string
  text: string
  meta: OpenMeta
}

export type Align = 'left' | 'center' | 'right' | 'justify'

export interface HwpxRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  highlight?: string
  fontFamily?: string
  /** px 단위 */
  fontSize?: number
  code?: boolean
  link?: string
}

export interface HwpxParagraph {
  type: 'paragraph'
  runs: HwpxRun[]
  align?: Align
  /** 1~6. 0/undefined이면 일반 문단 */
  heading?: number
  /** 들여쓰기 레벨 */
  indent?: number
  quote?: boolean
  pageBreak?: boolean
  list?: { kind: 'bullet' | 'ordered'; level: number; index?: number }
}

export interface HwpxTableCell {
  blocks: HwpxBlock[]
  colspan?: number
  rowspan?: number
  background?: string
  align?: Align
}

export interface HwpxTable {
  type: 'table'
  rows: HwpxTableCell[][]
  border?: boolean
  width?: number
}

export interface HwpxRule {
  type: 'rule'
}

export type HwpxBlock = HwpxParagraph | HwpxTable | HwpxRule

export interface HwpxDocument {
  title: string
  blocks: HwpxBlock[]
}

export interface SaveHwpxPayload {
  blocks: HwpxBlock[]
  title: string
  defaultPath?: string | null
  forceDialog?: boolean
}

export interface SaveResult {
  path: string
  name: string
}

export type ExportKind = 'html' | 'text' | 'markdown' | 'pdf'

export interface ExportPayload {
  kind: ExportKind
  title: string
  html?: string
  text?: string
  defaultPath?: string | null
}

export interface ExportResult {
  path: string
}

export type AiProvider = 'ollama' | 'openai'

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiPublicSettings {
  provider: AiProvider
  ollamaBaseUrl: string
  ollamaModel: string
  openaiBaseUrl: string
  openaiModel: string
  hasApiKey: boolean
  temperature: number
  systemPrompt: string
}

export interface AiSettingsPatch extends Partial<AiPublicSettings> {
  /** 새 키. 빈 문자열이면 기존 키를 유지한다. */
  openaiApiKey?: string
  /** true면 저장된 키를 삭제한다. */
  clearApiKey?: boolean
}

export interface AiChatRequest {
  requestId: string
  messages: AiMessage[]
  model?: string
  temperature?: number
}

export interface AiChunk {
  requestId: string
  delta?: string
  done?: boolean
  error?: string
  aborted?: boolean
}

export interface AiModelInfo {
  id: string
  label?: string
}

export type MenuActionType =
  | 'new'
  | 'open'
  | 'save'
  | 'save-as'
  | 'export-html'
  | 'export-text'
  | 'export-markdown'
  | 'export-pdf'
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-justify'
  | 'bullet-list'
  | 'ordered-list'
  | 'blockquote'
  | 'insert-table'
  | 'link'
  | 'clear-format'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'toggle-ai'
  | 'ai-settings'
  | 'ai-summarize'
  | 'ai-refine'
  | 'ai-translate'
  | 'ai-continue'
  | 'open-path'

export interface MenuAction {
  type: MenuActionType
  path?: string
}

export interface HanMacAPI {
  openDialog(): Promise<OpenResult | null>
  openPath(path: string): Promise<OpenResult>
  parseBuffer(data: ArrayBuffer, name: string): Promise<OpenResult>
  saveHwpx(payload: SaveHwpxPayload): Promise<SaveResult | null>
  exportFile(payload: ExportPayload): Promise<ExportResult | null>
  getSettings(): Promise<AiPublicSettings>
  setSettings(patch: AiSettingsPatch): Promise<AiPublicSettings>
  getRecent(): Promise<string[]>
  aiModels(provider: AiProvider): Promise<AiModelInfo[]>
  aiChat(payload: AiChatRequest): Promise<string>
  aiCancel(requestId: string): Promise<void>
  onAiChunk(callback: (chunk: AiChunk) => void): () => void
  onMenuAction(callback: (action: MenuAction) => void): () => void
  setTitle(title: string, dirty: boolean): void
  confirmDiscard(): Promise<boolean>
  showItemInFolder(path: string): Promise<void>
  getVersion(): Promise<string>
  platform: string
}
