/**
 * `generate_image`: OpenAI-compatible image generation for DeepSeek Harness.
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

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

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
 * root, or the complete endpoint; each resolves to one
 * `<…>/images/generations` URL. The rule is explicit so a pasted relay base
 * behaves predictably.
 *
 * @param baseUrl - API base, for example `https://relay.example.com/v1`.
 * @returns The absolute endpoint URL.
 * @throws When the value is not an absolute HTTP(S) URL.
 */
export function resolveEndpoint(baseUrl) {
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
  if (path.endsWith('/images/generations')) url.pathname = path
  else if (path.endsWith('/v1')) url.pathname = `${path}/images/generations`
  else url.pathname = `${path}/v1/images/generations`
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
  for (const field of ['baseUrl', 'model', 'size', 'quality', 'outputDir']) {
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
    // self-contained; an absent one is resolved per call.
    endpoint: raw.baseUrl === undefined ? undefined : resolveEndpoint(raw.baseUrl),
    baseUrlEnv,
    apiKeyEnv,
    apiKey: isFilledString(raw.apiKey) ? raw.apiKey : undefined,
    model: raw.model ?? DEFAULT_MODEL,
    size: raw.size ?? DEFAULT_SIZE,
    quality: raw.quality,
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
 * @returns The absolute endpoint and the credential value.
 * @throws When either value is unavailable, naming where to put it.
 */
export async function resolveTarget(ctx, config) {
  const endpoint = config.endpoint ?? await resolveNamed(ctx, config.baseUrlEnv)
  if (endpoint === undefined) {
    throw new Error(`imagegen: no API base — set config.baseUrl, or store ${config.baseUrlEnv} (for example in ~/.dsh/.env, or as an exported environment variable)`)
  }
  const apiKey = config.apiKey ?? await resolveNamed(ctx, config.apiKeyEnv)
  if (apiKey === undefined) {
    throw new Error(`imagegen: no credential for ${config.apiKeyEnv} — store it (for example in ~/.dsh/.env, or as an exported environment variable) or set config.apiKey`)
  }
  return { endpoint: config.endpoint ?? resolveEndpoint(endpoint), apiKey }
}

/**
 * Validate the model-supplied arguments the raw parameter schema cannot
 * express: non-empty strings, the `n` bound, and unknown keys.
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
  const known = ['prompt', 'model', 'size', 'quality', 'n']
  const unknown = Object.keys(args).filter(key => !known.includes(key))
  if (unknown.length > 0) throw new Error(`imagegen: unknown argument(s) ${unknown.join(', ')}`)
  if (!isFilledString(args.prompt)) throw new Error('imagegen: prompt must be a non-empty string')
  const n = args.n ?? 1
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES) {
    throw new Error(`imagegen: n must be an integer from 1 to ${MAX_IMAGES}`)
  }
  for (const field of ['model', 'size', 'quality']) {
    if (args[field] !== undefined && !isFilledString(args[field])) {
      throw new Error(`imagegen: ${field} must be a non-empty string when set`)
    }
  }
  return {
    prompt: args.prompt,
    n,
    model: args.model ?? config.model,
    size: args.size ?? config.size,
    quality: args.quality ?? config.quality,
  }
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
  const body = { model: request.model, prompt: request.prompt, n: request.n, size: request.size }
  if (request.quality !== undefined) body.quality = request.quality
  // No `response_format`: current gpt-image models reject it, and both response
  // forms are read below.
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
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
  const lines = [`Generated ${value.images.length} image(s) with ${value.model}:`]
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
    description: 'Generate one or more images from a text prompt with a third-party image model, and save them as files. '
      + 'Use read_image on a saved path to look at the result before iterating.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'The image to generate.' },
        model: { type: 'string', description: `Image model id. Defaults to ${DEFAULT_MODEL}.` },
        size: { type: 'string', description: `Image size such as 1024x1024. Defaults to ${DEFAULT_SIZE}.` },
        quality: { type: 'string', description: 'Provider quality level, for example low, medium, high, or auto.' },
        n: { type: 'integer', description: `How many images to generate, 1 to ${MAX_IMAGES}. Defaults to 1.` },
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
      const { endpoint, apiKey } = await resolveTarget(ctx, config)
      const { entries, revisedPrompt } = await requestImages(endpoint, apiKey, request, config.timeoutMs, exec.signal)
      await mkdir(config.outputDir, { recursive: true })
      const stem = outputStem()
      const images = []
      for (const [index, entry] of entries.entries()) {
        const bytes = entry.kind === 'base64'
          ? Buffer.from(entry.data, 'base64')
          : await downloadImage(entry, exec.signal)
        if (bytes.length === 0) throw new Error(`imagegen: image ${index + 1} decoded to zero bytes`)
        const { mimeType, extension } = sniffImageType(bytes)
        const path = join(config.outputDir, `${stem}-${index + 1}${extension}`)
        await writeFile(path, bytes)
        const attachment = await attachImage(ctx, config, bytes, mimeType, path)
        images.push(attachment === undefined
          ? { path, mimeType, bytes: bytes.byteLength }
          : { path, mimeType, bytes: bytes.byteLength, ...attachment })
      }
      return revisedPrompt === undefined
        ? { model: request.model, images }
        : { model: request.model, images, revisedPrompt }
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
