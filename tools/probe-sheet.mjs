/**
 * Measure one sprite sheet: alpha channel facts, per-cell ink coverage and
 * artwork bounding boxes, and whether ink sits on an interior seam.
 *
 *   node tools/probe-sheet.mjs <image> <cols> <rows> [--dsh=<checkout>]
 *
 * The numbers answer the questions a glance cannot: is the background really
 * transparent (a provider may return `max alpha 254` and never a fully opaque
 * pixel), does every cell carry artwork, is the character scaled to fill its
 * cell, and would a cut on the nominal grid line slice through it.
 */

import { loadSharp, splitDshFlag } from './sharp.mjs'

const { args, dshDir } = splitDshFlag(process.argv.slice(2))
const [path, colsArg, rowsArg] = args
if (path === undefined) {
  console.log('usage: node tools/probe-sheet.mjs <image> <cols> <rows> [--dsh=<checkout>]')
  process.exit(2)
}
const sharp = await loadSharp(dshDir)
const COLS = Number(colsArg ?? 4)
const ROWS = Number(rowsArg ?? 2)

const image = sharp(path)
const meta = await image.metadata()
console.log(`FILE   ${String(meta.format)} ${String(meta.width)}x${String(meta.height)} channels=${String(meta.channels)} hasAlpha=${String(meta.hasAlpha)}`)
console.log(`GRID   ${String(COLS)}x${String(ROWS)} cells of ${String(meta.width / COLS)}x${String(meta.height / ROWS)}`)

const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const alphaAt = (x, y) => data[(y * info.width + x) * 4 + 3]

let min = 255
let max = 0
let transparent = 0
let opaque = 0
for (let y = 0; y < info.height; y += 1) {
  for (let x = 0; x < info.width; x += 1) {
    const a = alphaAt(x, y)
    if (a < min) min = a
    if (a > max) max = a
    if (a === 0) transparent += 1
    else if (a === 255) opaque += 1
  }
}
const total = info.width * info.height
console.log(`ALPHA  min=${String(min)} max=${String(max)}  fullyTransparent=${(transparent / total * 100).toFixed(1)}%  fullyOpaque=${(opaque / total * 100).toFixed(2)}%`)
console.log(`CORNER tl=${String(alphaAt(0, 0))} tr=${String(alphaAt(info.width - 1, 0))} bl=${String(alphaAt(0, info.height - 1))} br=${String(alphaAt(info.width - 1, info.height - 1))}`)

const cellW = info.width / COLS
const cellH = info.height / ROWS
for (let row = 0; row < ROWS; row += 1) {
  const cells = []
  for (let col = 0; col < COLS; col += 1) {
    let ink = 0
    let left = Infinity
    let right = -Infinity
    let top = Infinity
    let bottom = -Infinity
    for (let y = row * cellH; y < (row + 1) * cellH; y += 1) {
      for (let x = col * cellW; x < (col + 1) * cellW; x += 1) {
        if (alphaAt(x, y) === 0) continue
        ink += 1
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
    const box = ink === 0 ? 'empty' : `w${String(right - left + 1)}xh${String(bottom - top + 1)}`
    cells.push(`${(ink / (cellW * cellH) * 100).toFixed(1)}% ${box}`)
  }
  console.log(`ROW ${String(row + 1)}: ${cells.join('   ')}`)
}

function seamInk(axis, positions) {
  return positions.map((at) => {
    let ink = 0
    if (axis === 'x') { for (let y = 0; y < info.height; y += 1) if (alphaAt(at, y) > 0) ink += 1 }
    else { for (let x = 0; x < info.width; x += 1) if (alphaAt(x, at) > 0) ink += 1 }
    return `@${String(at)}=${String(ink)}`
  }).join('  ')
}
const xs = Array.from({ length: COLS - 1 }, (_, index) => (index + 1) * cellW)
const ys = Array.from({ length: ROWS - 1 }, (_, index) => (index + 1) * cellH)
console.log(`SEAM x ${xs.length === 0 ? '(none)' : seamInk('x', xs)}`)
console.log(`SEAM y ${ys.length === 0 ? '(none)' : seamInk('y', ys)}`)
