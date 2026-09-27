/**
 * Self-test for `dsh-imagegen`: no network, no dependencies.
 *
 *   node smoke.mjs
 *
 * Covers the pure helpers (endpoint resolution, argument validation, request
 * bodies) and then drives the real `execute` against a local stub server that
 * speaks both endpoints — which is the only way to prove the multipart edit
 * path and the file-saving path without spending a provider call.
 *
 * Scope note: this file covers the **server half** (`index.js`). The original
 * scratch-directory smoke also loaded `client.js` in a VM and drove the card
 * render; that copy was lost with the source directory, so the client half is
 * currently only exercised by starting the GUI (see README「自检」).
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  appendEditFields,
  buildGenerationBody,
  defineGenerateImage,
  MAX_INPUT_IMAGES,
  parseArgs,
  requestKind,
  resolveConfig,
  resolveEndpoint,
  resolveOutputDir,
} from './index.js'

/** A real 1x1 PNG, so the sniffing and the byte comparison both mean something. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

let failures = 0
let checks = 0

function check(name, fn) {
  checks += 1
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}\n       ${error.message}`)
  }
}

async function checkAsync(name, fn) {
  checks += 1
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}\n       ${error.message}`)
  }
}

const config = resolveConfig({ model: 'stub-model', size: '1024x1024' })

console.log('resolveEndpoint')
check('bare origin → generations', () => {
  assert.equal(resolveEndpoint('https://r.example.com'), 'https://r.example.com/v1/images/generations')
})
check('/v1 base → generations', () => {
  assert.equal(resolveEndpoint('https://r.example.com/v1'), 'https://r.example.com/v1/images/generations')
})
check('path prefix + trailing slash → generations', () => {
  assert.equal(resolveEndpoint('https://r.example.com/openai/v1/'), 'https://r.example.com/openai/v1/images/generations')
})
check('complete generations endpoint is kept', () => {
  assert.equal(
    resolveEndpoint('https://r.example.com/v1/images/generations'),
    'https://r.example.com/v1/images/generations',
  )
})
check('bare origin → edits', () => {
  assert.equal(resolveEndpoint('https://r.example.com', 'edits'), 'https://r.example.com/v1/images/edits')
})
check('complete generations endpoint swaps to edits', () => {
  assert.equal(
    resolveEndpoint('https://r.example.com/v1/images/generations', 'edits'),
    'https://r.example.com/v1/images/edits',
  )
})
check('non-http base is rejected', () => {
  assert.throws(() => resolveEndpoint('ftp://r.example.com'), /must use http or https/)
})
check('unknown kind is rejected', () => {
  assert.throws(() => resolveEndpoint('https://r.example.com', 'upscale'), /unknown request kind/)
})

console.log('parseArgs')
check('image as a bare string becomes a one-element list and selects edits', () => {
  const request = parseArgs({ prompt: 'x', image: 'a.png' }, config)
  assert.deepEqual(request.images, ['a.png'])
  assert.equal(requestKind(request), 'edits')
})
check('no image selects generations', () => {
  assert.equal(requestKind(parseArgs({ prompt: 'x' }, config)), 'generations')
})
check('several images are kept in order', () => {
  assert.deepEqual(parseArgs({ prompt: 'x', image: ['a.png', 'b.png'] }, config).images, ['a.png', 'b.png'])
})
check(`more than ${MAX_INPUT_IMAGES} images are rejected`, () => {
  assert.throws(
    () => parseArgs({ prompt: 'x', image: Array.from({ length: MAX_INPUT_IMAGES + 1 }, (_, i) => `${i}.png`) }, config),
    /at most/,
  )
})
check('an empty image list is rejected', () => {
  assert.throws(() => parseArgs({ prompt: 'x', image: [] }, config), /at least one file/)
})
check('mask without image is rejected', () => {
  assert.throws(() => parseArgs({ prompt: 'x', mask: 'm.png' }, config), /mask needs at least one image/)
})
check('transparent + jpeg is rejected', () => {
  assert.throws(
    () => parseArgs({ prompt: 'x', background: 'transparent', output_format: 'jpeg' }, config),
    /cannot be combined/,
  )
})
check('transparent + png is accepted', () => {
  const request = parseArgs({ prompt: 'x', background: 'transparent', output_format: 'png' }, config)
  assert.equal(request.background, 'transparent')
  assert.equal(request.outputFormat, 'png')
})
check('providerOptions is merged and extra wins a collision', () => {
  const request = parseArgs({ prompt: 'x', providerOptions: { a: 1, b: 2 }, extra: { b: 3, c: 4 } }, config)
  assert.deepEqual(request.extra, { a: 1, b: 3, c: 4 })
})
check('non-object extra is rejected', () => {
  assert.throws(() => parseArgs({ prompt: 'x', extra: 'nope' }, config), /extra must be an object/)
})
check('seed accepts an integer and a string, rejects a boolean', () => {
  assert.equal(parseArgs({ prompt: 'x', seed: 7 }, config).seed, 7)
  assert.equal(parseArgs({ prompt: 'x', seed: '7' }, config).seed, '7')
  assert.throws(() => parseArgs({ prompt: 'x', seed: true }, config), /seed must be an integer or a string/)
})
check('unknown arguments are still rejected', () => {
  assert.throws(() => parseArgs({ prompt: 'x', strength: 0.5 }, config), /unknown argument\(s\) strength/)
})
check('n stays bounded', () => {
  assert.throws(() => parseArgs({ prompt: 'x', n: 5 }, config), /n must be an integer/)
})

console.log('request bodies')
check('generations body: explicit fields win and absent fields are omitted', () => {
  const request = parseArgs(
    { prompt: 'p', model: 'm', size: 's', background: 'transparent', seed: 7, extra: { size: 'SHOULD_LOSE', guidance_scale: 7 } },
    config,
  )
  const body = buildGenerationBody(request)
  assert.deepEqual(body, { guidance_scale: 7, model: 'm', prompt: 'p', n: 1, size: 's', background: 'transparent', seed: 7 })
  assert.equal('quality' in body, false)
  assert.equal('output_format' in body, false)
})
check('edit fields: strings stay, structures are JSON-encoded', () => {
  const request = parseArgs({ prompt: 'p', image: 'a.png', extra: { response_modalities: ['image'] } }, config)
  const value = appendEditFields(new FormData(), request).get('response_modalities')
  assert.equal(value, '["image"]')
})
check('edit fields omit undefined values', () => {
  const form = appendEditFields(new FormData(), parseArgs({ prompt: 'p', image: 'a.png' }, config))
  assert.equal(form.has('quality'), false)
  assert.equal(form.has('background'), false)
})
check('outputDir resolves against the configured default', () => {
  assert.equal(resolveOutputDir('sub', 'C:/base'), resolve('C:/base', 'sub'))
  assert.equal(resolveOutputDir(undefined, 'C:/base'), 'C:/base')
})

console.log('config')
check('config keeps the raw base and the pass-through defaults', () => {
  const resolved = resolveConfig({ baseUrl: 'https://r.example.com/v1', background: 'transparent', outputFormat: 'png' })
  assert.equal(resolved.baseUrl, 'https://r.example.com/v1')
  assert.equal(resolved.endpoint, 'https://r.example.com/v1/images/generations')
  assert.equal(resolved.background, 'transparent')
  assert.equal(resolved.outputFormat, 'png')
})
check('a malformed explicit base still fails while loading', () => {
  assert.throws(() => resolveConfig({ baseUrl: 'not a url' }), /not an absolute URL/)
})

console.log('execute against a local stub server')
const dir = await mkdtemp(join(tmpdir(), 'dsh-imagegen-test-'))
const inputImage = join(dir, 'in.png')
const maskImage = join(dir, 'mask.png')
await writeFile(inputImage, PNG)
await writeFile(maskImage, PNG)

const seen = []
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    seen.push({ url: req.url, contentType: req.headers['content-type'] ?? '', raw: Buffer.concat(chunks) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
})
await new Promise(ready => server.listen(0, '127.0.0.1', ready))
const port = server.address().port
const outDir = join(dir, 'out')
const stubConfig = resolveConfig({
  baseUrl: `http://127.0.0.1:${port}/v1`,
  apiKey: 'test-key',
  model: 'stub-model',
  outputDir: outDir,
})
const tool = defineGenerateImage({ get: () => undefined }, stubConfig)
const exec = { signal: new AbortController().signal }

try {
  await checkAsync('generations call posts JSON to /images/generations and saves the file', async () => {
    const result = await tool.execute({ prompt: 'a cat', background: 'transparent', outputDir: 'gen' }, exec)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, '/v1/images/generations')
    assert.match(seen[0].contentType, /^application\/json/)
    const body = JSON.parse(seen[0].raw.toString('utf8'))
    assert.equal(body.prompt, 'a cat')
    assert.equal(body.background, 'transparent')
    assert.equal(result.mode, 'generations')
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].path.startsWith(join(outDir, 'gen')), true)
    assert.deepEqual(await readFile(result.images[0].path), PNG)
  })

  await checkAsync('an image argument posts multipart to /images/edits with every field', async () => {
    const result = await tool.execute(
      {
        prompt: 'make the arm thicker',
        image: [inputImage],
        mask: maskImage,
        background: 'transparent',
        output_format: 'png',
        seed: 3,
        input_fidelity: 'high',
        extra: { guidance_scale: 7 },
      },
      exec,
    )
    assert.equal(seen.length, 2)
    assert.equal(seen[1].url, '/v1/images/edits')
    assert.match(seen[1].contentType, /^multipart\/form-data; boundary=/)
    const text = seen[1].raw.toString('latin1')
    for (const field of ['name="image"', 'name="mask"', 'name="prompt"', 'name="background"', 'name="output_format"', 'name="seed"', 'name="input_fidelity"', 'name="guidance_scale"', 'name="n"']) {
      assert.equal(text.includes(field), true, `missing ${field}`)
    }
    assert.equal(text.includes('make the arm thicker'), true)
    assert.equal(result.mode, 'edits')
    assert.deepEqual(result.inputImages, [inputImage])
    assert.deepEqual(await readFile(result.images[0].path), PNG)
  })

  await checkAsync('an unreadable input image fails before any request', async () => {
    const before = seen.length
    await assert.rejects(
      () => tool.execute({ prompt: 'x', image: join(dir, 'missing.png') }, exec),
      /cannot read image file/,
    )
    assert.equal(seen.length, before)
  })

  await checkAsync('a non-image input fails before any request', async () => {
    const notAnImage = join(dir, 'notes.txt')
    await writeFile(notAnImage, 'hello')
    await assert.rejects(
      () => tool.execute({ prompt: 'x', image: notAnImage }, exec),
      /is not a PNG\/JPEG\/WebP\/GIF image/,
    )
  })
} finally {
  await new Promise(done => server.close(done))
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
