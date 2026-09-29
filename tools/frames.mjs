/**
 * Frame handling shared by the animation writers: collect frame files, load
 * them as 8-bit RGBA, work out the common crop box, and resolve each frame's
 * dwell time as an exact rational.
 *
 * The dwell is where a writer's format decides what it can express. `--delays`
 * counts 1/100s (GIF's unit), while `--exposures` counts 24fps frames — the
 * unit an exposure sheet uses. APNG writes either exactly (`delay_num` over
 * `delay_den`); GIF can only round 1/24s to centiseconds, so a 24fps grid is
 * approximate there and exact in APNG.
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Frame files from explicit paths and/or directories, numeric order per directory. */
export function collectFrames(positionals) {
  const files = []
  for (const item of positionals) {
    if (!statSync(item).isDirectory()) {
      files.push(item)
      continue
    }
    const found = readdirSync(item)
      .filter(name => /^frame-\d+\.png$/.test(name))
      .sort((a, b) => Number(a.replace(/\D+/g, '')) - Number(b.replace(/\D+/g, '')))
    if (found.length === 0) throw new Error(`${item} holds no frame-<n>.png files`)
    for (const name of found) files.push(join(item, name))
  }
  if (files.length < 2) throw new Error('an animation needs at least two frames')
  return files
}

/** Load every file as RGBA, optionally nearest-neighbour upscaled, all the same size. */
export async function loadFrames(sharp, files, scale) {
  const loaded = []
  for (const file of files) {
    const meta = await sharp(file).metadata()
    if (meta.width === undefined || meta.height === undefined) throw new Error(`${file} has no dimensions`)
    let pipeline = sharp(file).ensureAlpha()
    if (scale !== 1) pipeline = pipeline.resize(Math.round(meta.width * scale), Math.round(meta.height * scale), { kernel: 'nearest' })
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true })
    loaded.push({ file, data, width: info.width, height: info.height })
  }
  const { width, height } = loaded[0]
  for (const frame of loaded) {
    if (frame.width !== width || frame.height !== height) {
      throw new Error(`frames differ in size: ${frame.file} is ${String(frame.width)}x${String(frame.height)}, first frame is ${String(width)}x${String(height)}`)
    }
  }
  return loaded
}

/** Union box of the pixels whose alpha reaches the threshold, so alignment survives cropping. */
export function trimBox(frames, alphaThreshold) {
  const { width, height } = frames[0]
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const frame of frames) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (frame.data[(y * width + x) * 4 + 3] < alphaThreshold) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (minX === Infinity) throw new Error('every frame is fully transparent')
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * Dwell time per frame as `{ num, den }` seconds.
 * @param options - `count` frames, plus one of `delay` (uniform 1/100s), `delays` (per frame 1/100s) or `exposures` (per frame, 24fps frames).
 * @returns One rational per frame.
 */
export function resolveSchedule({ count, delay, delays, exposures }) {
  if (delays !== undefined && exposures !== undefined) throw new Error('give either --delays or --exposures, not both')
  if (delays !== undefined) {
    if (delays.length !== count) throw new Error(`--delays lists ${String(delays.length)} values but there are ${String(count)} frames`)
    return delays.map(num => ({ num, den: 100 }))
  }
  if (exposures !== undefined) {
    if (exposures.length !== count) throw new Error(`--exposures lists ${String(exposures.length)} values but there are ${String(count)} frames`)
    return exposures.map(num => ({ num, den: 24 }))
  }
  return Array.from({ length: count }, () => ({ num: delay, den: 100 }))
}

/** Human-readable schedule, in seconds and in 24fps frames. */
export function describeSchedule(schedule) {
  const seconds = schedule.reduce((sum, each) => sum + each.num / each.den, 0)
  const frames = schedule.map(each => (each.num / each.den * 24).toFixed(1)).join(' ')
  const unit = schedule.every(each => each.den === 24) ? `${schedule.map(each => String(each.num)).join(',')} frames` : schedule.map(each => `${String(each.num)}/${String(each.den)}s`).join(',')
  return `${unit} = ${seconds.toFixed(2)}s per loop; in 24fps frames: ${frames}`
}

/**
 * The delivery manifest an engine reads instead of a preview format: the frames
 * in play order with the hold time of each, plus the canvas and the crop the
 * writer applied. The engine holds each frame for `exposures` of its 24fps
 * timeline, which is the exposure sheet in machine-readable form.
 *
 * @param options - the source sheet, the format written, the canvas, the applied crop, the schedule, the play count and the frame files.
 * @returns The manifest object, ready to serialize.
 */
export function buildManifest({ source, format, canvas, crop, schedule, plays, files }) {
  const frames = schedule.map((each, index) => ({
    index,
    file: files[index] === undefined ? null : basename(files[index]),
    path: files[index] ?? null,
    exposures: Number((each.num / each.den * 24).toFixed(6)),
    hold: { num: each.num, den: each.den },
    seconds: Number((each.num / each.den).toFixed(6)),
  }))
  return {
    version: 1,
    basis: 24,
    format,
    source,
    plays,
    canvas,
    crop,
    totalExposures: Number(frames.reduce((sum, frame) => sum + frame.exposures, 0).toFixed(6)),
    totalSeconds: Number(frames.reduce((sum, frame) => sum + frame.seconds, 0).toFixed(6)),
    frames,
  }
}
