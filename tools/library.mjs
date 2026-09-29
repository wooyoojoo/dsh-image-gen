/**
 * Where generated art lives, and how a tool-made artifact joins the plugin's gallery.
 *
 * The gallery lists records from the plugin's index, so a file the tools write is
 * invisible there until it has one. These helpers resolve the root the still
 * images already live in, keep one folder per animation, copy the frames in so
 * the folder is self-contained, and append an index record in the plugin's own
 * shape — the gallery then shows the animation next to the stills.
 *
 * The plugin serves an indexed file with a plain read, so the root may sit
 * outside the workspace: keeping it out of a checkout is what makes the art
 * survive a re-pull.
 */

import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Directory the plugin keeps its own state in, matching `STATE_DIR_NAME`. */
export function stateDir(env = process.env) {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'imagegen')
}

/** Whether a value is a usable non-empty string. */
function isFilled(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Read the plugin's image index, tolerating an absent or unreadable file.
 *
 * @param env - environment holding `DSH_HOME`.
 * @returns The records, newest first.
 */
export async function readIndex(env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir(env), 'images.json'), 'utf8'))
    return Array.isArray(parsed?.images) ? parsed.images : []
  } catch {
    return []
  }
}

/**
 * Whether a path already sits inside a library's animation folder.
 *
 * @param path - a record's path.
 * @returns True when the path is under `<root>/animations/`.
 */
function insideAnimations(path) {
  return /[\\/]animations[\\/]/i.test(path)
}

/**
 * Strip a per-session folder so a session's image still points at the library.
 *
 * @param dir - a directory that may end in `sessions/<id>`.
 * @returns The library root that folder belongs to.
 */
function withoutSessionFolder(dir) {
  return isFilled(dir) ? dir.replace(/[\\/]sessions[\\/][^\\/]+$/i, '') : dir
}

/**
 * Resolve the root the art belongs in.
 *
 * `auto` follows the art that already exists: the configured `outputDir` from
 * the Plugins-page overrides first, then the directory of the newest indexed
 * still — with any per-session folder stripped, so animations never nest inside
 * one session's images — and finally the current directory.
 *
 * Only stills steer the root. A published animation already lives inside the
 * library, so following one would nest the next animation a level deeper.
 *
 * @param explicit - a directory, or `auto`/undefined.
 * @param env - environment holding `DSH_HOME`.
 * @returns An absolute directory path.
 */
export async function libraryRoot(explicit, env = process.env) {
  if (isFilled(explicit) && explicit !== 'auto') return resolve(explicit)
  try {
    const overrides = JSON.parse(await readFile(join(stateDir(env), 'config.json'), 'utf8'))
    if (isFilled(overrides?.outputDir)) return resolve(overrides.outputDir)
  } catch {
    // No overrides file: fall through to the recorded art.
  }
  const newest = (await readIndex(env)).find(record => isFilled(record?.path)
    && record.mode !== 'animation'
    && !insideAnimations(record.path))
  if (newest !== undefined) return withoutSessionFolder(dirname(newest.path))
  try {
    const overrides = JSON.parse(await readFile(join(stateDir(env), 'config.json'), 'utf8'))
    if (isFilled(overrides?.outputDir)) return resolve(overrides.outputDir)
  } catch {
    // No overrides file: fall through to the working directory.
  }
  return process.cwd()
}

/** The folder one animation owns, under the library root. */
export function animationDir(root, set) {
  return join(root, 'animations', isFilled(set) ? set.trim() : 'unlabelled')
}

/** MIME type for a file this toolchain writes. */
export function mimeTypeOf(file) {
  const extension = extname(file).toLowerCase()
  if (extension === '.gif') return 'image/gif'
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  return 'application/octet-stream'
}

/**
 * The absolute path an animation should be written to.
 *
 * @param options - the requested `out` path, the animation `set`, and where the library lives.
 * @returns The absolute output path, with its folder created.
 */
export async function placeOutput({ out, set, into, env = process.env }) {
  const root = await libraryRoot(into, env)
  const target = isFilled(set) ? join(animationDir(root, set), basename(out)) : resolve(out)
  await mkdir(dirname(target), { recursive: true })
  return target
}

/** Append a record to the plugin's index, atomically, keeping the newest first. */
async function appendIndex(record, env) {
  const folder = stateDir(env)
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'images.json')
  const records = await readIndex(env)
  const temporary = `${file}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify({ version: 1, images: [record, ...records].slice(0, 500) }, null, 2)}\n`)
  await rename(temporary, file)
}

/**
 * Put an assembled animation in the library and give it a gallery record.
 *
 * The frames are copied next to the animation, so one folder holds everything a
 * later edit or re-encode needs.
 *
 * @param options - the written `file`, the animation `set`, the source `frames`, the `schedule` totals, an optional `manifest`, a `prompt` line for the gallery, and the sharp module used to read dimensions.
 * @returns The record that was appended.
 */
export async function publishAnimation({ file, set, frames = [], exposures, seconds, manifest, prompt, into, sharp, env = process.env }) {
  const root = await libraryRoot(into, env)
  const folder = animationDir(root, set)
  await mkdir(join(folder, 'frames'), { recursive: true })
  const copied = []
  for (const [index, source] of frames.entries()) {
    const name = `frame-${String(index + 1).padStart(2, '0')}${extname(source)}`
    await copyFile(source, join(folder, 'frames', name))
    copied.push(join(folder, 'frames', name))
  }
  let width
  let height
  if (sharp !== undefined) {
    try {
      const meta = await sharp(file).metadata()
      width = meta.width
      height = meta.height
    } catch {
      // Dimensions are cosmetic here: a file sharp cannot read still gets a record.
    }
  }
  const info = await stat(file)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
  const record = {
    id: `anim-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    path: file,
    name: basename(file),
    mimeType: mimeTypeOf(file),
    bytes: info.size,
    ...width === undefined ? {} : { width },
    ...height === undefined ? {} : { height },
    model: 'dsh-imagegen tools',
    size: width === undefined ? undefined : `${String(width)}x${String(height)}`,
    mode: 'animation',
    prompt: prompt ?? `animation ${set ?? 'unlabelled'}`,
    ...set === undefined ? {} : { animationId: set },
    animationRole: 'assembly',
    frames: copied.length,
    ...exposures === undefined ? {} : { exposures },
    ...seconds === undefined ? {} : { seconds },
    ...manifest === undefined ? {} : { manifest },
    ...copied.length === 0 ? {} : { frameFiles: copied },
  }
  if (record.size === undefined) delete record.size
  await appendIndex(record, env)
  return record
}
