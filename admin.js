// Trang quản trị: thêm / xoá khoá học bằng cách ghi trực tiếp vào thư mục courses/ của repository
// thông qua GitHub API. Sau mỗi thay đổi, GitHub Actions tự build lại và đăng web.
(function () {
  const $ = (id) => document.getElementById(id);
  const CFG_KEY = 'scorm-admin:config';
  const PART_MB = 90;       // GitHub giới hạn 100 MB/file → file lớn hơn được chia thành nhiều phần
  const MAX_TOTAL_MB = 900; // GitHub Pages giới hạn toàn bộ web 1 GB
  let cfg = null;      // { owner, repo, token, branch }
  let courses = [];    // [{ name, type: 'file'|'dir'|'parts', size, paths }]
  let catalog = [];    // courses.json của web đang chạy
  let pending = [];    // [{ file, name, title, error }]
  let pollTimer = null;

  // ---------- Tiện ích ----------
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3000);
  }
  function slugify(s) {
    s = s.replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFKD').replace(/[^\x00-\x7f]/g, '');
    return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'khoa-hoc';
  }
  const stem = (n) => n.replace(/\.zip$/i, '');
  const fmtSize = (b) => (b == null ? '' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.ceil(b / 1024) + ' KB');
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const siteUrl = () => new URL('./', location.href).href;
  const courseLink = (name) => {
    const c = catalog.find((x) => x.source === name);
    return siteUrl() + '?course=' + encodeURIComponent(c ? c.slug : slugify(stem(name)));
  };

  // ---------- GitHub API ----------
  async function gh(path, opts = {}) {
    const res = await fetch('https://api.github.com' + path, {
      ...opts,
      headers: {
        Authorization: 'Bearer ' + cfg.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message; } catch (_) {}
      const e = new Error(explain(res.status, msg));
      e.status = res.status;
      throw e;
    }
    return res.status === 204 ? null : res.json();
  }
  function explain(status, msg) {
    if (status === 401) return 'Mã truy cập không đúng hoặc đã hết hạn.';
    if (status === 403) return 'Mã truy cập không đủ quyền (cần quyền Contents: Read and write). ' + (msg || '');
    if (status === 404) return 'Không tìm thấy repository — kiểm tra tên tài khoản, tên repository và quyền của mã truy cập.';
    if (status === 409) return 'Repository đang trống hoặc bị xung đột, hãy thử lại.';
    if (status === 422) return 'GitHub từ chối dữ liệu: ' + (msg || '');
    return 'Lỗi GitHub ' + status + (msg ? ': ' + msg : '');
  }
  const R = () => '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo);

  function readBase64(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1] || '');
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(file);
    });
  }

  // Tạo 1 commit gồm nhiều thay đổi: adds [{path, file}], deletes [path, ...] (đường dẫn file)
  async function commit({ adds = [], deletes = [] }, message, onStep) {
    const ref = await gh(R() + '/git/ref/heads/' + encodeURIComponent(cfg.branch));
    const headSha = ref.object.sha;
    const head = await gh(R() + '/git/commits/' + headSha);
    const tree = deletes.map((path) => ({ path, mode: '100644', type: 'blob', sha: null }));
    for (let i = 0; i < adds.length; i++) {
      const a = adds[i];
      onStep && onStep(`Đang tải lên ${a.label || a.path} (${i + 1}/${adds.length}, ${fmtSize(a.file.size)})…`);
      const blob = await gh(R() + '/git/blobs', {
        method: 'POST', body: JSON.stringify({ content: await readBase64(a.file), encoding: 'base64' }),
      });
      tree.push({ path: a.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    onStep && onStep('Đang lưu thay đổi…');
    const newTree = await gh(R() + '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree }) });
    const c = await gh(R() + '/git/commits', {
      method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
    });
    await gh(R() + '/git/refs/heads/' + encodeURIComponent(cfg.branch), { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
    return c.sha;
  }

  // ---------- Đăng nhập ----------
  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)); } catch (_) { return null; }
  }
  function guessRepo() {
    const h = location.hostname;
    if (h.endsWith('.github.io')) {
      const owner = h.split('.')[0];
      const seg = location.pathname.split('/').filter(Boolean)[0];
      return { owner, repo: seg && !seg.endsWith('.html') ? seg : owner + '.github.io' };
    }
    return { owner: '', repo: '' };
  }

  function showLogin(msg) {
    $('loginPanel').hidden = false;
    $('mainPanel').hidden = true;
    $('btnLogout').hidden = true;
    const g = guessRepo();
    const old = loadCfg() || {};
    if (!$('inOwner').value) $('inOwner').value = old.owner || g.owner;
    if (!$('inRepo').value) $('inRepo').value = old.repo || g.repo;
    $('loginStatus').textContent = msg || '';
    $('loginStatus').classList.toggle('error', !!msg);
  }

  async function connect(c) {
    cfg = c;
    const repo = await gh(R());
    cfg.branch = repo.default_branch;
    if (repo.permissions && repo.permissions.push === false) throw new Error('Mã truy cập không có quyền ghi vào repository này.');
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    $('loginPanel').hidden = true;
    $('mainPanel').hidden = false;
    $('btnLogout').hidden = false;
    await Promise.all([refreshCourses(), loadCatalog()]);
    renderCourses();
    checkDeploy();
  }

  $('btnLogin').onclick = async () => {
    const c = { owner: $('inOwner').value.trim(), repo: $('inRepo').value.trim(), token: $('inToken').value.trim() };
    if (!c.owner || !c.repo || !c.token) { $('loginStatus').textContent = 'Hãy điền đủ 3 ô.'; return; }
    $('btnLogin').disabled = true;
    $('loginStatus').classList.remove('error');
    $('loginStatus').textContent = 'Đang kết nối…';
    try { await connect(c); } catch (e) { showLogin(e.message); } finally { $('btnLogin').disabled = false; }
  };
  $('btnLogout').onclick = () => {
    if (!confirm('Đăng xuất và xoá mã truy cập khỏi trình duyệt này?')) return;
    const c = loadCfg() || {};
    localStorage.setItem(CFG_KEY, JSON.stringify({ owner: c.owner, repo: c.repo }));
    cfg = null; clearTimeout(pollTimer);
    $('inToken').value = '';
    showLogin();
  };

  // ---------- Danh sách khoá học ----------
  async function refreshCourses() {
    try {
      const items = await gh(R() + '/contents/courses?ref=' + encodeURIComponent(cfg.branch) + '&t=' + Date.now());
      const map = {};
      for (const i of items) {
        if (i.name.startsWith('.')) continue;
        const part = /^(.+\.zip)\.part\d+$/i.exec(i.name);
        if (part && i.type === 'file') {
          const c = map[part[1]] || (map[part[1]] = { name: part[1], type: 'parts', size: 0, paths: [] });
          c.size += i.size; c.paths.push('courses/' + i.name);
        } else if (i.type === 'dir' || (i.type === 'file' && /\.zip$/i.test(i.name))) {
          map[i.name] = { name: i.name, type: i.type, size: i.type === 'file' ? i.size : null, paths: ['courses/' + i.name] };
        }
      }
      courses = Object.values(map).sort((a, b) => a.name.localeCompare(b.name, 'vi', { sensitivity: 'base' }));
    } catch (e) {
      if (e.status === 404) courses = []; else throw e;
    }
  }
  async function loadCatalog() {
    try { catalog = await (await fetch('courses.json', { cache: 'no-cache' })).json(); } catch (_) { catalog = []; }
  }

  function renderCourses() {
    const ul = $('courseList');
    ul.innerHTML = '';
    $('count').textContent = '(' + courses.length + ')';
    if (!courses.length) {
      const li = document.createElement('li');
      li.className = 'muted'; li.textContent = 'Chưa có khoá học nào. Hãy thêm ở phía trên.';
      ul.appendChild(li);
      return;
    }
    for (const c of courses) {
      const info = catalog.find((x) => x.source === c.name);
      const li = document.createElement('li');
      const box = document.createElement('div'); box.className = 'info';
      const t = document.createElement('div'); t.className = 't';
      t.textContent = info ? info.title : stem(c.name);
      const s = document.createElement('div'); s.className = 's';
      s.textContent = (c.type === 'dir' ? '📁 ' : '') + c.name + (c.size ? ' · ' + fmtSize(c.size) : '') +
        (info ? ' · ' + info.lessons + ' bài · SCORM ' + info.version : ' · đang cập nhật lên web…');
      box.append(t, s);
      const open = document.createElement('a');
      open.className = 'btn small'; open.textContent = 'Mở'; open.target = '_blank'; open.href = courseLink(c.name);
      const copy = document.createElement('button');
      copy.className = 'btn small'; copy.textContent = '🔗 Sao chép link';
      copy.onclick = async () => {
        const link = courseLink(c.name);
        try { await navigator.clipboard.writeText(link); toast('Đã sao chép: ' + link); } catch (_) { prompt('Sao chép link:', link); }
      };
      const del = document.createElement('button');
      del.className = 'btn small danger'; del.textContent = 'Xoá';
      del.onclick = () => removeCourse(c, del);
      li.append(box, open, copy, del);
      ul.appendChild(li);
    }
  }

  async function removeCourse(c, btn) {
    const title = (catalog.find((x) => x.source === c.name) || {}).title || c.name;
    if (!confirm(`Xoá khoá học "${title}"?\n\nNgười học sẽ không mở được khoá này nữa.`)) return;
    btn.disabled = true; btn.textContent = 'Đang xoá…';
    try {
      let paths = c.paths || ['courses/' + c.name];
      if (c.type === 'dir') {
        const ref = await gh(R() + '/git/ref/heads/' + encodeURIComponent(cfg.branch));
        const head = await gh(R() + '/git/commits/' + ref.object.sha);
        const tree = await gh(R() + '/git/trees/' + head.tree.sha + '?recursive=1');
        paths = tree.tree.filter((x) => x.type === 'blob' && x.path.startsWith('courses/' + c.name + '/')).map((x) => x.path);
      }
      const sha = await commit({ deletes: paths }, 'Xoá khoá học: ' + c.name);
      courses = courses.filter((x) => x !== c);
      renderCourses();
      toast('Đã xoá. Web sẽ cập nhật sau khoảng 1 phút.');
      watchDeploy(sha);
    } catch (e) {
      alert('Không xoá được: ' + e.message);
      btn.disabled = false; btn.textContent = 'Xoá';
    }
  }

  // ---------- Thêm khoá học ----------
  async function inspectZip(file) {
    const p = { file, name: file.name.replace(/[\\/]/g, '-'), title: '', error: '' };
    if (!/\.zip$/i.test(file.name)) { p.error = 'Không phải file .zip'; return p; }
    if (file.size > MAX_TOTAL_MB * 1048576) { p.error = `File quá lớn (${fmtSize(file.size)}). Tối đa ${MAX_TOTAL_MB} MB — hãy giảm dung lượng khi xuất bài giảng.`; return p; }
    try {
      const zip = await JSZip.loadAsync(file);
      const mPath = Object.keys(zip.files).filter((n) => /(^|\/)imsmanifest\.xml$/i.test(n) && !n.startsWith('__MACOSX/'))
        .sort((a, b) => a.length - b.length)[0];
      if (!mPath) { p.error = 'Không có imsmanifest.xml — đây không phải gói SCORM.'; return p; }
      const doc = new DOMParser().parseFromString(await zip.files[mPath].async('string'), 'application/xml');
      const orgs = doc.getElementsByTagNameNS('*', 'organization');
      const t = orgs[0] && Array.from(orgs[0].children).find((x) => x.localName === 'title');
      p.title = t ? t.textContent.trim() : '';
    } catch (e) {
      p.error = 'File zip bị hỏng hoặc không đúng định dạng.';
    }
    return p;
  }

  async function addFiles(files) {
    $('uploadStatus').textContent = 'Đang kiểm tra file…';
    for (const f of files) pending.push(await inspectZip(f));
    $('uploadStatus').textContent = '';
    renderPending();
  }

  function renderPending() {
    $('pendingWrap').hidden = !pending.length;
    const ul = $('pendingList');
    ul.innerHTML = '';
    pending.forEach((p, i) => {
      const li = document.createElement('li');
      const box = document.createElement('div'); box.className = 'info';
      const t = document.createElement('div'); t.className = 't';
      t.textContent = p.title || p.file.name;
      box.appendChild(t);
      if (p.error) {
        const e = document.createElement('div'); e.className = 'err'; e.textContent = '⚠ ' + p.error;
        box.appendChild(e);
      } else {
        const s = document.createElement('div'); s.className = 's';
        const lbl = document.createElement('label');
        lbl.textContent = 'Tên file (quyết định đường link, nên đặt ngắn gọn và không đổi về sau):';
        const inp = document.createElement('input');
        inp.value = stem(p.name);
        const linkPrev = document.createElement('div'); linkPrev.className = 's';
        const upd = () => {
          p.name = (inp.value.trim().replace(/[\\/]/g, '-') || 'khoa-hoc') + '.zip';
          const exists = courses.some((c) => c.name.toLowerCase() === p.name.toLowerCase());
          linkPrev.textContent = 'Link: ' + siteUrl() + '?course=' + slugify(stem(p.name)) +
            (exists ? '  ⚠ Trùng tên — sẽ THAY THẾ khoá học đang có' : '');
        };
        inp.oninput = upd; upd();
        const nParts = Math.ceil(p.file.size / (PART_MB * 1048576));
        s.textContent = fmtSize(p.file.size) + (nParts > 1 ? ` · file lớn, sẽ tự chia thành ${nParts} phần khi tải lên` : '');
        lbl.appendChild(inp);
        box.append(s, lbl, linkPrev);
      }
      const rm = document.createElement('button');
      rm.className = 'btn small'; rm.textContent = 'Bỏ';
      rm.onclick = () => { pending.splice(i, 1); renderPending(); };
      li.append(box, rm);
      ul.appendChild(li);
    });
    $('btnUpload').disabled = !pending.some((p) => !p.error);
  }

  $('btnCancel').onclick = () => { pending = []; renderPending(); };
  $('btnUpload').onclick = async () => {
    const ok = pending.filter((p) => !p.error);
    if (!ok.length) return;
    const names = ok.map((p) => p.name.toLowerCase());
    if (new Set(names).size !== names.length) { alert('Có 2 file trùng tên, hãy đổi tên một file.'); return; }
    $('btnUpload').disabled = $('btnCancel').disabled = true;
    const st = $('uploadStatus');
    st.classList.remove('error');
    try {
      const adds = [];
      for (const p of ok) {
        const size = PART_MB * 1048576;
        const n = Math.ceil(p.file.size / size);
        if (n <= 1) adds.push({ path: 'courses/' + p.name, file: p.file, label: p.name });
        else for (let k = 0; k < n; k++) {
          adds.push({
            path: 'courses/' + p.name + '.part' + String(k + 1).padStart(3, '0'),
            file: p.file.slice(k * size, (k + 1) * size),
            label: `${p.name} — phần ${k + 1}/${n}`,
          });
        }
      }
      // Thay thế khoá trùng tên: xoá các file cũ của khoá đó (trừ file sắp ghi đè)
      const newPaths = new Set(adds.map((a) => a.path));
      const deletes = [];
      for (const p of ok) {
        const old = courses.find((c) => c.name.toLowerCase() === p.name.toLowerCase());
        if (old && old.type !== 'dir') for (const x of old.paths || []) if (!newPaths.has(x)) deletes.push(x);
      }
      const sha = await commit(
        { adds, deletes },
        'Thêm khoá học: ' + ok.map((p) => p.name).join(', '),
        (m) => { st.textContent = m; },
      );
      st.textContent = '✓ Đã tải lên ' + ok.length + ' khoá học. Web sẽ cập nhật sau khoảng 1–2 phút.';
      pending = []; renderPending();
      await refreshCourses().catch(() => {});
      for (const p of ok) if (!courses.some((c) => c.name === p.name)) courses.push({ name: p.name, type: 'file', size: p.file.size, paths: [] });
      renderCourses();
      watchDeploy(sha);
    } catch (e) {
      st.textContent = 'Tải lên thất bại: ' + e.message;
      st.classList.add('error');
    } finally {
      $('btnUpload').disabled = $('btnCancel').disabled = false;
    }
  };

  $('fileInput').addEventListener('change', (e) => { addFiles(Array.from(e.target.files)); e.target.value = ''; });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles(Array.from(e.dataTransfer.files)));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // ---------- Trạng thái cập nhật web (GitHub Actions) ----------
  function setDeploy(state, text) {
    $('deploy').className = 'deploy ' + state;
    $('deployText').textContent = text;
  }

  async function latestRun(sha) {
    const q = '/actions/runs?per_page=1&branch=' + encodeURIComponent(cfg.branch) + (sha ? '&head_sha=' + sha : '');
    const r = await gh(R() + q);
    return r.workflow_runs[0] || null;
  }

  function describe(run) {
    if (!run) return ['', 'Chưa có lần cập nhật web nào.'];
    const when = new Date(run.updated_at).toLocaleString('vi-VN');
    if (run.status !== 'completed') return ['running', '⏳ Web đang được cập nhật… (thường mất 1–2 phút)'];
    if (run.conclusion === 'success') return ['ok', '✓ Web đã cập nhật xong lúc ' + when + '.'];
    if (run.conclusion === 'cancelled') return ['', 'Lần cập nhật lúc ' + when + ' đã được thay bằng lần mới hơn.'];
    return ['fail', '✗ Cập nhật web lúc ' + when + ' bị lỗi — mở GitHub › Actions để xem chi tiết.'];
  }

  async function checkDeploy() {
    try { const [s, t] = describe(await latestRun()); setDeploy(s, t); }
    catch (e) { setDeploy('', 'Không xem được trạng thái cập nhật web (mã truy cập cần thêm quyền Actions: Read-only). Web vẫn tự cập nhật sau 1–2 phút.'); }
  }

  function watchDeploy(sha) {
    clearTimeout(pollTimer);
    setDeploy('running', '⏳ Web đang được cập nhật… (thường mất 1–2 phút)');
    const started = Date.now();
    const tick = async () => {
      let run = null;
      try { run = await latestRun(sha); } catch (e) { return checkDeploy(); }
      if (run && run.status === 'completed') {
        const [s, t] = describe(run);
        setDeploy(s, t);
        if (run.conclusion === 'success') { await loadCatalog(); renderCourses(); }
        return;
      }
      if (Date.now() - started > 10 * 60 * 1000) return checkDeploy();
      pollTimer = setTimeout(tick, 5000);
    };
    pollTimer = setTimeout(tick, 4000);
  }

  // ---------- Khởi động ----------
  const saved = loadCfg();
  if (saved && saved.token) {
    connect(saved).catch((e) => showLogin(e.message));
  } else {
    showLogin();
  }
})();
