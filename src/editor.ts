import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView, drawSelection, highlightActiveLine, keymap, placeholder, scrollPastEnd } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'

export function makeEditorState(text: string, onUpdate: (update: ViewUpdate) => void) {
  return EditorState.create({
    doc: text,
    extensions: [
      history(), drawSelection(), highlightActiveLine(),
      markdown(), syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping, scrollPastEnd(),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      placeholder('从这里开始写 Markdown…'),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown 编辑器', spellcheck: 'false' }),
      EditorView.updateListener.of(onUpdate),
    ],
  })
}
