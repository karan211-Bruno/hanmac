import { inflateRawSync, inflateSync, constants as zlibConstants } from 'node:zlib'
import { blocksToText } from '../../shared/hwpxHtml'
import type {
  Align,
  HwpxBlock,
  HwpxParagraph,
  HwpxRun,
  HwpxTable,
  HwpxTableCell
} from '../../shared/types'

// HWP 5.0(OLE 복합 파일) 및 구형 HWP(3.0) 문서 읽기.
// 공개된 「한글 문서 파일 형식 5.0」 규격을 바탕으로
// DocInfo(글꼴·글자 모양·문단 모양·셀 배경)와 BodyText/SectionN(문단·서식 런·표·글상자)을
// 모두 복원해 HwpxBlock[] 구조로 변환한다.

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const HWP30_SIGNATURE = 'HWP Document File V3.00'
const MAX_REGULAR_SECTOR = 0xfffffffa

export type HwpErrorCode =
  | 'not-compound-file'
  | 'corrupt'
  | 'encrypted'
  | 'unsupported-version'
  | 'no-text'

export class HwpError extends Error {
  readonly code: HwpErrorCode

  constructor(code: HwpErrorCode, message: string) {
    super(message)
    this.name = 'HwpError'
    this.code = code
  }
}

export interface HwpParseResult {
  text: string
  blocks: HwpxBlock[]
  version: string
  compressed: boolean
  encrypted: boolean
  distributed?: boolean
  sections: number
  tables: number
  usedPreview: boolean
}

interface CfbEntry {
  name: string
  type: number
  startSector: number
  size: number
}

interface HwpRecord {
  tag: number
  level: number
  payload: Buffer
}

interface HwpCharShape {
  fontFamily: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  color?: string
  highlight?: string
}

interface HwpParaShape {
  align: Align
  indent?: number
  heading?: number
}

interface HwpDocContext {
  charShapes: HwpCharShape[]
  paraShapes: HwpParaShape[]
  borderFills: Array<string | undefined>
}

class CompoundFile {
  private readonly buffer: Buffer
  private readonly sectorSize: number
  private readonly miniSectorSize: number
  private readonly miniCutoff: number
  private readonly fat: number[]
  private readonly miniFat: number[]
  private readonly miniStream: Buffer
  readonly entries: CfbEntry[]

  constructor(buffer: Buffer) {
    if (buffer.length < 512) {
      throw new HwpError('corrupt', '파일이 너무 작습니다.')
    }
    if (!buffer.subarray(0, 8).equals(CFB_SIGNATURE)) {
      throw new HwpError('not-compound-file', 'HWP 5.0 복합 파일 형식이 아닙니다.')
    }

    this.buffer = buffer
    const sectorShift = buffer.readUInt16LE(30)
    const miniShift = buffer.readUInt16LE(32)
    if (sectorShift < 7 || sectorShift > 20 || miniShift < 4 || miniShift > 12) {
      throw new HwpError('corrupt', '섹터 크기 정보가 올바르지 않습니다.')
    }

    this.sectorSize = 1 << sectorShift
    this.miniSectorSize = 1 << miniShift
    this.miniCutoff = buffer.readUInt32LE(56)
    const fatSectorCount = buffer.readUInt32LE(44)
    const firstDirectorySector = buffer.readUInt32LE(48)
    const firstMiniFatSector = buffer.readUInt32LE(60)
    const miniFatSectorCount = buffer.readUInt32LE(64)
    const firstDifatSector = buffer.readUInt32LE(68)
    const difatSectorCount = buffer.readUInt32LE(72)
    const majorVersion = buffer.readUInt16LE(26)

    // DIFAT → FAT 섹터 목록
    const fatSectorIds: number[] = []
    for (let index = 0; index < 109; index += 1) {
      const id = buffer.readUInt32LE(76 + index * 4)
      if (id < MAX_REGULAR_SECTOR) fatSectorIds.push(id)
    }

    let difatSector = firstDifatSector
    const visitedDifat = new Set<number>()
    for (
      let extra = 0;
      extra < difatSectorCount && difatSector < MAX_REGULAR_SECTOR;
      extra += 1
    ) {
      if (visitedDifat.has(difatSector)) break
      visitedDifat.add(difatSector)
      const offset = this.sectorOffset(difatSector)
      if (offset === null) break
      const perSector = this.sectorSize / 4
      for (let index = 0; index < perSector - 1; index += 1) {
        const id = buffer.readUInt32LE(offset + index * 4)
        if (id < MAX_REGULAR_SECTOR) fatSectorIds.push(id)
      }
      difatSector = buffer.readUInt32LE(offset + (perSector - 1) * 4)
    }

    if (fatSectorCount > 0 && fatSectorIds.length > fatSectorCount) {
      fatSectorIds.length = fatSectorCount
    }

    // FAT
    const fat: number[] = []
    for (const id of fatSectorIds) {
      const offset = this.sectorOffset(id)
      if (offset === null) continue
      const count = Math.min(this.sectorSize / 4, Math.floor((buffer.length - offset) / 4))
      for (let index = 0; index < count; index += 1) {
        fat.push(buffer.readUInt32LE(offset + index * 4))
      }
    }
    if (fat.length === 0) {
      throw new HwpError('corrupt', 'FAT(파일 할당 테이블)을 찾지 못했습니다.')
    }
    this.fat = fat

    // 디렉터리
    const directoryBytes = this.readChain(firstDirectorySector, buffer.length)
    const entries: CfbEntry[] = []
    for (let offset = 0; offset + 128 <= directoryBytes.length; offset += 128) {
      const nameLength = directoryBytes.readUInt16LE(offset + 64)
      const type = directoryBytes[offset + 66]
      if ((type !== 1 && type !== 2 && type !== 5) || nameLength < 2 || nameLength > 64) {
        continue
      }
      const name = directoryBytes
        .subarray(offset, offset + nameLength - 2)
        .toString('utf16le')
        .replace(/\u0000/g, '')
      let size = directoryBytes.readUInt32LE(offset + 120)
      if (majorVersion === 4) {
        const high = directoryBytes.readUInt32LE(offset + 124)
        size = high * 0x100000000 + size
      }
      entries.push({
        name,
        type,
        startSector: directoryBytes.readUInt32LE(offset + 116),
        size
      })
    }

    // MiniFAT
    const miniFat: number[] = []
    if (miniFatSectorCount > 0 && firstMiniFatSector < MAX_REGULAR_SECTOR) {
      const miniFatBytes = this.readChain(
        firstMiniFatSector,
        Math.max(miniFatSectorCount * this.sectorSize, this.sectorSize)
      )
      for (let index = 0; index + 4 <= miniFatBytes.length; index += 4) {
        miniFat.push(miniFatBytes.readUInt32LE(index))
      }
    }

    // 루트 엔트리가 가리키는 미니 스트림
    let miniStream: Buffer = Buffer.alloc(0)
    const root = entries.find((entry) => entry.type === 5)
    if (root) {
      miniStream = this.readChain(root.startSector, root.size > 0 ? root.size : buffer.length)
    }

    this.miniFat = miniFat
    this.miniStream = miniStream
    this.entries = entries
  }

  get streamEntries(): CfbEntry[] {
    return this.entries.filter((entry) => entry.type === 2)
  }

  stream(name: string): Buffer | null {
    const entry = this.entries.find((item) => item.type === 2 && item.name === name)
    return entry ? this.streamOf(entry) : null
  }

  streamOf(entry: CfbEntry): Buffer {
    const size = entry.size
    if (size <= 0) return Buffer.alloc(0)
    if (size < this.miniCutoff) {
      const mini = this.readMiniChain(entry.startSector, size)
      if (mini.length > 0) return mini
    }
    return this.readChain(entry.startSector, size)
  }

  private readMiniChain(start: number, size: number): Buffer {
    const chunks: Buffer[] = []
    const visited = new Set<number>()
    let sector = start
    let total = 0
    while (sector < MAX_REGULAR_SECTOR && total < size) {
      if (visited.has(sector)) break
      visited.add(sector)
      const offset = sector * this.miniSectorSize
      if (offset < 0 || offset >= this.miniStream.length) break
      const end = Math.min(offset + this.miniSectorSize, this.miniStream.length)
      chunks.push(this.miniStream.subarray(offset, end))
      total += end - offset
      if (sector >= this.miniFat.length) break
      sector = this.miniFat[sector]
    }
    const result = Buffer.concat(chunks)
    return result.length > size ? result.subarray(0, size) : result
  }

  private readChain(start: number, limit: number): Buffer {
    const chunks: Buffer[] = []
    const visited = new Set<number>()
    let sector = start
    let total = 0
    while (sector < MAX_REGULAR_SECTOR && total < limit) {
      if (visited.has(sector)) break
      visited.add(sector)
      const offset = this.sectorOffset(sector)
      if (offset === null) break
      const end = Math.min(offset + this.sectorSize, this.buffer.length)
      if (end <= offset) break
      chunks.push(this.buffer.subarray(offset, end))
      total += end - offset
      if (sector >= this.fat.length) break
      sector = this.fat[sector]
    }
    const result = Buffer.concat(chunks)
    return result.length > limit ? result.subarray(0, limit) : result
  }

  private sectorOffset(sector: number): number | null {
    if (!Number.isInteger(sector) || sector < 0) return null
    const offset = (sector + 1) * this.sectorSize
    return offset < this.buffer.length ? offset : null
  }
}

export function parseHwp(buffer: Buffer): HwpParseResult {
  // HWP 3.0 시그니처 확인
  const asciiHeader = buffer.subarray(0, Math.min(32, buffer.length)).toString('ascii')
  if (asciiHeader.startsWith(HWP30_SIGNATURE)) {
    return parseHwp30(buffer)
  }

  const file = new CompoundFile(buffer)

  // FileHeader: 32바이트 식별 문자열 + 버전(4) + 플래그(4)
  const header = file.stream('FileHeader')
  if (!header || header.length < 40) {
    throw new HwpError('corrupt', 'FileHeader 스트림이 없습니다.')
  }
  const signature = header.subarray(0, Math.min(17, header.length)).toString('utf8')
  if (!signature.startsWith('HWP Document File')) {
    throw new HwpError('corrupt', 'FileHeader 서명이 일치하지 않습니다.')
  }

  const version = header.readUInt32LE(32)
  const major = (version >>> 24) & 0xff
  if (major < 5) {
    throw new HwpError('unsupported-version', 'HWP 5.0 이상 파일만 열 수 있습니다.')
  }

  const flags = header.readUInt32LE(36)
  if ((flags & 0x02) !== 0) {
    throw new HwpError(
      'encrypted',
      '암호가 설정된 HWP 파일은 열 수 없습니다. 한/글에서 암호를 해제한 뒤 저장해 주세요.'
    )
  }
  const compressed = (flags & 0x01) !== 0
  const distributed = (flags & 0x04) !== 0

  // DocInfo 파싱 (글꼴, 글자 모양, 문단 모양, 셀 배경색)
  const docContext = parseDocInfoStream(file.stream('DocInfo'), compressed)

  // Section0, Section1, … 순서대로 파싱한다.
  const byNumber = new Map<number, CfbEntry[]>()
  for (const entry of file.streamEntries) {
    if (!entry.name.startsWith('Section')) continue
    const suffix = entry.name.slice('Section'.length)
    if (!/^\d+$/.test(suffix)) continue
    const number = Number.parseInt(suffix, 10)
    const list = byNumber.get(number) ?? []
    list.push(entry)
    byNumber.set(number, list)
  }
  const sectionNumbers = [...byNumber.keys()].sort((a, b) => a - b)

  const blocks: HwpxBlock[] = []
  let tableCount = 0

  if (!distributed) {
    for (const number of sectionNumbers) {
      const entries = byNumber.get(number) ?? []
      for (const entry of entries) {
        const raw = file.streamOf(entry)
        if (raw.length === 0) continue
        const candidates = compressed ? [inflate(raw), raw] : [raw, inflate(raw)]
        let parsedSection: { blocks: HwpxBlock[]; tables: number } | null = null
        for (const candidate of candidates) {
          if (!candidate || candidate.length === 0) continue
          const records = parseRecords(candidate)
          if (records.length === 0) continue
          const result = parseSectionRecords(records, docContext)
          if (hasContent(result.blocks)) {
            parsedSection = result
            break
          }
        }
        if (parsedSection) {
          blocks.push(...parsedSection.blocks)
          tableCount += parsedSection.tables
          break
        }
      }
    }
  }

  // 본문이 없거나 배포용(ViewText 암호화) 문서인 경우 PrvText(미리보기 텍스트)로 대체한다.
  let usedPreview = false
  if (!hasContent(blocks)) {
    const preview = file.stream('PrvText')
    if (preview && preview.length > 0) {
      const previewText = decodePreview(preview)
      if (previewText) {
        blocks.length = 0
        for (const line of previewText.split('\n')) {
          blocks.push({
            type: 'paragraph',
            runs: line ? [{ text: line }] : []
          })
        }
        usedPreview = true
      }
    }
  }

  const text = blocksToText(blocks)
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim()

  if (!text && blocks.every((b) => b.type !== 'table')) {
    throw new HwpError('no-text', '문서에서 본문 텍스트를 찾지 못했습니다.')
  }

  return {
    text,
    blocks: blocks.length > 0 ? blocks : [{ type: 'paragraph', runs: [{ text }] }],
    version: formatVersion(version),
    compressed,
    encrypted: false,
    distributed,
    sections: Math.max(1, sectionNumbers.length),
    tables: tableCount,
    usedPreview
  }
}

function hasContent(blocks: HwpxBlock[]): boolean {
  for (const block of blocks) {
    if (block.type === 'table' && block.rows.length > 0) return true
    if (block.type === 'paragraph' && block.runs.some((r) => r.text.trim().length > 0)) {
      return true
    }
  }
  return false
}

function formatVersion(version: number): string {
  const major = (version >>> 24) & 0xff
  const minor = (version >>> 16) & 0xff
  const build = (version >>> 8) & 0xff
  const revision = version & 0xff
  return `${major}.${minor}.${build}.${revision}`
}

// MARK: - DocInfo 파싱 (글꼴 / 글자 모양 / 문단 모양 / 셀 배경색)

function parseDocInfoStream(raw: Buffer | null, compressed: boolean): HwpDocContext {
  const empty: HwpDocContext = {
    charShapes: [],
    paraShapes: [],
    borderFills: [undefined]
  }
  if (!raw || raw.length === 0) return empty

  const candidates = compressed ? [inflate(raw), raw] : [raw, inflate(raw)]
  for (const candidate of candidates) {
    if (!candidate || candidate.length === 0) continue
    const records = parseRecords(candidate)
    if (records.length === 0) continue

    const hangulFonts: string[] = []
    const allFonts: string[] = []
    let hangulFontLimit = Infinity

    const idMappings = records.find((r) => r.tag === 17)
    if (idMappings && idMappings.payload.length >= 8) {
      hangulFontLimit = idMappings.payload.readInt32LE(4)
    }

    for (const rec of records) {
      if (rec.tag === 19 && rec.payload.length >= 3) {
        // HWPTAG_FACE_NAME
        const nameLen = rec.payload.readUInt16LE(1)
        const end = Math.min(rec.payload.length, 3 + nameLen * 2)
        const name = rec.payload
          .subarray(3, end)
          .toString('utf16le')
          .replace(/\u0000/g, '')
          .trim()
        allFonts.push(name || '함초롬돋움')
        if (hangulFonts.length < hangulFontLimit) {
          hangulFonts.push(name || '함초롬돋움')
        }
      } else if (rec.tag === 20) {
        // HWPTAG_BORDER_FILL (1-based indexing in HWP)
        empty.borderFills.push(parseBorderFillBg(rec.payload))
      } else if (rec.tag === 21 && rec.payload.length >= 56) {
        // HWPTAG_CHAR_SHAPE
        const p = rec.payload
        const fontId = p.readUInt16LE(0)
        const heightHwp = p.readInt32LE(42)
        const attr = p.readUInt32LE(46)
        const colorRef = p.readUInt32LE(52)
        const shadeColorRef = p.length >= 64 ? p.readUInt32LE(60) : 0xffffffff

        const fontName =
          hangulFonts[fontId] ?? allFonts[fontId] ?? '함초롬돋움'
        const pt = Math.max(6, Math.min(120, heightHwp / 100))
        // 10pt(기본값)은 ~13.33px, 그 외 크기는 비율에 맞춰 px 변환
        const fontSize = Math.round(((pt * 4) / 3) * 100) / 100
        const bold = (attr & 0x01) !== 0
        const italic = (attr & 0x02) !== 0
        const underlineType = (attr >>> 2) & 0x03
        const strikeType = (attr >>> 18) & 0x07
        const colorHex = colorRefToHex(colorRef)
        const shadeHex =
          shadeColorRef !== 0xffffffff && shadeColorRef !== 0xffffff
            ? colorRefToHex(shadeColorRef)
            : undefined

        empty.charShapes.push({
          fontFamily: normalizeFontFamily(fontName),
          fontSize,
          bold,
          italic,
          underline: underlineType === 1 || underlineType === 3,
          strike: strikeType !== 0,
          color: colorHex !== '#000000' ? colorHex : undefined,
          highlight: shadeHex && shadeHex !== '#ffffff' ? shadeHex : undefined
        })
      } else if (rec.tag === 25 && rec.payload.length >= 8) {
        // HWPTAG_PARA_SHAPE
        const p = rec.payload
        const attr1 = p.readUInt32LE(0)
        const alignCode = (attr1 >>> 2) & 0x07
        const align: Align =
          alignCode === 1
            ? 'left'
            : alignCode === 2
              ? 'right'
              : alignCode === 3
                ? 'center'
                : 'justify'
        const leftMargin = p.readInt32LE(4)
        const indent =
          leftMargin > 1000
            ? Math.min(5, Math.max(1, Math.round(leftMargin / 4000)))
            : undefined
        const headingType = (attr1 >>> 23) & 0x03
        const headingLevel = ((attr1 >>> 25) & 0x07) + 1
        const heading =
          headingType === 1 && headingLevel >= 1 && headingLevel <= 4
            ? headingLevel
            : undefined

        empty.paraShapes.push({ align, indent, heading })
      }
    }

    if (empty.charShapes.length > 0 || empty.paraShapes.length > 0) {
      return empty
    }
  }

  return empty
}

function parseBorderFillBg(payload: Buffer): string | undefined {
  // 패턴 브러시(0x00000001) 뒤에 배경색 COLORREF(4바이트)가 위치한다.
  if (payload.length < 40) return undefined
  for (let offset = 26; offset + 8 <= payload.length; offset += 2) {
    const fillType = payload.readUInt32LE(offset)
    if (fillType === 1) {
      const bgRef = payload.readUInt32LE(offset + 4)
      if (bgRef === 0xffffffff || bgRef === 0x00ffffff) return undefined
      const hex = colorRefToHex(bgRef)
      return hex && hex !== '#ffffff' && hex !== '#000000' ? hex : undefined
    }
  }
  return undefined
}

function colorRefToHex(colorRef: number): string | undefined {
  const r = colorRef & 0xff
  const g = (colorRef >>> 8) & 0xff
  const b = (colorRef >>> 16) & 0xff
  return (
    '#' +
    [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
  )
}

function normalizeFontFamily(name: string): string {
  const cleaned = name.replace(/^[-\s]+/, '').trim()
  if (!cleaned) return '함초롬돋움'
  if (/명조|바탕/.test(cleaned)) return '함초롬바탕'
  if (/고딕|돋움|굴림|맑은/.test(cleaned)) return '함초롬돋움'
  return cleaned
}

// MARK: - Section 레코드 트리 파싱 (문단 · 서식 런 · 표 · 글상자)

function parseRecords(bytes: Buffer): HwpRecord[] {
  const records: HwpRecord[] = []
  let offset = 0
  while (offset + 4 <= bytes.length) {
    const header = bytes.readUInt32LE(offset)
    offset += 4
    const tag = header & 0x3ff
    const level = (header >>> 10) & 0x3ff
    let size = (header >>> 20) & 0xfff
    if (size === 0xfff) {
      if (offset + 4 > bytes.length) break
      size = bytes.readUInt32LE(offset)
      offset += 4
    }
    if (size < 0 || offset + size > bytes.length) break
    records.push({ tag, level, payload: bytes.subarray(offset, offset + size) })
    offset += size
  }
  return records
}

function parseSectionRecords(
  records: HwpRecord[],
  context: HwpDocContext
): { blocks: HwpxBlock[]; tables: number } {
  let tableCounter = 0

  const parseRange = (startIndex: number, endIndex: number, paraLevel: number): HwpxBlock[] => {
    const output: HwpxBlock[] = []
    let index = startIndex

    while (index < endIndex) {
      const rec = records[index]
      if (rec.tag === 66 && rec.level === paraLevel) {
        // 문단 범위 찾기: 다음 동일/상위 레벨의 PARA_HEADER 또는 LIST_HEADER 전까지
        let nextIndex = index + 1
        while (nextIndex < endIndex) {
          const r = records[nextIndex]
          if (r.level < paraLevel) break
          if (r.level === paraLevel && (r.tag === 66 || r.tag === 72)) break
          nextIndex += 1
        }
        output.push(...parseSingleParagraph(index, nextIndex, paraLevel))
        index = nextIndex
      } else {
        index += 1
      }
    }

    return output
  }

  const parseSingleParagraph = (
    pStart: number,
    pEnd: number,
    paraLevel: number
  ): HwpxBlock[] => {
    const headerPayload = records[pStart].payload
    const paraShapeId =
      headerPayload.length >= 10 ? headerPayload.readUInt16LE(8) : 0
    const breakType = headerPayload.length >= 12 ? headerPayload[11] : 0
    const pageBreak = (breakType & 0x04) !== 0
    const paraShape = context.paraShapes[paraShapeId]

    let textPayload: Buffer | null = null
    const charShapePairs: Array<{ pos: number; shapeId: number }> = []
    const childBlocks: HwpxBlock[] = []

    let i = pStart + 1
    while (i < pEnd) {
      const rec = records[i]
      if (rec.level === paraLevel + 1 && rec.tag === 67) {
        textPayload = rec.payload
        i += 1
      } else if (rec.level === paraLevel + 1 && rec.tag === 68) {
        for (let off = 0; off + 8 <= rec.payload.length; off += 8) {
          charShapePairs.push({
            pos: rec.payload.readUInt32LE(off),
            shapeId: rec.payload.readUInt32LE(off + 4)
          })
        }
        i += 1
      } else if (rec.level === paraLevel + 1 && rec.tag === 71) {
        // HWPTAG_CTRL_HEADER
        const ctrlId =
          rec.payload.length >= 4
            ? rec.payload.subarray(0, 4).toString('ascii').split('').reverse().join('')
            : ''
        let ctrlEnd = i + 1
        while (ctrlEnd < pEnd && records[ctrlEnd].level > rec.level) {
          ctrlEnd += 1
        }

        if (ctrlId === 'tbl ') {
          const table = parseTableControl(i + 1, ctrlEnd, rec.level + 1)
          if (table) {
            tableCounter += 1
            childBlocks.push(table)
          }
        } else if (ctrlId === 'gso ') {
          // 글상자(개체) 내부 텍스트 추출
          const gsoBlocks = extractGsoBlocks(i + 1, ctrlEnd, rec.level + 1)
          childBlocks.push(...gsoBlocks)
        }
        i = ctrlEnd
      } else {
        i += 1
      }
    }

    const runs = textPayload
      ? decodeStyledRuns(textPayload, charShapePairs, context)
      : []

    const result: HwpxBlock[] = []
    const hasRuns = runs.some((r) => r.text.length > 0)

    if (hasRuns || childBlocks.length === 0 || pageBreak) {
      const paragraph: HwpxParagraph = {
        type: 'paragraph',
        runs,
        align: paraShape?.align,
        indent: paraShape?.indent,
        heading: paraShape?.heading,
        pageBreak: pageBreak ? true : undefined
      }
      result.push(paragraph)
    }

    result.push(...childBlocks)
    return result
  }

  const parseTableControl = (
    cStart: number,
    cEnd: number,
    tableLevel: number
  ): HwpxTable | null => {
    let rowCount = 0
    let colCount = 0
    let idx = cStart

    while (idx < cEnd) {
      const r = records[idx]
      if (r.level === tableLevel && r.tag === 77 && r.payload.length >= 8) {
        rowCount = r.payload.readUInt16LE(4)
        colCount = r.payload.readUInt16LE(6)
        idx += 1
        break
      }
      idx += 1
    }
    if (rowCount <= 0 || colCount <= 0) return null

    // LIST_HEADER(tag=72, level=tableLevel)가 각 셀의 시작이다.
    interface ParsedCell {
      col: number
      row: number
      colspan: number
      rowspan: number
      background?: string
      blocks: HwpxBlock[]
    }
    const cells: ParsedCell[] = []

    while (idx < cEnd) {
      const r = records[idx]
      if (r.level === tableLevel && r.tag === 72 && r.payload.length >= 16) {
        let cellEnd = idx + 1
        while (cellEnd < cEnd) {
          const next = records[cellEnd]
          if (next.level < tableLevel) break
          if (next.level === tableLevel && next.tag === 72) break
          cellEnd += 1
        }

        const p = r.payload
        // HWP 5.0 셀 LIST_HEADER:
        // offset 8: colAddr (UINT16), offset 10: rowAddr (UINT16),
        // offset 12: colSpan (UINT16), offset 14: rowSpan (UINT16)
        const col = p.readUInt16LE(8)
        const row = p.readUInt16LE(10)
        const colspan = Math.max(1, p.readUInt16LE(12))
        const rowspan = Math.max(1, p.readUInt16LE(14))
        // borderFillId는 offset 32 (또는 30)에 위치
        let background: string | undefined
        if (p.length >= 34) {
          const bfId = p.readUInt16LE(32)
          background = context.borderFills[bfId]
        }

        // 셀 내부 문단의 레벨은 idx+1 레코드(PARA_HEADER)의 레벨을 따른다.
        let cellParaLevel = tableLevel
        for (let k = idx + 1; k < cellEnd; k += 1) {
          if (records[k].tag === 66) {
            cellParaLevel = records[k].level
            break
          }
        }

        const cellBlocks = parseRange(idx + 1, cellEnd, cellParaLevel)
        cells.push({
          col,
          row,
          colspan,
          rowspan,
          background,
          blocks:
            cellBlocks.length > 0 ? cellBlocks : [{ type: 'paragraph', runs: [] }]
        })
        idx = cellEnd
      } else {
        idx += 1
      }
    }

    if (cells.length === 0) return null

    // 행(row) 별로 정렬해 HwpxTable을 구성한다.
    const byRow = new Map<number, ParsedCell[]>()
    for (const cell of cells) {
      const list = byRow.get(cell.row) ?? []
      list.push(cell)
      byRow.set(cell.row, list)
    }

    const sortedRowIndices = [...byRow.keys()].sort((a, b) => a - b)
    const rows: HwpxTableCell[][] = sortedRowIndices.map((rIdx) => {
      const rowCells = (byRow.get(rIdx) ?? []).sort((a, b) => a.col - b.col)
      return rowCells.map((c) => {
        const firstPara = c.blocks.find(
          (b): b is HwpxParagraph => b.type === 'paragraph' && !!b.align
        )
        return {
          blocks: c.blocks,
          colspan: c.colspan > 1 ? c.colspan : undefined,
          rowspan: c.rowspan > 1 ? c.rowspan : undefined,
          background: c.background,
          align: firstPara?.align
        }
      })
    })

    return { type: 'table', rows, border: true }
  }

  const extractGsoBlocks = (
    gStart: number,
    gEnd: number,
    gLevel: number
  ): HwpxBlock[] => {
    const out: HwpxBlock[] = []
    let idx = gStart
    while (idx < gEnd) {
      const r = records[idx]
      if (r.tag === 72) {
        let subEnd = idx + 1
        while (subEnd < gEnd && records[subEnd].level > r.level) {
          subEnd += 1
        }
        let paraLevel = r.level + 1
        for (let k = idx + 1; k < subEnd; k += 1) {
          if (records[k].tag === 66) {
            paraLevel = records[k].level
            break
          }
        }
        out.push(...parseRange(idx + 1, subEnd, paraLevel))
        idx = subEnd
      } else {
        idx += 1
      }
    }
    return out
  }

  const blocks = parseRange(0, records.length, 0)
  return { blocks, tables: tableCounter }
}

/**
 * HWPTAG_PARA_TEXT(67)와 HWPTAG_PARA_CHAR_SHAPE(68)를 결합해
 * 글자 모양(굵게/기울임/밑줄/취소선/색상/형광펜/글꼴/크기)이 적용된 HwpxRun[]을 생성한다.
 */
function decodeStyledRuns(
  payload: Buffer,
  charShapePairs: Array<{ pos: number; shapeId: number }>,
  context: HwpDocContext
): HwpxRun[] {
  const units: number[] = []
  for (let index = 0; index + 1 < payload.length; index += 2) {
    units.push(payload.readUInt16LE(index))
  }

  const sortedPairs = [...charShapePairs].sort((a, b) => a.pos - b.pos)
  const shapeAt = (charIndex: number): HwpCharShape | undefined => {
    let shapeId = sortedPairs[0]?.shapeId ?? 0
    for (const pair of sortedPairs) {
      if (pair.pos <= charIndex) shapeId = pair.shapeId
      else break
    }
    return context.charShapes[shapeId]
  }

  const runs: HwpxRun[] = []
  let index = 0

  const appendChar = (char: string, shape: HwpCharShape | undefined): void => {
    if (!char) return
    const run: HwpxRun = {
      text: char,
      bold: shape?.bold || undefined,
      italic: shape?.italic || undefined,
      underline: shape?.underline || undefined,
      strike: shape?.strike || undefined,
      color: shape?.color,
      highlight: shape?.highlight,
      fontFamily: shape?.fontFamily,
      fontSize:
        shape?.fontSize && Math.abs(shape.fontSize - 13.33) > 0.5
          ? shape.fontSize
          : undefined
    }
    const prev = runs[runs.length - 1]
    if (prev && sameRunStyle(prev, run)) {
      prev.text += char
    } else {
      runs.push(run)
    }
  }

  while (index < units.length) {
    const unit = units[index]
    const shape = shapeAt(index)

    if (unit === 0x000d || unit === 0x0000) {
      index += 1
    } else if (unit === 0x000a || unit === 0x0018 || unit === 0x001e || unit === 0x001f) {
      appendChar(unit === 0x000a ? '\n' : ' ', shape)
      index += 1
    } else if (unit === 0x0009) {
      appendChar('\t', shape)
      if (index + 7 < units.length && units[index + 7] === 0x0009) {
        index += 8
      } else {
        index += 1
      }
    } else if (unit >= 0x0001 && unit <= 0x001f) {
      // 인라인/확장 컨트롤은 8 WCHAR(16바이트)를 차지한다.
      index += 8
    } else {
      appendChar(String.fromCharCode(unit), shape)
      index += 1
    }
  }

  // 문단 끝 공백 정리
  if (runs.length > 0) {
    const last = runs[runs.length - 1]
    last.text = last.text.replace(/[\n\r\t ]+$/g, '')
    if (!last.text) runs.pop()
  }

  return runs
}

function sameRunStyle(a: HwpxRun, b: HwpxRun): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    (a.color ?? '') === (b.color ?? '') &&
    (a.highlight ?? '') === (b.highlight ?? '') &&
    (a.fontFamily ?? '') === (b.fontFamily ?? '') &&
    (a.fontSize ?? 0) === (b.fontSize ?? 0)
  )
}

/** PrvText(미리보기)는 BOM 없는 UTF-16LE 평문이다. */
function decodePreview(bytes: Buffer): string {
  let start = 0
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) start = 2
  return bytes
    .subarray(start)
    .toString('utf16le')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
}

// MARK: - HWP 3.0 (구형 V3.00 바이너리) 파서

function parseHwp30(buffer: Buffer): HwpParseResult {
  if (buffer.length < 158) {
    throw new HwpError('corrupt', 'HWP 3.0 파일 크기가 너무 작습니다.')
  }
  const encrypted = buffer.readUInt16LE(30 + 96) !== 0
  if (encrypted) {
    throw new HwpError('encrypted', '암호가 설정된 HWP 3.0 파일은 열 수 없습니다.')
  }
  const compressed = buffer[30 + 124] !== 0
  const infoBlockLen = buffer.readUInt16LE(30 + 126)

  // 문서 요약(1008바이트) + 정보 블록 건너뛰기
  const bodyOffset = 30 + 128 + 1008 + infoBlockLen
  if (bodyOffset >= buffer.length) {
    throw new HwpError('corrupt', 'HWP 3.0 본문 오프셋이 올바르지 않습니다.')
  }

  const rawBody = buffer.subarray(bodyOffset)
  const body = compressed ? inflate(rawBody) ?? rawBody : rawBody

  // HWP 3.0은 2바이트 조합형/완성형/유니코드가 혼재하므로 읽을 수 있는 텍스트 라인을 추출한다.
  let text = ''
  try {
    text = new TextDecoder('euc-kr', { fatal: false }).decode(body)
  } catch {
    text = body.toString('utf8')
  }
  const cleanedLines = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]+/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const finalText = cleanedLines.join('\n').trim()
  if (!finalText) {
    throw new HwpError('no-text', 'HWP 3.0 문서에서 텍스트를 추출하지 못했습니다.')
  }

  const blocks: HwpxBlock[] = cleanedLines.map((line) => ({
    type: 'paragraph',
    runs: [{ text: line }]
  }))

  return {
    text: finalText,
    blocks,
    version: '3.0.0.0',
    compressed,
    encrypted: false,
    sections: 1,
    tables: 0,
    usedPreview: false
  }
}

// MARK: - 압축 해제

function inflate(input: Buffer): Buffer | null {
  const attempts: Array<() => Buffer> = [
    () => inflateRawSync(input),
    () => inflateRawSync(input, { finishFlush: zlibConstants.Z_SYNC_FLUSH }),
    () => inflateSync(input)
  ]
  for (const attempt of attempts) {
    try {
      const result = attempt()
      if (result.length > 0) return result
    } catch {
      // 다음 후보를 시도한다.
    }
  }

  if (input.length > 6 && (input[0] & 0x0f) === 8 && (input[1] & 0x20) === 0) {
    try {
      const result = inflateRawSync(input.subarray(2, input.length - 4))
      if (result.length > 0) return result
    } catch {
      // 무시
    }
  }
  return null
}
