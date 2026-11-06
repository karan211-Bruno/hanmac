import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { blocksToHtml, blocksToText, textToHtml } from '../../../shared/hwpxHtml'
import type {
  AiChatRequest,
  AiChunk,
  AiModelInfo,
  AiProvider,
  AiPublicSettings,
  AiSettingsPatch,
  Align,
  ExportPayload,
  ExportResult,
  HanMacAPI,
  HwpxBlock,
  HwpxParagraph,
  HwpxRun,
  HwpxTable,
  HwpxTableCell,
  MenuAction,
  OpenMeta,
  OpenResult,
  SaveHwpxPayload,
  SaveResult
} from '../../../shared/types'

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        hanmac?: {
          postMessage(message: unknown): void
        }
      }
    }
    __hanmacNativeOpenBase64?: (base64: string, name: string, path?: string) => void
    __hanmacNativeMenuAction?: (action: MenuAction) => void
  }
}

const STORAGE_SETTINGS_KEY = 'hanmac.ai.settings.v1'
const STORAGE_RECENT_KEY = 'hanmac.recent.v1'
const STORAGE_DOCS_KEY = 'hanmac.savedDocs.v1'

interface StoredAiSettings extends AiPublicSettings {
  openaiApiKey?: string
}

const DEFAULT_SETTINGS: StoredAiSettings = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'qwen2.5:7b',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini',
  hasApiKey: false,
  openaiApiKey: '',
  temperature: 0.3,
  systemPrompt:
    '당신은 한국어 문서 편집을 돕는 전문 어시스턴트입니다. 결과는 Markdown 기호 없이 일반 텍스트로만 출력하세요.'
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  processEntities: true,
  htmlEntities: true
})

// MARK: - Settings & Recent Storage

function loadSettings(): StoredAiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<StoredAiSettings>
    const key = parsed.openaiApiKey ?? ''
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      openaiApiKey: key,
      hasApiKey: key.trim().length > 0
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettingsToStorage(patch: AiSettingsPatch): AiPublicSettings {
  const current = loadSettings()
  let apiKey = current.openaiApiKey ?? ''
  if (patch.clearApiKey) {
    apiKey = ''
  } else if (typeof patch.openaiApiKey === 'string' && patch.openaiApiKey.trim().length > 0) {
    apiKey = patch.openaiApiKey.trim()
  }
  const next: StoredAiSettings = {
    provider: patch.provider ?? current.provider,
    ollamaBaseUrl: patch.ollamaBaseUrl?.trim() || current.ollamaBaseUrl,
    ollamaModel: patch.ollamaModel?.trim() || current.ollamaModel,
    openaiBaseUrl: patch.openaiBaseUrl?.trim() || current.openaiBaseUrl,
    openaiModel: patch.openaiModel?.trim() || current.openaiModel,
    openaiApiKey: apiKey,
    hasApiKey: apiKey.length > 0,
    temperature:
      typeof patch.temperature === 'number' && Number.isFinite(patch.temperature)
        ? Math.max(0, Math.min(2, patch.temperature))
        : current.temperature,
    systemPrompt:
      typeof patch.systemPrompt === 'string' ? patch.systemPrompt : current.systemPrompt
  }
  try {
    localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(next))
  } catch {
    // ignore storage quota errors
  }
  const { openaiApiKey: _hidden, ...pub } = next
  return pub
}

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function addRecentPath(path: string, result?: OpenResult): void {
  try {
    const current = loadRecent().filter((item) => item !== path)
    current.unshift(path)
    localStorage.setItem(STORAGE_RECENT_KEY, JSON.stringify(current.slice(0, 10)))
    if (result) {
      const docsRaw = localStorage.getItem(STORAGE_DOCS_KEY)
      const docs = docsRaw ? (JSON.parse(docsRaw) as Record<string, OpenResult>) : {}
      docs[path] = result
      localStorage.setItem(STORAGE_DOCS_KEY, JSON.stringify(docs))
    }
  } catch {
    // ignore
  }
}

// MARK: - HWP 5.0 Browser Parser (Uint8Array + DecompressionStream)

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const MAX_REGULAR_SECTOR = 0xfffffffa

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  )
}

function concatUint8(chunks: Uint8Array[], maxLen?: number): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return maxLen !== undefined && out.length > maxLen ? out.subarray(0, maxLen) : out
}

async function inflateRawBrowser(input: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null
  const formats: CompressionFormat[] = ['deflate-raw', 'deflate']
  for (const format of formats) {
    try {
      const ds = new DecompressionStream(format)
      const writer = ds.writable.getWriter()
      void writer.write(input as unknown as BufferSource)
      void writer.close()
      const reader = ds.readable.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
      }
      const result = concatUint8(chunks)
      if (result.length > 0) return result
    } catch {
      // try next
    }
  }
  return null
}

async function parseHwpBrowser(bytes: Uint8Array): Promise<{
  text: string
  version: string
  compressed: boolean
  sections: number
  usedPreview: boolean
}> {
  if (bytes.length < 512) throw new Error('파일이 너무 작습니다.')
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== CFB_SIGNATURE[i]) {
      throw new Error('HWP 5.0 복합 파일 형식이 아닙니다.')
    }
  }

  const sectorShift = readUInt16LE(bytes, 30)
  const miniShift = readUInt16LE(bytes, 32)
  const sectorSize = 1 << sectorShift
  const miniSectorSize = 1 << miniShift
  const miniCutoff = readUInt32LE(bytes, 56)
  const fatSectorCount = readUInt32LE(bytes, 44)
  const firstDirSector = readUInt32LE(bytes, 48)
  const firstMiniFatSector = readUInt32LE(bytes, 60)
  const miniFatSectorCount = readUInt32LE(bytes, 64)
  const firstDifatSector = readUInt32LE(bytes, 68)
  const difatSectorCount = readUInt32LE(bytes, 72)

  const sectorOffset = (sec: number): number | null => {
    if (sec < 0) return null
    const off = (sec + 1) * sectorSize
    return off < bytes.length ? off : null
  }

  const fatSectorIds: number[] = []
  for (let i = 0; i < 109; i += 1) {
    const id = readUInt32LE(bytes, 76 + i * 4)
    if (id < MAX_REGULAR_SECTOR) fatSectorIds.push(id)
  }
  let difat = firstDifatSector
  for (let e = 0; e < difatSectorCount && difat < MAX_REGULAR_SECTOR; e += 1) {
    const off = sectorOffset(difat)
    if (off === null) break
    const per = sectorSize / 4
    for (let i = 0; i < per - 1; i += 1) {
      const id = readUInt32LE(bytes, off + i * 4)
      if (id < MAX_REGULAR_SECTOR) fatSectorIds.push(id)
    }
    difat = readUInt32LE(bytes, off + (per - 1) * 4)
  }
  if (fatSectorCount > 0 && fatSectorIds.length > fatSectorCount) {
    fatSectorIds.length = fatSectorCount
  }

  const fat: number[] = []
  for (const id of fatSectorIds) {
    const off = sectorOffset(id)
    if (off === null) continue
    const count = Math.min(sectorSize / 4, Math.floor((bytes.length - off) / 4))
    for (let i = 0; i < count; i += 1) {
      fat.push(readUInt32LE(bytes, off + i * 4))
    }
  }

  const readChain = (start: number, limit: number): Uint8Array => {
    const chunks: Uint8Array[] = []
    const visited = new Set<number>()
    let sec = start
    let total = 0
    while (sec < MAX_REGULAR_SECTOR && total < limit && !visited.has(sec)) {
      visited.add(sec)
      const off = sectorOffset(sec)
      if (off === null) break
      const end = Math.min(off + sectorSize, bytes.length)
      chunks.push(bytes.subarray(off, end))
      total += end - off
      if (sec >= fat.length) break
      sec = fat[sec]
    }
    return concatUint8(chunks, limit)
  }

  const dirBytes = readChain(firstDirSector, bytes.length)
  const utf16Decoder = new TextDecoder('utf-16le')
  interface Entry {
    name: string
    type: number
    startSector: number
    size: number
  }
  const entries: Entry[] = []
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = readUInt16LE(dirBytes, off + 64)
    const type = dirBytes[off + 66]
    if ((type !== 1 && type !== 2 && type !== 5) || nameLen < 2 || nameLen > 64) continue
    const name = utf16Decoder
      .decode(dirBytes.subarray(off, off + nameLen - 2))
      .replace(/\u0000/g, '')
    entries.push({
      name,
      type,
      startSector: readUInt32LE(dirBytes, off + 116),
      size: readUInt32LE(dirBytes, off + 120)
    })
  }

  const miniFat: number[] = []
  if (miniFatSectorCount > 0 && firstMiniFatSector < MAX_REGULAR_SECTOR) {
    const mfBytes = readChain(firstMiniFatSector, Math.max(miniFatSectorCount * sectorSize, sectorSize))
    for (let i = 0; i + 4 <= mfBytes.length; i += 4) {
      miniFat.push(readUInt32LE(mfBytes, i))
    }
  }

  const root = entries.find((e) => e.type === 5)
  const miniStream = root
    ? readChain(root.startSector, root.size > 0 ? root.size : bytes.length)
    : new Uint8Array(0)

  const readMiniChain = (start: number, size: number): Uint8Array => {
    const chunks: Uint8Array[] = []
    const visited = new Set<number>()
    let sec = start
    let total = 0
    while (sec < MAX_REGULAR_SECTOR && total < size && !visited.has(sec)) {
      visited.add(sec)
      const off = sec * miniSectorSize
      if (off < 0 || off >= miniStream.length) break
      const end = Math.min(off + miniSectorSize, miniStream.length)
      chunks.push(miniStream.subarray(off, end))
      total += end - off
      if (sec >= miniFat.length) break
      sec = miniFat[sec]
    }
    return concatUint8(chunks, size)
  }

  const streamOf = (entry: Entry): Uint8Array => {
    if (entry.size <= 0) return new Uint8Array(0)
    if (entry.size < miniCutoff) {
      const mini = readMiniChain(entry.startSector, entry.size)
      if (mini.length > 0) return mini
    }
    return readChain(entry.startSector, entry.size)
  }

  const headerEntry = entries.find((e) => e.type === 2 && e.name === 'FileHeader')
  if (!headerEntry) throw new Error('FileHeader 스트림이 없습니다.')
  const header = streamOf(headerEntry)
  const verNum = readUInt32LE(header, 32)
  const flags = readUInt32LE(header, 36)
  if ((flags & 0x02) !== 0) {
    throw new Error('암호가 설정된 HWP 파일은 열 수 없습니다.')
  }
  const compressed = (flags & 0x01) !== 0

  const sectionEntries = entries
    .filter((e) => e.type === 2 && /^Section\d+$/.test(e.name))
    .sort((a, b) => Number(a.name.slice(7)) - Number(b.name.slice(7)))

  const decodePara = (payload: Uint8Array): string => {
    const units: number[] = []
    for (let i = 0; i + 1 < payload.length; i += 2) {
      units.push(readUInt16LE(payload, i))
    }
    const out: number[] = []
    let idx = 0
    while (idx < units.length) {
      const u = units[idx]
      if (u === 0x000d || u === 0x0000) {
        idx += 1
      } else if (u === 0x000a) {
        out.push(0x000a)
        idx += 1
      } else if (u === 0x0009) {
        out.push(0x0009)
        idx += idx + 7 < units.length && units[idx + 7] === 0x0009 ? 8 : 1
      } else if (u >= 0x0001 && u <= 0x001f) {
        idx += 8
      } else {
        out.push(u)
        idx += 1
      }
    }
    const u16 = new Uint16Array(out)
    return utf16Decoder.decode(u16.buffer)
  }

  const extractSectionText = (streamBytes: Uint8Array): string => {
    const paragraphs: string[] = []
    let current = ''
    let seen = false
    let offset = 0
    while (offset + 4 <= streamBytes.length) {
      const h = readUInt32LE(streamBytes, offset)
      offset += 4
      const tag = h & 0x3ff
      let size = (h >>> 20) & 0xfff
      if (size === 0xfff) {
        if (offset + 4 > streamBytes.length) break
        size = readUInt32LE(streamBytes, offset)
        offset += 4
      }
      if (size < 0 || offset + size > streamBytes.length) break
      const payload = streamBytes.subarray(offset, offset + size)
      offset += size
      if (tag === 0x42) {
        if (seen) paragraphs.push(current)
        current = ''
        seen = true
      } else if (tag === 0x43) {
        current += decodePara(payload)
      }
    }
    if (seen) paragraphs.push(current)
    return paragraphs
      .map((p) => p.replace(/[\n\r\t ]+$/g, ''))
      .join('\n')
      .trim()
  }

  let fullText = ''
  for (const entry of sectionEntries) {
    const raw = streamOf(entry)
    if (raw.length === 0) continue
    const inflated = compressed ? await inflateRawBrowser(raw) : null
    const candidates = compressed ? [inflated, raw] : [raw, await inflateRawBrowser(raw)]
    for (const cand of candidates) {
      if (!cand || cand.length === 0) continue
      const t = extractSectionText(cand)
      if (t) {
        fullText = fullText ? `${fullText}\n${t}` : t
        break
      }
    }
  }

  let usedPreview = false
  if (!fullText.trim()) {
    const prv = entries.find((e) => e.type === 2 && e.name === 'PrvText')
    if (prv) {
      const raw = streamOf(prv)
      const start = raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe ? 2 : 0
      fullText = utf16Decoder.decode(raw.subarray(start)).replace(/\u0000/g, '').trim()
      usedPreview = true
    }
  }

  if (!fullText.trim()) {
    throw new Error('문서에서 본문 텍스트를 찾지 못했습니다.')
  }

  const version = `${(verNum >>> 24) & 0xff}.${(verNum >>> 16) & 0xff}.${(verNum >>> 8) & 0xff}.${verNum & 0xff}`
  return {
    text: fullText,
    version,
    compressed,
    sections: sectionEntries.length,
    usedPreview
  }
}

// MARK: - HWPX Browser Parser & Builder

interface RunStyle {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  color: string
  highlight?: string
  fontFamily: string
  fontSize: number
  code: boolean
}

interface ParaStyle {
  align: Align
  heading: number
  indent: number
  quote: boolean
}

const DEFAULT_RUN_STYLE: RunStyle = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: '#000000',
  fontFamily: '함초롬돋움',
  fontSize: 13.33,
  code: false
}

const DEFAULT_PARA_STYLE: ParaStyle = {
  align: 'justify',
  heading: 0,
  indent: 0,
  quote: false
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function textOf(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (typeof value === 'object') {
    if ('#text' in (value as Record<string, unknown>)) {
      return textOf((value as Record<string, unknown>)['#text'])
    }
    let res = ''
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '#text' || k.startsWith('@_')) continue
      res += textOf(v)
    }
    return res
  }
  return ''
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

async function parseHwpxBrowser(data: ArrayBuffer | Uint8Array): Promise<{
  title: string
  blocks: HwpxBlock[]
  sections: number
}> {
  const zip = await JSZip.loadAsync(data)
  const sectionNames = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/section(\d+)\.xml$/i)?.[1] ?? 0)
      const nb = Number(b.match(/section(\d+)\.xml$/i)?.[1] ?? 0)
      return na - nb
    })

  if (sectionNames.length === 0) {
    throw new Error('문서 본문(section XML)을 찾을 수 없습니다.')
  }

  const charStyles = new Map<string, RunStyle>([['0', { ...DEFAULT_RUN_STYLE }]])
  const paraStyles = new Map<string, ParaStyle>([['0', { ...DEFAULT_PARA_STYLE }]])
  const borderFills = new Map<string, string | undefined>([['0', undefined]])

  const headerFile = zip.file('Contents/header.xml')
  if (headerFile) {
    try {
      const parsed = xmlParser.parse(await headerFile.async('string'))
      const head = toArray(parsed.head)[0] ?? parsed
      const refList = head?.refList
      const fonts = new Map<string, string>()
      for (const face of toArray(refList?.fontfaces?.fontface)) {
        const lang = String(face?.['@_lang'] ?? '')
        for (const font of toArray(face?.font)) {
          const id = String(font?.['@_id'] ?? '')
          const name = String(font?.['@_face'] ?? '')
          if (id && name && (!fonts.has(id) || lang === 'HANGUL')) fonts.set(id, name)
        }
      }
      for (const charPr of toArray(refList?.charProperties?.charPr)) {
        const id = String(charPr?.['@_id'] ?? '')
        if (!id) continue
        const fontRef = toArray(charPr?.fontRef)[0] ?? {}
        const fontId = String(fontRef?.['@_hangul'] ?? fontRef?.['@_latin'] ?? '0')
        const height = Number(charPr?.['@_height'] ?? 1000)
        const shade = String(charPr?.['@_shadeColor'] ?? 'none')
        charStyles.set(id, {
          bold: Object.prototype.hasOwnProperty.call(charPr, 'bold'),
          italic: Object.prototype.hasOwnProperty.call(charPr, 'italic'),
          underline: Object.prototype.hasOwnProperty.call(charPr, 'underline'),
          strike:
            Object.prototype.hasOwnProperty.call(charPr, 'strikeout') ||
            Object.prototype.hasOwnProperty.call(charPr, 'strike'),
          color: String(charPr?.['@_textColor'] ?? '#000000'),
          highlight: shade !== 'none' ? shade : undefined,
          fontFamily: fonts.get(fontId) ?? '함초롬돋움',
          fontSize: Math.round((height / 75) * 100) / 100,
          code: false
        })
      }
      for (const paraPr of toArray(refList?.paraProperties?.paraPr)) {
        const id = String(paraPr?.['@_id'] ?? '')
        if (!id) continue
        const alignRaw = String(paraPr?.align?.['@_horizontal'] ?? 'JUSTIFY').toLowerCase()
        const align: Align =
          alignRaw === 'left' || alignRaw === 'center' || alignRaw === 'right'
            ? alignRaw
            : 'justify'
        const headingType = String(paraPr?.heading?.['@_type'] ?? 'NONE')
        const level = Number(paraPr?.heading?.['@_level'] ?? 0)
        const leftNode = paraPr?.margin?.left
        const left =
          Number(typeof leftNode === 'object' ? leftNode?.['@_value'] : leftNode ?? 0) || 0
        paraStyles.set(id, {
          align,
          heading: headingType === 'OUTLINE' && level > 0 ? Math.min(6, level) : 0,
          indent: Math.min(5, Math.max(0, Math.round(left / 2000))),
          quote: false
        })
      }
    } catch {
      // use defaults
    }
  }

  const walkRun = (node: any, style: RunStyle, out: HwpxRun[]): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walkRun(item, style, out)
      return
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('@_') || k === '#text' || k === 'tbl') continue
      if (k === 't') {
        const t = textOf(v)
        if (t) out.push({ ...style, text: t })
      } else if (k === 'br' || k === 'lineBreak') {
        out.push({ ...style, text: '\n' })
      } else if (k === 'tab') {
        out.push({ ...style, text: '\t' })
      } else {
        walkRun(v, style, out)
      }
    }
  }

  const parseParagraph = (pNode: any): HwpxParagraph => {
    const pStyle = paraStyles.get(String(pNode?.['@_paraPrIDRef'] ?? '')) ?? DEFAULT_PARA_STYLE
    const runs: HwpxRun[] = []
    for (const rNode of toArray(pNode?.run)) {
      const cStyle = charStyles.get(String(rNode?.['@_charPrIDRef'] ?? '')) ?? DEFAULT_RUN_STYLE
      walkRun(rNode, cStyle, runs)
    }
    return {
      type: 'paragraph',
      runs,
      align: pStyle.align,
      heading: pStyle.heading > 0 ? pStyle.heading : undefined,
      indent: pStyle.indent > 0 ? pStyle.indent : undefined,
      pageBreak: String(pNode?.['@_pageBreak'] ?? '0') === '1' ? true : undefined
    }
  }

  const collectTables = (node: any): any[] => {
    const tables: any[] = []
    const visit = (val: any): void => {
      if (!val || typeof val !== 'object') return
      if (Array.isArray(val)) {
        for (const item of val) visit(item)
        return
      }
      for (const [k, child] of Object.entries(val)) {
        if (k === 'tbl') tables.push(child)
        else if (!k.startsWith('@_') && k !== 't' && k !== '#text') visit(child)
      }
    }
    visit(node)
    return tables
  }

  const parseTable = (tbl: any): HwpxTable => {
    const rows: HwpxTableCell[][] = toArray(tbl?.tr).map((tr: any) =>
      toArray(tr?.tc).map((tc: any) => {
        const subBlocks: HwpxBlock[] = []
        for (const pNode of toArray(tc?.subList?.p)) {
          subBlocks.push(parseParagraph(pNode))
        }
        const span = toArray(tc?.cellSpan)[0] ?? {}
        return {
          blocks: subBlocks.length > 0 ? subBlocks : [{ type: 'paragraph', runs: [] }],
          colspan: Math.max(1, Number(span?.['@_colSpan'] ?? 1) || 1),
          rowspan: Math.max(1, Number(span?.['@_rowSpan'] ?? 1) || 1),
          background: borderFills.get(String(tc?.['@_borderFillIDRef'] ?? ''))
        }
      })
    )
    return { type: 'table', rows, border: true }
  }

  const blocks: HwpxBlock[] = []
  for (const name of sectionNames) {
    const file = zip.file(name)
    if (!file) continue
    const parsed = xmlParser.parse(await file.async('string'))
    const sec = toArray(parsed.sec)[0] ?? parsed
    for (const pNode of toArray(sec?.p)) {
      const tables = collectTables(pNode)
      const para = parseParagraph(pNode)
      if (para.runs.some((r) => r.text.length > 0) || tables.length === 0) {
        blocks.push(para)
      }
      for (const t of tables) blocks.push(parseTable(t))
    }
  }

  return {
    title: '한맥 문서',
    blocks: blocks.length > 0 ? blocks : [{ type: 'paragraph', runs: [] }],
    sections: sectionNames.length
  }
}

async function buildHwpxUint8(blocks: HwpxBlock[], title = '한맥 문서'): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' })
  zip.file(
    'version.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hv:HWPApplicationSetting xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version"><hv:version appVersion="9.0.0.0" version="1.4"/></hv:HWPApplicationSetting>`
  )
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwp+zip"/></ocf:rootfiles></ocf:container>`
  )
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" version="1.2"><odf:file-entry odf:full-path="/" odf:media-type="application/hwp+zip"/><odf:file-entry odf:full-path="version.xml" odf:media-type="application/xml"/><odf:file-entry odf:full-path="Contents/content.hpf" odf:media-type="application/xml"/><odf:file-entry odf:full-path="Contents/header.xml" odf:media-type="application/xml"/><odf:file-entry odf:full-path="Contents/section0.xml" odf:media-type="application/xml"/></odf:manifest>`
  )
  zip.file(
    'Contents/content.hpf',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:dc="http://purl.org/dc/elements/1.1/" version="1.0" unique-identifier="bookid"><opf:metadata><dc:title>${escapeXml(title)}</dc:title><dc:language>ko</dc:language></opf:metadata><opf:manifest><opf:item id="header" href="header.xml" media-type="application/xml"/><opf:item id="section0" href="section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header"/><opf:itemref idref="section0"/></opf:spine></opf:package>`
  )
  zip.file(
    'Contents/header.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" version="1.4" secCnt="1"><hh:refList><hh:fontfaces itemCnt="1"><hh:fontface lang="HANGUL" fontCnt="1"><hh:font id="0" face="함초롬돋움" type="TTF" isEmbedded="0"/></hh:fontface></hh:fontfaces><hh:charProperties itemCnt="1"><hh:charPr id="0" height="1000" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="0"><hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/></hh:charPr></hh:charProperties><hh:borderFills itemCnt="2"><hh:borderFill id="0" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"/><hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"/></hh:borderFills><hh:paraProperties itemCnt="1"><hh:paraPr id="0" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="0" suppressLineNumbers="0" checked="0"><hh:align horizontal="JUSTIFY" vertical="BASELINE"/></hh:paraPr></hh:paraProperties></hh:refList></hh:head>`
  )

  let pid = 0
  const buildParaXml = (p: HwpxParagraph): string => {
    const runsXml =
      p.runs.length > 0
        ? p.runs
            .map((r) => `<hp:run charPrIDRef="0"><hp:t>${escapeXml(r.text)}</hp:t></hp:run>`)
            .join('')
        : '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>'
    return `<hp:p id="${pid++}" paraPrIDRef="0" styleIDRef="0" pageBreak="${p.pageBreak ? '1' : '0'}" columnBreak="0" merged="0">${runsXml}</hp:p>`
  }

  const bodyXml = blocks
    .map((b) => {
      if (b.type === 'paragraph') return buildParaXml(b)
      if (b.type === 'rule') {
        return buildParaXml({ type: 'paragraph', runs: [{ text: '────────────────' }] })
      }
      const rowsXml = b.rows
        .map((row, rIdx) => {
          const cellsXml = row
            .map((cell, cIdx) => {
              const cellContent = cell.blocks
                .map((cb) => (cb.type === 'paragraph' ? buildParaXml(cb) : ''))
                .join('')
              return `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP">${cellContent || buildParaXml({ type: 'paragraph', runs: [] })}</hp:subList><hp:cellAddr colAddr="${cIdx}" rowAddr="${rIdx}"/><hp:cellSpan colSpan="${cell.colspan ?? 1}" rowSpan="${cell.rowspan ?? 1}"/></hp:tc>`
            })
            .join('')
          return `<hp:tr>${cellsXml}</hp:tr>`
        })
        .join('')
      return `<hp:p id="${pid++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="${pid++}" rowCnt="${b.rows.length}" colCnt="${b.rows[0]?.length ?? 1}" borderFillIDRef="1">${rowsXml}</hp:tbl></hp:run></hp:p>`
    })
    .join('\n')

  zip.file(
    'Contents/section0.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">\n${bodyXml}\n</hs:sec>`
  )

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    mimeType: 'application/hwp+zip'
  })
}

// MARK: - Buffer Parsing

async function parseBufferInBrowser(data: ArrayBuffer, name: string): Promise<OpenResult> {
  const bytes = new Uint8Array(data)
  const ext = (name.includes('.') ? `.${name.split('.').pop()!}` : '').toLowerCase()
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  const isCfb =
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0

  if (isCfb || ext === '.hwp') {
    const parsed = await parseHwpBrowser(bytes)
    const meta: OpenMeta = {
      format: 'HWP 5.0',
      version: parsed.version,
      compressed: parsed.compressed,
      sections: parsed.sections,
      chars: parsed.text.length,
      usedPreview: parsed.usedPreview,
      warning:
        '구형 HWP는 본문 텍스트만 불러옵니다. 서식·표·그림은 복원되지 않으며, 저장은 HWPX로만 됩니다.'
    }
    const result: OpenResult = {
      path: name,
      name,
      kind: 'hwp',
      html: textToHtml(parsed.text),
      text: parsed.text,
      meta
    }
    addRecentPath(name, result)
    return result
  }

  if (isZip || ext === '.hwpx') {
    const parsed = await parseHwpxBrowser(bytes)
    const text = blocksToText(parsed.blocks)
    const result: OpenResult = {
      path: name,
      name,
      kind: 'hwpx',
      html: blocksToHtml(parsed.blocks),
      text,
      meta: {
        format: 'HWPX',
        sections: parsed.sections,
        chars: text.length
      }
    }
    addRecentPath(name, result)
    return result
  }

  const decoder = new TextDecoder('utf-8')
  const rawText = decoder.decode(bytes)
  if (ext === '.html' || ext === '.htm') {
    const result: OpenResult = {
      path: name,
      name,
      kind: 'html',
      html: rawText,
      text: rawText.replace(/<[^>]+>/g, ' ').trim(),
      meta: { format: 'HTML', chars: rawText.length }
    }
    addRecentPath(name, result)
    return result
  }

  const kind = ext === '.md' || ext === '.markdown' ? 'markdown' : 'text'
  const result: OpenResult = {
    path: name,
    name,
    kind,
    html: textToHtml(rawText),
    text: rawText,
    meta: { format: kind === 'markdown' ? 'Markdown' : '텍스트', chars: rawText.length }
  }
  addRecentPath(name, result)
  return result
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function triggerBrowserDownload(bytes: Uint8Array, filename: string, mime: string): void {
  const nativeHandler = window.webkit?.messageHandlers?.hanmac
  if (nativeHandler) {
    nativeHandler.postMessage({
      action: 'saveFile',
      filename,
      mimeType: mime,
      base64: uint8ToBase64(bytes)
    })
    return
  }
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

export function ensureHanMacBridge(): void {
  const win = window as Window & { hanmac?: HanMacAPI }
  if (typeof window === 'undefined' || win.hanmac) return

  const aiListeners = new Set<(chunk: AiChunk) => void>()
  const menuListeners = new Set<(action: MenuAction) => void>()
  const aiControllers = new Map<string, AbortController>()

  win.__hanmacNativeOpenBase64 = (base64: string, name: string) => {
    const buffer = base64ToArrayBuffer(base64)
    void parseBufferInBrowser(buffer, name).then((result) => {
      const docsRaw = localStorage.getItem(STORAGE_DOCS_KEY)
      const docs = docsRaw ? (JSON.parse(docsRaw) as Record<string, OpenResult>) : {}
      docs[name] = result
      localStorage.setItem(STORAGE_DOCS_KEY, JSON.stringify(docs))
      for (const listener of menuListeners) {
        listener({ type: 'open-path', path: name })
      }
    })
  }

  win.__hanmacNativeMenuAction = (action: MenuAction) => {
    for (const listener of menuListeners) listener(action)
  }

  const isIPad =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

  const api: HanMacAPI = {
    platform: isIPad ? 'ios' : 'web',

    openDialog(): Promise<OpenResult | null> {
      return new Promise((resolve, reject) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.hwp,.hwpx,.html,.htm,.txt,.md,.markdown'
        input.style.display = 'none'
        document.body.appendChild(input)
        input.onchange = async () => {
          const file = input.files?.[0]
          input.remove()
          if (!file) {
            resolve(null)
            return
          }
          try {
            const buf = await file.arrayBuffer()
            resolve(await parseBufferInBrowser(buf, file.name))
          } catch (err) {
            reject(err)
          }
        }
        input.oncancel = () => {
          input.remove()
          resolve(null)
        }
        input.click()
      })
    },

    async openPath(path: string): Promise<OpenResult> {
      const docsRaw = localStorage.getItem(STORAGE_DOCS_KEY)
      const docs = docsRaw ? (JSON.parse(docsRaw) as Record<string, OpenResult>) : {}
      if (docs[path]) return docs[path]
      throw new Error('이 문서는 다시 파일 열기로 선택해 주세요.')
    },

    parseBuffer(data: ArrayBuffer, name: string): Promise<OpenResult> {
      return parseBufferInBrowser(data, name)
    },

    async saveHwpx(payload: SaveHwpxPayload): Promise<SaveResult | null> {
      const safeTitle = (payload.title || '제목 없음').replace(/[\\/:*?"<>|]/g, ' ').trim()
      const filename = `${safeTitle || '제목 없음'}.hwpx`
      const bytes = await buildHwpxUint8(payload.blocks, payload.title)
      triggerBrowserDownload(bytes, filename, 'application/hwp+zip')
      const text = blocksToText(payload.blocks)
      addRecentPath(filename, {
        path: filename,
        name: filename,
        kind: 'hwpx',
        html: blocksToHtml(payload.blocks),
        text,
        meta: { format: 'HWPX', chars: text.length }
      })
      return { path: filename, name: filename }
    },

    async exportFile(payload: ExportPayload): Promise<ExportResult | null> {
      const safeTitle = (payload.title || '제목 없음').replace(/[\\/:*?"<>|]/g, ' ').trim()
      if (payload.kind === 'pdf') {
        const nativeHandler = window.webkit?.messageHandlers?.hanmac
        if (nativeHandler) {
          nativeHandler.postMessage({
            action: 'exportPdf',
            title: safeTitle,
            html: payload.html ?? ''
          })
        } else {
          window.print()
        }
        return { path: `${safeTitle}.pdf` }
      }

      const ext = payload.kind === 'html' ? 'html' : payload.kind === 'markdown' ? 'md' : 'txt'
      const mime =
        payload.kind === 'html'
          ? 'text/html;charset=utf-8'
          : payload.kind === 'markdown'
            ? 'text/markdown;charset=utf-8'
            : 'text/plain;charset=utf-8'
      const content = payload.kind === 'html' ? payload.html ?? '' : payload.text ?? ''
      const filename = `${safeTitle}.${ext}`
      triggerBrowserDownload(new TextEncoder().encode(content), filename, mime)
      return { path: filename }
    },

    async getSettings(): Promise<AiPublicSettings> {
      const { openaiApiKey: _hidden, ...pub } = loadSettings()
      return pub
    },

    async setSettings(patch: AiSettingsPatch): Promise<AiPublicSettings> {
      return saveSettingsToStorage(patch)
    },

    async getRecent(): Promise<string[]> {
      return loadRecent()
    },

    async aiModels(provider: AiProvider): Promise<AiModelInfo[]> {
      const s = loadSettings()
      if (provider === 'ollama') {
        const base = s.ollamaBaseUrl.replace(/\/+$/, '')
        const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) })
        if (!res.ok) throw new Error(`Ollama 연결 실패 (${res.status})`)
        const data = (await res.json()) as { models?: Array<{ name?: string }> }
        return (data.models ?? [])
          .map((m) => m.name ?? '')
          .filter(Boolean)
          .map((id) => ({ id, label: id }))
      }
      const base = s.openaiBaseUrl.replace(/\/+$/, '')
      const headers: Record<string, string> = {}
      if (s.openaiApiKey) headers.Authorization = `Bearer ${s.openaiApiKey}`
      const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`AI 서버 연결 실패 (${res.status})`)
      const data = (await res.json()) as { data?: Array<{ id?: string }> }
      return (data.data ?? [])
        .map((m) => m.id ?? '')
        .filter(Boolean)
        .map((id) => ({ id, label: id }))
    },

    async aiChat(request: AiChatRequest): Promise<string> {
      const s = loadSettings()
      const controller = new AbortController()
      aiControllers.set(request.requestId, controller)
      const emit = (chunk: AiChunk): void => {
        for (const fn of aiListeners) fn(chunk)
      }

      try {
        const messages = [...request.messages]
        if (!messages.some((m) => m.role === 'system') && s.systemPrompt.trim()) {
          messages.unshift({ role: 'system', content: s.systemPrompt })
        }
        const model =
          request.model || (s.provider === 'ollama' ? s.ollamaModel : s.openaiModel)
        const temperature = request.temperature ?? s.temperature

        if (s.provider === 'ollama') {
          const base = s.ollamaBaseUrl.replace(/\/+$/, '')
          const res = await fetch(`${base}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages, stream: false, options: { temperature } }),
            signal: controller.signal
          })
          if (!res.ok) throw new Error(`Ollama 요청 실패 (${res.status})`)
          const data = (await res.json()) as { message?: { content?: string } }
          const text = data.message?.content ?? ''
          if (text) emit({ requestId: request.requestId, delta: text })
          emit({ requestId: request.requestId, done: true })
          return text
        }

        const base = s.openaiBaseUrl.replace(/\/+$/, '')
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (s.openaiApiKey) headers.Authorization = `Bearer ${s.openaiApiKey}`
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages, stream: false, temperature }),
          signal: controller.signal
        })
        if (!res.ok) throw new Error(`AI 요청 실패 (${res.status})`)
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const text = data.choices?.[0]?.message?.content ?? ''
        if (text) emit({ requestId: request.requestId, delta: text })
        emit({ requestId: request.requestId, done: true })
        return text
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        emit({ requestId: request.requestId, error: msg, done: true })
        throw err
      } finally {
        aiControllers.delete(request.requestId)
      }
    },

    async aiCancel(requestId: string): Promise<void> {
      aiControllers.get(requestId)?.abort()
    },

    onAiChunk(callback: (chunk: AiChunk) => void): () => void {
      aiListeners.add(callback)
      return () => aiListeners.delete(callback)
    },

    onMenuAction(callback: (action: MenuAction) => void): () => void {
      menuListeners.add(callback)
      return () => menuListeners.delete(callback)
    },

    setTitle(title: string, dirty: boolean): void {
      document.title = `${title}${dirty ? ' — 수정됨' : ''} — 한맥 문서`
    },

    async confirmDiscard(): Promise<boolean> {
      return window.confirm('저장하지 않은 변경 사항이 있습니다. 계속할까요?')
    },

    async showItemInFolder(): Promise<void> {
      // no-op on web/iPad
    },

    async getVersion(): Promise<string> {
      return '0.1.0'
    }
  }

  Object.defineProperty(window, 'hanmac', {
    value: api,
    configurable: true,
    writable: true
  })
}
