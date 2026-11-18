import { htmlFragment } from './bridge'
import documentCss from './document.css?raw'
import type { Preferences } from './workspace'

export type ExportFormat = 'html' | 'pdf' | 'docx'

export function fontStack(font: string) {
  const fallback = '"Segoe UI", "Microsoft YaHei UI", sans-serif'
  return font === '系统默认' ? fallback : `${JSON.stringify(font.replace(/[\n\r\f]/g, ''))}, ${fallback}`
}

const escape = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)

export async function readyImages(root: ParentNode) {
  await Promise.all([...root.querySelectorAll<HTMLImageElement>('img')].map(async image => {
    try {
      await image.decode()
    } catch {
      throw new Error(`无法加载图片 ${image.dataset.source || image.alt}`)
    }
  }))
}

export function htmlExport(name: string, html: string, prefs: Preferences) {
  const body = document.createElement('main')
  body.className = 'markdown'
  body.style.setProperty('--doc-font', fontStack(prefs.font))
  body.style.setProperty('--doc-size', `${prefs.size}px`)
  body.append(htmlFragment(html))
  return new TextEncoder().encode(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(name)}</title>
<style>
${documentCss}
body { margin: 0; background: white; }
main { box-sizing: border-box; max-width: 860px; padding: 40px 32px; margin: auto; }
@media print { main { max-width: none; padding: 0; } }
</style>
</head>
<body>${body.outerHTML}</body>
</html>`)
}
