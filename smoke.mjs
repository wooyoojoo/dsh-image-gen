/**
 * Self-test for `dsh-imagegen`: no network, no dependencies.
 *
 *   node smoke.mjs
 *
 * Covers the pure helpers (endpoint resolution, argument validation, request
 * bodies), the Plugins-page surface (the override file, the image index, every
 * host route, and the credential writes), and then drives the real `execute`
 * against a local stub server that speaks both endpoints — which is the only
 * way to prove the multipart edit path, the file-saving path, and the index
 * write without spending a provider call.
 *
 * The harness home is redirected to a temporary directory before anything
 * touches it, so a test run never reads or writes the real `~/.dsh/imagegen`.
 *
 * It also loads `client.js` in a VM the way the Web shell does, drives every
 * surface it registers to its first render, and proves the module asks the
 * module table for nothing beyond `react` and `react-dom`; DOM behaviour and
 * the host round trip still need the GUI (see README「自检」).
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'

import {
  appendEditFields,
  apply,
  applyUpdate,
  buildGenerationBody,
  buildRoutes,
  buildStatus,
  createRuntime,
  defineGenerateImage,
  defineImageLibrary,
  MAX_INPUT_IMAGES,
  MAX_PAGE_SIZE,
  modelsUrl,
  OVERRIDE_FIELDS,
  parseArgs,
  probeConnection,
  readImageIndex,
  readOverrides,
  readUsage,
  recordGeneratedImages,
  redactCredentials,
  renderLibraryResult,
  renderResult,
  requestKind,
  resolveConfig,
  resolveEndpoint,
  resolveOutputDir,
  resolveStateDir,
  ROUTE_PREFIX,
  sanitizeOverrides,
  STATE_DIR_NAME,
  systemOpenCommand,
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
// The plugin's own state lives under the harness home; point it at this test's
// directory so a run never reads or writes the real one.
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = join(dir, 'home')

const seen = []
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    seen.push({ url: req.url, contentType: req.headers['content-type'] ?? '', raw: Buffer.concat(chunks) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: [{ b64_json: PNG.toString('base64') }],
      usage: { input_tokens: 11, output_tokens: 1756, total_tokens: 1767, input_tokens_details: { image_tokens: 0, text_tokens: 11 } },
    }))
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

  await checkAsync('every generated image is recorded in the index with what produced it', async () => {
    const index = await readImageIndex(resolveStateDir())
    assert.equal(index.length, 2)
    const newest = index[0]
    assert.equal(newest.mode, 'edits')
    assert.equal(newest.prompt, 'make the arm thicker')
    assert.equal(newest.model, 'stub-model')
    assert.equal(newest.bytes, PNG.byteLength)
    assert.equal(newest.mimeType, 'image/png')
    assert.deepEqual(newest.usage, {
      input_tokens: 11, output_tokens: 1756, total_tokens: 1767, input_tokens_details: { image_tokens: 0, text_tokens: 11 },
    })
    assert.equal(newest.name.endsWith('.png'), true)
    assert.deepEqual(newest.inputImages, [inputImage])
    assert.equal(index[1].mode, 'generations')
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
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(dir, { recursive: true, force: true })
}

console.log('state and overrides')
check('DSH_HOME decides the state directory, the home directory is the fallback', () => {
  assert.equal(resolveStateDir({ DSH_HOME: 'C:/dsh' }, 'C:/users/x'), join('C:/dsh', STATE_DIR_NAME))
  assert.equal(resolveStateDir({}, 'C:/users/x'), join('C:/users/x', '.dsh', STATE_DIR_NAME))
  assert.equal(resolveStateDir({ DSH_HOME: '   ' }, 'C:/users/x'), join('C:/users/x', '.dsh', STATE_DIR_NAME))
})
check('sanitizing keeps only owned fields, with usable values', () => {
  assert.deepEqual(
    sanitizeOverrides({ model: ' m ', size: 7, quality: '', timeoutMs: 0, outputDir: 'D:/out', baseUrl: 'x', extra: 1 }),
    { model: 'm', outputDir: 'D:/out' },
  )
  assert.deepEqual(sanitizeOverrides({ timeoutMs: 1000 }), { timeoutMs: 1000 })
  assert.deepEqual(sanitizeOverrides('nope'), {})
  assert.deepEqual(sanitizeOverrides(null), {})
})
check('a base URL never echoes embedded credentials', () => {
  assert.equal(redactCredentials('https://relay.example.com/v1'), 'https://relay.example.com/v1')
  assert.equal(redactCredentials('https://user:pass@relay.example.com/v1'), 'https://relay.example.com/v1')
  assert.equal(redactCredentials(undefined), undefined)
})
check('the models URL derives from every accepted base form', () => {
  for (const base of ['https://r.example.com', 'https://r.example.com/v1', 'https://r.example.com/v1/images/generations']) {
    assert.equal(modelsUrl(base), 'https://r.example.com/v1/models')
  }
})
check('the system open command is argv, never a shell, and matches the platform', () => {
  assert.deepEqual(systemOpenCommand('win32', 'D:/a/b.png', 'reveal'), { command: 'explorer.exe', args: ['/select,D:/a/b.png'] })
  assert.deepEqual(systemOpenCommand('win32', 'D:/a/b.png', 'open'), { command: 'explorer.exe', args: ['D:/a/b.png'] })
  assert.deepEqual(systemOpenCommand('darwin', '/a/b.png', 'open'), { command: 'open', args: ['/a/b.png'] })
  assert.deepEqual(systemOpenCommand('darwin', '/a/b.png', 'reveal'), { command: 'open', args: ['-R', '/a/b.png'] })
  assert.deepEqual(systemOpenCommand('linux', '/a/b.png', 'reveal'), { command: 'xdg-open', args: ['/a'] })
  assert.equal(systemOpenCommand('aix', '/a/b.png', 'open'), undefined)
})
check('result text spells saved paths with forward slashes, for copying into a message', () => {
  const text = renderResult({
    model: 'stub-model',
    mode: 'generations',
    images: [{ path: 'C:\\Users\\me\\.dsh\\out\\image-1.png', mimeType: 'image/png', bytes: 3 }],
  })
  assert.equal(text.includes('- C:/Users/me/.dsh/out/image-1.png (image/png, 3 bytes)'), true)
  // A backslash before punctuation is a Markdown escape, so none may survive.
  assert.equal(text.includes('\\'), false)
})
check('response usage keeps the counters and drops everything else', () => {
  assert.deepEqual(
    readUsage({ usage: { input_tokens: 11, output_tokens: 1756, total_tokens: 1767, junk: 'x', input_tokens_details: { image_tokens: 0, text_tokens: 11, other: 1 } } }),
    { input_tokens: 11, output_tokens: 1756, total_tokens: 1767, input_tokens_details: { image_tokens: 0, text_tokens: 11 } },
  )
  // A provider that omits usage, or answers with another shape, records nothing.
  assert.equal(readUsage({ data: [] }), undefined)
  assert.equal(readUsage({ usage: 'nope' }), undefined)
  assert.equal(readUsage({ usage: {} }), undefined)
  assert.equal(readUsage({ usage: { output_tokens: -1 } }), undefined)
  assert.equal(readUsage({ usage: { output_tokens: 1756.5 } }), undefined)
  assert.equal(readUsage(null), undefined)
})

/** A credential provider with the seam's shape: resolve, describe, set, unset. */
function fakeCredentialProvider(store = {}) {
  return {
    store,
    async resolve(ref) {
      return store[ref] === undefined ? undefined : { value: store[ref], source: 'file' }
    },
    async describe(ref) {
      return store[ref] === undefined
        ? { configured: false, writable: true }
        : { configured: true, source: 'file', writable: true }
    },
    async set(ref, value) { store[ref] = value },
    async unset(ref) { delete store[ref] },
  }
}

/** The plugin context shape these helpers read: `credentials` and nothing else. */
const fakeCtx = (credentials) => ({ get: name => (name === 'credentials' ? credentials : undefined) })

console.log('the Plugins page: status, credentials, and overrides')
const pageDir = await mkdtemp(join(tmpdir(), 'dsh-imagegen-page-'))
const pageHome = join(pageDir, 'home')
const homeBeforePage = process.env.DSH_HOME
process.env.DSH_HOME = pageHome

const credentials = fakeCredentialProvider()
const pageCtx = fakeCtx(credentials)
const pageConfig = resolveConfig({ outputDir: pageDir })
const pageRuntime = createRuntime(pageConfig)

try {
  await checkAsync('status reports unconfigured credentials and no overrides', async () => {
    const status = await buildStatus(pageCtx, pageConfig, pageRuntime)
    assert.equal(status.baseUrl.ref, 'IMAGE_BASE_URL')
    assert.equal(status.baseUrl.configured, false)
    assert.equal(status.baseUrl.pinned, false)
    assert.equal(status.apiKey.writable, true)
    assert.deepEqual(status.overrides, {})
    assert.equal(status.stateDir, join(pageHome, STATE_DIR_NAME))
    assert.equal(status.fields.model, 'gpt-image-2.5-flare')
    assert.equal(status.fields.timeoutMs, 300_000)
    // A field the deployment never set reports null, which the page shows as blank.
    assert.equal(status.fields.quality, null)
    for (const field of OVERRIDE_FIELDS) {
      const value = status.fields[field]
      assert.equal(value === null || typeof value === 'string' || typeof value === 'number', true, field)
    }
  })

  await checkAsync('writing the endpoint and the key lands in the credential store', async () => {
    assert.equal(await applyUpdate(pageCtx, pageConfig, pageRuntime, { field: 'baseUrl', value: 'https://relay.example.com/v1' }), undefined)
    assert.equal(await applyUpdate(pageCtx, pageConfig, pageRuntime, { field: 'apiKey', value: ' sk-test ' }), undefined)
    assert.deepEqual(credentials.store, {
      IMAGE_BASE_URL: 'https://relay.example.com/v1',
      IMAGE_API_KEY: 'sk-test',
    })
    const status = await buildStatus(pageCtx, pageConfig, pageRuntime)
    assert.equal(status.baseUrl.value, 'https://relay.example.com/v1')
    assert.equal(status.baseUrl.configured, true)
    assert.equal(status.apiKey.configured, true)
    // The key itself never crosses to the page, only whether one is stored.
    assert.equal('value' in status.apiKey, false)
  })

  await checkAsync('a malformed endpoint is refused with the resolver message', async () => {
    const failure = await applyUpdate(pageCtx, pageConfig, pageRuntime, { field: 'baseUrl', value: 'not a url' })
    assert.match(failure, /not an absolute URL/)
    assert.equal(credentials.store.IMAGE_BASE_URL, 'https://relay.example.com/v1')
  })

  await checkAsync('clearing a credential removes it from the store', async () => {
    assert.equal(await applyUpdate(pageCtx, pageConfig, pageRuntime, { field: 'apiKey', value: null }), undefined)
    assert.equal('IMAGE_API_KEY' in credentials.store, false)
  })

  await checkAsync('an override is written to disk and reaches the effective values', async () => {
    assert.equal(await applyUpdate(pageCtx, pageConfig, pageRuntime, { field: 'model', value: 'gpt-image-2.5-flare' }), undefined)
    assert.equal(await applyUpdate(pageCtx, pageConfig, pageRuntime, { field: 'timeoutMs', value: '45000' }), undefined)
    assert.deepEqual(await readOverrides(pageRuntime.stateDir), { model: 'gpt-image-2.5-flare', timeoutMs: 45_000 })
    assert.equal(pageRuntime.effective().model, 'gpt-image-2.5-flare')
    assert.equal(pageRuntime.effective().timeoutMs, 45_000)
    // The declared budget is read per call, so it follows the override.
    assert.equal(defineGenerateImage(pageCtx, pageConfig, pageRuntime).timeoutMs, 45_000)
  })

  await checkAsync('clearing an override falls back to the configured value', async () => {
    assert.equal(await applyUpdate(pageCtx, pageConfig, pageRuntime, { field: 'model', value: '' }), undefined)
    assert.deepEqual(await readOverrides(pageRuntime.stateDir), { timeoutMs: 45_000 })
    assert.equal(pageRuntime.effective().model, pageConfig.model)
  })

  await checkAsync('a non-integer timeout and an unknown field are refused', async () => {
    assert.match(await applyUpdate(pageCtx, pageConfig, pageRuntime, { field: 'timeoutMs', value: 'soon' }), /positive integer/)
    assert.match(await applyUpdate(pageCtx, pageConfig, pageRuntime, { field: 'baseUrlEnv', value: 'X' }), /unknown field/)
    assert.match(await applyUpdate(pageCtx, pageConfig, pageRuntime, { field: '', value: 'X' }), /must name the value/)
  })

  await checkAsync('a value the profile pins is refused, not silently ignored', async () => {
    const pinned = resolveConfig({ baseUrl: 'https://pinned.example.com/v1', outputDir: pageDir })
    const failure = await applyUpdate(pageCtx, pinned, createRuntime(pinned), { field: 'baseUrl', value: 'https://other.example.com' })
    assert.match(failure, /config\.baseUrl/)
    const status = await buildStatus(pageCtx, pinned, createRuntime(pinned))
    assert.equal(status.baseUrl.pinned, true)
    assert.equal(status.baseUrl.writable, false)
  })

  await checkAsync('a credential the seam refuses surfaces the seam message', async () => {
    const refusing = fakeCtx({
      async describe() { return { configured: true, source: 'env', writable: false } },
      async set() { throw new Error('credentials: "IMAGE_API_KEY" is supplied read-only by the launching environment') },
      async unset() { throw new Error('unreachable') },
    })
    const failure = await applyUpdate(refusing, pageConfig, pageRuntime, { field: 'apiKey', value: 'sk-x' })
    assert.match(failure, /read-only/)
  })
} finally {
  if (homeBeforePage === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = homeBeforePage
}

console.log('the Plugins page: host routes')
const routeDir = await mkdtemp(join(tmpdir(), 'dsh-imagegen-routes-'))
const homeBeforeRoutes = process.env.DSH_HOME
process.env.DSH_HOME = join(routeDir, 'home')

const routeImage = join(routeDir, 'image-1.png')
await writeFile(routeImage, PNG)
const routeConfig = resolveConfig({ outputDir: routeDir })
const routeRuntime = createRuntime(routeConfig)
await recordGeneratedImages(routeRuntime.stateDir, [{
  id: 'image-1',
  createdAt: '2026-09-27T00:00:00.000Z',
  path: routeImage,
  name: 'image-1.png',
  mimeType: 'image/png',
  bytes: PNG.byteLength,
  prompt: 'a cat',
  model: 'stub-model',
  size: '1024x1024',
  mode: 'generations',
}])
const routes = buildRoutes(fakeCtx(fakeCredentialProvider({ IMAGE_API_KEY: 'k' })), routeConfig, routeRuntime)
const routeOf = (name) => routes.find(candidate => candidate.path === `${ROUTE_PREFIX}/${name}`)
const call = (name, { method = 'GET', body, query = '' } = {}) => {
  const url = `http://127.0.0.1${ROUTE_PREFIX}/${name}${query}`
  return routeOf(name).fetch(new Request(url, method === 'GET' ? { method } : {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }))
}

try {
  await checkAsync('every route sits under the authenticated /api prefix and buffers its body', async () => {
    assert.deepEqual(routes.map(one => one.path), [
      `${ROUTE_PREFIX}/status`,
      `${ROUTE_PREFIX}/update`,
      `${ROUTE_PREFIX}/test`,
      `${ROUTE_PREFIX}/images`,
      `${ROUTE_PREFIX}/image`,
      `${ROUTE_PREFIX}/delete`,
      `${ROUTE_PREFIX}/open`,
      `${ROUTE_PREFIX}/reveal`,
    ])
    for (const one of routes) {
      assert.equal(one.path.startsWith('/api/'), true)
      assert.equal(one.requestBody, 'buffered')
      assert.equal(one.methods.length > 0, true)
    }
  })

  await checkAsync('the status route answers the whole read model', async () => {
    const payload = await (await call('status')).json()
    assert.equal(payload.ok, true)
    assert.equal(payload.status.apiKey.configured, true)
    assert.equal('value' in payload.status.apiKey, false)
  })

  await checkAsync('the update route commits and answers the fresh status', async () => {
    const response = await call('update', { method: 'POST', body: { field: 'size', value: '1536x1024' } })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).status.fields.size, '1536x1024')
    assert.equal(routeRuntime.effective().size, '1536x1024')
  })

  await checkAsync('a refused update answers 400 with the reason', async () => {
    const response = await call('update', { method: 'POST', body: { field: 'baseUrl', value: 'nope' } })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /not an absolute URL/)
  })

  await checkAsync('the images route pages the index', async () => {
    const payload = await (await call('images', { query: '?limit=1' })).json()
    assert.equal(payload.total, 1)
    assert.equal(payload.hasMore, false)
    assert.equal(payload.items[0].id, 'image-1')
    assert.equal(payload.items[0].prompt, 'a cat')
  })

  await checkAsync('the image route serves the recorded file with its sniffed type', async () => {
    const response = await call('image', { query: '?id=image-1' })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG)
  })

  await checkAsync('the image route refuses an unknown id and a missing one', async () => {
    assert.equal((await call('image', { query: '?id=nope' })).status, 404)
    assert.equal((await call('image')).status, 404)
  })

  await checkAsync('no route accepts a caller-supplied path', async () => {
    // The id is the only addressing unit, so a path in its place is just an
    // unknown id: a page cannot read an arbitrary file through this plugin.
    const response = await call('image', { query: `?id=${encodeURIComponent(routeImage)}` })
    assert.equal(response.status, 404)
  })

  await checkAsync('the delete route removes the record and the file', async () => {
    assert.deepEqual(await (await call('delete', { method: 'POST', body: { id: 'image-1' } })).json(), { ok: true, id: 'image-1' })
    assert.deepEqual(await readImageIndex(routeRuntime.stateDir), [])
    await assert.rejects(() => readFile(routeImage))
  })

  await checkAsync('the open routes refuse an unknown id without launching anything', async () => {
    for (const name of ['open', 'reveal']) {
      assert.equal((await call(name, { method: 'POST', body: { id: 'gone' } })).status, 404)
    }
    assert.equal((await call('open', { method: 'POST', body: {} })).status, 400)
  })

  await checkAsync('the test route asks for a base before probing', async () => {
    const bare = resolveConfig({ outputDir: routeDir, baseUrlEnv: 'ABSENT_BASE_URL' })
    const handler = buildRoutes(fakeCtx(fakeCredentialProvider()), bare, createRuntime(bare))
      .find(one => one.path === `${ROUTE_PREFIX}/test`)
    const response = await handler.fetch(new Request(`http://127.0.0.1${ROUTE_PREFIX}/test`, { method: 'POST' }))
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /no API base/)
  })
} finally {
  if (homeBeforeRoutes === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = homeBeforeRoutes
  await rm(routeDir, { recursive: true, force: true })
}

console.log('the image_library tool')
const toolDir = await mkdtemp(join(tmpdir(), 'dsh-imagegen-library-'))
const homeBeforeTool = process.env.DSH_HOME
process.env.DSH_HOME = join(toolDir, 'home')

const toolImage = join(toolDir, 'image-1.png')
await writeFile(toolImage, PNG)
const toolConfig = resolveConfig({ outputDir: toolDir })
const toolRuntime = createRuntime(toolConfig)
await recordGeneratedImages(toolRuntime.stateDir, [{
  id: 'image-1',
  createdAt: '2026-09-27T00:00:00.000Z',
  path: toolImage,
  name: 'image-1.png',
  mimeType: 'image/png',
  bytes: PNG.byteLength,
  prompt: 'a cat',
  model: 'stub-model',
  size: '1024x1024',
  mode: 'generations',
  width: 1024,
  height: 1024,
}])
const libraryTool = defineImageLibrary(fakeCtx(fakeCredentialProvider({ IMAGE_API_KEY: 'k' })), toolConfig, toolRuntime)

try {
  await checkAsync('the tool lists the index with ids and paths', async () => {
    const value = await libraryTool.execute({ action: 'list' })
    assert.equal(value.total, 1)
    assert.equal(value.hasMore, false)
    assert.deepEqual(value.images.map(one => one.id), ['image-1'])
    assert.equal(value.images[0].path, toolImage)
    assert.equal(value.images[0].width, 1024)
    assert.match(renderLibraryResult(value), /image-1/)
  })

  await checkAsync('a listed image carries no undefined field into the result schema', async () => {
    const value = await libraryTool.execute({ action: 'list' })
    for (const one of value.images) {
      for (const [field, held] of Object.entries(one)) assert.notEqual(held, undefined, field)
    }
  })

  await checkAsync('the tool reports status without echoing the credential', async () => {
    const value = await libraryTool.execute({ action: 'status' })
    assert.equal(value.status.apiKey.configured, true)
    assert.equal('value' in value.status.apiKey, false)
    assert.match(renderLibraryResult(value), /endpoint/)
  })

  await checkAsync('the tool refuses to write a credential at all', async () => {
    // The endpoint and the key are the user's to place; a model that could
    // rewrite them could redirect every later generation.
    await assert.rejects(() => libraryTool.execute({ action: 'configure', field: 'apiKey', value: 'sk-x' }), /Plugins page/)
    await assert.rejects(() => libraryTool.execute({ action: 'configure', field: 'baseUrl', value: 'https://x.test' }), /Plugins page/)
  })

  await checkAsync('the tool configures a tunable through the write the page uses', async () => {
    const value = await libraryTool.execute({ action: 'configure', field: 'size', value: '1536x1024' })
    assert.equal(value.status.fields.size, '1536x1024')
    assert.equal(toolRuntime.effective().size, '1536x1024')
    const cleared = await libraryTool.execute({ action: 'configure', field: 'size', value: null })
    assert.equal(cleared.status.fields.size, toolConfig.size)
    assert.equal(toolRuntime.effective().size, toolConfig.size)
    await assert.rejects(() => libraryTool.execute({ action: 'configure', field: 'nope', value: 'x' }), /unknown field/)
  })

  await checkAsync('the tool rejects an unknown action and unusable arguments', async () => {
    await assert.rejects(() => libraryTool.execute({ action: 'nope' }), /action must be one of/)
    await assert.rejects(() => libraryTool.execute(null), /arguments must be an object/)
    await assert.rejects(() => libraryTool.execute({ action: 'list', limit: 0 }), /limit must be an integer/)
    await assert.rejects(() => libraryTool.execute({ action: 'list', limit: MAX_PAGE_SIZE + 1 }), /limit must be an integer/)
    await assert.rejects(() => libraryTool.execute({ action: 'delete' }), /needs id/)
  })

  await checkAsync('the tool deletes exactly the image it names', async () => {
    const value = await libraryTool.execute({ action: 'delete', id: 'image-1' })
    assert.equal(value.id, 'image-1')
    assert.deepEqual(await readImageIndex(toolRuntime.stateDir), [])
    await assert.rejects(() => readFile(toolImage))
    await assert.rejects(() => libraryTool.execute({ action: 'delete', id: 'image-1' }), /unknown image id/)
  })

  await checkAsync('only the read-only actions overlap another call', async () => {
    for (const action of ['list', 'status', 'test']) assert.equal(libraryTool.isConcurrencySafe({ action }), true)
    for (const action of ['configure', 'delete', 'open', 'reveal']) assert.equal(libraryTool.isConcurrencySafe({ action }), false)
    assert.equal(libraryTool.isConcurrencySafe(null), false)
  })
} finally {
  if (homeBeforeTool === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = homeBeforeTool
  await rm(toolDir, { recursive: true, force: true })
}

console.log('connectivity probe')
const probeServer = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"data":[]}')
    return
  }
  res.writeHead(404)
  res.end('nope')
})
await new Promise(ready => probeServer.listen(0, '127.0.0.1', ready))
try {
  const origin = `http://127.0.0.1:${probeServer.address().port}`
  await checkAsync('a reachable /models endpoint proves the base and the key', async () => {
    const probe = await probeConnection(`${origin}/v1`, 'k')
    assert.equal(probe.ok, true)
    assert.equal(probe.status, 200)
    assert.equal(probe.url, `${origin}/v1/models`)
  })
  await checkAsync('a relay without /models is inconclusive, not a failure', async () => {
    const probe = await probeConnection(`${origin}/other/v1`, 'k')
    assert.equal(probe.ok, false)
    assert.equal(probe.inconclusive, true)
    assert.match(probe.detail, /proves nothing/)
  })
  await checkAsync('an unreachable endpoint reports the transport failure', async () => {
    const probe = await probeConnection('http://127.0.0.1:1/v1', 'k', 2000)
    assert.equal(probe.ok, false)
    assert.equal(probe.status, 0)
    assert.equal(typeof probe.detail, 'string')
  })
} finally {
  await new Promise(done => probeServer.close(done))
}

console.log('apply wiring')
const wiringDir = await mkdtemp(join(tmpdir(), 'dsh-imagegen-wiring-'))
const homeBeforeWiring = process.env.DSH_HOME
process.env.DSH_HOME = join(wiringDir, 'home')

/** A context with only the members `apply` touches, so the wiring is the subject. */
function applyCtx({ onInject }) {
  const tools = []
  return {
    tools,
    ctx: {
      logger: undefined,
      tools: { register: (definition) => { tools.push(definition); return () => {} } },
      inject: (deps, callback) => {
        onInject(deps, callback)
        return { dispose: () => {} }
      },
      effect: (callback) => callback(),
    },
  }
}

try {
  check('the tool registers even when no Web connection is composed', () => {
    const seen = []
    // A headless profile has no `connection`, so the child fiber never runs —
    // and the tool must still be there.
    const { ctx, tools } = applyCtx({ onInject: (deps) => { seen.push(deps) } })
    apply(ctx, { model: 'stub-model' })
    assert.deepEqual(seen, [['connection']])
    assert.deepEqual(tools.map(one => one.name), ['generate_image', 'image_library'])
    assert.equal(typeof tools[0].execute, 'function')
    assert.equal(tools[0].timeoutMs, 300_000)
  })

  check('the Plugins-page routes mount when a Web connection is composed', () => {
    const routes = []
    let disposed = 0
    const { ctx, tools } = applyCtx({
      onInject: (_deps, callback) => {
        callback({
          // The child fiber is an ordinary context: services plus `effect`.
          effect: (effect) => effect(),
          connection: {
            fetch: {
              register: (route) => {
                routes.push(route)
                return () => { disposed += 1; return Promise.resolve() }
              },
            },
          },
        })
      },
    })
    apply(ctx, { model: 'stub-model' })
    assert.deepEqual(tools.map(one => one.name), ['generate_image', 'image_library'])
    assert.deepEqual(routes.map(one => one.path), [
      `${ROUTE_PREFIX}/status`,
      `${ROUTE_PREFIX}/update`,
      `${ROUTE_PREFIX}/test`,
      `${ROUTE_PREFIX}/images`,
      `${ROUTE_PREFIX}/image`,
      `${ROUTE_PREFIX}/delete`,
      `${ROUTE_PREFIX}/open`,
      `${ROUTE_PREFIX}/reveal`,
    ])
    // The effect's disposer is what the fiber runs at teardown.
    assert.equal(disposed, 0)
  })
} finally {
  if (homeBeforeWiring === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = homeBeforeWiring
  await rm(wiringDir, { recursive: true, force: true })
}

console.log('the browser half, loaded the way the client loader loads it')
/**
 * Run `client.js` in a VM the way the Web shell does — `window.__ModuleLoader__
 * .load({ id, factory })` with a classic script — and drive the plugin it hands
 * back. React is stubbed down to the hooks the components use, and `h` invokes
 * function components eagerly, so a render here walks the whole tree. That
 * proves the module body, the registration wiring, and that every surface
 * renders its first state; DOM behaviour and the host round trip still need the
 * GUI (see README「自检」).
 */
function loadBrowserHalf() {
  let entry
  const sandbox = {
    window: { __ModuleLoader__: { load: (registered) => { entry = registered } } },
    document: { baseURI: 'http://127.0.0.1:3080/' },
    navigator: { language: 'zh-CN' },
    fetch: async () => { throw new Error('the smoke test has no network') },
    setTimeout,
    clearTimeout,
    console,
    URL,
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), sandbox, { filename: 'client.js' })
  assert.equal(entry.id, 'dsh-imagegen')
  const h = (type, props, ...children) => {
    const node = { type, props: props ?? {}, children }
    return typeof type === 'function' ? type({ ...node.props, children }) : node
  }
  const react = {
    createElement: h,
    Fragment: Symbol('react.fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
    useCallback: (callback) => callback,
  }
  // The bundle owns its controls, so the only modules it may reach for are the
  // two the shell seeds for everyone. A request for anything else — a Harness
  // Client package in particular — fails the load here instead of surviving
  // until that package changes shape.
  const requested = []
  const moduleExports = entry.factory((specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return react
    if (specifier === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`unexpected require(${specifier})`)
  })
  return { moduleExports, requested }
}

/** Every string a rendered tree carries, so assertions read as the reader does. */
function textsOf(node, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (typeof node === 'string' || typeof node === 'number') {
    found.push(String(node))
    return found
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, found)
    return found
  }
  if (typeof node === 'object' && 'children' in node) textsOf(node.children, found)
  return found
}

const { moduleExports: browserHalf, requested } = loadBrowserHalf()
const registrations = []
const browserCtx = {
  get: () => undefined,
  effect: (callback) => callback(),
  slots: {
    inject: (_name, run) => { run() },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
browserHalf.apply(browserCtx)
const registrationFor = (name) => registrations.find(one => one.options.name === name)
const browserT = registrationFor('tool.call.toolview').options.inject().t

check('the module registers under its package name and injects only slots', () => {
  assert.deepEqual([...browserHalf.inject], ['slots'])
  assert.equal(typeof browserHalf.apply, 'function')
})
check('the browser half reaches for react and react-dom, nothing else', () => {
  // A Harness Client package would be a dependency this bundle cannot track:
  // it would fail later, while rendering, and blank the slot entry.
  assert.deepEqual(requested, ['react', 'react-dom'])
})
check('it claims the tool card and both Plugins-page surfaces', () => {
  assert.deepEqual(registrations.map(one => one.options.name), [
    'tool.call.toolview',
    'plugins.bundle.config',
    'plugins.detail.section',
  ])
  assert.equal(registrationFor('tool.call.toolview').options.key, 'generate_image')
  assert.equal(registrationFor('plugins.bundle.config').options.key, 'dsh-imagegen')
  assert.equal(registrationFor('plugins.detail.section').options.id, 'imagegen-gallery')
  assert.equal(typeof registrationFor('plugins.detail.section').options.order, 'number')
  for (const one of registrations) assert.equal(typeof one.component, 'function')
})
check('every registration injects a translator that resolves real copy', () => {
  for (const one of registrations) {
    const injected = one.options.inject()
    assert.equal(typeof injected.t, 'function')
    const text = injected.t('config.baseUrl')
    assert.equal(typeof text, 'string')
    assert.notEqual(text, 'config.baseUrl')
    assert.notEqual(text.length, 0)
  }
  // An unknown key falls back to the key itself rather than to undefined.
  assert.equal(browserT('nope.missing'), 'nope.missing')
  // Parameters interpolate, so a message can name what went wrong.
  assert.equal(browserT('gallery.total', { shown: 3, total: 9 }).includes('3'), true)
})
check('the tool card renders its running state', () => {
  const texts = textsOf(registrationFor('tool.call.toolview').component({
    t: browserT,
    block: { kind: 'tool-call' },
    loadImage: () => Promise.resolve(''),
  }))
  assert.equal(texts.includes(browserT('card.generating')), true)
})
check('the settings section renders its loading state before the host answers', () => {
  const texts = textsOf(registrationFor('plugins.bundle.config').component({ t: browserT }))
  assert.equal(texts.includes(browserT('config.loading')), true)
})
check('the gallery renders only on this bundle’s own page', () => {
  const section = registrationFor('plugins.detail.section').component
  assert.equal(section({ t: browserT, subject: { kind: 'row', pkg: { name: 'dsh-imagegen' } } }), null)
  assert.equal(section({ t: browserT, subject: { kind: 'bundle', pkg: { name: 'other-plugin' } } }), null)
  assert.equal(section({ t: browserT, subject: undefined }), null)
  const texts = textsOf(section({ t: browserT, subject: { kind: 'bundle', pkg: { name: 'dsh-imagegen' } } }))
  assert.equal(texts.includes(browserT('gallery.title')), true)
  // Nothing is indexed yet, so it opens on the state it can render immediately.
  assert.equal(texts.includes(browserT('gallery.loading')), true)
})

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
