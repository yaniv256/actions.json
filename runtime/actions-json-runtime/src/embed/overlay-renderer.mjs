// Overlay rendering, extracted host-neutral.
//
// `docs/overlay-template-data.md` already says future first-party embeds
// should use the same overlay shape. This is that shape, lifted out of the
// Chrome content script so a second host can honour it rather than reimplement
// it — the extension's version lives inside a 6000-line IIFE and reaches
// chrome.storage for settings and launcher persistence, which is what made it
// look host-specific. The rendering itself never touches chrome.*.
//
// What is host-neutral and lives here: parsing an overlay document, stripping
// what must not execute, building the artifact for download, and rendering
// into a sandboxed frame.
//
// What is NOT here: persistence and launcher registration. Those are the parts
// that actually differ per host — chrome.storage in the extension, something
// else in a served page — so they arrive as an injected store rather than
// being assumed.

const OVERLAY_HOST_ID = "__actions_json_overlay_runtime_host";

// Attribute-level XSS surface that survives script removal. Inline handlers
// execute in the embedding document's origin, so they are stripped whether or
// not scripts are preserved for a template-driven overlay.
const UNSAFE_ATTRIBUTE_PREFIX = "on";
const UNSAFE_URL_SCHEMES = /^\s*(javascript|data|vbscript):/i;

export function removeUnsafeAttributes(root) {
  const elements = root.querySelectorAll("*");
  for (const element of elements) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith(UNSAFE_ATTRIBUTE_PREFIX)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === "href" || name === "src") && UNSAFE_URL_SCHEMES.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return root;
}

/**
 * Parse an overlay document into its renderable parts.
 *
 * `preserveScripts` is only ever true for a template-driven overlay, whose
 * template is a reviewed artifact rather than model output. An inline `html`
 * overlay never keeps its scripts: that content is whatever the agent wrote
 * this turn.
 */
export function parseHtmlDocument(html, { preserveScripts = false, parser } = {}) {
  const domParser = parser ?? new DOMParser();
  const doc = domParser.parseFromString(html, "text/html");

  const style = [...doc.querySelectorAll("style")].map((node) => node.textContent || "").join("\n");

  removeUnsafeAttributes(doc);
  if (!preserveScripts) {
    doc.querySelectorAll("script").forEach((node) => node.remove());
  }

  return {
    title: doc.querySelector("title")?.textContent?.trim() ?? null,
    style,
    body: doc.body ? doc.body.innerHTML : html,
    scripts_preserved: preserveScripts,
  };
}

/**
 * The sandbox flags for an overlay frame.
 *
 * `allow-scripts` and `allow-same-origin` are never granted together: that
 * combination lets framed content reach out of the sandbox and script the
 * embedding page, which for an embed host is the host application itself.
 * Templates get scripts without same-origin; inline overlays get same-origin
 * without scripts.
 */
export function sandboxFor({ allowScripts = false } = {}) {
  return allowScripts ? "allow-scripts" : "allow-same-origin";
}

export function buildOverlayArtifactHtml({ title, parsed }) {
  const artifactTitle = title || parsed?.title || "actions.json overlay";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(artifactTitle)}</title>`,
    parsed?.style ? `<style>${parsed.style}</style>` : "",
    "</head>",
    "<body>",
    parsed?.body ?? "",
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A template/data overlay: a reusable template rendered against a data file.
 * The split exists so a visual design can be shared without the private data
 * that fills it, and so a report refreshes by updating data alone.
 */
export function buildOverlayBundleHtml({ title, templateHtml, dataJson, metadata = {} }) {
  const bundleTitle = title || "actions.json overlay";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(bundleTitle)}</title>`,
    `<script type="application/json" data-overlay-metadata>${safeJsonForScript(metadata)}</script>`,
    `<script type="application/json" data-overlay-data>${safeJsonForScript(dataJson)}</script>`,
    "</head>",
    "<body>",
    templateHtml ?? "",
    "</body>",
    "</html>",
  ].join("\n");
}

// JSON embedded in a <script> block must not be able to close it. A payload
// containing "</script>" would otherwise end the block and let the remainder
// parse as markup.
function safeJsonForScript(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render a parsed overlay into a container, inside a sandboxed frame.
 *
 * The frame is the boundary: overlay content is agent-authored or
 * template-authored, and the embedding document is the host application. They
 * do not share a scripting context.
 */
export function renderOverlayDocument(container, parsed, { allowScripts = false, data, document: doc } = {}) {
  const ownerDocument = doc ?? container.ownerDocument ?? globalThis.document;
  container.textContent = "";

  const frame = ownerDocument.createElement("iframe");
  frame.dataset.overlayDocument = "true";
  frame.setAttribute("sandbox", sandboxFor({ allowScripts }));
  frame.setAttribute("title", parsed?.title || "actions.json overlay content");

  if (allowScripts) {
    frame.srcdoc = buildOverlayBundleHtml({
      title: parsed?.title,
      templateHtml: parsed?.body,
      dataJson: data ?? null,
    });
    container.appendChild(frame);
    return frame;
  }

  frame.srcdoc = buildOverlayArtifactHtml({ title: parsed?.title, parsed });
  container.appendChild(frame);
  return frame;
}

/**
 * The overlay surface: one live overlay at a time, addressed by id.
 *
 * Persistence and launcher registration are injected. In the extension they
 * are chrome.storage; in a served embed they are whatever that page provides.
 * Keeping them out is what makes this module portable, and passing no store at
 * all is legitimate — an overlay that is never persisted still renders.
 */
export class OverlaySurface {
  #document;
  #store;
  #templates;
  #parser;
  #openId = null;

  /**
   * @param templates  host-owned reviewed templates, id -> HTML. Supplied at
   *                   construction because a trust boundary a caller can move
   *                   is not a boundary.
   */
  constructor({ document: doc, store = null, templates = {}, parser = null } = {}) {
    this.#document = doc ?? globalThis.document;
    this.#store = store;
    this.#templates = new Map(Object.entries(templates));
    // Injectable so the trust boundary is testable without a DOM library.
    this.#parser = parser;
  }

  get openOverlayId() {
    return this.#openId;
  }

  /**
   * Open an overlay.
   *
   * `templateDriven` is NOT a caller flag. It was: `overlay.open` passed
   * arguments straight through, so an agent could declare its own
   * model-authored HTML a trusted scripted template and keep its scripts --
   * arbitrary script in the host page, from the least trusted input there is.
   * The docstring described a reviewed-template trust boundary that nothing
   * enforced.
   *
   * Scripts now require a `template_id` resolvable in the host-owned template
   * registry supplied at construction. Inline HTML is always scriptless,
   * whatever the caller says about it.
   */
  open({ html, title, width = 980, height = 760, template_id = null, data = null } = {}) {
    if (typeof html !== "string" || html.length === 0) {
      throw new TypeError("overlay.open requires html");
    }

    // One overlay at a time: the previous host is removed rather than stacked,
    // matching the extension's single-host element.
    this.close();

    // The ONLY path to scripts: a template the host registered, resolved
    // host-side. A caller-supplied id that is not registered is refused rather
    // than downgraded, so a typo cannot silently become an inline overlay
    // whose scripts were quietly stripped.
    let templateHtml = null;
    if (template_id !== null) {
      if (!this.#templates.has(template_id)) {
        throw new TypeError(`unknown template_id: ${template_id}`);
      }
      templateHtml = this.#templates.get(template_id);
    }
    const scripted = templateHtml !== null;
    const source = scripted ? templateHtml : html;
    const parsed = parseHtmlDocument(source, {
      preserveScripts: scripted,
      parser: this.#parser ?? undefined,
    });
    const overlayId = `overlay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const host = this.#document.createElement("div");
    host.id = OVERLAY_HOST_ID;
    host.dataset.overlayId = overlayId;
    host.dataset.width = String(Number(width) || 980);
    host.dataset.height = String(Number(height) || 760);

    const body = this.#document.createElement("div");
    body.className = "overlay-body";
    host.appendChild(body);

    renderOverlayDocument(body, parsed, {
      allowScripts: scripted,
      data,
      document: this.#document,
    });

    (this.#document.documentElement ?? this.#document.body).appendChild(host);
    this.#openId = overlayId;

    this.#store?.persist?.({ overlayId, title: title ?? parsed.title });

    return { overlay_id: overlayId, title: title ?? parsed.title ?? null };
  }

  close() {
    const existing = this.#document.getElementById(OVERLAY_HOST_ID);
    if (!existing) return { closed: false };
    const overlayId = existing.dataset.overlayId ?? null;
    existing.remove();
    this.#openId = null;
    return { closed: true, overlay_id: overlayId };
  }
}

/**
 * Register the overlay primitives against an EmbedHost registry.
 *
 * The signals a closed overlay emits are declared by the consuming
 * actions.json, not invented here — `emitSignal` applies its own ingestion
 * gate, so an overlay that closes while `overlay.closed` is undeclared or
 * disabled sends nothing.
 */
export function registerOverlayPrimitives(registry, surface, { host, signals = [] } = {}) {
  registry.register("overlay.open", async (args) => surface.open(args));
  registry.register("overlay.close", async () => {
    const result = surface.close();
    if (result.closed && host) {
      host.emitSignal("overlay.closed", { overlay_id: result.overlay_id }, { signals });
    }
    return result;
  });
  return registry;
}
