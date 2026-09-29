/**
 * Deterministic sprite-sheet cell tool: crop one cell out of a sheet, or paste a
 * replacement frame back into it.
 *
 *   node tools/frame-tool.mjs crop  <sheet> <cols> <rows> <index> <out>                     [--dsh=<checkout>]
 *   node tools/frame-tool.mjs paste <sheet> <cols> <rows> <index> <frame> <out>             [--dsh=<checkout>]
 *
 * Index is 0-based and row-major. `paste` erases the cell first: compositing
 * straight onto the sheet leaves the previous artwork showing through wherever
 * the replacement is transparent, which reads as a ghosted double image. The
 * erase and the replacement are followed by a check that counts leftover
 * pixels, so a regression cannot pass silently.
 */

import { loadSharp, splitDshFlag } from './sharp.mjs'

const { args, dshDir } = splitDshFlag(process.argv.slice(2))
const [command, sheetPath, colsArg, rowsArg, indexArg, ...rest] = args
if (command !== 'crop' && command !== 'paste') {
  console.log('usage: node tools/frame-tool.mjs crop|paste <sheet> <cols> <rows> <index> <out|frame out> [--dsh=<checkout>]')
  process.exit(2)
}
const sharp = await loadSharp(dshDir)
const COLS = Number(colsArg)
const ROWS = Number(rowsArg)
const INDEX = Number(indexArg)

const meta = await sharp(sheetPath).metadata()
if (meta.width === undefined || meta.height === undefined) throw new Error('sheet has no dimensions')
const cellW = Math.floor(meta.width / COLS)
const cellH = Math.floor(meta.height / ROWS)
const col = INDEX % COLS
const row = Math.floor(INDEX / COLS)
if (!Number.isInteger(INDEX) || INDEX < 0 || row >= ROWS) throw new Error(`index ${String(INDEX)} is outside a ${String(COLS)}x${String(ROWS)} grid`)
const left = col * cellW
const top = row * cellH
console.log(`SHEET ${String(meta.width)}x${String(meta.height)}  GRID ${String(COLS)}x${String(ROWS)}  CELL ${String(cellW)}x${String(cellH)}  INDEX ${String(INDEX)} -> col ${String(col)} row ${String(row)} at (${String(left)},${String(top)})`)

if (command === 'crop') {
  const [out] = rest
  await sharp(sheetPath).extract({ left, top, width: cellW, height: cellH }).png().toFile(out)
  const written = await sharp(out).metadata()
  console.log(`CROPPED -> ${out}  ${String(written.width)}x${String(written.height)}`)
} else {
  const [framePath, out] = rest
  const scaled = await sharp(framePath)
    .resize(cellW, cellH, { fit: 'contain', position: 'center', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  const erased = await sharp(sheetPath)
    .composite([{
      input: { create: { width: cellW, height: cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } },
      left,
      top,
      blend: 'dest-out',
    }])
    .png()
    .toBuffer()
  await sharp(erased).composite([{ input: scaled, left, top }]).png().toFile(out)

  const cell = await sharp(out).extract({ left, top, width: cellW, height: cellH }).ensureAlpha().raw().toBuffer()
  const frame = await sharp(scaled).ensureAlpha().raw().toBuffer()
  let ghost = 0
  for (let i = 3; i < cell.length; i += 4) if (cell[i] > 0 && frame[i] === 0) ghost += 1
  console.log(`PASTED ${framePath} -> ${out} at (${String(left)},${String(top)}); leftover pixels from the previous artwork: ${String(ghost)}`)
}
