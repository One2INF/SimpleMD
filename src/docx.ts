import {
  AlignmentType, Bookmark, BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun,
  InternalHyperlink, LevelFormat, Packer, Paragraph, ShadingType, Table, TableCell, TableRow,
  TextRun, WidthType,
} from 'docx'
import type { IParagraphOptions, IRunOptions, NumberingDefinition, ParagraphChild } from 'docx'
import { htmlFragment } from './bridge'
import documentCss from './document.css?raw'
import type { Preferences } from './workspace'

type Block = Paragraph | Table
const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
const headingSizes = [2.25, 1.48, 1.15, 1, 1, 1]
const mono = 'Consolas'
const fill = (color: string) => ({ type: ShadingType.CLEAR, fill: color })
const accent = '35664D'
const codeColors = new Map<string, string>()
for (const match of documentCss.matchAll(/:where\((\.hljs-[^)]+)\)\s*\{\s*color:\s*#([a-f0-9]{6})/gi)) {
  for (const selector of match[1].split(',')) codeColors.set(selector.slice(1), match[2].toUpperCase())
}

async function imageRun(node: HTMLImageElement) {
  const src = node.getAttribute('src')
  if (!src) throw new Error(`无法加载图片 ${node.alt}`)
  const image = new Image()
  image.src = src
  await image.decode()
  const scale = Math.min(1, 640 / image.naturalWidth, 900 / image.naturalHeight)
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法转换 DOCX 图片')
  ctx.drawImage(image, 0, 0, width, height)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(result => result ? resolve(result) : reject(new Error('无法编码 DOCX 图片'))))
  return new ImageRun({
    type: 'png', data: new Uint8Array(await blob.arrayBuffer()), transformation: { width, height },
    altText: { title: node.alt, description: node.alt, name: node.alt || '图片' },
  })
}

function textRuns(text: string, options: IRunOptions, preserveLines: boolean): TextRun[] {
  if (!preserveLines) return text ? [new TextRun({ ...options, text: text.replace(/[\n\t]/g, ' ') })] : []
  return text.replace(/\t/g, '    ').split('\n').flatMap((line, index) =>
    line || index ? [new TextRun({ ...options, text: line, break: index ? 1 : undefined })] : [])
}

export async function docxExport(name: string, html: string, settings: Preferences) {
  const tree = htmlFragment(html)
  const pointSize = Math.round(settings.size * 1.5) // CSS px to half-points.
  const face = settings.font === '系统默认' ? 'Microsoft YaHei' : settings.font
  const font = { ascii: face, hAnsi: face, eastAsia: face, cs: face }
  const bookmarks = new Map(
    [...tree.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')]
      .map((node, index) => [node.id, `heading_${index + 1}`]),
  )
  const numbering: NumberingDefinition[] = []

  async function inline(nodes: Iterable<Node>, style: IRunOptions = {}, code = false): Promise<ParagraphChild[]> {
    const result: ParagraphChild[] = []
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        result.push(...textRuns(node.textContent ?? '', style, code))
        continue
      }
      if (!(node instanceof HTMLElement)) continue
      const nested: IRunOptions = { ...style }
      const tag = node.tagName
      if (tag === 'BR') { result.push(new TextRun({ break: 1 })); continue }
      if (tag === 'IMG') { result.push(await imageRun(node as HTMLImageElement)); continue }
      if (tag === 'INPUT') {
        result.push(new TextRun({ ...nested, text: (node as HTMLInputElement).checked ? '☑' : '☐' }))
        continue
      }
      if (tag === 'STRONG') Object.assign(nested, { bold: true })
      if (tag === 'EM') Object.assign(nested, { italics: true })
      if (tag === 'S' || tag === 'DEL') Object.assign(nested, { strike: true })
      if (tag === 'CODE' && !code) Object.assign(nested, { font: mono, shading: fill('EAF1E9') })
      if (tag === 'SPAN' && code) {
        for (const cls of node.classList) {
          const color = codeColors.get(cls)
          if (color) Object.assign(nested, { color, italics: cls === 'hljs-comment' || cls === 'hljs-quote' })
        }
      }
      if (tag === 'A') Object.assign(nested, { color: accent, underline: {} })
      const children = await inline(node.childNodes, nested, code)
      if (tag === 'A') {
        const href = node.getAttribute('href') || ''
        let fragment = href.slice(1)
        try { fragment = decodeURIComponent(fragment) } catch { /* Keep the literal anchor. */ }
        const anchor = href.startsWith('#') ? bookmarks.get(fragment) : undefined
        if (anchor) { result.push(new InternalHyperlink({ anchor, children })); continue }
        if (href && !href.startsWith('#')) {
          result.push(new ExternalHyperlink({ link: href, children }))
          continue
        }
      }
      result.push(...children)
    }
    return result
  }

  async function blocks(nodes: Iterable<Node>, depth = 0, quote = false): Promise<Block[]> {
    const result: Block[] = []
    const left = depth * 360 + (quote ? 260 : 0)
    const options: IParagraphOptions = {
      indent: { left }, spacing: { after: 130, line: 330 },
      ...(quote ? { shading: fill('EAF1E9'), border: { left: { style: BorderStyle.SINGLE, size: 16, color: accent, space: 7 } } } : {}),
    }

    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue
      const tag = node.tagName
      if (/^H[1-6]$/.test(tag)) {
        const level = Number(tag[1]) - 1
        const children = await inline(node.childNodes, { bold: true, size: Math.round(pointSize * headingSizes[level]) })
        const id = bookmarks.get(node.id)
        result.push(new Paragraph({
          ...options, heading: headings[level], keepNext: true, keepLines: true,
          children: id ? [new Bookmark({ id, children })] : children,
          spacing: { before: 180, after: 130 },
        }))
      } else if (tag === 'BLOCKQUOTE') {
        result.push(...await blocks(node.childNodes, depth, true))
      } else if (tag === 'HR') {
        result.push(new Paragraph({ ...options, thematicBreak: true }))
      } else if (tag === 'PRE') {
        result.push(new Paragraph({
          ...options, shading: fill('202E29'), spacing: { before: 100, after: 160, line: 300 },
          children: await inline(node.childNodes, { font: mono, size: Math.round(pointSize * 0.91), color: 'DDE9DF' }, true),
        }))
      } else if (tag === 'TABLE') {
        const table = node as HTMLTableElement
        const rows: TableRow[] = []
        for (const row of table.rows) {
          const header = row.parentElement?.tagName === 'THEAD'
          const cells = await Promise.all([...row.cells].map(async cell => {
            const alignment = cell.style.textAlign === 'right' ? AlignmentType.RIGHT
              : cell.style.textAlign === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT
            return new TableCell({
              children: [new Paragraph({
                alignment, spacing: { after: 70, line: 300 },
                children: await inline(cell.childNodes, { bold: header }),
              })],
              shading: header ? fill('EAF1E9') : row.rowIndex % 2 === 0 ? fill('F6F8F4') : undefined,
              margins: { top: 90, bottom: 55, left: 130, right: 130 },
            })
          }))
          rows.push(new TableRow({ children: cells, tableHeader: header }))
        }
        result.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }))
      } else if (tag === 'OL' || tag === 'UL') {
        const reference = `list-${numbering.length + 1}`
        const ordered = tag === 'OL'
        numbering.push({
          reference, levels: [{
            level: 0, format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
            text: ordered ? '%1.' : '•', start: ordered ? (node as HTMLOListElement).start : 1,
            style: { paragraph: { indent: { left: left + 360, hanging: 260 } } },
          }],
        })
        for (const item of node.children) {
          const content = [...item.childNodes]
          const first = content.findIndex(child => child instanceof HTMLElement || child.textContent?.trim())
          const lead = content[first]
          const blockSelector = 'p,ul,ol,blockquote,pre,table,hr,h1,h2,h3,h4,h5,h6'
          const end = content.findIndex(child => child instanceof HTMLElement && child.matches(blockSelector))
          const paragraph = lead instanceof HTMLElement && lead.tagName === 'P'
          const head = paragraph ? lead.childNodes : content.slice(0, end < 0 ? undefined : end)
          result.push(new Paragraph({
            ...options, indent: { left: left + 360, hanging: item.classList.contains('task-item') ? 0 : 260 },
            spacing: { after: 65, line: 310 },
            numbering: item.classList.contains('task-item') ? undefined : { reference, level: 0 },
            children: await inline(head),
          }))
          const remainder = paragraph ? content.slice(first + 1) : end < 0 ? [] : content.slice(end)
          result.push(...await blocks(remainder, depth + 1, quote))
        }
      } else {
        result.push(new Paragraph({ ...options, children: await inline(node.childNodes) }))
      }
    }
    return result
  }

  const children = await blocks(tree.childNodes)
  const doc = new Document({
    title: name, creator: 'SimpleMD', numbering: { config: numbering },
    styles: { default: { document: { run: { font, size: pointSize, color: '283A33' } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 908, bottom: 908, left: 908, right: 908 } } },
      children: children.length ? children : [new Paragraph('')],
    }],
  })
  return (await Packer.toBlob(doc)).arrayBuffer()
}
