/**
 * `generate_image`: OpenAI-compatible image generation for DeepSeek Harness.
 *
 * Two endpoints are supported, chosen per call by the arguments:
 *
 *  - `POST {base}/v1/images/generations` — text to image (JSON body).
 *  - `POST {base}/v1/images/edits` — text **plus input images** (multipart body):
 *    pass `image` (one path, or several) and optionally `mask`, to keep an
 *    existing picture and change only what the prompt asks for.
 *
 * Extra wire parameters are passed through without the plugin knowing them:
 * `background`, `output_format`, `seed`, `input_fidelity`, and any other field
 * via the `extra` / `providerOptions` object, which is merged into the request
 * body (explicit fields win on a key collision).
 *
 * This module imports only Node builtins. It registers its tool through
 * `ctx.tools.register()` with raw JSON Schema rather than importing
 * `defineTool`, so no `@deepseek-ai/dsh-*` package is resolved when the plugin
 * loads: a harness upgrade cannot break module resolution, and the same file
 * runs from a source checkout, an installed `dsh`, and a packed tarball without
 * a build step. The cost is that `execute` validates its own arguments.
 *
 * The endpoint and the credential are resolved per call from the credential
 * plane, so one installed bundle works on every machine with no config edit and
 * a rotated key or a changed relay applies to the next call. A value the config
 * states explicitly is validated while the plugin loads; a value only the
 * credential plane can supply is resolved at the earliest point it exists, the
 * call. The tool therefore stays visible when its endpoint is unconfigured and
 * fails with an actionable error, the same contract `tool-web` uses for an
 * unavailable provider.
 *
 * Each generated image is also committed to the durable attachment store and
 * returned as an `ImageBlock`, so the session timeline renders it inline and the
 * model sees it without a second `read_image` call. The attachment seam is
 * optional: without a mounted store the tool still saves the file and returns
 * its path.
 *
 * @module dsh-imagegen
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'imagegen'

/** The tool registry this plugin contributes to. */
export const inject = ['tools']

/** Credential reference holding the API base when the config states none. */
export const DEFAULT_BASE_URL_ENV = 'IMAGE_BASE_URL'

/** Credential reference read when the config names no other one. */
export const DEFAULT_API_KEY_ENV = 'IMAGE_API_KEY'

/** Image model requested when neither config nor the call names one. */
export const DEFAULT_MODEL = 'gpt-image-2.5-flare'

/** Size requested when the call names none. */
export const DEFAULT_SIZE = '1024x1024'

/**
 * Cooperative tool-call budget in milliseconds. Image generation routinely
 * takes 30-120 seconds, and relays queue on top of that, so the default leaves
 * room for a slow provider instead of cutting off a request that will succeed.
 */
export const DEFAULT_TIMEOUT_MS = 300_000

/** Largest `n` one call may request; bounds the files and bytes one call owns. */
export const MAX_IMAGES = 4

/**
 * Largest number of input images one edit call may reference. Providers differ
 * (some accept fewer), so this only bounds what one call may hand over.
 */
export const MAX_INPUT_IMAGES = 8

/** Request kinds, each with its own endpoint and body encoding. */
export const KIND_GENERATIONS = 'generations'
export const KIND_EDITS = 'edits'

/**
 * Whether generated images are attached to the tool result by default. An
 * attachment adds the image to the session timeline and sends it to the routed
 * model, which is a deployment choice: it costs visual tokens on an
 * image-capable route, and a text-only route receives a placeholder instead.
 */
export const DEFAULT_ATTACH_IMAGES = true

/** Cap on provider error text carried into a failure message. */
const ERROR_TEXT_LIMIT = 500

/** A POSIX shell identifier, which is what a credential reference must be. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Resolve the absolute request URL from a configured base.
 *
 * The base may be a bare origin, an origin with a path prefix, a versioned API
 * root, the complete generations endpoint, or the complete edits endpoint; each
 * resolves to one `<…>/images/<kind>` URL, so a base pasted from either
 * endpoint's documentation works for both. The rule is explicit so a pasted
 * relay base behaves predictably.
 *
 * @param baseUrl - API base, for example `https://relay.example.com/v1`.
 * @param kind - `generations` (default) or `edits`.
 * @returns The absolute endpoint URL.
 * @throws When the value is not an absolute HTTP(S) URL, or the kind is unknown.
 */
export function resolveEndpoint(baseUrl, kind = KIND_GENERATIONS) {
  if (kind !== KIND_GENERATIONS && kind !== KIND_EDITS) {
    throw new Error(`imagegen: unknown request kind ${JSON.stringify(kind)}`)
  }
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error(`imagegen: base URL is not an absolute URL: ${JSON.stringify(baseUrl)}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`imagegen: base URL must use http or https, got ${url.protocol}`)
  }
  const path = url.pathname.replace(/\/+$/u, '')
  if (/\/images\/(?:generations|edits)$/u.test(path)) {
    url.pathname = path.replace(/\/images\/(?:generations|edits)$/u, `/images/${kind}`)
  } else if (path.endsWith('/v1')) {
    url.pathname = `${path}/images/${kind}`
  } else {
    url.pathname = `${path}/v1/images/${kind}`
  }
  return url.toString()
}

/**
 * Identify a generated image from its leading bytes.
 *
 * A relay may return JPEG or WebP bytes whatever the requested format, so the
 * saved file's extension and media type follow the bytes rather than the
 * request.
 *
 * @param buffer - complete image bytes.
 * @returns The media type and file extension.
 */
export function sniffImageType(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') {
    return { mimeType: 'image/png', extension: '.png' }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' }
  }
  if (buffer.length >= 12
    && buffer.toString('latin1', 0, 4) === 'RIFF'
    && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: '.webp' }
  }
  const header = buffer.toString('latin1', 0, 6)
  if (header === 'GIF87a' || header === 'GIF89a') {
    return { mimeType: 'image/gif', extension: '.gif' }
  }
  return { mimeType: 'application/octet-stream', extension: '.bin' }
}

/**
 * Read the image entries out of one images response.
 *
 * Both response forms relays actually return are accepted: base64 in
 * `b64_json`, and a downloadable URL in `url`.
 *
 * @param payload - parsed JSON response body.
 * @returns One entry per image, each either base64 data or a URL.
 * @throws When the body carries no image entries.
 */
export function readImageEntries(payload) {
  const data = payload !== null && typeof payload === 'object' ? payload.data : undefined
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`imagegen: response carried no images: ${JSON.stringify(payload).slice(0, ERROR_TEXT_LIMIT)}`)
  }
  return data.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`imagegen: response data[${index}] is not an object`)
    }
    if (typeof entry.b64_json === 'string' && entry.b64_json.length > 0) {
      return { kind: 'base64', data: entry.b64_json }
    }
    if (typeof entry.url === 'string' && entry.url.length > 0) {
      return { kind: 'url', url: entry.url }
    }
    throw new Error(`imagegen: response data[${index}] carried neither b64_json nor url`)
  })
}

/** Whether `value` is a non-empty string. */
function isFilledString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** Assert a credential reference names an environment variable. */
function assertCredentialRef(value, field) {
  if (!isFilledString(value) || !CREDENTIAL_REF_PATTERN.test(value)) {
    throw new Error(`imagegen: config.${field} must be an environment variable name, got ${JSON.stringify(value)}`)
  }
}

/**
 * Validate and normalize the Loader-supplied config, filling documented
 * defaults. Only values the config states are checked here; a value the
 * credential plane supplies is resolved per call.
 *
 * @param config - raw config from the plugin row; every field is optional.
 * @returns The resolved config.
 * @throws When a supplied value is unusable.
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('imagegen: config must be an object')
  }
  for (const field of ['baseUrl', 'model', 'size', 'quality', 'outputDir', 'background', 'outputFormat']) {
    if (raw[field] !== undefined && !isFilledString(raw[field])) {
      throw new Error(`imagegen: config.${field} must be a non-empty string when set`)
    }
  }
  const apiKeyEnv = raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const baseUrlEnv = raw.baseUrlEnv ?? DEFAULT_BASE_URL_ENV
  assertCredentialRef(apiKeyEnv, 'apiKeyEnv')
  assertCredentialRef(baseUrlEnv, 'baseUrlEnv')
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('imagegen: config.timeoutMs must be a positive integer')
  }
  if (raw.attachImages !== undefined && typeof raw.attachImages !== 'boolean') {
    throw new Error('imagegen: config.attachImages must be a boolean')
  }
  return {
    // An explicit base fails while the plugin loads, because a malformed one is
    // self-contained; an absent one is resolved per call. The generations form
    // is kept for callers that only ever generate; `baseUrl` lets an edit call
    // derive its own endpoint from the same base.
    endpoint: raw.baseUrl === undefined ? undefined : resolveEndpoint(raw.baseUrl),
    baseUrl: raw.baseUrl,
    baseUrlEnv,
    apiKeyEnv,
    apiKey: isFilledString(raw.apiKey) ? raw.apiKey : undefined,
    model: raw.model ?? DEFAULT_MODEL,
    size: raw.size ?? DEFAULT_SIZE,
    quality: raw.quality,
    // Per-call defaults for the pass-through wire parameters; an argument wins.
    background: raw.background,
    outputFormat: raw.outputFormat,
    timeoutMs,
    attachImages: raw.attachImages ?? DEFAULT_ATTACH_IMAGES,
    outputDir: raw.outputDir ?? process.cwd(),
  }
}

/**
 * Read one named value from the credential seam, falling back to the process
 * environment. Resolution happens per call: a stored or rotated value applies
 * to the next call without a restart or a configuration edit.
 *
 * @param ctx - plugin context; `credentials` is optional.
 * @param ref - credential reference to resolve.
 * @returns The value, or `undefined` when nothing supplies one.
 */
export async function resolveNamed(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined && isFilledString(hit.value)) return hit.value
  }
  const ambient = process.env[ref]
  return isFilledString(ambient) ? ambient : undefined
}

/**
 * Resolve the endpoint and credential for one call.
 *
 * @param ctx - plugin context.
 * @param config - resolved config.
 * @param kind - request kind, selecting the generations or edits endpoint.
 * @returns The absolute endpoint and the credential value.
 * @throws When either value is unavailable, naming where to put it.
 */
export async function resolveTarget(ctx, config, kind = KIND_GENERATIONS) {
  const base = config.baseUrl ?? await resolveNamed(ctx, config.baseUrlEnv)
  if (base === undefined) {
    throw new Error(`imagegen: no API base — set config.baseUrl, or store ${config.baseUrlEnv} (for example in ~/.dsh/.env, or as an exported environment variable)`)
  }
  const apiKey = config.apiKey ?? await resolveNamed(ctx, config.apiKeyEnv)
  if (apiKey === undefined) {
    throw new Error(`imagegen: no credential for ${config.apiKeyEnv} — store it (for example in ~/.dsh/.env, or as an exported environment variable) or set config.apiKey`)
  }
  // The generations form is reused when configured, so a base that only ever
  // generates keeps its exact previous endpoint string.
  const endpoint = kind === KIND_GENERATIONS && config.endpoint !== undefined
    ? config.endpoint
    : resolveEndpoint(base, kind)
  return { endpoint, apiKey }
}

/** Whether `value` is a plain object: not null, not an array. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalize `image` (one path or several) into a bounded list of paths.
 *
 * @param value - the raw `image` argument, if any.
 * @returns The input image paths.
 * @throws When the list is empty, too long, or holds a non-string entry.
 */
function normalizeImages(value) {
  if (value === undefined) return []
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) throw new Error('imagegen: image must name at least one file')
  if (list.length > MAX_INPUT_IMAGES) {
    throw new Error(`imagegen: at most ${MAX_INPUT_IMAGES} input images are supported, got ${list.length}`)
  }
  for (const entry of list) {
    if (!isFilledString(entry)) throw new Error('imagegen: every image entry must be a non-empty path string')
  }
  return list.map(entry => entry.trim())
}

/**
 * Validate the model-supplied arguments the raw parameter schema cannot
 * express: non-empty strings, the `n` bound, the input-image list, the
 * pass-through fields, and unknown keys.
 *
 * @param args - raw model arguments.
 * @param config - resolved config, supplying the per-call defaults.
 * @returns The validated request fields.
 * @throws When an argument is unusable.
 */
export function parseArgs(args, config) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('imagegen: arguments must be an object')
  }
  const known = [
    'prompt', 'model', 'size', 'quality', 'n',
    'image', 'mask', 'background', 'output_format', 'seed', 'input_fidelity',
    'extra', 'providerOptions', 'outputDir',
  ]
  const unknown = Object.keys(args).filter(key => !known.includes(key))
  if (unknown.length > 0) throw new Error(`imagegen: unknown argument(s) ${unknown.join(', ')}`)
  if (!isFilledString(args.prompt)) throw new Error('imagegen: prompt must be a non-empty string')
  const n = args.n ?? 1
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES) {
    throw new Error(`imagegen: n must be an integer from 1 to ${MAX_IMAGES}`)
  }
  for (const field of ['model', 'size', 'quality', 'mask', 'background', 'output_format', 'input_fidelity', 'outputDir']) {
    if (args[field] !== undefined && !isFilledString(args[field])) {
      throw new Error(`imagegen: ${field} must be a non-empty string when set`)
    }
  }
  for (const field of ['extra', 'providerOptions']) {
    if (args[field] !== undefined && !isPlainObject(args[field])) {
      throw new Error(`imagegen: ${field} must be an object when set`)
    }
  }
  if (args.seed !== undefined && !(Number.isInteger(args.seed) || isFilledString(args.seed))) {
    throw new Error('imagegen: seed must be an integer or a string when set')
  }
  const images = normalizeImages(args.image)
  if (images.length === 0 && args.mask !== undefined) {
    throw new Error('imagegen: mask needs at least one image')
  }
  const background = args.background ?? config.background
  const outputFormat = args.output_format ?? config.outputFormat
  if (background === 'transparent' && outputFormat === 'jpeg') {
    throw new Error('imagegen: background "transparent" cannot be combined with output_format "jpeg" — use png or webp')
  }
  return {
    prompt: args.prompt,
    n,
    model: args.model ?? config.model,
    size: args.size ?? config.size,
    quality: args.quality ?? config.quality,
    images,
    mask: args.mask,
    background,
    outputFormat,
    seed: args.seed,
    inputFidelity: args.input_fidelity,
    extra: { ...args.providerOptions, ...args.extra },
    outputDir: args.outputDir,
  }
}

/**
 * Which endpoint a validated request needs.
 *
 * @param request - validated request fields.
 * @returns `edits` when input images are present, else `generations`.
 */
export function requestKind(request) {
  return request.images.length > 0 ? KIND_EDITS : KIND_GENERATIONS
}

/**
 * The scalar wire fields both endpoints accept.
 *
 * `extra` comes first so an explicitly named argument wins a key collision, and
 * a field the caller never named is simply absent rather than null.
 *
 * @param request - validated request fields.
 * @returns The wire fields, still holding `undefined` for absent ones.
 */
export function scalarFields(request) {
  const fields = {
    ...request.extra,
    model: request.model,
    prompt: request.prompt,
    n: request.n,
    size: request.size,
  }
  if (request.quality !== undefined) fields.quality = request.quality
  if (request.background !== undefined) fields.background = request.background
  if (request.outputFormat !== undefined) fields.output_format = request.outputFormat
  if (request.seed !== undefined) fields.seed = request.seed
  if (request.inputFidelity !== undefined) fields.input_fidelity = request.inputFidelity
  return fields
}

/**
 * Build the JSON body for `POST /images/generations`.
 *
 * @param request - validated request fields.
 * @returns The request body.
 */
export function buildGenerationBody(request) {
  return scalarFields(request)
}

/**
 * Append the scalar fields to a multipart form.
 *
 * Multipart values are strings, so a structured `extra` value is JSON-encoded
 * rather than dropped.
 *
 * @param form - the FormData being built.
 * @param request - validated request fields.
 * @returns The same form, for chaining.
 */
export function appendEditFields(form, request) {
  for (const [key, value] of Object.entries(scalarFields(request))) {
    if (value === undefined) continue
    form.append(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  return form
}

/**
 * Resolve the directory one call writes into.
 *
 * @param requested - the call's `outputDir`, if any.
 * @param fallback - the configured default.
 * @returns An absolute directory path.
 */
export function resolveOutputDir(requested, fallback) {
  if (requested === undefined) return fallback
  return isAbsolute(requested) ? requested : resolve(fallback, requested)
}

/**
 * Read one local image and append it as a multipart file part.
 *
 * The part's filename carries the sniffed extension, which is how the provider
 * learns the format when the bytes alone are ambiguous.
 *
 * @param form - the FormData being built.
 * @param field - `image` or `mask`.
 * @param path - local file path.
 * @param index - 1-based image index; 0 for a mask, which needs no number.
 * @throws When the file is unreadable or is not a recognised image format.
 */
async function appendImageFile(form, field, path, index) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new Error(`imagegen: cannot read ${field} file ${JSON.stringify(path)}: ${error.message}`)
  }
  const { mimeType, extension } = sniffImageType(bytes)
  if (mimeType === 'application/octet-stream') {
    throw new Error(`imagegen: ${JSON.stringify(path)} is not a PNG/JPEG/WebP/GIF image`)
  }
  const stem = basename(path, extname(path)) || field
  const name = index > 0 ? `${index}-${stem}${extension}` : `${stem}${extension}`
  form.append(field, new Blob([bytes], { type: mimeType }), name)
}

/**
 * Append the input images and the optional mask to a multipart form.
 *
 * @param form - the FormData being built.
 * @param request - validated request fields.
 * @returns The same form, for chaining.
 */
async function appendEditParts(form, request) {
  for (const [index, path] of request.images.entries()) {
    await appendImageFile(form, 'image', path, index + 1)
  }
  if (request.mask !== undefined) {
    await appendImageFile(form, 'mask', request.mask, 0)
  }
  return form
}

/**
 * Send one generation request and return its image entries.
 *
 * @param endpoint - absolute images endpoint.
 * @param apiKey - credential value for this call.
 * @param request - validated request fields.
 * @param timeoutMs - configured per-call budget.
 * @param signal - caller cancellation, combined with the budget.
 * @returns The image entries and the response's revised prompt when present.
 * @throws On transport failure, a non-2xx status, or an unreadable body.
 */
async function requestImages(endpoint, apiKey, request, timeoutMs, signal) {
  const headers = { authorization: `Bearer ${apiKey}` }
  let body
  if (requestKind(request) === KIND_EDITS) {
    // Multipart: `fetch` writes the boundary itself, so no content-type here.
    const form = new FormData()
    await appendEditParts(form, request)
    appendEditFields(form, request)
    body = form
  } else {
    headers['content-type'] = 'application/json'
    // No `response_format`: current gpt-image models reject it, and both
    // response forms are read below.
    body = JSON.stringify(buildGenerationBody(request))
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    // A credentialed request must not follow a redirect to another origin.
    redirect: 'error',
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`imagegen: ${endpoint} returned HTTP ${response.status} ${response.statusText}: ${text.slice(0, ERROR_TEXT_LIMIT)}`)
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error('imagegen: response body was not JSON')
  }
  const revised = payload !== null && typeof payload === 'object' && isFilledString(payload.revised_prompt)
    ? payload.revised_prompt
    : undefined
  return { entries: readImageEntries(payload), revisedPrompt: revised }
}

/**
 * Fetch one image returned as a URL.
 *
 * @param entry - the URL entry.
 * @param signal - caller cancellation.
 * @returns The image bytes.
 * @throws When the download fails.
 */
async function downloadImage(entry, signal) {
  const response = await fetch(entry.url, { signal })
  if (!response.ok) {
    throw new Error(`imagegen: image download returned HTTP ${response.status} for ${entry.url}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

/** A short unique stem shared by the files of one call. */
function outputStem() {
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, '')
  const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
  return `image-${stamp}-${suffix}`
}

/**
 * Commit one generated image to the durable attachment store, so the session
 * timeline renders it and the routed model receives it.
 *
 * Returns nothing when no store is mounted, the deployment does not accept the
 * media type, or the store refuses the bytes (its size or pixel limits). The
 * saved file stays the result of record in every one of those cases, so the
 * call still succeeds and `read_image` can still read it.
 *
 * @param ctx - plugin context; `attachments` is optional.
 * @param config - resolved config.
 * @param bytes - the complete image bytes.
 * @param mediaType - media type sniffed from those bytes.
 * @param path - the saved file path, used as the attachment's display name.
 * @returns The attachment fields to merge into the result, or `undefined`.
 */
async function attachImage(ctx, config, bytes, mediaType, path) {
  if (!config.attachImages) return undefined
  const attachments = ctx.get('attachments')
  if (attachments === undefined || typeof attachments.saveImage !== 'function') return undefined
  if (!attachments.imageLimits.mediaTypes.includes(mediaType)) return undefined
  try {
    const ref = await attachments.saveImage({ data: bytes, mediaType, name: basename(path) })
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...ref.name === undefined ? {} : { name: ref.name },
    }
  } catch {
    // Only the store's own admission limits reach here (byte, pixel, and
    // dimension caps); the file is already written, so the result degrades to
    // its path instead of failing a generation that succeeded.
    return undefined
  }
}

/**
 * Render the canonical result as the model-facing summary text.
 *
 * @param value - the canonical result value.
 * @returns One line per saved file.
 */
export function renderResult(value) {
  const via = value.mode === KIND_EDITS ? ` (edited from ${value.inputImages ?? 'the input image(s)'})` : ''
  const lines = [`Generated ${value.images.length} image(s) with ${value.model}${via}:`]
  for (const image of value.images) {
    lines.push(`- ${image.path} (${image.mimeType}, ${image.bytes} bytes)`)
  }
  if (value.revisedPrompt !== undefined) lines.push(`Revised prompt: ${value.revisedPrompt}`)
  lines.push('Read a saved file with the read_image tool to inspect or iterate on the result.')
  return lines.join('\n')
}

/**
 * The model- and UI-facing content of one result: the summary text, followed by
 * one image block per attachment the store accepted. A UI renders those blocks
 * inline in the session timeline, and the routed model receives the image
 * itself; a text-only route substitutes its own placeholder.
 *
 * @param value - the canonical result value.
 * @returns The result's content blocks.
 */
export function renderContent(value) {
  return [
    { type: 'text', text: renderResult(value) },
    ...value.images
      .filter(image => image.attachmentId !== undefined)
      .map(image => ({
        type: 'image',
        attachment: {
          attachmentId: image.attachmentId,
          mediaType: image.mediaType,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          ...image.name === undefined ? {} : { name: image.name },
        },
      })),
  ]
}

/**
 * The `generate_image` tool definition.
 *
 * @param ctx - plugin context supplying the credential seam.
 * @param config - resolved config.
 * @returns The definition passed to `ctx.tools.register`.
 */
export function defineGenerateImage(ctx, config) {
  return {
    name: 'generate_image',
    description: 'Generate or edit one or more images with a third-party image model, and save them as files. '
      + 'Pass `image` (a local path, or several) to keep an existing picture and change only what the prompt asks for — that switches the call to the provider\'s edit endpoint. '
      + '`mask`, `background`, `output_format`, `seed`, and `input_fidelity` are passed through when the provider understands them, and any other provider field goes into `extra`. '
      + 'Use read_image on a saved path to look at the result before iterating.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'The image to generate, or the change to make when image is given.' },
        model: { type: 'string', description: `Image model id. Defaults to ${DEFAULT_MODEL}.` },
        size: { type: 'string', description: `Image size such as 1024x1024. Defaults to ${DEFAULT_SIZE}.` },
        quality: { type: 'string', description: 'Provider quality level, for example low, medium, high, or auto.' },
        n: { type: 'integer', description: `How many images to generate, 1 to ${MAX_IMAGES}. Defaults to 1.` },
        image: {
          type: 'array',
          items: { type: 'string' },
          description: 'Local path(s) of the image(s) to edit. A bare path string is also accepted. '
            + 'Giving any image switches the call to the edits endpoint (multipart upload).',
        },
        mask: {
          type: 'string',
          description: 'Optional local mask path for an edit: the transparent area is what gets regenerated. Requires image.',
        },
        background: {
          type: 'string',
          description: 'Pass-through: "transparent" asks for a cut-out background where the provider supports it (png/webp output).',
        },
        output_format: { type: 'string', description: 'Pass-through: png, jpeg, or webp where the provider supports it.' },
        seed: { type: 'integer', description: 'Pass-through: seed, for providers that honour one.' },
        input_fidelity: { type: 'string', description: 'Pass-through: for example "high" to stay close to the input image.' },
        extra: {
          type: 'object',
          additionalProperties: true,
          description: 'Any other provider field, merged into the request body. An explicitly named argument wins a key collision.',
        },
        providerOptions: {
          type: 'object',
          additionalProperties: true,
          description: 'Alias of `extra`; `extra` wins when both are set.',
        },
        outputDir: {
          type: 'string',
          description: 'Directory for the saved files. Defaults to the configured outputDir; a relative path resolves against it.',
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                mimeType: { type: 'string' },
                bytes: { type: 'integer' },
                attachmentId: { type: 'string' },
                mediaType: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                name: { type: 'string' },
              },
              required: ['path', 'mimeType', 'bytes'],
            },
          },
          revisedPrompt: { type: 'string' },
          mode: { type: 'string' },
          inputImages: { type: 'array', items: { type: 'string' } },
        },
        required: ['model', 'images'],
      },
      render: (_args, value) => renderContent(value),
    },
    timeoutMs: config.timeoutMs,
    // Distinct files per call: generation may overlap with sibling calls.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const request = parseArgs(args, config)
      const kind = requestKind(request)
      const { endpoint, apiKey } = await resolveTarget(ctx, config, kind)
      const { entries, revisedPrompt } = await requestImages(endpoint, apiKey, request, config.timeoutMs, exec.signal)
      const outputDir = resolveOutputDir(request.outputDir, config.outputDir)
      await mkdir(outputDir, { recursive: true })
      const stem = outputStem()
      const images = []
      for (const [index, entry] of entries.entries()) {
        const bytes = entry.kind === 'base64'
          ? Buffer.from(entry.data, 'base64')
          : await downloadImage(entry, exec.signal)
        if (bytes.length === 0) throw new Error(`imagegen: image ${index + 1} decoded to zero bytes`)
        const { mimeType, extension } = sniffImageType(bytes)
        const path = join(outputDir, `${stem}-${index + 1}${extension}`)
        await writeFile(path, bytes)
        const attachment = await attachImage(ctx, config, bytes, mimeType, path)
        images.push(attachment === undefined
          ? { path, mimeType, bytes: bytes.byteLength }
          : { path, mimeType, bytes: bytes.byteLength, ...attachment })
      }
      const result = { model: request.model, mode: kind, images }
      if (request.images.length > 0) result.inputImages = request.images
      if (revisedPrompt !== undefined) result.revisedPrompt = revisedPrompt
      return result
    },
  }
}

/**
 * Register `generate_image` on the tool registry.
 *
 * @param ctx - plugin context; `tools` is required, `credentials` optional.
 * @param config - plugin row config, validated here.
 */
export function apply(ctx, config) {
  ctx.tools.register(defineGenerateImage(ctx, resolveConfig(config)))
}
