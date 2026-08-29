const { parseHTML } = require('linkedom');
const { extractReadable, extractNodes, nodeTextLength } = require('./readability-lite');

const INSTAPARSER_URL = 'https://instaparser.com/api/1/article';

async function fetchText(url) {
  // Some sites' bot-protection (Vox Media's, notably) blocks a
  // self-identifying User-Agent outright, even for a plain public-page
  // request. A realistic browser UA + standard Accept headers gets treated
  // like any other reader's request instead of getting blocked at the edge.
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

function extractLocally(html, url, maxImages) {
  const { document } = parseHTML(html);
  return extractReadable(document, url, maxImages);
}

async function parseWithInstaparser(url, apiKey, maxImages, state) {
  if (!apiKey) throw new Error('no Instaparser API key configured');
  if (state.instaparserBlocked) throw new Error('rate-limited earlier this run, not retrying');
  const resp = await fetch(INSTAPARSER_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, output: 'html', use_cache: true })
  });
  if (resp.status === 429) {
    state.instaparserBlocked = true;
    throw new Error('rate limited (429), skipping it for the rest of this build');
  }
  if (!resp.ok) {
    let reason = 'HTTP ' + resp.status;
    try {
      reason = (await resp.json()).reason || reason;
    } catch (e) {}
    throw new Error('Instaparser ' + reason);
  }
  const data = await resp.json();
  const html = data.html || data.body || '';
  const canonicalUrl = data.url || url;
  const { document } = parseHTML('<body>' + html + '</body>');
  const nodes = extractNodes(document.body, canonicalUrl, maxImages);
  return { title: data.title || null, author: data.author || null, nodes };
}

// Local extraction first (no cost, no rate limit); Instaparser only as a
// fallback when local extraction comes up thin. Same order and thresholds
// as the firmware plugin / extension.
async function getArticle(url, cfg, state, log) {
  const maxImages = cfg.includeImages ? cfg.maxImagesPerArticle : 0;
  let local = null;
  let localErr = null;
  try {
    const html = await fetchText(url);
    local = extractLocally(html, url, maxImages);
  } catch (e) {
    localErr = e;
  }
  const localLen = local ? nodeTextLength(local.nodes) : 0;
  if (local && localLen > 200) return local;

  if (cfg.apiKey) {
    try {
      log((local ? 'Local extraction was thin (' + localLen + ' chars), trying' : 'Local fetch failed, trying') + ' Instaparser: ' + url);
      const viaApi = await parseWithInstaparser(url, cfg.apiKey, maxImages, state);
      if (nodeTextLength(viaApi.nodes) > 80) return viaApi;
      log('Instaparser also came back thin for: ' + url);
    } catch (e) {
      log('Instaparser fallback failed (' + e.message + '): ' + url);
    }
  } else if (!localErr) {
    // No API key configured, so there's no fallback to try — log exactly
    // what local extraction saw, since this is otherwise a silent failure:
    // a 200 response with no usable article content (a bot-check/JS-challenge
    // page, a paywall interstitial, or a client-rendered page with no
    // server-side HTML) looks identical to "nothing went wrong" from here.
    log('Local extraction found only ' + localLen + ' char(s) of text (no Instaparser key configured to fall back to): ' + url);
  }

  if (local && local.nodes && local.nodes.length) return local;
  if (localErr) throw localErr;
  throw new Error('no readable content found');
}

module.exports = { getArticle, fetchText };
