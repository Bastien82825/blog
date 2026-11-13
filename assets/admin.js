/* 後台：在瀏覽器裡編輯，存檔時直接寫回 GitHub 上的檔案 */
(() => {
  const B = window.Blog;
  const { esc, fmt } = B;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const app = $('#app');
  const K_TOKEN = 'blog_admin_token', K_REPO = 'blog_admin_repo';
  const D = { site: {}, posts: [], albums: [] };
  const pending = new Map(); // 還沒上傳的圖片：路徑 → { b64, url, done }
  let dirty = false;
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- 小工具 ---------- */
  let toastTimer;
  function toast(msg, bad, sticky) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastTimer); if (!sticky) toastTimer = setTimeout(() => (t.hidden = true), bad ? 8000 : 4000);
  }
  async function run(label, fn) {
    app.classList.add('busy'); toast(label + '…', false, true);
    try { await fn(); return true; } catch (e) { console.error(e); toast('沒有成功：' + e.message, true); return false; } finally { app.classList.remove('busy'); }
  }
  const short = () => Date.now().toString(36) + B.rid(4).toLowerCase();
  const move = (arr, from, to) => { if (to < 0 || to >= arr.length) return; const [x] = arr.splice(from, 1); arr.splice(to, 0, x); };
  const pad = (n) => String(n).padStart(2, '0');
  const toLocalInput = (iso) => { const d = iso ? new Date(iso) : new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const makeSlug = (iso) => { const d = new Date(iso); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${B.rid(4).toLowerCase()}`; };
  const parseTags = (s) => [...new Set(s.split(/[,，、\n]/).map((t) => t.trim().replace(/^#\s*/, '')).filter(Boolean))];

  function detectRepo() {
    try { const s = JSON.parse(localStorage.getItem(K_REPO)); if (s && s.owner) return s; } catch (e) {}
    const h = location.hostname;
    if (h.endsWith('.github.io')) {
      const owner = h.split('.')[0], seg = location.pathname.split('/').filter(Boolean)[0];
      return { owner, repo: seg && !/\.html?$/.test(seg) ? seg : `${owner}.github.io`, branch: 'main' };
    }
    return { owner: '', repo: '', branch: 'main' };
  }

  /* ---------- GitHub ---------- */
  const GH = {
    ...detectRepo(),
    token: localStorage.getItem(K_TOKEN) || '',
    get base() { return `https://api.github.com/repos/${this.owner}/${this.repo}`; },
    raw(path) { return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${path}`; },
    async req(method, path, body, accept) {
      const r = await fetch(this.base + path, {
        method, cache: 'no-store',
        headers: { Authorization: `Bearer ${this.token}`, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) {
        const hint = { 401: '金鑰無效或已過期，請到「設定」重新貼上', 403: '金鑰權限不足（需要這個倉庫的 Contents 讀寫權限）', 404: '找不到倉庫或檔案，請檢查帳號與倉庫名稱', 409: '倉庫是空的或有衝突', 422: '存檔時遇到衝突，請重新整理後再試一次' }[r.status];
        const e = new Error(hint || `GitHub ${r.status}`); e.status = r.status; throw e;
      }
      return accept ? r.text() : r.status === 204 ? null : r.json();
    },
    async readText(path) {
      try { return await this.req('GET', `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`, null, 'application/vnd.github.raw+json'); }
      catch (e) { if (e.status === 404) return null; throw e; }
    },
    async readJSON(path, fallback) { const t = await this.readText(path); return t == null ? fallback : JSON.parse(t); },
    async listTree(prefix) {
      const t = await this.req('GET', `/git/trees/${encodeURIComponent(this.branch)}?recursive=1`);
      return t.tree.filter((x) => x.type === 'blob' && x.path.startsWith(prefix)).map((x) => x.path);
    },
    /* 一次存檔 = 一個 commit，可同時新增、修改、刪除多個檔案 */
    async commit(files, message) {
      const ref = await this.req('GET', `/git/ref/heads/${encodeURIComponent(this.branch)}`);
      const head = await this.req('GET', `/git/commits/${ref.object.sha}`);
      const tree = [];
      const ups = files.filter((f) => !f.del);
      let n = 0;
      for (let i = 0; i < ups.length; i += 4) {
        await Promise.all(ups.slice(i, i + 4).map(async (f) => {
          const b = await this.req('POST', '/git/blobs', f.b64 != null ? { content: f.b64, encoding: 'base64' } : { content: f.text, encoding: 'utf-8' });
          tree.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha });
          n++; if (ups.length > 3) toast(`上傳中 ${n} / ${ups.length}…`, false, true);
        }));
      }
      files.filter((f) => f.del).forEach((f) => tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null }));
      const t = await this.req('POST', '/git/trees', { base_tree: head.tree.sha, tree });
      const c = await this.req('POST', '/git/commits', { message, tree: t.sha, parents: [ref.object.sha] });
      await this.req('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: c.sha });
    },
  };
  const json = (o) => JSON.stringify(o, null, 2) + '\n';
  const SAVED = '存好了！網站大約一分鐘後會更新。';

  /* ---------- 圖片 ---------- */
  async function toJpeg(file, max, q = 0.85) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(file); }
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', q));
  }
  const toB64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
  async function stage(file, dir, max, name) {
    const gif = file.type === 'image/gif';
    const blob = gif ? file : await toJpeg(file, max);
    const path = `${dir}/${name || short()}.${gif ? 'gif' : 'jpg'}`;
    pending.set(path, { b64: await toB64(blob), url: URL.createObjectURL(blob), done: false });
    return path;
  }
  const show = (path) => (!path ? '' : /^(https?:|blob:|data:)/.test(path) ? path : pending.has(path) ? pending.get(path).url : GH.raw(path));
  const uploads = (paths) => paths.filter((p) => pending.has(p) && !pending.get(p).done).map((p) => ({ path: p, b64: pending.get(p).b64 }));
  const markDone = (files) => files.forEach((f) => { if (pending.has(f.path)) pending.get(f.path).done = true; });
  function pickFiles(multiple = true) {
    return new Promise((res) => {
      const inp = $('#filepick'); inp.multiple = multiple; inp.value = '';
      inp.onchange = () => res([...inp.files].filter((f) => f.type.startsWith('image/')));
      inp.click();
    });
  }

  /* ---------- 拖拉排序（另外都有 ↑↓ 按鈕，手機用按的） ---------- */
  function sortable(box, itemSel, onMove) {
    let from = null;
    $$(itemSel, box).forEach((el, i) => {
      const h = el.querySelector('[data-grip]') || el;
      h.draggable = true;
      h.ondragstart = (e) => { from = i; el.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); };
      h.ondragend = () => { el.classList.remove('drag'); $$('.over', box).forEach((x) => x.classList.remove('over')); from = null; };
      el.ondragover = (e) => { if (from === null) return; e.preventDefault(); el.classList.add('over'); };
      el.ondragleave = () => el.classList.remove('over');
      el.ondrop = (e) => { e.preventDefault(); const f = from; from = null; if (f !== null && f !== i) onMove(f, i); };
    });
  }

  /* ---------- 文字編輯器 ---------- */
  const INLINE = new Set(['A', 'STRONG', 'B', 'EM', 'I', 'U', 'BR', 'IMG']);
  const BLOCK = new Set(['P', 'H2', 'H3', 'UL', 'OL', 'BLOCKQUOTE', 'DIV']);
  const ALLOW = new Set([...INLINE, ...BLOCK, 'LI']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'HEAD', 'NOSCRIPT', 'TEMPLATE']);
  const RENAME = { H1: 'H2', H4: 'H3', H5: 'H3', H6: 'H3', DIV: 'P', SECTION: 'P', ARTICLE: 'P', FIGCAPTION: 'P', PRE: 'P' };
  /* 只留下部落格會用到的標籤，貼上 Word 或網頁內容時把多餘的格式清掉 */
  function scrub(root) {
    [...root.childNodes].forEach((n) => {
      if (n.nodeType === 8) return n.remove();
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (DROP.has(tag)) return n.remove();
      if (tag === 'DIV' && n.classList.contains('video') && /^[\w-]{11}$/.test(n.dataset.youtube || '')) {
        [...n.attributes].forEach((a) => { if (!['class', 'data-youtube', 'contenteditable'].includes(a.name)) n.removeAttribute(a.name); });
        n.className = 'video';
        return;
      }
      scrub(n);
      let el = n;
      if (RENAME[tag]) {
        if (RENAME[tag] === 'P' && [...n.children].some((c) => BLOCK.has(c.tagName))) return n.replaceWith(...n.childNodes);
        el = document.createElement(RENAME[tag]); el.append(...n.childNodes); n.replaceWith(el);
      } else if (!ALLOW.has(tag)) return n.replaceWith(...n.childNodes);
      [...el.attributes].forEach((a) => {
        const ok = (el.tagName === 'A' && a.name === 'href' && /^(https?:|mailto:|#)/i.test(a.value)) || (el.tagName === 'IMG' && ['src', 'alt', 'data-path'].includes(a.name));
        if (!ok) el.removeAttribute(a.name);
      });
    });
  }
  /* 最外層散落的文字包成段落 */
  function wrapLoose(root) {
    let p = null;
    [...root.childNodes].forEach((n) => {
      const loose = n.nodeType === 3 || (n.nodeType === 1 && INLINE.has(n.tagName));
      if (!loose) { p = null; return; }
      if (n.nodeType === 3 && !n.textContent.trim() && !p) return n.remove();
      if (!p) { p = document.createElement('p'); n.before(p); }
      p.append(n);
    });
    $$('p', root).forEach((x) => { if (!x.textContent.trim() && !x.querySelector('img')) x.remove(); });
  }
  const videoBlock = (id) => `<div class="video" data-youtube="${id}" contenteditable="false"><img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt=""><span>▶ YouTube 影片（發布後可以直接播放）</span></div>`;

  function makeEditor(host, imgDir) {
    host.innerHTML = `<div class="ed"><div class="ed-bar">
      <button type="button" data-c="formatBlock" data-v="p" title="一般內文">內文</button>
      <button type="button" data-c="formatBlock" data-v="h2" title="大標題">大標</button>
      <button type="button" data-c="formatBlock" data-v="h3" title="小標題">小標</button><i></i>
      <button type="button" data-c="bold" title="粗體"><b>粗</b></button>
      <button type="button" data-c="italic" title="斜體"><em>斜</em></button>
      <button type="button" data-c="formatBlock" data-v="blockquote" title="引用">引用</button>
      <button type="button" data-c="insertUnorderedList" title="項目清單">• 清單</button>
      <button type="button" data-c="insertOrderedList" title="編號清單">1. 清單</button>
      <button type="button" data-a="link" title="加上連結">連結</button><i></i>
      <button type="button" class="hl" data-a="image" title="插入圖片">＋ 圖片</button>
      <button type="button" class="hl" data-a="youtube" title="插入 YouTube 影片">＋ YouTube</button><i></i>
      <button type="button" data-c="removeFormat" title="清除格式">清格式</button>
      <button type="button" data-c="undo" title="復原">↶</button>
      <button type="button" data-c="redo" title="重做">↷</button>
    </div><div class="ed-body prose" contenteditable="true"></div></div>`;
    const body = $('.ed-body', host);
    let saved = null;
    const keep = () => { const s = getSelection(); if (s.rangeCount && body.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange(); };
    ['keyup', 'mouseup', 'blur', 'input'].forEach((ev) => body.addEventListener(ev, keep));
    body.addEventListener('input', () => (dirty = true));
    const restore = () => {
      body.focus();
      const s = getSelection();
      if (saved) { s.removeAllRanges(); s.addRange(saved); } else { s.selectAllChildren(body); s.collapseToEnd(); }
    };
    const cmd = (c, v) => { restore(); document.execCommand(c, false, v); keep(); dirty = true; };
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {}

    async function addImages(files) {
      for (const f of files) {
        try { const path = await stage(f, imgDir(), 1600); cmd('insertHTML', `<p><img src="${pending.get(path).url}" data-path="${path}" alt=""></p><p><br></p>`); }
        catch (e) { toast(`「${f.name}」不是可以用的圖片`, true); }
      }
    }
    const addVideo = (id) => cmd('insertHTML', videoBlock(id) + '<p><br></p>');

    $('.ed-bar', host).addEventListener('mousedown', (e) => e.preventDefault());
    $('.ed-bar', host).addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.c) return cmd(b.dataset.c, b.dataset.v ? `<${b.dataset.v}>` : undefined);
      if (b.dataset.a === 'image') { keep(); addImages(await pickFiles(true)); }
      if (b.dataset.a === 'youtube') {
        keep(); const u = prompt('貼上 YouTube 影片網址：'); if (!u) return;
        const id = B.ytId(u); id ? addVideo(id) : toast('看不懂這個網址，請貼 YouTube 影片頁面的網址', true);
      }
      if (b.dataset.a === 'link') {
        keep(); const u = prompt('連結網址（https://…）：'); if (!u) return;
        if (!/^(https?:|mailto:)/i.test(u.trim())) return toast('網址要以 http:// 或 https:// 開頭', true);
        const s = getSelection(); restore();
        s.isCollapsed ? cmd('insertHTML', `<a href="${esc(u.trim())}">${esc(u.trim())}</a>`) : cmd('createLink', u.trim());
      }
    });

    body.addEventListener('paste', async (e) => {
      e.preventDefault(); keep();
      const cd = e.clipboardData;
      const imgs = [...cd.files].filter((f) => f.type.startsWith('image/'));
      const html = cd.getData('text/html'), txt = cd.getData('text/plain');
      if (imgs.length && !html) return addImages(imgs);
      if (txt && !/\s/.test(txt.trim()) && B.ytId(txt)) return addVideo(B.ytId(txt));
      if (html) {
        const box = document.createElement('div'); box.innerHTML = html; scrub(box);
        for (const im of $$('img', box)) {
          const src = im.getAttribute('src') || '';
          if (src.startsWith('data:')) {
            try { const path = await stage(await (await fetch(src)).blob(), imgDir(), 1600); im.src = pending.get(path).url; im.dataset.path = path; } catch (x) { im.remove(); }
          } else if (!/^https?:/.test(src)) im.remove();
        }
        return cmd('insertHTML', box.innerHTML);
      }
      cmd('insertHTML', txt.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join(''));
    });
    body.addEventListener('drop', (e) => {
      const imgs = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (imgs.length) { e.preventDefault(); addImages(imgs); }
    });

    const storageDom = () => {
      const c = body.cloneNode(true);
      $$('img', c).forEach((im) => { if (im.dataset.path) { im.setAttribute('src', im.dataset.path); im.removeAttribute('data-path'); } });
      $$('.video', c).forEach((v) => { const id = v.dataset.youtube; v.removeAttribute('contenteditable'); v.innerHTML = `<a href="https://www.youtube.com/watch?v=${id}">https://www.youtube.com/watch?v=${id}</a>`; });
      scrub(c); wrapLoose(c);
      return c;
    };
    return {
      setHTML(html) {
        body.innerHTML = html || '';
        $$('img', body).forEach((im) => { const s = im.getAttribute('src') || ''; if (!/^(https?:|blob:|data:)/.test(s)) { im.dataset.path = s; im.src = show(s); } });
        $$('.video[data-youtube]', body).forEach((v) => (v.outerHTML = videoBlock(v.dataset.youtube)));
      },
      getHTML: () => storageDom().innerHTML,
      info() {
        const c = storageDom();
        const img = $('img', c), vid = $('.video', c);
        $$('.video', c).forEach((v) => v.remove());
        const plain = c.textContent.replace(/\s+/g, ' ').trim();
        return { cover: img ? img.getAttribute('src') : vid ? `https://i.ytimg.com/vi/${vid.dataset.youtube}/hqdefault.jpg` : '', excerpt: plain.slice(0, 110) + (plain.length > 110 ? '…' : '') };
      },
      files: () => uploads($$('img[data-path]', body).map((im) => im.dataset.path)),
    };
  }

  /* ---------- 第一次使用：貼上金鑰 ---------- */
  function viewSetup(msg) {
    $('#tabs').hidden = true;
    app.innerHTML = `
      <h1>第一次在這台裝置使用</h1>
      <p class="hint">這裡不用帳號密碼登入。只要把 GitHub 給你的「金鑰」貼進來一次，這台裝置的瀏覽器就會記住，之後打開就能直接編輯。<br>金鑰只存在你這台裝置上，不會傳到 GitHub 以外的地方。請不要在公用電腦上使用。</p>
      ${msg ? `<div class="notice">${esc(msg)}</div>` : ''}
      <form class="card form" id="sf">
        <div class="two">
          <label class="fld"><span>GitHub 帳號</span><input type="text" id="s-owner" required value="${esc(GH.owner)}"></label>
          <label class="fld"><span>倉庫（repository）名稱</span><input type="text" id="s-repo" required value="${esc(GH.repo)}"></label>
        </div>
        <label class="fld"><span>分支（通常是 main，不用改）</span><input type="text" id="s-branch" required value="${esc(GH.branch || 'main')}"></label>
        <label class="fld"><span>金鑰（github_pat_ 開頭的那一長串）</span><input type="password" id="s-token" required autocomplete="off"></label>
        <div class="row"><button class="btn" type="submit">開始使用</button></div>
      </form>`;
    $('#sf').onsubmit = async (e) => {
      e.preventDefault();
      Object.assign(GH, { owner: $('#s-owner').value.trim(), repo: $('#s-repo').value.trim(), branch: $('#s-branch').value.trim() || 'main', token: $('#s-token').value.trim() });
      await run('檢查金鑰', async () => {
        const r = await GH.req('GET', '');
        if (!r.permissions || !r.permissions.push) throw new Error('這把金鑰不能寫入這個倉庫，請確認 Contents 權限選的是 Read and write');
        localStorage.setItem(K_TOKEN, GH.token);
        localStorage.setItem(K_REPO, JSON.stringify({ owner: GH.owner, repo: GH.repo, branch: GH.branch }));
        toast('連上了！'); await boot();
      });
    };
  }

  /* ---------- 文章 ---------- */
  function viewPosts() {
    const list = [...D.posts].sort((a, b) => (a.created < b.created ? 1 : -1));
    app.innerHTML = `
      <div class="hrow"><h1>文章（${list.length}）</h1><a class="btn" href="#new">＋ 寫新文章</a></div>
      <ul class="rows">${list.map((p) => `<li>
        <div class="ttl"><b>${esc(p.title)}</b><small>建立 ${fmt(p.created)}　修改 ${fmt(p.updated)}${(p.tags || []).length ? '　# ' + esc(p.tags.join('、')) : ''}</small></div>
        <a class="btn sm" href="#edit/${encodeURIComponent(p.slug)}">編輯</a>
        <button class="btn sm danger" data-del="${esc(p.slug)}">刪除</button></li>`).join('') || '<p class="empty">還沒有文章，按右上角開始寫第一篇。</p>'}</ul>`;
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const p = D.posts.find((x) => x.slug === b.dataset.del);
      if (!confirm(`確定要刪除「${p.title}」嗎？刪掉就不會出現在網站上了。`)) return;
      if (await run('刪除中', async () => {
        const posts = (await GH.readJSON('content/posts.json', [])).filter((x) => x.slug !== p.slug);
        const imgs = await GH.listTree(`content/images/posts/${p.slug}/`);
        await GH.commit([{ path: `content/posts/${p.slug}.html`, del: true }, ...imgs.map((path) => ({ path, del: true })), { path: 'content/posts.json', text: json(posts) }], `刪除文章：${p.title}`);
        D.posts = posts;
      })) { toast('已刪除。'); viewPosts(); }
    }));
  }

  async function viewPostEdit(slug) {
    const old = slug ? D.posts.find((p) => p.slug === slug) : null;
    if (slug && !old) { location.hash = '#posts'; return; }
    const s = slug || makeSlug(new Date());
    const all = B.tagList(D.posts, D.site.tagOrder).map((t) => t.name);
    app.innerHTML = `
      <div class="hrow"><h1>${old ? '編輯文章' : '寫新文章'}</h1></div>
      <label class="fld"><span>標題</span><input type="text" id="p-title" maxlength="120" value="${esc(old ? old.title : '')}"></label>
      <div id="p-ed"></div>
      <label class="fld"><span>關鍵字（多個用逗號分開；文章會自動歸到這些主題下）</span><input type="text" id="p-tags" value="${esc(old ? (old.tags || []).join('、') : '')}"></label>
      ${all.length ? `<div class="tagpick">用過的：${all.map((t) => `<button type="button" class="chip" data-t="${esc(t)}"># ${esc(t)}</button>`).join('')}</div>` : ''}
      <label class="fld"><span>建立時間（搬舊文章過來時，可以改成原本的發表時間）</span><input type="datetime-local" id="p-created" value="${toLocalInput(old && old.created)}"></label>
      ${old ? `<p class="hint">上次修改：${fmt(old.updated)}（存檔時會自動更新）</p>` : ''}
      <div class="actions"><button class="btn" id="p-save">存檔並發布</button><a class="btn plain" href="#posts">取消</a></div>`;
    const ed = makeEditor($('#p-ed'), () => `content/images/posts/${s}`);
    const tagsIn = $('#p-tags');
    const paintPick = () => { const cur = parseTags(tagsIn.value); $$('.tagpick [data-t]').forEach((b) => b.classList.toggle('on', cur.includes(b.dataset.t))); };
    $$('.tagpick [data-t]').forEach((b) => (b.onclick = () => { const cur = parseTags(tagsIn.value); const i = cur.indexOf(b.dataset.t); i >= 0 ? cur.splice(i, 1) : cur.push(b.dataset.t); tagsIn.value = cur.join('、'); dirty = true; paintPick(); }));
    tagsIn.oninput = () => { dirty = true; paintPick(); }; paintPick();
    $('#p-title').oninput = () => (dirty = true);
    if (old) {
      await run('讀取文章', async () => { ed.setHTML((await GH.readText(`content/posts/${s}.html`)) || ''); });
      $('#toast').hidden = true;
    }
    $('#p-save').onclick = async () => {
      const title = $('#p-title').value.trim();
      if (!title) return toast('請先填標題', true);
      const cv = $('#p-created').value;
      const ok = await run('存檔中', async () => {
        const now = new Date().toISOString();
        const entry = { slug: s, title, created: cv ? new Date(cv).toISOString() : now, updated: now, tags: parseTags(tagsIn.value), ...ed.info() };
        const posts = await GH.readJSON('content/posts.json', []);
        const i = posts.findIndex((p) => p.slug === s);
        i >= 0 ? (posts[i] = entry) : posts.push(entry);
        posts.sort((a, b) => (a.created < b.created ? 1 : -1));
        const up = ed.files();
        await GH.commit([{ path: `content/posts/${s}.html`, text: ed.getHTML() + '\n' }, { path: 'content/posts.json', text: json(posts) }, ...up], `${old ? '修改' : '新增'}文章：${title}`);
        markDone(up); D.posts = posts;
      });
      if (ok) { dirty = false; toast(SAVED); location.hash = '#posts'; }
    };
  }

  /* ---------- 個人頁面 ---------- */
  function viewProfile() {
    const p = { ...(D.site.profile || {}) };
    app.innerHTML = `
      <div class="hrow"><h1>個人頁面</h1></div>
      <div class="avatar-row"><img id="pf-img" src="${esc(show(p.photo)) || 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='}" alt=""><div><button class="btn sm plain" id="pf-pick">換照片</button> <button class="btn sm danger" id="pf-none">不放照片</button></div></div>
      <div class="two">
        <label class="fld"><span>名字</span><input type="text" id="pf-name" value="${esc(p.name || '')}"></label>
        <label class="fld"><span>一句話介紹</span><input type="text" id="pf-tag" value="${esc(p.tagline || '')}"></label>
      </div>
      <label class="fld"><span>聯絡方式（Email 或網址；留空就不顯示）</span><input type="text" id="pf-contact" value="${esc(p.contact || '')}"></label>
      <label class="fld"><span>ORCID（例如 0000-0001-7025-6587；留空就不顯示）</span><input type="text" id="pf-orcid" value="${esc(p.orcid || '')}"></label>
      <label class="fld"><span>國科會個人頁面網址（有填的話，頁面上會出現一顆連過去的按鈕）</span><input type="url" id="pf-nstc" value="${esc(p.nstcUrl || '')}" placeholder="https://"></label>
      <div id="pf-ed"></div>
      <p class="hint">建立：${fmt(p.created)}　上次修改：${fmt(p.updated)}</p>
      <div class="actions"><button class="btn" id="pf-save">存檔</button></div>`;
    const ed = makeEditor($('#pf-ed'), () => 'content/images/profile');
    ed.setHTML(p.html || '');
    $('#pf-pick').onclick = async () => { const [f] = await pickFiles(false); if (!f) return; p.photo = await stage(f, 'content/images/profile', 900); $('#pf-img').src = show(p.photo); dirty = true; };
    $('#pf-none').onclick = () => { p.photo = ''; $('#pf-img').removeAttribute('src'); dirty = true; };
    $$('input', app).forEach((i) => i.addEventListener('input', () => (dirty = true)));
    $('#pf-save').onclick = async () => {
      const ok = await run('存檔中', async () => {
        const now = new Date().toISOString();
        const site = await GH.readJSON('content/site.json', D.site);
        site.profile = { name: $('#pf-name').value.trim(), tagline: $('#pf-tag').value.trim(), photo: p.photo || '', nstcUrl: $('#pf-nstc').value.trim(), contact: $('#pf-contact').value.trim(), orcid: $('#pf-orcid').value.trim().replace(/^https?:\/\/orcid\.org\//, ''), html: ed.getHTML(), created: p.created || now, updated: now };
        const up = [...ed.files(), ...uploads([p.photo])];
        await GH.commit([{ path: 'content/site.json', text: json(site) }, ...up], '修改個人頁面');
        markDone(up); D.site = site;
      });
      if (ok) { dirty = false; toast(SAVED); viewProfile(); }
    };
  }

  /* ---------- 相簿 ---------- */
  function viewAlbums() {
    let changed = false;
    const paint = () => {
      app.innerHTML = `
        <div class="hrow"><h1>相簿（${D.albums.length}）</h1>${changed ? '<button class="btn" id="al-order">儲存順序</button>' : ''}<a class="btn" href="#album/new">＋ 新相簿</a></div>
        <p class="hint">每張相片都要放在某一本相簿裡，所以是先開相簿、再放相片。相簿可以拖拉或按 ↑↓ 排順序。</p>
        <ul class="rows">${D.albums.map((a, i) => `<li>
          <span class="grip" data-grip title="拖拉排序">⋮⋮</span><span class="mv"><button data-up="${i}">↑</button><button data-dn="${i}">↓</button></span>
          <img src="${esc(show((a.photos.find((p) => p.src === a.cover) || a.photos[0] || {}).thumb))}" alt="">
          <div class="ttl"><b>${esc(a.title)}</b><small>${a.photos.length} 張　建立 ${fmt(a.created, false)}</small></div>
          <a class="btn sm" href="#album/${encodeURIComponent(a.id)}">編輯</a>
          <button class="btn sm danger" data-del="${i}">刪除</button></li>`).join('') || '<p class="empty">還沒有相簿。</p>'}</ul>`;
      const mv = (f, t) => { move(D.albums, f, t); changed = true; dirty = true; paint(); };
      sortable(app, '.rows li', mv);
      $$('[data-up]').forEach((b) => (b.onclick = () => mv(+b.dataset.up, +b.dataset.up - 1)));
      $$('[data-dn]').forEach((b) => (b.onclick = () => mv(+b.dataset.dn, +b.dataset.dn + 1)));
      const ob = $('#al-order');
      if (ob) ob.onclick = async () => { if (await run('存檔中', () => GH.commit([{ path: 'content/albums.json', text: json(D.albums) }], '調整相簿順序'))) { changed = false; dirty = false; toast(SAVED); paint(); } };
      $$('[data-del]').forEach((b) => (b.onclick = async () => {
        const a = D.albums[+b.dataset.del];
        if (!confirm(`確定要刪除相簿「${a.title}」和裡面的 ${a.photos.length} 張相片嗎？`)) return;
        if (await run('刪除中', async () => {
          const albums = (await GH.readJSON('content/albums.json', [])).filter((x) => x.id !== a.id);
          const imgs = await GH.listTree(`content/images/albums/${a.id}/`);
          await GH.commit([...imgs.map((path) => ({ path, del: true })), { path: 'content/albums.json', text: json(albums) }], `刪除相簿：${a.title}`);
          D.albums = albums;
        })) { toast('已刪除。'); paint(); }
      }));
    };
    paint();
  }

  function viewAlbumEdit(id) {
    const old = id === 'new' ? null : D.albums.find((a) => a.id === id);
    if (id !== 'new' && !old) { location.hash = '#albums'; return; }
    const al = old ? JSON.parse(JSON.stringify(old)) : { id: 'a' + short(), title: '', desc: '', created: new Date().toISOString(), cover: '', photos: [] };
    const removed = [];
    const dir = `content/images/albums/${al.id}`;
    app.innerHTML = `
      <div class="hrow"><h1>${old ? '編輯相簿' : '新相簿'}</h1></div>
      <label class="fld"><span>相簿名稱</span><input type="text" id="al-title" maxlength="60" value="${esc(al.title)}"></label>
      <label class="fld"><span>說明（可不填）</span><textarea id="al-desc" maxlength="500">${esc(al.desc || '')}</textarea></label>
      <div class="hrow"><h2 id="al-n" style="flex:1"></h2><button class="btn sm" id="al-add">＋ 加入相片</button></div>
      <div class="pgrid" id="al-grid"></div>
      <p class="hint">相片可以拖拉或按 ←→ 排順序；一本相簿至少要有一張相片。</p>
      <div class="actions"><button class="btn" id="al-save">存檔</button><a class="btn plain" href="#albums">取消</a></div>`;
    const grid = $('#al-grid');
    const paint = () => {
      if (!al.photos.some((p) => p.src === al.cover)) al.cover = al.photos[0] ? al.photos[0].src : '';
      $('#al-n').textContent = `相片（${al.photos.length}）`;
      grid.innerHTML = al.photos.map((p, i) => `<div class="pcell">
        ${p.src === al.cover ? '<span class="cov">封面</span>' : ''}<img data-grip src="${esc(show(p.thumb || p.src))}" alt="">
        <input type="text" placeholder="說明（可不填）" maxlength="100" data-cap="${i}" value="${esc(p.caption || '')}">
        <div class="ops"><button class="icon" data-l="${i}" title="往前">←</button><button class="icon" data-r="${i}" title="往後">→</button><button class="icon" data-cov="${i}">設封面</button><button class="icon" data-rm="${i}" title="移除">✕</button></div></div>`).join('') || '<p class="empty" style="grid-column:1/-1">還沒有相片，按「＋ 加入相片」選幾張。</p>';
      const mv = (f, t) => { move(al.photos, f, t); dirty = true; paint(); };
      sortable(grid, '.pcell', mv);
      $$('[data-cap]', grid).forEach((i) => (i.oninput = () => { al.photos[+i.dataset.cap].caption = i.value; dirty = true; }));
      $$('[data-l]', grid).forEach((b) => (b.onclick = () => mv(+b.dataset.l, +b.dataset.l - 1)));
      $$('[data-r]', grid).forEach((b) => (b.onclick = () => mv(+b.dataset.r, +b.dataset.r + 1)));
      $$('[data-cov]', grid).forEach((b) => (b.onclick = () => { al.cover = al.photos[+b.dataset.cov].src; dirty = true; paint(); }));
      $$('[data-rm]', grid).forEach((b) => (b.onclick = () => { const [p] = al.photos.splice(+b.dataset.rm, 1); removed.push(p); dirty = true; paint(); }));
    };
    paint();
    $('#al-add').onclick = async () => {
      const files = await pickFiles(true);
      if (!files.length) return;
      await run('處理相片', async () => {
        let n = 0;
        for (const f of files) {
          toast(`處理相片 ${++n} / ${files.length}…`, false, true);
          try {
            const name = short();
            const src = await stage(f, dir, 1800, name);
            const thumb = f.type === 'image/gif' ? src : await stage(await toJpeg(f, 560, 0.8), dir, 560, name + '_t');
            al.photos.push({ src, thumb, caption: '' });
          } catch (e) { console.warn(e); }
        }
      });
      $('#toast').hidden = true; dirty = true; paint();
    };
    $('#al-save').onclick = async () => {
      al.title = $('#al-title').value.trim(); al.desc = $('#al-desc').value.trim();
      if (!al.title) return toast('請先幫相簿取個名字', true);
      if (!al.photos.length) return toast('相簿至少要有一張相片。如果不要這本相簿，請回列表按「刪除」。', true);
      const ok = await run('存檔中', async () => {
        al.updated = new Date().toISOString();
        const albums = await GH.readJSON('content/albums.json', []);
        const i = albums.findIndex((a) => a.id === al.id);
        i >= 0 ? (albums[i] = al) : albums.unshift(al);
        const up = uploads(al.photos.flatMap((p) => [p.src, p.thumb]));
        const gone = [...new Set(removed.flatMap((p) => [p.src, p.thumb]))].filter((p) => p && (!pending.has(p) || pending.get(p).done)).map((path) => ({ path, del: true }));
        await GH.commit([{ path: 'content/albums.json', text: json(albums) }, ...up, ...gone], `${old ? '修改' : '新增'}相簿：${al.title}`);
        markDone(up); D.albums = albums;
      });
      if (ok) { dirty = false; toast(SAVED); location.hash = '#albums'; }
    };
  }

  /* ---------- 關鍵字 ---------- */
  function viewTags() {
    const ops = [];
    let posts = JSON.parse(JSON.stringify(D.posts));
    let order = B.tagList(posts, D.site.tagOrder).map((t) => t.name);
    const apply = (list, op) => list.forEach((p) => {
      p.tags = [...new Set((p.tags || []).flatMap((t) => (t !== op.from ? [t] : op.to ? [op.to] : [])))];
    });
    const paint = () => {
      const count = Object.fromEntries(B.tagList(posts).map((t) => [t.name, t.count]));
      order = order.filter((t) => count[t]);
      app.innerHTML = `
        <div class="hrow"><h1>關鍵字（${order.length}）</h1><button class="btn" id="tg-save">存檔</button></div>
        <p class="hint">這裡的順序就是網站左邊「主題關鍵字」的順序，可以拖拉或按 ↑↓。關鍵字是在寫文章時加上去的；在這裡可以改名（改成已有的名字就會合併）或整個拿掉。</p>
        <ul class="rows">${order.map((t, i) => `<li><span class="grip" data-grip>⋮⋮</span><span class="mv"><button data-up="${i}">↑</button><button data-dn="${i}">↓</button></span>
          <div class="ttl"><b># ${esc(t)}</b><small>${count[t]} 篇文章</small></div>
          <button class="btn sm plain" data-ren="${i}">改名</button><button class="btn sm danger" data-rm="${i}">拿掉</button></li>`).join('') || '<p class="empty">還沒有任何關鍵字。寫文章時在「關鍵字」欄填上就會出現在這裡。</p>'}</ul>`;
      const mv = (f, t) => { move(order, f, t); dirty = true; paint(); };
      sortable(app, '.rows li', mv);
      $$('[data-up]').forEach((b) => (b.onclick = () => mv(+b.dataset.up, +b.dataset.up - 1)));
      $$('[data-dn]').forEach((b) => (b.onclick = () => mv(+b.dataset.dn, +b.dataset.dn + 1)));
      $$('[data-ren]').forEach((b) => (b.onclick = () => {
        const from = order[+b.dataset.ren]; const to = (prompt(`把「${from}」改成：`, from) || '').trim().replace(/^#\s*/, '');
        if (!to || to === from) return;
        const op = { from, to }; ops.push(op); apply(posts, op);
        order = order.includes(to) ? order.filter((t) => t !== from) : order.map((t) => (t === from ? to : t));
        dirty = true; paint();
      }));
      $$('[data-rm]').forEach((b) => (b.onclick = () => {
        const from = order[+b.dataset.rm];
        if (!confirm(`把「${from}」從所有文章上拿掉？（文章本身不會被刪除）`)) return;
        const op = { from, to: '' }; ops.push(op); apply(posts, op); dirty = true; paint();
      }));
      $('#tg-save').onclick = async () => {
        const ok = await run('存檔中', async () => {
          const site = await GH.readJSON('content/site.json', D.site);
          site.tagOrder = order;
          const files = [{ path: 'content/site.json', text: json(site) }];
          let fresh = D.posts;
          if (ops.length) { fresh = await GH.readJSON('content/posts.json', []); ops.forEach((op) => apply(fresh, op)); files.push({ path: 'content/posts.json', text: json(fresh) }); }
          await GH.commit(files, '調整關鍵字');
          D.site = site; D.posts = fresh;
        });
        if (ok) { dirty = false; toast(SAVED); viewTags(); }
      };
    };
    paint();
  }

  /* ---------- 設定 ---------- */
  function viewSettings() {
    const s = D.site, fb = s.firebase || {};
    app.innerHTML = `
      <div class="hrow"><h1>設定</h1></div>
      <div class="card form">
        <h2>網站</h2>
        <label class="fld"><span>網站名稱</span><input type="text" id="st-title" value="${esc(s.title || '')}"></label>
        <label class="fld"><span>副標（顯示在名稱下面的一句話）</span><input type="text" id="st-sub" value="${esc(s.subtitle || '')}"></label>
        <label class="fld"><span>頁尾文字</span><input type="text" id="st-foot" value="${esc(s.footer || '')}"></label>
        <h2 style="margin-top:20px">互動區與計數（Firebase）</h2>
        <p class="hint">兩格都填了，互動區的留言和拜訪／點閱次數才會真的存起來；留空就是「示範模式」。怎麼拿到這兩個值，請看說明文件的第三部分。</p>
        <div class="two">
          <label class="fld"><span>Project ID</span><input type="text" id="st-pid" value="${esc(fb.projectId || '')}"></label>
          <label class="fld"><span>Web API Key</span><input type="text" id="st-key" value="${esc(fb.apiKey || '')}"></label>
        </div>
        ${fb.projectId ? `<p class="hint">要刪除不當留言：到 <a href="https://console.firebase.google.com/project/${esc(fb.projectId)}/firestore" target="_blank" rel="noopener">Firebase 主控台</a> 的 threads 裡把那一筆刪掉。</p>` : ''}
        <div class="row"><button class="btn" id="st-save">存檔</button></div>
      </div>
      <div class="card form" style="margin-top:16px">
        <h2>這台裝置</h2>
        <p class="hint">目前連到 <code>${esc(GH.owner)}/${esc(GH.repo)}</code>（${esc(GH.branch)}）。金鑰過期或要換裝置時，按下面的按鈕重新設定。</p>
        <div class="row"><button class="btn danger" id="st-out">清除這台裝置上的金鑰</button></div>
      </div>`;
    $$('input', app).forEach((i) => i.addEventListener('input', () => (dirty = true)));
    $('#st-save').onclick = async () => {
      const ok = await run('存檔中', async () => {
        const site = await GH.readJSON('content/site.json', D.site);
        Object.assign(site, { title: $('#st-title').value.trim(), subtitle: $('#st-sub').value.trim(), footer: $('#st-foot').value.trim(), firebase: { projectId: $('#st-pid').value.trim(), apiKey: $('#st-key').value.trim() } });
        await GH.commit([{ path: 'content/site.json', text: json(site) }], '修改網站設定');
        D.site = site;
      });
      if (ok) { dirty = false; toast(SAVED); viewSettings(); }
    };
    $('#st-out').onclick = () => { if (!confirm('清除後，這台裝置要重新貼金鑰才能編輯。確定嗎？')) return; localStorage.removeItem(K_TOKEN); GH.token = ''; viewSetup(); };
  }

  /* ---------- 路由 ---------- */
  let lastHash = '';
  function route() {
    if (dirty && location.hash !== lastHash) {
      if (!confirm('還沒存檔，確定要離開這一頁嗎？')) { history.replaceState(null, '', lastHash || '#posts'); return; }
    }
    dirty = false; lastHash = location.hash;
    const [a, ...r] = location.hash.replace(/^#/, '').split('/');
    const arg = decodeURIComponent(r.join('/'));
    const tab = { '': 'posts', posts: 'posts', new: 'posts', edit: 'posts', profile: 'profile', albums: 'albums', album: 'albums', tags: 'tags', settings: 'settings' }[a] || 'posts';
    $$('#tabs a').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
    window.scrollTo(0, 0);
    if (a === 'new') viewPostEdit(null);
    else if (a === 'edit') viewPostEdit(arg);
    else if (a === 'profile') viewProfile();
    else if (a === 'albums') viewAlbums();
    else if (a === 'album') viewAlbumEdit(arg);
    else if (a === 'tags') viewTags();
    else if (a === 'settings') viewSettings();
    else viewPosts();
  }

  async function boot() {
    if (!GH.token || !GH.owner || !GH.repo) return viewSetup();
    app.innerHTML = '<p class="loading">讀取資料中…</p>';
    try {
      [D.site, D.posts, D.albums] = await Promise.all([GH.readJSON('content/site.json', {}), GH.readJSON('content/posts.json', []), GH.readJSON('content/albums.json', [])]);
    } catch (e) { return viewSetup(e.message); }
    $('#tabs').hidden = false;
    lastHash = location.hash;
    route();
  }
  window.addEventListener('hashchange', () => { if (!$('#tabs').hidden) route(); });
  boot();
})();
