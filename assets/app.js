/* 前台：單頁式部落格 */
(() => {
  const B = window.Blog;
  const { esc, fmt } = B;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const main = $('#main');
  const S = { site: {}, posts: [], albums: [], counts: {}, be: null, threads: null };
  const PAGE = 15;

  const href = (...p) => '#/' + p.map(encodeURIComponent).join('/');
  const postBySlug = (slug) => S.posts.find((p) => p.slug === slug);
  const ses = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} },
  };
  const loc = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  /* ---------- 啟動 ---------- */
  async function init() {
    try {
      const [site, posts, albums] = await Promise.all([B.getJSON('content/site.json'), B.getJSON('content/posts.json'), B.getJSON('content/albums.json')]);
      S.site = site;
      S.posts = posts.sort((a, b) => (a.created < b.created ? 1 : -1));
      S.albums = albums.filter((a) => a.photos && a.photos.length);
    } catch (e) {
      main.innerHTML = `<p class="empty">內容載入失敗，請稍後重新整理。<br><small>${esc(e.message)}</small></p>`;
      return;
    }
    S.be = B.makeBackend(S.site.firebase);
    if (loc.get('blog_admin_token')) document.body.classList.add('is-owner');
    document.title = S.site.title || '部落格';
    $('#foot').innerHTML = `${esc(S.site.footer || '')} <span class="owner-only">· <a href="admin.html">後台</a></span>`;
    window.addEventListener('hashchange', route);
    route();
    renderRail();
    countVisit();
  }

  /* ---------- 計數 ---------- */
  async function countVisit() {
    try {
      if (!ses.get('blog_visited')) { ses.set('blog_visited', '1'); await S.be.hit('site'); }
      S.counts = await S.be.counts(); S.counted = true;
    } catch (e) { console.warn('計數讀取失敗', e); }
    paintCounts();
  }
  async function countPost(slug) {
    const k = 'blog_v_' + slug;
    if (ses.get(k)) return;
    ses.set(k, '1');
    try { await S.be.hit('post__' + slug); S.counts['post__' + slug] = (S.counts['post__' + slug] || 0) + 1; paintCounts(); } catch (e) { console.warn(e); }
  }
  function paintCounts() {
    $$('[data-c]').forEach((el) => { const n = S.counts[el.dataset.c]; el.textContent = n == null ? (S.counted ? '0' : '–') : n.toLocaleString(); });
  }

  /* ---------- 路由 ---------- */
  function route() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, qs = ''] = raw.split('?');
    const parts = path.split('/').map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } });
    const q = Object.fromEntries(new URLSearchParams(qs));
    const [a, ...r] = parts;
    const rest = r.join('/');
    let nav = 'posts';
    if (a === 'post' && postBySlug(rest)) viewPost(rest);
    else if (a === 'tag') viewPosts(rest);
    else if (a === 'about') { nav = 'about'; viewAbout(); }
    else if (a === 'albums') { nav = 'albums'; viewAlbums(); }
    else if (a === 'album') { nav = 'albums'; viewAlbum(rest); }
    else if (a === 'forum') { nav = 'forum'; rest === 'new' ? viewNewThread(q.post) : rest ? viewThread(rest) : viewForum(q.post); }
    else viewPosts('');
    renderChrome(nav, a === 'tag' ? rest : null);
    paintCounts();
    window.scrollTo(0, 0);
  }

  /* ---------- 側欄、手機頁首 ---------- */
  function photoBox(p) {
    return p.photo ? `<span class="photo"><img src="${esc(p.photo)}" alt="${esc(p.name)}"></span>` : `<span class="photo none">${esc((p.name || '我').slice(0, 1))}</span>`;
  }
  const NAV = [['posts', '#/', '文章'], ['forum', '#/forum', '互動區'], ['albums', '#/albums', '相簿'], ['about', '#/about', '關於我']];
  function renderChrome(nav, tag) {
    const p = S.site.profile || {};
    const tags = B.tagList(S.posts, S.site.tagOrder);
    const navHtml = NAV.map(([k, h, t]) => `<a href="${h}" class="${k === nav ? 'on' : ''}">${t}</a>`).join('');
    $('#side').innerHTML = `
      <div class="card me">
        <a href="#/about">${photoBox(p)}</a>
        <h1>${esc(S.site.title || p.name || '')}</h1>
        <p>${esc(S.site.subtitle || p.tagline || '')}</p>
        <a class="more" href="#/about">關於我 →</a>
      </div>
      <nav class="nav">${navHtml}</nav>
      <div class="card box">
        <h3>主題關鍵字</h3>
        <ul class="taglist">
          <li><a href="#/" class="${nav === 'posts' && tag === null && !location.hash.startsWith('#/post') ? 'on' : ''}"><span>全部文章</span><small>${S.posts.length}</small></a></li>
          ${tags.map((t) => `<li><a href="${href('tag', t.name)}" class="${t.name === tag ? 'on' : ''}"><span># ${esc(t.name)}</span><small>${t.count}</small></a></li>`).join('')}
        </ul>
      </div>
      ${S.albums.length ? `<div class="card box"><h3>相簿</h3><ul class="alblist">${S.albums.map((a) => `<li><a href="${href('album', a.id)}"><span>${esc(a.title)}</span><small>${a.photos.length} 張</small></a></li>`).join('')}</ul></div>` : ''}
      <div class="card box stat">拜訪人次<b data-c="site">–</b></div>`;
    $('#mhead').innerHTML = `
      <a class="top" href="#/about">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : `<i>${esc((p.name || '我').slice(0, 1))}</i>`}<b>${esc(S.site.title || '')}</b><small>拜訪 <span data-c="site">–</span></small></a>
      <nav>${navHtml}</nav>`;
  }

  /* ---------- 右欄：最新討論、相簿 ---------- */
  async function renderRail() {
    const rail = $('#rail');
    const covers = S.albums.slice(0, 4).map((a) => `<a href="${href('album', a.id)}"><img loading="lazy" src="${esc(coverOf(a))}" alt=""><span>${esc(a.title)}</span></a>`).join('');
    rail.innerHTML = `
      <div class="card box"><h3>最新討論</h3><ul class="mini" id="rail-threads"><li><small>載入中…</small></li></ul><p style="margin:8px 0 0;font-size:14px"><a href="#/forum/new">＋ 我要提問</a></p></div>
      ${covers ? `<div class="card box"><h3>相簿</h3><div class="covers">${covers}</div></div>` : ''}`;
    try {
      const list = (await threads()).slice(0, 5);
      $('#rail-threads').innerHTML = list.length
        ? list.map((t) => `<li><a href="${href('forum', t.id)}">${esc(t.title)}</a><small>${esc(t.nick)} · ${fmt(t.lastAt, false)} · 回覆 ${t.replyCount || 0}</small></li>`).join('')
        : '<li><small>還沒有人發問，來當第一個吧。</small></li>';
    } catch (e) { $('#rail-threads').innerHTML = '<li><small>討論載入失敗</small></li>'; }
  }
  const coverOf = (a) => { const c = a.photos.find((p) => p.src === a.cover) || a.photos[0]; return c.thumb || c.src; };
  async function threads(fresh) {
    if (!S.threads || fresh) S.threads = await S.be.listThreads();
    return S.threads;
  }

  /* ---------- 文章列表 ---------- */
  function stamps(o) {
    return `<div class="stamps"><span><b>建立</b>${fmt(o.created)}</span>${o.updated ? `<span><b>修改</b>${fmt(o.updated)}</span>` : ''}</div>`;
  }
  function postCard(p) {
    return `<a class="card pcard" href="${href('post', p.slug)}">
      <div class="t"><h2>${esc(p.title)}</h2>
        <div class="meta"><span>${fmt(p.created, false)}</span><span>點閱 <span data-c="post__${esc(p.slug)}">–</span></span></div>
        ${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ''}
        <div class="tags">${(p.tags || []).map((t) => `<span class="chip"># ${esc(t)}</span>`).join('')}</div>
      </div>${p.cover ? `<img class="cover" loading="lazy" src="${esc(p.cover)}" alt="">` : ''}</a>`;
  }
  function viewPosts(tag) {
    const all = tag ? S.posts.filter((p) => (p.tags || []).includes(tag)) : S.posts;
    const tags = B.tagList(S.posts, S.site.tagOrder);
    let shown = PAGE, kw = '';
    main.innerHTML = `
      <div class="vhead"><h1>${tag ? '# ' + esc(tag) : '所有文章'}</h1><span class="n">${all.length} 篇・新的在前</span><span class="sp"></span>
        <input type="search" id="kw" placeholder="搜尋標題或內容…" aria-label="搜尋文章"></div>
      <div class="tagstrip"><a class="chip ${tag ? '' : 'on'}" href="#/">全部</a>${tags.map((t) => `<a class="chip ${t.name === tag ? 'on' : ''}" href="${href('tag', t.name)}"># ${esc(t.name)} ${t.count}</a>`).join('')}</div>
      <div id="plist"></div><div class="morebox" id="more"></div>`;
    const paint = () => {
      const list = kw ? all.filter((p) => (p.title + ' ' + (p.excerpt || '') + ' ' + (p.tags || []).join(' ')).toLowerCase().includes(kw)) : all;
      $('#plist').innerHTML = list.length ? list.slice(0, shown).map(postCard).join('') : `<p class="empty">${S.posts.length ? '找不到符合的文章。' : '還沒有文章。'}</p>`;
      $('#more').innerHTML = list.length > shown ? `<button class="btn ghost" id="morebtn">看更多（還有 ${list.length - shown} 篇）</button>` : '';
      const mb = $('#morebtn'); if (mb) mb.onclick = () => { shown += PAGE; paint(); };
      paintCounts();
    };
    $('#kw').oninput = (e) => { kw = e.target.value.trim().toLowerCase(); shown = PAGE; paint(); };
    paint();
  }

  /* ---------- 文章內頁 ---------- */
  function enhance(root) {
    // YouTube：存檔時是一個連結，顯示時換成可以直接播放的影片
    $$('.video[data-youtube]', root).forEach((v) => embed(v, v.dataset.youtube));
    $$('p', root).forEach((p) => {
      const t = p.textContent.trim();
      if (/^https?:\/\/\S+$/.test(t) && !p.querySelector('img')) { const id = B.ytId(t); if (id) { const d = document.createElement('div'); d.className = 'video'; p.replaceWith(d); embed(d, id); } }
    });
    $$('a[href^="http"]', root).forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
    const imgs = $$('img', root);
    imgs.forEach((im, i) => { im.loading = 'lazy'; im.onclick = () => lightbox(imgs.map((x) => ({ src: x.src, caption: x.alt })), i); });
  }
  function embed(el, id) {
    if (!/^[\w-]{11}$/.test(id || '')) return;
    el.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}" title="YouTube 影片" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
  }
  async function viewPost(slug) {
    const p = postBySlug(slug);
    const i = S.posts.indexOf(p), newer = S.posts[i - 1], older = S.posts[i + 1];
    main.innerHTML = `
      <a class="back" href="#/">← 回文章列表</a>
      <article class="card article">
        <h1>${esc(p.title)}</h1>
        <div class="tags">${(p.tags || []).map((t) => `<a class="chip" href="${href('tag', t)}"># ${esc(t)}</a>`).join('')}</div>
        <div class="prose" id="body"><p class="loading">載入中…</p></div>
        <footer>
          ${stamps(p)}
          <div class="stamps" style="margin-top:8px"><span><b>點閱</b><span data-c="post__${esc(slug)}">–</span> 次</span></div>
          <div class="discuss">
            <a class="btn" href="#/forum/new?post=${encodeURIComponent(slug)}">對這篇有想法？到互動區發問</a>
            <a href="#/forum?post=${encodeURIComponent(slug)}">看這篇的討論<span id="dcount"></span></a>
            <a class="owner-only" href="admin.html#edit/${encodeURIComponent(slug)}">✎ 編輯這篇</a>
          </div>
        </footer>
      </article>
      <nav class="pn">${older ? `<a class="card" href="${href('post', older.slug)}"><small>← 較早的一篇</small>${esc(older.title)}</a>` : '<span></span>'}${newer ? `<a class="card" href="${href('post', newer.slug)}"><small>較新的一篇 →</small>${esc(newer.title)}</a>` : '<span></span>'}</nav>`;
    countPost(slug);
    threads().then((l) => { const n = l.filter((t) => t.postSlug === slug).length; const el = $('#dcount'); if (el) el.textContent = `（${n}）`; }).catch(() => {});
    try {
      const html = await B.getText(`content/posts/${slug}.html`);
      if (!location.hash.includes(encodeURIComponent(slug)) && !location.hash.includes(slug)) return;
      const body = $('#body'); body.innerHTML = html; enhance(body);
    } catch (e) { $('#body').innerHTML = '<p class="empty">這篇文章的內容讀不到，可能剛發布還在更新，請過一分鐘再試。</p>'; }
  }

  /* ---------- 個人頁 ---------- */
  function contactLine(c) {
    c = (c || '').trim();
    if (!c) return '';
    const link = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c) ? `<a href="mailto:${esc(c)}">${esc(c)}</a>`
      : /^https?:\/\//.test(c) ? `<a href="${esc(c)}" target="_blank" rel="noopener">${esc(c)}</a>` : esc(c);
    return `<p class="contact">聯絡方式：${link}</p>`;
  }
  function viewAbout() {
    const p = S.site.profile || {};
    main.innerHTML = `
      <article class="card article">
        <div class="about-top">${photoBox(p)}
          <div><h1>${esc(p.name || '')}</h1><p>${esc(p.tagline || '')}</p>
            ${contactLine(p.contact)}
            ${p.orcid ? `<p class="contact">ORCID：<a href="https://orcid.org/${esc(p.orcid)}" target="_blank" rel="noopener">${esc(p.orcid)}</a></p>` : ''}
            ${p.nstcUrl ? `<a class="btn ghost" href="${esc(p.nstcUrl)}" target="_blank" rel="noopener">國科會個人頁面 ↗</a>` : ''}
            <a class="owner-only" href="admin.html#profile" style="margin-left:10px">✎ 編輯</a></div>
        </div>
        <div class="prose" id="body">${p.html || ''}</div>
        <footer>${stamps(p)}</footer>
      </article>`;
    enhance($('#body'));
  }

  /* ---------- 相簿 ---------- */
  function viewAlbums() {
    main.innerHTML = `<div class="vhead"><h1>相簿</h1><span class="n">${S.albums.length} 本</span></div>` +
      (S.albums.length
        ? `<div class="albums">${S.albums.map((a) => `<a class="alb" href="${href('album', a.id)}"><img loading="lazy" src="${esc(coverOf(a))}" alt=""><h2>${esc(a.title)}</h2><small>${a.photos.length} 張 · ${fmt(a.created, false)}</small></a>`).join('')}</div>`
        : '<p class="empty">還沒有相簿。</p>');
  }
  function viewAlbum(id) {
    const a = S.albums.find((x) => x.id === id);
    if (!a) return viewAlbums();
    main.innerHTML = `
      <a class="back" href="#/albums">← 回相簿列表</a>
      <div class="vhead"><h1>${esc(a.title)}</h1><span class="n">${a.photos.length} 張</span></div>
      ${a.desc ? `<p class="desc">${esc(a.desc)}</p>` : ''}
      ${stamps(a)}
      <div class="photos">${a.photos.map((p, i) => `<figure data-i="${i}"><img loading="lazy" src="${esc(p.thumb || p.src)}" alt="${esc(p.caption || '')}">${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}</figure>`).join('')}</div>`;
    $$('.photos figure').forEach((f) => (f.onclick = () => lightbox(a.photos, +f.dataset.i)));
  }

  /* ---------- 看大圖 ---------- */
  const LB = { list: [], i: 0 };
  function lightbox(list, i) { LB.list = list; LB.i = i; $('#lb').hidden = false; lbShow(); }
  function lbShow() {
    const p = LB.list[LB.i];
    $('#lb-img').src = p.src; $('#lb-cap').textContent = (p.caption ? p.caption + '　' : '') + (LB.list.length > 1 ? `${LB.i + 1} / ${LB.list.length}` : '');
    $$('.lb-nav').forEach((b) => (b.style.display = LB.list.length > 1 ? '' : 'none'));
  }
  function lbMove(d) { LB.i = (LB.i + d + LB.list.length) % LB.list.length; lbShow(); }
  $('#lb').addEventListener('click', (e) => {
    const k = e.target.dataset.lb;
    if (k === 'prev') lbMove(-1); else if (k === 'next') lbMove(1); else if (e.target.id !== 'lb-img') $('#lb').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if ($('#lb').hidden) return;
    if (e.key === 'Escape') $('#lb').hidden = true; else if (e.key === 'ArrowLeft') lbMove(-1); else if (e.key === 'ArrowRight') lbMove(1);
  });
  let tx = null;
  $('#lb').addEventListener('touchstart', (e) => (tx = e.touches[0].clientX), { passive: true });
  $('#lb').addEventListener('touchend', (e) => { if (tx == null) return; const dx = e.changedTouches[0].clientX - tx; tx = null; if (Math.abs(dx) > 50 && LB.list.length > 1) lbMove(dx < 0 ? 1 : -1); });

  /* ---------- 互動區 ---------- */
  const demoNote = () => (S.be.mode === 'local' ? '<div class="notice">目前是示範模式：互動區還沒接上資料庫，這裡的留言只會存在你這台瀏覽器。</div>' : '');
  const text = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener nofollow">$1</a>');
  function reLine(t) {
    const p = t.postSlug && postBySlug(t.postSlug);
    const title = p ? p.title : t.postTitle;
    if (!t.postSlug) return '<div class="re gen">一般提問</div>';
    return p ? `<div class="re">回應文章：<a href="${href('post', p.slug)}">《${esc(title)}》</a></div>` : `<div class="re gen">回應文章：《${esc(title)}》（文章已移除）</div>`;
  }
  async function viewForum(postSlug) {
    main.innerHTML = `
      <div class="vhead"><h1>互動區</h1><span class="n" id="fn"></span><span class="sp"></span>
        <select id="ff" aria-label="篩選"><option value="">全部主題</option></select>
        <a class="btn" href="#/forum/new${postSlug ? '?post=' + encodeURIComponent(postSlug) : ''}">＋ 發表新主題</a></div>
      ${demoNote()}<div id="tlist"><p class="loading">載入中…</p></div>`;
    let list;
    try { list = await threads(true); } catch (e) { $('#tlist').innerHTML = '<p class="empty">討論載入失敗，請稍後再試。</p>'; return; }
    if (!$('#ff')) return;
    const slugs = [...new Set(list.map((t) => t.postSlug).filter(Boolean))];
    $('#ff').innerHTML = '<option value="">全部主題</option><option value="-">一般提問</option>' +
      slugs.map((s) => { const p = postBySlug(s); return `<option value="${esc(s)}">回應：${esc(p ? p.title : (list.find((t) => t.postSlug === s) || {}).postTitle || s)}</option>`; }).join('');
    const paint = (f) => {
      const l = f === '-' ? list.filter((t) => !t.postSlug) : f ? list.filter((t) => t.postSlug === f) : list;
      $('#fn').textContent = `${l.length} 個主題`;
      $('#tlist').innerHTML = l.length
        ? l.map((t) => `<div class="card thread">${reLine(t)}<h2><a href="${href('forum', t.id)}">${esc(t.title)}</a></h2><div class="stamps"><span><b>${esc(t.nick)}</b>${fmt(t.createdAt)}</span><span><b>回覆</b>${t.replyCount || 0}</span></div></div>`).join('')
        : '<p class="empty">這裡還沒有主題。想問什麼、想聊什麼，都可以發一個。</p>';
    };
    if (postSlug && slugs.includes(postSlug)) $('#ff').value = postSlug;
    $('#ff').onchange = (e) => paint(e.target.value);
    paint(postSlug && !slugs.includes(postSlug) ? postSlug : $('#ff').value);
  }

  function guard(form) {
    if (form.website && form.website.value) return '送出失敗';
    const last = +loc.get('blog_last_post') || 0;
    if (Date.now() - last < 20000) return '剛剛才送出過，請等個二十秒再送。';
    return '';
  }
  function viewNewThread(preSlug) {
    main.innerHTML = `
      <a class="back" href="#/forum">← 回互動區</a>
      <div class="vhead"><h1>發表新主題</h1></div>${demoNote()}
      <form class="card form" id="tf">
        <label for="f-post">這個主題要回應哪篇文章？</label>
        <select id="f-post"><option value="">不針對特定文章（一般提問）</option>${S.posts.map((p) => `<option value="${esc(p.slug)}" ${p.slug === preSlug ? 'selected' : ''}>${fmt(p.created, false)}　${esc(p.title)}</option>`).join('')}</select>
        <label for="f-nick">你的暱稱</label><input type="text" id="f-nick" maxlength="30" required value="${esc(loc.get('blog_nick') || '')}">
        <label for="f-title">主題</label><input type="text" id="f-title" maxlength="80" required>
        <label for="f-body">內容</label><textarea id="f-body" maxlength="5000" required></textarea>
        <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <div class="row"><button class="btn" type="submit">送出</button><span class="err" id="f-err"></span></div>
      </form>`;
    $('#tf').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, err = $('#f-err');
      const d = { nick: $('#f-nick').value.trim(), title: $('#f-title').value.trim(), body: $('#f-body').value.trim(), postSlug: $('#f-post').value };
      d.postTitle = d.postSlug ? postBySlug(d.postSlug).title.slice(0, 190) : '';
      if (!d.nick || !d.title || !d.body) { err.textContent = '暱稱、主題、內容都要填喔。'; return; }
      const g = guard(f); if (g) { err.textContent = g; return; }
      const btn = $('button', f); btn.disabled = true; err.textContent = '';
      try {
        const id = await S.be.createThread(d);
        loc.set('blog_nick', d.nick); loc.set('blog_last_post', Date.now());
        S.threads = null; renderRail(); location.hash = href('forum', id);
      } catch (x) { console.warn(x); err.textContent = '送出失敗，請稍後再試。'; btn.disabled = false; }
    };
  }
  async function viewThread(id) {
    main.innerHTML = `<a class="back" href="#/forum">← 回互動區</a><div id="tv"><p class="loading">載入中…</p></div>`;
    let t, rs;
    try { [t, rs] = await Promise.all([S.be.getThread(id), S.be.listReplies(id)]); } catch (e) { $('#tv').innerHTML = '<p class="empty">找不到這個主題。</p>'; return; }
    if (!$('#tv')) return;
    const p = t.postSlug && postBySlug(t.postSlug);
    const banner = p
      ? `<a class="re-banner" href="${href('post', p.slug)}">這個主題在回應文章（點這裡看原文）<b>《${esc(p.title)}》 →</b></a>`
      : t.postSlug ? `<div class="re-banner">這個主題在回應文章<b>《${esc(t.postTitle)}》（文章已移除）</b></div>` : '';
    $('#tv').innerHTML = `${banner}${demoNote()}
      <div class="card msg q"><h1>${esc(t.title)}</h1><div class="who"><b>${esc(t.nick)}</b>${fmt(t.createdAt)}</div><div class="txt">${text(t.body)}</div></div>
      ${rs.map((r) => `<div class="card msg"><div class="who"><b>${esc(r.nick)}</b>${fmt(r.createdAt)}</div><div class="txt">${text(r.body)}</div></div>`).join('')}
      <form class="card form" id="rf">
        <label for="r-nick">你的暱稱</label><input type="text" id="r-nick" maxlength="30" required value="${esc(loc.get('blog_nick') || '')}">
        <label for="r-body">回覆內容</label><textarea id="r-body" maxlength="5000" required></textarea>
        <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <div class="row"><button class="btn" type="submit">回覆</button><span class="err" id="r-err"></span></div>
      </form>`;
    $('#rf').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, err = $('#r-err');
      const d = { nick: $('#r-nick').value.trim(), body: $('#r-body').value.trim() };
      if (!d.nick || !d.body) { err.textContent = '暱稱和內容都要填喔。'; return; }
      const g = guard(f); if (g) { err.textContent = g; return; }
      const btn = $('button', f); btn.disabled = true;
      try {
        await S.be.reply(id, d);
        loc.set('blog_nick', d.nick); loc.set('blog_last_post', Date.now());
        S.threads = null; renderRail(); viewThread(id);
      } catch (x) { console.warn(x); err.textContent = '送出失敗，請稍後再試。'; btn.disabled = false; }
    };
  }

  init();
})();
