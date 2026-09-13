function renderHome() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Read Later \u2192 EPUB</title>
<style>
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 520px; margin: 40px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 22px; }
  input[type=text] { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #ccc; border-radius: 8px; font-size: 15px; margin-bottom: 10px; }
  button, .btn { display: inline-block; padding: 10px 16px; border: none; border-radius: 8px; background: #5b6bd6; color: #fff; font-size: 14px; cursor: pointer; text-decoration: none; }
  button.secondary { background: #eee; color: #222; }
  .row { display: flex; gap: 8px; margin-bottom: 10px; }
  .row input { flex: 1; margin-bottom: 0; }
  #queue { margin: 10px 0; }
  .qitem { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f2f2f2; font-size: 14px; }
  .qitem button { background: none; color: #b00; padding: 2px 6px; }
  #status { font-size: 13px; opacity: .75; min-height: 18px; }
  details { margin-top: 28px; }
  summary { cursor: pointer; font-weight: 600; }
  .hint { font-size: 12px; opacity: .6; }
</style>
</head>
<body>
  <h1>Read Later \u2192 EPUB</h1>
  <p class="hint">Paste an article URL to save it as an EPUB, or queue several and build one digest.</p>
  <p class="hint"><a href="/tools/epub-to-pdf/">Have an EPUB already? Convert it to a reMarkable-sized PDF \u2192</a></p>

  <div class="row">
    <input type="text" id="url" placeholder="https://example.com/some-article">
    <button id="save-now">Save now</button>
  </div>
  <button class="secondary" id="add-queue">Add to queue instead</button>

  <div id="queue"></div>
  <button id="build-digest">Build EPUB from queue + feeds</button>
  <div id="status"></div>

  <details>
    <summary>Settings & feeds</summary>
    <p class="hint">Same options as the extension: Instaparser fallback key, image handling, RSS/Atom feeds.</p>
    <div id="settings-body">Loading\u2026</div>
  </details>

<script>
const statusEl = document.getElementById('status');
function setStatus(t) { statusEl.textContent = t || ''; }

async function loadQueue() {
  const q = await fetch('/api/queue').then(r => r.json());
  const el = document.getElementById('queue');
  if (!q.length) { el.innerHTML = '<p class="hint">Queue is empty.</p>'; return; }
  el.innerHTML = '';
  q.forEach(item => {
    const row = document.createElement('div');
    row.className = 'qitem';
    row.innerHTML = '<span>' + (item.title || item.url) + '</span>';
    const btn = document.createElement('button');
    btn.textContent = '\u2715';
    btn.onclick = async () => {
      await fetch('/api/queue?url=' + encodeURIComponent(item.url), { method: 'DELETE' });
      loadQueue();
    };
    row.appendChild(btn);
    el.appendChild(row);
  });
}

document.getElementById('save-now').addEventListener('click', () => {
  const u = document.getElementById('url').value.trim();
  if (!u) return;
  setStatus('Building\u2026 this can take a few seconds.');
  window.location.href = '/api/save?url=' + encodeURIComponent(u);
  setTimeout(() => setStatus(''), 4000);
});

document.getElementById('add-queue').addEventListener('click', async () => {
  const u = document.getElementById('url').value.trim();
  if (!u) return;
  await fetch('/api/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u, title: u }) });
  document.getElementById('url').value = '';
  loadQueue();
});

document.getElementById('build-digest').addEventListener('click', async (e) => {
  e.preventDefault();
  setStatus('Building digest\u2026 this can take a while for several articles.');
  const resp = await fetch('/api/digest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!resp.ok) { const j = await resp.json().catch(() => ({})); setStatus('Failed: ' + (j.error || resp.status)); return; }
  const blob = await resp.blob();
  const disposition = resp.headers.get('Content-Disposition') || '';
  const m = disposition.match(/filename="([^"]+)"/);
  const filename = m ? m[1] : 'digest.epub';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  const logsHeader = resp.headers.get('X-Build-Logs');
  setStatus('Saved: ' + filename + (logsHeader ? ' \u2014 see console for build log' : ''));
  if (logsHeader) { try { console.log(JSON.parse(decodeURIComponent(logsHeader)).join('\\n')); } catch (e) {} }
  loadQueue();
});

async function loadSettings() {
  const cfg = await fetch('/api/config').then(r => r.json());
  const body = document.getElementById('settings-body');
  body.innerHTML =
    '<div class="row"><input type="text" id="cfg-apikey" placeholder="Instaparser API key (optional)" value="' + (cfg.apiKey || '') + '"></div>' +
    '<div class="row"><input type="text" id="cfg-feed" placeholder="Add RSS/Atom feed URL"><button id="cfg-add-feed">Add</button></div>' +
    '<div id="cfg-feeds"></div>' +
    '<button id="cfg-save">Save settings</button>';
  renderFeeds(cfg.feeds || []);

  function renderFeeds(feeds) {
    const el = document.getElementById('cfg-feeds');
    el.innerHTML = feeds.length ? '' : '<p class="hint">No feeds yet.</p>';
    feeds.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'qitem';
      row.innerHTML = '<span>' + f.url + '</span>';
      const btn = document.createElement('button');
      btn.textContent = '\u2715';
      btn.onclick = () => { feeds.splice(i, 1); renderFeeds(feeds); };
      row.appendChild(btn);
      el.appendChild(row);
    });
    document.getElementById('cfg-add-feed').onclick = () => {
      const u = document.getElementById('cfg-feed').value.trim();
      if (!u) return;
      feeds.push({ url: u, max: 5 });
      document.getElementById('cfg-feed').value = '';
      renderFeeds(feeds);
    };
    document.getElementById('cfg-save').onclick = async () => {
      cfg.apiKey = document.getElementById('cfg-apikey').value.trim();
      cfg.feeds = feeds;
      await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      setStatus('Settings saved.');
    };
  }
}

loadQueue();
loadSettings();
</script>
</body>
</html>`;
}

module.exports = { renderHome };
