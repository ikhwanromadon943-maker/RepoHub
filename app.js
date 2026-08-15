/* ==========================================================================
   RepoHub — GitHub control deck
   Semua interaksi ke GitHub lewat REST API (api.github.com) memakai
   Personal Access Token yang disimpan di localStorage browser pengguna.
   ========================================================================== */

const GH_API = "https://api.github.com";
const LS_TOKEN_KEY = "repohub_token";
const LS_ACTIVITY_KEY = "repohub_activity";

const state = {
  token: null,
  user: null,
  repos: [],
  activity: [],
  stagedFiles: [], // { path, file, size }
  pushCount: 0,
  currentView: "dashboard",
  explorer: {
    repoFullName: "",
    branch: "",
    branches: [],
    pathStack: [], // array of folder names from repo root
    items: [],
    loading: false,
  },
};

/* ---------------------------------------------------------------------- */
/* Utilities                                                              */
/* ---------------------------------------------------------------------- */

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024, sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return "baru saja";
  if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)} hari lalu`;
  return new Date(dateStr).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/* ---------------------------------------------------------------------- */
/* Toast notifications                                                    */
/* ---------------------------------------------------------------------- */

function toast(message, type = "info", duration = 4200) {
  const container = $("#toastContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";

  const icons = {
    success: `<svg class="w-5 h-5 text-hub-teal shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6L9 17l-5-5"/></svg>`,
    error: `<svg class="w-5 h-5 text-hub-coral shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>`,
    info: `<svg class="w-5 h-5 text-hub-cyan shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>`,
    warn: `<svg class="w-5 h-5 text-hub-amber shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>`,
  };

  el.innerHTML = `
    ${icons[type] || icons.info}
    <span class="text-sm text-hub-ink leading-snug pt-0.5">${escapeHtml(message)}</span>
    <button class="ml-auto shrink-0 text-hub-dim hover:text-hub-ink transition-colors" aria-label="Tutup">
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  `;
  el.querySelector("button").onclick = () => dismissToast(el);
  container.appendChild(el);
  if (duration) setTimeout(() => dismissToast(el), duration);
}
function dismissToast(el) {
  if (!el.isConnected) return;
  el.classList.add("leaving");
  setTimeout(() => el.remove(), 240);
}

/* ---------------------------------------------------------------------- */
/* Modal system                                                           */
/* ---------------------------------------------------------------------- */

function openModal(innerHtml, { onMount } = {}) {
  closeModal();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "activeModal";
  backdrop.innerHTML = `<div class="modal-card">${innerHtml}</div>`;
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) closeModal(); });
  $("#modalRoot").appendChild(backdrop);
  document.body.style.overflow = "hidden";
  if (onMount) onMount(backdrop);
  return backdrop;
}
function closeModal() {
  const existing = $("#activeModal");
  if (existing) existing.remove();
  document.body.style.overflow = "";
}

/* ---------------------------------------------------------------------- */
/* Activity log (persisted)                                               */
/* ---------------------------------------------------------------------- */

function loadActivity() {
  try {
    state.activity = JSON.parse(localStorage.getItem(LS_ACTIVITY_KEY) || "[]");
  } catch { state.activity = []; }
}
function saveActivity() {
  try {
    localStorage.setItem(LS_ACTIVITY_KEY, JSON.stringify(state.activity.slice(0, 100)));
  } catch { /* storage full or unavailable — ignore */ }
}
function logActivity(type, title, detail = "") {
  state.activity.unshift({ type, title, detail, ts: new Date().toISOString() });
  saveActivity();
  renderActivity();
  renderDashboardActivity();
}

const ACTIVITY_ICONS = {
  push: { bg: "bg-hub-teal/15", color: "text-hub-teal", svg: `<path d="M12 19V5M5 12l7-7 7 7"/>` },
  repo_create: { bg: "bg-hub-cyan/15", color: "text-hub-cyan", svg: `<path d="M12 5v14M5 12h14"/>` },
  repo_delete: { bg: "bg-hub-coral/15", color: "text-hub-coral", svg: `<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/>` },
  file_delete: { bg: "bg-hub-coral/15", color: "text-hub-coral", svg: `<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/>` },
  visibility: { bg: "bg-hub-violet/15", color: "text-hub-violet", svg: `<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>` },
  connect: { bg: "bg-hub-amber/15", color: "text-hub-amber", svg: `<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/>` },
  error: { bg: "bg-hub-coral/15", color: "text-hub-coral", svg: `<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>` },
};

function activityRow(item) {
  const icon = ACTIVITY_ICONS[item.type] || ACTIVITY_ICONS.push;
  return `
    <div class="flex items-start gap-3 p-4">
      <div class="w-8 h-8 rounded-lg ${icon.bg} flex items-center justify-center shrink-0">
        <svg class="w-4 h-4 ${icon.color}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icon.svg}</svg>
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium truncate">${escapeHtml(item.title)}</p>
        ${item.detail ? `<p class="text-xs text-hub-dim truncate mt-0.5">${escapeHtml(item.detail)}</p>` : ""}
        <p class="text-[11px] font-mono text-hub-dim mt-1">${timeAgo(item.ts)}</p>
      </div>
    </div>
  `;
}

function renderActivity() {
  const list = $("#activityList");
  const empty = $("#activityEmpty");
  if (!list) return;
  if (state.activity.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  list.innerHTML = state.activity.map(activityRow).join("");
}

function renderDashboardActivity() {
  const wrap = $("#dashRecentActivity");
  if (!wrap) return;
  if (state.activity.length === 0) {
    wrap.innerHTML = `<div class="p-6 text-center text-sm text-hub-dim">Belum ada aktivitas.</div>`;
    return;
  }
  wrap.innerHTML = state.activity.slice(0, 6).map(activityRow).join("");
}

/* ---------------------------------------------------------------------- */
/* GitHub API wrapper                                                     */
/* ---------------------------------------------------------------------- */

async function ghFetch(path, options = {}) {
  if (!state.token) throw new Error("Belum terhubung ke GitHub");
  let res;
  try {
    res = await fetch(`${GH_API}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${state.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (networkErr) {
    throw new Error("Gagal terhubung ke GitHub. Cek koneksi internet kamu.");
  }
  if (!res.ok) {
    let msg = `GitHub API error (${res.status})`;
    try {
      const data = await res.json();
      if (data.message) msg = data.message;
    } catch { /* body not JSON — keep default msg */ }
    if (res.status === 401) msg = "Token tidak valid atau sudah kedaluwarsa";
    if (res.status === 403) msg = "Akses ditolak — cek scope token kamu (perlu 'repo'), atau rate limit tercapai";
    if (res.status === 404) msg = "Tidak ditemukan (404)";
    if (res.status === 409) msg = "Konflik: file/branch sudah berubah, coba refresh";
    if (res.status === 422) msg = msg || "Data tidak valid";
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ---------------------------------------------------------------------- */
/* Auth: connect / logout                                                 */
/* ---------------------------------------------------------------------- */

async function connectWithToken(token) {
  const cleaned = (token || "").trim();
  if (!cleaned) {
    toast("Token tidak boleh kosong", "error");
    return false;
  }
  try {
    const res = await fetch(`${GH_API}/user`, {
      headers: {
        Authorization: `Bearer ${cleaned}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) {
      if (res.status === 401) throw new Error("Token tidak valid. Cek kembali token kamu.");
      throw new Error(`Gagal memverifikasi token (${res.status})`);
    }
    const user = await res.json();
    state.token = cleaned;
    state.user = user;
    try { localStorage.setItem(LS_TOKEN_KEY, cleaned); } catch { /* storage unavailable */ }
    logActivity("connect", "Terhubung ke GitHub", `Masuk sebagai @${user.login}`);
    toast(`Berhasil terhubung sebagai @${user.login}`, "success");
    await onConnected();
    return true;
  } catch (err) {
    toast(err.message || "Gagal terhubung ke GitHub", "error");
    return false;
  }
}

function logout() {
  state.token = null;
  state.user = null;
  state.repos = [];
  state.explorer = { repoFullName: "", branch: "", branches: [], pathStack: [], items: [], loading: false };
  try { localStorage.removeItem(LS_TOKEN_KEY); } catch {}
  closeModal();
  renderAuthUI();
  switchView("dashboard");
  toast("Kamu sudah keluar dari RepoHub", "info");
}

async function tryAutoConnect() {
  let saved;
  try { saved = localStorage.getItem(LS_TOKEN_KEY); } catch { saved = null; }
  if (!saved) return;
  state.token = saved;
  try {
    const user = await ghFetch("/user");
    state.user = user;
    await onConnected(true);
  } catch (err) {
    try { localStorage.removeItem(LS_TOKEN_KEY); } catch {}
    state.token = null;
    toast("Sesi tersimpan sudah tidak valid, silakan hubungkan ulang", "warn");
  }
}

async function onConnected(silent = false) {
  renderAuthUI();
  await refreshRepos();
  renderDashboard();
  if (!silent) switchView("dashboard");
}

/* ---------------------------------------------------------------------- */
/* Render: Auth-dependent UI (navbar, gates)                              */
/* ---------------------------------------------------------------------- */

function renderAuthUI() {
  const connected = !!state.token && !!state.user;

  $("#btnConnect").classList.toggle("hidden", connected);
  $("#btnConnect").classList.toggle("flex", !connected);
  $("#userMenuWrap").classList.toggle("hidden", !connected);

  const dot = $("#connDot");
  const text = $("#connText");
  if (connected) {
    dot.className = "absolute inline-flex h-full w-full rounded-full bg-hub-teal";
    text.textContent = `@${state.user.login}`;
    text.classList.remove("text-hub-dim");
    text.classList.add("text-hub-teal");
  } else {
    dot.className = "absolute inline-flex h-full w-full rounded-full bg-hub-coral";
    text.textContent = "Belum terhubung";
    text.classList.add("text-hub-dim");
    text.classList.remove("text-hub-teal");
  }

  if (connected) {
    $("#userAvatar").src = state.user.avatar_url;
    $("#userAvatarBig").src = state.user.avatar_url;
    $("#userLogin").textContent = state.user.login;
    $("#userLoginBig").textContent = `@${state.user.login}`;
    $("#userNameBig").textContent = state.user.name || state.user.login;
    $("#userRepoCount").textContent = state.user.public_repos ?? "0";
    $("#userPlan").textContent = state.user.plan?.name ? capitalize(state.user.plan.name) : "Free";
    $("#btnOpenGithubProfile").href = state.user.html_url;
  }

  $("#heroLoggedOut").classList.toggle("hidden", connected);
  $("#dashLoggedIn").classList.toggle("hidden", !connected);

  $("#uploadGate").classList.toggle("hidden", connected);
  $("#uploadContent").classList.toggle("hidden", !connected);

  $("#reposGate").classList.toggle("hidden", connected);
  $("#reposContent").classList.toggle("hidden", !connected);

  $("#activityGate").classList.toggle("hidden", connected);
  $("#activityContent").classList.toggle("hidden", !connected);

  $("#explorerGate").classList.toggle("hidden", connected);
  $("#explorerContent").classList.toggle("hidden", !connected);

  if (connected) {
    $("#welcomeText").textContent = `Halo, ${(state.user.name || state.user.login).split(" ")[0]} 👋`;
  }
}

/* ---------------------------------------------------------------------- */
/* Navigation                                                             */
/* ---------------------------------------------------------------------- */

function switchView(viewName) {
  state.currentView = viewName;
  $all(".view-panel").forEach((el) => el.classList.add("hidden"));
  const target = $(`#view-${viewName}`);
  if (target) target.classList.remove("hidden");

  $all(".nav-link").forEach((btn) => btn.classList.toggle("active-nav", btn.dataset.view === viewName));
  $all(".nav-link-mobile").forEach((btn) => btn.classList.toggle("active-nav", btn.dataset.view === viewName));

  closeMobileMenu();
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (viewName === "repos" && state.token) renderRepoGrid();
  if (viewName === "activity" && state.token) renderActivity();
  if (viewName === "explorer" && state.token) {
    populateExplorerRepoSelect();
    if (state.explorer.repoFullName) renderExplorerBreadcrumb();
  }
}

function closeMobileMenu() {
  $("#mobileNavPanel").classList.add("hidden");
  $("#iconMenuOpen").classList.remove("hidden");
  $("#iconMenuClose").classList.add("hidden");
}

/* ---------------------------------------------------------------------- */
/* Repos: fetch & render                                                  */
/* ---------------------------------------------------------------------- */

async function refreshRepos() {
  try {
    const repos = await ghFetch("/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator");
    state.repos = repos || [];
    const publicCount = state.repos.filter((r) => !r.private).length;
    const privateCount = state.repos.filter((r) => r.private).length;
    $("#statPublicRepos").textContent = publicCount;
    $("#statPrivateRepos").textContent = privateCount;
    $("#statFollowers").textContent = state.user.followers ?? 0;
    populateRepoSelect();
    populateExplorerRepoSelect();
    renderRepoGrid();
    renderDashRecentRepos();
  } catch (err) {
    toast(err.message, "error");
  }
}

function populateRepoSelect() {
  const sel = $("#targetRepoSelect");
  const currentVal = sel.value;
  sel.innerHTML = `<option value="">— pilih repository —</option>` +
    state.repos.map((r) => `<option value="${escapeHtml(r.full_name)}">${escapeHtml(r.full_name)}${r.private ? " 🔒" : ""}</option>`).join("");
  if (currentVal && state.repos.some((r) => r.full_name === currentVal)) sel.value = currentVal;
}

function repoCardHtml(repo) {
  return `
    <div class="repo-card rounded-2xl border border-hub-line bg-white/[0.02] backdrop-blur-xl p-4 sm:p-5 flex flex-col" data-repo="${escapeHtml(repo.full_name)}">
      <div class="flex items-start justify-between gap-2 mb-2">
        <div class="min-w-0">
          <h3 class="font-mono font-semibold text-sm truncate">${escapeHtml(repo.name)}</h3>
          <p class="text-[11px] text-hub-dim font-mono truncate">${escapeHtml(repo.full_name)}</p>
        </div>
        <span class="badge ${repo.private ? "badge-private" : "badge-public"} shrink-0">${repo.private ? "Private" : "Public"}</span>
      </div>
      <p class="text-xs text-hub-dim line-clamp-2 mb-3 flex-1 min-h-[2.2em]">${repo.description ? escapeHtml(repo.description) : "Tidak ada deskripsi."}</p>
      <div class="flex items-center gap-3 text-[11px] font-mono text-hub-dim mb-4 flex-wrap">
        ${repo.language ? `<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-hub-teal inline-block"></span>${escapeHtml(repo.language)}</span>` : ""}
        <span class="flex items-center gap-1">
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.4 5.6 21l2.4-7.2-6-4.6h7.6z"/></svg>
          ${repo.stargazers_count}
        </span>
        <span>Diubah ${timeAgo(repo.updated_at)}</span>
      </div>
      <div class="flex items-center gap-2 mt-auto">
        <button class="btnRepoExplore flex-1 text-center text-xs font-medium bg-hub-violet/10 text-hub-violet border border-hub-violet/30 rounded-lg py-2 hover:bg-hub-violet/20 transition-all" data-repo="${escapeHtml(repo.full_name)}">Jelajahi</button>
        <button class="btnRepoUpload text-xs font-medium bg-hub-teal/10 text-hub-teal border border-hub-teal/30 rounded-lg py-2 px-3 hover:bg-hub-teal/20 transition-all" data-repo="${escapeHtml(repo.full_name)}">Upload</button>
        <a href="${repo.html_url}" target="_blank" rel="noopener" class="w-8 h-8 flex items-center justify-center rounded-lg border border-hub-line hover:bg-white/[0.09] transition-all shrink-0" aria-label="Buka di GitHub">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
        </a>
        <button class="btnRepoMore w-8 h-8 flex items-center justify-center rounded-lg border border-hub-line hover:bg-white/[0.09] transition-all shrink-0" data-repo="${escapeHtml(repo.full_name)}" aria-label="Opsi lain">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"/></svg>
        </button>
      </div>
    </div>
  `;
}

function renderRepoGrid() {
  const grid = $("#repoGrid");
  const empty = $("#repoEmptyState");
  if (!grid) return;

  const query = ($("#repoSearch")?.value || "").toLowerCase();
  const sortMode = $("#repoSortSelect")?.value || "updated";

  let list = state.repos.filter((r) => r.name.toLowerCase().includes(query));
  if (sortMode === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  else if (sortMode === "stars") list = [...list].sort((a, b) => b.stargazers_count - a.stargazers_count);
  else list = [...list].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  if (list.length === 0) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  grid.innerHTML = list.map(repoCardHtml).join("");

  $all(".btnRepoUpload", grid).forEach((btn) => {
    btn.onclick = () => {
      switchView("upload");
      $("#targetRepoSelect").value = btn.dataset.repo;
    };
  });
  $all(".btnRepoExplore", grid).forEach((btn) => {
    btn.onclick = () => {
      switchView("explorer");
      openRepoInExplorer(btn.dataset.repo);
    };
  });
  $all(".btnRepoMore", grid).forEach((btn) => {
    btn.onclick = () => openRepoOptionsModal(btn.dataset.repo);
  });
}

function renderDashRecentRepos() {
  const wrap = $("#dashRecentRepos");
  if (!wrap) return;
  const recent = [...state.repos].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 5);
  if (recent.length === 0) {
    wrap.innerHTML = `<div class="p-6 text-center text-sm text-hub-dim">Belum ada repository.</div>`;
    return;
  }
  wrap.innerHTML = recent.map((r) => `
    <div class="flex items-center gap-3 p-4 hover:bg-white/[0.02] transition-colors cursor-pointer dashRepoRow" data-repo="${escapeHtml(r.full_name)}">
      <div class="w-9 h-9 rounded-lg ${r.private ? "bg-hub-violet/15" : "bg-hub-teal/15"} flex items-center justify-center shrink-0">
        <svg class="w-4 h-4 ${r.private ? "text-hub-violet" : "text-hub-teal"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          ${r.private ? `<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>` : `<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>`}
        </svg>
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium truncate font-mono">${escapeHtml(r.name)}</p>
        <p class="text-[11px] text-hub-dim">Diubah ${timeAgo(r.updated_at)}</p>
      </div>
      <svg class="w-4 h-4 text-hub-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
    </div>
  `).join("");

  $all(".dashRepoRow", wrap).forEach((row) => {
    row.onclick = () => {
      switchView("explorer");
      openRepoInExplorer(row.dataset.repo);
    };
  });
}

function renderDashboard() {
  renderDashRecentRepos();
  renderDashboardActivity();
  $("#statPushCount").textContent = state.pushCount;
}

/* ---------------------------------------------------------------------- */
/* Create repo                                                            */
/* ---------------------------------------------------------------------- */

function openNewRepoModal() {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-5">
        <h2 class="font-mono font-bold text-lg">Buat repository baru</h2>
        <button id="mClose" class="text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="space-y-4">
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Nama repository</label>
          <input id="newRepoName" type="text" placeholder="proyek-keren-saya" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
        </div>
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Deskripsi (opsional)</label>
          <input id="newRepoDesc" type="text" placeholder="Deskripsi singkat repo ini" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
        </div>
        <div class="flex items-center justify-between bg-white/[0.02] border border-hub-line rounded-xl px-4 py-3">
          <div>
            <p class="text-sm font-medium">Repository privat</p>
            <p class="text-xs text-hub-dim">Hanya kamu dan kolaborator yang bisa melihat</p>
          </div>
          <button id="togglePrivate" type="button" role="switch" aria-checked="false" class="relative w-11 h-6 rounded-full bg-white/10 transition-colors shrink-0">
            <span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-hub-dim transition-transform"></span>
          </button>
        </div>
        <label class="flex items-center gap-2.5 text-sm cursor-pointer">
          <input id="newRepoInitReadme" type="checkbox" checked class="w-4 h-4 rounded accent-hub-teal">
          Inisialisasi dengan README
        </label>
      </div>
      <button id="btnCreateRepoSubmit" type="button" class="w-full mt-6 flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3.5 rounded-xl hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-hub-teal/20">
        <span id="createRepoBtnText">Buat Repository</span>
      </button>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      let isPrivate = false;
      const toggle = $("#togglePrivate", root);
      toggle.onclick = () => {
        isPrivate = !isPrivate;
        toggle.setAttribute("aria-checked", String(isPrivate));
        toggle.classList.toggle("bg-hub-teal", isPrivate);
        toggle.classList.toggle("bg-white/10", !isPrivate);
        const knob = toggle.querySelector("span");
        knob.style.transform = isPrivate ? "translateX(20px)" : "translateX(0)";
        knob.classList.toggle("bg-hub-bg", isPrivate);
        knob.classList.toggle("bg-hub-dim", !isPrivate);
      };
      $("#mClose", root).onclick = closeModal;
      $("#newRepoName", root).focus();

      $("#btnCreateRepoSubmit", root).onclick = async () => {
        const name = $("#newRepoName", root).value.trim();
        if (!name) { toast("Nama repository wajib diisi", "error"); return; }
        if (!/^[a-zA-Z0-9._-]+$/.test(name)) { toast("Nama hanya boleh huruf, angka, titik, strip, underscore", "error"); return; }

        const btn = $("#btnCreateRepoSubmit", root);
        const btnText = $("#createRepoBtnText", root);
        btn.disabled = true;
        btnText.innerHTML = `<span class="spinner"></span>`;

        try {
          const repo = await ghFetch("/user/repos", {
            method: "POST",
            body: JSON.stringify({
              name,
              description: $("#newRepoDesc", root).value.trim() || undefined,
              private: isPrivate,
              auto_init: $("#newRepoInitReadme", root).checked,
            }),
          });
          logActivity("repo_create", `Repository dibuat: ${repo.name}`, isPrivate ? "Private" : "Public");
          toast(`Repository "${repo.name}" berhasil dibuat`, "success");
          closeModal();
          await refreshRepos();
        } catch (err) {
          toast(err.message, "error");
          logActivity("error", "Gagal membuat repository", err.message);
          btn.disabled = false;
          btnText.textContent = "Buat Repository";
        }
      };
    },
  });
}

/* ---------------------------------------------------------------------- */
/* Repo options modal (visibility, delete)                                */
/* ---------------------------------------------------------------------- */

function openRepoOptionsModal(fullName) {
  const repo = state.repos.find((r) => r.full_name === fullName);
  if (!repo) return;

  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-5">
        <div class="min-w-0">
          <h2 class="font-mono font-bold text-lg truncate">${escapeHtml(repo.name)}</h2>
          <p class="text-xs text-hub-dim font-mono truncate">${escapeHtml(repo.full_name)}</p>
        </div>
        <button id="mClose" class="text-hub-dim hover:text-hub-ink transition-colors shrink-0">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      <div class="space-y-2">
        <button id="btnGoExploreHere" class="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-hub-line hover:bg-white/[0.05] transition-all text-sm font-medium text-left">
          <svg class="w-4 h-4 text-hub-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          Jelajahi file repo ini
        </button>
        <a href="${repo.html_url}" target="_blank" rel="noopener" class="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-hub-line hover:bg-white/[0.05] transition-all text-sm font-medium">
          <svg class="w-4 h-4 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
          Buka di GitHub
        </a>
        <button id="btnGoUploadHere" class="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-hub-line hover:bg-white/[0.05] transition-all text-sm font-medium text-left">
          <svg class="w-4 h-4 text-hub-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>
          Upload file ke sini
        </button>
        <button id="btnToggleVisibility" class="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-hub-line hover:bg-white/[0.05] transition-all text-sm font-medium text-left">
          <svg class="w-4 h-4 text-hub-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
          Jadikan ${repo.private ? "Public" : "Private"}
        </button>
        <button id="btnDeleteRepo" class="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-hub-coral/5 border border-hub-coral/20 hover:bg-hub-coral/10 transition-all text-sm font-medium text-left text-hub-coral">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
          Hapus Repository
        </button>
      </div>
    </div>
  `;

  openModal(html, {
    onMount: (root) => {
      $("#mClose", root).onclick = closeModal;
      $("#btnGoExploreHere", root).onclick = () => {
        closeModal();
        switchView("explorer");
        openRepoInExplorer(repo.full_name);
      };
      $("#btnGoUploadHere", root).onclick = () => {
        closeModal();
        switchView("upload");
        $("#targetRepoSelect").value = repo.full_name;
      };
      $("#btnToggleVisibility", root).onclick = async () => {
        try {
          await ghFetch(`/repos/${repo.full_name}`, {
            method: "PATCH",
            body: JSON.stringify({ private: !repo.private }),
          });
          logActivity("visibility", `Visibilitas diubah: ${repo.name}`, !repo.private ? "Sekarang Private" : "Sekarang Public");
          toast(`"${repo.name}" sekarang ${!repo.private ? "Private" : "Public"}`, "success");
          closeModal();
          await refreshRepos();
        } catch (err) {
          toast(err.message, "error");
        }
      };
      $("#btnDeleteRepo", root).onclick = () => openDeleteConfirmModal(repo);
    },
  });
}

function openDeleteConfirmModal(repo) {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="w-12 h-12 rounded-full bg-hub-coral/15 flex items-center justify-center mb-4">
        <svg class="w-6 h-6 text-hub-coral" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
      </div>
      <h2 class="font-mono font-bold text-lg mb-1.5">Hapus repository ini?</h2>
      <p class="text-sm text-hub-dim mb-4 leading-relaxed">Tindakan ini permanen dan tidak bisa dibatalkan. Semua kode, issue, dan riwayat di <strong class="text-hub-ink font-mono">${escapeHtml(repo.full_name)}</strong> akan hilang.</p>
      <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Ketik <strong class="text-hub-coral">${escapeHtml(repo.name)}</strong> untuk konfirmasi</label>
      <input id="confirmRepoName" type="text" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm font-mono mb-4 focus:outline-none focus:ring-2 focus:ring-hub-coral/50" placeholder="${escapeHtml(repo.name)}">
      <div class="flex gap-3">
        <button id="mCancel" type="button" class="flex-1 border border-hub-line py-3 rounded-xl text-sm font-medium hover:bg-white/[0.05] transition-all">Batal</button>
        <button id="btnConfirmDelete" type="button" disabled class="flex-1 flex items-center justify-center gap-2 bg-hub-coral text-white font-semibold py-3 rounded-xl hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
          <span id="deleteBtnText">Hapus Permanen</span>
        </button>
      </div>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      $("#mCancel", root).onclick = () => openRepoOptionsModal(repo.full_name);
      const input = $("#confirmRepoName", root);
      const btn = $("#btnConfirmDelete", root);
      input.oninput = () => { btn.disabled = input.value.trim() !== repo.name; };
      input.focus();
      btn.onclick = async () => {
        btn.disabled = true;
        $("#deleteBtnText", root).innerHTML = `<span class="spinner"></span>`;
        try {
          await ghFetch(`/repos/${repo.full_name}`, { method: "DELETE" });
          logActivity("repo_delete", `Repository dihapus: ${repo.name}`);
          toast(`"${repo.name}" berhasil dihapus`, "success");
          closeModal();
          if (state.explorer.repoFullName === repo.full_name) {
            state.explorer = { repoFullName: "", branch: "", branches: [], pathStack: [], items: [], loading: false };
          }
          await refreshRepos();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          $("#deleteBtnText", root).textContent = "Hapus Permanen";
        }
      };
    },
  });
}

/* ---------------------------------------------------------------------- */
/* Token modal (manage token)                                             */
/* ---------------------------------------------------------------------- */

function openTokenModal() {
  const connected = !!state.token;
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-5">
        <h2 class="font-mono font-bold text-lg">${connected ? "Kelola Token" : "Hubungkan GitHub"}</h2>
        <button id="mClose" class="text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      ${connected ? `
        <div class="flex items-center gap-3 bg-white/[0.02] border border-hub-line rounded-xl p-3 mb-4">
          <img src="${state.user.avatar_url}" class="w-10 h-10 rounded-full ring-1 ring-hub-line">
          <div class="min-w-0">
            <p class="text-sm font-medium truncate">${escapeHtml(state.user.name || state.user.login)}</p>
            <p class="text-xs text-hub-dim font-mono truncate">@${escapeHtml(state.user.login)}</p>
          </div>
          <span class="ml-auto badge badge-public shrink-0">Terhubung</span>
        </div>
        <p class="text-xs text-hub-dim mb-4 leading-relaxed">Token kamu disimpan hanya di penyimpanan lokal browser ini. Untuk mengganti akun, hubungkan token baru di bawah, atau keluar dari menu profil.</p>
      ` : `
        <p class="text-sm text-hub-dim mb-4 leading-relaxed">Tempel Personal Access Token GitHub kamu (scope <code class="text-hub-cyan bg-white/5 px-1.5 py-0.5 rounded font-mono text-xs">repo</code>). Belum punya token? <a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener" class="text-hub-teal hover:underline">Buat di sini →</a></p>
      `}

      <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Personal Access Token</label>
      <div class="relative mb-4">
        <input id="tokenInput" type="password" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 pr-11 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
        <button id="btnToggleTokenVis" type="button" class="absolute right-3 top-1/2 -translate-y-1/2 text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <button id="btnSubmitToken" type="button" class="w-full flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3.5 rounded-xl hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-hub-teal/20">
        <span id="submitTokenText">${connected ? "Ganti Token" : "Hubungkan"}</span>
      </button>

      ${connected ? `
        <button id="btnLogoutFromModal" type="button" class="w-full mt-2.5 flex items-center justify-center gap-2 text-hub-coral text-sm font-medium py-3 rounded-xl hover:bg-hub-coral/5 transition-all">
          Log Out
        </button>
      ` : ""}
    </div>
  `;

  openModal(html, {
    onMount: (root) => {
      $("#mClose", root).onclick = closeModal;
      $("#tokenInput", root).focus();
      $("#btnToggleTokenVis", root).onclick = () => {
        const input = $("#tokenInput", root);
        input.type = input.type === "password" ? "text" : "password";
      };
      $("#tokenInput", root).addEventListener("keydown", (e) => {
        if (e.key === "Enter") $("#btnSubmitToken", root).click();
      });
      $("#btnSubmitToken", root).onclick = async () => {
        const val = $("#tokenInput", root).value;
        const btn = $("#btnSubmitToken", root);
        const btnText = $("#submitTokenText", root);
        btn.disabled = true;
        btnText.innerHTML = `<span class="spinner"></span>`;
        const ok = await connectWithToken(val);
        if (ok) {
          closeModal();
        } else {
          btn.disabled = false;
          btnText.textContent = connected ? "Ganti Token" : "Hubungkan";
        }
      };
      if (connected) {
        $("#btnLogoutFromModal", root).onclick = logout;
      }
    },
  });
}

/* ---------------------------------------------------------------------- */
/* EXPLORER: browse repo contents, switch repos/branches, breadcrumbs     */
/* ---------------------------------------------------------------------- */

function populateExplorerRepoSelect() {
  const sel = $("#explorerRepoSelect");
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = `<option value="">— pilih repository —</option>` +
    state.repos.map((r) => `<option value="${escapeHtml(r.full_name)}">${escapeHtml(r.full_name)}${r.private ? " 🔒" : ""}</option>`).join("");
  if (currentVal && state.repos.some((r) => r.full_name === currentVal)) sel.value = currentVal;
  else if (state.explorer.repoFullName) sel.value = state.explorer.repoFullName;
}

async function openRepoInExplorer(fullName) {
  state.explorer.repoFullName = fullName;
  state.explorer.pathStack = [];
  $("#explorerRepoSelect").value = fullName;
  await loadBranchesForExplorer();
  await loadExplorerFolder();
}

async function loadBranchesForExplorer() {
  const repoFullName = state.explorer.repoFullName;
  if (!repoFullName) return;
  try {
    const branches = await ghFetch(`/repos/${repoFullName}/branches?per_page=100`);
    state.explorer.branches = branches || [];
    const repoMeta = state.repos.find((r) => r.full_name === repoFullName);
    const defaultBranch = repoMeta?.default_branch || (branches[0] && branches[0].name) || "main";
    state.explorer.branch = state.explorer.branches.some((b) => b.name === defaultBranch)
      ? defaultBranch
      : (branches[0]?.name || "main");

    const sel = $("#explorerBranchSelect");
    sel.innerHTML = state.explorer.branches.map((b) => `<option value="${escapeHtml(b.name)}">${escapeHtml(b.name)}</option>`).join("") || `<option value="main">main</option>`;
    sel.value = state.explorer.branch;
  } catch (err) {
    toast("Gagal memuat branch: " + err.message, "error");
    state.explorer.branches = [];
  }
}

function currentExplorerPath() {
  return state.explorer.pathStack.join("/");
}

async function loadExplorerFolder() {
  const { repoFullName, branch } = state.explorer;
  if (!repoFullName) return;

  const loadingEl = $("#explorerLoading");
  const emptyEl = $("#explorerEmpty");
  const folderEmptyEl = $("#explorerFolderEmpty");
  const listEl = $("#explorerList");

  emptyEl.classList.add("hidden");
  folderEmptyEl.classList.add("hidden");
  listEl.innerHTML = "";
  loadingEl.classList.remove("hidden");
  state.explorer.loading = true;
  renderExplorerBreadcrumb();

  const path = currentExplorerPath();
  try {
    const data = await ghFetch(`/repos/${repoFullName}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`);
    const items = Array.isArray(data) ? data : [data];
    // folders first, then files, alphabetically
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    state.explorer.items = items;
    loadingEl.classList.add("hidden");
    if (items.length === 0) {
      folderEmptyEl.classList.remove("hidden");
    } else {
      renderExplorerList();
    }
  } catch (err) {
    loadingEl.classList.add("hidden");
    toast("Gagal memuat isi folder: " + err.message, "error");
    folderEmptyEl.classList.remove("hidden");
  } finally {
    state.explorer.loading = false;
  }
}

const EXPLORER_FILE_ICONS = {
  code: `<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>`,
  image: `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>`,
  doc: `<path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M13 2v7h7"/>`,
  archive: `<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>`,
};
function iconForFileName(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "go", "rs", "html", "css", "json", "php", "rb", "sh", "yml", "yaml"].includes(ext)) return EXPLORER_FILE_ICONS.code;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return EXPLORER_FILE_ICONS.image;
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return EXPLORER_FILE_ICONS.archive;
  return EXPLORER_FILE_ICONS.doc;
}

function renderExplorerBreadcrumb() {
  const wrap = $("#explorerBreadcrumb");
  if (!wrap) return;
  const { repoFullName, pathStack } = state.explorer;
  if (!repoFullName) { wrap.innerHTML = ""; return; }

  const repoShortName = repoFullName.split("/")[1] || repoFullName;
  let html = `<button type="button" class="crumb-btn ${pathStack.length === 0 ? "crumb-active" : ""}" data-depth="0">
    <span class="inline-flex items-center gap-1.5">
      <svg class="w-3 h-3 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>
      ${escapeHtml(repoShortName)}
    </span>
  </button>`;

  pathStack.forEach((seg, idx) => {
    html += `<span class="crumb-sep">/</span>`;
    html += `<button type="button" class="crumb-btn ${idx === pathStack.length - 1 ? "crumb-active" : ""}" data-depth="${idx + 1}">${escapeHtml(seg)}</button>`;
  });

  wrap.innerHTML = html;
  $all(".crumb-btn", wrap).forEach((btn) => {
    btn.onclick = () => {
      const depth = Number(btn.dataset.depth);
      state.explorer.pathStack = state.explorer.pathStack.slice(0, depth);
      loadExplorerFolder();
    };
  });
}

function renderExplorerList() {
  const listEl = $("#explorerList");
  const items = state.explorer.items;

  listEl.innerHTML = items.map((item, idx) => {
    if (item.type === "dir") {
      return `
        <div class="explorer-row flex items-center gap-3 p-3.5 cursor-pointer" data-idx="${idx}" data-type="dir">
          <div class="w-8 h-8 rounded-lg bg-hub-amber/15 flex items-center justify-center shrink-0">
            <svg class="w-4 h-4 text-hub-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-mono truncate">${escapeHtml(item.name)}</p>
            <p class="text-[11px] text-hub-dim">Folder</p>
          </div>
          <svg class="w-4 h-4 text-hub-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </div>
      `;
    }
    return `
      <div class="explorer-row flex items-center gap-3 p-3.5" data-idx="${idx}" data-type="file">
        <div class="w-8 h-8 rounded-lg bg-white/[0.05] flex items-center justify-center shrink-0">
          <svg class="w-4 h-4 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${iconForFileName(item.name)}</svg>
        </div>
        <div class="min-w-0 flex-1 cursor-pointer explorerFileClick" data-idx="${idx}">
          <p class="text-sm font-mono truncate">${escapeHtml(item.name)}</p>
          <p class="text-[11px] text-hub-dim">${fmtBytes(item.size)}</p>
        </div>
        <a href="${item.html_url}" target="_blank" rel="noopener" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/[0.08] transition-all shrink-0 text-hub-dim hover:text-hub-teal" aria-label="Buka di GitHub" onclick="event.stopPropagation()">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
        </a>
        <button class="btnExplorerFileDelete w-8 h-8 flex items-center justify-center rounded-lg hover:bg-hub-coral/10 transition-all shrink-0 text-hub-dim hover:text-hub-coral" data-idx="${idx}" aria-label="Hapus file">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
        </button>
      </div>
    `;
  }).join("");

  $all('.explorer-row[data-type="dir"]', listEl).forEach((row) => {
    row.onclick = () => {
      const idx = Number(row.dataset.idx);
      const item = state.explorer.items[idx];
      state.explorer.pathStack.push(item.name);
      loadExplorerFolder();
    };
  });
  $all(".btnExplorerFileDelete", listEl).forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      openExplorerFileDeleteModal(state.explorer.items[idx]);
    };
  });
}

function openExplorerFileDeleteModal(item) {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="w-12 h-12 rounded-full bg-hub-coral/15 flex items-center justify-center mb-4">
        <svg class="w-6 h-6 text-hub-coral" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
      </div>
      <h2 class="font-mono font-bold text-lg mb-1.5">Hapus file ini?</h2>
      <p class="text-sm text-hub-dim mb-5 leading-relaxed">File <strong class="text-hub-ink font-mono">${escapeHtml(item.name)}</strong> akan dihapus permanen dari branch <strong class="text-hub-ink font-mono">${escapeHtml(state.explorer.branch)}</strong>.</p>
      <div class="flex gap-3">
        <button id="mCancel" type="button" class="flex-1 border border-hub-line py-3 rounded-xl text-sm font-medium hover:bg-white/[0.05] transition-all">Batal</button>
        <button id="btnConfirmFileDelete" type="button" class="flex-1 flex items-center justify-center gap-2 bg-hub-coral text-white font-semibold py-3 rounded-xl hover:brightness-110 transition-all">
          <span id="fileDeleteBtnText">Hapus</span>
        </button>
      </div>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      $("#mCancel", root).onclick = closeModal;
      $("#btnConfirmFileDelete", root).onclick = async () => {
        const btn = $("#btnConfirmFileDelete", root);
        btn.disabled = true;
        $("#fileDeleteBtnText", root).innerHTML = `<span class="spinner"></span>`;
        try {
          await ghFetch(`/repos/${state.explorer.repoFullName}/contents/${encodeURI(item.path)}`, {
            method: "DELETE",
            body: JSON.stringify({
              message: `Hapus ${item.name} via RepoHub`,
              sha: item.sha,
              branch: state.explorer.branch,
            }),
          });
          logActivity("file_delete", `File dihapus: ${item.name}`, item.path);
          toast(`"${item.name}" berhasil dihapus`, "success");
          closeModal();
          await loadExplorerFolder();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          $("#fileDeleteBtnText", root).textContent = "Hapus";
        }
      };
    },
  });
}

/* ---------------------------------------------------------------------- */
/* Upload: staging files (drag/drop, folder, zip)                         */
/* ---------------------------------------------------------------------- */

function stageFiles(fileList) {
  const arr = Array.from(fileList || []);
  if (arr.length === 0) return;
  arr.forEach((file) => {
    const relPath = file.webkitRelativePath && file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name;
    state.stagedFiles.push({ path: relPath, file, size: file.size });
  });
  renderStagedList();
  toast(`${arr.length} file ditambahkan ke antrian upload`, "info", 2200);
}

async function stageZipFile(zipFile) {
  if (typeof JSZip === "undefined") {
    toast("Gagal memuat pustaka ZIP. Cek koneksi internet dan muat ulang halaman.", "error");
    return;
  }
  toast(`Mengekstrak ${zipFile.name}...`, "info", 2500);
  try {
    const zip = await JSZip.loadAsync(zipFile);
    const entries = Object.values(zip.files).filter((e) => !e.dir);
    if (entries.length === 0) {
      toast("ZIP kosong atau tidak berisi file", "warn");
      return;
    }
    for (const entry of entries) {
      const blob = await entry.async("blob");
      const name = entry.name.split("/").pop();
      const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
      state.stagedFiles.push({ path: entry.name, file, size: blob.size });
    }
    renderStagedList();
    toast(`${entries.length} file berhasil diekstrak dari ${zipFile.name}`, "success");
  } catch (err) {
    toast("Gagal mengekstrak ZIP: " + err.message, "error");
  }
}

function renderStagedList() {
  const wrap = $("#stagedWrap");
  const list = $("#stagedList");
  const count = $("#stagedCount");

  if (state.stagedFiles.length === 0) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  count.textContent = state.stagedFiles.length;

  list.innerHTML = state.stagedFiles.map((item, idx) => `
    <div class="flex items-center gap-3 p-3.5">
      <div class="w-8 h-8 rounded-lg bg-white/[0.05] flex items-center justify-center shrink-0">
        <svg class="w-4 h-4 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${iconForFileName(item.path)}</svg>
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-mono truncate">${escapeHtml(item.path)}</p>
        <p class="text-[11px] text-hub-dim">${fmtBytes(item.size)}</p>
      </div>
      <button type="button" class="btnRemoveStaged text-hub-dim hover:text-hub-coral transition-colors shrink-0" data-idx="${idx}" aria-label="Hapus file">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
  `).join("");

  $all(".btnRemoveStaged", list).forEach((btn) => {
    btn.onclick = () => {
      state.stagedFiles.splice(Number(btn.dataset.idx), 1);
      renderStagedList();
    };
  });
}

function clearStaged() {
  state.stagedFiles = [];
  renderStagedList();
  $("#uploadProgressWrap").classList.add("hidden");
}

/* ---------------------------------------------------------------------- */
/* Upload: push staged files to GitHub                                    */
/* ---------------------------------------------------------------------- */

async function readFileAsBase64(file) {
  const buffer = await file.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

async function pushStagedFiles() {
  const repoFullName = $("#targetRepoSelect").value;
  const branch = $("#targetBranch").value.trim() || "main";
  const subPath = $("#targetPath").value.trim().replace(/^\/+|\/+$/g, "");
  const message = $("#commitMessage").value.trim() || `Upload ${state.stagedFiles.length} file via RepoHub`;

  if (!repoFullName) { toast("Pilih repository tujuan dulu", "error"); return; }
  if (state.stagedFiles.length === 0) { toast("Belum ada file untuk diupload", "error"); return; }

  const btn = $("#btnDoUpload");
  const btnText = $("#btnDoUploadText");
  btn.disabled = true;
  btnText.innerHTML = `<span class="spinner"></span>`;

  const progressWrap = $("#uploadProgressWrap");
  const progressBar = $("#uploadProgressBar");
  const progressPct = $("#uploadProgressPct");
  const progressLabel = $("#uploadProgressLabel");
  progressWrap.classList.remove("hidden");
  progressBar.style.width = "0%";
  progressPct.textContent = "0%";

  let done = 0;
  const total = state.stagedFiles.length;
  let failCount = 0;
  const failedNames = [];

  for (const item of state.stagedFiles) {
    const fullPath = subPath ? `${subPath}/${item.path}` : item.path;
    progressLabel.textContent = `Mengunggah ${item.path}...`;
    try {
      const base64Content = await readFileAsBase64(item.file);

      let sha;
      try {
        const existing = await ghFetch(`/repos/${repoFullName}/contents/${encodeURI(fullPath)}?ref=${encodeURIComponent(branch)}`);
        if (existing && existing.sha) sha = existing.sha;
      } catch { /* file doesn't exist yet — that's fine, create new */ }

      await ghFetch(`/repos/${repoFullName}/contents/${encodeURI(fullPath)}`, {
        method: "PUT",
        body: JSON.stringify({
          message,
          content: base64Content,
          branch,
          ...(sha ? { sha } : {}),
        }),
      });
    } catch (err) {
      failCount++;
      failedNames.push(item.path);
      console.error(`Gagal upload ${item.path}:`, err.message);
    }
    done++;
    const pct = Math.round((done / total) * 100);
    progressBar.style.width = `${pct}%`;
    progressPct.textContent = `${pct}%`;
  }

  state.pushCount += 1;
  $("#statPushCount").textContent = state.pushCount;

  if (failCount === 0) {
    logActivity("push", `Push berhasil ke ${repoFullName}`, `${total} file · branch ${branch}`);
    toast(`${total} file berhasil dipush ke ${repoFullName}`, "success");
  } else if (failCount < total) {
    logActivity("push", `Push sebagian ke ${repoFullName}`, `${total - failCount}/${total} file berhasil`);
    toast(`${total - failCount}/${total} file berhasil, ${failCount} gagal (${failedNames.slice(0, 3).join(", ")}${failedNames.length > 3 ? "..." : ""})`, "warn", 6000);
  } else {
    logActivity("error", `Push gagal ke ${repoFullName}`, "Semua file gagal diupload");
    toast("Semua file gagal diupload. Cek token / nama repo / koneksi.", "error", 6000);
  }

  clearStaged();
  $("#commitMessage").value = "";
  btn.disabled = false;
  btnText.textContent = "Push ke GitHub";
  setTimeout(() => progressWrap.classList.add("hidden"), 1500);

  await refreshRepos();
  // If explorer currently points at this repo, refresh its view too
  if (state.explorer.repoFullName === repoFullName) {
    await loadExplorerFolder();
  }
}

/* ---------------------------------------------------------------------- */
/* Event bindings                                                         */
/* ---------------------------------------------------------------------- */

function bindEvents() {
  $all("[data-view]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      switchView(btn.dataset.view);
    });
  });

  $("#btnMobileMenu").addEventListener("click", () => {
    const panel = $("#mobileNavPanel");
    const isHidden = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    $("#iconMenuOpen").classList.toggle("hidden", isHidden);
    $("#iconMenuClose").classList.toggle("hidden", !isHidden);
  });

  window.addEventListener("scroll", () => {
    $("#navbar").classList.toggle("scrolled", window.scrollY > 8);
  }, { passive: true });

  $("#btnConnect").addEventListener("click", openTokenModal);
  $("#btnHeroConnect").addEventListener("click", openTokenModal);
  $all(".btnConnectAlias").forEach((btn) => btn.addEventListener("click", openTokenModal));

  $("#btnUserMenu").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#userMenuDrop").classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!$("#userMenuWrap").contains(e.target)) $("#userMenuDrop").classList.add("hidden");
  });
  $("#btnOpenTokenModal").addEventListener("click", () => {
    $("#userMenuDrop").classList.add("hidden");
    openTokenModal();
  });
  $("#btnLogout").addEventListener("click", logout);

  $("#btnNewRepo").addEventListener("click", openNewRepoModal);
  $("#btnNewRepoQuick").addEventListener("click", openNewRepoModal);

  $("#repoSearch").addEventListener("input", renderRepoGrid);
  $("#repoSortSelect").addEventListener("change", renderRepoGrid);

  // Explorer
  $("#explorerRepoSelect").addEventListener("change", (e) => {
    const val = e.target.value;
    if (val) openRepoInExplorer(val);
  });
  $("#explorerBranchSelect").addEventListener("change", (e) => {
    state.explorer.branch = e.target.value;
    state.explorer.pathStack = [];
    loadExplorerFolder();
  });
  $("#btnExplorerRefresh").addEventListener("click", () => {
    if (state.explorer.repoFullName) loadExplorerFolder();
    else toast("Pilih repository dulu", "info", 2000);
  });

  // Upload pickers — each button triggers only its own hidden input
  $("#btnPickFiles").addEventListener("click", () => $("#fileInputMulti").click());
  $("#btnPickFolder").addEventListener("click", () => $("#fileInputFolder").click());
  $("#btnPickZip").addEventListener("click", () => $("#fileInputZip").click());

  $("#fileInputMulti").addEventListener("change", (e) => { stageFiles(e.target.files); e.target.value = ""; });
  $("#fileInputFolder").addEventListener("change", (e) => { stageFiles(e.target.files); e.target.value = ""; });
  $("#fileInputZip").addEventListener("change", async (e) => {
    if (e.target.files[0]) await stageZipFile(e.target.files[0]);
    e.target.value = "";
  });

  // Drag & drop on the dropzone panel itself (not the buttons)
  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach((evt) => {
    dz.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add("dz-active"); });
  });
  ["dragleave"].forEach((evt) => {
    dz.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.target === dz) dz.classList.remove("dz-active");
    });
  });
  dz.addEventListener("drop", async (e) => {
    e.preventDefault(); e.stopPropagation();
    dz.classList.remove("dz-active");
    const files = Array.from(e.dataTransfer.files || []);
    const zipFiles = files.filter((f) => f.name.toLowerCase().endsWith(".zip"));
    const regularFiles = files.filter((f) => !f.name.toLowerCase().endsWith(".zip"));
    if (regularFiles.length) stageFiles(regularFiles);
    for (const zf of zipFiles) await stageZipFile(zf);
  });

  $("#btnClearStaged").addEventListener("click", clearStaged);
  $("#btnDoUpload").addEventListener("click", pushStagedFiles);

  document.addEventListener("click", (e) => {
    const panel = $("#mobileNavPanel");
    const btn = $("#btnMobileMenu");
    if (!panel.classList.contains("hidden") && !panel.contains(e.target) && !btn.contains(e.target)) {
      closeMobileMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

/* ---------------------------------------------------------------------- */
/* Init                                                                    */
/* ---------------------------------------------------------------------- */

async function init() {
  bindEvents();
  loadActivity();
  renderActivity();
  renderAuthUI();
  await tryAutoConnect();
}

document.addEventListener("DOMContentLoaded", init);
