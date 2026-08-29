/*
 * feed.js
 * -------
 * Minimal RSS/Atom item extraction. Deliberately regex-based rather than a
 * full XML parser: Workers' HTML-oriented DOM shims (linkedom included)
 * aren't reliable in strict XML mode across every feed's namespace quirks,
 * and feed items are simple/flat enough that this is robust in practice.
 */

function tagText(block, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = block.match(re);
  if (!m) return '';
  return m[1]
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

function atomLinkHref(block) {
  // Prefer rel="alternate" or an unmarked <link href="...">; fall back to
  // the first <link> tag found.
  const matches = Array.from(block.matchAll(/<link\b([^>]*)\/?>(?:<\/link>)?/gi));
  for (const m of matches) {
    const attrs = m[1];
    if (/rel\s*=\s*["']alternate["']/i.test(attrs) || !/rel\s*=/i.test(attrs)) {
      const hrefM = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
      if (hrefM) return hrefM[1];
    }
  }
  if (matches.length) {
    const hrefM = matches[0][1].match(/href\s*=\s*["']([^"']+)["']/i);
    if (hrefM) return hrefM[1];
  }
  return '';
}

function parseFeed(xml, max) {
  const rssItems = Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)).map((m) => m[0]);
  let items;
  if (rssItems.length) {
    items = rssItems.map((block) => ({
      title: tagText(block, 'title'),
      link: tagText(block, 'link') || tagText(block, 'guid'),
      pubDate: tagText(block, 'pubDate')
    }));
  } else {
    const entries = Array.from(xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)).map((m) => m[0]);
    items = entries.map((block) => ({
      title: tagText(block, 'title'),
      link: atomLinkHref(block),
      pubDate: tagText(block, 'updated') || tagText(block, 'published')
    }));
  }
  return items.filter((i) => i.link).slice(0, max);
}

module.exports = { parseFeed };
