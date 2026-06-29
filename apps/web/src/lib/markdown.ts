import DOMPurify from "dompurify";
import { marked } from "marked";

// Tight, GFM-friendly Markdown. Avoid full HTML pass-through (we sanitize
// below) — the synthesizer prompt restricts output to headings/bullets/bold/
// code, so we don't need the heavy GFM extensions.
marked.setOptions({
  gfm: true,
  breaks: false,
});

/**
 * Render untrusted Markdown (from the LLM synthesizer) to sanitized HTML
 * safe to inject via {@html …} in Svelte. Strips scripts, iframes,
 * event handlers, and any non-allowlist tag/attribute.
 */
export function renderMarkdown(input: string): string {
  const raw = marked.parse(input ?? "", { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "br",
      "hr",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "span",
      "em",
      "strong",
      "del",
      "a",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    ALLOWED_ATTR: ["href", "title", "target", "rel"],
    ALLOW_DATA_ATTR: false,
  });
}
