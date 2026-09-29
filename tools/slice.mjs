/**
 * Deterministic sprite-sheet slicer: choose the least-damaging cut line near
 * each nominal boundary, then trim each frame to its artwork and place it on a
 * uniform canvas with a fixed anchor.
 *
 *   node tools/slice.mjs <sheet> <cols> <rows> <outDir> [--anchor=feet|box] [--dsh=<checkout>]
 *
 * A generated sheet rarely has real gutters between frames, so a cut is not
 * forced onto a clean line: it lands on the middle of an empty run when one is
 * wide enough, otherwise on the line carrying the least ink, and the artwork
 * split by that fallback is reported rather than hidden. Frames are never
 * rescaled (one sheet's own scale is consistent); they are trimmed and
 * re-anchored so relative size across frames survives. A frame that cannot fit
 * the padded canvas fails the run instead of being clipped.
 *
 * Anchoring decides whether the animation holds a fixed viewpoint. `feet` (the
 * default) pins each frame's foot contact to one canvas point, so the body
 * stays put while a prop swings out to the side; `box` pins the artwork
 * bounding box instead, which lets a swung prop drag the body around. The foot
 * pivot is found as the lowest opaque pixel inside a window around the densest
 * column — the densest column tracks the body core, and the window keeps a
 * bowl swung out to the side from being mistaken for the ground contact.
 *
 * Output: frame-<n>.png, contact-strip.png (all frames side by side), SLICE.txt.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSharp, splitDshFlag } from './sharp.mjs'

const { args: rawArgs, dshDir } = splitDshFlag(process.argv.slice(2))
let anchor = 'feet'
let canvas = 640
let cuts = 'gap'
const args = []
for (const value of rawArgs) {
  if (value.startsWith('--anchor=')) anchor = value.slice('--anchor='.length)
  else if (value.startsWith('--canvas=')) canvas = Number(value.slice('--canvas='.length))
  else if (value.startsWith('--cuts=')) cuts = value.slice('--cuts='.length)
  else args.push(value)
}
const [sheetPath, colsArg, rowsArg, outDir] = args
if (outDir === undefined) {
  console.log('usage: node tools/slice.mjs <sheet> <cols> <rows> <outDir> [--anchor=feet|box] [--cuts=gap|nominal] [--canvas=640] [--dsh=<checkout>]')
  process.exit(2)
}
if (anchor !== 'feet' && anchor !== 'box') throw new Error(`unknown anchor ${JSON.stringify(anchor)}: use feet or box`)
if (cuts !== 'gap' && cuts !== 'nominal') throw new Error(`unknown cuts ${JSON.stringify(cuts)}: use gap or nominal`)
const sharp = await loadSharp(dshDir)
const COLS = Number(colsArg)
const ROWS = Number(rowsArg)
const WINDOW = 48
const MIN_RUN = 8
const PAD = 32
const SHIM = 8
const CORE_BAND = 0.15
const FOOT_BAND = 0.1

const { data, info } = await sharp(sheetPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const W = info.width
const H = info.height
const alphaAt = (x, y) => data[(y * W + x) * 4 + 3]

const colInk = new Array(W).fill(0)
const rowInk = new Array(H).fill(0)
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    if (alphaAt(x, y) === 0) continue
    colInk[x] += 1
    rowInk[y] += 1
  }
}

/** Prefer the middle of a wide empty run; otherwise the least-ink line nearest the boundary. */
function findCut(profile, nominal) {
  const lo = Math.max(1, nominal - WINDOW)
  const hi = Math.min(profile.length - 2, nominal + WINDOW)
  let best = null
  let runStart = null
  for (let i = lo; i <= hi + 1; i += 1) {
    const empty = i <= hi && profile[i] === 0
    if (empty) {
      if (runStart === null) runStart = i
      continue
    }
    if (runStart === null) continue
    const len = i - runStart
    if (best === null || len > best.len) best = { len, cut: runStart + Math.floor(len / 2) }
    runStart = null
  }
  if (best !== null && best.len >= MIN_RUN) return { cut: best.cut, ink: 0, how: `empty gutter of ${String(best.len)}px` }
  // An opaque sheet inks every line, so several candidates tie at the same count:
  // the nominal boundary wins those ties, and the window never drags the grid.
  let least = null
  for (let i = lo; i <= hi; i += 1) {
    if (least === null || profile[i] < least.ink) {
      least = { cut: i, ink: profile[i] }
      continue
    }
    if (profile[i] === least.ink && Math.abs(i - nominal) < Math.abs(least.cut - nominal)) {
      least = { cut: i, ink: profile[i] }
    }
  }
  return { cut: least.cut, ink: least.ink, how: 'least-ink fallback' }
}

const cellW = Math.floor(W / COLS)
const cellH = Math.floor(H / ROWS)
const xs = [0]
const ys = [0]
for (let c = 1; c < COLS; c += 1) {
  const found = cuts === 'nominal' ? { cut: c * cellW, ink: colInk[c * cellW], how: 'nominal grid' } : findCut(colInk, c * cellW)
  xs.push(found.cut)
  console.log(`CUT x ${String(c)}: nominal ${String(c * cellW)} -> ${String(found.cut)} (${found.how}, splits ${String(found.ink)}px of artwork)`)
}
for (let r = 1; r < ROWS; r += 1) {
  const found = cuts === 'nominal' ? { cut: r * cellH, ink: rowInk[r * cellH], how: 'nominal grid' } : findCut(rowInk, r * cellH)
  ys.push(found.cut)
  console.log(`CUT y ${String(r)}: nominal ${String(r * cellH)} -> ${String(found.cut)} (${found.how}, splits ${String(found.ink)}px of artwork)`)
}
xs.push(W)
ys.push(H)

await mkdir(outDir, { recursive: true })
const canvases = []
const pivots = []
for (let row = 0; row < ROWS; row += 1) {
  for (let col = 0; col < COLS; col += 1) {
    const index = row * COLS + col
    const left = xs[col]
    const top = ys[row]
    const right = xs[col + 1]
    const bottom = ys[row + 1]

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        if (alphaAt(x, y) === 0) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    if (minX === Infinity) throw new Error(`frame ${String(index + 1)} is empty: the cut lines left nothing inside its cell`)
    const artW = maxX - minX + 1
    const artH = maxY - minY + 1

    let pivotX = Math.round((artW - 1) / 2)
    let pivotY = artH - 1
    if (anchor === 'feet') {
      const colCount = new Array(artW).fill(0)
      for (let y = 0; y < artH; y += 1) {
        for (let x = 0; x < artW; x += 1) {
          if (alphaAt(minX + x, minY + y) > 0) colCount[x] += 1
        }
      }
      let core = 0
      for (let x = 1; x < artW; x += 1) {
        if (colCount[x] > colCount[core]) core = x
      }
      const half = Math.max(4, Math.round(artW * CORE_BAND))
      const from = Math.max(0, core - half)
      const to = Math.min(artW - 1, core + half)
      pivotY = -1
      for (let y = artH - 1; y >= 0 && pivotY < 0; y -= 1) {
        for (let x = from; x <= to; x += 1) {
          if (alphaAt(minX + x, minY + y) > 0) {
            pivotY = y
            break
          }
        }
      }
      if (pivotY < 0) pivotY = artH - 1
      const bandTop = Math.max(0, pivotY - Math.round(artH * FOOT_BAND))
      let sum = 0
      let count = 0
      for (let y = bandTop; y <= pivotY; y += 1) {
        for (let x = from; x <= to; x += 1) {
          if (alphaAt(minX + x, minY + y) === 0) continue
          sum += x
          count += 1
        }
      }
      if (count > 0) pivotX = Math.round(sum / count)
    }
    pivots.push({ index: index + 1, x: pivotX, y: pivotY })

    const destX = Math.round(canvas / 2 - pivotX)
    const destY = canvas - PAD - pivotY
    if (destX < 0 || destY < 0 || destX + artW > canvas || destY + artH > canvas) {
      throw new Error(`frame ${String(index + 1)} artwork ${String(artW)}x${String(artH)} with pivot (${String(pivotX)},${String(pivotY)}) does not fit the ${String(canvas)}px canvas with ${String(PAD)}px padding — raise --canvas`)
    }

    const frame = Buffer.alloc(canvas * canvas * 4)
    for (let y = 0; y < artH; y += 1) {
      for (let x = 0; x < artW; x += 1) {
        const src = ((minY + y) * W + (minX + x)) * 4
        const dst = ((destY + y) * canvas + (destX + x)) * 4
        frame[dst] = data[src]
        frame[dst + 1] = data[src + 1]
        frame[dst + 2] = data[src + 2]
        frame[dst + 3] = data[src + 3]
      }
    }

    await sharp(frame, { raw: { width: canvas, height: canvas, channels: 4 } }).png().toFile(join(outDir, `frame-${String(index + 1)}.png`))
    canvases.push(frame)
    console.log(`FRAME ${String(index + 1)}: cell (${String(left)},${String(top)})-(${String(right)},${String(bottom)}) art ${String(artW)}x${String(artH)} anchor=(${String(pivotX)},${String(pivotY)}) -> canvas (${String(canvas / 2)},${String(canvas - PAD)})`)
  }
}

const spread = axis => {
  const values = pivots.map(pivot => pivot[axis])
  return Math.max(...values) - Math.min(...values)
}
console.log(`ANCHOR mode=${anchor}  detected pivots x=[${pivots.map(pivot => String(pivot.x)).join(', ')}] y=[${pivots.map(pivot => String(pivot.y)).join(', ')}]  detection spread x=${String(spread('x'))}px y=${String(spread('y'))}px`)

const stripW = canvases.length * canvas + (canvases.length - 1) * SHIM
const strip = Buffer.alloc(stripW * canvas * 4)
for (const [index, frame] of canvases.entries()) {
  const destX = index * (canvas + SHIM)
  for (let y = 0; y < canvas; y += 1) {
    const srcRow = y * canvas * 4
    frame.copy(strip, (y * stripW + destX) * 4, srcRow, srcRow + canvas * 4)
  }
}
const stripPath = join(outDir, 'contact-strip.png')
await sharp(strip, { raw: { width: stripW, height: canvas, channels: 4 } }).png().toFile(stripPath)
console.log(`STRIP -> ${stripPath} (${String(stripW)}x${String(canvas)})`)
await writeFile(join(outDir, 'SLICE.txt'), `Sliced from ${sheetPath} (${String(COLS)}x${String(ROWS)})\nCut x: ${xs.join(', ')}\nCut y: ${ys.join(', ')}\nAnchor mode: ${anchor}\nPivots: ${pivots.map(pivot => `(${String(pivot.x)},${String(pivot.y)})`).join(' ')}\nCanvas ${String(canvas)}x${String(canvas)}, padding ${String(PAD)}, no rescaling. Anchor pinned to (${String(canvas / 2)},${String(canvas - PAD)}).\n`)
