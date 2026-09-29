/**
 * Match a separately generated frame to the scale of the sequence it joins.
 *
 *   node tools/normalize.mjs <frame> --to=<reference.png>[,<reference.png>...] [--feature=face|silhouette] [--out=scaled.png]
 *
 * A frame generated on its own is framed by the model, not by your sequence:
 * measured runs produced characters 1.5–1.9× the size of the neighbours they
 * were meant to sit between, which reads as the character inflating for one
 * frame. The fix is a linear rescale against a feature that survives the pose.
 *
 * `face` (the default) measures the largest connected skin region, which is
 * immune to the smeared hair and swinging props that defeat every silhouette
 * measure: on a smear frame the hair measured 897px wide against 335px in the
 * sequence, while the face tracked the real scale. `silhouette` uses artwork
 * height and is only safe when the pose matches the reference exactly.
 *
 * The factor fixes the magnitude; always confirm it in a strip against the
 * neighbours before trusting it.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadSharp, splitDshFlag } from './sharp.mjs'

/** Bright, warm pixels: the character's skin, including the open mouth. */
function isSkin(r, g, b, a) {
  return a > 128 && r > 200 && g > 160 && b > 135 && r > b + 25 && r >= g
}

/**
 * Measure one frame's artwork box and its scale feature.
 *
 * @param sharp - the loaded sharp module.
 * @param file - image to measure.
 * @returns The artwork box, the head-band width, and the largest skin region.
 */
async function measure(sharp, file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (x, y) => (y * info.width + x) * 4
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[at(x, y) + 3] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (minX === Infinity) throw new Error(`${file} is fully transparent`)
  const artW = maxX - minX + 1
  const artH = maxY - minY + 1

  let headBand = 0
  for (let y = minY; y < minY + Math.round(artH * 0.25); y += 1) {
    let first = -1
    let last = -1
    for (let x = minX; x <= maxX; x += 1) {
      if (data[at(x, y) + 3] === 0) continue
      if (first === -1) first = x
      last = x
    }
    if (first !== -1 && last - first + 1 > headBand) headBand = last - first + 1
  }

  const seen = new Uint8Array(info.width * info.height)
  let face = { width: 0, height: 0, count: 0 }
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (seen[y * info.width + x] === 1) continue
      const base = at(x, y)
      if (!isSkin(data[base], data[base + 1], data[base + 2], data[base + 3])) continue
      const stack = [x, y]
      seen[y * info.width + x] = 1
      let count = 0
      let bx0 = x
      let bx1 = x
      let by0 = y
      let by1 = y
      while (stack.length > 0) {
        const cy = stack.pop()
        const cx = stack.pop()
        count += 1
        if (cx < bx0) bx0 = cx
        if (cx > bx1) bx1 = cx
        if (cy < by0) by0 = cy
        if (cy > by1) by1 = cy
        for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
          if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue
          if (seen[ny * info.width + nx] === 1) continue
          const neighbour = at(nx, ny)
          if (!isSkin(data[neighbour], data[neighbour + 1], data[neighbour + 2], data[neighbour + 3])) continue
          seen[ny * info.width + nx] = 1
          stack.push(nx, ny)
        }
      }
      if (count > face.count) face = { width: bx1 - bx0 + 1, height: by1 - by0 + 1, count }
    }
  }
  return { file, width: info.width, height: info.height, artW, artH, headBand, face }
}

const { args, dshDir } = splitDshFlag(process.argv.slice(2))
let to
let out
let feature = 'face'
let scale
const files = []
for (const value of args) {
  if (value.startsWith('--to=')) to = value.slice('--to='.length).split(',').map(part => part.trim())
  else if (value.startsWith('--out=')) out = value.slice('--out='.length)
  else if (value.startsWith('--feature=')) feature = value.slice('--feature='.length)
  else if (value.startsWith('--scale=')) scale = Number(value.slice('--scale='.length))
  else files.push(value)
}
const [frame] = files
if (frame === undefined || (to === undefined && scale === undefined)) {
  console.log('usage: node tools/normalize.mjs <frame> --to=<reference.png>[,...] [--feature=face|silhouette] [--out=scaled.png] [--scale=1.2] [--dsh=<checkout>]')
  process.exit(2)
}
if (feature !== 'face' && feature !== 'silhouette') throw new Error(`unknown feature ${JSON.stringify(feature)}: use face or silhouette`)

const sharp = await loadSharp(dshDir)
const measured = await measure(sharp, frame)
const value = each => (feature === 'face' ? each.face.count : each.artH)
console.log(`FRAME ${frame}`)
console.log(`  canvas ${String(measured.width)}x${String(measured.height)}  art ${String(measured.artW)}x${String(measured.artH)}  head band ${String(measured.headBand)}px  face ${String(measured.face.width)}x${String(measured.face.height)} (${String(measured.face.count)}px)`)

let factor = scale
if (factor === undefined) {
  const references = []
  for (const reference of to) {
    const candidate = await measure(sharp, reference)
    references.push(candidate)
    console.log(`  ref  ${reference}  art ${String(candidate.artW)}x${String(candidate.artH)}  head band ${String(candidate.headBand)}px  face ${String(candidate.face.width)}x${String(candidate.face.height)} (${String(candidate.face.count)}px)`)
  }
  const targets = references.map(value).filter(each => each > 0).sort((a, b) => a - b)
  if (targets.length === 0) throw new Error(`no reference carried a measurable ${feature}`)
  const target = targets[Math.floor(targets.length / 2)]
  const own = value(measured)
  if (own === 0) throw new Error(`the frame carries no measurable ${feature} — the model may have drawn her as a flat silhouette; rescale by hand with --scale`)
  // Area ratios scale linearly as their square root; heights scale directly.
  factor = feature === 'face' ? Math.sqrt(target / own) : target / own
  console.log(`FEATURE ${feature}: own ${String(own)} vs reference median ${String(target)} -> scale x${factor.toFixed(4)}`)
}
if (!Number.isFinite(factor) || factor <= 0) throw new Error(`unusable scale factor ${String(factor)}`)

if (out !== undefined) {
  const meta = await sharp(frame).metadata()
  await sharp(frame)
    .ensureAlpha()
    .resize(Math.round(meta.width * factor), Math.round(meta.height * factor), { kernel: 'lanczos3' })
    .png()
    .toFile(out)
  console.log(`SCALED x${factor.toFixed(4)} -> ${out}`)
} else {
  console.log(`DRY RUN: pass --out= to write the x${factor.toFixed(4)} frame`)
}

const folder = join(frame, '..')
if (readdirSync(folder).some(name => /^frame-\d+\.png$/.test(name))) {
  console.log('NOTE this frame sits next to a sliced sequence; check the result against its neighbours before assembling.')
}
