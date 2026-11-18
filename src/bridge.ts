import { invoke } from '@tauri-apps/api/core'

export function htmlFragment(html: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}

export async function resolveImages(html: string, id: string, exportAll = false) {
  const sources = [...new Set(
    [...htmlFragment(html).querySelectorAll<HTMLImageElement>('img[data-source]')]
      .map(image => image.dataset.source ?? '')
      .filter(source => source && !/^data:image\//i.test(source) && (exportAll || !/^https?:\/\//i.test(source))),
  )]
  const assets = new Map<string, string>()
  const failures: string[] = []
  await Promise.all(sources.map(async source => {
    try {
      const path = /^https?:\/\//i.test(source) ? source : decodeURIComponent(source.split(/[?#]/, 1)[0])
      assets.set(source, await invoke<string>('image_data', { id, source: path }))
    } catch {
      failures.push(source)
    }
  }))
  return { assets, failures }
}

export async function writeExport(path: string, bytes: ArrayBuffer | Uint8Array) {
  const encoded = new TextEncoder().encode(path)
  const header = btoa(String.fromCharCode(...encoded))
  await invoke('write_export', bytes, { headers: { 'x-simplemd-path': header } })
}
