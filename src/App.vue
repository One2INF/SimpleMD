<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { NConfigProvider, NDropdown, NModal, NSelect, NInputNumber } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import {
  BookOpen, ChevronDown, Columns2, Copy, Download, Eye,
  Minus, PanelLeftClose, PanelLeftOpen, Pencil, Plus,
  Settings2, Square, X,
} from 'lucide-vue-next'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open, save } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { EditorView } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { resolveImages, writeExport } from './bridge'
import { makeEditorState } from './editor'
import { fontStack, htmlExport, readyImages } from './export'
import type { ExportFormat } from './export'
import { guide } from './guide'
import { renderMarkdown } from './markdown'
import { editorLine, editorScrollTop, previewAnchors, previewLine, scrollPreview } from './scroll'
import { basename, changed, useWorkspace, validatedPreferences } from './workspace'
import type { DocumentTab, Preferences, Theme, WorkspaceConfiguration, WorkspaceSession } from './workspace'

const store = useWorkspace()
const prefs = store.preferences
const active = computed(() => store.tabs.find(tab => tab.id === store.activeId))
const session = computed<WorkspaceSession>(() => ({
  files: store.tabs.flatMap(tab => tab.path ? [tab.path] : []),
  activePath: active.value?.path ?? null,
}))
const desktop = isTauri()
const appWindow = desktop ? getCurrentWindow() : undefined
const maximized = ref(false)
const maximizeLabel = computed(() => maximized.value ? '还原窗口' : '最大化窗口')
const initialized = ref(false)
const editorHost = ref<HTMLElement>()
const preview = ref<HTMLElement>()
const article = ref<HTMLElement>()
const grid = ref<HTMLElement>()
const printArticle = ref<HTMLElement>()
const printDocument = shallowRef<{ html: string; preferences: Preferences }>()
const settings = ref(false)
const fonts = ref(['系统默认', 'Microsoft YaHei UI', 'Segoe UI', 'Consolas'])
const fontOptions = computed(() => [...new Set([...fonts.value, prefs.font])].map(font => ({ label: font, value: font })))
const notice = ref('就绪')
const noticeType = ref<'ok' | 'error'>('ok')
const isBusy = ref(true)
const dragging = ref<'outline' | 'split' | null>(null)
const readingLine = ref(1)
const navigationLine = ref(1)
const assetCache = shallowRef(new Map<string, string>())
const rendered = computed(() => renderMarkdown(active.value?.text ?? '', assetCache.value))
const lineCount = computed(() => active.value?.text.split('\n').length ?? 0)
const charCount = computed(() => Array.from(active.value?.text ?? '').length)
const currentHeading = computed(() => rendered.value.headings.findLast(heading => heading.line <= navigationLine.value))
const modeOptions = [
  { key: 'edit', label: '编辑', icon: Pencil },
  { key: 'split', label: '分栏', icon: Columns2 },
  { key: 'preview', label: '预览', icon: Eye },
] as const
const themes: { key: Theme; label: string }[] = [
  { key: 'light', label: '浅色' }, { key: 'sage', label: '豆沙绿' }, { key: 'wood', label: '原木色' },
]
const exportOptions: DropdownOption[] = [
  { key: 'html', label: 'html' }, { key: 'pdf', label: 'pdf' }, { key: 'docx', label: 'docx' },
]
const markdownFilters = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdx', 'txt'] }]
const defaultThemeOverrides = {
  common: {
    primaryColor: '#38674f', primaryColorHover: '#477a60', primaryColorPressed: '#2e5641',
    borderRadius: '8px', fontFamily: '"Segoe UI", "Microsoft YaHei UI", sans-serif',
  },
}
const gridStyle = computed(() => ({
  '--outline-width': prefs.outline ? `${prefs.outlineWidth}px` : '0px',
  '--outline-divider': prefs.outline ? '1px' : '0px',
  '--left-track': prefs.mode === 'preview' ? '0fr' : prefs.mode === 'edit' ? '1fr' : `${prefs.split}fr`,
  '--right-track': prefs.mode === 'edit' ? '0fr' : prefs.mode === 'preview' ? '1fr' : `${1 - prefs.split}fr`,
  '--split-divider': prefs.mode === 'split' ? '1px' : '0px',
  '--doc-font': fontStack(prefs.font),
  '--doc-size': `${prefs.size}px`,
}))
const unlisten: (() => void)[] = []
let view: EditorView | undefined
let expectedEdit = -1
let expectedPreview = -1
let anchorCache: ReturnType<typeof previewAnchors> | undefined
let observer: ResizeObserver | undefined
let configurationLoaded = false
let configurationTimer: ReturnType<typeof setTimeout> | undefined
let configurationWrites = Promise.resolve()
let layoutFrame = 0
let restoreEditorOnFrame = false
let layoutTimer: ReturnType<typeof setTimeout> | undefined
let running: Promise<unknown> | undefined
let startupPending = false

function status(message: string, error = false) {
  notice.value = message
  noticeType.value = error ? 'error' : 'ok'
}

async function action(operation: () => Promise<unknown>) {
  if (!initialized.value || running) return
  isBusy.value = true
  const result = Promise.resolve().then(operation)
  running = result
  try { await result }
  catch (error) { status(String(error), true) }
  finally {
    running = undefined
    isBusy.value = false
    if (startupPending) void drainStartup()
  }
}

function writeConfiguration() {
  clearTimeout(configurationTimer)
  // Wait for the original snapshot before saving so partial startup state cannot replace it.
  if (!configurationLoaded || !initialized.value) return configurationWrites
  const configuration: WorkspaceConfiguration = { preferences: { ...prefs }, session: session.value }
  configurationWrites = configurationWrites.then(() =>
    invoke<void>('save_configuration', { configuration }).catch(error => status(`配置保存失败 · ${error}`, true)))
  return configurationWrites
}

watch([prefs, session], () => {
  if (!configurationLoaded || !initialized.value || dragging.value) return
  clearTimeout(configurationTimer)
  configurationTimer = setTimeout(writeConfiguration, 130)
}, { deep: true })

function editorUpdate(update: ViewUpdate) {
  const tab = active.value
  if (!tab) return
  tab.editor = update.state
  if (update.docChanged) tab.text = update.state.doc.toString()
  if (update.selectionSet || update.docChanged) {
    const cursor = update.state.selection.main.head
    const line = update.state.doc.lineAt(cursor)
    tab.line = line.number
    tab.column = Array.from(update.state.sliceDoc(line.from, cursor)).length + 1
    navigationLine.value = tab.line
  }
}

function attachEditor(tab: DocumentTab) {
  if (!view) return
  if (!tab.editor) tab.editor = makeEditorState(tab.text, editorUpdate)
  view.setState(tab.editor)
}

function selectTab(tab: DocumentTab, focus = false) {
  if (active.value?.id === tab.id) return
  store.activeId = tab.id
  assetCache.value = new Map()
  readingLine.value = tab.readingLine
  navigationLine.value = prefs.mode === 'preview' ? tab.readingLine : tab.line
  attachEditor(tab)
  scheduleLayout()
  void nextTick(() => {
    document.querySelector('.active-tab')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (focus && prefs.mode !== 'preview') view?.focus()
  })
}

function addDocument() {
  selectTab(store.add(), true)
  status('已新建文档')
}

async function openPath(path: string) {
  const result = await invoke<{ id: string; path: string; text: string }>('open_document', {
    id: crypto.randomUUID(), path,
  })
  return store.tabs.find(tab => tab.id === result.id) ?? store.add(result.text, result.path, undefined, result.id)
}

async function restoreSession(previous: WorkspaceSession) {
  let selected: DocumentTab | undefined
  const unavailable: string[] = []
  for (const path of previous.files) {
    try {
      const tab = await openPath(path)
      if (path === previous.activePath) selected = tab
    } catch {
      unavailable.push(basename(path))
    }
  }
  selected ??= store.tabs[0]
  if (selected) {
    selectTab(selected)
    status(`已恢复 ${store.tabs.length} 个文件`)
  }
  return unavailable
}

async function openPaths(paths: string[]) {
  let opened = false
  for (const path of paths) {
    try {
      const tab = await openPath(path)
      selectTab(tab)
      opened = true
      status(`已打开 ${tab.name}`)
    } catch (error) {
      status(`打开 ${basename(path)} 失败 · ${error}`, true)
    }
  }
  return opened
}

async function chooseDocuments() {
  const paths = await open({ multiple: true, filters: markdownFilters, title: '打开 Markdown 文档' })
  if (paths) await openPaths(Array.isArray(paths) ? paths : [paths])
}

async function drainStartup() {
  if (running || !initialized.value) { startupPending = true; return }
  startupPending = false
  await action(async () => openPaths(await invoke<string[]>('take_startup_files')))
}

async function saveTab(tab: DocumentTab, as = false) {
  try {
    const path = tab.path && !as ? tab.path : await save({
      title: '保存 Markdown 文档', defaultPath: tab.path ?? tab.name, filters: markdownFilters,
    })
    if (!path) return false
    const text = tab.text
    tab.path = await invoke<string>('save_document', { id: tab.id, path, text: text.replaceAll('\n', tab.lineEnding) })
    tab.name = basename(tab.path)
    tab.saved = text
    status(`已保存 ${tab.name}`)
    return true
  } catch (error) {
    status(`保存失败 · ${error}`, true)
    return false
  }
}

function saveActive(as = false) {
  const tab = active.value
  if (tab) void action(() => saveTab(tab, as))
}

const pending = shallowRef<{ tab: DocumentTab; exit: boolean; resolve: (value: string) => void }>()
function confirm(tab: DocumentTab, exit: boolean) {
  return new Promise<string>(resolve => { pending.value = { tab, exit, resolve } })
}
function respond(value: string) {
  const dialog = pending.value
  pending.value = undefined
  dialog?.resolve(value)
}

async function mayClose(tab: DocumentTab, exit = false) {
  while (changed(tab)) {
    const choice = await confirm(tab, exit)
    if (choice === 'discard') return true
    if (choice !== 'save' || !await saveTab(tab)) return false
  }
  return true
}

async function closeTab(tab: DocumentTab) {
  if (!await mayClose(tab)) return
  if (desktop) await invoke('close_document', { id: tab.id })
  const wasActive = active.value?.id === tab.id
  store.remove(tab.id)
  if (wasActive) {
    const next = active.value
    store.activeId = ''
    if (next) selectTab(next)
    else view?.setState(makeEditorState('', editorUpdate))
  }
  status(`已关闭 ${tab.name}`)
}

async function exitApp() {
  for (const tab of store.tabs) if (!await mayClose(tab, true)) return
  await writeConfiguration()
  await appWindow?.destroy()
}

function windowControl(command: 'minimize' | 'toggleMaximize' | 'close') {
  // A close request must go through the same save prompt as a system close.
  void appWindow?.[command]().catch(error => status(`窗口操作失败 · ${error}`, true))
}

async function exportDocument(format: ExportFormat) {
  const tab = active.value
  if (!tab) return
  const stem = tab.name.replace(/\.[^.]+$/, '')
  const ext = { html: 'HTML 网页', pdf: 'PDF 文档', docx: 'Word 文档' }
  try {
    const path = await save({
      title: `导出 ${ext[format]}`,
      defaultPath: tab.path ? tab.path.replace(/\.[^.\\/]+$/, '') + '.' + format : stem + '.' + format,
      filters: [{ name: ext[format], extensions: [format] }],
    })
    if (!path) return
    const text = tab.text
    const snapshot = { ...prefs }
    status(`正在生成 ${format.toUpperCase()}…`)
    const { assets, failures } = await resolveImages(renderMarkdown(text).html, tab.id, true)
    if (failures.length) throw new Error(`无法嵌入图片 ${failures[0]}`)
    const html = renderMarkdown(text, assets).html
    if (format === 'html') {
      await writeExport(path, htmlExport(stem, html, snapshot))
    } else if (format === 'docx') {
      const { docxExport } = await import('./docx')
      await writeExport(path, await docxExport(stem, html, snapshot))
    } else {
      printDocument.value = { html, preferences: snapshot }
      await nextTick()
      if (!printArticle.value) throw new Error('打印内容未准备就绪')
      await Promise.all([readyImages(printArticle.value), document.fonts.ready])
      await invoke('print_pdf', { path })
    }
    status(`已导出 ${basename(path)}`)
  } catch (error) {
    status(`导出失败 · ${error}`, true)
  } finally {
    printDocument.value = undefined
  }
}

watch(() => [active.value?.id, active.value?.path, active.value?.text] as const, ([id, path, text], previous, onCleanup) => {
  if (previous && previous[1] !== path) assetCache.value = new Map()
  if (!id || !path || text === undefined) return
  let obsolete = false
  const timer = setTimeout(async () => {
    const { assets } = await resolveImages(renderMarkdown(text).html, id)
    if (!obsolete) assetCache.value = assets
  }, 140)
  onCleanup(() => { obsolete = true; clearTimeout(timer) })
})

function getAnchors() {
  if (!preview.value) return []
  return anchorCache ??= previewAnchors(preview.value, lineCount.value)
}

function rememberLine(line: number) {
  readingLine.value = line
  navigationLine.value = line
  if (active.value) active.value.readingLine = line
}

function setPreview(line: number) {
  const pane = preview.value
  if (!pane || prefs.mode === 'edit') return
  scrollPreview(pane, getAnchors(), line, lineCount.value)
  expectedPreview = pane.scrollTop
}

function setEditor(line: number) {
  if (!view || prefs.mode === 'preview') return
  view.scrollDOM.scrollTop = editorScrollTop(view, line)
  expectedEdit = view.scrollDOM.scrollTop
}

function fromEditor() {
  if (!view || !active.value || prefs.mode === 'preview') return
  if (layoutTimer || dragging.value || layoutFrame) return
  if (Math.abs(expectedEdit - view.scrollDOM.scrollTop) < 1) return
  expectedEdit = -1
  const line = editorLine(view)
  rememberLine(line)
  setPreview(line)
}

function fromPreview() {
  const pane = preview.value
  if (!pane || !active.value || prefs.mode === 'edit') return
  if (layoutTimer || dragging.value || layoutFrame) return
  if (Math.abs(expectedPreview - pane.scrollTop) < 1) return
  expectedPreview = -1
  const line = previewLine(pane, getAnchors(), lineCount.value)
  rememberLine(line)
  setEditor(line)
}

function scheduleLayout(restoreEditor = true) {
  anchorCache = undefined
  restoreEditorOnFrame ||= restoreEditor
  if (layoutFrame || layoutTimer || dragging.value) return
  layoutFrame = requestAnimationFrame(() => {
    // CodeMirror must measure wrapping at the final width before applying the saved line.
    if (restoreEditorOnFrame && prefs.mode !== 'preview') {
      view?.requestMeasure({
        key: scheduleLayout,
        read: editor => editorScrollTop(editor, readingLine.value),
        write: (top, editor) => {
          if (layoutTimer || dragging.value) return
          editor.scrollDOM.scrollTop = top
          expectedEdit = editor.scrollDOM.scrollTop
        },
      })
    }
    setPreview(readingLine.value)
    restoreEditorOnFrame = false
    layoutFrame = 0
  })
}

watch(() => rendered.value.html, () => scheduleLayout(false), { flush: 'post' })
watch(() => [prefs.size, prefs.font], () => scheduleLayout(), { flush: 'post' })
watch(() => prefs.mode, mode => {
  if (mode === 'preview') navigationLine.value = readingLine.value
})
watch(() => [prefs.mode, prefs.outline, prefs.outlineWidth, prefs.split], () => {
  if (dragging.value) return
  clearTimeout(layoutTimer)
  layoutTimer = setTimeout(() => {
    layoutTimer = undefined
    scheduleLayout()
  }, 250)
}, { flush: 'sync' })

function goTo(line: number) {
  rememberLine(line)
  if (view && prefs.mode !== 'preview') {
    const target = view.state.doc.line(line)
    view.dispatch({ selection: { anchor: target.from } })
  }
  setEditor(line)
  setPreview(line)
}

function goToAnchor(value: string) {
  let id = value
  try { id = decodeURIComponent(id) } catch { /* Keep a literal anchor. */ }
  const heading = rendered.value.headings.find(item => item.id === id)
  if (heading) goTo(heading.line)
}

function linkClick(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
  if (!link) return
  event.preventDefault()
  const href = link.getAttribute('href') ?? ''
  if (href.startsWith('#')) {
    goToAnchor(href.slice(1))
  } else if (/^(https?:\/\/|mailto:|tel:)/i.test(href)) {
    if (desktop) void openUrl(href).catch(error => status(`无法打开链接 · ${error}`, true))
    else window.open(href, '_blank', 'noopener,noreferrer')
  } else if (href && desktop && active.value) {
    const id = active.value.id
    void action(async () => {
      try {
        const [relative, fragment] = href.split('#', 2)
        const path = await invoke<string>('resolve_document_link', {
          id, relative: decodeURIComponent(relative.split('?', 1)[0]),
        })
        const opened = await openPaths([path])
        if (opened && fragment) { await nextTick(); goToAnchor(fragment) }
      } catch (error) { status(`无法打开链接 · ${error}`, true) }
    })
  }
}

function resize(event: PointerEvent, handle: 'outline' | 'split') {
  if (!grid.value || dragging.value || event.button !== 0) return
  event.preventDefault()
  dragging.value = handle
  const bounds = grid.value.getBoundingClientRect()
  const left = bounds.left + (prefs.outline ? prefs.outlineWidth + 1 : 0)
  const width = bounds.right - left
  const listeners = new AbortController()
  const options = { capture: true, signal: listeners.signal }
  const move = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return
    if (handle === 'outline') prefs.outlineWidth = Math.round(Math.max(160, Math.min(360, e.clientX - bounds.left)))
    else prefs.split = Math.max(0.25, Math.min(0.75, (e.clientX - left) / width))
  }
  const finish = () => {
    listeners.abort()
    dragging.value = null
    scheduleLayout()
    void writeConfiguration()
  }
  const release = (e: PointerEvent) => { if (e.pointerId === event.pointerId) finish() }
  // The narrow divider moves with the pointer, so track the drag at the window level.
  window.addEventListener('pointermove', move, options)
  window.addEventListener('pointerup', release, options)
  window.addEventListener('pointercancel', release, options)
  window.addEventListener('blur', finish, options)
}

function keyResize(event: KeyboardEvent, handle: 'outline' | 'split') {
  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!direction) return
  event.preventDefault()
  if (handle === 'outline') prefs.outlineWidth = Math.max(160, Math.min(360, prefs.outlineWidth + direction * 12))
  else prefs.split = Math.max(0.25, Math.min(0.75, prefs.split + direction * 0.025))
}

function toggleOutline() {
  prefs.outline = !prefs.outline
}

function shortcuts(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'F12' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    event.preventDefault()
    if (!event.repeat && !settings.value && !pending.value) toggleOutline()
    return
  }
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return
  const key = event.key.toLowerCase()
  if (!['n', 'o', 's', 'w', '1', '2', '3'].includes(key)) return
  event.preventDefault()
  if (isBusy.value || settings.value || pending.value) return
  if (key === 'n') addDocument()
  else if (key === 'o') void action(chooseDocuments)
  else if (key === 's') saveActive(event.shiftKey)
  else if (key === 'w' && active.value) void action(() => closeTab(active.value!))
  else if (key === '1' || key === '2' || key === '3') prefs.mode = modeOptions[Number(key) - 1].key
}

onMounted(async () => {
  view = new EditorView({ parent: editorHost.value!, state: makeEditorState('', editorUpdate) })
  view.scrollDOM.addEventListener('scroll', fromEditor, { passive: true })
  window.addEventListener('keydown', shortcuts)
  observer = new ResizeObserver(entries => {
    let resizedPane = false
    for (const entry of entries) {
      if (entry.target === preview.value) {
        preview.value.style.setProperty('--preview-tail', `${Math.max(0, entry.contentRect.height - 55)}px`)
        resizedPane = true
      }
      if (entry.target === editorHost.value) resizedPane = true
    }
    scheduleLayout(resizedPane)
  })
  if (article.value) observer.observe(article.value)
  if (preview.value) observer.observe(preview.value)
  if (editorHost.value) observer.observe(editorHost.value)
  let unavailable: string[] = []
  if (appWindow) {
    try {
      unlisten.push(await appWindow.onCloseRequested(event => {
        event.preventDefault()
        if (!running) void action(exitApp)
      }))
      unlisten.push(await listen('simplemd-open-files', () => { void drainStartup() }))
      unlisten.push(await appWindow.onDragDropEvent(event => {
        if (event.payload.type === 'drop') {
          const paths = event.payload.paths
          void action(() => openPaths(paths))
        }
      }))
      void invoke<string[]>('system_fonts').then(list => { fonts.value = [...fonts.value, ...list] }).catch(() => {})
      const syncMaximized = () => {
        void appWindow.isMaximized().then(value => { maximized.value = value }).catch(() => {})
      }
      unlisten.push(await appWindow.onResized(syncMaximized))
      syncMaximized()
      const configuration = await invoke<WorkspaceConfiguration>('load_configuration')
      Object.assign(prefs, validatedPreferences(configuration.preferences))
      unavailable = await restoreSession(configuration.session)
      configurationLoaded = true
    } catch (error) { status(`工作区初始化失败 · ${error}`, true) }
  }
  initialized.value = true
  isBusy.value = false
  // Explicit launch arguments open after the restored session and take focus.
  if (desktop) await drainStartup()
  if (!store.tabs.length) selectTab(store.add(guide, null, '使用指南.md'))
  if (unavailable.length) status(`未能恢复 ${unavailable.length} 个文件 · ${unavailable.join('、')}`, true)
  await writeConfiguration()
})

onBeforeUnmount(() => {
  unlisten.forEach(stop => stop())
  window.removeEventListener('keydown', shortcuts)
  observer?.disconnect()
  cancelAnimationFrame(layoutFrame)
  clearTimeout(layoutTimer)
  clearTimeout(configurationTimer)
  view?.destroy()
})
</script>

<template>
  <NConfigProvider :theme-overrides="defaultThemeOverrides">
    <div class="app-shell" :data-theme="prefs.theme">
      <header class="toolbar flex items-center gap-3" data-tauri-drag-region>
        <div class="toolbar-brand" data-tauri-drag-region="deep">
          <span class="toolbar-brand-mark" aria-hidden="true"></span>
          <div class="toolbar-brand-copy">
            <strong class="toolbar-brand-name">SimpleMD</strong>
            <span class="toolbar-brand-tagline">less is more, simple is good</span>
          </div>
        </div>
        <div class="toolbar-drag" data-tauri-drag-region></div>
        <div class="flex items-center gap-3">
          <button class="icon-button outline-toggle" :class="{ selected: prefs.outline }" :title="prefs.outline ? '隐藏目录 · F12' : '显示目录 · F12'"
            :aria-label="prefs.outline ? '隐藏目录' : '显示目录'" :aria-pressed="prefs.outline" aria-keyshortcuts="F12" @click="toggleOutline">
            <PanelLeftClose v-if="prefs.outline" :size="18" /><PanelLeftOpen v-else :size="18" />
          </button>
          <div class="mode-control flex items-center" aria-label="工作区视图">
            <button v-for="mode in modeOptions" :key="mode.key" :aria-pressed="prefs.mode === mode.key"
              :class="{ 'mode-current': prefs.mode === mode.key }" @click="prefs.mode = mode.key">
              <component :is="mode.icon" :size="14" />{{ mode.label }}
            </button>
          </div>
          <NDropdown trigger="click" :options="exportOptions" :disabled="!active || isBusy"
            @select="key => action(() => exportDocument(key as ExportFormat))">
            <button class="tool-button export-button" :disabled="isBusy || !active"><Download :size="16" />导出<ChevronDown :size="13" /></button>
          </NDropdown>
          <button class="icon-button" title="设置" aria-label="设置" @click="settings = true">
            <Settings2 :size="17" />
          </button>
        </div>
        <div v-if="desktop" class="window-controls flex items-center" role="group" aria-label="窗口控制">
          <button class="icon-button" title="最小化窗口" aria-label="最小化窗口" @click="windowControl('minimize')">
            <Minus :size="17" />
          </button>
          <button class="icon-button" :title="maximizeLabel" :aria-label="maximizeLabel" @click="windowControl('toggleMaximize')">
            <Copy v-if="maximized" :size="14" /><Square v-else :size="14" />
          </button>
          <button class="icon-button window-close" title="关闭窗口" aria-label="关闭窗口"
            :disabled="!initialized || isBusy" @click="windowControl('close')">
            <X :size="18" />
          </button>
        </div>
      </header>

      <nav class="tabbar flex items-end" aria-label="打开的文档">
        <div class="tab-strip flex items-end">
          <div v-for="tab in store.tabs" :key="tab.id" class="tab" :class="{ 'active-tab': tab.id === store.activeId }">
            <button class="tab-label" :title="tab.path ?? tab.name" :aria-current="tab.id === store.activeId"
              @click="selectTab(tab)" @auxclick.middle.prevent="action(() => closeTab(tab))">
              <span>{{ tab.name }}</span>
            </button>
            <button class="tab-close" :class="{ modified: changed(tab) }" :disabled="isBusy"
              :title="changed(tab) ? '关闭（有未保存的修改）' : '关闭'" :aria-label="`关闭 ${tab.name}`"
              @click="action(() => closeTab(tab))">
              <span v-if="changed(tab)" class="dirty-dot"></span><X :size="14" />
            </button>
          </div>
        </div>
        <button class="icon-button new-tab" title="新建标签 · Ctrl+N" aria-label="新建标签" :disabled="isBusy" @click="addDocument">
          <Plus :size="17" />
        </button>
      </nav>

      <div ref="grid" class="workspace-grid" :class="{ resizing: dragging }" :style="gridStyle">
        <aside class="pane outline-pane" aria-label="文章目录" :class="{ collapsed: !prefs.outline }" :inert="!prefs.outline">
          <div class="outline-items" aria-label="章节">
            <button v-for="heading in rendered.headings" :key="heading.id" class="outline-entry"
              :class="{ 'current-heading': currentHeading?.id === heading.id }"
              :style="{ '--depth': heading.level - 1 }" :title="heading.title"
              :aria-current="currentHeading?.id === heading.id ? 'location' : undefined" @click="goTo(heading.line)">
              <span>{{ heading.title }}</span>
            </button>
            <p v-if="!rendered.headings.length" class="outline-empty">文档中的标题会显示在这里。</p>
          </div>
        </aside>
        <div class="divider" :class="{ collapsed: !prefs.outline }" role="separator" aria-label="调整目录宽度"
          aria-orientation="vertical" :tabindex="prefs.outline ? 0 : -1" @pointerdown="resize($event, 'outline')" @keydown="keyResize($event, 'outline')"></div>
        <section class="pane editor-pane" aria-label="编辑器" :class="{ collapsed: prefs.mode === 'preview' }" :inert="prefs.mode === 'preview' || !active">
          <div ref="editorHost" class="editor-content"></div>
        </section>
        <div class="divider" :class="{ collapsed: prefs.mode !== 'split' }" role="separator" aria-label="调整编辑和预览宽度"
          aria-orientation="vertical" :tabindex="prefs.mode === 'split' ? 0 : -1" @pointerdown="resize($event, 'split')" @keydown="keyResize($event, 'split')"></div>
        <section class="pane preview-pane" aria-label="预览" :class="{ collapsed: prefs.mode === 'edit' }" :inert="prefs.mode === 'edit'">
          <div ref="preview" class="preview-scroll" @scroll.passive="fromPreview" @load.capture="scheduleLayout(false)">
            <article ref="article" class="markdown preview-body" v-html="rendered.html" @click="linkClick"></article>
          </div>
        </section>
        <div v-if="!active" class="empty-workspace">
          <BookOpen :size="37" :stroke-width="1.55" />
          <h2>打开一份 Markdown 文档</h2>
          <div class="flex gap-2">
            <button class="tool-button" :disabled="isBusy" @click="addDocument">新建文档</button>
            <button class="primary" :disabled="isBusy" @click="action(chooseDocuments)">打开文件</button>
          </div>
        </div>
      </div>

      <footer class="statusbar flex items-center justify-between gap-4">
        <span class="operation-status" :class="{ 'status-error': noticeType === 'error' }" :title="notice" role="status">
          <span class="status-dot"></span><span>{{ notice }}</span>
        </span>
        <div v-if="active" class="status-details">
          <span>{{ charCount.toLocaleString() }} 字符</span><span>{{ lineCount.toLocaleString() }} 行</span>
          <span>行 {{ active.line }}，列 {{ active.column }}</span><span>UTF-8</span>
        </div>
      </footer>
    </div>

    <NModal v-model:show="settings">
      <div class="dialog-card" role="dialog" aria-label="工作区设置">
        <header class="dialog-header"><h2>工作区设置</h2><button class="icon-button" aria-label="关闭设置" @click="settings = false"><X :size="19" /></button></header>
        <div class="settings-field">
          <span>主题</span>
          <div class="theme-choices">
            <button v-for="theme in themes" :key="theme.key" :class="{ 'theme-current': prefs.theme === theme.key }"
              :aria-pressed="prefs.theme === theme.key" @click="prefs.theme = theme.key">
              <span class="swatch" :data-color="theme.key"></span>{{ theme.label }}
            </button>
          </div>
        </div>
        <label class="settings-field"><span>文档字体</span><NSelect v-model:value="prefs.font" :options="fontOptions" filterable aria-label="文档字体" /></label>
        <label class="settings-field"><span>字号（8–48 px）</span>
          <NInputNumber :value="prefs.size" :min="8" :max="48" :precision="0" aria-label="字号"
            @update:value="value => { if (value !== null) prefs.size = value }" />
        </label>
      </div>
    </NModal>

    <NModal :show="Boolean(pending)" @esc="respond('cancel')" @mask-click="respond('cancel')">
      <div v-if="pending" class="dialog-card confirm" role="alertdialog" aria-label="保存修改">
        <header class="dialog-header"><h2>保存修改</h2><button class="icon-button" aria-label="取消" @click="respond('cancel')"><X :size="19" /></button></header>
        <p>要在{{ pending.exit ? '退出 SimpleMD' : '关闭文档' }}前保存「{{ pending.tab.name }}」的修改吗？</p>
        <div class="dialog-actions">
          <button class="danger" @click="respond('discard')">不保存</button>
          <button class="secondary" @click="respond('cancel')">取消</button>
          <button class="primary" @click="respond('save')">保存</button>
        </div>
      </div>
    </NModal>

    <article v-if="printDocument" ref="printArticle" class="markdown print-document"
      :style="{ '--doc-font': fontStack(printDocument.preferences.font), '--doc-size': `${printDocument.preferences.size}px` }"
      v-html="printDocument.html"></article>
  </NConfigProvider>
</template>


