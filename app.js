(function () {
  const CACHE = 'scorm-packages-v1';
  const RECENT_KEY = 'scorm-viewer:recent';
  const $ = (id) => document.getElementById(id);

  const MIME = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', xhtml: 'application/xhtml+xml',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
    json: 'application/json', xml: 'application/xml', xsd: 'application/xml', txt: 'text/plain; charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', m4v: 'video/mp4', vtt: 'text/vtt',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
    pdf: 'application/pdf', swf: 'application/x-shockwave-flash', wasm: 'application/wasm',
  };

  let current = null;   // { id, name, title, version, items, flat, base }
  let runtime = null;
  let activeItem = null;

  // ---------- Service worker ----------
  async function ensureSW() {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Trình duyệt không hỗ trợ Service Worker. Hãy mở trang qua http://localhost hoặc https.');
    }
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((res) => {
        navigator.serviceWorker.addEventListener('controllerchange', res, { once: true });
        setTimeout(res, 3000);
      });
    }
    if (!navigator.serviceWorker.controller) {
      throw new Error('Service Worker chưa sẵn sàng — hãy tải lại trang (F5) rồi thử lại.');
    }
  }

  // ---------- Tiện ích ----------
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const pkgBaseUrl = (id) => new URL('pkg/' + id + '/', location.href).href;
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  function setStatus(msg, isErr) {
    const el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isErr);
  }

  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch (_) { return []; }
  }
  function saveRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 20))); } catch (_) {}
  }

  // ---------- Phân tích imsmanifest.xml ----------
  const kids = (el, name) => Array.from(el ? el.children : []).filter((c) => c.localName === name);
  const kid = (el, name) => kids(el, name)[0] || null;
  const attrAny = (el, name) => {
    if (!el) return null;
    for (const a of el.attributes) if (a.localName.toLowerCase() === name.toLowerCase()) return a.value;
    return null;
  };
  const joinBase = (...parts) => parts.filter(Boolean).reduce((acc, p) => (/^[a-z]+:\/\//i.test(p) || p.startsWith('/') ? p : acc + p), '');

  function parseManifest(xmlText, manifestDir) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('imsmanifest.xml không hợp lệ.');
    const root = doc.documentElement;

    // Phiên bản SCORM
    const md = kid(root, 'metadata');
    const schemaVer = (kid(md, 'schemaversion') || {}).textContent || '';
    const version = /2004|CAM 1\.3/i.test(schemaVer) || /adlcp_v1p3/.test(xmlText) ? '2004' : '1.2';

    // Tài nguyên
    const rootBase = attrAny(root, 'base') || '';
    const resEl = kid(root, 'resources');
    const resBase = attrAny(resEl, 'base') || '';
    const resources = {};
    for (const r of kids(resEl, 'resource')) {
      const href = attrAny(r, 'href');
      resources[attrAny(r, 'identifier')] = {
        href: href ? joinBase(manifestDir, rootBase, resBase, attrAny(r, 'base') || '', href) : null,
        type: (attrAny(r, 'scormtype') || '').toLowerCase(),
      };
    }

    // Mục lục
    const orgsEl = kid(root, 'organizations');
    const orgs = kids(orgsEl, 'organization');
    const defId = attrAny(orgsEl, 'default');
    const org = orgs.find((o) => attrAny(o, 'identifier') === defId) || orgs[0];

    function textOf(el, name) { const c = kid(el, name); return c ? c.textContent.trim() : null; }

    function buildItem(el) {
      const ref = attrAny(el, 'identifierref');
      const res = ref ? resources[ref] : null;
      let href = res && res.href;
      const params = attrAny(el, 'parameters');
      if (href && params) {
        let p = params.trim();
        if (p.startsWith('?') && href.includes('?')) p = '&' + p.slice(1);
        else if (!p.startsWith('?') && !p.startsWith('#') && !p.startsWith('&')) p = (href.includes('?') ? '&' : '?') + p;
        href += p;
      }
      const ms = textOf(el, 'masteryscore');
      const sps = (() => {
        const seq = kid(el, 'sequencing'); const obj = seq && kid(seq, 'objectives');
        const prim = obj && kid(obj, 'primaryObjective');
        const mnm = prim && kid(prim, 'minNormalizedMeasure');
        return prim && attrAny(prim, 'satisfiedByMeasure') === 'true' && mnm ? mnm.textContent.trim() : null;
      })();
      return {
        id: attrAny(el, 'identifier'),
        title: textOf(el, 'title') || attrAny(el, 'identifier') || 'Không tên',
        href,
        visible: attrAny(el, 'isvisible') !== 'false',
        launchData: textOf(el, 'datafromlms') || textOf(el, 'dataFromLMS') || '',
        masteryScore: version === '2004' ? (sps != null ? +sps : null) : (ms != null && ms !== '' ? +ms : null),
        children: kids(el, 'item').map(buildItem),
      };
    }

    let items = org ? kids(org, 'item').map(buildItem) : [];
    const title = (org && textOf(org, 'title')) || 'Gói SCORM';

    if (!items.some(function has(i) { return i.href || i.children.some(has); })) {
      // Không có organization hợp lệ: dùng resource đầu tiên có href
      const first = Object.entries(resources).find(([, r]) => r.href);
      if (!first) throw new Error('Không tìm thấy trang khởi chạy trong manifest.');
      items = [{ id: first[0], title, href: first[1].href, visible: true, launchData: '', masteryScore: null, children: [] }];
    }

    const flat = [];
    (function walk(list) { for (const i of list) { if (i.href) flat.push(i); walk(i.children); } })(items);
    return { title, version, items, flat };
  }

  // ---------- Nạp gói ----------
  async function openZipFile(file) {
    setStatus('Đang chuẩn bị…');
    try {
      await ensureSW();
      setStatus('Đang giải nén ' + file.name + '…');
      const zip = await JSZip.loadAsync(file);
      const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
      const manifestPath = names
        .filter((n) => /(^|\/)imsmanifest\.xml$/i.test(n) && !n.startsWith('__MACOSX/'))
        .sort((a, b) => a.length - b.length)[0];
      if (!manifestPath) throw new Error('File zip không chứa imsmanifest.xml — đây không phải gói SCORM.');

      const id = hashStr(file.name + '|' + file.size + '|' + file.lastModified);
      const base = pkgBaseUrl(id);
      const cache = await caches.open(CACHE);
      await deletePackageCache(id);

      let done = 0;
      const queue = names.filter((n) => !n.startsWith('__MACOSX/'));
      const worker = async () => {
        while (queue.length) {
          const n = queue.shift();
          const blob = await zip.files[n].async('blob');
          const ext = (n.split('.').pop() || '').toLowerCase();
          await cache.put(base + encPath(n), new Response(blob, {
            headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': String(blob.size) },
          }));
          done++;
          if (done % 25 === 0) setStatus(`Đang giải nén… ${done}/${names.length} file`);
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));

      const xml = await zip.files[manifestPath].async('string');
      const manifestDir = dirOf(manifestPath);
      const pkg = parseManifest(xml, manifestDir);
      Object.assign(pkg, { id, name: file.name, manifestPath, baseUrl: base });

      const recent = getRecent().filter((r) => r.id !== id);
      recent.unshift({ id, name: file.name, title: pkg.title, manifestPath, size: file.size, date: Date.now() });
      saveRecent(recent);

      setStatus('');
      startPlayer(pkg);
    } catch (e) {
      console.error(e);
      setStatus(e.message || String(e), true);
    }
  }

  async function openRecent(r) {
    setStatus('Đang mở…');
    try {
      await ensureSW();
      const res = await (await caches.open(CACHE)).match(pkgBaseUrl(r.id) + encPath(r.manifestPath));
      if (!res) throw new Error('Gói này không còn trong bộ nhớ trình duyệt, hãy mở lại file zip.');
      const pkg = parseManifest(await res.text(), dirOf(r.manifestPath));
      Object.assign(pkg, { id: r.id, name: r.name, manifestPath: r.manifestPath, baseUrl: pkgBaseUrl(r.id) });
      setStatus('');
      startPlayer(pkg);
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  }

  async function deletePackageCache(id) {
    const cache = await caches.open(CACHE);
    const prefix = pkgBaseUrl(id);
    await Promise.all((await cache.keys()).filter((k) => k.url.startsWith(prefix)).map((k) => cache.delete(k)));
  }

  async function removeRecent(id) {
    await deletePackageCache(id);
    for (const k of Object.keys(localStorage)) if (k.startsWith('scorm:' + id + ':')) localStorage.removeItem(k);
    saveRecent(getRecent().filter((r) => r.id !== id));
    renderRecent();
  }

  // ---------- Trình phát ----------
  function setPlayerChrome(on, pkg) {
    $('home').hidden = on;
    $('player').hidden = !on;
    for (const id of ['btnClose', 'btnLog', 'versionBadge']) $(id).hidden = !on;
    const multi = on && pkg.flat.length > 1;
    $('btnPrev').hidden = $('btnNext').hidden = !multi;
    $('btnShare').hidden = !(on && pkg.slug);
    $('pkgTitle').textContent = on ? pkg.title : '';
    document.title = on ? pkg.title + ' — ' + siteName : siteName;
  }

  function startPlayer(pkg) {
    current = pkg;
    setPlayerChrome(true, pkg);
    $('versionBadge').textContent = 'SCORM ' + pkg.version;
    $('toc').hidden = pkg.flat.length <= 1 && !pkg.items.some((i) => i.children.length);
    renderToc();
    const resumeId = localStorage.getItem('scorm:' + pkg.id + ':last');
    launch(pkg.flat.find((i) => i.id === resumeId) || pkg.flat[0]);
  }

  function itemStatus(item) {
    try {
      const d = JSON.parse(localStorage.getItem('scorm:' + current.id + ':' + item.id)) || {};
      const s = d['cmi.core.lesson_status'];
      if (s && s !== 'not attempted') return s;
      if (d['cmi.success_status'] === 'passed' || d['cmi.success_status'] === 'failed') return d['cmi.success_status'];
      return d['cmi.completion_status'] && d['cmi.completion_status'] !== 'unknown' ? d['cmi.completion_status'] : '';
    } catch (_) { return ''; }
  }
  const STATUS_ICON = { completed: '✓', passed: '✓', failed: '✗', incomplete: '◐', browsed: '◐' };

  function renderToc() {
    const toc = $('toc');
    toc.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'org';
    head.textContent = current.title;
    toc.appendChild(head);
    const build = (list) => {
      const ul = document.createElement('ul');
      for (const it of list) {
        if (!it.visible) continue;
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'item ' + (it.href ? 'launchable' : 'folder') + (activeItem === it ? ' active' : '');
        const st = document.createElement('span');
        st.className = 'st';
        st.textContent = it.href ? (STATUS_ICON[itemStatus(it)] || '○') : '▾';
        const tx = document.createElement('span');
        tx.textContent = it.title;
        row.append(st, tx);
        if (it.href) row.onclick = () => launch(it);
        li.appendChild(row);
        if (it.children.length) li.appendChild(build(it.children));
        ul.appendChild(li);
      }
      return ul;
    };
    toc.appendChild(build(current.items));
  }

  function updateNav() {
    const i = current.flat.indexOf(activeItem);
    $('btnPrev').disabled = i <= 0;
    $('btnNext').disabled = i < 0 || i >= current.flat.length - 1;
  }

  function renderSummary(sum) {
    const el = $('cmiSummary');
    el.innerHTML = '';
    for (const [k, v] of Object.entries(sum || {})) {
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('span'); b.textContent = v;
      el.append(a, b);
    }
  }

  function log(line) {
    const pre = $('log');
    pre.textContent += line + '\n';
    if (pre.textContent.length > 200000) pre.textContent = pre.textContent.slice(-150000);
    pre.scrollTop = pre.scrollHeight;
  }

  function unloadFrame() {
    const frame = $('frame');
    return new Promise((res) => {
      if (!frame.src || frame.src === 'about:blank') return res();
      const t = setTimeout(res, 1500);
      frame.addEventListener('load', () => { clearTimeout(t); res(); }, { once: true });
      frame.src = 'about:blank';
    });
  }

  async function launch(item) {
    if (!item) return;
    await unloadFrame();   // cho SCO cũ gọi LMSFinish/Terminate
    activeItem = item;
    localStorage.setItem('scorm:' + current.id + ':last', item.id);

    const learnerName = localStorage.getItem('scorm-viewer:learner') || 'Khách, Học viên';
    runtime = new ScormRuntime({
      storageKey: 'scorm:' + current.id + ':' + item.id,
      learnerName,
      learnerId: 'local-learner',
      launchData: item.launchData,
      masteryScore: item.masteryScore,
      onLog: ({ api, fn, args, ret, err }) => {
        const t = new Date().toLocaleTimeString();
        log(`[${t}] ${fn}(${args.map((a) => JSON.stringify(a)).join(', ')}) → ${JSON.stringify(ret)}${err ? '  ⚠ lỗi ' + err : ''}`);
        if (fn === 'LMSFinish' || fn === 'Terminate' || fn === 'LMSCommit' || fn === 'Commit') renderToc();
      },
      onChange: renderSummary,
      onNavRequest: (req, afterTerminate) => {
        if (!afterTerminate) return;
        const i = current.flat.indexOf(activeItem);
        if (req === 'continue') launch(current.flat[i + 1]);
        else if (req === 'previous') launch(current.flat[i - 1]);
        else {
          const m = /^\{target=([^}]+)\}(choice|jump)$/.exec(req);
          if (m) launch(current.flat.find((x) => x.id === m[1]));
        }
      },
    });
    runtime.version = current.version;
    window.API = runtime.API;
    window.API_1484_11 = runtime.API_1484_11;
    renderSummary(runtime.summary());
    log(`—— Mở: ${item.title} (${item.href}) ——`);

    const url = /^[a-z]+:\/\//i.test(item.href) ? item.href : current.baseUrl + encPathKeepQuery(item.href);
    $('frame').src = url;
    renderToc();
    updateNav();
  }

  function encPathKeepQuery(href) {
    const m = /^([^?#]*)(.*)$/.exec(href);
    let path = m[1];
    try { path = decodeURIComponent(path); } catch (_) {}
    return encPath(path) + m[2];
  }

  async function closePlayer() {
    await unloadFrame();
    current = null; runtime = null; activeItem = null;
    delete window.API; delete window.API_1484_11;
    setPlayerChrome(false);
    renderRecent();
    renderCatalog();
  }

  // ---------- Danh mục khoá học (courses.json do scripts/build.py tạo ra) ----------
  let siteName = document.title;
  let catalog = [];
  const PALETTE = [['#2f6fed', '#6b9bff'], ['#0f9d7a', '#4fd1a5'], ['#c2410c', '#fb923c'], ['#7c3aed', '#a78bfa'],
    ['#be185d', '#f472b6'], ['#0369a1', '#38bdf8'], ['#4d7c0f', '#a3e635'], ['#b45309', '#fbbf24']];

  function courseProgress(c) {
    const prefix = 'scorm:c-' + c.slug + ':';
    let done = 0, started = false;
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(prefix) || k.endsWith(':last')) continue;
      started = true;
      try {
        const d = JSON.parse(localStorage.getItem(k)) || {};
        const s = d['cmi.core.lesson_status'] || d['cmi.success_status'];
        if (s === 'completed' || s === 'passed' || d['cmi.completion_status'] === 'completed') done++;
      } catch (_) {}
    }
    return { done: Math.min(done, c.lessons), started };
  }

  function renderCatalog() {
    const grid = $('catalog');
    grid.innerHTML = '';
    catalog.forEach((c, i) => {
      const card = document.createElement('button');
      card.className = 'card';
      const [c1, c2] = PALETTE[hashStr(c.slug).charCodeAt(0) % PALETTE.length] || PALETTE[i % PALETTE.length];
      card.style.setProperty('--c1', c1); card.style.setProperty('--c2', c2);
      const cover = document.createElement('div');
      cover.className = 'cover'; cover.textContent = '📘';
      const body = document.createElement('div'); body.className = 'body';
      const t = document.createElement('div'); t.className = 'title'; t.textContent = c.title;
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.textContent = c.lessons + ' bài · SCORM ' + c.version;
      const p = courseProgress(c);
      if (p.started) {
        const pr = document.createElement('span');
        const finished = p.done >= c.lessons;
        pr.className = 'prog ' + (finished ? 'done' : 'doing');
        pr.textContent = finished ? '✓ Đã hoàn thành' : `Đang học ${p.done}/${c.lessons}`;
        meta.append(' · ', pr);
      }
      body.append(t, meta);
      card.append(cover, body);
      card.onclick = () => openCourse(c, true);
      grid.appendChild(card);
    });
  }

  async function loadCatalog() {
    const st = $('catalogStatus');
    try {
      const res = await fetch('courses.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      catalog = await res.json();
      st.textContent = catalog.length ? `${catalog.length} khoá học — bấm vào một khoá để bắt đầu học.` : 'Chưa có khoá học nào.';
    } catch (_) {
      catalog = [];
      st.textContent = 'Chưa có danh mục khoá học (courses.json). Hãy chạy scripts/build.py hoặc đăng web lên GitHub Pages.';
      $('localWrap').open = true;
    }
    renderCatalog();
  }

  async function openCourse(c, push) {
    try {
      const baseUrl = new URL('courses/' + c.slug + '/', location.href).href;
      const res = await fetch(baseUrl + encPath(c.manifestPath));
      if (!res.ok) throw new Error('Không tải được imsmanifest.xml (' + res.status + ')');
      const pkg = parseManifest(await res.text(), dirOf(c.manifestPath));
      Object.assign(pkg, { id: 'c-' + c.slug, slug: c.slug, name: c.title, baseUrl });
      if (push) history.pushState({ course: c.slug }, '', '?course=' + encodeURIComponent(c.slug));
      startPlayer(pkg);
    } catch (e) {
      $('catalogStatus').textContent = 'Lỗi mở khoá học: ' + (e.message || e);
    }
  }

  async function routeFromUrl() {
    const slug = new URLSearchParams(location.search).get('course');
    const c = slug && catalog.find((x) => x.slug === slug);
    if (c) { if (!current || current.slug !== c.slug) { if (current) await closePlayer(); await openCourse(c, false); } }
    else if (current) await closePlayer();
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2500);
  }

  function renderRecent() {
    const list = getRecent();
    $('recentWrap').hidden = !list.length;
    const ul = $('recentList');
    ul.innerHTML = '';
    for (const r of list) {
      const li = document.createElement('li');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = r.title || r.name;
      name.title = r.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = new Date(r.date).toLocaleDateString('vi-VN');
      const open = document.createElement('button');
      open.className = 'btn small'; open.textContent = 'Mở';
      open.onclick = () => openRecent(r);
      const del = document.createElement('button');
      del.className = 'btn small danger'; del.textContent = 'Xoá';
      del.title = 'Xoá gói và tiến độ học';
      del.onclick = () => { if (confirm('Xoá gói "' + (r.title || r.name) + '" và toàn bộ tiến độ?')) removeRecent(r.id); };
      li.append(name, meta, open, del);
      ul.appendChild(li);
    }
  }

  // ---------- Sự kiện giao diện ----------
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) openZipFile(f);
    e.target.value = '';
  });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) openZipFile(f);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('btnPrev').onclick = () => launch(current.flat[current.flat.indexOf(activeItem) - 1]);
  $('btnNext').onclick = () => launch(current.flat[current.flat.indexOf(activeItem) + 1]);
  $('btnClose').onclick = () => {
    if (current && current.slug) history.pushState({}, '', location.pathname);
    closePlayer();
  };
  $('homeLink').onclick = (e) => { e.preventDefault(); $('btnClose').onclick(); };
  $('btnShare').onclick = async () => {
    const link = location.origin + location.pathname + '?course=' + encodeURIComponent(current.slug);
    try { await navigator.clipboard.writeText(link); toast('Đã sao chép link khoá học: ' + link); }
    catch (_) { prompt('Sao chép đường link này:', link); }
  };
  window.addEventListener('popstate', routeFromUrl);
  $('btnLog').onclick = () => { $('logPanel').hidden = !$('logPanel').hidden; };
  $('btnClearLog').onclick = () => { $('log').textContent = ''; };

  if (location.protocol === 'file:') {
    setStatus('⚠ Trang đang mở trực tiếp từ file. Hãy chạy qua máy chủ web (xem README) để SCORM hoạt động.', true);
  }
  renderRecent();
  loadCatalog().then(routeFromUrl);
})();
