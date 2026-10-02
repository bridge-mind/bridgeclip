import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { parseCustomCaption, type CustomCaptionPreset } from '../shared/custom-captions'

const libraryPath = (): string => join(app.getPath('userData'), 'caption-styles.json')

export function listCaptionStyles(): CustomCaptionPreset[] {
  const path = libraryPath()
  if (!existsSync(path)) return []
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(value) || value.length > 200) throw new Error('Invalid library')
    const styles = value.map(parseCustomCaption)
    if (new Set(styles.map(style => style.id)).size !== styles.length) throw new Error('Duplicate style')
    return styles
  } catch { throw new Error('Could not read your caption styles. The saved file has been kept for recovery.') }
}

function writeLibrary(styles: CustomCaptionPreset[]): CustomCaptionPreset[] {
  const path = libraryPath(), temporary = `${path}.${randomUUID()}.tmp`
  mkdirSync(app.getPath('userData'), { recursive: true })
  try {
    writeFileSync(temporary, JSON.stringify(styles, null, 2), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
  return styles
}

export function saveCaptionStyle(value: unknown): CustomCaptionPreset[] {
  const style = parseCustomCaption(value), styles = listCaptionStyles()
  const index = styles.findIndex(item => item.id === style.id)
  if (styles.some(item => item.id !== style.id && item.name.toLocaleLowerCase() === style.name.toLocaleLowerCase())) throw new Error('A style with that name already exists.')
  if (index >= 0) styles[index] = style
  else {
    if (styles.length >= 200) throw new Error('Your library is full. Remove a style before adding another.')
    styles.unshift(style)
  }
  return writeLibrary(styles)
}

export function deleteCaptionStyle(id: unknown): CustomCaptionPreset[] {
  if (typeof id !== 'string' || !/^custom-[a-zA-Z0-9-]{1,56}$/.test(id)) throw new Error('Invalid caption style')
  return writeLibrary(listCaptionStyles().filter(style => style.id !== id))
}
