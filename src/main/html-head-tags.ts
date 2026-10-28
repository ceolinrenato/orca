// Tag scans only move forward: rescanning from every unclosed opener is quadratic on
// a malformed page, and this parse blocks the main or runtime event loop.

/** Attributes of each `<tagName ...>` in document order; stops at the first unclosed tag. */
export function* htmlTagAttributes(html: string, tagName: string): Generator<Map<string, string>> {
  const open = new RegExp(`<${tagName}\\b`, 'gi')
  while (open.test(html)) {
    const end = html.indexOf('>', open.lastIndex)
    if (end === -1) {
      return
    }
    const tag = html.slice(open.lastIndex, end)
    open.lastIndex = end + 1
    const attributes = new Map<string, string>()
    // Names start after whitespace so a long unquoted run cannot backtrack from every offset.
    for (const [, name, double, single, bare] of tag.matchAll(
      /(?:^|\s)([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
    )) {
      attributes.set(name.toLowerCase(), double ?? single ?? bare ?? '')
    }
    yield attributes
  }
}

export function extractHtmlTitle(html: string): string | null {
  const open = /<title\b/gi
  if (!open.test(html)) {
    return null
  }
  const tagEnd = html.indexOf('>', open.lastIndex)
  if (tagEnd === -1) {
    return null
  }
  const close = /<\/title>/gi
  close.lastIndex = tagEnd + 1
  const end = close.exec(html)
  if (!end) {
    return null
  }
  return normalizeHtmlText(html.slice(tagEnd + 1, end.index)) || null
}

export function findIconHref(html: string): string | null {
  for (const attributes of htmlTagAttributes(html, 'link')) {
    const rel = attributes.get('rel')?.toLowerCase().split(/\s+/) ?? []
    const href = attributes.get('href')
    if (rel.includes('icon') && href) {
      return decodeHtmlEntities(href)
    }
  }
  return null
}

/** Decodes entities and collapses whitespace, as a browser shows the text. */
export function normalizeHtmlText(text: string): string {
  return decodeHtmlEntities(text).replace(/\s+/g, ' ').trim()
}

export function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity
    }
    return named[body.toLowerCase()] ?? entity
  })
}
