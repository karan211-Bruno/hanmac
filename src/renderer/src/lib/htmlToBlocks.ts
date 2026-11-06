import type {
  Align,
  HwpxBlock,
  HwpxParagraph,
  HwpxRun,
  HwpxTable,
  HwpxTableCell
} from '../../../shared/types'

const HEADING_SIZES: Record<number, number> = {
  1: 26,
  2: 22,
  3: 19,
  4: 17,
  5: 15,
  6: 14
}

/** TipTap HTML을 HWPX 블록 모델로 변환한다. */
export function htmlToBlocks(html: string): HwpxBlock[] {
  const document = new DOMParser().parseFromString(`<div id="hanmac-root">${html}</div>`, 'text/html')
  const root = document.getElementById('hanmac-root')
  if (!root) return [{ type: 'paragraph', runs: [] }]

  const blocks: HwpxBlock[] = []
  walkBlocks(root, blocks)
  if (blocks.length === 0) blocks.push({ type: 'paragraph', runs: [] })
  return blocks
}

function walkBlocks(parent: Node, output: HwpxBlock[]): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? ''
      if (text.trim()) {
        output.push({ type: 'paragraph', runs: [{ text }] })
      }
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue

    const element = child as HTMLElement
    const tag = element.tagName.toLowerCase()

    if (tag === 'p') {
      output.push(paragraphFrom(element))
      continue
    }
    if (/^h[1-6]$/.test(tag)) {
      output.push(headingFrom(element, Number(tag.slice(1))))
      continue
    }
    if (tag === 'ul' || tag === 'ol') {
      listFrom(element, tag === 'ol', 0, output)
      continue
    }
    if (tag === 'blockquote') {
      quoteFrom(element, output)
      continue
    }
    if (tag === 'table') {
      output.push(tableFrom(element as HTMLTableElement))
      continue
    }
    if (tag === 'hr') {
      output.push({ type: 'rule' })
      continue
    }
    if (tag === 'br') {
      output.push({ type: 'paragraph', runs: [] })
      continue
    }
    if (tag === 'pre') {
      output.push(preFrom(element))
      continue
    }
    if (element.classList.contains('page-break') || element.dataset.pageBreak !== undefined) {
      output.push({ type: 'paragraph', runs: [], pageBreak: true })
      continue
    }
    if (element.classList.contains('tableWrapper')) {
      const table = element.querySelector('table')
      if (table) output.push(tableFrom(table))
      continue
    }

    if (element.querySelector('p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,table,hr,div')) {
      walkBlocks(element, output)
    } else {
      output.push(paragraphFrom(element))
    }
  }
}

function quoteFrom(element: HTMLElement, output: HwpxBlock[]): void {
  const inner: HwpxBlock[] = []
  walkBlocks(element, inner)
  if (inner.length === 0) {
    output.push({ type: 'paragraph', runs: [], quote: true, indent: 1 })
    return
  }
  for (const block of inner) {
    if (block.type === 'paragraph') {
      output.push({
        ...block,
        quote: true,
        indent: Math.max(1, block.indent ?? 0)
      })
    } else {
      output.push(block)
    }
  }
}

function listFrom(
  list: HTMLElement,
  ordered: boolean,
  level: number,
  output: HwpxBlock[]
): void {
  const start = Number(list.getAttribute('start') ?? 1) || 1
  let index = start

  for (const child of Array.from(list.children)) {
    if (child.tagName.toLowerCase() !== 'li') continue
    const item = child as HTMLElement

    const nested = Array.from(item.children).filter((node) =>
      /^(ul|ol)$/i.test(node.tagName)
    ) as HTMLElement[]

    const clone = item.cloneNode(true) as HTMLElement
    for (const node of Array.from(clone.children)) {
      if (/^(ul|ol)$/i.test(node.tagName)) node.remove()
    }

    const inner: HwpxBlock[] = []
    walkBlocks(clone, inner)

    const paragraphs = inner.filter(
      (block): block is HwpxParagraph => block.type === 'paragraph'
    )
    if (paragraphs.length === 0) {
      paragraphs.push({ type: 'paragraph', runs: [] })
    }

    for (const paragraph of paragraphs) {
      output.push({
        ...paragraph,
        indent: Math.max(paragraph.indent ?? 0, level + 1),
        list: {
          kind: ordered ? 'ordered' : 'bullet',
          level,
          index: ordered ? index : undefined
        }
      })
    }

    for (const block of inner) {
      if (block.type !== 'paragraph') output.push(block)
    }

    for (const nestedList of nested) {
      listFrom(nestedList, nestedList.tagName.toLowerCase() === 'ol', level + 1, output)
    }
    index += 1
  }
}

function paragraphFrom(element: HTMLElement): HwpxParagraph {
  const runs: HwpxRun[] = []
  collectInline(element, {}, runs)
  return {
    type: 'paragraph',
    runs: normalizeRuns(runs),
    align: alignOf(element),
    indent: indentOf(element)
  }
}

function headingFrom(element: HTMLElement, level: number): HwpxParagraph {
  const runs: HwpxRun[] = []
  collectInline(element, {}, runs)
  const size = HEADING_SIZES[level] ?? 15
  const styled = runs.map((run) => ({
    ...run,
    bold: true,
    fontSize: run.fontSize ?? size
  }))
  return {
    type: 'paragraph',
    runs: normalizeRuns(styled),
    align: alignOf(element),
    heading: level
  }
}

function preFrom(element: HTMLElement): HwpxParagraph {
  const text = element.textContent ?? ''
  return {
    type: 'paragraph',
    runs: text ? [{ text, code: true, fontFamily: 'Menlo' }] : [],
    align: 'left'
  }
}

function collectInline(
  node: Node,
  inherited: Partial<HwpxRun>,
  output: HwpxRun[]
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? ''
    if (text) output.push({ ...inherited, text })
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return

  const element = node as HTMLElement
  const tag = element.tagName.toLowerCase()
  if (tag === 'br') {
    output.push({ ...inherited, text: '\n' })
    return
  }

  const style = { ...inherited, ...styleOf(element, tag) }
  for (const child of Array.from(element.childNodes)) {
    collectInline(child, style, output)
  }
}

function styleOf(element: HTMLElement, tag: string): Partial<HwpxRun> {
  const run: Partial<HwpxRun> = {}

  if (tag === 'strong' || tag === 'b') run.bold = true
  if (tag === 'em' || tag === 'i') run.italic = true
  if (tag === 'u') run.underline = true
  if (tag === 's' || tag === 'del' || tag === 'strike') run.strike = true
  if (tag === 'code') {
    run.code = true
    run.fontFamily = 'Menlo'
  }
  if (tag === 'a') {
    const href = element.getAttribute('href')
    if (href) run.link = href
    run.underline = true
    run.color = '#2f6b57'
  }
  if (tag === 'mark') {
    const color = element.getAttribute('data-color') ?? element.style.backgroundColor
    const hex = toHex(color)
    if (hex) run.highlight = hex
  }

  const inline = element.style
  if (inline.color) {
    const hex = toHex(inline.color)
    if (hex) run.color = hex
  }
  if (inline.backgroundColor) {
    const hex = toHex(inline.backgroundColor)
    if (hex) run.highlight = hex
  }
  if (inline.fontFamily) run.fontFamily = firstFont(inline.fontFamily)
  if (inline.fontSize) {
    const px = fontSizePx(inline.fontSize)
    if (px) run.fontSize = px
  }
  if (inline.fontWeight === 'bold' || Number.parseInt(inline.fontWeight, 10) >= 600) {
    run.bold = true
  }
  if (inline.fontStyle === 'italic') run.italic = true
  if (inline.textDecoration.includes('underline')) run.underline = true
  if (inline.textDecoration.includes('line-through')) run.strike = true

  return run
}

function alignOf(element: HTMLElement): Align | undefined {
  const value = (element.style.textAlign || element.getAttribute('align') || '').toLowerCase()
  if (value === 'left' || value === 'center' || value === 'right' || value === 'justify') {
    return value
  }
  return undefined
}

function indentOf(element: HTMLElement): number | undefined {
  const margin = Number.parseFloat(element.style.marginLeft || '0')
  if (!Number.isFinite(margin) || margin <= 0) return undefined
  return Math.min(5, Math.max(1, Math.round(margin / 24)))
}

function tableFrom(table: HTMLTableElement): HwpxTable {
  const rows: HwpxTableCell[][] = []

  for (const row of Array.from(table.rows)) {
    const cells: HwpxTableCell[] = []
    for (const cell of Array.from(row.cells)) {
      const blocks: HwpxBlock[] = []
      walkBlocks(cell, blocks)
      if (blocks.length === 0) blocks.push({ type: 'paragraph', runs: [] })

      const background =
        cell.style.backgroundColor ||
        cell.getAttribute('data-background-color') ||
        ''

      cells.push({
        blocks,
        colspan: Number(cell.getAttribute('colspan') ?? 1) || 1,
        rowspan: Number(cell.getAttribute('rowspan') ?? 1) || 1,
        background: toHex(background),
        align: alignOf(cell)
      })
    }
    rows.push(cells)
  }

  return { type: 'table', rows, border: true }
}

function normalizeRuns(runs: HwpxRun[]): HwpxRun[] {
  const output: HwpxRun[] = []
  for (const run of runs) {
    if (!run.text) continue
    const previous = output[output.length - 1]
    if (previous && runKey(previous) === runKey(run)) {
      previous.text += run.text
    } else {
      output.push({ ...run })
    }
  }
  return output
}

function runKey(run: HwpxRun): string {
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

function toHex(value: string | null | undefined): string | undefined {
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
  return undefined
}

function firstFont(value: string): string {
  return value.replace(/["']/g, '').split(',')[0]?.trim() || '함초롬돋움'
}

function fontSizePx(value: string): number | undefined {
  const match = value.trim().match(/^([\d.]+)(px|pt|em|rem)?$/i)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  switch ((match[2] ?? 'px').toLowerCase()) {
    case 'pt':
      return (amount * 4) / 3
    case 'em':
    case 'rem':
      return amount * 16
    default:
      return amount
  }
}
