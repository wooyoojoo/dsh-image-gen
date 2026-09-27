/**
 * Browser half of dsh-imagegen: renders one `generate_image` call as a card with
 * the generated images inline, each a bounded thumbnail that opens a
 * click-to-enlarge preview.
 *
 * The Web client does not consume Host presentation methods; it renders a tool
 * result through the `tool.call.toolview` keyed slot, keyed by the wire tool
 * name, and falls back to the generic row for an unclaimed key. This file claims
 * `generate_image`.
 *
 * It is hand-written in the artifact format the client module loader executes:
 * a classic script calling `window.__ModuleLoader__.load({ id, factory })` with
 * a factory returning the plugin module. That is what `packages/client/tsdown.client.ts`
 * emits for in-repo client packages; reproducing it here keeps this bundle free
 * of a build step, at the cost of writing plain `React.createElement` instead of
 * JSX, inline styles instead of CSS Modules, and plain copy instead of the
 * repository's typed locale dictionaries. `react` and `react-dom` are
 * shell-seeded baseline modules, so no `dsh.client.external` request is needed.
 *
 * The card must render every state of its key: claiming a tool name suppresses
 * the generic row for that tool, including its failures.
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

    /** Image attachment references carried by one result's content blocks. */
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
     * backdrop press, or the close control. Rendered through a body portal: an
     * opener inside a transformed or filtered ancestor would otherwise trap the
     * fixed backdrop in that ancestor's box instead of covering the viewport.
     */
    function ImageLightbox({ src, alt, onClose }) {
      React.useEffect(() => {
        const onKeyDown = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKeyDown)
        return () => { window.removeEventListener('keydown', onKeyDown) }
      }, [onClose])
      return createPortal(
        h('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': alt,
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 1200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        h('div', {
          'aria-hidden': 'true',
          onMouseDown: onClose,
          style: { position: 'absolute', inset: 0, background: 'rgba(0, 0, 0, 0.72)' },
        }),
        h('img', {
          src,
          alt,
          style: {
            position: 'relative',
            maxWidth: '92vw',
            maxHeight: '92vh',
            borderRadius: '10px',
            boxShadow: '0 12px 48px rgba(0, 0, 0, 0.45)',
          },
        }),
        h('button', {
          type: 'button',
          onClick: onClose,
          'aria-label': 'Close image preview',
          style: {
            position: 'absolute',
            top: '16px',
            right: '16px',
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            border: 'none',
            cursor: 'pointer',
            fontSize: '16px',
            lineHeight: '1',
            color: '#fff',
            background: 'rgba(255, 255, 255, 0.18)',
          },
        }, '✕')),
        document.body,
      )
    }

    /**
     * One generated image: loaded through the session-authorized `loadImage`
     * prop, shown as a bounded thumbnail, and enlarged on click. The bytes are
     * not in the event, so the card resolves an object URL from the attachment
     * reference the tool result carries.
     */
    function AttachmentImage({ attachment, load }) {
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
      const note = { fontSize: '13px', opacity: 0.7 }
      if (failed) return h('div', { style: note }, 'Generated image could not be loaded.')
      if (url === null) return h('div', { style: note }, 'Loading image…')
      const label = attachment.name ?? 'generated image'
      const fit = thumbFit(attachment)
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          onClick: () => { setOpen(true) },
          title: 'Click to enlarge',
          'aria-label': `Enlarge ${label}`,
          style: {
            display: 'block',
            width: `${fit.width}px`,
            height: `${fit.height}px`,
            padding: 0,
            border: 'none',
            borderRadius: '10px',
            overflow: 'hidden',
            background: 'none',
            cursor: 'zoom-in',
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
        open ? h(ImageLightbox, { src: url, alt: label, onClose: () => { setOpen(false) } }) : null,
      )
    }

    /** The `generate_image` tool card. */
    function GenerateImageRow(props) {
      const block = props.block
      const settled = block.kind === 'tool-result'
      const content = settled ? block.content ?? [] : []
      // Keyed on the result's own content array so a re-render does not hand the
      // loaders a fresh reference and restart every request.
      const images = React.useMemo(() => imageRefs(content), [content])
      const text = settled ? textOf(content) : 'Generating image…'
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        text.length > 0 ? h('div', { style: { whiteSpace: 'pre-wrap', fontSize: '13px' } }, text) : null,
        ...images.map((attachment, index) => h(AttachmentImage, {
          key: `${attachment.attachmentId}:${index}`,
          attachment,
          load: props.loadImage,
        })),
      )
    }

    /** Claim the `generate_image` key; no `children`, so no slot conflict with the shipped image card. */
    function apply(ctx) {
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
        { name: 'tool.call.toolview', key: 'generate_image' },
        GenerateImageRow,
      ))
    }

    const inject = ['slots']
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
