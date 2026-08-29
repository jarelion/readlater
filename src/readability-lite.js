/*
 * readability-lite.js
 * --------------------
 * Identical scoring logic to the firmware plugin and the browser extension.
 * Here it runs against a linkedom `document` (parseHTML(html).document)
 * instead of a real browser DOM — linkedom implements querySelectorAll,
 * textContent, parentElement, className, getAttribute, remove(), etc. to
 * the same surface, so this file is a straight copy, not a rewrite.
 */

const KILL_TAGS = ['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'form', 'button', 'input', 'select', 'textarea', 'svg', 'canvas', 'audio', 'video', 'nav', 'footer', 'header', 'aside', 'link', 'meta', 'label'];
const UNLIKELY_RE = /(?:^|[\s_-])(comment|sidebar|footer|footnote|masthead|related|share|social|newsletter|subscri|promo|advert|banner|popup|cookie|breadcrumb|pagination|nav|menu|widget|byline|tag-list|category|reply|discuss|author-box|site-header|site-footer|skip-link)(?:[\s_-]|$)/i;
const MAYBE_RE = /(?:^|[\s_-])(article|body|column|main|shadow|post|entry|story|content)(?:[\s_-]|$)/i;

function classAndId(el) {
  const cls = typeof el.className === 'string' ? el.className : el.className ? String(el.className) : '';
  return cls + ' ' + (el.id || '');
}

function pruneBoilerplate(root) {
  KILL_TAGS.forEach((t) => root.querySelectorAll(t).forEach((el) => el.remove()));
  Array.from(root.querySelectorAll('*')).forEach((el) => {
    if (el.tagName === 'BODY') return;
    const str = classAndId(el);
    if (!str.trim()) return;
    if (UNLIKELY_RE.test(str) && !MAYBE_RE.test(str)) el.remove();
  });
}

function scoreAndPickBest(root) {
  const scores = new Map();
  root.querySelectorAll('p, pre, td').forEach((p) => {
    const text = (p.textContent || '').trim();
    if (text.length < 25) return;
    const score = 1 + (text.match(/,/g) || []).length + Math.min(Math.floor(text.length / 100), 3);
    const parent = p.parentElement;
    const grandparent = parent ? parent.parentElement : null;
    if (parent) scores.set(parent, (scores.get(parent) || 0) + score);
    if (grandparent) scores.set(grandparent, (scores.get(grandparent) || 0) + score / 2);
  });
  let best = root;
  let bestAdjusted = -Infinity;
  scores.forEach((score, el) => {
    const text = el.textContent || '';
    if (text.length < 200) return;
    const linkChars = Array.from(el.querySelectorAll('a')).reduce((s, a) => s + (a.textContent || '').length, 0);
    const density = linkChars / Math.max(text.length, 1);
    const adjusted = score * (1 - Math.min(density, 0.8));
    if (adjusted > bestAdjusted) {
      bestAdjusted = adjusted;
      best = el;
    }
  });
  return best;
}

// Author detection — a gap the extension version had (local extraction
// always returned author:null there). Checked here before falling back.
function detectAuthor(doc) {
  const meta = doc.querySelector('meta[name="author"]') || doc.querySelector('meta[property="article:author"]');
  if (meta && meta.getAttribute('content')) return meta.getAttribute('content').trim();
  const relAuthor = doc.querySelector('[rel="author"]');
  if (relAuthor && relAuthor.textContent.trim()) return relAuthor.textContent.trim();
  const bylineEl = doc.querySelector('.byline, .author, [itemprop="author"], .post-author, .article-author');
  if (bylineEl && bylineEl.textContent.trim() && bylineEl.textContent.trim().length < 80) return bylineEl.textContent.trim();
  return null;
}

function extractNodes(elRoot, baseUrl, maxImages) {
  const nodes = [];
  const seenSrc = new Set();
  let imgCount = 0;
  const els = elRoot.querySelectorAll('p, h2, h3, h4, blockquote, li, img');
  els.forEach((el) => {
    if (el.tagName === 'IMG') {
      if (imgCount >= maxImages) return;
      const rawSrc = el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || '';
      if (!rawSrc) return;
      let abs;
      try {
