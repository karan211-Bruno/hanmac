import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'
import { buildHwpx, parseHwpx } from '../src/main/formats/hwpx'
import { parseHwp } from '../src/main/formats/hwp'
import { blocksToHtml, blocksToText } from '../src/shared/hwpxHtml'
import type { HwpxBlock, HwpxParagraph, HwpxRun } from '../src/shared/types'

const HWP_SAMPLE =
  process.env.HANMAC_HWP_SAMPLE ?? '/Users/newborn/Documents/Welcome to Hwp.hwp'

const SAMPLE_BLOCKS: HwpxBlock[] = [
  {
    type: 'paragraph',
    heading: 1,
    align: 'center',
    runs: [
      {
        text: '한맥 문서 HWPX 검증',
        bold: true,
        color: '#a8432f',
        fontSize: 24,
        fontFamily: '함초롬바탕'
      }
    ]
  },
  {
    type: 'paragraph',
    align: 'justify',
    runs: [
      { text: '일반 텍스트 ' },
      { text: '굵게', bold: true },
      { text: ' ' },
      { text: '기울임', italic: true },
      { text: ' ' },
      { text: '밑줄', underline: true },
      { text: ' ' },
      { text: '취소선', strike: true },
      { text: ' ' },
      { text: '색상', color: '#2f6b57' },
      { text: ' ' },
      { text: '형광', highlight: '#fff1a8' },
      { text: ' ' },
      { text: '글꼴', fontFamily: 'Apple SD Gothic Neo', fontSize: 18 }
    ]
  },
  {
    type: 'paragraph',
    align: 'left',
    indent: 2,
    runs: [{ text: '왼쪽 들여쓰기 문단' }]
  },
  {
    type: 'paragraph',
    align: 'justify',
    quote: true,
    runs: [{ text: '인용 문단입니다.' }]
  },
  {
    type: 'paragraph',
    runs: [{ text: '목록 첫째' }],
    indent: 1,
    list: { kind: 'bullet', level: 0 }
  },
  {
    type: 'paragraph',
    runs: [{ text: '목록 둘째' }],
    indent: 1,
    list: { kind: 'ordered', level: 0, index: 2 }
  },
  {
    type: 'paragraph',
    runs: [],
    pageBreak: true
  },
  {
    type: 'paragraph',
    runs: [{ text: '페이지 나눈 뒤 문단' }]
  },
  {
    type: 'table',
    border: true,
    rows: [
      [
        {
          blocks: [{ type: 'paragraph', runs: [{ text: '머리1', bold: true }] }],
          background: '#f5f1e7'
        },
        {
          blocks: [{ type: 'paragraph', runs: [{ text: '머리2', bold: true }] }],
          background: '#f5f1e7'
        }
      ],
      [
        { blocks: [{ type: 'paragraph', runs: [{ text: '값1' }] }] },
        { blocks: [{ type: 'paragraph', runs: [{ text: '값2' }] }] }
      ]
    ]
  }
]

function runText(paragraph: HwpxParagraph): string {
  return paragraph.runs.map((run) => run.text).join('')
}

function paragraphs(blocks: HwpxBlock[]): HwpxParagraph[] {
  const output: HwpxParagraph[] = []
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      output.push(block)
    } else if (block.type === 'table') {
      for (const row of block.rows) {
        for (const cell of row) output.push(...paragraphs(cell.blocks))
      }
    }
  }
  return output
}

function findParagraph(blocks: HwpxBlock[], needle: string): HwpxParagraph {
  const found = paragraphs(blocks).find((paragraph) => runText(paragraph).includes(needle))
  assert.ok(found, `문단을 찾지 못했습니다: ${needle}`)
  return found
}

function findRun(blocks: HwpxBlock[], needle: string): HwpxRun {
  for (const paragraph of paragraphs(blocks)) {
    const found = paragraph.runs.find((run) => run.text.includes(needle))
    if (found) return found
  }
  assert.fail(`런을 찾지 못했습니다: ${needle}`)
}

function testHwp(): void {
  if (!existsSync(HWP_SAMPLE)) {
    console.warn(`⚠ HWP 샘플이 없어 테스트를 건너뜁니다: ${HWP_SAMPLE}`)
    return
  }

  const buffer = readFileSync(HWP_SAMPLE)
  assert.equal(buffer.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1', 'CFB 서명')

  const result = parseHwp(buffer)
  assert.ok(result.text.length > 500, `본문이 너무 짧습니다: ${result.text.length}`)
  assert.match(result.text, /[가-힣]/, '한글 본문이 있어야 합니다.')
  assert.ok(result.version.startsWith('5.'), `HWP 5.x 버전이어야 합니다: ${result.version}`)
  assert.ok(result.sections >= 1, '섹션이 하나 이상이어야 합니다.')
  assert.ok(!result.text.includes('\uFFFD'), '치환 문자(U+FFFD)가 없어야 합니다.')
  assert.doesNotMatch(
    result.text,
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/,
    '제어 문자가 남아 있으면 안 됩니다.'
  )

  console.log(
    `✓ HWP 파싱: ${result.text.length.toLocaleString()}자 · v${result.version} · ` +
      `${result.sections}섹션 · 압축 ${result.compressed ? 'O' : 'X'} · ` +
      `미리보기 ${result.usedPreview ? 'O' : 'X'}`
  )
  console.log(`  ${result.text.slice(0, 120).replace(/\n/g, ' / ')}`)
}

async function testHwpx(): Promise<void> {
  const buffer = await buildHwpx(SAMPLE_BLOCKS, '테스트 문서')
  assert.equal(buffer.subarray(0, 2).toString(), 'PK', 'HWPX는 ZIP이어야 합니다.')

  // HWPX 규격: 첫 항목은 압축하지 않은 mimetype이어야 한다.
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, 'ZIP 로컬 헤더')
  assert.equal(buffer.readUInt16LE(8), 0, 'mimetype은 STORE 압축')
  const nameLength = buffer.readUInt16LE(26)
  assert.equal(buffer.subarray(30, 30 + nameLength).toString(), 'mimetype')

  const zip = await JSZip.loadAsync(buffer)
  const names = Object.keys(zip.files)
  assert.equal(names[0], 'mimetype', 'mimetype이 첫 항목이어야 합니다.')
  for (const required of [
    'version.xml',
    'META-INF/container.xml',
    'META-INF/manifest.xml',
    'Contents/content.hpf',
    'Contents/header.xml',
    'Contents/section0.xml'
  ]) {
    assert.ok(zip.file(required), `${required} 항목이 필요합니다.`)
  }

  const mimetype = await zip.file('mimetype')?.async('string')
  assert.equal(mimetype, 'application/hwp+zip')

  const sectionXml = await zip.file('Contents/section0.xml')?.async('string')
  assert.ok(sectionXml, 'section0.xml을 읽을 수 있어야 합니다.')
  assert.match(sectionXml, /<hp:tbl[\s>]/, '표 XML이 있어야 합니다.')
  assert.match(sectionXml, /pageBreak="1"/, '페이지 나누기 속성이 있어야 합니다.')
  assert.match(sectionXml, /<hp:t>한맥 문서 HWPX 검증<\/hp:t>/, '제목 텍스트')

  const headerXml = await zip.file('Contents/header.xml')?.async('string')
  assert.ok(headerXml, 'header.xml을 읽을 수 있어야 합니다.')
  assert.match(headerXml, /<hh:charPr[\s>]/, '글자 모양 정의')
  assert.match(headerXml, /<hh:paraPr[\s>]/, '문단 모양 정의')
  assert.match(headerXml, /face="함초롬바탕"/, '글꼴 정의')
  assert.match(headerXml, /shadeColor="#fff1a8"/, '형광펜 색')

  const parsed = await parseHwpx(buffer)
  assert.equal(parsed.sections, 1)
  assert.equal(parsed.title, '테스트 문서')

  const title = findParagraph(parsed.blocks, '한맥 문서 HWPX 검증')
  assert.equal(title.heading, 1, '제목 수준')
  assert.equal(title.align, 'center', '가운데 정렬')
  const titleRun = title.runs.find((run) => run.text.includes('한맥')) ?? title.runs[0]
  assert.equal(titleRun.bold, true, '굵게')
  assert.equal(titleRun.color, '#a8432f', '글자 색')
  assert.equal(titleRun.fontSize, 24, '글자 크기')
  assert.equal(titleRun.fontFamily, '함초롬바탕', '글꼴')

  assert.equal(findRun(parsed.blocks, '굵게').bold, true)
  assert.equal(findRun(parsed.blocks, '기울임').italic, true)
  assert.equal(findRun(parsed.blocks, '밑줄').underline, true)
  assert.equal(findRun(parsed.blocks, '취소선').strike, true)
  assert.equal(findRun(parsed.blocks, '색상').color, '#2f6b57')
  assert.equal(findRun(parsed.blocks, '형광').highlight, '#fff1a8')
  assert.equal(findRun(parsed.blocks, '글꼴').fontFamily, 'Apple SD Gothic Neo')
  assert.equal(findRun(parsed.blocks, '글꼴').fontSize, 18)

  const indented = findParagraph(parsed.blocks, '왼쪽 들여쓰기 문단')
  assert.equal(indented.align, 'left')
  assert.equal(indented.indent, 2)

  const pageBreak = paragraphs(parsed.blocks).find((paragraph) => paragraph.pageBreak)
  assert.ok(pageBreak, '페이지 나누기가 복원되어야 합니다.')
  assert.ok(
    findParagraph(parsed.blocks, '페이지 나눈 뒤 문단'),
    '페이지 나누기 뒤 문단이 있어야 합니다.'
  )

  const bullets = findParagraph(parsed.blocks, '목록 첫째')
  const ordered = findParagraph(parsed.blocks, '목록 둘째')
  assert.match(runText(bullets), /^• /, '글머리 기호가 유지되어야 합니다.')
  assert.match(runText(ordered), /^2\. /, '번호가 유지되어야 합니다.')

  const table = parsed.blocks.find((block) => block.type === 'table')
  assert.ok(table && table.type === 'table', '표가 복원되어야 합니다.')
  assert.equal(table.rows.length, 2, '표 행 수')
  assert.equal(table.rows[0].length, 2, '표 열 수')
  assert.equal(table.rows[0][0].background, '#f5f1e7', '머리글 배경색')
  assert.match(blocksToText(table.rows[0][0].blocks), /머리1/)
  assert.match(blocksToText(table.rows[1][1].blocks), /값2/)

  const html = blocksToHtml(parsed.blocks)
  assert.match(html, /<h1[^>]*>/, 'HTML 제목')
  assert.match(html, /<strong>/, 'HTML 굵게')
  assert.match(html, /<table>/, 'HTML 표')
  assert.match(html, /data-page-break="true"/, 'HTML 페이지 나누기')
  assert.doesNotMatch(
    html,
    /<div data-page-break="true" class="page-break"><\/div><p><br><\/p>/,
    '빈 페이지 나누기 블록 뒤에 불필요한 빈 문단이 추가되면 안 됩니다.'
  )

  const text = blocksToText(parsed.blocks)
  assert.match(text, /한맥 문서 HWPX 검증/)
  assert.match(text, /머리1\t머리2/)

  console.log(`✓ HWPX 왕복: ${parsed.blocks.length}블록 · ${buffer.length.toLocaleString()}바이트`)
  console.log(`  XML ${sectionXml.length.toLocaleString()}자 · 표 ${table.rows.length}×${table.rows[0].length}`)
}

async function main(): Promise<void> {
  console.log('한맥 문서 — 형식 테스트\n')
  testHwp()
  await testHwpx()
  console.log('\n모든 형식 테스트를 통과했습니다.')
}

main().catch((error: unknown) => {
  console.error('\n✗ 형식 테스트 실패')
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
