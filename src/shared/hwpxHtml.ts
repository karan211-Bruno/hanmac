import type { HwpxBlock, HwpxParagraph, HwpxRun, HwpxTable } from './types'

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 일반 텍스트를 문단 HTML로 바꾼다. */
export function textToHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.trim()) return '<p></p>'
  const lines = normalized.split('\n')
  return lines
    .map((line) => {
      if (!line) return '<p><br></p>'
      return `<p>${escapeHtml(line).replace(/\t/g, '&emsp;')}</p>`
    })
    .join('')
}

function runToHtml(run: HwpxRun): string {
  let html = escapeHtml(run.text)
    .replace(/\n/g, '<br>')
    .replace(/\t/g, '&emsp;')
  if (!html) return ''

  if (run.code) html = `<code>${html}</code>`

  const highlight = safeColor(run.highlight)
  if (highlight) {
    html = `<mark data-color="${highlight}" style="background-color:${highlight}">${html}</mark>`
  }

  const styles: string[] = []
  const color = safeColor(run.color)
  if (color) styles.push(`color:${color}`)
  if (run.fontFamily) styles.push(`font-family:'${safeFontName(run.fontFamily)}'`)
  if (run.fontSize && Number.isFinite(run.fontSize) && run.fontSize > 0) {
    styles.push(`font-size:${Math.min(200, run.fontSize)}px`)
  }
  if (styles.length > 0) html = `<span style="${styles.join(';')}">${html}</span>`

  if (run.bold) html = `<strong>${html}</strong>`
  if (run.italic) html = `<em>${html}</em>`
  if (run.underline) html = `<u>${html}</u>`
  if (run.strike) html = `<s>${html}</s>`
  if (run.link) html = `<a href="${escapeHtml(run.link)}">${html}</a>`
  return html
}

/** HWPX에서 읽은 색상은 16진수만 허용한다. */
function safeColor(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
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
  return undefined
}

/** CSS 문자열에 들어갈 수 없는 문자를 제거한다. */
function safeFontName(value: string): string {
  return value.replace(/[\\'"<>&\u0000-\u001f]/g, '').trim().slice(0, 80) || '함초롬돋움'
}

const ALIGNMENTS = new Set(['left', 'center', 'right', 'justify'])

/** 문단/셀 정렬은 알려진 값만 허용한다. */
function safeAlign(value: string | undefined): string | undefined {
  return value && ALIGNMENTS.has(value) ? value : undefined
}

function paragraphContent(paragraph: HwpxParagraph): string {
  const content = paragraph.runs.map(runToHtml).join('')
  return content || '<br>'
}

function paragraphStyle(paragraph: HwpxParagraph): string {
  const styles: string[] = []
  const align = safeAlign(paragraph.align)
  if (align) styles.push(`text-align:${align}`)
  if (paragraph.indent) styles.push(`margin-left:${paragraph.indent * 24}px`)
  return styles.length > 0 ? ` style="${styles.join(';')}"` : ''
}

function paragraphToHtml(paragraph: HwpxParagraph): string {
  if (paragraph.pageBreak) {
    if (paragraph.runs.length === 0 || !paragraph.runs.some((run) => run.text.length > 0)) {
      return '<div data-page-break="true" class="page-break"></div>'
    }
    return `<div data-page-break="true" class="page-break"></div><p${paragraphStyle(paragraph)}>${paragraphContent(paragraph)}</p>`
  }
  const style = paragraphStyle(paragraph)
  if (paragraph.quote) {
    return `<blockquote><p${style}>${paragraphContent(paragraph)}</p></blockquote>`
  }
  if (paragraph.heading && paragraph.heading >= 1 && paragraph.heading <= 6) {
    const tag = `h${paragraph.heading}`
    return `<${tag}${style}>${paragraphContent(paragraph)}</${tag}>`
  }
  return `<p${style}>${paragraphContent(paragraph)}</p>`
}

function tableToHtml(table: HwpxTable): string {
  const rows = table.rows
    .map((row) => {
      const cells = row
        .map((cell) => {
          const attrs: string[] = []
          if (cell.colspan && cell.colspan > 1) attrs.push(`colspan="${cell.colspan}"`)
          if (cell.rowspan && cell.rowspan > 1) attrs.push(`rowspan="${cell.rowspan}"`)
          const styles: string[] = []
          const background = safeColor(cell.background)
          if (background) styles.push(`background-color:${background}`)
          const align = safeAlign(cell.align)
          if (align) styles.push(`text-align:${align}`)
          if (styles.length > 0) attrs.push(`style="${styles.join(';')}"`)
          const body = blocksToHtml(cell.blocks) || '<p><br></p>'
          return `<td${attrs.length > 0 ? ' ' + attrs.join(' ') : ''}>${body}</td>`
        })
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')
  return `<table><tbody>${rows}</tbody></table>`
}

/** HWPX 블록 모델을 TipTap이 읽을 수 있는 HTML로 변환한다. */
export function blocksToHtml(blocks: HwpxBlock[]): string {
  const output: string[] = []
  let index = 0

  while (index < blocks.length) {
    const block = blocks[index]
    if (block.type === 'rule') {
      output.push('<hr>')
      index += 1
      continue
    }
    if (block.type === 'table') {
      output.push(tableToHtml(block))
      index += 1
      continue
    }

    if (block.list) {
      const kind = block.list.kind
      const level = block.list.level
      const items: HwpxParagraph[] = []
      while (
        index < blocks.length &&
        blocks[index].type === 'paragraph' &&
        (blocks[index] as HwpxParagraph).list?.kind === kind &&
        (blocks[index] as HwpxParagraph).list?.level === level
      ) {
        items.push(blocks[index] as HwpxParagraph)
        index += 1
      }
      const tag = kind === 'ordered' ? 'ol' : 'ul'
      const start =
        kind === 'ordered' && items[0]?.list?.index && items[0].list.index !== 1
          ? ` start="${items[0].list.index}"`
          : ''
      const listItems = items
        .map((item) => `<li><p>${paragraphContent(item)}</p></li>`)
        .join('')
      output.push(`<${tag}${start}>${listItems}</${tag}>`)
      continue
    }

    output.push(paragraphToHtml(block))
    index += 1
  }

  return output.join('')
}

function runText(run: HwpxRun): string {
  return run.text
}

/** HWPX 블록 모델을 평문으로 변환한다. */
export function blocksToText(blocks: HwpxBlock[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.type === 'rule') {
      lines.push('────────────────')
    } else if (block.type === 'table') {
      for (const row of block.rows) {
        lines.push(row.map((cell) => blocksToText(cell.blocks).replace(/\n/g, ' ')).join('\t'))
      }
    } else {
      let prefix = ''
      if (block.list) {
        if (block.list.kind === 'ordered') prefix = `${block.list.index ?? 1}. `
        else prefix = ['• ', '◦ ', '▪ '][block.list.level % 3]
      }
      lines.push(prefix + block.runs.map(runText).join(''))
    }
  }
  return lines.join('\n')
}

function runToMarkdown(run: HwpxRun): string {
  let text = run.text
  if (run.code) text = `\`${text}\``
  if (run.bold) text = `**${text}**`
  if (run.italic) text = `*${text}*`
  if (run.strike) text = `~~${text}~~`
  if (run.link) text = `[${text}](${run.link})`
  return text
}

function tableToMarkdown(table: HwpxTable): string {
  if (table.rows.length === 0) return ''
  const rows = table.rows.map((row) =>
    row.map((cell) => blocksToMarkdown(cell.blocks).replace(/\n/g, '<br>').replace(/\|/g, '\\|'))
  )
  const width = Math.max(...rows.map((row) => row.length))
  const header = rows[0].concat(Array(Math.max(0, width - rows[0].length)).fill(''))
  const separator = Array(width).fill('---')
  const body = rows.slice(1).map((row) => row.concat(Array(Math.max(0, width - row.length)).fill('')))
  return [header, separator, ...body].map((row) => `| ${row.join(' | ')} |`).join('\n')
}

/** HWPX 블록 모델을 Markdown으로 변환한다. */
export function blocksToMarkdown(blocks: HwpxBlock[]): string {
  const output: string[] = []
  for (const block of blocks) {
    if (block.type === 'rule') {
      output.push('---')
      continue
    }
    if (block.type === 'table') {
      output.push(tableToMarkdown(block))
      continue
    }
    const text = block.runs.map(runToMarkdown).join('')
    if (block.heading && block.heading >= 1 && block.heading <= 6) {
      output.push(`${'#'.repeat(block.heading)} ${text}`)
    } else if (block.quote) {
      output.push(`> ${text}`)
    } else if (block.list) {
      const indent = '  '.repeat(block.list.level)
      const marker = block.list.kind === 'ordered' ? `${block.list.index ?? 1}.` : '-'
      output.push(`${indent}${marker} ${text}`)
    } else {
      output.push(text)
    }
  }
  return output.join('\n\n')
}
