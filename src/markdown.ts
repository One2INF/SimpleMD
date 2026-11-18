import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import c from 'highlight.js/lib/languages/c'
import dos from 'highlight.js/lib/languages/dos'
import powershell from 'highlight.js/lib/languages/powershell'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import rust from 'highlight.js/lib/languages/rust'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'

for (const [name, language] of Object.entries({ bash, cpp, c, dos, powershell, javascript, typescript, rust, json, python, xml, css })) {
  hljs.registerLanguage(name, language)
}
hljs.registerAliases(['cmd', 'bat', 'batch'], { languageName: 'dos' })
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' })
hljs.registerAliases(['ps', 'ps1', 'pwsh'], { languageName: 'powershell' })
hljs.registerAliases(['c++'], { languageName: 'cpp' })

export interface Heading {
  id: string
  level: number
  line: number
  title: string
}
interface RenderContext {
  headings: Heading[]
  assets?: ReadonlyMap<string, string>
}
const escaped = (source: string) => md.utils.escapeHtml(source)

function code(source: string, language: string) {
  const lang = language.toLowerCase()
  return lang && hljs.getLanguage(lang)
    ? hljs.highlight(source, { language: lang, ignoreIllegals: true }).value
    : escaped(source)
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false })
const mapped = new Set(['paragraph_open', 'heading_open', 'list_item_open', 'tr_open', 'hr', 'blockquote_open'])

function plainText(tokens: Token[]): string {
  return tokens.map(token => token.type === 'image' ? plainText(token.children ?? [])
    : ['softbreak', 'hardbreak'].includes(token.type) ? ' ' : token.content).join('')
}

md.core.ruler.after('inline', 'simplemd_source_map', state => {
  const env = state.env as RenderContext
  const ids = new Set<string>()
  state.tokens.forEach((token, i) => {
    const line = token.map?.[0]
    if (line !== undefined && mapped.has(token.type)) token.attrSet('data-line', String(line + 1))
    if (token.type === 'heading_open' && line !== undefined) {
      const title = plainText(state.tokens[i + 1].children ?? []).trim()
      const base = title.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s+/g, '-') || 'heading'
      let id = base
      for (let suffix = 2; ids.has(id); suffix++) id = `${base}-${suffix}`
      ids.add(id)
      token.attrSet('id', id)
      env.headings.push({ id, level: Number(token.tag[1]), line: line + 1, title: title || '无标题' })
    }
    if (token.type === 'inline' && state.tokens[i - 1]?.type === 'paragraph_open'
      && state.tokens[i - 2]?.type === 'list_item_open') {
      const first = token.children?.[0]
      const match = first?.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null
      if (match && first && token.children) {
        first.content = first.content.slice(match[0].length)
        state.tokens[i - 2].attrJoin('class', 'task-item')
        const checkbox = new state.Token('task_checkbox', 'input', 0)
        checkbox.meta = match[1] !== ' '
        token.children.unshift(checkbox)
      }
    }
  })
})

md.renderer.rules.task_checkbox = (tokens, index) =>
  `<input class="task-check" type="checkbox" disabled aria-label="${tokens[index].meta ? '已完成' : '未完成'}"${tokens[index].meta ? ' checked' : ''}> `

const renderCode: NonNullable<typeof md.renderer.rules.fence> = (tokens, index) => {
  const token = tokens[index]
  const language = md.utils.unescapeAll(token.info.trim()).split(/\s+/, 1)[0] || ''
  return `<pre data-line="${(token.map?.[0] ?? 0) + 1}" data-end="${token.map?.[1] ?? 1}"${language ? ` data-language="${escaped(language)}"` : ''}><code class="hljs">${code(token.content, language)}</code></pre>\n`
}
md.renderer.rules.fence = renderCode
md.renderer.rules.code_block = renderCode

const image = md.renderer.rules.image!
md.renderer.rules.image = (tokens, index, options, env: RenderContext, renderer) => {
  const token = tokens[index]
  const source = token.attrGet('src') ?? ''
  const resolved = env.assets?.get(source)
  token.attrSet('data-source', source)
  token.attrSet('referrerpolicy', 'no-referrer')
  if (resolved || /^https?:\/\//i.test(source) || /^data:image\//i.test(source)) {
    token.attrSet('src', resolved || source)
  } else {
    token.attrs = token.attrs?.filter(([key]) => key !== 'src') ?? null
  }
  return image(tokens, index, options, env, renderer)
}

export function renderMarkdown(text: string, assets?: ReadonlyMap<string, string>) {
  const env: RenderContext = { headings: [], assets }
  return { html: md.render(text, env), headings: env.headings }
}
