/**
 * Minimal, dependency-free, XSS-safe Markdown renderer for community + channel
 * descriptions.
 *
 * Security model: the ENTIRE input is HTML-escaped FIRST, then a small
 * whitelist of transforms is applied to the already-escaped text. Because
 * escaping happens before any transform runs, no attacker-controlled `<`, `>`
 * or quote can ever reach the DOM as markup — the only tags that survive are
 * the ones this file itself emits, all with fixed, safe attributes. Links are
 * restricted to http/https; every other scheme is left as inert escaped text.
 *
 * This is deliberately NOT a full CommonMark parser. It handles bold, italic,
 * inline code, safe links, hard line breaks and simple `- ` bullet lists — the
 * subset useful for short descriptions. (Known minor limitation: `*`/`_` inside
 * inline code can still be styled; this never affects safety.)
 */

/** Escape every HTML-significant character. Runs before any transform. */
function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Apply inline marks to an already-escaped fragment. */
function renderInline(escaped: string): string {
  let out = escaped
  // [text](http(s)://url) — only http/https; other schemes fall through as text.
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, text: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-gold underline">${text}</a>`,
  )
  // `inline code`
  out = out.replace(
    /`([^`]+)`/g,
    '<code class="bg-overlay rounded px-1 font-mono text-[0.9em]">$1</code>',
  )
  // **bold** (must run before italic so `**` is consumed first)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // *italic* / _italic_
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  out = out.replace(/_([^_]+)_/g, '<em>$1</em>')
  return out
}

/** Escape, then group lines into paragraphs and bullet lists. */
export function renderMarkdown(input: string): string {
  const lines = escapeHtml(input).split(/\r?\n/)
  const out: string[] = []
  let paragraph: string[] = []
  let list: string[] = []

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.join('<br>')}</p>`)
      paragraph = []
    }
  }
  const flushList = () => {
    if (list.length > 0) {
      out.push(`<ul class="list-disc pl-5">${list.map((li) => `<li>${li}</li>`).join('')}</ul>`)
      list = []
    }
  }

  for (const line of lines) {
    const bullet = /^\s*-\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      list.push(renderInline(bullet[1] ?? ''))
    } else if (line.trim() === '') {
      flushParagraph()
      flushList()
    } else {
      flushList()
      paragraph.push(renderInline(line))
    }
  }
  flushParagraph()
  flushList()
  return out.join('')
}

/** Render sanitized Markdown. Safe: `html` is escaped before any transform. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = renderMarkdown(text)
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: input is HTML-escaped in renderMarkdown before any markup is emitted; only whitelisted tags with fixed attributes survive.
    <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
  )
}
