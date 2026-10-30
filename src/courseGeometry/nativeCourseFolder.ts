import { NativeGkdError, parseGkdLayout, type NativeCourseLayout } from './nativeGkd'

/**
 * Find a GSPro course's layout files inside the folder the golfer granted.
 *
 * What a GSPro course folder looks like (FarmLinks, from the player's PC):
 *   farmlinks_al_2_7_gsp.GKD            main layout; file stem = live CourseKey
 *   Farmlinks Kids.GKDalt               alternate layout; SceneFolderName = farmlinks_al_2_7_gsp
 *   farmlinks_al_2_7_gsp-<epoch>.GKD_BAK  old revisions (ignored)
 *   farmlinks_al_2_7_gsp.unity3d, scorecards, splash images, ...
 *
 * The golfer may grant the course folder itself, the Courses folder, or the
 * GSPro install folder (C:\GSProV1). Search order: the granted folder, a
 * subfolder named after the course, a Courses subfolder, then a bounded
 * breadth-first walk. Only names are listed; only GKD/GKDalt files are read.
 * Nothing leaves the machine.
 */

export type NativeFileLike = { name: string; size: number; lastModified: number; text(): Promise<string> }
export type NativeEntry = { kind: 'file' | 'directory'; name: string }
export type NativeFolderHandle = NativeEntry & {
  kind: 'directory'
  getFileHandle(name: string): Promise<{ getFile(): Promise<NativeFileLike> }>
  getDirectoryHandle(name: string): Promise<NativeFolderHandle>
  values?: () => AsyncIterable<NativeEntry & Partial<Omit<NativeFolderHandle, 'kind' | 'name'>>>
}

export type NativeLayoutFile = Readonly<{
  fileName: string
  kind: 'main' | 'alt'
  size: number
  lastModified: number
}>

export type NativeSceneLayout = Readonly<{ file: NativeLayoutFile; layout: NativeCourseLayout }>

export type NativeSceneFolder = Readonly<{
  /** Folder names from the granted folder down to the course folder. */
  path: readonly string[]
  dir: NativeFolderHandle
}>

export const MAX_FOLDERS_VISITED = 1500
const MAX_DEPTH = 3
const COURSES_FOLDER = /^courses$/i
const SKIP_FOLDER = /^(\.|\$)|^(gspro_data|monobleedingedge|logs?|crashes|screenshots)$/i

const lower = (value: string) => value.toLowerCase()
const GKD_EXT = /\.gkd$/i
const GKDALT_EXT = /\.gkdalt$/i

const listEntries = async (dir: NativeFolderHandle) => {
  const files: string[] = []
  const folders: (NativeEntry & Partial<Omit<NativeFolderHandle, 'kind' | 'name'>>)[] = []
  if (!dir.values) return { files, folders }
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') files.push(entry.name)
    else if (entry.kind === 'directory') folders.push(entry)
  }
  return { files, folders }
}

/** A folder holds the course when it has <key>.GKD or <key>.GKDalt (any case). */
const holdsCourse = (files: readonly string[], key: string) => {
  const wanted = new Set([`${lower(key)}.gkd`, `${lower(key)}.gkdalt`])
  return files.some((name) => wanted.has(lower(name)))
}

const child = async (dir: NativeFolderHandle, name: string): Promise<NativeFolderHandle | null> => {
  try {
    return await dir.getDirectoryHandle(name)
  } catch {
    return null
  }
}

/** Follow a cached path; null if any folder on it is gone. */
export const walkNativePath = async (root: NativeFolderHandle, path: readonly string[]) => {
  let dir: NativeFolderHandle | null = root
  for (const name of path) {
    dir = dir ? await child(dir, name) : null
    if (!dir) return null
  }
  return dir
}

export const findNativeSceneFolder = async (
  root: NativeFolderHandle,
  courseKey: string,
  maxVisited = MAX_FOLDERS_VISITED,
): Promise<NativeSceneFolder | null> => {
  const key = lower(courseKey)
  const queue: { dir: NativeFolderHandle; path: string[]; depth: number }[] = [{ dir: root, path: [], depth: 0 }]
  const seen = new Set<string>()
  let visited = 0
  while (queue.length > 0 && visited < maxVisited) {
    const { dir, path, depth } = queue.shift()!
    const id = path.map(lower).join('/')
    if (seen.has(id)) continue
    seen.add(id)
    visited += 1
    const { files, folders } = await listEntries(dir)
    if (holdsCourse(files, courseKey)) return { path, dir }
    if (depth >= MAX_DEPTH) continue
    // Likely spots first: a folder named after the course, then "Courses".
    const rank = (name: string) => (lower(name) === key ? 0 : COURSES_FOLDER.test(name) ? 1 : 2)
    const next = folders
      .filter((f) => !SKIP_FOLDER.test(f.name) && f.getFileHandle)
      .sort((a, b) => rank(a.name) - rank(b.name))
    const urgent = next.filter((f) => rank(f.name) < 2).map((f) => ({ dir: f as NativeFolderHandle, path: [...path, f.name], depth: depth + 1 }))
    const later = next.filter((f) => rank(f.name) === 2).map((f) => ({ dir: f as NativeFolderHandle, path: [...path, f.name], depth: depth + 1 }))
    queue.unshift(...urgent)
    queue.push(...later)
  }
  return null
}

/** GKD and GKDalt files in a course folder (GKD_BAK revisions ignored). */
export const listNativeLayoutFiles = async (dir: NativeFolderHandle): Promise<readonly NativeLayoutFile[]> => {
  const { files } = await listEntries(dir)
  const out: NativeLayoutFile[] = []
  for (const name of files) {
    const kind = GKD_EXT.test(name) ? 'main' : GKDALT_EXT.test(name) ? 'alt' : null
    if (!kind) continue
    try {
      const file = await (await dir.getFileHandle(name)).getFile()
      out.push({ fileName: name, kind, size: file.size, lastModified: file.lastModified })
    } catch {
      // unreadable: skip
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.fileName.localeCompare(b.fileName) : a.kind === 'main' ? -1 : 1))
}

export const sameNativeLayoutFiles = (a: readonly NativeLayoutFile[], b: readonly NativeLayoutFile[]) =>
  a.length === b.length && a.every((f, i) =>
    f.fileName === b[i].fileName && f.size === b[i].size && f.lastModified === b[i].lastModified)

export const fileStem = (name: string) => name.replace(/\.(gkd|gkdalt)$/i, '')

/**
 * Parse the course's layouts: the main <sceneKey>.GKD and every GKDalt that
 * names that scene. Other courses' files sharing a folder, and unreadable or
 * malformed files, are left out.
 */
export const readNativeSceneLayouts = async (
  dir: NativeFolderHandle,
  sceneKey: string,
  files: readonly NativeLayoutFile[],
): Promise<readonly NativeSceneLayout[]> => {
  const out: NativeSceneLayout[] = []
  for (const file of files) {
    if (file.kind === 'main' && lower(fileStem(file.fileName)) !== lower(sceneKey)) continue
    let layout: NativeCourseLayout
    try {
      layout = parseGkdLayout(await (await (await dir.getFileHandle(file.fileName)).getFile()).text())
    } catch (error) {
      if (error instanceof NativeGkdError) continue
      throw error
    }
    if (file.kind === 'alt' && layout.sceneFolderName && lower(layout.sceneFolderName) !== lower(sceneKey)) continue
    out.push({ file, layout })
  }
  return out
}

/** Display name for a layout: GKDalt files are named after their layout. */
export const nativeLayoutName = (entry: NativeSceneLayout) =>
  entry.file.kind === 'main' ? (entry.layout.courseName ?? fileStem(entry.file.fileName)) : fileStem(entry.file.fileName)
