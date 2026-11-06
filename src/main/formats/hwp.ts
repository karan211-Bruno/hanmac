import { inflateRawSync, inflateSync, constants as zlibConstants } from 'node:zlib'

// HWP 5.0(구형 바이너리, OLE 복합 파일) 문서 읽기.
// 공개된 「한글 문서 파일 형식 5.0」 규격을 참고해 직접 구현했다.
// 서식·표·그림은 복원하지 않고 본문 텍스트만 추출한다.

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
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
  version: string
  compressed: boolean
  encrypted: boolean
  sections: number
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
    for (let extra = 0; extra < difatSectorCount && difatSector < MAX_REGULAR_SECTOR; extra += 1) {
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

  // Section0, Section1, … 순서대로 이어 붙인다.
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

  let text = ''
  for (const number of sectionNumbers) {
    const entries = byNumber.get(number) ?? []
    let sectionText = ''
    for (const entry of entries) {
      const raw = file.streamOf(entry)
      if (raw.length === 0) continue
      // 압축 플래그가 잘못된 파일도 열 수 있도록 양쪽을 순서대로 시도한다.
      const candidates = compressed ? [inflate(raw), raw] : [raw, inflate(raw)]
      for (const candidate of candidates) {
        if (!candidate || candidate.length === 0) continue
        const candidateText = extractText(parseRecords(candidate))
        if (candidateText.trim().length > 0) {
          sectionText = candidateText
          break
        }
      }
      if (sectionText) break
    }
    if (sectionText) {
      if (text) text += '\n'
      text += sectionText
    }
  }

  // 본문이 없으면 미리보기 텍스트(PrvText)로 대체한다.
  let usedPreview = false
  if (text.trim().length === 0) {
    const preview = file.stream('PrvText')
    if (preview && preview.length > 0) {
      text = decodePreview(preview)
      usedPreview = true
    }
  }

  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim()

  if (!text) {
    throw new HwpError('no-text', '문서에서 본문 텍스트를 찾지 못했습니다.')
  }

  return {
    text,
    version: formatVersion(version),
    compressed,
    encrypted: false,
    sections: sectionNumbers.length,
    usedPreview
  }
}

function formatVersion(version: number): string {
  const major = (version >>> 24) & 0xff
  const minor = (version >>> 16) & 0xff
  const build = (version >>> 8) & 0xff
  const revision = version & 0xff
  return `${major}.${minor}.${build}.${revision}`
}

// MARK: - 레코드

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

/**
 * HWPTAG_PARA_HEADER(0x42)로 문단을 구분하고
 * HWPTAG_PARA_TEXT(0x43)의 UTF-16LE 본문을 뽑는다.
 */
function extractText(records: HwpRecord[]): string {
  const paragraphs: string[] = []
  let current = ''
  let seenParagraph = false

  for (const record of records) {
    if (record.tag === 0x42) {
      if (seenParagraph) paragraphs.push(current)
      current = ''
      seenParagraph = true
    } else if (record.tag === 0x43) {
      current += decodeParagraphText(record.payload)
    }
  }
  if (seenParagraph) paragraphs.push(current)

  const cleaned = paragraphs.map((paragraph) => paragraph.replace(/[\n\r\t ]+$/g, ''))
  let start = 0
  let end = cleaned.length
  while (start < end && cleaned[start].length === 0) start += 1
  while (end > start && cleaned[end - 1].length === 0) end -= 1
  if (start >= end) return ''
  return cleaned.slice(start, end).join('\n')
}

/**
 * 문단 텍스트 안의 제어 문자를 처리한다.
 * 0x00/0x0D는 한 글자, 0x09(탭)·확장/인라인 컨트롤은 8글자를 차지한다.
 */
function decodeParagraphText(payload: Buffer): string {
  const units: number[] = []
  for (let index = 0; index + 1 < payload.length; index += 2) {
    units.push(payload.readUInt16LE(index))
  }

  const output: number[] = []
  let index = 0
  while (index < units.length) {
    const unit = units[index]
    if (unit === 0x000d) {
      index += 1
    } else if (unit === 0x000a) {
      output.push(0x000a)
      index += 1
    } else if (unit === 0x0009) {
      output.push(0x0009)
      if (index + 7 < units.length && units[index + 7] === 0x0009) {
        index += 8
      } else {
        index += 1
      }
    } else if (unit === 0x0000) {
      index += 1
    } else if (unit >= 0x0001 && unit <= 0x001f) {
      // 인라인/확장 컨트롤은 8글자를 차지한다.
      index += 8
    } else {
      output.push(unit)
      index += 1
    }
  }

  const result = Buffer.allocUnsafe(output.length * 2)
  for (let i = 0; i < output.length; i += 1) {
    result.writeUInt16LE(output[i], i * 2)
  }
  return result.toString('utf16le')
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

// MARK: - 압축 해제

function inflate(input: Buffer): Buffer | null {
  // HWP 5.0은 zlib 헤더가 없는 raw deflate를 사용한다.
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

  // 일부 파일은 zlib 헤더/트레일러를 포함한다.
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
