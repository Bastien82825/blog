/* 前台與後台共用的小工具、計數與互動區資料層 */
window.Blog = (() => {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmt(iso, withTime = true) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}` + (withTime ? ` ${p(d.getHours())}:${p(d.getMinutes())}` : '');
  }

  /* 從各種 YouTube 網址取出影片 ID */
  function ytId(url) {
    try {
      const u = new URL(String(url).trim());
      const h = u.hostname.replace(/^(www|m|music)\./, '');
      const clean = (s) => ((s || '').match(/^[\w-]{11}/) || [])[0] || null;
      if (h === 'youtu.be') return clean(u.pathname.slice(1));
      if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
        if (u.searchParams.get('v')) return clean(u.searchParams.get('v'));
        const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
        if (m) return m[2];
      }
    } catch (e) {}
    return null;
  }

  async function getJSON(path) {
    const r = await fetch(path, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  }
  async function getText(path) {
    const r = await fetch(path, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.text();
  }

  /* 關鍵字清單：先照自訂順序，其餘依文章數 */
  function tagList(posts, order = []) {
    const count = {};
    posts.forEach((p) => (p.tags || []).forEach((t) => (count[t] = (count[t] || 0) + 1)));
    const names = Object.keys(count);
    const pos = (t) => { const i = order.indexOf(t); return i < 0 ? 1e9 : i; };
    names.sort((a, b) => pos(a) - pos(b) || count[b] - count[a] || a.localeCompare(b, 'zh-Hant'));
    return names.map((name) => ({ name, count: count[name] }));
  }

  const rid = (n = 20) => {
    const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => abc[b % abc.length]).join('');
  };

  /* ---------- Firebase (Firestore REST，不需要載入任何 SDK) ---------- */
  function firestore({ projectId, apiKey }) {
    const root = `projects/${projectId}/databases/(default)/documents`;
    const api = `https://firestore.googleapis.com/v1/${root}`;
    const q = `key=${encodeURIComponent(apiKey)}`;
    async function call(url, body) {
      const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
      if (!r.ok) throw new Error(`Firestore ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    }
    const val = (v) =>
      'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'timestampValue' in v ? v.timestampValue : 'doubleValue' in v ? v.doubleValue : null;
    const obj = (d) => {
      const o = { id: d.name.split('/').pop() };
      for (const [k, v] of Object.entries(d.fields || {})) o[k] = val(v);
      return o;
    };
    const S = (s) => ({ stringValue: String(s) });
    const now = (f) => ({ fieldPath: f, setToServerValue: 'REQUEST_TIME' });
    const inc = (f) => ({ fieldPath: f, increment: { integerValue: '1' } });
    const commit = (writes) => call(`${api}:commit?${q}`, { writes });
    const query = (parent, structuredQuery) =>
      call(`${api}${parent}:runQuery?${q}`, { structuredQuery }).then((rows) => rows.filter((r) => r.document).map((r) => obj(r.document)));

    return {
      mode: 'firebase',
      hit: (id) => commit([{ update: { name: `${root}/counters/${id}`, fields: {} }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('n')] }]),
      async counts() {
        const out = {};
        let token = '';
        do {
          const r = await call(`${api}/counters?${q}&pageSize=300${token ? `&pageToken=${token}` : ''}`);
          (r.documents || []).forEach((d) => { const o = obj(d); out[o.id] = o.n || 0; });
          token = r.nextPageToken || '';
        } while (token);
        return out;
      },
      listThreads: () => query('', { from: [{ collectionId: 'threads' }], orderBy: [{ field: { fieldPath: 'lastAt' }, direction: 'DESCENDING' }], limit: 300 }),
      getThread: (id) => call(`${api}/threads/${id}?${q}`).then(obj),
      listReplies: (id) => query(`/threads/${id}`, { from: [{ collectionId: 'replies' }], orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' }], limit: 500 }),
      async createThread(t) {
        const id = rid();
        await commit([{
          update: { name: `${root}/threads/${id}`, fields: { nick: S(t.nick), title: S(t.title), body: S(t.body), postSlug: S(t.postSlug || ''), postTitle: S(t.postTitle || ''), replyCount: { integerValue: '0' } } },
          currentDocument: { exists: false },
          updateTransforms: [now('createdAt'), now('lastAt')],
        }]);
        return id;
      },
      reply: (tid, r) => commit([
        { update: { name: `${root}/threads/${tid}/replies/${rid()}`, fields: { nick: S(r.nick), body: S(r.body) } }, currentDocument: { exists: false }, updateTransforms: [now('createdAt')] },
        { update: { name: `${root}/threads/${tid}`, fields: {} }, updateMask: { fieldPaths: [] }, currentDocument: { exists: true }, updateTransforms: [inc('replyCount'), now('lastAt')] },
      ]),
    };
  }

  /* ---------- 示範模式：還沒設定 Firebase 時，資料只放在這台瀏覽器 ---------- */
  function local() {
    const KEY = 'blog_demo_data';
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { counters: {}, threads: [] }; } catch (e) { return { counters: {}, threads: [] }; } };
    const save = (d) => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} };
    const strip = ({ replies, ...t }) => t;
    return {
      mode: 'local',
      async hit(id) { const d = load(); d.counters[id] = (d.counters[id] || 0) + 1; save(d); },
      async counts() { return load().counters; },
      async listThreads() { return load().threads.map(strip).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)); },
      async getThread(id) { const t = load().threads.find((x) => x.id === id); if (!t) throw new Error('not found'); return strip(t); },
      async listReplies(id) { return (load().threads.find((x) => x.id === id) || { replies: [] }).replies; },
      async createThread(t) {
        const d = load(); const id = rid(); const ts = new Date().toISOString();
        d.threads.push({ id, nick: t.nick, title: t.title, body: t.body, postSlug: t.postSlug || '', postTitle: t.postTitle || '', replyCount: 0, createdAt: ts, lastAt: ts, replies: [] });
        save(d); return id;
      },
      async reply(tid, r) {
        const d = load(); const t = d.threads.find((x) => x.id === tid); if (!t) throw new Error('not found');
        const ts = new Date().toISOString();
        t.replies.push({ id: rid(), nick: r.nick, body: r.body, createdAt: ts }); t.replyCount = t.replies.length; t.lastAt = ts; save(d);
      },
    };
  }

  const makeBackend = (fb) => (fb && fb.projectId && fb.apiKey ? firestore(fb) : local());

  return { esc, fmt, ytId, getJSON, getText, tagList, rid, makeBackend };
})();
