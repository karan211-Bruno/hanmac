import { Extension } from '@tiptap/core'

export interface IndentOptions {
  types: string[]
  minLevel: number
  maxLevel: number
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType
      outdent: () => ReturnType
    }
  }
}

export const Indent = Extension.create<IndentOptions>({
  name: 'indent',

  addOptions() {
    return {
      types: ['paragraph', 'heading'],
      minLevel: 0,
      maxLevel: 5
    }
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => {
              const margin = Number.parseFloat(element.style.marginLeft || '0')
              if (!Number.isFinite(margin) || margin <= 0) return 0
              return Math.min(
                this.options.maxLevel,
                Math.max(0, Math.round(margin / 24))
              )
            },
            renderHTML: (attributes) => {
              const level = Number(attributes.indent ?? 0)
              if (!level || level <= 0) return {}
              return { style: `margin-left: ${level * 24}px` }
            }
          }
        }
      }
    ]
  },

  addCommands() {
    const updateIndent =
      (delta: number) =>
      ({ tr, state, dispatch }: { tr: any; state: any; dispatch?: any }) => {
        const { selection } = state
        const { from, to } = selection
        let changed = false

        state.doc.nodesBetween(from, to, (node: any, pos: number) => {
          if (!this.options.types.includes(node.type.name)) return
          const current = Number(node.attrs.indent ?? 0) || 0
          const next = Math.min(
            this.options.maxLevel,
            Math.max(this.options.minLevel, current + delta)
          )
          if (next !== current) {
            tr = tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              indent: next
            })
            changed = true
          }
        })

        if (changed && dispatch) dispatch(tr)
        return changed
      }

    return {
      indent: () => updateIndent(1),
      outdent: () => updateIndent(-1)
    }
  }
})
