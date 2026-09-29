/**
 * Resolve the image library the tools in this directory use.
 *
 * The plugin itself depends on nothing, so these development tools borrow a
 * sharp that already exists on the machine: a bare `sharp` import first (works
 * when they run inside a tree that has it), then the pnpm store of a DSH
 * checkout — `--dsh=<dir>`, `$DSH_DIR`, or the current directory. Failing to
 * find one reports what to do instead of leaking a module-not-found.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Split the shared `--dsh=<checkout>` flag out of a tool's argument list.
 * @param argv - the process arguments after the script name.
 * @returns The positional arguments, and the requested checkout directory.
 */
export function splitDshFlag(argv) {
  let dshDir
  const args = []
  for (const value of argv) {
    if (value.startsWith('--dsh=')) dshDir = value.slice('--dsh='.length)
    else args.push(value)
  }
  return { args, dshDir }
}

/**
 * Load sharp from the running tree or from a DSH checkout's pnpm store.
 * @param dshDir - checkout directory named by `--dsh=`; omitted falls back to `$DSH_DIR` and the current directory.
 * @returns The sharp module.
 * @throws When no usable copy is reachable, naming both remedies.
 */
export async function loadSharp(dshDir) {
  try {
    return (await import('sharp')).default
  } catch {
    // No sharp in this tree; the DSH checkout keeps one for its attachment package.
  }
  const roots = [dshDir, process.env.DSH_DIR, process.cwd()].filter(value => typeof value === 'string' && value.length > 0)
  for (const root of roots) {
    const store = join(root, 'node_modules', '.pnpm')
    let entries
    try {
      entries = readdirSync(store)
    } catch {
      continue
    }
    const hits = entries.filter(name => name.startsWith('sharp@')).sort()
    for (const hit of hits) {
      const file = join(store, hit, 'node_modules', 'sharp', 'dist', 'index.cjs')
      try {
        return (await import(pathToFileURL(file).href)).default
      } catch {
        // A store entry without a usable build; try the next one.
      }
    }
  }
  throw new Error('these tools need sharp: install it (`npm i sharp`), or pass `--dsh=<DSH checkout>` so they can load the copy bundled there')
}
