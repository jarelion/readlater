const { getArticle, fetchText } = require('./extract');
const { parseFeed } = require('./feed');
const { processImage, cropToCover } = require('./images');
const { buildEpub } = require('./epub');
const { renderHome } = require('./webapp');

const DEFAULT_CFG = {
  apiKey: '',
  maxArticles: 15,
  feeds: [], // [{url, max}]
  includeImages: true,
  maxImagesPerArticle: 3,
  grayscale: true,
  imageMaxWidth: 800,
  coverWidth: 800,
  coverHeight: 1200
};
const MAX_SEEN = 500;
const MAX_COVER_CANDIDATES = 12;

async function getCfg(env) {
  const raw = await env.RLE_KV.get('cfg', 'json');
  return Object.assign({}, DEFAULT_CFG, raw || {});
}
async function getSeen(env) {
  return (await env.RLE_KV.get('seen', 'json')) || [];
}
async function saveSeen(env, seen) {
  await env.RLE_KV.put('seen', JSON.stringify(seen.slice(-MAX_SEEN)));
}
async function getQueue(env) {
  return (await env.RLE_KV.get('queue', 'json')) || [];
}
async function saveQueue(env, queue) {
  await env.RLE_KV.put('queue', JSON.stringify(queue));
}

function safeFilename(s) {
  return (
    String(s || 'digest')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim()
      .slice(0, 80) || 'digest'
  );
}

async function embedImages(articles, cfg, log) {
  const coverCandidates = [];
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const id = 'chap' + (i + 1);
    let imgIndex = 0;
    const newNodes = [];
    for (const n of a.nodes || []) {
      if (n.type !== 'img') {
        newNodes.push(n);
        continue;
      }
      try {
        log('  Fetching image: ' + n.src);
        const r = await fetch(n.src);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const raw = new Uint8Array(await r.arrayBuffer());
        const bytes = await processImage(raw, cfg.imageMaxWidth, cfg.grayscale !== false);
        imgIndex++;
        const file = 'images/' + id + '-img' + imgIndex + '.jpg';
        newNodes.push({ type: 'img', file, bytes, alt: n.alt });
        if (coverCandidates.length < MAX_COVER_CANDIDATES) coverCandidates.push({ bytes, articleTitle: a.title });
      } catch (e) {
        log('  Skipped image (' + e.message + '): ' + n.src);
      }
    }
    a.nodes = newNodes;
  }
  return coverCandidates;
}

// The core pipeline — same shape as the extension's runDigest(), fetch()
// standing in for the device relay, KV standing in for the SD card.
async function runDigest(env, opts, log) {
  const cfg = await getCfg(env);
  let seen = await getSeen(env);
  const state = { instaparserBlocked: false };

  let queue = (opts.manualUrls || []).map((u) => ({ url: u.url || u, title: u.title || null }));

  if (opts.useFeeds !== false) {
    for (const feed of cfg.feeds) {
      try {
        log('Reading feed: ' + feed.url);
        const xml = await fetchText(feed.url);
        const items = parseFeed(xml, feed.max || 5);
        let added = 0;
        for (const it of items) {
          if (!opts.includeSeen && seen.indexOf(it.link) !== -1) continue;
          queue.push({ url: it.link, title: it.title });
          added++;
        }
        log('  ' + added + ' new item(s) from this feed');
      } catch (e) {
        log('Feed failed (' + feed.url + '): ' + e.message);
      }
    }
  }

  const dedup = new Set();
  queue = queue.filter((q) => (dedup.has(q.url) ? false : (dedup.add(q.url), true)));
  const cap = cfg.maxArticles || 15;
  if (queue.length > cap) {
    log('Capping to ' + cap + ' of ' + queue.length + ' queued articles');
    queue = queue.slice(0, cap);
  }
  if (!queue.length) throw new Error('nothing to build — add a URL or an RSS feed with new items');

  const articles = [];
  for (const item of queue) {
    log('Fetching: ' + item.url);
    try {
      const a = await getArticle(item.url, cfg, state, log);
      if (!a.nodes || !a.nodes.length) throw new Error('no readable content found');
      articles.push({ title: (a.title || item.title || item.url).trim(), author: a.author, source: item.url, nodes: a.nodes });
      seen.push(item.url);
    } catch (e) {
      log('Skipped (failed to fetch/parse): ' + item.url + ' \u2014 ' + e.message);
    }
  }
  if (!articles.length) throw new Error('every queued article failed to fetch or parse');

  const bookTitle = opts.bookTitle || 'Read Later - ' + new Date().toISOString().slice(0, 10);
  log('Fetching and processing images...');
  const coverCandidates = await embedImages(articles, cfg, log);

  let cover = null;
  if (coverCandidates.length) {
    try {
      const bytes = await cropToCover(coverCandidates[0].bytes, cfg.coverWidth, cfg.coverHeight, cfg.grayscale !== false);
      cover = { bytes };
    } catch (e) {
      log('Could not prepare the cover image (' + e.message + '), continuing without one');
    }
  }

  log('Building EPUB from ' + articles.length + ' article(s)...');
  const bytes = await buildEpub(articles, bookTitle, cover);
  await saveSeen(env, seen);
  const filename = safeFilename(bookTitle) + '.epub';
  return { bytes, filename, count: articles.length };
}

function epubResponse(bytes, filename) {
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': 'attachment; filename="' + filename.replace(/"/g, '') + '"',
      'Cache-Control': 'no-store'
    }
  });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const logs = [];
    const log = (m) => logs.push(m);

    try {
      if (url.pathname === '/' && request.method === 'GET') {
        return new Response(renderHome(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // GET /api/save?url=https://...&title=optional
      // The single-URL path — what the iOS Shortcut and the webapp's "paste
      // a URL" box both hit.
      if (url.pathname === '/api/save' && request.method === 'GET') {
        const target = url.searchParams.get('url');
        if (!target) return jsonResponse({ error: 'missing ?url=' }, 400);
        const cfg = await getCfg(env);
        const state = { instaparserBlocked: false };
        const a = await getArticle(target, cfg, state, log);
        if (!a.nodes || !a.nodes.length) return jsonResponse({ error: 'no readable content found', logs }, 422);
        const articles = [{ title: (a.title || target).trim(), author: a.author, source: target, nodes: a.nodes }];
        const coverCandidates = await embedImages(articles, cfg, log);
        let cover = null;
        if (coverCandidates.length) {
          const bytes = await cropToCover(coverCandidates[0].bytes, cfg.coverWidth, cfg.coverHeight, cfg.grayscale !== false);
          cover = { bytes };
        }
        const bookTitle = url.searchParams.get('title') || articles[0].title;
        const bytes = await buildEpub(articles, bookTitle, cover);
        return epubResponse(bytes, safeFilename(bookTitle) + '.epub');
      }

      // GET/PUT /api/config — settings + feeds, same shape as the extension's options page
      if (url.pathname === '/api/config' && request.method === 'GET') {
        return jsonResponse(await getCfg(env));
      }
      if (url.pathname === '/api/config' && request.method === 'PUT') {
        const body = await request.json();
        const cfg = Object.assign({}, DEFAULT_CFG, body);
        await env.RLE_KV.put('cfg', JSON.stringify(cfg));
        return jsonResponse({ ok: true, cfg });
      }

      // GET /api/queue, POST /api/queue {url,title}, DELETE /api/queue?url=...
      if (url.pathname === '/api/queue' && request.method === 'GET') {
        return jsonResponse(await getQueue(env));
      }
      if (url.pathname === '/api/queue' && request.method === 'POST') {
        const item = await request.json();
        const queue = await getQueue(env);
        if (!queue.some((q) => q.url === item.url)) queue.push(item);
        await saveQueue(env, queue);
        return jsonResponse(queue);
      }
      if (url.pathname === '/api/queue' && request.method === 'DELETE') {
        const target = url.searchParams.get('url');
        let queue = await getQueue(env);
        queue = queue.filter((q) => q.url !== target);
        await saveQueue(env, queue);
        return jsonResponse(queue);
      }

      // POST /api/digest — build from the queue + feeds right now, return the EPUB
      if (url.pathname === '/api/digest' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const queue = await getQueue(env);
        const result = await runDigest(env, { manualUrls: queue, useFeeds: true, bookTitle: body.bookTitle }, log);
        await saveQueue(env, []);
        return epubResponse(result.bytes, result.filename);
      }

      // GET /api/latest — fetch the most recent cron-built digest (see scheduled(), below)
      if (url.pathname === '/api/latest' && request.method === 'GET') {
        const raw = await env.RLE_KV.get('latest-digest', 'json');
        if (!raw) return jsonResponse({ error: 'no automatic digest has run yet' }, 404);
        const bytes = Uint8Array.from(atob(raw.bytesB64), (c) => c.charCodeAt(0));
        return epubResponse(bytes, raw.filename);
      }

      return jsonResponse({ error: 'not found' }, 404);
    } catch (e) {
      return jsonResponse({ error: e && e.message ? e.message : String(e), logs }, 500);
    }
  },

  // Cron trigger (see wrangler.toml [triggers]). No HTTP requester to stream
  // the file back to, so this builds and stores the result in KV for later
  // pickup via GET /api/latest (e.g. an iOS Shortcut run each morning).
  async scheduled(event, env, ctx) {
    const logs = [];
    const log = (m) => logs.push(m);
    try {
      const result = await runDigest(env, { useFeeds: true }, log);
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < result.bytes.length; i += chunk) bin += String.fromCharCode.apply(null, result.bytes.subarray(i, i + chunk));
      await env.RLE_KV.put(
        'latest-digest',
        JSON.stringify({ bytesB64: btoa(bin), filename: result.filename, builtAt: new Date().toISOString(), count: result.count })
      );
    } catch (e) {
      await env.RLE_KV.put('latest-digest-error', JSON.stringify({ error: e.message, at: new Date().toISOString() }));
    }
  }
};
