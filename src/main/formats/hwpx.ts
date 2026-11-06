import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import type {
  Align,
  HwpxBlock,
  HwpxParagraph,
  HwpxRun,
  HwpxTable,
  HwpxTableCell
} from '../../shared/types'

// HWPX(OWPML, KS X 6101 공개 표준) 읽기/쓰기.
// ZIP 컨테이너와 XML 본문 구조를 직접 다룬다.

export class HwpxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HwpxError'
  }
}

export interface HwpxParseResult {
  title: string
  blocks: HwpxBlock[]
  sections: number
}

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

interface HeaderContext {
  charStyles: Map<string, RunStyle>
  paraStyles: Map<string, ParaStyle>
  borderFills: Map<string, string | undefined>
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

// MARK: - 읽기

export async function parseHwpx(buffer: Uint8Array | ArrayBuffer): Promise<HwpxParseResult> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw new HwpxError('HWPX 패키지를 열 수 없습니다.')
  }

  const sectionNames = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => sectionNumber(a) - sectionNumber(b))

  if (sectionNames.length === 0) {
    throw new HwpxError('문서 본문(section XML)을 찾을 수 없습니다.')
  }

  const headerFile = zip.file('Contents/header.xml')
  const context = headerFile
    ? parseHeader(await headerFile.async('string'))
    : defaultContext()

  const blocks: HwpxBlock[] = []
  for (const name of sectionNames) {
    const file = zip.file(name)
    if (!file) continue
    const xml = await file.async('string')
    const parsed = xmlParser.parse(xml)
    const section = toArray(parsed.sec)[0] ?? parsed
    blocks.push(...parseSection(section, context))
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph', runs: [] })
  }

  return {
    title: await readTitle(zip),
    blocks,
    sections: sectionNames.length
  }
}

function sectionNumber(name: string): number {
  const match = name.match(/section(\d+)\.xml$/i)
  return match ? Number(match[1]) : 0
}

async function readTitle(zip: JSZip): Promise<string> {
  const file = zip.file('Contents/content.hpf')
  if (!file) return '한맥 문서'
  try {
    const parsed = xmlParser.parse(await file.async('string'))
    const pkg = toArray(parsed.package)[0] ?? parsed
    const title = textOf(pkg?.metadata?.title).trim()
    return title || '한맥 문서'
  } catch {
    return '한맥 문서'
  }
}

function defaultContext(): HeaderContext {
  return {
    charStyles: new Map([['0', { ...DEFAULT_RUN_STYLE }]]),
    paraStyles: new Map([['0', { ...DEFAULT_PARA_STYLE }]]),
    borderFills: new Map([['0', undefined]])
  }
}

function parseHeader(xml: string): HeaderContext {
  const context = defaultContext()
  try {
    const parsed = xmlParser.parse(xml)
    const head = toArray(parsed.head)[0] ?? parsed
    const refList = head?.refList

    const fonts = new Map<string, string>()
    for (const face of toArray(refList?.fontfaces?.fontface)) {
      const lang = String(face?.['@_lang'] ?? '')
      for (const font of toArray(face?.font)) {
        const id = String(font?.['@_id'] ?? '')
        const name = String(font?.['@_face'] ?? '')
        if (!id || !name) continue
        if (!fonts.has(id) || lang === 'HANGUL') fonts.set(id, name)
      }
    }

    for (const charPr of toArray(refList?.charProperties?.charPr)) {
      const id = String(charPr?.['@_id'] ?? '')
      if (!id) continue
      const fontRef = toArray(charPr?.fontRef)[0] ?? {}
      const fontId = String(fontRef?.['@_hangul'] ?? fontRef?.['@_latin'] ?? '0')
      const height = Number(charPr?.['@_height'] ?? 1000)
      const shade = String(charPr?.['@_shadeColor'] ?? 'none')
      context.charStyles.set(id, {
        bold: hasKey(charPr, 'bold'),
        italic: hasKey(charPr, 'italic'),
        underline: hasKey(charPr, 'underline'),
        strike: hasKey(charPr, 'strikeout') || hasKey(charPr, 'strike'),
        color: normalizeHex(String(charPr?.['@_textColor'] ?? '#000000')) ?? '#000000',
        highlight: shade !== 'none' ? normalizeHex(shade) : undefined,
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
      context.paraStyles.set(id, {
        align,
        heading: headingType === 'OUTLINE' && level > 0 ? Math.min(6, level) : 0,
        indent: Math.min(5, Math.max(0, Math.round(left / 2000))),
        quote: false
      })
    }

    for (const borderFill of toArray(refList?.borderFills?.borderFill)) {
      const id = String(borderFill?.['@_id'] ?? '')
      if (!id) continue
      const winBrush = toArray(borderFill?.fillBrush?.winBrush)[0]
      const face = winBrush?.['@_faceColor']
      context.borderFills.set(
        id,
        face && String(face) !== 'none' ? normalizeHex(String(face)) : undefined
      )
    }
  } catch {
    // 헤더를 읽지 못하면 기본 스타일로 진행한다.
  }
  return context
}

function parseSection(section: any, context: HeaderContext): HwpxBlock[] {
  const blocks: HwpxBlock[] = []
  for (const paragraphNode of toArray(section?.p)) {
    const tables = collectTables(paragraphNode)
    const paragraph = parseParagraph(paragraphNode, context)
    if (paragraph.runs.some((run) => run.text.length > 0) || tables.length === 0) {
      blocks.push(paragraph)
    }
    for (const table of tables) {
      blocks.push(parseTable(table, context))
    }
  }
  return blocks
}

function parseParagraph(node: any, context: HeaderContext): HwpxParagraph {
  const paraStyle =
    context.paraStyles.get(String(node?.['@_paraPrIDRef'] ?? '')) ?? DEFAULT_PARA_STYLE
  const runs: HwpxRun[] = []
  const runNodes = toArray(node?.run)
  if (runNodes.length > 0) {
    for (const run of runNodes) {
      const style =
        context.charStyles.get(String(run?.['@_charPrIDRef'] ?? '')) ?? DEFAULT_RUN_STYLE
      walkRun(run, style, runs, context)
    }
  } else {
    walkRun(node, DEFAULT_RUN_STYLE, runs, context)
  }

  return {
    type: 'paragraph',
    runs: mergeRuns(runs),
    align: paraStyle.align,
    heading: paraStyle.heading > 0 ? paraStyle.heading : undefined,
    indent: paraStyle.indent > 0 ? paraStyle.indent : undefined,
    pageBreak: String(node?.['@_pageBreak'] ?? '0') === '1' ? true : undefined
  }
}

function walkRun(
  node: any,
  style: RunStyle,
  output: HwpxRun[],
  context: HeaderContext
): void {
  if (node == null) return
  if (Array.isArray(node)) {
    for (const item of node) walkRun(item, style, output, context)
    return
  }
  if (typeof node !== 'object') return

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || key === '#text') continue
    if (key === 't') {
      const text = textOf(value)
      if (text) pushRun(output, style, text)
    } else if (key === 'br' || key === 'lineBreak') {
      pushRun(output, style, '\n')
    } else if (key === 'tab') {
      pushRun(output, style, '\t')
    } else if (key === 'tbl') {
      // 표는 문단과 별도 블록으로 처리한다.
      continue
    } else if (key === 'run') {
      for (const nested of toArray(value)) {
        const nestedStyle =
          context.charStyles.get(
            String((nested as Record<string, unknown> | null)?.['@_charPrIDRef'] ?? '')
          ) ?? style
        walkRun(nested, nestedStyle, output, context)
      }
    } else {
      walkRun(value, style, output, context)
    }
  }
}

function collectTables(node: any): any[] {
  const tables: any[] = []
  const visit = (value: any): void => {
    if (value == null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'tbl') {
        tables.push(child)
        continue
      }
      if (key.startsWith('@_') || key === 't' || key === '#text') continue
      visit(child)
    }
  }
  visit(node)
  return tables
}

function parseTable(table: any, context: HeaderContext): HwpxTable {
  const rows = toArray(table?.tr).map((row: any) =>
    toArray(row?.tc).map((cell: any) => parseCell(cell, context))
  )
  return { type: 'table', rows, border: true }
}

function parseCell(cell: any, context: HeaderContext): HwpxTableCell {
  const blocks = parseSubList(cell?.subList, context)
  const cellSpan = toArray(cell?.cellSpan)[0] ?? {}
  const background = context.borderFills.get(String(cell?.['@_borderFillIDRef'] ?? ''))
  const firstAligned = blocks.find(
    (block): block is HwpxParagraph => block.type === 'paragraph' && !!block.align
  )

  return {
    blocks: blocks.length > 0 ? blocks : [{ type: 'paragraph', runs: [] }],
    colspan: Math.max(1, Number(cellSpan?.['@_colSpan'] ?? cellSpan?.['@_colspan'] ?? 1) || 1),
    rowspan: Math.max(1, Number(cellSpan?.['@_rowSpan'] ?? cellSpan?.['@_rowspan'] ?? 1) || 1),
    background,
    align: firstAligned?.align
  }
}

function parseSubList(subList: any, context: HeaderContext): HwpxBlock[] {
  const blocks: HwpxBlock[] = []
  for (const paragraphNode of toArray(subList?.p)) {
    const tables = collectTables(paragraphNode)
    const paragraph = parseParagraph(paragraphNode, context)
    if (paragraph.runs.some((run) => run.text.length > 0) || tables.length === 0) {
      blocks.push(paragraph)
    }
    for (const table of tables) {
      blocks.push(parseTable(table, context))
    }
  }
  return blocks
}

function pushRun(output: HwpxRun[], style: RunStyle, text: string): void {
  if (!text) return
  output.push({ ...style, text })
}

function mergeRuns(runs: HwpxRun[]): HwpxRun[] {
  const merged: HwpxRun[] = []
  for (const run of runs) {
    if (!run.text) continue
    const previous = merged[merged.length - 1]
    if (previous && runStyleKey(previous) === runStyleKey(run)) {
      previous.text += run.text
    } else {
      merged.push({ ...run })
    }
  }
  return merged
}

function runStyleKey(run: HwpxRun): string {
  return [
    run.bold ? 1 : 0,
    run.italic ? 1 : 0,
    run.underline ? 1 : 0,
    run.strike ? 1 : 0,
    run.color ?? '',
    run.highlight ?? '',
    run.fontFamily ?? '',
    run.fontSize ?? 0,
    run.code ? 1 : 0,
    run.link ?? ''
  ].join('|')
}

// MARK: - 쓰기

interface CharStyle {
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

interface BorderFill {
  id: number
  background?: string
  tableBorder: boolean
}

const DEFAULT_WRITE_CHAR: CharStyle = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: '#000000',
  fontFamily: '함초롬돋움',
  fontSize: 13.33,
  code: false
}

const DEFAULT_WRITE_PARA: ParaStyle = {
  align: 'justify',
  heading: 0,
  indent: 0,
  quote: false
}

class StyleRegistry {
  readonly fonts: string[] = ['함초롬돋움']
  readonly charStyles: Array<{ id: number; style: CharStyle }> = []
  readonly paraStyles: Array<{ id: number; style: ParaStyle }> = []
  readonly borderFills: BorderFill[] = []

  private readonly charKeys = new Map<string, number>()
  private readonly paraKeys = new Map<string, number>()
  private readonly borderKeys = new Map<string, number>()

  constructor() {
    this.charId({ ...DEFAULT_WRITE_CHAR })
    this.paraId({ ...DEFAULT_WRITE_PARA })
    this.addBorderFill(undefined, false)
    this.addBorderFill(undefined, true)
  }

  fontId(name: string): number {
    const normalized = name.trim() || '함초롬돋움'
    const existing = this.fonts.indexOf(normalized)
    if (existing >= 0) return existing
    this.fonts.push(normalized)
    return this.fonts.length - 1
  }

  charId(style: CharStyle): number {
    // header.xml의 fontfaces를 만들기 전에 사용된 글꼴을 모두 등록한다.
    this.fontId(style.fontFamily)
    const key = [
      style.bold ? 1 : 0,
      style.italic ? 1 : 0,
      style.underline ? 1 : 0,
      style.strike ? 1 : 0,
      style.color,
      style.highlight ?? '',
      style.fontFamily,
      style.fontSize,
      style.code ? 1 : 0
    ].join('|')
    const existing = this.charKeys.get(key)
    if (existing !== undefined) return existing
    const id = this.charStyles.length
    this.charKeys.set(key, id)
    this.charStyles.push({ id, style: { ...style } })
    return id
  }

  paraId(style: ParaStyle): number {
    const key = [style.align, style.heading, style.indent, style.quote ? 1 : 0].join('|')
    const existing = this.paraKeys.get(key)
    if (existing !== undefined) return existing
    const id = this.paraStyles.length
    this.paraKeys.set(key, id)
    this.paraStyles.push({ id, style: { ...style } })
    return id
  }

  borderId(background?: string): number {
    const normalized = background ? normalizeHex(background) : undefined
    if (!normalized) return 1
    const existing = this.borderKeys.get(normalized)
    if (existing !== undefined) return existing
    const id = this.addBorderFill(normalized, true)
    this.borderKeys.set(normalized, id)
    return id
  }

  private addBorderFill(background: string | undefined, tableBorder: boolean): number {
    const id = this.borderFills.length
    this.borderFills.push({ id, background, tableBorder })
    return id
  }
}

export async function buildHwpx(blocks: HwpxBlock[], title = '한맥 문서'): Promise<Buffer> {
  const safeBlocks: HwpxBlock[] =
    blocks.length > 0 ? blocks : [{ type: 'paragraph', runs: [] }]
  const registry = new StyleRegistry()
  collectStyles(safeBlocks, registry)

  const zip = new JSZip()
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' })
  zip.file('version.xml', versionXml())
  zip.file('META-INF/container.xml', containerXml())
  zip.file('META-INF/manifest.xml', manifestXml())
  zip.file('Contents/content.hpf', contentHpf(title))
  zip.file('Contents/header.xml', buildHeaderXml(registry))
  zip.file('Contents/section0.xml', buildSectionXml(safeBlocks, registry))

  const result = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    mimeType: 'application/hwp+zip'
  })
  return typeof Buffer !== 'undefined' ? Buffer.from(result) : (result as unknown as Buffer)
}

function collectStyles(blocks: HwpxBlock[], registry: StyleRegistry): void {
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      registry.paraId({
        align: block.align ?? 'justify',
        heading: block.heading ?? 0,
        indent: block.indent ?? 0,
        quote: !!block.quote
      })
      for (const run of block.runs) {
        registry.charId(runToCharStyle(run, block.heading))
      }
    } else if (block.type === 'table') {
      for (const row of block.rows) {
        for (const cell of row) {
          registry.borderId(cell.background)
          collectStyles(cell.blocks, registry)
        }
      }
    }
  }
}

function headingSize(level: number): number {
  switch (level) {
    case 1:
      return 26
    case 2:
      return 22
    case 3:
      return 19
    case 4:
      return 17
    case 5:
      return 15
    case 6:
      return 14
    default:
      return 13.33
  }
}

function runToCharStyle(run: HwpxRun, heading?: number): CharStyle {
  const level = heading && heading >= 1 && heading <= 6 ? heading : 0
  return {
    bold: !!run.bold || level > 0,
    italic: !!run.italic,
    underline: !!run.underline,
    strike: !!run.strike,
    color: normalizeHex(run.color) ?? '#000000',
    highlight: run.highlight ? normalizeHex(run.highlight) : undefined,
    fontFamily: run.fontFamily?.trim() || (run.code ? 'Menlo' : '함초롬돋움'),
    fontSize:
      run.fontSize && run.fontSize > 0
        ? run.fontSize
        : level > 0
          ? headingSize(level)
          : 13.33,
    code: !!run.code
  }
}

function buildSectionXml(blocks: HwpxBlock[], registry: StyleRegistry): string {
  const ids = { value: 0 }
  const body: string[] = []

  for (const block of blocks) {
    if (block.type === 'paragraph') {
      body.push(buildParagraph(block, registry, ids))
    } else if (block.type === 'rule') {
      body.push(
        buildParagraph(
          {
            type: 'paragraph',
            runs: [{ text: '────────────────' }],
            align: 'center'
          },
          registry,
          ids
        )
      )
    } else {
      body.push(buildTableParagraph(block, registry, ids))
    }
  }

  if (body.length === 0) {
    body.push(buildParagraph({ type: 'paragraph', runs: [] }, registry, ids))
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">
${body.join('\n')}
</hs:sec>`
}

function buildParagraph(
  paragraph: HwpxParagraph,
  registry: StyleRegistry,
  ids: { value: number }
): string {
  const paraId = registry.paraId({
    align: paragraph.align ?? 'justify',
    heading: paragraph.heading ?? 0,
    indent: paragraph.indent ?? 0,
    quote: !!paragraph.quote
  })
  const runs =
    paragraph.runs.length > 0
      ? effectiveRuns(paragraph)
          .map((run) => buildRun(run, paragraph.heading, registry))
          .join('')
      : '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>'
  const pageBreak = paragraph.pageBreak ? '1' : '0'
  return `<hp:p id="${ids.value++}" paraPrIDRef="${paraId}" styleIDRef="0" pageBreak="${pageBreak}" columnBreak="0" merged="0">${runs}</hp:p>`
}

function effectiveRuns(paragraph: HwpxParagraph): HwpxRun[] {
  if (!paragraph.list || paragraph.runs.length === 0) return paragraph.runs
  if (!paragraph.runs.some((run) => run.text.length > 0)) return paragraph.runs

  const marker =
    paragraph.list.kind === 'ordered'
      ? `${paragraph.list.index ?? 1}. `
      : ['• ', '◦ ', '▪ '][paragraph.list.level % 3]

  return [{ ...paragraph.runs[0], text: marker }, ...paragraph.runs]
}

function buildRun(run: HwpxRun, heading: number | undefined, registry: StyleRegistry): string {
  const charId = registry.charId(runToCharStyle(run, heading))
  const parts = run.text.split(/(\n|\t)/)
  const content = parts
    .map((part) => {
      if (part === '\n') return '<hp:br/>'
      if (part === '\t') return '<hp:tab/>'
      if (!part) return ''
      const preserve = /^\s|\s$/.test(part) ? ' xml:space="preserve"' : ''
      return `<hp:t${preserve}>${escapeXml(part)}</hp:t>`
    })
    .join('')
  return `<hp:run charPrIDRef="${charId}">${content || '<hp:t></hp:t>'}</hp:run>`
}

function buildTableParagraph(
  table: HwpxTable,
  registry: StyleRegistry,
  ids: { value: number }
): string {
  const paraId = registry.paraId({ ...DEFAULT_WRITE_PARA })
  const charId = registry.charId({ ...DEFAULT_WRITE_CHAR })
  return `<hp:p id="${ids.value++}" paraPrIDRef="${paraId}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${charId}">${buildTableXml(table, registry, ids)}</hp:run></hp:p>`
}

function buildTableXml(
  table: HwpxTable,
  registry: StyleRegistry,
  ids: { value: number }
): string {
  const rows: HwpxTableCell[][] =
    table.rows.length > 0
      ? table.rows
      : [[{ blocks: [{ type: 'paragraph', runs: [] }] }]]
  const rowCount = rows.length
  const colCount = Math.max(
    1,
    ...rows.map((row) =>
      row.reduce((sum, cell) => sum + Math.max(1, cell.colspan ?? 1), 0)
    )
  )
  const width = 48000
  const colWidth = Math.floor(width / colCount)
  const rowHeight = 2200

  const trs = rows
    .map((row, rowIndex) => {
      let column = 0
      const tcs = row
        .map((cell) => {
          const colspan = Math.max(1, cell.colspan ?? 1)
          const rowspan = Math.max(1, cell.rowspan ?? 1)
          const cellWidth = colWidth * colspan
          const borderId = registry.borderId(cell.background)
          const content =
            cell.blocks.length > 0
              ? cell.blocks
                  .map((block) => buildCellBlock(block, registry, ids))
                  .join('')
              : buildParagraph({ type: 'paragraph', runs: [] }, registry, ids)

          const tc = `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${borderId}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="${cellWidth}" textHeight="0" hasTextRef="0" hasNumRef="0">${content}</hp:subList><hp:cellAddr colAddr="${column}" rowAddr="${rowIndex}"/><hp:cellSpan colSpan="${colspan}" rowSpan="${rowspan}"/><hp:cellSz width="${cellWidth}" height="${rowHeight}"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>`
          column += colspan
          return tc
        })
        .join('')
      return `<hp:tr>${tcs}</hp:tr>`
    })
    .join('')

  return `<hp:tbl id="${ids.value++}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rowCount}" colCnt="${colCount}" cellSpacing="0" borderFillIDRef="1" noAdjust="0"><hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${rowHeight * rowCount}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>${trs}</hp:tbl>`
}

function buildCellBlock(
  block: HwpxBlock,
  registry: StyleRegistry,
  ids: { value: number }
): string {
  if (block.type === 'paragraph') return buildParagraph(block, registry, ids)
  if (block.type === 'rule') {
    return buildParagraph(
      { type: 'paragraph', runs: [{ text: '────────────────' }], align: 'center' },
      registry,
      ids
    )
  }
  return buildTableParagraph(block, registry, ids)
}

function buildHeaderXml(registry: StyleRegistry): string {
  const languages = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER']
  const fontfaces = languages
    .map(
      (lang) =>
        `<hh:fontface lang="${lang}" fontCnt="${registry.fonts.length}">${registry.fonts
          .map(
            (name, id) =>
              `<hh:font id="${id}" face="${escapeAttr(name)}" type="TTF" isEmbedded="0"/>`
          )
          .join('')}</hh:fontface>`
    )
    .join('')
  const charProperties = registry.charStyles
    .map(({ id, style }) => buildCharPr(id, style, registry))
    .join('')
  const borderFills = registry.borderFills.map(borderFillXml).join('')
  const paraProperties = registry.paraStyles
    .map(({ id, style }) => buildParaPr(id, style))
    .join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" version="1.4" secCnt="1">
  <hh:refList>
    <hh:fontfaces itemCnt="${languages.length}">${fontfaces}</hh:fontfaces>
    <hh:charProperties itemCnt="${registry.charStyles.length}">${charProperties}</hh:charProperties>
    <hh:borderFills itemCnt="${registry.borderFills.length}">${borderFills}</hh:borderFills>
    <hh:paraProperties itemCnt="${registry.paraStyles.length}">${paraProperties}</hh:paraProperties>
    <hh:styles itemCnt="1">
      <hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>
    </hh:styles>
  </hh:refList>
</hh:head>`
}

function buildCharPr(id: number, style: CharStyle, registry: StyleRegistry): string {
  const height = Math.max(100, Math.round(style.fontSize * 75))
  const fontId = registry.fontId(style.fontFamily)
  const shade = style.highlight ?? 'none'
  const parts: string[] = [
    `<hh:fontRef hangul="${fontId}" latin="${fontId}" hanja="${fontId}" japanese="${fontId}" other="${fontId}" symbol="${fontId}" user="${fontId}"/>`,
    '<hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>',
    '<hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>',
    '<hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>',
    '<hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>'
  ]
  if (style.italic) parts.push('<hh:italic/>')
  if (style.bold) parts.push('<hh:bold/>')
  if (style.underline) {
    parts.push(`<hh:underline type="BOTTOM" shape="SOLID" color="${style.color}"/>`)
  }
  if (style.strike) {
    parts.push(`<hh:strikeout shape="SOLID" color="${style.color}"/>`)
  }
  return `<hh:charPr id="${id}" height="${height}" textColor="${style.color}" shadeColor="${shade}" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="0">${parts.join('')}</hh:charPr>`
}

function buildParaPr(id: number, style: ParaStyle): string {
  const align = style.align.toUpperCase()
  const headingType = style.heading > 0 ? 'OUTLINE' : 'NONE'
  const level = style.heading > 0 ? style.heading : 0
  const left = (style.indent + (style.quote ? 1 : 0)) * 2000
  return `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="0" suppressLineNumbers="0" checked="0"><hh:align horizontal="${align}" vertical="BASELINE"/><hh:heading type="${headingType}" idRef="0" level="${level}"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hh:margin><hc:intent value="0"/><hc:left value="${left}"/><hc:right value="0"/><hc:prev value="${style.heading > 0 ? 800 : 0}"/><hc:next value="${style.heading > 0 ? 400 : 0}"/></hh:margin><hh:lineSpacing type="PERCENT" value="160"/></hh:paraPr>`
}

function borderFillXml(fill: BorderFill): string {
  if (!fill.tableBorder) {
    return `<hh:borderFill id="${fill.id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:leftBorder type="NONE" width="0.1mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1mm" color="#000000"/><hh:topBorder type="NONE" width="0.1mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1mm" color="#000000"/><hh:diagonal type="SOLID" width="0.1mm" color="#000000"/></hh:borderFill>`
  }
  const border =
    '<hh:leftBorder type="SOLID" width="0.12mm" color="#000000"/><hh:rightBorder type="SOLID" width="0.12mm" color="#000000"/><hh:topBorder type="SOLID" width="0.12mm" color="#000000"/><hh:bottomBorder type="SOLID" width="0.12mm" color="#000000"/><hh:diagonal type="SOLID" width="0.1mm" color="#000000"/>'
  const fillXml = fill.background
    ? `<hh:fillBrush><hh:winBrush faceColor="${fill.background}" hatchColor="#000000" alpha="0"/></hh:fillBrush>`
    : ''
  return `<hh:borderFill id="${fill.id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">${border}${fillXml}</hh:borderFill>`
}

function versionXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hv:HWPApplicationSetting xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version">
  <hv:version appVersion="9.0.0.0" version="1.4"/>
</hv:HWPApplicationSetting>`
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwp+zip"/>
  </ocf:rootfiles>
</ocf:container>`
}

function manifestXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" version="1.2">
  <odf:file-entry odf:full-path="/" odf:media-type="application/hwp+zip"/>
  <odf:file-entry odf:full-path="version.xml" odf:media-type="application/xml"/>
  <odf:file-entry odf:full-path="Contents/content.hpf" odf:media-type="application/xml"/>
  <odf:file-entry odf:full-path="Contents/header.xml" odf:media-type="application/xml"/>
  <odf:file-entry odf:full-path="Contents/section0.xml" odf:media-type="application/xml"/>
</odf:manifest>`
}

function contentHpf(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:dc="http://purl.org/dc/elements/1.1/" version="1.0" unique-identifier="bookid">
  <opf:metadata>
    <dc:title>${escapeXml(title || '한맥 문서')}</dc:title>
    <dc:language>ko</dc:language>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="header" href="header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="section0.xml" media-type="application/xml"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="header"/>
    <opf:itemref idref="section0"/>
  </opf:spine>
</opf:package>`
}

// MARK: - 유틸

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function hasKey(value: any, key: string): boolean {
  return value != null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
}

function textOf(value: any): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (typeof value === 'object') {
    if ('#text' in value) return textOf((value as any)['#text'])
    let result = ''
    for (const [key, child] of Object.entries(value)) {
      if (key === '#text' || key.startsWith('@_')) continue
      result += textOf(child)
    }
    return result
  }
  return ''
}

function normalizeHex(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'none' || trimmed === 'transparent') return undefined
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return (
      '#' +
      trimmed
        .slice(1)
        .split('')
        .map((character) => character + character)
        .join('')
    ).toLowerCase()
  }
  const match = trimmed.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (match) {
    return (
      '#' +
      [match[1], match[2], match[3]]
        .map((part) =>
          Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, '0')
        )
        .join('')
    )
  }
  if (/^[0-9a-f]{6}$/i.test(trimmed)) return `#${trimmed.toLowerCase()}`
  return undefined
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function escapeAttr(value: string): string {
  return escapeXml(value)
}
