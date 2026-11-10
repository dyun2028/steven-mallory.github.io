(() => {
  'use strict';

  const cfg = window.IMAGEBOARD_CONFIG || {};
  const root = document.getElementById('imageboard-root');
  const BASE = (cfg.SUPABASE_URL || '').replace(/\/+$/, '');
  const MAX_BYTES = 5 * 1024 * 1024;
  const THUMB_PX = 250;
  const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

  let nav = 0;
  let boardsCache = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (s) => new Date(s).toLocaleString();
  const fileUrl = (path) => `${BASE}/storage/v1/object/public/imageboard/${path}`;

  // ---------- Supabase over plain fetch (no third-party scripts) ----------
  const authHeaders = () => ({ apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}` });

  async function failure(r) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); msg = j.message || j.error || msg; } catch (_) { /* keep default */ }
    return new Error(msg);
  }

  async function rest(path, opts = {}) {
    const r = await fetch(`${BASE}/rest/v1/${path}`, {
      ...opts,
      headers: { ...authHeaders(), 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (!r.ok) throw await failure(r);
    return r.status === 204 ? null : r.json();
  }

  const rpc = (fn, args) => rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

  async function upload(path, blob, type) {
    const r = await fetch(`${BASE}/storage/v1/object/imageboard/${path}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': type, 'cache-control': 'max-age=31536000' },
      body: blob,
    });
    if (!r.ok) throw await failure(r);
  }

  async function getBoards() {
    if (!boardsCache) boardsCache = await rest('boards?select=*&order=sort.asc,id.asc');
    return boardsCache;
  }

  // ---------- images ----------
  async function prepareImage(file) {
    const ext = TYPES[file.type];
    if (!ext) throw new Error('Image must be PNG, JPEG, GIF or WebP.');
    if (file.size > MAX_BYTES) throw new Error('Image must be 5 MB or smaller.');
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (_) { throw new Error('Could not read that image.'); }
    const scale = Math.min(1, THUMB_PX / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const thumb = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
    const out = { ext, thumb, width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  }

  async function uploadImage(file) {
    if (!file || !file.size) return null;
    const img = await prepareImage(file);
    const id = crypto.randomUUID();
    const full = `full/${id}.${img.ext}`;
    const thumb = `thumbs/${id}.jpg`;
    await upload(full, file, file.type);
    await upload(thumb, img.thumb, 'image/jpeg');
    return { file_path: full, thumb_path: thumb, original_name: file.name.slice(0, 64), width: img.width, height: img.height };
  }

  // ---------- rendering ----------
  const setHtml = (html) => { root.innerHTML = html; };

  function fmtBody(body, tid) {
    return esc(body).split('\n').map((line) => {
      const quote = line.startsWith('&gt;') && !line.startsWith('&gt;&gt;');
      const html = line.replace(/&gt;&gt;(\d+)/g,
        (_, id) => `<a href="#/t/${tid}" class="ref" data-ref="${id}">&gt;&gt;${id}</a>`);
      return quote ? `<span class="quote">${html}</span>` : html;
    }).join('<br>');
  }

  function renderNav(boards) {
    document.getElementById('boardnav').innerHTML =
      boards.map((b) => `[<a href="#/b/${esc(b.id)}">/${esc(b.id)}/</a>]`).join(' ');
  }

  function formHtml(kind) {
    const isThread = kind === 'thread';
    return `
      <div class="reply_form">
        <form data-kind="${kind}">
          <div><label for="f-user">user</label><input type="text" id="f-user" name="username" maxlength="16" placeholder="anon"></div>
          ${isThread ? '<div><label for="f-title">title</label><input type="text" id="f-title" name="subject" maxlength="100"></div>' : ''}
          <div><label for="f-body">${isThread ? 'full text' : 'reply text'}</label><textarea id="f-body" name="body" rows="4" maxlength="2000"></textarea></div>
          <div><label for="f-file">${isThread ? 'image (required)' : 'image (optional)'}</label>
            <input type="file" id="f-file" name="file" accept="image/png,image/jpeg,image/gif,image/webp"${isThread ? ' required' : ''}></div>
          <button type="submit">${isThread ? 'upload it!' : 'reply'}</button>
          <p class="hint">PNG, JPEG, GIF or WebP up to 5 MB. Posts are public, and you can't edit or delete them. Don't post anything illegal.</p>
          <p class="error" role="alert"></p>
        </form>
      </div>`;
  }

  function postHtml(p, tid) {
    const img = p.file_path ? `
      <a href="${esc(fileUrl(p.file_path))}" target="_blank" rel="noopener">
        <img src="${esc(fileUrl(p.thumb_path))}" alt="${esc(p.original_name || 'attachment')}" loading="lazy">
      </a>` : '';
    return `
      <div class="post_in_thread" id="p${Number(p.id)}">
        <span class="post-user">${esc(p.post_user)}</span>
        <p>${fmtBody(p.body, tid)}</p>
        ${img}
        <span class="timestamp">${esc(when(p.created_at))} · <a href="#/t/${tid}" data-reply="${Number(p.id)}">No. ${Number(p.id)}</a></span>
      </div>`;
  }

  const errorPage = (img, msg) => setHtml(`<div class="errorpage"><h2>${esc(msg)}</h2><a href="#/">back home</a><img src="${img}" alt=""></div>`);

  // ---------- views ----------
  function setupNeeded() {
    setHtml(`<h2>Not connected yet</h2>
      <p class="lead">Create a Supabase project, run <code>supabase/schema.sql</code> in its SQL editor, then put the project URL
      and public key in <code>static/imageboard/config.js</code>.</p>`);
  }

  async function showHome() {
    const my = ++nav;
    const boards = await getBoards();
    if (my !== nav) return;
    renderNav(boards);
    setHtml(`<h2>mychan</h2><p class="lead">Pick a board.</p>
      <ul class="board-list">${boards.map((b) => `
        <li><a href="#/b/${esc(b.id)}">/${esc(b.id)}/ ${esc(b.name)}</a><span>${esc(b.description)}</span></li>`).join('')}</ul>`);
  }

  async function showBoard(id) {
    const my = ++nav;
    const [boards, threads] = await Promise.all([
      getBoards(),
      rest(`thread_catalog?board=eq.${encodeURIComponent(id)}&order=bumped_at.desc&limit=50`),
    ]);
    if (my !== nav) return;
    renderNav(boards);
    const board = boards.find((b) => b.id === id);
    if (!board) return errorPage('404.png', 'Board not found');
    setHtml(`
      <h2>/${esc(board.id)}/ - ${esc(board.name)}</h2>
      <p class="actions"><a href="#/b/${esc(board.id)}/new">post new thread</a></p>
      ${threads.length ? `<div class="catalog">${threads.map((t) => `
        <div class="thread">
          <a class="thread-link" href="#/t/${Number(t.id)}">
            ${t.op_thumb_path ? `<img class="thread-thumb" src="${esc(fileUrl(t.op_thumb_path))}" alt="" loading="lazy">` : ''}
            <div class="thread-info">
              <span class="thread-subject">${esc(t.subject || '(no subject)')}</span>
              <span class="thread-by">By ${esc(t.original_poster_username)}</span>
              <span class="thread-text">${esc((t.op_body || '').slice(0, 120))}</span>
              <span class="thread-meta">${Number(t.reply_count)} ${t.reply_count === 1 ? 'reply' : 'replies'} · ${esc(when(t.created_at))}</span>
            </div>
          </a>
        </div>`).join('')}</div>` : '<p>No threads yet. Start one!</p>'}`);
  }

  async function showNewThread(id) {
    const my = ++nav;
    const boards = await getBoards();
    if (my !== nav) return;
    renderNav(boards);
    const board = boards.find((b) => b.id === id);
    if (!board) return errorPage('404.png', 'Board not found');
    setHtml(`<h2>New thread on /${esc(board.id)}/</h2>${formHtml('thread')}
      <p class="actions"><a href="#/b/${esc(board.id)}">back</a></p>`);
    bindForm(root.querySelector('form'), { board: board.id });
  }

  async function showThread(id) {
    const my = ++nav;
    const [boards, rows] = await Promise.all([
      getBoards(),
      rest(`threads?id=eq.${id}&select=*,posts(*)&posts.order=created_at.asc,id.asc`),
    ]);
    if (my !== nav) return;
    renderNav(boards);
    const t = rows[0];
    if (!t) return errorPage('404.png', 'Thread not found');
    setHtml(`
      <h2>${esc(t.subject || '(no subject)')}</h2>
      <p class="actions"><a href="#/b/${esc(t.board)}">&larr; back to /${esc(t.board)}/</a></p>
      ${t.posts.map((p) => postHtml(p, t.id)).join('')}
      <hr class="divider">
      ${formHtml('reply')}`);
    bindForm(root.querySelector('form'), { thread: t.id });
  }

  // ---------- forms ----------
  function bindForm(form, ctx) {
    const label = form.querySelector('button').textContent;
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = form.querySelector('.error');
      const btn = form.querySelector('button');
      const f = new FormData(form);
      err.textContent = '';
      btn.disabled = true;
      btn.textContent = 'posting…';
      try {
        const m = (await uploadImage(f.get('file'))) || {};
        const media = {
          p_file_path: m.file_path ?? null, p_thumb_path: m.thumb_path ?? null,
          p_original_name: m.original_name ?? null, p_width: m.width ?? null, p_height: m.height ?? null,
        };
        if (form.dataset.kind === 'thread') {
          const tid = await rpc('create_thread', {
            p_board: ctx.board, p_subject: f.get('subject') || '', p_username: f.get('username') || '',
            p_body: f.get('body') || '', ...media,
          });
          location.hash = `#/t/${tid}`;
        } else {
          await rpc('create_post', {
            p_thread_id: ctx.thread, p_username: f.get('username') || '', p_body: f.get('body') || '', ...media,
          });
          await showThread(ctx.thread);
        }
      } catch (e) {
        err.textContent = e.message || String(e);
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  }

  // "No. 12" inserts >>12 into the reply box; >>12 links scroll to that post.
  root.addEventListener('click', (ev) => {
    const reply = ev.target.closest('[data-reply]');
    const ref = ev.target.closest('[data-ref]');
    if (reply) {
      ev.preventDefault();
      const ta = root.querySelector('form textarea');
      if (ta) { ta.value += `>>${reply.dataset.reply}\n`; ta.focus(); }
    } else if (ref) {
      ev.preventDefault();
      const el = document.getElementById(`p${ref.dataset.ref}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1500);
      }
    }
  });

  // ---------- routing (hash-based, because GitHub Pages is static) ----------
  function route() {
    const [kind, arg, sub] = location.hash.replace(/^#\/?/, '').split('/');
    let view;
    if (kind === 'b' && arg && sub === 'new') view = showNewThread(arg);
    else if (kind === 'b' && arg) view = showBoard(arg);
    else if (kind === 't' && /^\d+$/.test(arg || '')) view = showThread(Number(arg));
    else view = showHome();
    view.catch((e) => setHtml(`<p class="error">Something went wrong: ${esc(e.message || e)}</p>`));
  }

  if (!BASE || BASE.includes('YOUR-PROJECT') || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY.includes('YOUR-')) {
    setupNeeded();
  } else {
    addEventListener('hashchange', route);
    route();
  }
})();
