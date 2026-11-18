import type { EditorView } from '@codemirror/view'

type Anchor = { line: number; y: number }
const probe = 34

function interpolate(anchors: Anchor[], value: number, input: keyof Anchor, output: keyof Anchor) {
  let low = 0
  let high = anchors.length - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (anchors[mid][input] <= value) low = mid
    else high = mid
  }
  const from = anchors[low]
  const to = anchors[high]
  if (!from || !to) return 0
  const span = to[input] - from[input]
  const ratio = span ? Math.max(0, Math.min(1, (value - from[input]) / span)) : 0
  return from[output] + ratio * (to[output] - from[output])
}

export function previewAnchors(pane: HTMLElement, count: number) {
  const bounds = pane.getBoundingClientRect()
  const anchors: Anchor[] = [{ line: 1, y: 0 }]
  for (const node of pane.querySelectorAll<HTMLElement>('[data-line]')) {
    const rect = node.getBoundingClientRect()
    const line = Number(node.dataset.line)
    const prior = anchors[anchors.length - 1]
    const y = line === 1 ? 0 : Math.max(0, rect.top - bounds.top + pane.scrollTop - probe)
    if (line > prior.line && y > prior.y) anchors.push({ line, y })
    // Code fences map their interior lines to the height of the highlighted block.
    const end = Number(node.dataset.end)
    if (node.tagName === 'PRE' && end > line) {
      anchors.push({ line: end, y: Math.max(y, prior.y) + Math.max(1, rect.height - 20) })
    }
  }
  const last = anchors[anchors.length - 1]
  const body = pane.firstElementChild
  const tail = body ? Number.parseFloat(getComputedStyle(body).paddingBottom) : 0
  anchors.push({ line: Math.max(count + 1, last.line + 1), y: Math.max(last.y + 1, pane.scrollHeight - tail - probe) })
  return anchors
}

function maxScroll(pane: HTMLElement) {
  return Math.max(0, pane.scrollHeight - pane.clientHeight)
}

export function editorLine(view: EditorView) {
  const pane = view.scrollDOM
  if (pane.scrollTop < 1) return 1
  if (maxScroll(pane) - pane.scrollTop < 1) return view.state.doc.lines
  const height = pane.getBoundingClientRect().top + probe - view.documentTop
  const block = view.lineBlockAtHeight(height)
  const line = view.state.doc.lineAt(block.from).number
  return line + Math.max(0, Math.min(0.99, (height - block.top) / Math.max(1, block.height)))
}

export function editorScrollTop(view: EditorView, line: number) {
  const doc = view.state.doc
  if (line <= 1) return 0
  if (line >= doc.lines) return maxScroll(view.scrollDOM)
  const block = view.lineBlockAt(doc.line(Math.floor(line)).from)
  const pane = view.scrollDOM
  return pane.scrollTop + view.documentTop + block.top + (line % 1) * block.height - pane.getBoundingClientRect().top - probe
}

export function previewLine(pane: HTMLElement, anchors: Anchor[], count: number) {
  if (pane.scrollTop < 1) return 1
  if (maxScroll(pane) - pane.scrollTop < 1) return count
  return interpolate(anchors, pane.scrollTop, 'y', 'line')
}

export function scrollPreview(pane: HTMLElement, anchors: Anchor[], line: number, count: number) {
  pane.scrollTop = line >= count ? maxScroll(pane) : interpolate(anchors, line, 'line', 'y')
}
