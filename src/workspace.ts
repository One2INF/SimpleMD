import { defineStore } from 'pinia'
import { reactive, ref, shallowReactive } from 'vue'
import type { EditorState } from '@codemirror/state'

export type ViewMode = 'edit' | 'split' | 'preview'
export type Theme = 'light' | 'sage' | 'wood'
export interface Preferences {
  theme: Theme
  font: string
  size: number
  mode: ViewMode
  outline: boolean
  outlineWidth: number
  split: number
}
export interface WorkspaceSession {
  files: string[]
  activePath: string | null
}
export interface WorkspaceConfiguration {
  preferences: Partial<Preferences> | null
  session: WorkspaceSession
}
export interface DocumentTab {
  id: string
  name: string
  path: string | null
  text: string
  saved: string
  lineEnding: string
  editor?: EditorState
  line: number
  column: number
  readingLine: number
}

export const defaultPreferences: Preferences = {
  theme: 'light', font: '系统默认', size: 15, mode: 'split',
  outline: true, outlineWidth: 224, split: 0.48,
}

const n = (value: unknown, min: number, max: number, otherwise: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : otherwise

export function validatedPreferences(value: Partial<Preferences> | null): Preferences {
  const defaults = defaultPreferences
  return {
    theme: value?.theme && ['light', 'sage', 'wood'].includes(value.theme) ? value.theme : defaults.theme,
    mode: value?.mode && ['edit', 'split', 'preview'].includes(value.mode) ? value.mode : defaults.mode,
    font: typeof value?.font === 'string' && value.font.trim() ? value.font : defaults.font,
    size: Math.round(n(value?.size, 8, 48, defaults.size)),
    outline: typeof value?.outline === 'boolean' ? value.outline : defaults.outline,
    outlineWidth: Math.round(n(value?.outlineWidth, 160, 360, defaults.outlineWidth)),
    split: n(value?.split, 0.25, 0.75, defaults.split),
  }
}

export const changed = (tab: DocumentTab) => tab.text !== tab.saved
export const basename = (path: string) => path.split(/[\\/]/).at(-1) || path
export const normalize = (text: string) => text.replace(/\r\n?/g, '\n')

export const useWorkspace = defineStore('workspace', () => {
  const tabs = shallowReactive<DocumentTab[]>([])
  const activeId = ref('')
  const preferences = reactive({ ...defaultPreferences })
  let unnamed = 0

  function add(text = '', path: string | null = null, name?: string, id: string = crypto.randomUUID()) {
    const normalized = normalize(text)
    const tab = shallowReactive<DocumentTab>({
      id, path, name: name ?? (path ? basename(path) : `未命名 ${++unnamed}.md`),
      text: normalized, saved: normalized, lineEnding: text.match(/\r\n|\r|\n/)?.[0] ?? '\n',
      line: 1, column: 1, readingLine: 1,
    })
    tabs.push(tab)
    return tab
  }

  function remove(id: string) {
    const index = tabs.findIndex(tab => tab.id === id)
    if (index < 0) return
    tabs.splice(index, 1)
    if (activeId.value === id) activeId.value = tabs[Math.max(0, index - 1)]?.id ?? ''
  }

  return { tabs, activeId, preferences, add, remove }
})

