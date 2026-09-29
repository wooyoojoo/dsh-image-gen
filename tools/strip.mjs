/**
 * Throwaway: composite arbitrary frames into one bottom-aligned horizontal
 * strip, so a rescale can be judged against its neighbours by eye.
 */
import { loadSharp } from './sharp.mjs'

const args = process.argv.slice(2)
let out
let shim = 12
const files = []
for (const value of args) {
  if (value.startsWith('--out=')) out = value.slice('--out='.length)
  else if (value.startsWith('--shim=')) shim = Number(value.slice('--shim='.length))
  else files.push(value)
}
const lib = await loadSharp()
const loaded = []
for (const file of files) {
  const { data, info } = await lib(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  loaded.push({ data, width: info.width, height: info.height })
}
const height = Math.max(...loaded.map(frame => frame.height))
const width = loaded.reduce((sum, frame) => sum + frame.width, 0) + shim * (loaded.length - 1)
const canvas = Buffer.alloc(width * height * 4)
let at = 0
for (const frame of loaded) {
  for (let y = 0; y < frame.height; y += 1) {
    const source = y * frame.width * 4
    const dest = ((height - frame.height + y) * width + at) * 4
    frame.data.copy(canvas, dest, source, source + frame.width * 4)
  }
  at += frame.width + shim
}
await lib(canvas, { raw: { width, height, channels: 4 } }).png().toFile(out)
console.log(`STRIP -> ${out} ${String(width)}x${String(height)} (${files.length} frames, shim ${String(shim)})`)
