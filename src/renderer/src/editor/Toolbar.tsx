import type { Editor } from '@tiptap/core'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Columns3,
  Eraser,
  FileDown,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  Merge,
  Palette,
  Quote,
  Redo2,
  Rows3,
  Sparkles,
  Split,
  Strikethrough,
  Table,
  Trash2,
  Underline,
  Undo2
} from 'lucide-react'
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'

interface Props {
  editor: Editor
  aiOpen: boolean
  onToggleAi: () => void
  onOpenLink: () => void
}

const FONT_FAMILIES = [
  '함초롬돋움',
  '함초롬바탕',
  'Apple SD Gothic Neo',
  'AppleMyungjo',
  'Georgia',
  'Menlo',
  'Arial'
]

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 40]

function parseSize(value: string | undefined): number | null {
  if (!value) return null
  const size = Number.parseFloat(value)
  return Number.isFinite(size) ? Math.round(size) : null
}

function blockValue(editor: Editor): string {
  for (let level = 1; level <= 4; level += 1) {
    if (editor.isActive('heading', { level })) return `h${level}`
  }
  return 'p'
}

export function Toolbar({ editor, aiOpen, onToggleAi, onOpenLink }: Props) {
  const [, force] = useReducer((value: number) => value + 1, 0)
  const [tableMenuOpen, setTableMenuOpen] = useState(false)
  const tableMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const update = (): void => force()
    editor.on('transaction', update)
    return () => {
      editor.off('transaction', update)
    }
  }, [editor])

  useEffect(() => {
    if (!tableMenuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!tableMenuRef.current?.contains(event.target as Node)) setTableMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [tableMenuOpen])

  const textStyle = editor.getAttributes('textStyle')
  const fontSize = parseSize(textStyle.fontSize as string | undefined)
  const fontFamily = (textStyle.fontFamily as string | undefined) ?? ''
  const textColor = (textStyle.color as string | undefined) ?? '#1f1d1a'
  const highlightColor =
    (editor.getAttributes('highlight').color as string | undefined) ?? '#fff1a8'
  const sizeOptions = Array.from(
    new Set([...FONT_SIZES, ...(fontSize ? [fontSize] : [])])
  ).sort((a, b) => a - b)
  const inTable = editor.isActive('table')

  const setBlock = (value: string): void => {
    if (value === 'p') {
      editor.chain().focus().setParagraph().run()
      return
    }
    const level = Number(value.slice(1)) as 1 | 2 | 3 | 4
    editor.chain().focus().setHeading({ level }).run()
  }

  return (
    <div className="toolbar">
      <div className="tool-group">
        <ToolButton
          title="실행 취소 (⌘Z)"
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
        >
          <Undo2 size={16} />
        </ToolButton>
        <ToolButton
          title="다시 실행 (⇧⌘Z)"
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
        >
          <Redo2 size={16} />
        </ToolButton>
      </div>

      <div className="tool-group">
        <select
          className="tool-select block-select"
          value={blockValue(editor)}
          title="문단 스타일"
          onChange={(event) => setBlock(event.target.value)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <option value="p">본문</option>
          <option value="h1">제목 1</option>
          <option value="h2">제목 2</option>
          <option value="h3">제목 3</option>
          <option value="h4">제목 4</option>
        </select>

        <select
          className="tool-select font-select"
          value={fontFamily}
          title="글꼴"
          onChange={(event) => {
            const value = event.target.value
            if (value) editor.chain().focus().setFontFamily(value).run()
            else editor.chain().focus().unsetFontFamily().run()
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <option value="">글꼴</option>
          {FONT_FAMILIES.map((family) => (
            <option key={family} value={family}>
              {family}
            </option>
          ))}
        </select>

        <select
          className="tool-select size-select"
          value={fontSize ? String(fontSize) : ''}
          title="글자 크기"
          onChange={(event) => {
            const value = event.target.value
            if (value) editor.chain().focus().setFontSize(`${value}px`).run()
            else editor.chain().focus().unsetFontSize().run()
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <option value="">크기</option>
          {sizeOptions.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      <div className="tool-group">
        <ToolButton
          title="굵게 (⌘B)"
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={16} />
        </ToolButton>
        <ToolButton
          title="기울임 (⌘I)"
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={16} />
        </ToolButton>
        <ToolButton
          title="밑줄 (⌘U)"
          active={editor.isActive('underline')}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <Underline size={16} />
        </ToolButton>
        <ToolButton
          title="취소선 (⇧⌘X)"
          active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough size={16} />
        </ToolButton>
      </div>

      <div className="tool-group">
        <ColorTool
          title="글자 색"
          icon={<Palette size={16} />}
          value={textColor}
          onChange={(value) => editor.chain().focus().setColor(value).run()}
        />
        <ColorTool
          title="형광펜"
          icon={<Highlighter size={16} />}
          value={highlightColor}
          onChange={(value) => editor.chain().focus().setHighlight({ color: value }).run()}
        />
      </div>

      <div className="tool-group">
        <ToolButton
          title="왼쪽 정렬"
          active={editor.isActive({ textAlign: 'left' })}
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
        >
          <AlignLeft size={16} />
        </ToolButton>
        <ToolButton
          title="가운데 정렬"
          active={editor.isActive({ textAlign: 'center' })}
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
        >
          <AlignCenter size={16} />
        </ToolButton>
        <ToolButton
          title="오른쪽 정렬"
          active={editor.isActive({ textAlign: 'right' })}
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
        >
          <AlignRight size={16} />
        </ToolButton>
        <ToolButton
          title="양쪽 정렬"
          active={editor.isActive({ textAlign: 'justify' })}
          onClick={() => editor.chain().focus().setTextAlign('justify').run()}
        >
          <AlignJustify size={16} />
        </ToolButton>
      </div>

      <div className="tool-group">
        <ToolButton
          title="글머리 기호"
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List size={16} />
        </ToolButton>
        <ToolButton
          title="번호 매기기"
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={16} />
        </ToolButton>
        <ToolButton
          title="인용"
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <Quote size={16} />
        </ToolButton>
        <ToolButton
          title="내어쓰기"
          onClick={() => {
            if (editor.isActive('bulletList') || editor.isActive('orderedList')) {
              editor.chain().focus().liftListItem('listItem').run()
            } else {
              editor.chain().focus().outdent().run()
            }
          }}
        >
          <IndentDecrease size={16} />
        </ToolButton>
        <ToolButton
          title="들여쓰기"
          onClick={() => {
            if (editor.isActive('bulletList') || editor.isActive('orderedList')) {
              editor.chain().focus().sinkListItem('listItem').run()
            } else {
              editor.chain().focus().indent().run()
            }
          }}
        >
          <IndentIncrease size={16} />
        </ToolButton>
      </div>

      <div className="tool-group">
        <div className="tool-menu-wrap" ref={tableMenuRef}>
          <ToolButton
            title="표"
            active={inTable}
            onClick={() => setTableMenuOpen((value) => !value)}
          >
            <Table size={16} />
          </ToolButton>
          {tableMenuOpen && (
            <div className="tool-menu">
              {!inTable ? (
                <button
                  type="button"
                  onClick={() => {
                    editor
                      .chain()
                      .focus()
                      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                      .run()
                    setTableMenuOpen(false)
                  }}
                >
                  <Table size={14} /> 3×3 표 삽입
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => editor.chain().focus().addRowAfter().run()}
                  >
                    <Rows3 size={14} /> 아래에 행 추가
                  </button>
                  <button
                    type="button"
                    onClick={() => editor.chain().focus().addColumnAfter().run()}
                  >
                    <Columns3 size={14} /> 오른쪽에 열 추가
                  </button>
                  <button
                    type="button"
                    onClick={() => editor.chain().focus().deleteRow().run()}
                  >
                    <Rows3 size={14} /> 행 삭제
                  </button>
                  <button
                    type="button"
                    onClick={() => editor.chain().focus().deleteColumn().run()}
                  >
                    <Columns3 size={14} /> 열 삭제
                  </button>
                  <div className="tool-menu-separator" />
                  <button
                    type="button"
                    onClick={() => editor.chain().focus().mergeCells().run()}
                    disabled={!editor.can().mergeCells()}
                  >
                    <Merge size={14} /> 셀 병합
                  </button>
                  <button
                    type="button"
                    onClick={() => editor.chain().focus().splitCell().run()}
                    disabled={!editor.can().splitCell()}
                  >
                    <Split size={14} /> 셀 분할
                  </button>
                  <div className="tool-menu-separator" />
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      editor.chain().focus().deleteTable().run()
                      setTableMenuOpen(false)
                    }}
                  >
                    <Trash2 size={14} /> 표 삭제
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <ToolButton title="링크" active={editor.isActive('link')} onClick={onOpenLink}>
          <Link2 size={16} />
        </ToolButton>
        <ToolButton
          title="페이지 나누기"
          onClick={() => editor.chain().focus().setPageBreak().run()}
        >
          <FileDown size={16} />
        </ToolButton>
        <ToolButton
          title="서식 지우기"
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
        >
          <Eraser size={16} />
        </ToolButton>
      </div>

      <div className="tool-spacer" />

      <button
        type="button"
        className={`ai-toggle-button ${aiOpen ? 'active' : ''}`}
        onClick={onToggleAi}
        title="AI 도우미 (⌘⇧A)"
      >
        <Sparkles size={15} />
        <span>AI</span>
      </button>
    </div>
  )
}

interface ToolButtonProps {
  title: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}

function ToolButton({ title, active, disabled, onClick, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`tool-button ${active ? 'active' : ''}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

interface ColorToolProps {
  title: string
  icon: ReactNode
  value: string
  onChange: (value: string) => void
}

function ColorTool({ title, icon, value, onChange }: ColorToolProps) {
  return (
    <label className="tool-button color-tool" title={title}>
      {icon}
      <span className="color-bar" style={{ backgroundColor: value }} />
      <input
        type="color"
        value={value}
        aria-label={title}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}
