/**
 * Assemble PNG frames into an animated GIF without any third-party encoder:
 * median-cut palette quantization, GIF's LZW bitstream, and the GIF89a
 * animation blocks are all implemented here.
 *
 *   node tools/make-gif.mjs --out=anim.gif [--delay=10 | --delays=16,9,15,5,13,22 | --exposures=4,2,6,2,4,6] [--scale=2] [--trim] [--loop=0] <frame.png ... | dir>
 *
 * Timing is what makes a short frame set read as an attack: `--delay` gives
 * every frame the same dwell, `--delays` sets each frame's dwell in 1/100s, and
 * `--exposures` uses the animator's unit — 24fps frames held per drawing. GIF
 * stores delays in centiseconds, so a 24fps grid can only be approximated here;
 * make-apng.mjs writes it exactly.
 *
 * GIF cannot carry partial alpha, so soft edges are binarized at `--alpha`
 * (default 128) and every frame shares one 255-colour global palette plus a
 * single transparent index. Frames are drawn with disposal method 2, which
 * clears each frame before the next one is painted. The written file is read
 * back with sharp as a self-check that it is a valid animation of N pages.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSharp, splitDshFlag } from './sharp.mjs'
import { collectFrames, loadFrames, trimBox, resolveSchedule, describeSchedule, buildManifest } from './frames.mjs'

const { args, dshDir } = splitDshFlag(process.argv.slice(2))
let out
let delay = 10
let delays
let exposures
let scale = 1
let loop = 0
let alphaThreshold = 128
let trim = false
let manifest
const positionals = []
for (const value of args) {
  if (value.startsWith('--out=')) out = value.slice('--out='.length)
  else if (value.startsWith('--manifest=')) manifest = value.slice('--manifest='.length)
  else if (value.startsWith('--delays=')) {
    delays = value.slice('--delays='.length).split(',').map(part => Number(part.trim()))
    if (delays.some(each => !Number.isInteger(each) || each < 0 || each > 65535)) throw new Error(`--delays must be whole 1/100s values in 0..65535, got ${JSON.stringify(value)}`)
  } else if (value.startsWith('--exposures=')) exposures = value.slice('--exposures='.length).split(',').map(part => Number(part.trim()))
  else if (value.startsWith('--delay=')) delay = Number(value.slice('--delay='.length))
  else if (value.startsWith('--scale=')) scale = Number(value.slice('--scale='.length))
  else if (value.startsWith('--loop=')) loop = Number(value.slice('--loop='.length))
  else if (value.startsWith('--alpha=')) alphaThreshold = Number(value.slice('--alpha='.length))
  else if (value === '--trim') trim = true
  else positionals.push(value)
}
if (out === undefined || positionals.length === 0) {
  console.log('usage: node tools/make-gif.mjs --out=anim.gif [--delay=10 | --delays=16,9 | --exposures=4,2,6] [--scale=2] [--trim] [--loop=0] [--alpha=128] <frame.png ... | dir> [--dsh=<checkout>]')
  process.exit(2)
}

const files = collectFrames(positionals)
const sharp = await loadSharp(dshDir)
const loaded = await loadFrames(sharp, files, scale)
const { width, height } = loaded[0]
const alphaAt = (frame, x, y) => frame.data[(y * width + x) * 4 + 3]

let box = { x: 0, y: 0, width, height }
if (trim) {
  box = trimBox(loaded, alphaThreshold)
  console.log(`TRIM ${String(width)}x${String(height)} -> ${String(box.width)}x${String(box.height)} at (${String(box.x)},${String(box.y)})`)
}
const schedule = resolveSchedule({ count: files.length, delay, delays, exposures })
const centiseconds = schedule.map(each => Math.round(each.num / each.den * 100))
if (centiseconds.some(each => each < 2)) console.log(`WARN a dwell below 2/100s is clamped to 100ms by browsers; got ${centiseconds.join(',')}`)
console.log(`TIMING ${describeSchedule(schedule)} -> ${centiseconds.join(',')}/100s`)

// One global palette for every frame, built from a 15-bit colour histogram.
const hist = new Map()
for (const frame of loaded) {
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const at = (y * width + x) * 4
      if (frame.data[at + 3] < alphaThreshold) continue
      const r = frame.data[at]
      const g = frame.data[at + 1]
      const b = frame.data[at + 2]
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      const bucket = hist.get(key)
      if (bucket === undefined) hist.set(key, { count: 1, sumR: r, sumG: g, sumB: b })
      else {
        bucket.count += 1
        bucket.sumR += r
        bucket.sumG += g
        bucket.sumB += b
      }
    }
  }
}

function makeBox(items) {
  let count = 0
  let sumR = 0
  let sumG = 0
  let sumB = 0
  for (const item of items) {
    count += item.count
    sumR += item.sumR
    sumG += item.sumG
    sumB += item.sumB
  }
  return { items, count, sumR, sumG, sumB }
}

const channel = (item, which) => (which === 0 ? item.r5 : which === 1 ? item.g5 : item.b5)

/** Median cut: split the most populated box at its widest channel's median. */
function medianCut(maxColors) {
  const items = []
  for (const [key, value] of hist) {
    items.push({ r5: (key >> 10) & 31, g5: (key >> 5) & 31, b5: key & 31, count: value.count, sumR: value.sumR, sumG: value.sumG, sumB: value.sumB })
  }
  const boxes = [makeBox(items)]
  while (boxes.length < maxColors) {
    let target = -1
    for (let i = 0; i < boxes.length; i += 1) {
      if (boxes[i].items.length < 2) continue
      if (target === -1 || boxes[i].count > boxes[target].count) target = i
    }
    if (target === -1) break
    const box = boxes[target]
    let which = 0
    let widest = -1
    for (let c = 0; c < 3; c += 1) {
      let min = 32
      let max = -1
      for (const item of box.items) {
        const value = channel(item, c)
        if (value < min) min = value
        if (value > max) max = value
      }
      if (max - min > widest) {
        widest = max - min
        which = c
      }
    }
    box.items.sort((a, b) => channel(a, which) - channel(b, which))
    let acc = 0
    let cut = 1
    for (let i = 0; i < box.items.length; i += 1) {
      acc += box.items[i].count
      if (acc * 2 >= box.count) {
        cut = Math.min(i + 1, box.items.length - 1)
        break
      }
    }
    boxes.splice(target, 1, makeBox(box.items.slice(0, cut)), makeBox(box.items.slice(cut)))
  }
  return boxes.map(box => [
    Math.round(box.sumR / box.count),
    Math.round(box.sumG / box.count),
    Math.round(box.sumB / box.count),
  ])
}

const palette = medianCut(255)
console.log(`PALETTE ${String(hist.size)} distinct colours -> ${String(palette.length)} entries (index 0 stays transparent)`)

const nearest = new Map()
function indexOf(r, g, b) {
  const key = (r << 16) | (g << 8) | b
  const cached = nearest.get(key)
  if (cached !== undefined) return cached
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < palette.length; i += 1) {
    const dr = r - palette[i][0]
    const dg = g - palette[i][1]
    const db = b - palette[i][2]
    const distance = dr * dr + dg * dg + db * db
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  nearest.set(key, best)
  return best
}

const frames = []
for (const frame of loaded) {
  const indices = new Uint8Array(box.width * box.height)
  let opaque = 0
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) {
      const at = ((y + box.y) * width + (x + box.x)) * 4
      const index = y * box.width + x
      if (frame.data[at + 3] < alphaThreshold) {
        indices[index] = 0
        continue
      }
      indices[index] = indexOf(frame.data[at], frame.data[at + 1], frame.data[at + 2]) + 1
      opaque += 1
    }
  }
  frames.push(indices)
  console.log(`FRAME ${String(frames.length)}: ${frame.file} -> ${(opaque / (box.width * box.height) * 100).toFixed(1)}% opaque pixels`)
}

/** GIF's variable-width LZW, emitted as 255-byte sub-blocks. */
function lzwCompress(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize
  const endCode = clearCode + 1
  let codeSize = minCodeSize + 1
  let next = endCode + 1
  let table = new Map()
  const bytes = []
  let bits = 0
  let bitCount = 0
  const emit = (code) => {
    bits |= code << bitCount
    bitCount += codeSize
    while (bitCount >= 8) {
      bytes.push(bits & 0xff)
      bits >>= 8
      bitCount -= 8
    }
  }
  emit(clearCode)
  let prefix = indices[0]
  for (let i = 1; i < indices.length; i += 1) {
    const next8 = indices[i]
    const key = (prefix << 8) | next8
    const found = table.get(key)
    if (found !== undefined) {
      prefix = found
      continue
    }
    emit(prefix)
    if (next < 4096) {
      table.set(key, next)
      next += 1
      if (next > (1 << codeSize) && codeSize < 12) codeSize += 1
    } else {
      emit(clearCode)
      table = new Map()
      next = endCode + 1
      codeSize = minCodeSize + 1
    }
    prefix = next8
  }
  emit(prefix)
  emit(endCode)
  if (bitCount > 0) bytes.push(bits & 0xff)
  return bytes
}

const gif = []
const byte = value => gif.push(value & 0xff)
const short = value => { byte(value); byte(value >> 8) }
const text = value => { for (const character of value) byte(character.charCodeAt(0)) }

text('GIF89a')
short(box.width)
short(box.height)
byte(0x80 | (7 << 4) | 7)
byte(0)
byte(0)
byte(0)
byte(0)
byte(0)
for (let i = 0; i < 255; i += 1) {
  byte(palette[i] === undefined ? 0 : palette[i][0])
  byte(palette[i] === undefined ? 0 : palette[i][1])
  byte(palette[i] === undefined ? 0 : palette[i][2])
}
byte(0x21)
byte(0xff)
byte(0x0b)
text('NETSCAPE2.0')
byte(0x03)
byte(0x01)
short(loop)
byte(0)
for (const [index, indices] of frames.entries()) {
  byte(0x21)
  byte(0xf9)
  byte(0x04)
  byte(0x09)
  short(centiseconds[index])
  byte(0)
  byte(0)
  byte(0x2c)
  short(0)
  short(0)
  short(box.width)
  short(box.height)
  byte(0)
  const minCodeSize = 8
  byte(minCodeSize)
  const compressed = lzwCompress(indices, minCodeSize)
  for (let at = 0; at < compressed.length; at += 255) {
    const chunk = compressed.slice(at, at + 255)
    byte(chunk.length)
    for (const value of chunk) byte(value)
  }
  byte(0)
}
byte(0x3b)

writeFileSync(out, Buffer.from(gif))
console.log(`WROTE ${out} ${String(gif.length)} bytes (${String(box.width)}x${String(box.height)}, ${String(frames.length)} frames, timing ${centiseconds.join(',')}/100s, loop ${String(loop)})`)
if (manifest !== undefined) {
  const value = buildManifest({
    source: files.length === 1 ? files[0] : null,
    format: 'gif',
    canvas: { width: box.width, height: box.height },
    crop: box,
    schedule,
    plays: loop,
    files: loaded.map(frame => frame.file),
  })
  writeFileSync(manifest, `${JSON.stringify(value, null, 2)}\n`)
  console.log(`MANIFEST -> ${manifest} (${String(value.totalExposures)} frames at 24fps = ${String(value.totalSeconds)}s per loop)`)
}

const check = await sharp(out, { animated: true }).metadata()
console.log(`VERIFY format=${String(check.format)} ${String(check.width)}x${String(check.pageHeight)} pages=${String(check.pages)} (${String(check.pages) === String(frames.length) ? 'ok' : 'MISMATCH'})`)
