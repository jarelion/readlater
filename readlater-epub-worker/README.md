# Read Later → EPUB (Cloudflare Worker)

Same pipeline as the firmware plugin and the browser extension — local
readability-style extraction, Instaparser fallback, image resize/grayscale/
cover-crop, RSS/Atom dedup — running as a Cloudflare Worker instead of on
your CrossPoint device or in a browser. This is what makes it reachable
from an iPhone.

## Deploy

```sh
npm install
npx wrangler login
npx wrangler kv namespace create RLE_KV
# paste the id it prints into wrangler.toml's kv_namespaces entry
npx wrangler deploy
```

That gives you a URL like `https://readlater-epub.<your-subdomain>.workers.dev`.

Open it in a browser — that's the webapp (paste a URL, save, or build a
digest from your feeds). Add feeds and an optional Instaparser key under
"Settings & feeds" on that same page.

## Use it from an iPhone

Extensions (the browser one from before) don't run in iOS Safari without a
paid Apple Developer account and Xcode packaging. The Worker sidesteps that
entirely — it's just a URL. Two ways to use it from an iPhone:

1. **Open the Worker's URL directly** in Safari and paste articles in —
   works exactly like the desktop webapp, no install.
2. **An iOS Shortcut, for a real share-sheet flow:**
   - Shortcuts app → **+** → add action **Get Contents of URL**
   - URL: `https://readlater-epub.<you>.workers.dev/api/save?url=` +
     (insert the **Shortcut Input** variable right after `url=`)
   - Method: GET
   - Add action **Save File** (or **Quick Look**) on the result
   - In the shortcut's settings, turn on **"Use with Share Sheet"**,
     restrict input types to **URLs**
   - Now: in Safari, tap Share → your shortcut → it saves the EPUB
     straight to Files (from where the Books app can open it)

## Routes

| Route | What it does |
|---|---|
| `GET /` | The webapp — paste a URL, manage the queue, edit settings/feeds |
| `GET /api/save?url=...&title=...` | Build and download a single-article EPUB — what the iOS Shortcut hits |
| `GET/POST/DELETE /api/queue` | A persisted "save for later" list, same idea as the extension's queue |
| `POST /api/digest` | Build one EPUB from the queue + all feeds' new items, download it |
| `GET/PUT /api/config` | Settings + feeds, as JSON |
| `GET /api/latest` | Fetch the most recent **automatic** digest (see below) |

## Automatic digest (optional)

Uncomment the `[triggers]` block in `wrangler.toml` and redeploy to have the
Worker build a digest from your feeds on a schedule (cron syntax, UTC),
even with nothing open anywhere. It has nowhere to stream the finished file
to on its own, so it stores the result in KV; `GET /api/latest` fetches
whatever the most recent scheduled run produced — point the same iOS
Shortcut idea at that URL (no `?url=` needed) for a "check every morning"
routine.

## What's been tested here, and what to verify on your end

I ran this through `wrangler dev` in the sandbox I built it in, which
confirmed: every module loads and bundles cleanly, the Worker boots with
the KV binding, the webapp and `/api/config` routes serve correctly, and
outbound `fetch()` from inside the Worker reaches real sites and gets as
far as the extraction step. That sandbox's network is locked to an
allowlist of a few dozen domains (fine for `npm install`, not for fetching
arbitrary articles), and a couple of my live-fetch tests against sites
outside that allowlist hung or dropped the connection rather than actually
exercising the pipeline end-to-end — I could see the request logged but
not confirm what came back. One real bug did turn up this way: linkedom
chokes on a response that isn't real HTML (a plain-text file, for
instance), which I've guarded against, but I haven't been able to hammer
this on a wide variety of live articles.

**Worth doing on your first run:** `npx wrangler dev` locally (full
internet access from your machine) and try `/api/save?url=...` against a
few real articles — a text-heavy one, one with lots of images, and
something behind a lighter paywall — before wiring up the iOS Shortcut.
The image pipeline (`@cf-wasm/photon`) in particular I could only confirm
against the documented API, not a live resize/grayscale/crop through the
actual WASM binary — if `src/images.js` throws on your first real image,
that's the most likely spot, and the error will point at exactly which
Photon call misbehaved.

## Files

```
wrangler.toml         Worker config — KV binding, optional cron trigger
src/index.js           Routes, KV-backed config/queue/seen-list, digest pipeline
src/webapp.js           The single-page HTML/JS front end, served by the Worker itself
src/extract.js          fetch() + local extraction + Instaparser fallback (getArticle equivalent)
src/readability-lite.js Extraction scoring — ported from the extension, plus two fixes:
                          author detection, and inline formatting (bold/italic/links)
                          preserved instead of flattened to plain text
src/feed.js              RSS/Atom parsing (regex-based — more robust than an XML parser
                          across real-world feeds' namespace quirks)
src/images.js            Resize/grayscale/cover-crop via @cf-wasm/photon (WASM; Workers
                          have no <canvas>)
src/epub.js              EPUB (OPF/NCX/XHTML) assembly, plus two output fixes: suppresses
                          a figcaption that just repeats the article's own headline, and
                          shows a published date under the byline when known
```

## Differences from the extension's output, on purpose

Two of the output-quality issues you flagged from the `zenFEED_8_28.epub`
review are fixed here (inline formatting, redundant hero captions, author
detection) — they're not yet ported back to the browser extension. Say the
word if you'd like those backported.
