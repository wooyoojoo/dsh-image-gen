/**
 * Assemble PNG frames into an animated PNG (APNG), the format that carries
 * what GIF cannot: exact rational frame delays and real partial alpha.
 *
 *   node tools/make-apng.mjs --out=anim.png [--exposures=5,2,7,1,1,4,5 | --delays=17,8,25,4,4,17,21 | --delay=10] [--trim] [--scale=2] [--plays=0] <frame.png ... | dir>
 *
 * `--exposures` is the animator's unit: the number of 24fps frames each drawing
 * is held, written into the file as `delay_num/delay_den` without rounding, so
 * a 24fps exposure sheet survives intact (GIF can only approximate it in
 * centiseconds). No palette quantization happens here either — frames stay full
 * RGBA, so anti-aliased edges keep their soft alpha.
 *
 * Every frame is written full-canvas with blend_op SOURCE and dispose_op NONE,
 * which replaces the previous frame outright: the correct behaviour for a
 * sprite animation. The written file is parsed back (chunk order, sequence
 * numbers, frame count) and read with sharp as a self-check.
 */

import { writeFileSync, readFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { loadSharp, splitDshFlag } from './sharp.mjs'
import { collectFrames, loadFrames, trimBox, resolveSchedule, describeSchedule, buildManifest } from './frames.mjs'

const { args, dshDir } = splitDshFlag(process.argv.slice(2))
let out
let delay = 10
let delays
let exposures
let scale = 1
let plays = 0
let alphaThreshold = 128
let trim = false
let manifest
const positionals = []
for (const value of args) {
  if (value.startsWith('--out=')) out = value.slice('--out='.length)
  else if (value.startsWith('--manifest=')) manifest = value.slice('--manifest='.length)
  else if (value.startsWith('--delays=')) delays = value.slice('--delays='.length).split(',').map(part => Number(part.trim()))
  else if (value.startsWith('--exposures=')) exposures = value.slice('--exposures='.length).split(',').map(part => Number(part.trim()))
  else if (value.startsWith('--delay=')) delay = Number(value.slice('--delay='.length))
  else if (value.startsWith('--scale=')) scale = Number(value.slice('--scale='.length))
  else if (value.startsWith('--plays=')) plays = Number(value.slice('--plays='.length))
  else if (value.startsWith('--loop=')) plays = Number(value.slice('--loop='.length))
  else if (value.startsWith('--alpha=')) alphaThreshold = Number(value.slice('--alpha='.length))
  else if (value === '--trim') trim = true
  else positionals.push(value)
}
if (out === undefined || positionals.length === 0) {
  console.log('usage: node tools/make-apng.mjs --out=anim.png [--exposures=5,2,7,1,1,4,5 | --delays=17,8 | --delay=10] [--trim] [--scale=2] [--plays=0] [--alpha=128] <frame.png ... | dir> [--dsh=<checkout>]')
  process.exit(2)
}

const files = collectFrames(positionals)
const sharp = await loadSharp(dshDir)
const loaded = await loadFrames(sharp, files, scale)
const { width, height } = loaded[0]
let box = { x: 0, y: 0, width, height }
if (trim) {
  box = trimBox(loaded, alphaThreshold)
  console.log(`TRIM ${String(width)}x${String(height)} -> ${String(box.width)}x${String(box.height)} at (${String(box.x)},${String(box.y)})`)
}
const schedule = resolveSchedule({ count: files.length, delay, delays, exposures })
if (schedule.some(each => !Number.isFinite(each.num) || !Number.isFinite(each.den) || each.num < 1 || each.den < 1)) {
  throw new Error(`every dwell must be a positive rational, got ${JSON.stringify(schedule)}`)
}
console.log(`TIMING ${describeSchedule(schedule)}`)

/** PNG scanline filtering: pick the filter with the smallest absolute-sum per row. */
function filterScanlines(rgba, frameWidth, frameHeight) {
  const bpp = 4
  const stride = frameWidth * bpp
  const out = Buffer.alloc((stride + 1) * frameHeight)
  const candidates = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)]
  for (let y = 0; y < frameHeight; y += 1) {
    const row = y * stride
    const previous = (y - 1) * stride
    let bestType = 0
    let bestScore = Infinity
    for (let type = 0; type < 5; type += 1) {
      const target = candidates[type]
      let score = 0
      for (let i = 0; i < stride; i += 1) {
        const raw = rgba[row + i]
        const left = i >= bpp ? rgba[row + i - bpp] : 0
        const up = y > 0 ? rgba[previous + i] : 0
        const upLeft = y > 0 && i >= bpp ? rgba[previous + i - bpp] : 0
        let value
        if (type === 0) value = raw
        else if (type === 1) value = raw - left
        else if (type === 2) value = raw - up
        else if (type === 3) value = raw - ((left + up) >> 1)
        else {
          const estimate = left + up - upLeft
          const da = Math.abs(estimate - left)
          const db = Math.abs(estimate - up)
          const dc = Math.abs(estimate - upLeft)
          value = raw - (da <= db && da <= dc ? left : db <= dc ? up : upLeft)
        }
        value &= 0xff
        target[i] = value
        score += value < 128 ? value : 256 - value
      }
      if (score < bestScore) {
        bestScore = score
        bestType = type
      }
    }
    out[y * (stride + 1)] = bestType
    candidates[bestType].copy(out, y * (stride + 1) + 1)
  }
  return out
}

const crcTable = new Int32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c
}
function crc32(buffer) {
  let crc = -1
  for (const value of buffer) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
function frameControl(sequence, num, den) {
  const data = Buffer.alloc(26)
  data.writeUInt32BE(sequence, 0)
  data.writeUInt32BE(box.width, 4)
  data.writeUInt32BE(box.height, 8)
  data.writeUInt32BE(0, 12)
  data.writeUInt32BE(0, 16)
  data.writeUInt16BE(num, 20)
  data.writeUInt16BE(den, 22)
  data[24] = 0
  data[25] = 0
  return chunk('fcTL', data)
}

const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(box.width, 0)
ihdr.writeUInt32BE(box.height, 4)
ihdr[8] = 8
ihdr[9] = 6
parts.push(chunk('IHDR', ihdr))
const actl = Buffer.alloc(8)
actl.writeUInt32BE(loaded.length, 0)
actl.writeUInt32BE(plays, 4)
parts.push(chunk('acTL', actl))

let sequence = 0
let soft = 0
let softTotal = 0
const built = []
for (const [index, frame] of loaded.entries()) {
  const pixels = Buffer.alloc(box.width * box.height * 4)
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) {
      const src = ((y + box.y) * width + (x + box.x)) * 4
      const dst = (y * box.width + x) * 4
      const alpha = frame.data[src + 3]
      if (alpha > 0 && alpha < 255) soft += 1
      softTotal += 1
      pixels[dst] = frame.data[src]
      pixels[dst + 1] = frame.data[src + 1]
      pixels[dst + 2] = frame.data[src + 2]
      pixels[dst + 3] = alpha
    }
  }
  const compressed = deflateSync(filterScanlines(pixels, box.width, box.height), { level: 9 })
  built.push(pixels)
  parts.push(frameControl(sequence, schedule[index].num, schedule[index].den))
  sequence += 1
  if (index === 0) {
    parts.push(chunk('IDAT', compressed))
  } else {
    const data = Buffer.alloc(4 + compressed.length)
    data.writeUInt32BE(sequence, 0)
    sequence += 1
    compressed.copy(data, 4)
    parts.push(chunk('fdAT', data))
  }
  console.log(`FRAME ${String(index + 1)}: ${frame.file} held ${String(schedule[index].num)}/${String(schedule[index].den)}s -> ${String(compressed.length)} bytes`)
}
parts.push(chunk('IEND', Buffer.alloc(0)))
const png = Buffer.concat(parts)
writeFileSync(out, png)
console.log(`WROTE ${out} ${String(png.length)} bytes (${String(box.width)}x${String(box.height)}, ${String(loaded.length)} frames, plays ${String(plays)})`)
if (manifest !== undefined) {
  const value = buildManifest({
    source: files.length === 1 ? files[0] : null,
    format: 'apng',
    canvas: { width: box.width, height: box.height },
    crop: box,
    schedule,
    plays,
    files: loaded.map(frame => frame.file),
  })
  writeFileSync(manifest, `${JSON.stringify(value, null, 2)}\n`)
  console.log(`MANIFEST -> ${manifest} (${String(value.totalExposures)} frames at 24fps = ${String(value.totalSeconds)}s per loop)`)
}
console.log(`ALPHA ${(soft / softTotal * 100).toFixed(1)}% of pixels carry partial alpha — GIF had to binarize these`)

const parsed = readFileSync(out)
let at = 8
const seen = []
const data = []
let declared = -1
while (at < parsed.length) {
  const size = parsed.readUInt32BE(at)
  const type = parsed.toString('ascii', at + 4, at + 8)
  if (type === 'acTL') declared = parsed.readUInt32BE(at + 8)
  if (type === 'fcTL') seen.push(parsed.readUInt32BE(at + 8))
  if (type === 'fdAT') data.push(parsed.subarray(at + 12, at + 8 + size))
  at += 12 + size
}

/** Undo PNG scanline filtering, so a written frame can be compared with its source. */
function unfilterScanlines(raw, frameWidth, frameHeight) {
  const bpp = 4
  const stride = frameWidth * bpp
  const out = Buffer.alloc(stride * frameHeight)
  let position = 0
  for (let y = 0; y < frameHeight; y += 1) {
    const type = raw[position]
    position += 1
    for (let i = 0; i < stride; i += 1) {
      const value = raw[position + i]
      const left = i >= bpp ? out[y * stride + i - bpp] : 0
      const up = y > 0 ? out[(y - 1) * stride + i] : 0
      const upLeft = y > 0 && i >= bpp ? out[(y - 1) * stride + i - bpp] : 0
      let restored
      if (type === 0) restored = value
      else if (type === 1) restored = value + left
      else if (type === 2) restored = value + up
      else if (type === 3) restored = value + ((left + up) >> 1)
      else {
        const estimate = left + up - upLeft
        const da = Math.abs(estimate - left)
        const db = Math.abs(estimate - up)
        const dc = Math.abs(estimate - upLeft)
        restored = value + (da <= db && da <= dc ? left : db <= dc ? up : upLeft)
      }
      out[y * stride + i] = restored & 0xff
    }
    position += stride
  }
  return out
}

const lastPayload = data[data.length - 1]
const decoded = unfilterScanlines(inflateSync(lastPayload), box.width, box.height)
const roundTrip = decoded.equals(built[built.length - 1])
const check = await sharp(out).metadata()
// Sequence numbers advance for every fcTL and every fdAT; the first frame pairs
// fcTL(0) with IDAT, which carries none, so its successors are the odd numbers.
const expected = loaded.map((_, index) => (index === 0 ? 0 : index * 2 - 1))
const structure = declared === loaded.length && seen.length === loaded.length && seen.every((value, index) => value === expected[index])
console.log(`VERIFY apng ${String(check.width)}x${String(check.height)} format=${String(check.format)} frames declared=${String(declared)} fcTL=${String(seen.length)} sequence=${seen.join(',')} — structure ${structure ? 'ok' : 'MISMATCH'}, last frame decoded back byte-identical ${roundTrip ? 'ok' : 'MISMATCH'}`)
console.log('NOTE sharp reads only the still image of an APNG (no page count); browsers animate it natively.')
