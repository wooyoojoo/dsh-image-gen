/**
 * Move every indexed file into the library root and rewrite the index.
 *
 *   node tools/relocate.mjs [--to=<dir|auto>] [--dry-run] [--dsh=<checkout>]
 *
 * Art generated before a root was configured sits wherever each launch happened
 * to start from, so one user's images end up in several directories. This moves
 * them under one root, keeping provenance: files that belong to a published
 * animation keep their `animations/<set>/` home, and everything else lands under
 * `legacy/<its old folder>/`.
 *
 * Each file is copied, its size verified, and only then is the source removed;
 * a record is written back to the index as soon as all of its files moved, so an
 * aborted run leaves the remaining records pointing at files that still exist.
 */

import { copyFile, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { animationDir, libraryRoot, readIndex, stateDir } from './library.mjs'

const args = process.argv.slice(2)
let to
let dryRun = false
for (const value of args) {
  if (value.startsWith('--to=')) to = value.slice('--to='.length)
  else if (value === '--dry-run') dryRun = true
  else if (value.startsWith('--dsh=') || value.startsWith('--')) continue
}
const target = await libraryRoot(to)
console.log(`LIBRARY ${target}${dryRun ? ' (dry run)' : ''}`)

/** A filesystem-safe label for a source folder, keeping its last path segment. */
function folderLabel(dir) {
  const segment = basename(resolve(dir)) || 'root'
  return segment.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root'
}

/** Where one indexed file belongs under the target root. */
function destinationFor(file) {
  const animation = /[\\/]animations[\\/](.+)$/i.exec(file)
  if (animation !== null) return join(target, 'animations', animation[1])
  return join(target, 'legacy', folderLabel(dirname(file)), basename(file))
}

/** Move one file; returns the new path, or `undefined` when it was already there or missing. */
async function moveFile(file) {
  const destination = destinationFor(file)
  if (resolve(file) === resolve(destination)) return { path: destination, skipped: 'already in place' }
  try {
    await stat(file)
  } catch {
    return { path: file, skipped: 'source missing' }
  }
  await mkdir(dirname(destination), { recursive: true })
  if (dryRun) return { path: destination, moved: true }
  const source = await stat(file)
  try {
    await rename(file, destination)
  } catch {
    // A different volume needs a copy, and only a verified copy may replace it.
    await copyFile(file, destination)
    const copied = await stat(destination)
    if (copied.size !== source.size) throw new Error(`copy of ${file} differs in size; the source was kept`)
    await unlink(file)
  }
  return { path: destination, moved: true }
}

const records = await readIndex()
console.log(`INDEX ${String(records.length)} records`)
let moved = 0
let skipped = 0
let bytes = 0
let changed = 0

for (const record of records) {
  const updates = {}
  const single = await moveFile(record.path)
  if (single.moved === true) {
    updates.path = single.path
    bytes += Number(record.bytes ?? 0)
    moved += 1
  } else {
    skipped += 1
    if (single.skipped === 'source missing') console.log(`  missing ${record.path}`)
  }
  for (const key of ['manifest']) {
    const value = record[key]
    if (typeof value !== 'string' || value.length === 0) continue
    const result = await moveFile(value)
    if (result.moved === true) updates[key] = result.path
  }
  if (Array.isArray(record.frameFiles)) {
    const movedFrames = []
    for (const frame of record.frameFiles) {
      const result = await moveFile(frame)
      if (result.moved === true) moved += 1
      movedFrames.push(result.path)
    }
    if (movedFrames.some((frame, index) => frame !== record.frameFiles[index])) updates.frameFiles = movedFrames
  }
  if (Object.keys(updates).length === 0) continue
  Object.assign(record, updates)
  changed += 1
  console.log(`  ${record.name} -> ${relative(target, record.path) || record.path}`)
  if (!dryRun) {
    const file = join(stateDir(), 'images.json')
    await writeFile(file, `${JSON.stringify({ version: 1, images: records }, null, 2)}\n`)
  }
}

console.log(`${dryRun ? 'WOULD MOVE' : 'MOVED'} ${String(moved)} file(s), ${String(bytes)} bytes; ${String(changed)} record(s) updated; ${String(skipped)} already in place or missing`)
if (dryRun) console.log('DRY RUN: pass without --dry-run to move for real')
