const JSZip = require('jszip');

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// n.html carries preserved inline <b>/<i>/<a>/etc from readability-lite's
// inlineHtml(); n.text is the plain-text fallback used to build it, kept
// for length checks. chapterTitle is used to suppress a figcaption that
// just repeats the article's own headline (a real, observed output flaw —
// some sites set an image's alt text to the post title).
function nodeToXhtml(n, chapterTitle) {
  if (n.type === 'img') {
    const alt = escapeHtml(n.alt || '');
    const isDupe = n.alt && chapterTitle && normalize(n.alt) === normalize(chapterTitle);
    const caption = n.alt && !isDupe ? '<figcaption>' + escapeHtml(n.alt) + '</figcaption>' : '';
    return '<figure><img src="' + n.file + '" alt="' + alt + '"/>' + caption + '</figure>';
  }
  const body = (n.html || escapeHtml(n.text)).replace(/\n/g, '<br/>');
  if (n.type === 'blockquote') return '<blockquote><p>' + body + '</p></blockquote>';
  if (n.type === 'li') return '<p>' + body + '</p>';
  return '<' + n.type + '>' + body + '</' + n.type + '>';
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return 'Other sources';
  }
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

// articles: [{title, author, source, publishedAt, nodes}], cover: null | {bytes}
async function buildEpub(articles, bookTitle, cover) {
  const zip = new JSZip();
  const uid = 'urn:uuid:' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random());
  const now = new Date().toISOString();

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
      '</container>'
  );
  zip.file(
    'OEBPS/style.css',
    'body{font-family:serif;line-height:1.4;margin:1em;}' +
      'h1{font-size:1.3em;margin-bottom:.1em;}' +
      '.byline{opacity:.7;font-size:.85em;margin-top:0;margin-bottom:1.2em;}' +
      'p{margin:0 0 .8em 0;}' +
      'blockquote{margin:0 0 .8em 1.2em;font-style:italic;}' +
      'figure{margin:1em 0;text-align:center;}' +
      'figure img{max-width:100%;height:auto;}' +
      'figcaption{font-size:.8em;opacity:.7;margin-top:.3em;}' +
      'body.cover{margin:0;text-align:center;}' +
      'body.cover img{max-width:100%;height:100%;}' +
      '.sources h2{font-size:1em;opacity:.8;margin-bottom:.2em;}' +
      '.sources ul{margin-top:0;padding-left:1.2em;}' +
      '.sources li{font-size:.85em;word-break:break-all;margin-bottom:.4em;}'
  );

  const manifestItems = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="style.css" media-type="text/css"/>'
  ];
  const spineItems = [];
  const navPoints = [];
  const navLis = [];
  let coverMeta = '';

  if (cover) {
    zip.file('OEBPS/images/cover.jpg', cover.bytes);
    zip.file(
      'OEBPS/cover.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
        '<head><meta charset="utf-8"/><title>' +
        escapeHtml(bookTitle) +
        '</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n' +
        '<body class="cover"><div epub:type="cover"><img src="images/cover.jpg" alt="Cover"/></div></body></html>'
    );
    manifestItems.push('<item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
    manifestItems.push('<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>');
    spineItems.push('<itemref idref="cover" linear="yes"/>');
    coverMeta = '<meta name="cover" content="cover-image"/>\n';
  }

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const id = 'chap' + (i + 1);
    const file = id + '.xhtml';
    const title = escapeHtml(a.title || 'Untitled');
    const bylineParts = [];
    if (a.author) bylineParts.push(escapeHtml(a.author));
    const dateStr = formatDate(a.publishedAt);
    if (dateStr) bylineParts.push(dateStr);
    const byline = bylineParts.join(' \u00b7 ');

    const bodyParts = [];
    let imgIndex = 0;
    for (const n of a.nodes || []) {
      if (n.type === 'img') {
        imgIndex++;
        zip.file('OEBPS/' + n.file, n.bytes);
        manifestItems.push('<item id="' + id + 'img' + imgIndex + '" href="' + n.file + '" media-type="image/jpeg"/>');
      }
      bodyParts.push(nodeToXhtml(n, a.title));
    }
    const bodyHtml = bodyParts.join('\n') || '<p><em>(no readable content found)</em></p>';

    zip.file(
      'OEBPS/' + file,
      '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml">\n' +
        '<head><meta charset="utf-8"/><title>' +
        title +
        '</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n' +
        '<body>\n<h1>' +
        title +
        '</h1>\n' +
        (byline ? '<p class="byline">' + byline + '</p>\n' : '') +
        bodyHtml +
        '\n</body>\n</html>'
    );
    manifestItems.push('<item id="' + id + '" href="' + file + '" media-type="application/xhtml+xml"/>');
    spineItems.push('<itemref idref="' + id + '"/>');
    navPoints.push(
      '<navPoint id="np' +
        (i + 1) +
        '" playOrder="' +
        (i + 1) +
        '"><navLabel><text>' +
        title +
        '</text></navLabel><content src="' +
        file +
        '"/></navPoint>'
    );
    navLis.push('<li><a href="' + file + '">' + title + '</a></li>');
  }

  const byHost = new Map();
  articles.forEach((a) => {
    const host = hostnameOf(a.source);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(a);
  });
  let sourcesBody = '';
  byHost.forEach((arts, host) => {
    sourcesBody +=
      '<section><h2>' +
      escapeHtml(host) +
      '</h2><ul>' +
      arts.map((a) => '<li><a href="' + escapeHtml(a.source) + '">' + escapeHtml(a.title || a.source) + '</a></li>').join('') +
      '</ul></section>\n';
  });
  zip.file(
    'OEBPS/sources.xhtml',
    '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml">\n' +
      '<head><meta charset="utf-8"/><title>Sources</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n' +
      '<body class="sources">\n<h1>Sources</h1>\n' +
      sourcesBody +
      '</body>\n</html>'
  );
  manifestItems.push('<item id="sources" href="sources.xhtml" media-type="application/xhtml+xml"/>');
  spineItems.push('<itemref idref="sources"/>');
  navPoints.push(
    '<navPoint id="npsources" playOrder="' + (articles.length + 1) + '"><navLabel><text>Sources</text></navLabel><content src="sources.xhtml"/></navPoint>'
  );
  navLis.push('<li><a href="sources.xhtml">Sources</a></li>');

  zip.file(
    'OEBPS/nav.xhtml',
    '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
      '<head><meta charset="utf-8"/><title>Contents</title></head>\n' +
      '<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>\n' +
      navLis.join('\n') +
      '\n</ol></nav></body></html>'
  );
  zip.file(
    'OEBPS/toc.ncx',
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
      '<head><meta name="dtb:uid" content="' +
      uid +
      '"/></head>\n' +
      '<docTitle><text>' +
      escapeHtml(bookTitle) +
      '</text></docTitle>\n' +
      '<navMap>\n' +
      navPoints.join('\n') +
      '\n</navMap></ncx>'
  );
  zip.file(
    'OEBPS/content.opf',
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '<dc:identifier id="bookid">' +
      uid +
      '</dc:identifier>\n' +
      '<dc:title>' +
      escapeHtml(bookTitle) +
      '</dc:title>\n' +
      '<dc:language>en</dc:language>\n' +
      '<dc:creator>Read Later Digest</dc:creator>\n' +
      '<meta property="dcterms:modified">' +
      now.replace(/\.\d+Z$/, 'Z') +
      '</meta>\n' +
      coverMeta +
      '</metadata>\n' +
      '<manifest>\n' +
      manifestItems.join('\n') +
      '\n</manifest>\n' +
      '<spine toc="ncx">\n' +
      spineItems.join('\n') +
      '\n</spine>\n' +
      '</package>'
  );

  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return bytes;
}

module.exports = { buildEpub };
