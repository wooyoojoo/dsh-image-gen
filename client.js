/**
 * Browser half of dsh-imagegen. Three surfaces, all claimed by this file:
 *
 *  - `tool.call.toolview` / `generate_image` — one call as a card with the
 *    generated images inline, each a bounded thumbnail that opens a
 *    click-to-enlarge preview.
 *  - `plugins.bundle.config` / `dsh-imagegen` — the Plugins page's configuration
 *    section for this bundle: the request endpoint and the API key through the
 *    host's credential seam, and the model, size, quality, timeout, and output
 *    directory through the plugin's own override file.
 *  - `plugins.detail.section` — the generated-image gallery under that page,
 *    served by the plugin's own index and image routes.
 *
 * The Web client does not consume Host presentation methods; it renders a tool
 * result through the `tool.call.toolview` keyed slot, keyed by the wire tool
 * name, and falls back to the generic row for an unclaimed key. The two Plugins
 * page slots are declared by `ui-plugin-manager` and rendered with the bundle's
 * package name as the key, so a plugin's own configuration and content appear on
 * its page without the page naming any plugin.
 *
 * It is hand-written in the artifact format the client module loader executes:
 * a classic script calling `window.__ModuleLoader__.load({ id, factory })` with
 * a factory returning the plugin module. That is what `packages/client/tsdown.client.ts`
 * emits for in-repo client packages; reproducing it here keeps this bundle free
 * of a build step, at the cost of writing plain `React.createElement` instead of
 * JSX, inline styles instead of CSS Modules, and a dictionary registered through
 * `ctx.locale` instead of the repository's generated typed dictionaries.
 *
 * The plugin-page surfaces talk to the host over plain `fetch` on the
 * authenticated `/api` routes the plugin's host half registers: the browser
 * session cookie rides along, and the connection service applies its
 * host/origin fence before any handler runs. Every route is resolved against
 * `document.baseURI`, so a deployment mounted below the origin still resolves.
 *
 * The card and both sections must render every state they own: claiming a tool
 * name suppresses the generic row for that tool, including its failures.
 */

window.__ModuleLoader__.load({
  id: 'dsh-imagegen',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    /**
     * The bundle's own controls and the styles they need.
     *
     * The host ships these atoms in `@deepseek-ai/dsh-client-ui-primitives`, and
     * this bundle used to require that package. It does not any more: a plugin
     * authored outside the harness has no type check and no release coupling
     * with it, so a changed prop contract would not fail here — it would throw
     * while rendering, blank this whole slot entry, and take the failures the
     * tool card exists to show down with it. The declarations below are copied
     * from the atoms (`src/Button.tsx`, `src/Input.tsx`, and their CSS modules),
     * prefix-renamed, and reduced to the variants and sizes this bundle uses;
     * every colour stays a `--dsw-*` token, so both themes still match the host.
     * Only `react` and `react-dom` are requested from the module table now.
     */
    const CSS = `
.imagegen-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: none;
  cursor: pointer;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-sm);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
}
.imagegen-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.imagegen-btn--primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.imagegen-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.imagegen-btn--ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.imagegen-btn--ghost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.imagegen-btn--outline {
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: transparent;
}
.imagegen-btn--outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.imagegen-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
}
.imagegen-field:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.imagegen-field-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.imagegen-field-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.imagegen-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 40px;
}
.imagegen-lightbox-mask {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1);
  backdrop-filter: var(--dsw-mask-blur);
}
.imagegen-lightbox-image {
  position: relative;
  max-width: min(100%, 1600px);
  max-height: calc(100vh - 80px);
  object-fit: contain;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-input-major);
  box-shadow: var(--dsw-elevation-prominent);
}
.imagegen-lightbox-close {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 0.5px solid var(--dsw-alias-border-l2-darkmode-thin);
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-specific-input-major);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
}
.imagegen-lightbox-close:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 3px;
}
`

    /**
     * Mount the bundle's styles with the surface that uses them, so unmounting
     * the surface removes them; the shell shares no stylesheet with a plugin.
     */
    function Styles() {
      return h('style', null, CSS)
    }

    /**
     * The host's action button: same geometry, variants, and disabled styling.
     * Native button attributes pass through; `variant` and `size` stay here
     * instead of reaching the DOM as attributes.
     */
    function Button({ variant = 'ghost', size = 'sm', children, ...rest }) {
      return h('button', {
        type: 'button',
        className: `imagegen-btn imagegen-btn--${variant} imagegen-btn--${size}`,
        ...rest,
      }, children)
    }

    /** The host's single-line field: same frame, focus ring, and placeholder. */
    function Input({ className, ...rest }) {
      return h('span', { className: className === undefined ? 'imagegen-field' : `imagegen-field ${className}` },
        h('input', { className: 'imagegen-field-input', ...rest }))
    }

    /** Package name this bundle is installed as; it keys the Plugins-page slots. */
    const BUNDLE = 'dsh-imagegen'

    /** Locale namespace owned by this bundle. */
    const NS = 'imagegen'

    /** Images one gallery page requests. */
    const PAGE_SIZE = 24

    /** How long an in-place notice stays before it clears itself. */
    const NOTICE_MS = 6000

    /** Fields the Plugins page may override, in display order. */
    const FIELD_ORDER = ['model', 'size', 'quality', 'timeoutMs', 'outputDir']

    /** Which dictionary key names each credential source the host reports. */
    const SOURCE_KEYS = {
      file: 'config.sourceFile',
      env: 'config.sourceEnv',
      'user-env': 'config.sourceUserEnv',
      'project-env': 'config.sourceProjectEnv',
      config: 'config.sourceConfig',
    }

    const zh = {
      'config.baseUrl': '请求地址',
      'config.apiKey': 'API KEY',
      'config.model': '模型',
      'config.size': '尺寸',
      'config.quality': '质量',
      'config.timeoutMs': '超时（秒）',
      'config.outputDir': '输出目录',
      'config.save': '保存',
      'config.saving': '保存中…',
      'config.test': '测试连接',
      'config.testing': '测试中…',
      'config.clearKey': '清除已保存的 KEY',
      'config.confirmClearKey': '确认清除',
      'config.cancel': '取消',
      'config.loading': '正在读取配置…',
      'config.loadFailed': '读取配置失败：{detail}',
      'config.saved': '已保存',
      'config.cleared': '已清除已保存的 KEY',
      'config.nothingToSave': '没有改动需要保存',
      'config.sourceFile': '凭据存储',
      'config.sourceEnv': '启动环境',
      'config.sourceUserEnv': '~/.dsh/.env',
      'config.sourceProjectEnv': '工作区 .env',
      'config.sourceConfig': 'profile 配置',
      'config.sourceUnknown': '未知来源',
      'config.pinned': '由 profile 配置固定，此处只读',
      'config.unconfigured': '未配置',
      'config.editableFrom': '来源：{where}，可在此修改',
      'config.readOnlyFrom': '来源：{where}，只读',
      'config.overridden': '已在插件页覆盖，清空并保存即恢复默认',
      'config.inherited': '来自 profile 配置或内置默认值',
      'config.baseUrlPlaceholder': 'https://relay.example.com/v1',
      'config.keyConfigured': '已保存（留空表示不修改）',
      'config.keyMissing': '未配置',
      'config.probeOk': '连通正常（HTTP {status}）',
      'config.probeInconclusive': '无法判定：{detail}',
      'config.probeFailed': '连接失败：{detail}',
      'gallery.title': '已生成的图片',
      'gallery.empty': '还没有生成过图片。模型调用一次 generate_image 就会出现在这里。',
      'gallery.loading': '正在读取图片…',
      'gallery.loadFailed': '读取图片失败：{detail}',
      'gallery.loadMore': '加载更多',
      'gallery.total': '共 {total} 张，显示 {shown} 张',
      'gallery.open': '打开',
      'gallery.reveal': '定位',
      'gallery.copy': '复制路径',
      'gallery.reuse': '再次编辑',
      'gallery.remove': '删除',
      'gallery.confirmRemove': '确认删除',
      'gallery.cancel': '取消',
      'gallery.copied': '已复制路径',
      'gallery.copyFailed': '复制失败：{detail}',
      'gallery.reuseCopied': '已复制 generate_image 的参数，粘到输入框再说明要改什么',
      'gallery.opened': '已交给系统打开',
      'gallery.revealed': '已在文件管理器中定位',
      'gallery.handOffFailed': '操作失败：{detail}',
      'gallery.deleted': '已删除图片与索引记录',
      'gallery.editFailed': '操作失败：{detail}',
      'gallery.previewDialog': '图片预览',
      'gallery.previewClose': '关闭图片预览',
      'card.generating': '正在生成图片…',
      'card.loading': '正在加载图片…',
      'card.failed': '图片加载失败。',
      'card.enlarge': '点击放大',
      'card.enlargeLabel': '放大 {label}',
      'card.fallbackLabel': '生成的图片',
    }
    const en = {
      'config.baseUrl': 'Endpoint',
      'config.apiKey': 'API key',
      'config.model': 'Model',
      'config.size': 'Size',
      'config.quality': 'Quality',
      'config.timeoutMs': 'Timeout (seconds)',
      'config.outputDir': 'Output directory',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.test': 'Test connection',
      'config.testing': 'Testing…',
      'config.clearKey': 'Clear saved key',
      'config.confirmClearKey': 'Confirm clear',
      'config.cancel': 'Cancel',
      'config.loading': 'Reading settings…',
      'config.loadFailed': 'Could not read the settings: {detail}',
      'config.saved': 'Saved',
      'config.cleared': 'The saved key was cleared',
      'config.nothingToSave': 'Nothing changed',
      'config.sourceFile': 'the credential store',
      'config.sourceEnv': 'the launch environment',
      'config.sourceUserEnv': '~/.dsh/.env',
      'config.sourceProjectEnv': 'the workspace .env',
      'config.sourceConfig': 'the profile configuration',
      'config.sourceUnknown': 'an unknown source',
      'config.pinned': 'Pinned by the profile configuration; read-only here',
      'config.unconfigured': 'Not configured',
      'config.editableFrom': 'From {where}; editable here',
      'config.readOnlyFrom': 'From {where}; read-only',
      'config.overridden': 'Overridden on this page; save an empty value to fall back',
      'config.inherited': 'From the profile configuration or the built-in default',
      'config.baseUrlPlaceholder': 'https://relay.example.com/v1',
      'config.keyConfigured': 'Saved (leave blank to keep it)',
      'config.keyMissing': 'Not configured',
      'config.probeOk': 'Reachable (HTTP {status})',
      'config.probeInconclusive': 'Inconclusive: {detail}',
      'config.probeFailed': 'Connection failed: {detail}',
      'gallery.title': 'Generated images',
      'gallery.empty': 'Nothing generated yet. One generate_image call puts its images here.',
      'gallery.loading': 'Reading images…',
      'gallery.loadFailed': 'Could not read the images: {detail}',
      'gallery.loadMore': 'Load more',
      'gallery.total': '{shown} of {total} images',
      'gallery.open': 'Open',
      'gallery.reveal': 'Show in folder',
      'gallery.copy': 'Copy path',
      'gallery.reuse': 'Edit again',
      'gallery.remove': 'Delete',
      'gallery.confirmRemove': 'Confirm delete',
      'gallery.cancel': 'Cancel',
      'gallery.copied': 'Path copied',
      'gallery.copyFailed': 'Could not copy: {detail}',
      'gallery.reuseCopied': 'The generate_image arguments are on the clipboard; paste them and say what to change',
      'gallery.opened': 'Handed to the system',
      'gallery.revealed': 'Selected in the file manager',
      'gallery.handOffFailed': 'That did not work: {detail}',
      'gallery.deleted': 'The image and its index record are gone',
      'gallery.editFailed': 'That did not work: {detail}',
      'gallery.previewDialog': 'Image preview',
      'gallery.previewClose': 'Close image preview',
      'card.generating': 'Generating image…',
      'card.loading': 'Loading image…',
      'card.failed': 'The generated image could not be loaded.',
      'card.enlarge': 'Click to enlarge',
      'card.enlargeLabel': 'Enlarge {label}',
      'card.fallbackLabel': 'generated image',
    }

    /** Substitute `{name}` placeholders without the locale service. */
    const interpolate = (template, params) => params === undefined
      ? template
      : template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)

    /** Shared layout, so the two sections read as one page. */
    const S = {
      stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px' },
      label: { fontSize: '13px', opacity: 0.75 },
      note: { fontSize: '12px', opacity: 0.6 },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      muted: { fontSize: '13px', opacity: 0.7 },
      problem: { fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #d9544d)' },
      section: { display: 'flex', flexDirection: 'column', gap: '12px' },
      heading: { fontSize: '14px', fontWeight: 600, margin: 0 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '14px' },
      tile: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
      thumb: {
        display: 'block', width: '100%', height: '150px', objectFit: 'cover',
        borderRadius: '10px', background: 'var(--dsw-alias-bg-skeleton, rgba(127, 127, 127, 0.12))',
      },
      thumbButton: { padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', display: 'block', width: '100%' },
      caption: {
        fontSize: '12px', opacity: 0.6, display: '-webkit-box', WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical', overflow: 'hidden',
      },
      actions: { display: 'flex', gap: '2px', flexWrap: 'wrap' },
    }

    /** The message of a thrown value, whatever was thrown. */
    const detailOf = (error) => error instanceof Error ? error.message : String(error)

    /** Absolute URL of one host route, resolved against the deployment's base. */
    function routeUrl(path, params) {
      const url = new URL(`api/imagegen/${path}`, document.baseURI)
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
      }
      return url.href
    }

    /**
     * Read one JSON route, turning the host's `{ ok: false, error }` envelope
     * and any transport failure into one thrown Error the caller can show.
     */
    async function readJson(url, init) {
      const response = await fetch(url, init)
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        throw new Error(`HTTP ${response.status}`)
      }
      if (payload !== null && typeof payload === 'object' && payload.ok === false) {
        throw new Error(String(payload.error ?? `HTTP ${response.status}`))
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return payload
    }

    /** POST one JSON body to a host route. */
    const postJson = (path, body) => readJson(routeUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    /** Bytes as a short human string. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return ''
      if (bytes < 1024) return `${String(bytes)} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /** One record's timestamp in the reader's own locale. */
    function formatTime(createdAt) {
      const at = new Date(createdAt)
      return Number.isNaN(at.getTime()) ? '' : at.toLocaleString()
    }

    /**
     * Image attachment references carried by one result's content blocks.
     * @param content - the tool result's content blocks.
     * @returns One attachment reference per image block.
     */
    const imageRefs = (content) => content
      .filter(block => block.type === 'image' && block.attachment !== undefined)
      .map(block => block.attachment)

    /** The result's text blocks, joined the way the generic row joins them. */
    const textOf = (content) => content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')

    /**
     * Display box for one thumbnail: long edge 240px with the rendered aspect
     * ratio clamped to [0.25, 4] (the overflow is cropped by `object-fit`), and
     * never upscaled past the image's own size. The same rule the shipped
     * message-image component uses, so a generated image sits in the timeline
     * like every other image.
     */
    function thumbFit(dimensions) {
      if (dimensions === undefined || dimensions.width <= 0 || dimensions.height <= 0) {
        return { width: 240, height: 240, objectPosition: 'center' }
      }
      const natural = dimensions.width / dimensions.height
      const ratio = Math.min(4, Math.max(0.25, natural))
      const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 }
      const scale = Math.min(1, dimensions.width / box.width, dimensions.height / box.height)
      return {
        width: Math.max(1, Math.round(box.width * scale)),
        height: Math.max(1, Math.round(box.height * scale)),
        objectPosition: natural < 0.25 ? 'center top' : natural > 4 ? 'left center' : 'center',
      }
    }

    /**
     * Document-level preview opened by clicking a thumbnail. Closes on Escape,
     * backdrop press, or the close control, and holds the keyboard while it is
     * open: the close control takes focus, Tab stays inside the dialog, and
     * unmounting returns focus to the control that opened it. Rendered through a
     * body portal: an opener inside a transformed or filtered ancestor would
     * otherwise trap the fixed backdrop in that ancestor's box instead of
     * covering the viewport. Everything the dialog owns sits inside the element
     * that carries `role="dialog"`, so the role contains the image and the
     * control rather than an empty box beside them.
     */
    function ImageLightbox({ src, alt, labels, onClose }) {
      const closeRef = React.useRef(null)
      const restoreRef = React.useRef(null)
      React.useEffect(() => {
        restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        if (closeRef.current !== null) closeRef.current.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
          // One control, so Tab parks on it instead of walking the page behind.
          if (event.key === 'Tab') {
            event.preventDefault()
            if (closeRef.current !== null) closeRef.current.focus()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => {
          window.removeEventListener('keydown', onKeyDown, true)
          if (restoreRef.current !== null) restoreRef.current.focus()
        }
      }, [onClose])
      return createPortal(
        h('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': labels.dialog,
          className: 'imagegen-lightbox',
        },
        h('div', { className: 'imagegen-lightbox-mask', 'aria-hidden': 'true', onMouseDown: onClose }),
        h('img', { className: 'imagegen-lightbox-image', src, alt }),
        h('button', {
          ref: closeRef,
          type: 'button',
          className: 'imagegen-lightbox-close',
          onClick: onClose,
          'aria-label': labels.close,
        }, '✕')),
        document.body,
      )
    }

    /** An in-place notice that clears itself; repeated text restarts the hold. */
    function useNotice() {
      const [notice, setNotice] = React.useState(null)
      React.useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => { setNotice(null) }, NOTICE_MS)
        return () => { clearTimeout(timer) }
      }, [notice])
      const notify = React.useCallback((text) => { setNotice({ seq: Date.now(), text }) }, [])
      return { notice, notify }
    }

    /** The notice line both sections render above their content. */
    const NoticeLine = ({ notice }) => notice === null
      ? null
      : h('div', { role: 'status', style: S.note }, notice.text)

    /**
     * One generated image: loaded through the session-authorized `loadImage`
     * prop, shown as a bounded thumbnail, and enlarged on click. The bytes are
     * not in the event, so the card resolves an object URL from the attachment
     * reference the tool result carries.
     */
    function AttachmentImage({ attachment, load, t }) {
      const [url, setUrl] = React.useState(() => load.peek?.(attachment) ?? null)
      const [failed, setFailed] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => {
        let live = true
        setFailed(false)
        setUrl(load.peek?.(attachment) ?? null)
        load(attachment)
          .then(next => { if (live) setUrl(next) })
          .catch(() => { if (live) setFailed(true) })
        return () => { live = false }
      }, [attachment, load])
      const close = React.useCallback(() => { setOpen(false) }, [])
      if (failed) return h('div', { style: S.note }, t('card.failed'))
      if (url === null) return h('div', { style: S.note }, t('card.loading'))
      const label = attachment.name ?? t('card.fallbackLabel')
      const fit = thumbFit(attachment)
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          onClick: () => { setOpen(true) },
          title: t('card.enlarge'),
          'aria-label': t('card.enlargeLabel', { label }),
          style: {
            ...S.thumbButton,
            width: `${fit.width}px`,
            height: `${fit.height}px`,
            borderRadius: '10px',
            overflow: 'hidden',
          },
        },
        h('img', {
          src: url,
          alt: label,
          style: {
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: fit.objectPosition,
          },
        })),
        open
          ? h(ImageLightbox, {
            src: url,
            alt: label,
            labels: { dialog: t('gallery.previewDialog'), close: t('gallery.previewClose') },
            onClose: close,
          })
          : null,
      )
    }

    /** The `generate_image` tool card. */
    function GenerateImageRow(props) {
      const t = props.t
      const block = props.block
      const settled = block.kind === 'tool-result'
      const content = settled ? block.content ?? [] : []
      // Keyed on the result's own content array so a re-render does not hand the
      // loaders a fresh reference and restart every request.
      const images = React.useMemo(() => imageRefs(content), [content])
      const text = settled ? textOf(content) : t('card.generating')
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        text.length > 0 ? h('div', { style: { whiteSpace: 'pre-wrap', fontSize: '13px' } }, text) : null,
        ...images.map((attachment, index) => h(AttachmentImage, {
          key: `${attachment.attachmentId}:${index}`,
          attachment,
          load: props.loadImage,
          t,
        })),
      )
    }

    /** Every editable field as text, so an untouched field is not submitted. */
    function draftsOf(status) {
      const drafts = { baseUrl: status.baseUrl.value ?? '', apiKey: '' }
      for (const field of FIELD_ORDER) {
        drafts[field] = status.fields[field] === null ? '' : String(status.fields[field])
      }
      return drafts
    }

    /** The edits the drafts express, as the host's `{ field, value }` writes. */
    function collectEdits(status, drafts) {
      const edits = []
      const baseUrl = drafts.baseUrl.trim()
      if (!status.baseUrl.pinned && baseUrl !== (status.baseUrl.value ?? '')) {
        edits.push({ field: 'baseUrl', value: baseUrl === '' ? null : baseUrl })
      }
      const apiKey = drafts.apiKey.trim()
      if (!status.apiKey.pinned && apiKey !== '') edits.push({ field: 'apiKey', value: apiKey })
      for (const field of FIELD_ORDER) {
        const current = status.fields[field] === null ? '' : String(status.fields[field])
        const draft = (drafts[field] ?? '').trim()
        if (draft !== current) edits.push({ field, value: draft === '' ? null : draft })
      }
      return edits
    }

    /** Where one credential's value comes from, and whether it can be replaced. */
    function sourceLine(t, info) {
      if (info.pinned) return t('config.pinned')
      if (!info.configured) return t('config.unconfigured')
      const where = t(SOURCE_KEYS[info.source] ?? 'config.sourceUnknown')
      return t(info.writable ? 'config.editableFrom' : 'config.readOnlyFrom', { where })
    }

    /** One labelled control with its note. */
    const Field = ({ label, control, note }) => h('label', { style: S.field },
      h('span', { style: S.label }, label),
      control,
      note === undefined || note === '' ? null : h('span', { style: S.note }, note),
    )

    /**
     * The bundle's configuration section on the Plugins page: what the host
     * currently resolves, what this page has overridden, and the writes for
     * both. Save submits only the fields whose drafts differ, so a page left
     * open does not rewrite values somebody else changed meanwhile.
     */
    function SettingsSection(props) {
      const t = props.t
      const [status, setStatus] = React.useState(null)
      const [drafts, setDrafts] = React.useState({})
      const [problem, setProblem] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [clearing, setClearing] = React.useState(false)
      const { notice, notify } = useNotice()

      const adopt = React.useCallback((next) => {
        setStatus(next)
        setDrafts(draftsOf(next))
        setProblem(null)
      }, [])

      React.useEffect(() => {
        let live = true
        readJson(routeUrl('status'))
          .then(payload => { if (live) adopt(payload.status) })
          .catch(error => { if (live) setProblem(detailOf(error)) })
        return () => { live = false }
      }, [adopt])

      const edit = React.useCallback((field, value) => {
        setDrafts(previous => ({ ...previous, [field]: value }))
      }, [])

      const save = React.useCallback(async () => {
        if (status === null) return
        setBusy('save')
        try {
          const edits = collectEdits(status, drafts)
          if (edits.length === 0) {
            notify(t('config.nothingToSave'))
            return
          }
          let latest = status
          for (const one of edits) latest = (await postJson('update', one)).status
          adopt(latest)
          notify(t('config.saved'))
        } catch (error) {
          notify(detailOf(error))
        } finally {
          setBusy(null)
        }
      }, [status, drafts, adopt, notify, t])

      const test = React.useCallback(async () => {
        setBusy('test')
        try {
          const probe = (await postJson('test', {})).probe
          if (probe.ok) notify(t('config.probeOk', { status: probe.status }))
          else if (probe.inconclusive === true) notify(t('config.probeInconclusive', { detail: probe.detail ?? '' }))
          else notify(t('config.probeFailed', { detail: probe.detail ?? `HTTP ${probe.status}` }))
        } catch (error) {
          notify(detailOf(error))
        } finally {
          setBusy(null)
        }
      }, [notify, t])

      const clearKey = React.useCallback(async () => {
        setBusy('clear')
        try {
          adopt((await postJson('update', { field: 'apiKey', value: null })).status)
          setClearing(false)
          notify(t('config.cleared'))
        } catch (error) {
          notify(detailOf(error))
        } finally {
          setBusy(null)
        }
      }, [adopt, notify, t])

      if (problem !== null) return h('div', { style: S.problem }, t('config.loadFailed', { detail: problem }))
      if (status === null) return h('div', { style: S.muted }, t('config.loading'))

      const text = (field, extra) => Object.assign({
        value: drafts[field] ?? '',
        'aria-label': t(`config.${field}`),
        onChange: event => { edit(field, event.target.value) },
      }, extra ?? {})

      const overrideNotes = {}
      for (const field of FIELD_ORDER) {
        overrideNotes[field] = status.overrides[field] === undefined ? t('config.inherited') : t('config.overridden')
      }

      return h('div', { style: S.stack },
        h(Styles),
        h(NoticeLine, { notice }),
        h(Field, {
          label: t('config.baseUrl'),
          control: h(Input, text('baseUrl', {
            readOnly: status.baseUrl.pinned,
            placeholder: t('config.baseUrlPlaceholder'),
            spellCheck: false,
          })),
          note: sourceLine(t, status.baseUrl),
        }),
        h(Field, {
          label: t('config.apiKey'),
          control: h(Input, text('apiKey', {
            type: 'password',
            readOnly: status.apiKey.pinned,
            autoComplete: 'off',
            spellCheck: false,
            placeholder: status.apiKey.configured ? t('config.keyConfigured') : t('config.keyMissing'),
          })),
          note: sourceLine(t, status.apiKey),
        }),
        h(Field, {
          label: t('config.model'),
          control: h(Input, text('model')),
          note: overrideNotes.model,
        }),
        h(Field, {
          label: t('config.size'),
          control: h(Input, text('size')),
          note: overrideNotes.size,
        }),
        h(Field, {
          label: t('config.quality'),
          control: h(Input, text('quality')),
          note: overrideNotes.quality,
        }),
        h(Field, {
          label: t('config.timeoutMs'),
          control: h(Input, text('timeoutMs')),
          note: overrideNotes.timeoutMs,
        }),
        h(Field, {
          label: t('config.outputDir'),
          control: h(Input, text('outputDir')),
          note: overrideNotes.outputDir,
        }),
        h('div', { style: S.row },
          h(Button, { variant: 'primary', size: 'sm', disabled: busy !== null, onClick: () => { void save() } },
            busy === 'save' ? t('config.saving') : t('config.save')),
          h(Button, { variant: 'outline', size: 'sm', disabled: busy !== null, onClick: () => { void test() } },
            busy === 'test' ? t('config.testing') : t('config.test')),
          status.apiKey.configured && status.apiKey.writable && !status.apiKey.pinned
            ? (clearing
              ? h(React.Fragment, null,
                h(Button, { variant: 'outline', size: 'sm', disabled: busy !== null, onClick: () => { void clearKey() } },
                  t('config.confirmClearKey')),
                h(Button, { variant: 'ghost', size: 'sm', onClick: () => { setClearing(false) } }, t('config.cancel')))
              : h(Button, { variant: 'ghost', size: 'sm', onClick: () => { setClearing(true) } }, t('config.clearKey')))
            : null),
      )
    }

    /** One gallery tile: the image, its prompt, and the actions on it. */
    function GalleryTile({ record, t, onOpen, onHandOff, onCopy, onReuse, onRemove, confirming, onConfirming }) {
      const bytes = formatBytes(record.bytes)
      const tokens = record.usage?.output_tokens
      const meta = [record.mode, record.size, bytes, tokens === undefined ? undefined : `${tokens.toLocaleString()} tok`, formatTime(record.createdAt)].filter(Boolean).join(' · ')
      const action = (label, onClick) => h(Button, { variant: 'ghost', size: 'sm', onClick }, label)
      return h('div', { style: S.tile },
        h('button', {
          type: 'button',
          style: S.thumbButton,
          onClick: () => { onOpen(record) },
          title: record.prompt ?? record.name ?? '',
          'aria-label': t('card.enlargeLabel', { label: record.name ?? t('card.fallbackLabel') }),
        }, h('img', {
          src: routeUrl('image', { id: record.id }),
          alt: record.name ?? '',
          loading: 'lazy',
          decoding: 'async',
          style: S.thumb,
        })),
        record.prompt === undefined ? null : h('div', { style: S.caption }, record.prompt),
        h('div', { style: S.note }, meta),
        confirming
          ? h('div', { style: S.actions },
            action(t('gallery.confirmRemove'), () => { onRemove(record) }),
            action(t('gallery.cancel'), () => { onConfirming(null) }))
          : h('div', { style: S.actions },
            action(t('gallery.open'), () => { onHandOff(record, 'open') }),
            action(t('gallery.reveal'), () => { onHandOff(record, 'reveal') }),
            action(t('gallery.copy'), () => { onCopy(record.path, t('gallery.copied')) }),
            action(t('gallery.reuse'), () => { onReuse(record) }),
            action(t('gallery.remove'), () => { onConfirming(record.id) })),
      )
    }

    /**
     * The generated-image gallery. It reads the plugin's own index through the
     * host's authenticated image routes, so it lists what this plugin produced
     * even when the files sit outside any session's workspace.
     */
    function Gallery(props) {
      const t = props.t
      const [state, setState] = React.useState({ items: [], total: 0, hasMore: false, offset: 0 })
      const [problem, setProblem] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [preview, setPreview] = React.useState(null)
      const [confirming, setConfirming] = React.useState(null)
      const { notice, notify } = useNotice()

      const load = React.useCallback(async (offset) => {
        setLoading(true)
        try {
          const payload = await readJson(routeUrl('images', { limit: PAGE_SIZE, offset }))
          setState(previous => ({
            items: offset === 0 ? payload.items : [...previous.items, ...payload.items],
            total: payload.total,
            hasMore: payload.hasMore,
            offset: offset + payload.items.length,
          }))
          setProblem(null)
        } catch (error) {
          setProblem(detailOf(error))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => { void load(0) }, [load])

      const copy = React.useCallback(async (text, done) => {
        try {
          await navigator.clipboard.writeText(text)
          notify(done)
        } catch (error) {
          notify(t('gallery.copyFailed', { detail: detailOf(error) }))
        }
      }, [notify, t])

      const handOff = React.useCallback(async (record, action) => {
        try {
          await postJson(action, { id: record.id })
          notify(action === 'open' ? t('gallery.opened') : t('gallery.revealed'))
        } catch (error) {
          notify(t('gallery.handOffFailed', { detail: detailOf(error) }))
        }
      }, [notify, t])

      const reuse = React.useCallback((record) => {
        const args = { prompt: record.prompt ?? '', image: [record.path] }
        void copy(JSON.stringify(args, null, 2), t('gallery.reuseCopied'))
      }, [copy, t])

      const remove = React.useCallback(async (record) => {
        try {
          await postJson('delete', { id: record.id })
          setState(previous => ({
            ...previous,
            items: previous.items.filter(item => item.id !== record.id),
            total: Math.max(0, previous.total - 1),
          }))
          setConfirming(null)
          notify(t('gallery.deleted'))
        } catch (error) {
          notify(t('gallery.editFailed', { detail: detailOf(error) }))
        }
      }, [notify, t])

      const closePreview = React.useCallback(() => { setPreview(null) }, [])

      return h('section', { style: S.section },
        h(Styles),
        h('h3', { style: S.heading }, t('gallery.title')),
        h(NoticeLine, { notice }),
        problem === null ? null : h('div', { style: S.problem }, t('gallery.loadFailed', { detail: problem })),
        loading && state.items.length === 0 ? h('div', { style: S.muted }, t('gallery.loading')) : null,
        problem !== null || (loading && state.items.length === 0) || state.items.length > 0
          ? null
          : h('div', { style: S.muted }, t('gallery.empty')),
        state.items.length === 0 ? null : h('div', { style: S.grid },
          ...state.items.map(record => h(GalleryTile, {
            key: record.id,
            record,
            t,
            confirming: confirming === record.id,
            onConfirming: setConfirming,
            onOpen: setPreview,
            onHandOff: (one, action) => { void handOff(one, action) },
            onCopy: (text, done) => { void copy(text, done) },
            onReuse: reuse,
            onRemove: (one) => { void remove(one) },
          }))),
        state.items.length === 0 ? null : h('div', { style: S.row },
          h('span', { style: S.note }, t('gallery.total', { shown: state.items.length, total: state.total })),
          state.hasMore
            ? h(Button, { variant: 'outline', size: 'sm', disabled: loading, onClick: () => { void load(state.offset) } },
              t('gallery.loadMore'))
            : null),
        preview === null ? null : h(ImageLightbox, {
          src: routeUrl('image', { id: preview.id }),
          alt: preview.name ?? '',
          labels: { dialog: t('gallery.previewDialog'), close: t('gallery.previewClose') },
          onClose: closePreview,
        }),
      )
    }

    /**
     * The gallery claims the detail-section slot only for this bundle's own
     * page: the slot renders under every bundle, row, and official-plugin page.
     */
    function GallerySection(props) {
      const subject = props.subject
      if (subject === undefined || subject.kind !== 'bundle' || subject.pkg.name !== BUNDLE) return null
      return h(Gallery, { t: props.t })
    }

    /**
     * Claim the tool card and the two Plugins-page surfaces. No `children` on
     * the tool card, so there is no slot conflict with the shipped image card.
     */
    function apply(ctx) {
      const locale = ctx.get('locale')
      // Falls back to the reader's own language when no locale service is
      // composed, so the page is never in a language nobody chose.
      const fallback = (navigator.language ?? '').toLowerCase().startsWith('zh') ? zh : en
      let t = (key, params) => interpolate(fallback[key] ?? en[key] ?? key, params)
      if (locale !== undefined && typeof locale.bind === 'function' && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh, en }), 'imagegen: dictionaries')
        t = locale.bind(NS)
      }
      const inject = () => ({ t })
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
        { name: 'tool.call.toolview', key: 'generate_image', inject },
        GenerateImageRow,
      ))
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
        { name: 'plugins.bundle.config', key: BUNDLE, inject },
        SettingsSection,
      ))
      ctx.slots.inject('plugins.detail.section', () => ctx.slots.register(
        { name: 'plugins.detail.section', id: 'imagegen-gallery', order: 20, inject },
        GallerySection,
      ))
    }

    const inject = ['slots']
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
