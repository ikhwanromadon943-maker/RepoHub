/* ==========================================================================
   RepoHub — GitHub Control Deck
   All interactions with GitHub go through the REST API (api.github.com)
   using a Personal Access Token stored only in the browser's localStorage.
   This file follows defensive coding practices: every piece of dynamic
   content rendered into the DOM is escaped, every external link is opened
   with rel="noopener noreferrer", and the token is never logged or sent
   anywhere except api.github.com.
   ========================================================================== */

"use strict";

const GH_API = "https://api.github.com";
const LS_TOKEN_KEY = "repohub_token";
const LS_ACTIVITY_KEY = "repohub_activity";
const LS_FAVORITES_KEY = "repohub_favorites";
const LS_ONBOARDING_KEY = "repohub_onboarding_seen";
const ALLOWED_HOSTS = new Set(["github.com", "api.github.com", "raw.githubusercontent.com", "githubusercontent.com"]);

const state = {
  token: null,
  user: null,
  tokenScopes: [],
  repos: [],
  favorites: [],
  activity: [],
  stagedFiles: [], // { path, file, size }
  uploadInProgress: false,
  pushCount: 0,
  currentView: "dashboard",
  explorer: {
    repoFullName: "",
    branch: "",
    branches: [],
    pathStack: [],
    items: [],
    loading: false,
  },
  bulkUpload: {
    enabled: false,
    selectedRepos: [],
  },
  issues: {
    repoFullName: "",
    state: "open",
    items: [],
  },
  repoDetail: {
    repoFullName: "",
    readme: null,
    commits: [],
    branches: [],
  },
  collaborate: {
    repoFullName: "",
    activeTab: "pulls",
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
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

/** Escapes any string for safe insertion into innerHTML. Core XSS defense. */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/** Escapes a string for safe use inside an HTML attribute value. */
function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, "&#96;");
}

/** Validates that a URL is https and points to an allow-listed host before use in href/src. */
function safeExternalUrl(url) {
  try {
    const u = new URL(url, window.location.href);
    if (u.protocol !== "https:") return "#";
    const hostOk = Array.from(ALLOWED_HOSTS).some((h) => u.hostname === h || u.hostname.endsWith("." + h));
    return hostOk ? u.href : "#";
  } catch {
    return "#";
  }
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/** Very small debounce helper to avoid hammering the API on every keystroke. */
function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

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
    <button type="button" class="ml-auto shrink-0 text-hub-dim hover:text-hub-ink transition-colors" aria-label="Dismiss">
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

function openModal(innerHtml, { onMount, wide = false } = {}) {
  closeModal();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "activeModal";
  backdrop.innerHTML = `<div class="modal-card${wide ? " modal-card-wide" : ""}">${innerHtml}</div>`;
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
/* Activity log (persisted locally)                                       */
/* ---------------------------------------------------------------------- */

function loadActivity() {
  try {
    state.activity = JSON.parse(localStorage.getItem(LS_ACTIVITY_KEY) || "[]");
  } catch { state.activity = []; }
}
function saveActivity() {
  try {
    localStorage.setItem(LS_ACTIVITY_KEY, JSON.stringify(state.activity.slice(0, 100)));
  } catch { /* storage full or unavailable — ignore silently */ }
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
  file_edit: { bg: "bg-hub-cyan/15", color: "text-hub-cyan", svg: `<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>` },
  visibility: { bg: "bg-hub-violet/15", color: "text-hub-violet", svg: `<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>` },
  connect: { bg: "bg-hub-amber/15", color: "text-hub-amber", svg: `<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/>` },
  issue_open: { bg: "bg-hub-teal/15", color: "text-hub-teal", svg: `<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>` },
  issue_close: { bg: "bg-hub-violet/15", color: "text-hub-violet", svg: `<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/>` },
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
    wrap.innerHTML = `<div class="p-6 text-center text-sm text-hub-dim">No activity yet.</div>`;
    return;
  }
  wrap.innerHTML = state.activity.slice(0, 6).map(activityRow).join("");
}

function clearActivityLog() {
  state.activity = [];
  saveActivity();
  renderActivity();
  renderDashboardActivity();
  toast("Activity log cleared", "info", 2200);
}

/* ---------------------------------------------------------------------- */
/* Favorites / pinned repos (persisted locally)                          */
/* ---------------------------------------------------------------------- */

function loadFavorites() {
  try {
    state.favorites = JSON.parse(localStorage.getItem(LS_FAVORITES_KEY) || "[]");
  } catch { state.favorites = []; }
}
function saveFavorites() {
  try {
    localStorage.setItem(LS_FAVORITES_KEY, JSON.stringify(state.favorites));
  } catch { /* storage unavailable — ignore */ }
}
function isFavorite(fullName) {
  return state.favorites.includes(fullName);
}
function toggleFavorite(fullName) {
  if (isFavorite(fullName)) {
    state.favorites = state.favorites.filter((f) => f !== fullName);
    toast("Removed from pinned repos", "info", 1800);
  } else {
    state.favorites.unshift(fullName);
    toast("Pinned to top of dashboard", "success", 1800);
  }
  saveFavorites();
  renderRepoGrid();
  renderDashRecentRepos();
}

/* ---------------------------------------------------------------------- */
/* Theme (light / dark)                                                   */
/* ---------------------------------------------------------------------- */


/* ---------------------------------------------------------------------- */
/* GitHub API wrapper                                                     */
/* ---------------------------------------------------------------------- */

async function ghFetch(path, options = {}) {
  if (!state.token) throw new Error("Not connected to GitHub");
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new Error("You're offline. This will retry automatically once reconnected.");
  }
  let res;
  try {
    res = await fetch(`${GH_API}${path}`, {
      ...options,
      referrerPolicy: "no-referrer",
      headers: {
        Authorization: `Bearer ${state.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new Error("Could not reach GitHub. Check your internet connection.");
  }
  if (!res.ok) {
    let msg = `GitHub API error (${res.status})`;
    try {
      const data = await res.json();
      if (data.message) msg = data.message;
    } catch { /* body wasn't JSON — keep default message */ }
    if (res.status === 401) msg = "Token is invalid or has expired";
    if (res.status === 403) msg = "Access denied — check your token scopes (needs 'repo'), or rate limit reached";
    if (res.status === 404) msg = "Not found (404)";
    if (res.status === 409) msg = "Conflict: the file or branch changed, try refreshing";
    if (res.status === 422) msg = msg || "Invalid request data";
    throw new Error(msg);
  }
  const scopeHeader = res.headers.get("x-oauth-scopes");
  if (scopeHeader !== null) {
    state.tokenScopes = scopeHeader.split(",").map((s) => s.trim()).filter(Boolean);
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

function base64ToUtf8(base64) {
  try {
    const binary = atob(base64.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null; // likely binary content — caller should handle
  }
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

/* ---------------------------------------------------------------------- */
/* Auth: connect / logout                                                 */
/* ---------------------------------------------------------------------- */

/** Basic client-side shape check before we even hit the network. Real validation happens via /user. */
function looksLikeGithubToken(v) {
  return /^[A-Za-z0-9_]{20,255}$/.test(v);
}

async function connectWithToken(token) {
  const cleaned = (token || "").trim();
  if (!cleaned) {
    toast("Token cannot be empty", "error");
    return false;
  }
  if (!looksLikeGithubToken(cleaned)) {
    toast("This doesn't look like a valid GitHub token", "error");
    return false;
  }
  try {
    const res = await fetch(`${GH_API}/user`, {
      referrerPolicy: "no-referrer",
      headers: {
        Authorization: `Bearer ${cleaned}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) {
      if (res.status === 401) throw new Error("Invalid token. Double-check and try again.");
      throw new Error(`Could not verify token (${res.status})`);
    }
    const scopeHeader = res.headers.get("x-oauth-scopes");
    state.tokenScopes = scopeHeader ? scopeHeader.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const user = await res.json();
    state.token = cleaned;
    state.user = user;
    try { localStorage.setItem(LS_TOKEN_KEY, cleaned); } catch { /* storage unavailable */ }
    logActivity("connect", "Connected to GitHub", `Signed in as @${user.login}`);
    toast(`Connected as @${user.login}`, "success");
    await onConnected();
    return true;
  } catch (err) {
    toast(err.message || "Could not connect to GitHub", "error");
    return false;
  }
}

function logout() {
  state.token = null;
  state.user = null;
  state.repos = [];
  state.tokenScopes = [];
  state.explorer = { repoFullName: "", branch: "", branches: [], pathStack: [], items: [], loading: false };
  state.issues = { repoFullName: "", state: "open", items: [] };
  try { localStorage.removeItem(LS_TOKEN_KEY); } catch {}
  closeModal();
  renderAuthUI();
  switchView("dashboard");
  toast("You've been logged out of RepoHub", "info");
}

function maybeShowOnboarding() {
  let seen;
  try { seen = localStorage.getItem(LS_ONBOARDING_KEY); } catch { seen = null; }
  if (seen) return;
  openOnboardingModal();
}

function openOnboardingModal() {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-hub-teal to-hub-cyan flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" class="w-4 h-4 text-hub-bg" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M3 12l4-7h10l4 7-9 10-9-10z"/></svg>
          </div>
          <h2 class="font-mono font-bold text-lg">Welcome to RepoHub</h2>
        </div>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <p class="text-sm text-hub-dim mb-5">You're connected as <span class="text-hub-teal font-mono">@${escapeHtml(state.user?.login || "")}</span>. Here's the fastest way to get going:</p>
      <div class="space-y-2.5">
        <div class="flex items-start gap-3 p-3.5 rounded-xl border border-hub-line bg-white/[0.02]">
          <div class="w-6 h-6 rounded-full bg-hub-teal/15 text-hub-teal font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">1</div>
          <div>
            <p class="text-sm font-medium">Create or pick a repository</p>
            <p class="text-xs text-hub-dim mt-0.5">Head to <strong class="text-hub-ink">Repositories</strong> and hit "New Repository", or use one you already have.</p>
          </div>
        </div>
        <div class="flex items-start gap-3 p-3.5 rounded-xl border border-hub-line bg-white/[0.02]">
          <div class="w-6 h-6 rounded-full bg-hub-teal/15 text-hub-teal font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">2</div>
          <div>
            <p class="text-sm font-medium">Upload your files</p>
            <p class="text-xs text-hub-dim mt-0.5">Drag a folder or ZIP into <strong class="text-hub-ink">Upload</strong> — it pushes automatically once a repo is selected.</p>
          </div>
        </div>
        <div class="flex items-start gap-3 p-3.5 rounded-xl border border-hub-line bg-white/[0.02]">
          <div class="w-6 h-6 rounded-full bg-hub-teal/15 text-hub-teal font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">3</div>
          <div>
            <p class="text-sm font-medium">Explore, track issues, collaborate</p>
            <p class="text-xs text-hub-dim mt-0.5">Browse files in <strong class="text-hub-ink">Explorer</strong>, file bugs in <strong class="text-hub-ink">Issues</strong>, and manage PRs in <strong class="text-hub-ink">Collaborate</strong>.</p>
          </div>
        </div>
      </div>
      <button id="btnDismissOnboarding" type="button" class="w-full mt-5 flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3 rounded-xl hover:brightness-110 transition-all text-sm">
        Let's go
      </button>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      const dismiss = () => {
        try { localStorage.setItem(LS_ONBOARDING_KEY, "1"); } catch {}
        closeModal();
      };
      $("#mClose", root).onclick = dismiss;
      $("#btnDismissOnboarding", root).onclick = dismiss;
    },
  });
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
  } catch {
    try { localStorage.removeItem(LS_TOKEN_KEY); } catch {}
    state.token = null;
    toast("Your saved session is no longer valid, please reconnect", "warn");
  }
}

async function onConnected(silent = false) {
  renderAuthUI();
  await refreshRepos();
  renderDashboard();
  renderSecurityInfo();
  refreshNotificationBadge();
  if (!silent) {
    switchView("dashboard");
    maybeShowOnboarding();
  }
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
    text.textContent = "Not connected";
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
    $("#btnOpenGithubProfile").href = safeExternalUrl(state.user.html_url);
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

  $("#issuesGate").classList.toggle("hidden", connected);
  $("#issuesContent").classList.toggle("hidden", !connected);

  $("#collaborateGate").classList.toggle("hidden", connected);
  $("#collaborateContent").classList.toggle("hidden", !connected);

  $("#accountGate").classList.toggle("hidden", connected);
  $("#accountContent").classList.toggle("hidden", !connected);

  if (connected) {
    $("#welcomeText").textContent = `Welcome, ${(state.user.name || state.user.login).split(" ")[0]} 👋`;
  }

  renderSecurityInfo();
}

function renderSecurityInfo() {
  const connEl = $("#secConnStatus");
  const scopeEl = $("#secScopeStatus");
  if (!connEl || !scopeEl) return;
  const connected = !!state.token && !!state.user;
  connEl.textContent = connected ? `Connected as @${state.user.login}` : "Not connected";
  connEl.className = `font-mono font-semibold ${connected ? "text-hub-teal" : "text-hub-dim"}`;
  if (!connected) {
    scopeEl.textContent = "—";
    scopeEl.className = "font-mono font-semibold text-hub-dim";
    return;
  }
  if (state.tokenScopes.length === 0) {
    scopeEl.textContent = "Fine-grained / unknown";
    scopeEl.className = "font-mono font-semibold text-hub-cyan";
  } else {
    const hasRepo = state.tokenScopes.includes("repo");
    scopeEl.textContent = state.tokenScopes.join(", ");
    scopeEl.className = `font-mono font-semibold ${hasRepo ? "text-hub-teal" : "text-hub-amber"}`;
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
  if (viewName === "security" && state.token) renderSecurityInfo();
  if (viewName === "explorer" && state.token) {
    populateExplorerRepoSelect();
    if (state.explorer.repoFullName) renderExplorerBreadcrumb();
  }
  if (viewName === "issues" && state.token) {
    populateIssuesRepoSelect();
  }
  if (viewName === "collaborate" && state.token) {
    populateCollabRepoSelect();
  }
  if (viewName === "account" && state.token) {
    loadGistsList();
    loadSshKeysList();
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
    populateRepoSelect();
    populateExplorerRepoSelect();
    populateIssuesRepoSelect();
    populateRepoLangFilter();
    renderRepoGrid();
    renderDashRecentRepos();
  } catch (err) {
    toast(err.message, "error");
  }
}

function populateRepoSelect() {
  const sel = $("#targetRepoSelect");
  const currentVal = sel.value;
  sel.innerHTML = `<option value="">— select repository —</option>` +
    state.repos.map((r) => `<option value="${escapeAttr(r.full_name)}">${escapeHtml(r.full_name)}${r.private ? " (private)" : ""}</option>`).join("");
  if (currentVal && state.repos.some((r) => r.full_name === currentVal)) sel.value = currentVal;

  const checklist = $("#bulkRepoChecklist");
  if (checklist) {
    checklist.innerHTML = state.repos.map((r) => `
      <label class="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-white/[0.04] cursor-pointer text-xs">
        <input type="checkbox" class="bulkRepoCheck w-3.5 h-3.5 rounded accent-hub-teal" value="${escapeAttr(r.full_name)}" ${state.bulkUpload.selectedRepos.includes(r.full_name) ? "checked" : ""}>
        <span class="font-mono truncate">${escapeHtml(r.full_name)}</span>
      </label>
    `).join("");
    $all(".bulkRepoCheck", checklist).forEach((cb) => {
      cb.onchange = () => {
        if (cb.checked) {
          if (!state.bulkUpload.selectedRepos.includes(cb.value)) state.bulkUpload.selectedRepos.push(cb.value);
        } else {
          state.bulkUpload.selectedRepos = state.bulkUpload.selectedRepos.filter((r) => r !== cb.value);
        }
      };
    });
  }
}

function repoCardHtml(repo) {
  const safeHtmlUrl = safeExternalUrl(repo.html_url);
  const pinned = isFavorite(repo.full_name);
  return `
    <div class="repo-card rounded-2xl border ${pinned ? "border-hub-amber/40" : "border-hub-line"} bg-white/[0.02] backdrop-blur-xl p-4 sm:p-5 flex flex-col" data-repo="${escapeAttr(repo.full_name)}">
      <div class="flex items-start justify-between gap-2 mb-2">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            ${pinned ? `<svg class="w-3.5 h-3.5 text-hub-amber shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.4 5.6 21l2.4-7.2-6-4.6h7.6z"/></svg>` : ""}
            <h3 class="font-mono font-semibold text-sm truncate">${escapeHtml(repo.name)}</h3>
          </div>
          <p class="text-[11px] text-hub-dim font-mono truncate">${escapeHtml(repo.full_name)}</p>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button class="btnRepoPin w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/[0.08] transition-all ${pinned ? "text-hub-amber" : "text-hub-dim"}" data-repo="${escapeAttr(repo.full_name)}" aria-label="${pinned ? "Unpin" : "Pin"} repository" title="${pinned ? "Unpin" : "Pin to top"}">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="${pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.4 5.6 21l2.4-7.2-6-4.6h7.6z"/></svg>
          </button>
          <span class="badge ${repo.private ? "badge-private" : "badge-public"}">${repo.private ? "Private" : "Public"}</span>
        </div>
      </div>
      <p class="text-xs text-hub-dim line-clamp-2 mb-3 flex-1 min-h-[2.2em]">${repo.description ? escapeHtml(repo.description) : "No description provided."}</p>
      <div class="flex items-center gap-3 text-[11px] font-mono text-hub-dim mb-4 flex-wrap">
        ${repo.language ? `<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-hub-teal inline-block"></span>${escapeHtml(repo.language)}</span>` : ""}
        <span class="flex items-center gap-1">
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.4 5.6 21l2.4-7.2-6-4.6h7.6z"/></svg>
          ${repo.stargazers_count}
        </span>
        <span class="flex items-center gap-1">
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>
          ${repo.forks_count ?? 0}
        </span>
        <span>Updated ${timeAgo(repo.updated_at)}</span>
      </div>
      <div class="flex items-center gap-2 mt-auto">
        <button class="btnRepoDetail flex-1 text-center text-xs font-medium bg-hub-amber/10 text-hub-amber border border-hub-amber/30 rounded-lg py-2 hover:bg-hub-amber/20 transition-all" data-repo="${escapeAttr(repo.full_name)}">Overview</button>
        <button class="btnRepoExplore flex-1 text-center text-xs font-medium bg-hub-violet/10 text-hub-violet border border-hub-violet/30 rounded-lg py-2 hover:bg-hub-violet/20 transition-all" data-repo="${escapeAttr(repo.full_name)}">Explore</button>
        <button class="btnRepoUpload text-xs font-medium bg-hub-teal/10 text-hub-teal border border-hub-teal/30 rounded-lg py-2 px-3 hover:bg-hub-teal/20 transition-all" data-repo="${escapeAttr(repo.full_name)}">Upload</button>
        <button class="btnRepoMore w-8 h-8 flex items-center justify-center rounded-lg border border-hub-line hover:bg-white/[0.09] transition-all shrink-0" data-repo="${escapeAttr(repo.full_name)}" aria-label="More options">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"/></svg>
        </button>
      </div>
    </div>
  `;
}

function populateRepoLangFilter() {
  const sel = $("#repoLangFilter");
  if (!sel) return;
  const currentVal = sel.value;
  const langs = [...new Set(state.repos.map((r) => r.language).filter(Boolean))].sort();
  sel.innerHTML = `<option value="">All languages</option>` + langs.map((l) => `<option value="${escapeAttr(l)}">${escapeHtml(l)}</option>`).join("");
  if (langs.includes(currentVal)) sel.value = currentVal;
}

function renderRepoGrid() {
  const grid = $("#repoGrid");
  const empty = $("#repoEmptyState");
  if (!grid) return;

  const query = ($("#repoSearch")?.value || "").toLowerCase();
  const sortMode = $("#repoSortSelect")?.value || "updated";
  const langFilter = $("#repoLangFilter")?.value || "";
  const visFilter = $("#repoVisFilter")?.value || "";
  const pinnedOnly = $("#repoPinnedFilter")?.checked || false;

  let list = state.repos.filter((r) => r.name.toLowerCase().includes(query));
  if (langFilter) list = list.filter((r) => r.language === langFilter);
  if (visFilter === "public") list = list.filter((r) => !r.private);
  if (visFilter === "private") list = list.filter((r) => r.private);
  if (pinnedOnly) list = list.filter((r) => isFavorite(r.full_name));

  if (sortMode === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  else if (sortMode === "stars") list = [...list].sort((a, b) => b.stargazers_count - a.stargazers_count);
  else list = [...list].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  // Pinned repos always float to the top, preserving the sort order within each group.
  list = [...list].sort((a, b) => {
    const aPin = isFavorite(a.full_name) ? 0 : 1;
    const bPin = isFavorite(b.full_name) ? 0 : 1;
    return aPin - bPin;
  });

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
  $all(".btnRepoDetail", grid).forEach((btn) => {
    btn.onclick = () => openRepoDetailModal(btn.dataset.repo);
  });
  $all(".btnRepoMore", grid).forEach((btn) => {
    btn.onclick = () => openRepoOptionsModal(btn.dataset.repo);
  });
  $all(".btnRepoPin", grid).forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      toggleFavorite(btn.dataset.repo);
    };
  });
}

function renderDashRecentRepos() {
  const wrap = $("#dashRecentRepos");
  if (!wrap) return;
  const pinned = state.repos.filter((r) => isFavorite(r.full_name));
  const rest = [...state.repos]
    .filter((r) => !isFavorite(r.full_name))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const recent = [...pinned, ...rest].slice(0, 5);

  if (recent.length === 0) {
    wrap.innerHTML = `<div class="p-6 text-center text-sm text-hub-dim">No repositories yet.</div>`;
    return;
  }
  wrap.innerHTML = recent.map((r) => `
    <div class="flex items-center gap-3 p-4 hover:bg-white/[0.02] transition-colors cursor-pointer dashRepoRow" data-repo="${escapeAttr(r.full_name)}">
      <div class="w-9 h-9 rounded-lg ${r.private ? "bg-hub-violet/15" : "bg-hub-teal/15"} flex items-center justify-center shrink-0">
        <svg class="w-4 h-4 ${r.private ? "text-hub-violet" : "text-hub-teal"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          ${r.private ? `<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>` : `<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>`}
        </svg>
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium truncate font-mono flex items-center gap-1.5">
          ${isFavorite(r.full_name) ? `<svg class="w-3 h-3 text-hub-amber shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.4 5.6 21l2.4-7.2-6-4.6h7.6z"/></svg>` : ""}
          <span class="truncate">${escapeHtml(r.name)}</span>
        </p>
        <p class="text-[11px] text-hub-dim">Updated ${timeAgo(r.updated_at)}</p>
      </div>
      <svg class="w-4 h-4 text-hub-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
    </div>
  `).join("");

  $all(".dashRepoRow", wrap).forEach((row) => {
    row.onclick = () => openRepoDetailModal(row.dataset.repo);
  });
}

function renderDashboard() {
  renderDashRecentRepos();
  renderDashboardActivity();
  $("#statPushCount").textContent = state.pushCount;
  refreshOpenIssuesCount();
}

async function refreshOpenIssuesCount() {
  // Lightweight aggregate: sum open_issues_count across all repos (already included in repo objects)
  const total = state.repos.reduce((sum, r) => sum + (r.open_issues_count || 0), 0);
  $("#statOpenIssues").textContent = total;
}

/* ---------------------------------------------------------------------- */
/* Create repo                                                            */
/* ---------------------------------------------------------------------- */

function openNewRepoModal() {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-5">
        <h2 class="font-mono font-bold text-lg">Create new repository</h2>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="space-y-4">
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Repository name</label>
          <input id="newRepoName" type="text" placeholder="my-awesome-project" autocomplete="off" spellcheck="false" maxlength="100" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
        </div>
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Description (optional)</label>
          <input id="newRepoDesc" type="text" placeholder="A short description of this repo" maxlength="350" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
        </div>
        <div class="flex items-center justify-between bg-white/[0.02] border border-hub-line rounded-xl px-4 py-3">
          <div>
            <p class="text-sm font-medium">Private repository</p>
            <p class="text-xs text-hub-dim">Only you and collaborators can see it</p>
          </div>
          <button id="togglePrivate" type="button" role="switch" aria-checked="false" class="relative w-11 h-6 rounded-full bg-white/10 transition-colors shrink-0">
            <span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-hub-dim transition-transform"></span>
          </button>
        </div>
        <label class="flex items-center gap-2.5 text-sm cursor-pointer">
          <input id="newRepoInitReadme" type="checkbox" checked class="w-4 h-4 rounded accent-hub-teal">
          Initialize with a README
        </label>
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">.gitignore template (optional)</label>
          <select id="newRepoGitignore" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-hub-teal/50 appearance-none">
            <option value="">None</option>
            ${Object.keys(GITIGNORE_TEMPLATES).map((k) => `<option value="${escapeAttr(k)}">${escapeHtml(k)}</option>`).join("")}
          </select>
        </div>
      </div>
      <button id="btnCreateRepoSubmit" type="button" class="w-full mt-6 flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3.5 rounded-xl hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-hub-teal/20">
        <span id="createRepoBtnText">Create Repository</span>
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
        if (!name) { toast("Repository name is required", "error"); return; }
        if (!/^[a-zA-Z0-9._-]+$/.test(name)) { toast("Name can only contain letters, numbers, dots, hyphens, underscores", "error"); return; }

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

          const gitignoreKey = $("#newRepoGitignore", root).value;
          if (gitignoreKey && GITIGNORE_TEMPLATES[gitignoreKey]) {
            try {
              await ghFetch(`/repos/${repo.full_name}/contents/.gitignore`, {
                method: "PUT",
                body: JSON.stringify({
                  message: "Add .gitignore via RepoHub",
                  content: utf8ToBase64(GITIGNORE_TEMPLATES[gitignoreKey]),
                  branch: repo.default_branch || "main",
                }),
              });
            } catch {
              // Non-fatal — repo was still created successfully even if this follow-up commit fails
              // (e.g. auto_init was off so there's no default branch yet to commit onto).
            }
          }

          logActivity("repo_create", `Repository created: ${repo.name}`, isPrivate ? "Private" : "Public");
          toast(`Repository "${repo.name}" created successfully`, "success");
          closeModal();
          await refreshRepos();
        } catch (err) {
          toast(err.message, "error");
          logActivity("error", "Failed to create repository", err.message);
          btn.disabled = false;
          btnText.textContent = "Create Repository";
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
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors shrink-0">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      <div class="space-y-2">
        <button id="btnGoExploreHere" type="button" class="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-hub-line hover:bg-white/[0.05] transition-all text-sm font-medium text-left">
          <svg class="w-4 h-4 text-hub-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          Explore repository files
        </button>
        <button id="btnGoIssuesHere" type="button" class="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-hub-line hover:bg-white/[0.05] transition-all text-sm font-medium text-left">
          <svg class="w-4 h-4 text-hub-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          View issues
        </button>
        <a href="${safeExternalUrl(repo.html_url)}" target="_blank" rel="noopener noreferrer" class="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-hub-line hover:bg-white/[0.05] transition-all text-sm font-medium">
          <svg class="w-4 h-4 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
          Open on GitHub
        </a>
        <button id="btnGoUploadHere" type="button" class="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-hub-line hover:bg-white/[0.05] transition-all text-sm font-medium text-left">
          <svg class="w-4 h-4 text-hub-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>
          Upload files here
        </button>
        <button id="btnToggleVisibility" type="button" class="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-hub-line hover:bg-white/[0.05] transition-all text-sm font-medium text-left">
          <svg class="w-4 h-4 text-hub-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
          Make ${repo.private ? "Public" : "Private"}
        </button>
        <button id="btnDeleteRepo" type="button" class="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-hub-coral/5 border border-hub-coral/20 hover:bg-hub-coral/10 transition-all text-sm font-medium text-left text-hub-coral">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
          Delete Repository
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
      $("#btnGoIssuesHere", root).onclick = () => {
        closeModal();
        switchView("issues");
        $("#issuesRepoSelect").value = repo.full_name;
        openRepoInIssues(repo.full_name);
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
          logActivity("visibility", `Visibility changed: ${repo.name}`, !repo.private ? "Now Private" : "Now Public");
          toast(`"${repo.name}" is now ${!repo.private ? "Private" : "Public"}`, "success");
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
      <h2 class="font-mono font-bold text-lg mb-1.5">Delete this repository?</h2>
      <p class="text-sm text-hub-dim mb-4 leading-relaxed">This action is permanent and cannot be undone. All code, issues, and history in <strong class="text-hub-ink font-mono">${escapeHtml(repo.full_name)}</strong> will be lost.</p>
      <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Type <strong class="text-hub-coral">${escapeHtml(repo.name)}</strong> to confirm</label>
      <input id="confirmRepoName" type="text" autocomplete="off" spellcheck="false" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm font-mono mb-4 focus:outline-none focus:ring-2 focus:ring-hub-coral/50" placeholder="${escapeAttr(repo.name)}">
      <div class="flex gap-3">
        <button id="mCancel" type="button" class="flex-1 border border-hub-line py-3 rounded-xl text-sm font-medium hover:bg-white/[0.05] transition-all">Cancel</button>
        <button id="btnConfirmDelete" type="button" disabled class="flex-1 flex items-center justify-center gap-2 bg-hub-coral text-white font-semibold py-3 rounded-xl hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
          <span id="deleteBtnText">Delete Permanently</span>
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
          logActivity("repo_delete", `Repository deleted: ${repo.name}`);
          toast(`"${repo.name}" deleted successfully`, "success");
          closeModal();
          if (state.explorer.repoFullName === repo.full_name) {
            state.explorer = { repoFullName: "", branch: "", branches: [], pathStack: [], items: [], loading: false };
          }
          if (state.issues.repoFullName === repo.full_name) {
            state.issues = { repoFullName: "", state: "open", items: [] };
          }
          await refreshRepos();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          $("#deleteBtnText", root).textContent = "Delete Permanently";
        }
      };
    },
  });
}

/* ---------------------------------------------------------------------- */
/* Repo Detail modal: README preview, commit history, star/fork, branches */
/* ---------------------------------------------------------------------- */

async function openRepoDetailModal(fullName) {
  const repo = state.repos.find((r) => r.full_name === fullName);
  if (!repo) return;
  state.repoDetail.repoFullName = fullName;

  const pinned = isFavorite(fullName);
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-start justify-between gap-3 mb-4">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h2 class="font-mono font-bold text-lg truncate">${escapeHtml(repo.name)}</h2>
            <span class="badge ${repo.private ? "badge-private" : "badge-public"} shrink-0">${repo.private ? "Private" : "Public"}</span>
          </div>
          <p class="text-xs text-hub-dim font-mono truncate mt-0.5">${escapeHtml(repo.full_name)}</p>
        </div>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors shrink-0">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      <div class="flex items-center gap-2 mb-5 flex-wrap">
        <button id="btnDetailStar" type="button" class="flex items-center gap-1.5 border border-hub-line px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-white/[0.05] transition-all">
          <svg id="detailStarIcon" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.4 5.6 21l2.4-7.2-6-4.6h7.6z"/></svg>
          <span id="detailStarText">Star</span>
          <span class="text-hub-dim">${repo.stargazers_count}</span>
        </button>
        <button id="btnDetailFork" type="button" class="flex items-center gap-1.5 border border-hub-line px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-white/[0.05] transition-all">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>
          Fork
          <span class="text-hub-dim">${repo.forks_count ?? 0}</span>
        </button>
        <button id="btnDetailPin" type="button" class="flex items-center gap-1.5 border ${pinned ? "border-hub-amber/40 text-hub-amber" : "border-hub-line"} px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-white/[0.05] transition-all">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="${pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.4 5.6 21l2.4-7.2-6-4.6h7.6z"/></svg>
          ${pinned ? "Pinned" : "Pin"}
        </button>
        <a href="${safeExternalUrl(repo.html_url)}" target="_blank" rel="noopener noreferrer" class="flex items-center gap-1.5 border border-hub-line px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-white/[0.05] transition-all ml-auto">
          GitHub
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M7 17L17 7M7 7h10v10"/></svg>
        </a>
      </div>

      <div class="flex items-center gap-1 border-b border-hub-line mb-4 overflow-x-auto">
        <button class="detailTab px-3.5 py-2 text-xs font-medium border-b-2 border-hub-teal text-hub-teal whitespace-nowrap" data-tab="readme">README</button>
        <button class="detailTab px-3.5 py-2 text-xs font-medium border-b-2 border-transparent text-hub-dim whitespace-nowrap" data-tab="commits">Commits</button>
        <button class="detailTab px-3.5 py-2 text-xs font-medium border-b-2 border-transparent text-hub-dim whitespace-nowrap" data-tab="branches">Branches</button>
        <button class="detailTab px-3.5 py-2 text-xs font-medium border-b-2 border-transparent text-hub-dim whitespace-nowrap" data-tab="insights">Insights</button>
        <button class="detailTab px-3.5 py-2 text-xs font-medium border-b-2 border-transparent text-hub-dim whitespace-nowrap" data-tab="releases">Releases</button>
        <button class="detailTab px-3.5 py-2 text-xs font-medium border-b-2 border-transparent text-hub-dim whitespace-nowrap" data-tab="topics">Topics</button>
        <button class="detailTab px-3.5 py-2 text-xs font-medium border-b-2 border-transparent text-hub-dim whitespace-nowrap" data-tab="danger">Settings</button>
      </div>

      <div id="detailTabReadme" class="detailTabPanel">
        <div class="flex items-center justify-center py-8"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>
      </div>
      <div id="detailTabCommits" class="detailTabPanel hidden">
        <div class="flex items-center justify-center py-8"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>
      </div>
      <div id="detailTabBranches" class="detailTabPanel hidden">
        <div class="flex items-center justify-center py-8"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>
      </div>
      <div id="detailTabInsights" class="detailTabPanel hidden">
        <div class="flex items-center justify-center py-8"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>
      </div>
      <div id="detailTabReleases" class="detailTabPanel hidden">
        <div class="flex items-center justify-center py-8"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>
      </div>
      <div id="detailTabTopics" class="detailTabPanel hidden">
        <div class="flex items-center justify-center py-8"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>
      </div>
      <div id="detailTabDanger" class="detailTabPanel hidden"></div>
    </div>
  `;

  openModal(html, {
    wide: true,
    onMount: async (root) => {
      $("#mClose", root).onclick = closeModal;

      $all(".detailTab", root).forEach((tab) => {
        tab.onclick = () => {
          $all(".detailTab", root).forEach((t) => {
            t.classList.remove("border-hub-teal", "text-hub-teal");
            t.classList.add("border-transparent", "text-hub-dim");
          });
          tab.classList.remove("border-transparent", "text-hub-dim");
          tab.classList.add("border-hub-teal", "text-hub-teal");
          $all(".detailTabPanel", root).forEach((p) => p.classList.add("hidden"));
          $(`#detailTab${capitalize(tab.dataset.tab)}`, root).classList.remove("hidden");
        };
      });

      // Star toggle
      let starred = null; // unknown until checked
      const starBtn = $("#btnDetailStar", root);
      const starIcon = $("#detailStarIcon", root);
      const starText = $("#detailStarText", root);
      try {
        await ghFetch(`/user/starred/${repo.full_name}`);
        starred = true;
      } catch {
        starred = false;
      }
      updateStarButton();
      function updateStarButton() {
        starIcon.setAttribute("fill", starred ? "currentColor" : "none");
        starBtn.classList.toggle("text-hub-amber", starred);
        starBtn.classList.toggle("border-hub-amber/40", starred);
        starText.textContent = starred ? "Starred" : "Star";
      }
      starBtn.onclick = async () => {
        starBtn.disabled = true;
        try {
          await ghFetch(`/user/starred/${repo.full_name}`, { method: starred ? "DELETE" : "PUT" });
          starred = !starred;
          updateStarButton();
          toast(starred ? "Repository starred" : "Star removed", "success", 1800);
        } catch (err) {
          toast(err.message, "error");
        } finally {
          starBtn.disabled = false;
        }
      };

      // Fork
      $("#btnDetailFork", root).onclick = async () => {
        const btn = $("#btnDetailFork", root);
        btn.disabled = true;
        try {
          await ghFetch(`/repos/${repo.full_name}/forks`, { method: "POST" });
          toast(`Forking "${repo.name}" — it will appear in your repos shortly`, "success", 4000);
          logActivity("repo_create", `Forked repository: ${repo.name}`, repo.full_name);
        } catch (err) {
          toast(err.message, "error");
        } finally {
          btn.disabled = false;
        }
      };

      // Pin
      $("#btnDetailPin", root).onclick = () => {
        toggleFavorite(repo.full_name);
        closeModal();
        openRepoDetailModal(fullName);
      };

      await loadReadmeInto(root, repo);
      await loadCommitsInto(root, repo);
      await loadBranchesInto(root, repo);
      await loadInsightsInto(root, repo);
      await loadReleasesInto(root, repo);
      await loadTopicsInto(root, repo);
      loadDangerZoneInto(root, repo);
    },
  });
}

async function loadReadmeInto(root, repo) {
  const panel = $("#detailTabReadme", root);
  try {
    const data = await ghFetch(`/repos/${repo.full_name}/readme`);
    const decoded = data.content ? base64ToUtf8(data.content) : null;
    if (decoded === null) {
      panel.innerHTML = `<p class="text-sm text-hub-dim text-center py-6">README could not be decoded.</p>`;
      return;
    }
    panel.innerHTML = `<div class="bg-white/[0.02] border border-hub-line rounded-xl p-4 max-h-80 overflow-y-auto">
      <pre class="text-xs text-hub-ink whitespace-pre-wrap font-sans leading-relaxed">${escapeHtml(decoded.slice(0, 8000))}${decoded.length > 8000 ? "\n\n… truncated, view full file on GitHub …" : ""}</pre>
    </div>`;
  } catch {
    panel.innerHTML = `<p class="text-sm text-hub-dim text-center py-6">No README found in this repository.</p>`;
  }
}

async function loadCommitsInto(root, repo) {
  const panel = $("#detailTabCommits", root);
  try {
    const commits = await ghFetch(`/repos/${repo.full_name}/commits?per_page=20`);
    if (!commits || commits.length === 0) {
      panel.innerHTML = `<p class="text-sm text-hub-dim text-center py-6">No commits found.</p>`;
      return;
    }
    panel.innerHTML = `<div class="space-y-2 max-h-80 overflow-y-auto pr-1">` + commits.map((c) => {
      const msg = (c.commit?.message || "").split("\n")[0];
      const author = c.commit?.author?.name || c.author?.login || "unknown";
      const date = c.commit?.author?.date || c.commit?.committer?.date;
      const shortSha = (c.sha || "").slice(0, 7);
      return `
        <a href="${safeExternalUrl(c.html_url)}" target="_blank" rel="noopener noreferrer" class="flex items-start gap-3 p-3 rounded-xl border border-hub-line bg-white/[0.02] hover:bg-white/[0.04] transition-all">
          <img src="${escapeAttr(c.author?.avatar_url || "")}" alt="" class="w-7 h-7 rounded-full shrink-0 mt-0.5" onerror="this.style.visibility='hidden'">
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium truncate">${escapeHtml(msg)}</p>
            <p class="text-[11px] text-hub-dim mt-0.5 font-mono">${escapeHtml(author)} · ${date ? timeAgo(date) : ""} · <span class="text-hub-cyan">${escapeHtml(shortSha)}</span></p>
          </div>
        </a>
      `;
    }).join("") + `</div>`;
  } catch (err) {
    panel.innerHTML = `<p class="text-sm text-hub-coral text-center py-6">Failed to load commits: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadBranchesInto(root, repo) {
  const panel = $("#detailTabBranches", root);
  try {
    const branches = await ghFetch(`/repos/${repo.full_name}/branches?per_page=100`);
    panel.innerHTML = `
      <div class="flex items-center gap-2 mb-3">
        <input id="newBranchName" type="text" placeholder="new-branch-name" autocomplete="off" spellcheck="false" class="flex-1 bg-hub-deep border border-hub-line rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
        <button id="btnCreateBranch" type="button" class="flex items-center gap-1.5 bg-hub-teal text-hub-bg font-semibold px-3 py-2 rounded-lg text-xs hover:brightness-110 transition-all shrink-0">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>
          Create
        </button>
      </div>
      <div id="branchListWrap" class="space-y-1.5 max-h-64 overflow-y-auto"></div>
    `;
    renderBranchList(root, repo, branches);

    $("#btnCreateBranch", root).onclick = async () => {
      const nameInput = $("#newBranchName", root);
      const name = nameInput.value.trim();
      if (!name) { toast("Enter a branch name", "error"); return; }
      if (!/^[a-zA-Z0-9._\/-]+$/.test(name)) { toast("Branch name contains invalid characters", "error"); return; }
      const btn = $("#btnCreateBranch", root);
      btn.disabled = true;
      try {
        const base = branches.find((b) => b.name === repo.default_branch) || branches[0];
        if (!base) throw new Error("Could not determine a base branch");
        const refData = await ghFetch(`/repos/${repo.full_name}/git/ref/heads/${encodeURIComponent(base.name)}`);
        await ghFetch(`/repos/${repo.full_name}/git/refs`, {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${name}`, sha: refData.object.sha }),
        });
        toast(`Branch "${name}" created`, "success");
        nameInput.value = "";
        const updated = await ghFetch(`/repos/${repo.full_name}/branches?per_page=100`);
        renderBranchList(root, repo, updated);
      } catch (err) {
        toast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    };
  } catch (err) {
    panel.innerHTML = `<p class="text-sm text-hub-coral text-center py-6">Failed to load branches: ${escapeHtml(err.message)}</p>`;
  }
}

function renderBranchList(root, repo, branches) {
  const wrap = $("#branchListWrap", root);
  if (!wrap) return;
  wrap.innerHTML = branches.map((b) => `
    <div class="flex items-center gap-2.5 p-2.5 rounded-lg border border-hub-line bg-white/[0.02]">
      <svg class="w-3.5 h-3.5 text-hub-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>
      <span class="text-xs font-mono flex-1 truncate">${escapeHtml(b.name)}</span>
      ${b.name === repo.default_branch ? `<span class="badge badge-open">default</span>` : `<button type="button" class="btnDeleteBranch text-hub-dim hover:text-hub-coral transition-colors shrink-0" data-branch="${escapeAttr(b.name)}" aria-label="Delete branch"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`}
    </div>
  `).join("");

  $all(".btnDeleteBranch", wrap).forEach((btn) => {
    btn.onclick = async () => {
      const branchName = btn.dataset.branch;
      if (!confirm(`Delete branch "${branchName}"? This cannot be undone.`)) return;
      btn.disabled = true;
      try {
        await ghFetch(`/repos/${repo.full_name}/git/refs/heads/${encodeURIComponent(branchName)}`, { method: "DELETE" });
        toast(`Branch "${branchName}" deleted`, "success");
        const updated = await ghFetch(`/repos/${repo.full_name}/branches?per_page=100`);
        renderBranchList(root, repo, updated);
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
      }
    };
  });
}

/* --- Insights: language breakdown, contributors, traffic --- */

const LANGUAGE_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5", Java: "#b07219",
  HTML: "#e34c26", CSS: "#563d7c", Go: "#00ADD8", Rust: "#dea584", Ruby: "#701516",
  PHP: "#4F5D95", "C++": "#f34b7d", C: "#555555", "C#": "#178600", Swift: "#F05138",
  Kotlin: "#A97BFF", Shell: "#89e051", Dart: "#00B4AB", Vue: "#41b883",
};
function colorForLanguage(lang) {
  return LANGUAGE_COLORS[lang] || "#7c8ba3";
}

async function loadInsightsInto(root, repo) {
  const panel = $("#detailTabInsights", root);
  panel.innerHTML = `
    <div class="mb-5">
      <h4 class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-2.5">Language breakdown</h4>
      <div id="insightsLangBar" class="h-2.5 rounded-full overflow-hidden flex bg-white/[0.05] mb-2.5"></div>
      <div id="insightsLangLegend" class="flex flex-wrap gap-x-4 gap-y-1.5"></div>
    </div>
    <div>
      <h4 class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-2.5">Top contributors</h4>
      <div id="insightsContributors" class="space-y-2"></div>
    </div>
  `;
  try {
    const [langs, contributors] = await Promise.all([
      ghFetch(`/repos/${repo.full_name}/languages`).catch(() => ({})),
      ghFetch(`/repos/${repo.full_name}/contributors?per_page=10`).catch(() => []),
    ]);

    const langEntries = Object.entries(langs || {});
    const totalBytes = langEntries.reduce((sum, [, v]) => sum + v, 0);
    const bar = $("#insightsLangBar", root);
    const legend = $("#insightsLangLegend", root);
    if (langEntries.length === 0 || totalBytes === 0) {
      bar.outerHTML = `<p class="text-xs text-hub-dim">No language data available.</p>`;
    } else {
      bar.innerHTML = langEntries.map(([lang, bytes]) => {
        const pct = (bytes / totalBytes) * 100;
        return `<div style="width:${pct.toFixed(2)}%;background:${colorForLanguage(lang)}" title="${escapeAttr(lang)}"></div>`;
      }).join("");
      legend.innerHTML = langEntries
        .sort((a, b) => b[1] - a[1])
        .map(([lang, bytes]) => {
          const pct = ((bytes / totalBytes) * 100).toFixed(1);
          return `<span class="flex items-center gap-1.5 text-xs text-hub-dim"><span class="w-2.5 h-2.5 rounded-full inline-block" style="background:${colorForLanguage(lang)}"></span>${escapeHtml(lang)} <span class="font-mono">${pct}%</span></span>`;
        }).join("");
    }

    const contribWrap = $("#insightsContributors", root);
    if (!contributors || contributors.length === 0) {
      contribWrap.innerHTML = `<p class="text-xs text-hub-dim">No contributor data available.</p>`;
    } else {
      const maxCommits = Math.max(...contributors.map((c) => c.contributions || 0), 1);
      contribWrap.innerHTML = contributors.map((c) => `
        <div class="flex items-center gap-2.5">
          <img src="${escapeAttr(c.avatar_url || "")}" alt="" class="w-6 h-6 rounded-full shrink-0">
          <span class="text-xs font-mono w-28 truncate shrink-0">${escapeHtml(c.login || "unknown")}</span>
          <div class="flex-1 h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
            <div class="h-full bg-hub-teal rounded-full" style="width:${((c.contributions || 0) / maxCommits * 100).toFixed(1)}%"></div>
          </div>
          <span class="text-[11px] font-mono text-hub-dim shrink-0">${c.contributions || 0}</span>
        </div>
      `).join("");
    }
  } catch (err) {
    panel.innerHTML = `<p class="text-sm text-hub-coral text-center py-6">Failed to load insights: ${escapeHtml(err.message)}</p>`;
  }
}

/* --- Releases --- */

async function loadReleasesInto(root, repo) {
  const panel = $("#detailTabReleases", root);
  panel.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <h4 class="text-xs font-mono uppercase tracking-wider text-hub-dim">Releases</h4>
      <button id="btnNewRelease" type="button" class="flex items-center gap-1.5 bg-hub-teal text-hub-bg font-semibold px-3 py-1.5 rounded-lg text-xs hover:brightness-110 transition-all">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>
        New release
      </button>
    </div>
    <div id="releasesListWrap" class="space-y-2 max-h-64 overflow-y-auto">
      <div class="flex items-center justify-center py-4"><span class="spinner text-hub-teal" style="width:18px;height:18px;"></span></div>
    </div>
  `;
  $("#btnNewRelease", root).onclick = () => openNewReleaseModal(root, repo);
  await refreshReleasesList(root, repo);
}

async function refreshReleasesList(root, repo) {
  const wrap = $("#releasesListWrap", root);
  try {
    const releases = await ghFetch(`/repos/${repo.full_name}/releases?per_page=15`);
    if (!releases || releases.length === 0) {
      wrap.innerHTML = `<p class="text-xs text-hub-dim text-center py-4">No releases yet.</p>`;
      return;
    }
    wrap.innerHTML = releases.map((r) => `
      <div class="flex items-start gap-3 p-3 rounded-xl border border-hub-line bg-white/[0.02]">
        <div class="w-8 h-8 rounded-lg ${r.prerelease ? "bg-hub-amber/15" : "bg-hub-teal/15"} flex items-center justify-center shrink-0">
          <svg class="w-4 h-4 ${r.prerelease ? "text-hub-amber" : "text-hub-teal"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none"/></svg>
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium truncate">${escapeHtml(r.name || r.tag_name)}</p>
          <p class="text-[11px] text-hub-dim mt-0.5 font-mono">${escapeHtml(r.tag_name)} · ${timeAgo(r.published_at || r.created_at)}${r.prerelease ? " · pre-release" : ""}</p>
        </div>
        <button type="button" class="btnDeleteRelease text-hub-dim hover:text-hub-coral transition-colors shrink-0" data-id="${r.id}" aria-label="Delete release">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
        </button>
      </div>
    `).join("");
    $all(".btnDeleteRelease", wrap).forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("Delete this release? The git tag itself will remain.")) return;
        btn.disabled = true;
        try {
          await ghFetch(`/repos/${repo.full_name}/releases/${btn.dataset.id}`, { method: "DELETE" });
          toast("Release deleted", "success");
          await refreshReleasesList(root, repo);
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
        }
      };
    });
  } catch (err) {
    wrap.innerHTML = `<p class="text-xs text-hub-coral text-center py-4">${escapeHtml(err.message)}</p>`;
  }
}

function openNewReleaseModal(parentRoot, repo) {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-5">
        <h2 class="font-mono font-bold text-lg">New Release</h2>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="space-y-4">
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Tag name</label>
          <input id="releaseTag" type="text" placeholder="v1.0.0" autocomplete="off" spellcheck="false" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
        </div>
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Release title</label>
          <input id="releaseTitle" type="text" placeholder="Version 1.0.0" maxlength="256" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
        </div>
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Release notes (optional)</label>
          <textarea id="releaseBody" rows="4" placeholder="What changed in this release..." class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-hub-teal/50"></textarea>
        </div>
        <label class="flex items-center gap-2.5 text-sm cursor-pointer">
          <input id="releasePrerelease" type="checkbox" class="w-4 h-4 rounded accent-hub-teal">
          Mark as pre-release
        </label>
      </div>
      <button id="btnSubmitRelease" type="button" class="w-full mt-6 flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3.5 rounded-xl hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-hub-teal/20">
        <span id="submitReleaseText">Publish Release</span>
      </button>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      $("#mClose", root).onclick = closeModal;
      $("#releaseTag", root).focus();
      $("#btnSubmitRelease", root).onclick = async () => {
        const tag = $("#releaseTag", root).value.trim();
        if (!tag) { toast("Tag name is required", "error"); return; }
        const btn = $("#btnSubmitRelease", root);
        const btnText = $("#submitReleaseText", root);
        btn.disabled = true;
        btnText.innerHTML = `<span class="spinner"></span>`;
        try {
          await ghFetch(`/repos/${repo.full_name}/releases`, {
            method: "POST",
            body: JSON.stringify({
              tag_name: tag,
              name: $("#releaseTitle", root).value.trim() || tag,
              body: $("#releaseBody", root).value.trim() || undefined,
              prerelease: $("#releasePrerelease", root).checked,
            }),
          });
          logActivity("repo_create", `Release published: ${tag}`, repo.full_name);
          toast(`Release "${tag}" published`, "success");
          closeModal();
          await refreshReleasesList(parentRoot, repo);
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          btnText.textContent = "Publish Release";
        }
      };
    },
  });
}

/* --- Topics --- */

async function loadTopicsInto(root, repo) {
  const panel = $("#detailTabTopics", root);
  panel.innerHTML = `
    <p class="text-xs text-hub-dim mb-3">Topics help others discover this repository on GitHub.</p>
    <div id="topicsChipWrap" class="flex flex-wrap gap-2 mb-4"></div>
    <div class="flex gap-2">
      <input id="newTopicInput" type="text" placeholder="add a topic (e.g. javascript)" autocomplete="off" spellcheck="false" class="flex-1 bg-hub-deep border border-hub-line rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
      <button id="btnAddTopic" type="button" class="flex items-center gap-1.5 bg-hub-teal text-hub-bg font-semibold px-4 py-2.5 rounded-xl text-sm hover:brightness-110 transition-all shrink-0">Add</button>
    </div>
  `;
  let topics = [];
  try {
    const data = await ghFetch(`/repos/${repo.full_name}/topics`);
    topics = data?.names || [];
  } catch {
    topics = [];
  }
  renderTopicChips(root, repo, topics);

  $("#btnAddTopic", root).onclick = async () => {
    const input = $("#newTopicInput", root);
    const raw = input.value.trim().toLowerCase();
    if (!raw) return;
    if (!/^[a-z0-9-]+$/.test(raw)) { toast("Topics can only contain lowercase letters, numbers, and hyphens", "error"); return; }
    if (topics.includes(raw)) { toast("Topic already added", "warn", 1800); return; }
    topics = [...topics, raw];
    input.value = "";
    await saveTopics(root, repo, topics);
  };
}

function renderTopicChips(root, repo, topics) {
  const wrap = $("#topicsChipWrap", root);
  if (topics.length === 0) {
    wrap.innerHTML = `<p class="text-xs text-hub-dim italic">No topics added yet.</p>`;
    return;
  }
  wrap.innerHTML = topics.map((t) => `
    <span class="inline-flex items-center gap-1.5 bg-hub-teal/10 text-hub-teal border border-hub-teal/30 rounded-full px-3 py-1 text-xs font-mono">
      ${escapeHtml(t)}
      <button type="button" class="btnRemoveTopic hover:text-hub-coral transition-colors" data-topic="${escapeAttr(t)}" aria-label="Remove topic">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </span>
  `).join("");
  $all(".btnRemoveTopic", wrap).forEach((btn) => {
    btn.onclick = async () => {
      const updated = topics.filter((t) => t !== btn.dataset.topic);
      await saveTopics(root, repo, updated);
    };
  });
}

async function saveTopics(root, repo, topics) {
  try {
    await ghFetch(`/repos/${repo.full_name}/topics`, {
      method: "PUT",
      body: JSON.stringify({ names: topics }),
    });
    renderTopicChips(root, repo, topics);
    toast("Topics updated", "success", 1800);
  } catch (err) {
    toast(err.message, "error");
  }
}

/* --- Danger zone: archive, template flag, transfer --- */

function loadDangerZoneInto(root, repo) {
  const panel = $("#detailTabDanger", root);
  panel.innerHTML = `
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-3 p-4 rounded-xl border border-hub-line bg-white/[0.02]">
        <div>
          <p class="text-sm font-medium">${repo.archived ? "Unarchive repository" : "Archive repository"}</p>
          <p class="text-xs text-hub-dim mt-0.5">${repo.archived ? "Restore write access to this repository." : "Makes the repository read-only for everyone."}</p>
        </div>
        <button id="btnToggleArchive" type="button" class="border border-hub-line px-3.5 py-2 rounded-lg text-xs font-medium hover:bg-white/[0.05] transition-all shrink-0">${repo.archived ? "Unarchive" : "Archive"}</button>
      </div>
      <div class="flex items-center justify-between gap-3 p-4 rounded-xl border border-hub-line bg-white/[0.02]">
        <div>
          <p class="text-sm font-medium">${repo.is_template ? "Remove template flag" : "Mark as template"}</p>
          <p class="text-xs text-hub-dim mt-0.5">Template repos let others generate new repos from this structure.</p>
        </div>
        <button id="btnToggleTemplate" type="button" class="border border-hub-line px-3.5 py-2 rounded-lg text-xs font-medium hover:bg-white/[0.05] transition-all shrink-0">${repo.is_template ? "Remove" : "Mark as template"}</button>
      </div>
      <div class="flex items-center justify-between gap-3 p-4 rounded-xl border border-hub-amber/20 bg-hub-amber/5">
        <div>
          <p class="text-sm font-medium">Transfer ownership</p>
          <p class="text-xs text-hub-dim mt-0.5">Move this repository to another user or organization.</p>
        </div>
        <button id="btnTransferRepo" type="button" class="border border-hub-amber/30 text-hub-amber px-3.5 py-2 rounded-lg text-xs font-medium hover:bg-hub-amber/10 transition-all shrink-0">Transfer</button>
      </div>
    </div>
  `;

  $("#btnToggleArchive", root).onclick = async () => {
    const btn = $("#btnToggleArchive", root);
    const nextState = !repo.archived;
    if (nextState && !confirm(`Archive "${repo.name}"? It will become read-only.`)) return;
    btn.disabled = true;
    try {
      await ghFetch(`/repos/${repo.full_name}`, { method: "PATCH", body: JSON.stringify({ archived: nextState }) });
      logActivity("visibility", `Repository ${nextState ? "archived" : "unarchived"}: ${repo.name}`);
      toast(`"${repo.name}" ${nextState ? "archived" : "unarchived"}`, "success");
      closeModal();
      await refreshRepos();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
    }
  };

  $("#btnToggleTemplate", root).onclick = async () => {
    const btn = $("#btnToggleTemplate", root);
    btn.disabled = true;
    try {
      await ghFetch(`/repos/${repo.full_name}`, { method: "PATCH", body: JSON.stringify({ is_template: !repo.is_template }) });
      toast(`Template flag ${!repo.is_template ? "enabled" : "removed"}`, "success");
      closeModal();
      await refreshRepos();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
    }
  };

  $("#btnTransferRepo", root).onclick = () => openTransferRepoModal(repo);
}

function openTransferRepoModal(repo) {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="w-12 h-12 rounded-full bg-hub-amber/15 flex items-center justify-center mb-4">
        <svg class="w-6 h-6 text-hub-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
      </div>
      <h2 class="font-mono font-bold text-lg mb-1.5">Transfer repository</h2>
      <p class="text-sm text-hub-dim mb-4 leading-relaxed">Transferring <strong class="text-hub-ink font-mono">${escapeHtml(repo.full_name)}</strong> moves it to another GitHub account or organization. You'll lose direct ownership immediately.</p>
      <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">New owner's username</label>
      <input id="transferNewOwner" type="text" autocomplete="off" spellcheck="false" placeholder="username-or-org" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm font-mono mb-4 focus:outline-none focus:ring-2 focus:ring-hub-amber/50">
      <div class="flex gap-3">
        <button id="mCancel" type="button" class="flex-1 border border-hub-line py-3 rounded-xl text-sm font-medium hover:bg-white/[0.05] transition-all">Cancel</button>
        <button id="btnConfirmTransfer" type="button" class="flex-1 bg-hub-amber text-hub-bg font-semibold py-3 rounded-xl hover:brightness-110 transition-all text-sm">Transfer</button>
      </div>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      $("#mCancel", root).onclick = closeModal;
      $("#transferNewOwner", root).focus();
      $("#btnConfirmTransfer", root).onclick = async () => {
        const newOwner = $("#transferNewOwner", root).value.trim();
        if (!newOwner) { toast("Enter the new owner's username", "error"); return; }
        const btn = $("#btnConfirmTransfer", root);
        btn.disabled = true;
        try {
          await ghFetch(`/repos/${repo.full_name}/transfer`, {
            method: "POST",
            body: JSON.stringify({ new_owner: newOwner }),
          });
          logActivity("repo_delete", `Repository transferred: ${repo.name}`, `to ${newOwner}`);
          toast(`Transfer of "${repo.name}" to ${newOwner} initiated`, "success");
          closeModal();
          await refreshRepos();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
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
        <h2 class="font-mono font-bold text-lg">${connected ? "Manage Token" : "Connect GitHub"}</h2>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      ${connected ? `
        <div class="flex items-center gap-3 bg-white/[0.02] border border-hub-line rounded-xl p-3 mb-4">
          <img src="${escapeAttr(state.user.avatar_url)}" alt="" class="w-10 h-10 rounded-full ring-1 ring-hub-line">
          <div class="min-w-0">
            <p class="text-sm font-medium truncate">${escapeHtml(state.user.name || state.user.login)}</p>
            <p class="text-xs text-hub-dim font-mono truncate">@${escapeHtml(state.user.login)}</p>
          </div>
          <span class="ml-auto badge badge-public shrink-0">Connected</span>
        </div>
        <p class="text-xs text-hub-dim mb-4 leading-relaxed">Your token is stored only in this browser's local storage. To switch accounts, connect a new token below, or log out from the profile menu.</p>
      ` : `
        <p class="text-sm text-hub-dim mb-4 leading-relaxed">Paste your GitHub Personal Access Token (scope <code class="text-hub-cyan bg-white/5 px-1.5 py-0.5 rounded font-mono text-xs">repo</code>). Don't have one yet? <a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener noreferrer" class="text-hub-teal hover:underline">Create one →</a></p>
      `}

      <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Personal Access Token</label>
      <div class="relative mb-1">
        <input id="tokenInput" type="password" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 pr-11 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
        <button id="btnToggleTokenVis" type="button" class="absolute right-3 top-1/2 -translate-y-1/2 text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <p class="text-[11px] text-hub-dim mb-4 flex items-center gap-1.5">
        <svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        Sent only to api.github.com over HTTPS. Never logged.
      </p>
      <button id="btnSubmitToken" type="button" class="w-full flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3.5 rounded-xl hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-hub-teal/20">
        <span id="submitTokenText">${connected ? "Switch Token" : "Connect"}</span>
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
          btnText.textContent = connected ? "Switch Token" : "Connect";
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
  sel.innerHTML = `<option value="">— select repository —</option>` +
    state.repos.map((r) => `<option value="${escapeAttr(r.full_name)}">${escapeHtml(r.full_name)}${r.private ? " (private)" : ""}</option>`).join("");
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
    sel.innerHTML = state.explorer.branches.map((b) => `<option value="${escapeAttr(b.name)}">${escapeHtml(b.name)}</option>`).join("") || `<option value="main">main</option>`;
    sel.value = state.explorer.branch;
  } catch (err) {
    toast("Failed to load branches: " + err.message, "error");
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
    toast("Failed to load folder contents: " + err.message, "error");
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
const TEXT_EDITABLE_EXTENSIONS = new Set(["md", "txt", "json", "js", "ts", "jsx", "tsx", "css", "html", "yml", "yaml", "py", "java", "c", "cpp", "go", "rs", "php", "rb", "sh", "xml", "toml", "ini", "gitignore", "env", "csv", "svg"]);

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
    const ext = (item.name.split(".").pop() || "").toLowerCase();
    const isEditable = TEXT_EDITABLE_EXTENSIONS.has(ext);
    return `
      <div class="explorer-row flex items-center gap-3 p-3.5" data-idx="${idx}" data-type="file">
        <div class="w-8 h-8 rounded-lg bg-white/[0.05] flex items-center justify-center shrink-0">
          <svg class="w-4 h-4 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${iconForFileName(item.name)}</svg>
        </div>
        <div class="min-w-0 flex-1 cursor-pointer explorerFileClick" data-idx="${idx}">
          <p class="text-sm font-mono truncate">${escapeHtml(item.name)}</p>
          <p class="text-[11px] text-hub-dim">${fmtBytes(item.size)}${isEditable ? " · editable" : ""}</p>
        </div>
        <a href="${safeExternalUrl(item.html_url)}" target="_blank" rel="noopener noreferrer" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/[0.08] transition-all shrink-0 text-hub-dim hover:text-hub-teal" aria-label="Open on GitHub" onclick="event.stopPropagation()">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
        </a>
        <button class="btnExplorerFileDelete w-8 h-8 flex items-center justify-center rounded-lg hover:bg-hub-coral/10 transition-all shrink-0 text-hub-dim hover:text-hub-coral" data-idx="${idx}" aria-label="Delete file">
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
  $all(".explorerFileClick", listEl).forEach((el) => {
    el.onclick = () => {
      const idx = Number(el.dataset.idx);
      openFilePreviewModal(state.explorer.items[idx]);
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

/* --- File preview / inline text editor --- */

/** Minimal dependency-free syntax highlighter — enough for readability without pulling in a library. */
function highlightCode(code, ext) {
  const escaped = escapeHtml(code);
  const rules = {
    js: [[/(\/\/.*$)/gm, "cm"], [/(".*?"|'.*?'|`.*?`)/g, "st"], [/\b(function|const|let|var|return|if|else|for|while|class|import|export|from|async|await|new|this|try|catch|throw|typeof|null|undefined|true|false)\b/g, "kw"]],
    ts: [[/(\/\/.*$)/gm, "cm"], [/(".*?"|'.*?'|`.*?`)/g, "st"], [/\b(function|const|let|var|return|if|else|for|while|class|import|export|from|async|await|new|this|try|catch|throw|typeof|interface|type|extends|implements|null|undefined|true|false)\b/g, "kw"]],
    py: [[/(#.*$)/gm, "cm"], [/(".*?"|'.*?')/g, "st"], [/\b(def|return|if|elif|else|for|while|class|import|from|as|try|except|raise|with|lambda|None|True|False|self)\b/g, "kw"]],
    json: [[/(".*?")\s*:/g, "kw"], [/:\s*(".*?")/g, "st"]],
    css: [[/(\/\*[\s\S]*?\*\/)/g, "cm"], [/([.#][a-zA-Z0-9_-]+)/g, "kw"], [/(".*?"|'.*?')/g, "st"]],
    html: [[/(&lt;!--[\s\S]*?--&gt;)/g, "cm"], [/(&lt;\/?[a-zA-Z0-9-]+)/g, "kw"]],
  };
  const set = rules[ext] || rules.js;
  let out = escaped;
  out = out.replace(/(&lt;!--[\s\S]*?--&gt;|\/\/.*$|#.*$|\/\*[\s\S]*?\*\/)/gm, (m) => `<span class="tok-cm">${m}</span>`);
  out = out.replace(/(".*?"|'.*?'|`.*?`)/g, (m) => `<span class="tok-st">${m}</span>`);
  const kwList = ["function","const","let","var","return","if","else","for","while","class","import","export","from","async","await","new","this","try","catch","throw","typeof","interface","type","extends","implements","def","elif","except","raise","with","lambda","self","null","undefined","true","false","None","True","False"];
  out = out.replace(new RegExp(`\\b(${kwList.join("|")})\\b`, "g"), (m) => `<span class="tok-kw">${m}</span>`);
  return out;
}

async function openFilePreviewModal(item) {
  const ext = (item.name.split(".").pop() || "").toLowerCase();
  const isEditable = TEXT_EDITABLE_EXTENSIONS.has(ext);
  const isImage = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);

  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-4">
        <div class="min-w-0 flex-1">
          <h2 class="font-mono font-bold text-base truncate">${escapeHtml(item.name)}</h2>
          <p class="text-xs text-hub-dim font-mono truncate">${escapeHtml(item.path)}</p>
        </div>
        <div class="flex items-center gap-1.5 shrink-0 ml-3">
          <button id="btnFileHistory" type="button" class="w-8 h-8 flex items-center justify-center rounded-lg border border-hub-line hover:bg-white/[0.05] transition-all" aria-label="File history" title="View file history">
            <svg class="w-4 h-4 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 106 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>
          </button>
          <button id="btnFileRename" type="button" class="w-8 h-8 flex items-center justify-center rounded-lg border border-hub-line hover:bg-white/[0.05] transition-all" aria-label="Rename or move file" title="Rename or move">
            <svg class="w-4 h-4 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
      </div>
      <div id="filePreviewBody" class="min-h-[120px]">
        <div class="flex items-center justify-center py-10">
          <span class="spinner text-hub-teal" style="width:22px;height:22px;"></span>
        </div>
      </div>
    </div>
  `;

  openModal(html, {
    wide: true,
    onMount: async (root) => {
      $("#mClose", root).onclick = closeModal;
      $("#btnFileHistory", root).onclick = () => openFileHistoryModal(item);
      $("#btnFileRename", root).onclick = () => openFileRenameModal(item);
      const body = $("#filePreviewBody", root);

      if (isImage) {
        body.innerHTML = `<div class="rounded-xl overflow-hidden border border-hub-line bg-hub-deep flex items-center justify-center p-4"><img src="${escapeAttr(item.download_url)}" alt="${escapeAttr(item.name)}" class="max-h-[50vh] max-w-full object-contain rounded-lg"></div>
          <a href="${safeExternalUrl(item.html_url)}" target="_blank" rel="noopener noreferrer" class="mt-4 w-full flex items-center justify-center gap-2 border border-hub-line py-2.5 rounded-xl text-sm font-medium hover:bg-white/[0.05] transition-all">Open on GitHub</a>`;
        return;
      }

      if (!isEditable) {
        body.innerHTML = `
          <div class="text-center py-8">
            <p class="text-sm text-hub-dim mb-4">Preview isn't available for this file type.</p>
            <a href="${safeExternalUrl(item.html_url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 bg-hub-teal text-hub-bg font-semibold px-4 py-2.5 rounded-xl text-sm hover:brightness-110 transition-all">Open on GitHub</a>
          </div>
        `;
        return;
      }

      try {
        const fileData = await ghFetch(`/repos/${state.explorer.repoFullName}/contents/${encodeURI(item.path)}?ref=${encodeURIComponent(state.explorer.branch)}`);
        const decoded = fileData.content ? base64ToUtf8(fileData.content) : "";
        if (decoded === null) {
          body.innerHTML = `
            <div class="text-center py-8">
              <p class="text-sm text-hub-dim mb-4">This file appears to be binary and can't be edited here.</p>
              <a href="${safeExternalUrl(item.html_url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 bg-hub-teal text-hub-bg font-semibold px-4 py-2.5 rounded-xl text-sm hover:brightness-110 transition-all">Open on GitHub</a>
            </div>
          `;
          return;
        }
        body.innerHTML = `
          <div class="flex items-center gap-2 mb-2">
            <button id="btnTogglePreviewMode" type="button" class="text-[11px] font-mono text-hub-teal hover:underline">Switch to plain edit mode</button>
          </div>
          <div id="highlightedView" class="w-full h-[45vh] bg-hub-deep border border-hub-line rounded-xl p-4 text-xs font-mono leading-relaxed overflow-auto"><pre class="whitespace-pre-wrap break-words"><code id="highlightedCode"></code></pre></div>
          <textarea id="fileEditArea" spellcheck="false" class="hidden w-full h-[45vh] bg-hub-deep border border-hub-line rounded-xl p-4 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-hub-teal/50 leading-relaxed"></textarea>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block mt-4">Commit message</label>
          <input id="fileEditCommitMsg" type="text" placeholder="Update ${escapeAttr(item.name)}" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-2.5 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
          <div class="flex gap-3">
            <button id="btnDiscardFileEdit" type="button" class="flex-1 border border-hub-line py-3 rounded-xl text-sm font-medium hover:bg-white/[0.05] transition-all">Cancel</button>
            <button id="btnSaveFileEdit" type="button" class="flex-1 flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3 rounded-xl hover:brightness-110 transition-all">
              <span id="saveFileEditText">Save Changes</span>
            </button>
          </div>
        `;
        // Set value via property assignment (not innerHTML) to avoid any injection through file content.
        const editArea = $("#fileEditArea", root);
        editArea.value = decoded;
        $("#highlightedCode", root).innerHTML = highlightCode(decoded, ext);

        let editMode = false;
        const highlightedView = $("#highlightedView", root);
        const toggleBtn = $("#btnTogglePreviewMode", root);
        toggleBtn.onclick = () => {
          editMode = !editMode;
          highlightedView.classList.toggle("hidden", editMode);
          editArea.classList.toggle("hidden", !editMode);
          toggleBtn.textContent = editMode ? "Switch to highlighted view" : "Switch to plain edit mode";
          if (editMode) editArea.focus();
        };

        $("#btnDiscardFileEdit", root).onclick = closeModal;
        $("#btnSaveFileEdit", root).onclick = async () => {
          const btn = $("#btnSaveFileEdit", root);
          const btnText = $("#saveFileEditText", root);
          btn.disabled = true;
          btnText.innerHTML = `<span class="spinner"></span>`;
          try {
            const newContent = editArea.value;
            const commitMsg = $("#fileEditCommitMsg", root).value.trim() || `Update ${item.name} via RepoHub`;
            await ghFetch(`/repos/${state.explorer.repoFullName}/contents/${encodeURI(item.path)}`, {
              method: "PUT",
              body: JSON.stringify({
                message: commitMsg,
                content: utf8ToBase64(newContent),
                sha: fileData.sha,
                branch: state.explorer.branch,
              }),
            });
            logActivity("file_edit", `File updated: ${item.name}`, item.path);
            toast(`"${item.name}" saved successfully`, "success");
            closeModal();
            await loadExplorerFolder();
          } catch (err) {
            toast(err.message, "error");
            btn.disabled = false;
            btnText.textContent = "Save Changes";
          }
        };
      } catch (err) {
        body.innerHTML = `<p class="text-sm text-hub-coral text-center py-8">Failed to load file: ${escapeHtml(err.message)}</p>`;
      }
    },
  });
}

/* --- Per-file commit history --- */

async function openFileHistoryModal(item) {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-4">
        <div class="min-w-0">
          <h2 class="font-mono font-bold text-base truncate">History: ${escapeHtml(item.name)}</h2>
          <p class="text-xs text-hub-dim font-mono truncate">${escapeHtml(item.path)}</p>
        </div>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors shrink-0 ml-3">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div id="fileHistoryList" class="max-h-96 overflow-y-auto space-y-2">
        <div class="flex items-center justify-center py-8"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>
      </div>
    </div>
  `;
  openModal(html, {
    wide: true,
    onMount: async (root) => {
      $("#mClose", root).onclick = closeModal;
      const listEl = $("#fileHistoryList", root);
      try {
        const commits = await ghFetch(`/repos/${state.explorer.repoFullName}/commits?path=${encodeURIComponent(item.path)}&per_page=25`);
        if (!commits || commits.length === 0) {
          listEl.innerHTML = `<p class="text-sm text-hub-dim text-center py-6">No history found for this file.</p>`;
          return;
        }
        listEl.innerHTML = commits.map((c, idx) => {
          const msg = (c.commit?.message || "").split("\n")[0];
          const author = c.commit?.author?.name || c.author?.login || "unknown";
          const date = c.commit?.author?.date;
          return `
            <div class="fileHistoryRow flex items-start gap-3 p-3 rounded-xl border border-hub-line bg-white/[0.02] cursor-pointer hover:bg-white/[0.04] transition-colors" data-sha="${escapeAttr(c.sha)}" data-idx="${idx}">
              <img src="${escapeAttr(c.author?.avatar_url || "")}" alt="" class="w-7 h-7 rounded-full shrink-0 mt-0.5" onerror="this.style.visibility='hidden'">
              <div class="min-w-0 flex-1">
                <p class="text-xs font-medium truncate">${escapeHtml(msg)}</p>
                <p class="text-[11px] text-hub-dim mt-0.5 font-mono">${escapeHtml(author)} · ${date ? timeAgo(date) : ""} · <span class="text-hub-cyan">${escapeHtml((c.sha || "").slice(0, 7))}</span></p>
              </div>
              <svg class="w-3.5 h-3.5 text-hub-dim shrink-0 mt-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
            </div>
          `;
        }).join("");
        $all(".fileHistoryRow", listEl).forEach((row) => {
          row.onclick = () => openFileVersionAtCommit(item, commits[Number(row.dataset.idx)]);
        });
      } catch (err) {
        listEl.innerHTML = `<p class="text-sm text-hub-coral text-center py-6">Failed to load history: ${escapeHtml(err.message)}</p>`;
      }
    },
  });
}

async function openFileVersionAtCommit(item, commit) {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-4">
        <div class="min-w-0">
          <h2 class="font-mono font-bold text-base truncate">${escapeHtml(item.name)} <span class="text-hub-dim font-normal">@ ${escapeHtml((commit.sha || "").slice(0, 7))}</span></h2>
          <p class="text-xs text-hub-dim truncate mt-0.5">${escapeHtml((commit.commit?.message || "").split("\n")[0])}</p>
        </div>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors shrink-0 ml-3">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div id="fileVersionBody" class="min-h-[100px]">
        <div class="flex items-center justify-center py-8"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>
      </div>
    </div>
  `;
  openModal(html, {
    wide: true,
    onMount: async (root) => {
      $("#mClose", root).onclick = closeModal;
      const body = $("#fileVersionBody", root);
      try {
        const fileAtCommit = await ghFetch(`/repos/${state.explorer.repoFullName}/contents/${encodeURI(item.path)}?ref=${encodeURIComponent(commit.sha)}`);
        const decoded = fileAtCommit.content ? base64ToUtf8(fileAtCommit.content) : null;
        if (decoded === null) {
          body.innerHTML = `<p class="text-sm text-hub-dim text-center py-6">This version is binary and can't be previewed.</p>`;
          return;
        }
        const ext = (item.name.split(".").pop() || "").toLowerCase();
        body.innerHTML = `<div class="bg-hub-deep border border-hub-line rounded-xl p-4 text-xs font-mono leading-relaxed max-h-96 overflow-auto"><pre class="whitespace-pre-wrap break-words"><code>${highlightCode(decoded, ext)}</code></pre></div>
          <a href="${safeExternalUrl(commit.html_url)}" target="_blank" rel="noopener noreferrer" class="mt-4 w-full flex items-center justify-center gap-2 border border-hub-line py-2.5 rounded-xl text-sm font-medium hover:bg-white/[0.05] transition-all">View commit on GitHub</a>`;
      } catch (err) {
        body.innerHTML = `<p class="text-sm text-hub-coral text-center py-6">Failed to load this version: ${escapeHtml(err.message)}</p>`;
      }
    },
  });
}

/* --- Rename / move a file --- */

function openFileRenameModal(item) {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-5">
        <h2 class="font-mono font-bold text-lg">Rename or Move</h2>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <p class="text-xs text-hub-dim mb-4">Current path: <span class="font-mono text-hub-ink">${escapeHtml(item.path)}</span></p>
      <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">New path</label>
      <input id="renameNewPath" type="text" value="${escapeAttr(item.path)}" autocomplete="off" spellcheck="false" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm font-mono mb-4 focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
      <p class="text-[11px] text-hub-dim mb-4">This creates the file at the new path and removes it from the old one, as two linked commits.</p>
      <button id="btnConfirmRename" type="button" class="w-full flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3.5 rounded-xl hover:brightness-110 transition-all">
        <span id="confirmRenameText">Rename / Move</span>
      </button>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      $("#mClose", root).onclick = closeModal;
      const input = $("#renameNewPath", root);
      input.focus();
      input.setSelectionRange(0, input.value.lastIndexOf("."));
      $("#btnConfirmRename", root).onclick = async () => {
        const newPath = input.value.trim().replace(/^\/+/, "");
        if (!newPath || newPath === item.path) { toast("Enter a different path", "error"); return; }
        const btn = $("#btnConfirmRename", root);
        const btnText = $("#confirmRenameText", root);
        btn.disabled = true;
        btnText.innerHTML = `<span class="spinner"></span>`;
        try {
          const fileData = await ghFetch(`/repos/${state.explorer.repoFullName}/contents/${encodeURI(item.path)}?ref=${encodeURIComponent(state.explorer.branch)}`);
          await ghFetch(`/repos/${state.explorer.repoFullName}/contents/${encodeURI(newPath)}`, {
            method: "PUT",
            body: JSON.stringify({
              message: `Move ${item.path} to ${newPath} via RepoHub`,
              content: fileData.content,
              branch: state.explorer.branch,
            }),
          });
          await ghFetch(`/repos/${state.explorer.repoFullName}/contents/${encodeURI(item.path)}`, {
            method: "DELETE",
            body: JSON.stringify({
              message: `Remove old path ${item.path} after move via RepoHub`,
              sha: item.sha,
              branch: state.explorer.branch,
            }),
          });
          logActivity("file_edit", `File moved: ${item.name}`, `${item.path} → ${newPath}`);
          toast(`Moved to "${newPath}"`, "success");
          closeModal();
          await loadExplorerFolder();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          btnText.textContent = "Rename / Move";
        }
      };
    },
  });
}

function openExplorerFileDeleteModal(item) {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="w-12 h-12 rounded-full bg-hub-coral/15 flex items-center justify-center mb-4">
        <svg class="w-6 h-6 text-hub-coral" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
      </div>
      <h2 class="font-mono font-bold text-lg mb-1.5">Delete this file?</h2>
      <p class="text-sm text-hub-dim mb-5 leading-relaxed">The file <strong class="text-hub-ink font-mono">${escapeHtml(item.name)}</strong> will be permanently deleted from branch <strong class="text-hub-ink font-mono">${escapeHtml(state.explorer.branch)}</strong>.</p>
      <div class="flex gap-3">
        <button id="mCancel" type="button" class="flex-1 border border-hub-line py-3 rounded-xl text-sm font-medium hover:bg-white/[0.05] transition-all">Cancel</button>
        <button id="btnConfirmFileDelete" type="button" class="flex-1 flex items-center justify-center gap-2 bg-hub-coral text-white font-semibold py-3 rounded-xl hover:brightness-110 transition-all">
          <span id="fileDeleteBtnText">Delete</span>
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
              message: `Delete ${item.name} via RepoHub`,
              sha: item.sha,
              branch: state.explorer.branch,
            }),
          });
          logActivity("file_delete", `File deleted: ${item.name}`, item.path);
          toast(`"${item.name}" deleted successfully`, "success");
          closeModal();
          await loadExplorerFolder();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          $("#fileDeleteBtnText", root).textContent = "Delete";
        }
      };
    },
  });
}

/* --- Create new file / folder --- */

function openNewFileModal() {
  if (!state.explorer.repoFullName) { toast("Select a repository first", "error"); return; }
  const currentPath = currentExplorerPath();
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-5">
        <h2 class="font-mono font-bold text-lg">New File</h2>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">File name</label>
      <input id="newFileName" type="text" placeholder="example.txt" autocomplete="off" spellcheck="false" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm font-mono mb-1 focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
      <p class="text-[11px] text-hub-dim mb-4">Will be created in: <span class="font-mono">${currentPath ? escapeHtml(currentPath) + "/" : "(repository root)"}</span></p>
      <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Initial content (optional)</label>
      <textarea id="newFileContent" rows="6" spellcheck="false" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-xs font-mono mb-4 focus:outline-none focus:ring-2 focus:ring-hub-teal/50"></textarea>
      <button id="btnCreateFile" type="button" class="w-full flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3.5 rounded-xl hover:brightness-110 transition-all">
        <span id="createFileText">Create File</span>
      </button>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      $("#mClose", root).onclick = closeModal;
      $("#newFileName", root).focus();
      $("#btnCreateFile", root).onclick = async () => {
        const name = $("#newFileName", root).value.trim();
        if (!name) { toast("Enter a file name", "error"); return; }
        if (/[\\<>:"|?*]/.test(name)) { toast("File name contains invalid characters", "error"); return; }
        const fullPath = currentPath ? `${currentPath}/${name}` : name;
        const btn = $("#btnCreateFile", root);
        const btnText = $("#createFileText", root);
        btn.disabled = true;
        btnText.innerHTML = `<span class="spinner"></span>`;
        try {
          await ghFetch(`/repos/${state.explorer.repoFullName}/contents/${encodeURI(fullPath)}`, {
            method: "PUT",
            body: JSON.stringify({
              message: `Create ${fullPath} via RepoHub`,
              content: utf8ToBase64($("#newFileContent", root).value || ""),
              branch: state.explorer.branch,
            }),
          });
          logActivity("file_edit", `File created: ${name}`, fullPath);
          toast(`"${name}" created`, "success");
          closeModal();
          await loadExplorerFolder();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          btnText.textContent = "Create File";
        }
      };
    },
  });
}

function openNewFolderModal() {
  if (!state.explorer.repoFullName) { toast("Select a repository first", "error"); return; }
  const currentPath = currentExplorerPath();
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-5">
        <h2 class="font-mono font-bold text-lg">New Folder</h2>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Folder name</label>
      <input id="newFolderName" type="text" placeholder="assets" autocomplete="off" spellcheck="false" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm font-mono mb-1 focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
      <p class="text-[11px] text-hub-dim mb-4">Will be created in: <span class="font-mono">${currentPath ? escapeHtml(currentPath) + "/" : "(repository root)"}</span></p>
      <p class="text-[11px] text-hub-amber mb-4 flex items-start gap-1.5">
        <svg class="w-3.5 h-3.5 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
        Git doesn't track empty folders — a placeholder <span class="font-mono">.gitkeep</span> file will be added inside so the folder appears immediately.
      </p>
      <button id="btnCreateFolder" type="button" class="w-full flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3.5 rounded-xl hover:brightness-110 transition-all">
        <span id="createFolderText">Create Folder</span>
      </button>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      $("#mClose", root).onclick = closeModal;
      $("#newFolderName", root).focus();
      $("#btnCreateFolder", root).onclick = async () => {
        const name = $("#newFolderName", root).value.trim();
        if (!name) { toast("Enter a folder name", "error"); return; }
        if (/[\\<>:"|?*]/.test(name)) { toast("Folder name contains invalid characters", "error"); return; }
        const fullPath = currentPath ? `${currentPath}/${name}/.gitkeep` : `${name}/.gitkeep`;
        const btn = $("#btnCreateFolder", root);
        const btnText = $("#createFolderText", root);
        btn.disabled = true;
        btnText.innerHTML = `<span class="spinner"></span>`;
        try {
          await ghFetch(`/repos/${state.explorer.repoFullName}/contents/${encodeURI(fullPath)}`, {
            method: "PUT",
            body: JSON.stringify({
              message: `Create folder ${name} via RepoHub`,
              content: utf8ToBase64(""),
              branch: state.explorer.branch,
            }),
          });
          logActivity("file_edit", `Folder created: ${name}`, fullPath);
          toast(`"${name}" created`, "success");
          closeModal();
          await loadExplorerFolder();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          btnText.textContent = "Create Folder";
        }
      };
    },
  });
}

/* ---------------------------------------------------------------------- */
/* ISSUES: list, create, view, comment, close/reopen                      */
/* ---------------------------------------------------------------------- */

function populateIssuesRepoSelect() {
  const sel = $("#issuesRepoSelect");
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = `<option value="">— select repository —</option>` +
    state.repos.map((r) => `<option value="${escapeAttr(r.full_name)}">${escapeHtml(r.full_name)}${r.private ? " (private)" : ""}</option>`).join("");
  if (currentVal && state.repos.some((r) => r.full_name === currentVal)) sel.value = currentVal;
  else if (state.issues.repoFullName) sel.value = state.issues.repoFullName;
}

async function openRepoInIssues(fullName) {
  state.issues.repoFullName = fullName;
  await loadIssuesList();
}

async function loadIssuesList() {
  const { repoFullName } = state.issues;
  const stateFilter = $("#issuesStateFilter").value || "open";
  state.issues.state = stateFilter;

  const loadingEl = $("#issuesLoading");
  const emptyEl = $("#issuesEmpty");
  const listEmptyEl = $("#issuesListEmpty");
  const listEl = $("#issuesList");

  if (!repoFullName) {
    listEl.innerHTML = "";
    loadingEl.classList.add("hidden");
    listEmptyEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    return;
  }

  emptyEl.classList.add("hidden");
  listEmptyEl.classList.add("hidden");
  listEl.innerHTML = "";
  loadingEl.classList.remove("hidden");

  try {
    const issues = await ghFetch(`/repos/${repoFullName}/issues?state=${encodeURIComponent(stateFilter)}&per_page=50`);
    // GitHub's issues endpoint also returns pull requests — filter those out.
    state.issues.items = (issues || []).filter((i) => !i.pull_request);
    loadingEl.classList.add("hidden");
    if (state.issues.items.length === 0) {
      listEmptyEl.classList.remove("hidden");
    } else {
      renderIssuesList();
    }
  } catch (err) {
    loadingEl.classList.add("hidden");
    toast("Failed to load issues: " + err.message, "error");
    listEmptyEl.classList.remove("hidden");
  }
}

function issueRowHtml(issue, idx) {
  return `
    <div class="issue-row flex items-start gap-3 p-4 cursor-pointer" data-idx="${idx}">
      <div class="w-8 h-8 rounded-lg ${issue.state === "open" ? "bg-hub-teal/15" : "bg-hub-violet/15"} flex items-center justify-center shrink-0 mt-0.5">
        <svg class="w-4 h-4 ${issue.state === "open" ? "text-hub-teal" : "text-hub-violet"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          ${issue.state === "open" ? `<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>` : `<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/>`}
        </svg>
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium truncate">${escapeHtml(issue.title)}</p>
        <p class="text-xs text-hub-dim mt-0.5">#${issue.number} opened ${timeAgo(issue.created_at)} by ${escapeHtml(issue.user?.login || "unknown")}${issue.comments ? ` · ${issue.comments} comment${issue.comments === 1 ? "" : "s"}` : ""}</p>
        ${issue.labels && issue.labels.length ? `<div class="flex flex-wrap gap-1.5 mt-2">${issue.labels.map((l) => `<span class="text-[10px] font-mono px-2 py-0.5 rounded-full" style="background:#${escapeAttr(l.color || "333333")}33;color:#${escapeAttr(l.color || "cccccc")}">${escapeHtml(l.name)}</span>`).join("")}</div>` : ""}
      </div>
      <span class="badge ${issue.state === "open" ? "badge-open" : "badge-closed"} shrink-0">${issue.state}</span>
    </div>
  `;
}

function renderIssuesList() {
  const listEl = $("#issuesList");
  listEl.innerHTML = state.issues.items.map(issueRowHtml).join("");
  $all(".issue-row", listEl).forEach((row) => {
    row.onclick = () => openIssueDetailModal(state.issues.items[Number(row.dataset.idx)]);
  });
}

function openNewIssueModal() {
  if (!state.issues.repoFullName) { toast("Select a repository first", "error"); return; }
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-5">
        <h2 class="font-mono font-bold text-lg">New Issue</h2>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <p class="text-xs text-hub-dim font-mono mb-4">${escapeHtml(state.issues.repoFullName)}</p>
      <div class="space-y-4">
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Title</label>
          <input id="newIssueTitle" type="text" placeholder="Short, descriptive title" maxlength="256" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
        </div>
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Description (optional)</label>
          <textarea id="newIssueBody" rows="5" placeholder="Describe the issue in more detail..." class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-hub-teal/50"></textarea>
        </div>
      </div>
      <button id="btnSubmitIssue" type="button" class="w-full mt-6 flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3.5 rounded-xl hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-hub-teal/20">
        <span id="submitIssueText">Create Issue</span>
      </button>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      $("#mClose", root).onclick = closeModal;
      $("#newIssueTitle", root).focus();
      $("#btnSubmitIssue", root).onclick = async () => {
        const title = $("#newIssueTitle", root).value.trim();
        if (!title) { toast("Issue title is required", "error"); return; }
        const btn = $("#btnSubmitIssue", root);
        const btnText = $("#submitIssueText", root);
        btn.disabled = true;
        btnText.innerHTML = `<span class="spinner"></span>`;
        try {
          const issue = await ghFetch(`/repos/${state.issues.repoFullName}/issues`, {
            method: "POST",
            body: JSON.stringify({
              title,
              body: $("#newIssueBody", root).value.trim() || undefined,
            }),
          });
          logActivity("issue_open", `Issue opened: ${issue.title}`, `${state.issues.repoFullName} #${issue.number}`);
          toast(`Issue #${issue.number} created`, "success");
          closeModal();
          await loadIssuesList();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          btnText.textContent = "Create Issue";
        }
      };
    },
  });
}

async function openIssueDetailModal(issue) {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-start justify-between gap-3 mb-4">
        <div class="min-w-0">
          <h2 class="font-mono font-bold text-base leading-snug">${escapeHtml(issue.title)}</h2>
          <p class="text-xs text-hub-dim mt-1">#${issue.number} · <span class="badge ${issue.state === "open" ? "badge-open" : "badge-closed"}">${issue.state}</span> · opened ${timeAgo(issue.created_at)} by ${escapeHtml(issue.user?.login || "unknown")}</p>
        </div>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors shrink-0">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      <div class="bg-white/[0.02] border border-hub-line rounded-xl p-4 mb-4 max-h-56 overflow-y-auto">
        <p class="text-sm text-hub-ink whitespace-pre-wrap leading-relaxed">${issue.body ? escapeHtml(issue.body) : '<span class="text-hub-dim italic">No description provided.</span>'}</p>
      </div>

      <div id="issueCommentsWrap" class="mb-4">
        <div class="flex items-center justify-center py-4"><span class="spinner text-hub-teal" style="width:18px;height:18px;"></span></div>
      </div>

      <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Add a comment</label>
      <textarea id="newCommentBody" rows="3" placeholder="Write a comment..." class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-hub-teal/50"></textarea>
      <div class="flex gap-3">
        <button id="btnPostComment" type="button" class="flex-1 flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3 rounded-xl hover:brightness-110 transition-all text-sm">
          <span id="postCommentText">Post Comment</span>
        </button>
        <button id="btnToggleIssueState" type="button" class="flex-1 flex items-center justify-center gap-2 border border-hub-line py-3 rounded-xl text-sm font-medium hover:bg-white/[0.05] transition-all">
          <span id="toggleIssueStateText">${issue.state === "open" ? "Close Issue" : "Reopen Issue"}</span>
        </button>
      </div>
      <a href="${safeExternalUrl(issue.html_url)}" target="_blank" rel="noopener noreferrer" class="mt-3 flex items-center justify-center gap-1.5 text-xs text-hub-dim hover:text-hub-teal transition-colors">
        Open on GitHub
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M7 17L17 7M7 7h10v10"/></svg>
      </a>
    </div>
  `;

  openModal(html, {
    wide: true,
    onMount: async (root) => {
      $("#mClose", root).onclick = closeModal;

      $("#btnToggleIssueState", root).onclick = async () => {
        const btn = $("#btnToggleIssueState", root);
        const btnText = $("#toggleIssueStateText", root);
        const newState = issue.state === "open" ? "closed" : "open";
        btn.disabled = true;
        btnText.innerHTML = `<span class="spinner"></span>`;
        try {
          await ghFetch(`/repos/${state.issues.repoFullName}/issues/${issue.number}`, {
            method: "PATCH",
            body: JSON.stringify({ state: newState }),
          });
          logActivity(newState === "closed" ? "issue_close" : "issue_open", `Issue ${newState === "closed" ? "closed" : "reopened"}: ${issue.title}`, `#${issue.number}`);
          toast(`Issue #${issue.number} ${newState === "closed" ? "closed" : "reopened"}`, "success");
          closeModal();
          await loadIssuesList();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          btnText.textContent = issue.state === "open" ? "Close Issue" : "Reopen Issue";
        }
      };

      $("#btnPostComment", root).onclick = async () => {
        const text = $("#newCommentBody", root).value.trim();
        if (!text) { toast("Comment cannot be empty", "error"); return; }
        const btn = $("#btnPostComment", root);
        const btnText = $("#postCommentText", root);
        btn.disabled = true;
        btnText.innerHTML = `<span class="spinner"></span>`;
        try {
          await ghFetch(`/repos/${state.issues.repoFullName}/issues/${issue.number}/comments`, {
            method: "POST",
            body: JSON.stringify({ body: text }),
          });
          toast("Comment posted", "success");
          $("#newCommentBody", root).value = "";
          btn.disabled = false;
          btnText.textContent = "Post Comment";
          await loadCommentsInto(root, issue);
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          btnText.textContent = "Post Comment";
        }
      };

      await loadCommentsInto(root, issue);
    },
  });
}

async function loadCommentsInto(root, issue) {
  const wrap = $("#issueCommentsWrap", root);
  if (!wrap) return;
  wrap.innerHTML = `<div class="flex items-center justify-center py-4"><span class="spinner text-hub-teal" style="width:18px;height:18px;"></span></div>`;
  try {
    const comments = await ghFetch(`/repos/${state.issues.repoFullName}/issues/${issue.number}/comments?per_page=30`);
    if (!comments || comments.length === 0) {
      wrap.innerHTML = `<p class="text-xs text-hub-dim text-center py-2">No comments yet.</p>`;
      return;
    }
    wrap.innerHTML = `<div class="space-y-3 max-h-64 overflow-y-auto pr-1">` + comments.map((c) => `
      <div class="flex gap-2.5">
        <img src="${escapeAttr(c.user?.avatar_url || "")}" alt="" class="w-7 h-7 rounded-full shrink-0 mt-0.5">
        <div class="min-w-0 flex-1 bg-white/[0.02] border border-hub-line rounded-xl p-3">
          <p class="text-xs font-medium mb-1">${escapeHtml(c.user?.login || "unknown")} <span class="text-hub-dim font-normal">· ${timeAgo(c.created_at)}</span></p>
          <p class="text-xs text-hub-ink whitespace-pre-wrap leading-relaxed">${escapeHtml(c.body || "")}</p>
        </div>
      </div>
    `).join("") + `</div>`;
  } catch (err) {
    wrap.innerHTML = `<p class="text-xs text-hub-coral text-center py-2">Failed to load comments: ${escapeHtml(err.message)}</p>`;
  }
}

/* ---------------------------------------------------------------------- */
/* COLLABORATE: Pull Requests, Collaborators, Actions, Webhooks           */
/* ---------------------------------------------------------------------- */

function populateCollabRepoSelect() {
  const sel = $("#collabRepoSelect");
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = `<option value="">— select repository —</option>` +
    state.repos.map((r) => `<option value="${escapeAttr(r.full_name)}">${escapeHtml(r.full_name)}${r.private ? " (private)" : ""}</option>`).join("");
  if (currentVal && state.repos.some((r) => r.full_name === currentVal)) sel.value = currentVal;
  else if (state.collaborate.repoFullName) sel.value = state.collaborate.repoFullName;
}

function switchCollabTab(tabName) {
  state.collaborate.activeTab = tabName;
  $all(".collabTab").forEach((t) => {
    const active = t.dataset.tab === tabName;
    t.classList.toggle("border-hub-teal", active);
    t.classList.toggle("text-hub-teal", active);
    t.classList.toggle("border-transparent", !active);
    t.classList.toggle("text-hub-dim", !active);
  });
  $all(".collabPanel").forEach((p) => p.classList.add("hidden"));
  const panelMap = { pulls: "collabPanelPulls", collabs: "collabPanelCollabs", actions: "collabPanelActions", webhooks: "collabPanelWebhooks" };
  $(`#${panelMap[tabName]}`).classList.remove("hidden");
  loadCollabTabData(tabName);
}

async function onCollabRepoSelected(fullName) {
  state.collaborate.repoFullName = fullName;
  if (!fullName) return;
  await loadCollabTabData(state.collaborate.activeTab);
}

async function loadCollabTabData(tabName) {
  const repoFullName = state.collaborate.repoFullName;
  if (tabName === "pulls") return loadPullRequests(repoFullName);
  if (tabName === "collabs") return loadCollaborators(repoFullName);
  if (tabName === "actions") return loadWorkflowRuns(repoFullName);
  if (tabName === "webhooks") return loadWebhooks(repoFullName);
}

/* --- Pull Requests --- */

async function loadPullRequests(repoFullName) {
  const emptyEl = $("#collabPullsEmpty");
  const listEl = $("#collabPullsList");
  if (!repoFullName) {
    emptyEl.classList.remove("hidden");
    listEl.classList.add("hidden");
    emptyEl.innerHTML = `<p class="text-sm text-hub-dim">Select a repository to view pull requests.</p>`;
    return;
  }
  emptyEl.classList.remove("hidden");
  listEl.classList.add("hidden");
  emptyEl.innerHTML = `<div class="flex items-center justify-center py-4"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>`;
  try {
    const prs = await ghFetch(`/repos/${repoFullName}/pulls?state=open&per_page=30`);
    if (!prs || prs.length === 0) {
      emptyEl.innerHTML = `<p class="text-sm text-hub-dim">No open pull requests for this repository.</p>`;
      return;
    }
    emptyEl.classList.add("hidden");
    listEl.classList.remove("hidden");
    listEl.innerHTML = prs.map((pr, idx) => `
      <div class="issue-row flex items-start gap-3 p-4 cursor-pointer" data-idx="${idx}">
        <div class="w-8 h-8 rounded-lg bg-hub-cyan/15 flex items-center justify-center shrink-0 mt-0.5">
          <svg class="w-4 h-4 text-hub-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 009 9"/></svg>
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium truncate">${escapeHtml(pr.title)}</p>
          <p class="text-xs text-hub-dim mt-0.5">#${pr.number} by ${escapeHtml(pr.user?.login || "unknown")} · ${timeAgo(pr.created_at)} · <span class="font-mono text-hub-violet">${escapeHtml(pr.head?.ref || "?")}</span> → <span class="font-mono text-hub-teal">${escapeHtml(pr.base?.ref || "?")}</span></p>
        </div>
        ${pr.draft ? `<span class="badge badge-closed shrink-0">draft</span>` : `<span class="badge badge-open shrink-0">open</span>`}
      </div>
    `).join("");
    $all(".issue-row", listEl).forEach((row) => {
      row.onclick = () => openPullRequestModal(repoFullName, prs[Number(row.dataset.idx)]);
    });
  } catch (err) {
    emptyEl.innerHTML = `<p class="text-sm text-hub-coral">Failed to load pull requests: ${escapeHtml(err.message)}</p>`;
  }
}

function openPullRequestModal(repoFullName, pr) {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-start justify-between gap-3 mb-4">
        <div class="min-w-0">
          <h2 class="font-mono font-bold text-base leading-snug">${escapeHtml(pr.title)}</h2>
          <p class="text-xs text-hub-dim mt-1">#${pr.number} · <span class="font-mono text-hub-violet">${escapeHtml(pr.head?.ref || "?")}</span> → <span class="font-mono text-hub-teal">${escapeHtml(pr.base?.ref || "?")}</span> · opened ${timeAgo(pr.created_at)} by ${escapeHtml(pr.user?.login || "unknown")}</p>
        </div>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors shrink-0">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="bg-white/[0.02] border border-hub-line rounded-xl p-4 mb-4 max-h-56 overflow-y-auto">
        <p class="text-sm text-hub-ink whitespace-pre-wrap leading-relaxed">${pr.body ? escapeHtml(pr.body) : '<span class="text-hub-dim italic">No description provided.</span>'}</p>
      </div>
      <div class="flex gap-3">
        <button id="btnMergePR" type="button" class="flex-1 flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3 rounded-xl hover:brightness-110 transition-all text-sm">
          <span id="mergePRText">Merge Pull Request</span>
        </button>
        <button id="btnClosePR" type="button" class="flex-1 border border-hub-coral/30 text-hub-coral py-3 rounded-xl text-sm font-medium hover:bg-hub-coral/10 transition-all">
          Close without merging
        </button>
      </div>
      <a href="${safeExternalUrl(pr.html_url)}" target="_blank" rel="noopener noreferrer" class="mt-3 flex items-center justify-center gap-1.5 text-xs text-hub-dim hover:text-hub-teal transition-colors">
        Review full diff on GitHub
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M7 17L17 7M7 7h10v10"/></svg>
      </a>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      $("#mClose", root).onclick = closeModal;
      $("#btnMergePR", root).onclick = async () => {
        if (!confirm(`Merge pull request #${pr.number} into ${pr.base?.ref}?`)) return;
        const btn = $("#btnMergePR", root);
        const btnText = $("#mergePRText", root);
        btn.disabled = true;
        btnText.innerHTML = `<span class="spinner"></span>`;
        try {
          await ghFetch(`/repos/${repoFullName}/pulls/${pr.number}/merge`, { method: "PUT" });
          logActivity("issue_close", `Pull request merged: ${pr.title}`, `${repoFullName} #${pr.number}`);
          toast(`Pull request #${pr.number} merged`, "success");
          closeModal();
          await loadPullRequests(repoFullName);
          await refreshRepos();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          btnText.textContent = "Merge Pull Request";
        }
      };
      $("#btnClosePR", root).onclick = async () => {
        const btn = $("#btnClosePR", root);
        btn.disabled = true;
        try {
          await ghFetch(`/repos/${repoFullName}/pulls/${pr.number}`, {
            method: "PATCH",
            body: JSON.stringify({ state: "closed" }),
          });
          logActivity("issue_close", `Pull request closed: ${pr.title}`, `${repoFullName} #${pr.number}`);
          toast(`Pull request #${pr.number} closed`, "success");
          closeModal();
          await loadPullRequests(repoFullName);
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
        }
      };
    },
  });
}

/* --- Collaborators --- */

async function loadCollaborators(repoFullName) {
  const emptyEl = $("#collabCollabsEmpty");
  const bodyEl = $("#collabCollabsBody");
  if (!repoFullName) {
    emptyEl.classList.remove("hidden");
    bodyEl.classList.add("hidden");
    emptyEl.innerHTML = `<p class="text-sm text-hub-dim">Select a repository to manage collaborators.</p>`;
    return;
  }
  emptyEl.classList.remove("hidden");
  bodyEl.classList.add("hidden");
  emptyEl.innerHTML = `<div class="flex items-center justify-center py-4"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>`;
  try {
    const collabs = await ghFetch(`/repos/${repoFullName}/collaborators?per_page=50`);
    emptyEl.classList.add("hidden");
    bodyEl.classList.remove("hidden");
    renderCollaboratorsList(repoFullName, collabs || []);
  } catch (err) {
    emptyEl.innerHTML = `<p class="text-sm text-hub-coral">Failed to load collaborators: ${escapeHtml(err.message)}</p>`;
  }
}

function renderCollaboratorsList(repoFullName, collabs) {
  const listEl = $("#collabCollabsList");
  if (collabs.length === 0) {
    listEl.innerHTML = `<div class="p-6 text-center text-sm text-hub-dim">No collaborators yet — you're the sole owner.</div>`;
    return;
  }
  listEl.innerHTML = collabs.map((c) => `
    <div class="flex items-center gap-3 p-3.5">
      <img src="${escapeAttr(c.avatar_url)}" alt="" class="w-8 h-8 rounded-full shrink-0">
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium truncate">${escapeHtml(c.login)}</p>
        <p class="text-[11px] text-hub-dim font-mono">${escapeHtml(c.permissions?.admin ? "Admin" : c.permissions?.push ? "Write" : "Read")}</p>
      </div>
      ${c.login === state.user?.login ? "" : `<button type="button" class="btnRemoveCollab text-hub-dim hover:text-hub-coral transition-colors shrink-0" data-login="${escapeAttr(c.login)}" aria-label="Remove collaborator"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`}
    </div>
  `).join("");

  $all(".btnRemoveCollab", listEl).forEach((btn) => {
    btn.onclick = async () => {
      const login = btn.dataset.login;
      if (!confirm(`Remove ${login} as a collaborator?`)) return;
      btn.disabled = true;
      try {
        await ghFetch(`/repos/${repoFullName}/collaborators/${encodeURIComponent(login)}`, { method: "DELETE" });
        toast(`${login} removed`, "success");
        await loadCollaborators(repoFullName);
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
      }
    };
  });
}

/* --- GitHub Actions workflow runs --- */

async function loadWorkflowRuns(repoFullName) {
  const emptyEl = $("#collabActionsEmpty");
  const listEl = $("#collabActionsList");
  if (!repoFullName) {
    emptyEl.classList.remove("hidden");
    listEl.classList.add("hidden");
    emptyEl.innerHTML = `<p class="text-sm text-hub-dim">Select a repository to view workflow runs.</p>`;
    return;
  }
  emptyEl.classList.remove("hidden");
  listEl.classList.add("hidden");
  emptyEl.innerHTML = `<div class="flex items-center justify-center py-4"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>`;
  try {
    const data = await ghFetch(`/repos/${repoFullName}/actions/runs?per_page=20`);
    const runs = data?.workflow_runs || [];
    if (runs.length === 0) {
      emptyEl.innerHTML = `<p class="text-sm text-hub-dim">No workflow runs found. This repo may not use GitHub Actions.</p>`;
      return;
    }
    emptyEl.classList.add("hidden");
    listEl.classList.remove("hidden");
    listEl.innerHTML = runs.map((run) => {
      const statusColor = run.conclusion === "success" ? "text-hub-teal" : run.conclusion === "failure" ? "text-hub-coral" : "text-hub-amber";
      const statusBg = run.conclusion === "success" ? "bg-hub-teal/15" : run.conclusion === "failure" ? "bg-hub-coral/15" : "bg-hub-amber/15";
      const statusIcon = run.conclusion === "success"
        ? `<path d="M20 6L9 17l-5-5"/>`
        : run.conclusion === "failure"
        ? `<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>`
        : `<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`;
      return `
        <a href="${safeExternalUrl(run.html_url)}" target="_blank" rel="noopener noreferrer" class="flex items-center gap-3 p-3.5 hover:bg-white/[0.03] transition-colors">
          <div class="w-8 h-8 rounded-lg ${statusBg} flex items-center justify-center shrink-0">
            <svg class="w-4 h-4 ${statusColor}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${statusIcon}</svg>
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium truncate">${escapeHtml(run.name || run.display_title || "Workflow run")}</p>
            <p class="text-[11px] text-hub-dim mt-0.5 font-mono">${escapeHtml(run.head_branch || "?")} · ${escapeHtml(run.status)}${run.conclusion ? ` · ${escapeHtml(run.conclusion)}` : ""} · ${timeAgo(run.created_at)}</p>
          </div>
        </a>
      `;
    }).join("");
  } catch (err) {
    emptyEl.innerHTML = `<p class="text-sm text-hub-coral">Failed to load workflow runs: ${escapeHtml(err.message)}</p>`;
  }
}

/* --- Webhooks --- */

async function loadWebhooks(repoFullName) {
  const emptyEl = $("#collabWebhooksEmpty");
  const bodyEl = $("#collabWebhooksBody");
  if (!repoFullName) {
    emptyEl.classList.remove("hidden");
    bodyEl.classList.add("hidden");
    emptyEl.innerHTML = `<p class="text-sm text-hub-dim">Select a repository to manage webhooks.</p>`;
    return;
  }
  emptyEl.classList.remove("hidden");
  bodyEl.classList.add("hidden");
  emptyEl.innerHTML = `<div class="flex items-center justify-center py-4"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>`;
  try {
    const hooks = await ghFetch(`/repos/${repoFullName}/hooks?per_page=50`);
    emptyEl.classList.add("hidden");
    bodyEl.classList.remove("hidden");
    renderWebhooksList(repoFullName, hooks || []);
  } catch (err) {
    emptyEl.innerHTML = `<p class="text-sm text-hub-coral">Failed to load webhooks: ${escapeHtml(err.message)}${err.message.includes("denied") ? " (requires admin access to this repository)" : ""}</p>`;
  }
}

function renderWebhooksList(repoFullName, hooks) {
  const listEl = $("#collabWebhooksList");
  if (hooks.length === 0) {
    listEl.innerHTML = `<div class="p-6 text-center text-sm text-hub-dim">No webhooks configured for this repository.</div>`;
    return;
  }
  listEl.innerHTML = hooks.map((h) => `
    <div class="flex items-center gap-3 p-3.5">
      <div class="w-8 h-8 rounded-lg ${h.active ? "bg-hub-teal/15" : "bg-hub-dim/15"} flex items-center justify-center shrink-0">
        <svg class="w-4 h-4 ${h.active ? "text-hub-teal" : "text-hub-dim"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 118 15h.02"/><path d="M8 15a4 4 0 01-6 0"/></svg>
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-mono truncate">${escapeHtml(h.config?.url || "unknown URL")}</p>
        <p class="text-[11px] text-hub-dim">${h.active ? "Active" : "Disabled"} · ${(h.events || []).join(", ")}</p>
      </div>
      <button type="button" class="btnRemoveWebhook text-hub-dim hover:text-hub-coral transition-colors shrink-0" data-id="${h.id}" aria-label="Delete webhook">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
      </button>
    </div>
  `).join("");

  $all(".btnRemoveWebhook", listEl).forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Delete this webhook?")) return;
      btn.disabled = true;
      try {
        await ghFetch(`/repos/${repoFullName}/hooks/${btn.dataset.id}`, { method: "DELETE" });
        toast("Webhook deleted", "success");
        await loadWebhooks(repoFullName);
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
      }
    };
  });
}

async function addWebhook(repoFullName, url) {
  if (!repoFullName) { toast("Select a repository first", "error"); return; }
  if (!/^https:\/\/.+/i.test(url)) { toast("Webhook URL must start with https://", "error"); return; }
  const btn = $("#btnAddWebhook");
  btn.disabled = true;
  try {
    await ghFetch(`/repos/${repoFullName}/hooks`, {
      method: "POST",
      body: JSON.stringify({
        name: "web",
        active: true,
        events: ["push"],
        config: { url, content_type: "json" },
      }),
    });
    toast("Webhook added", "success");
    $("#webhookUrl").value = "";
    await loadWebhooks(repoFullName);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------------- */
/* ACCOUNT: Gists & SSH Keys                                              */
/* ---------------------------------------------------------------------- */

function switchAccountTab(tabName) {
  $all(".accountTab").forEach((t) => {
    const active = t.dataset.tab === tabName;
    t.classList.toggle("border-hub-teal", active);
    t.classList.toggle("text-hub-teal", active);
    t.classList.toggle("border-transparent", !active);
    t.classList.toggle("text-hub-dim", !active);
  });
  $("#accountPanelGists").classList.toggle("hidden", tabName !== "gists");
  $("#accountPanelKeys").classList.toggle("hidden", tabName !== "keys");
}

async function loadGistsList() {
  const wrap = $("#gistsListWrap");
  wrap.innerHTML = `<div class="flex items-center justify-center py-8"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>`;
  try {
    const gists = await ghFetch(`/gists?per_page=30`);
    if (!gists || gists.length === 0) {
      wrap.innerHTML = `<div class="p-8 text-center text-sm text-hub-dim">No gists yet. Create your first one above.</div>`;
      return;
    }
    wrap.innerHTML = gists.map((g, idx) => {
      const files = Object.keys(g.files || {});
      const firstFile = files[0] || "untitled";
      return `
        <div class="flex items-start gap-3 p-3.5">
          <div class="w-8 h-8 rounded-lg ${g.public ? "bg-hub-teal/15" : "bg-hub-violet/15"} flex items-center justify-center shrink-0">
            <svg class="w-4 h-4 ${g.public ? "text-hub-teal" : "text-hub-violet"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-mono truncate">${escapeHtml(g.description || firstFile)}</p>
            <p class="text-[11px] text-hub-dim mt-0.5">${files.length} file${files.length === 1 ? "" : "s"} · ${g.public ? "Public" : "Secret"} · Updated ${timeAgo(g.updated_at)}</p>
          </div>
          <a href="${safeExternalUrl(g.html_url)}" target="_blank" rel="noopener noreferrer" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/[0.08] transition-all shrink-0 text-hub-dim hover:text-hub-teal" aria-label="Open gist">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
          </a>
          <button type="button" class="btnDeleteGist w-8 h-8 flex items-center justify-center rounded-lg hover:bg-hub-coral/10 transition-all shrink-0 text-hub-dim hover:text-hub-coral" data-id="${escapeAttr(g.id)}" aria-label="Delete gist">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
          </button>
        </div>
      `;
    }).join("");
    $all(".btnDeleteGist", wrap).forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("Delete this gist? This cannot be undone.")) return;
        btn.disabled = true;
        try {
          await ghFetch(`/gists/${btn.dataset.id}`, { method: "DELETE" });
          toast("Gist deleted", "success");
          await loadGistsList();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
        }
      };
    });
  } catch (err) {
    wrap.innerHTML = `<div class="p-8 text-center text-sm text-hub-coral">${escapeHtml(err.message)}</div>`;
  }
}

function openNewGistModal() {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-5">
        <h2 class="font-mono font-bold text-lg">New Gist</h2>
        <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="space-y-4">
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Description (optional)</label>
          <input id="gistDesc" type="text" placeholder="What is this gist for?" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
        </div>
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">File name</label>
          <input id="gistFileName" type="text" placeholder="snippet.js" autocomplete="off" spellcheck="false" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
        </div>
        <div>
          <label class="text-xs font-mono uppercase tracking-wider text-hub-dim mb-1.5 block">Content</label>
          <textarea id="gistContent" rows="8" spellcheck="false" class="w-full bg-hub-deep border border-hub-line rounded-xl px-4 py-3 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-hub-teal/50"></textarea>
        </div>
        <label class="flex items-center gap-2.5 text-sm cursor-pointer">
          <input id="gistPublic" type="checkbox" class="w-4 h-4 rounded accent-hub-teal">
          Make this gist public
        </label>
      </div>
      <button id="btnSubmitGist" type="button" class="w-full mt-6 flex items-center justify-center gap-2 bg-hub-teal text-hub-bg font-semibold py-3.5 rounded-xl hover:brightness-110 transition-all">
        <span id="submitGistText">Create Gist</span>
      </button>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      $("#mClose", root).onclick = closeModal;
      $("#gistFileName", root).focus();
      $("#btnSubmitGist", root).onclick = async () => {
        const fileName = $("#gistFileName", root).value.trim();
        const content = $("#gistContent", root).value;
        if (!fileName) { toast("File name is required", "error"); return; }
        if (!content.trim()) { toast("Gist content cannot be empty", "error"); return; }
        const btn = $("#btnSubmitGist", root);
        const btnText = $("#submitGistText", root);
        btn.disabled = true;
        btnText.innerHTML = `<span class="spinner"></span>`;
        try {
          await ghFetch(`/gists`, {
            method: "POST",
            body: JSON.stringify({
              description: $("#gistDesc", root).value.trim() || undefined,
              public: $("#gistPublic", root).checked,
              files: { [fileName]: { content } },
            }),
          });
          toast("Gist created", "success");
          closeModal();
          await loadGistsList();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          btnText.textContent = "Create Gist";
        }
      };
    },
  });
}

async function loadSshKeysList() {
  const wrap = $("#sshKeysListWrap");
  wrap.innerHTML = `<div class="flex items-center justify-center py-8"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>`;
  try {
    const keys = await ghFetch(`/user/keys`);
    if (!keys || keys.length === 0) {
      wrap.innerHTML = `<div class="p-8 text-center text-sm text-hub-dim">No SSH keys added yet.</div>`;
      return;
    }
    wrap.innerHTML = keys.map((k) => `
      <div class="flex items-center gap-3 p-3.5">
        <div class="w-8 h-8 rounded-lg bg-hub-cyan/15 flex items-center justify-center shrink-0">
          <svg class="w-4 h-4 text-hub-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium truncate">${escapeHtml(k.title || "Untitled key")}</p>
          <p class="text-[11px] text-hub-dim font-mono truncate mt-0.5">${escapeHtml((k.key || "").slice(0, 40))}...</p>
        </div>
        <button type="button" class="btnDeleteSshKey text-hub-dim hover:text-hub-coral transition-colors shrink-0" data-id="${k.id}" aria-label="Delete key">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
        </button>
      </div>
    `).join("");
    $all(".btnDeleteSshKey", wrap).forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("Remove this SSH key from your account?")) return;
        btn.disabled = true;
        try {
          await ghFetch(`/user/keys/${btn.dataset.id}`, { method: "DELETE" });
          toast("SSH key removed", "success");
          await loadSshKeysList();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
        }
      };
    });
  } catch (err) {
    wrap.innerHTML = `<div class="p-8 text-center text-sm text-hub-coral">${escapeHtml(err.message)}</div>`;
  }
}

async function addSshKey(title, keyValue) {
  if (!title.trim()) { toast("Enter a key title", "error"); return; }
  if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-)/.test(keyValue.trim())) { toast("This doesn't look like a valid SSH public key", "error"); return; }
  const btn = $("#btnAddSshKey");
  btn.disabled = true;
  try {
    await ghFetch(`/user/keys`, {
      method: "POST",
      body: JSON.stringify({ title: title.trim(), key: keyValue.trim() }),
    });
    toast("SSH key added", "success");
    $("#sshKeyTitle").value = "";
    $("#sshKeyValue").value = "";
    await loadSshKeysList();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}



function openGlobalSearchModal() {
  if (!state.token) { openTokenModal(); return; }
  const html = `
    <div class="p-5 sm:p-6">
      <div class="relative mb-4">
        <svg class="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-hub-dim pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input id="globalSearchInput" type="text" placeholder="Search your repositories or code across GitHub..." autocomplete="off" spellcheck="false" class="w-full bg-hub-deep border border-hub-line rounded-xl pl-11 pr-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-hub-teal/50">
      </div>
      <div class="flex items-center gap-2 mb-4">
        <button class="searchModeBtn active-search-mode text-xs font-medium px-3 py-1.5 rounded-full border border-hub-teal/40 bg-hub-teal/10 text-hub-teal" data-mode="repos">My Repositories</button>
        <button class="searchModeBtn text-xs font-medium px-3 py-1.5 rounded-full border border-hub-line text-hub-dim" data-mode="code">Code on GitHub</button>
      </div>
      <div id="globalSearchResults" class="max-h-96 overflow-y-auto">
        <p class="text-sm text-hub-dim text-center py-8">Start typing to search.</p>
      </div>
    </div>
  `;
  openModal(html, {
    wide: true,
    onMount: (root) => {
      const input = $("#globalSearchInput", root);
      const resultsEl = $("#globalSearchResults", root);
      let mode = "repos";
      input.focus();

      $all(".searchModeBtn", root).forEach((btn) => {
        btn.onclick = () => {
          mode = btn.dataset.mode;
          $all(".searchModeBtn", root).forEach((b) => {
            b.classList.toggle("active-search-mode", b === btn);
            b.classList.toggle("border-hub-teal/40", b === btn);
            b.classList.toggle("bg-hub-teal/10", b === btn);
            b.classList.toggle("text-hub-teal", b === btn);
            b.classList.toggle("border-hub-line", b !== btn);
            b.classList.toggle("text-hub-dim", b !== btn);
          });
          runSearch(input.value.trim(), mode, resultsEl);
        };
      });

      const debouncedSearch = debounce(() => runSearch(input.value.trim(), mode, resultsEl), 350);
      input.addEventListener("input", debouncedSearch);
    },
  });
}

async function runSearch(query, mode, resultsEl) {
  if (!query) {
    resultsEl.innerHTML = `<p class="text-sm text-hub-dim text-center py-8">Start typing to search.</p>`;
    return;
  }
  resultsEl.innerHTML = `<div class="flex items-center justify-center py-8"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>`;

  if (mode === "repos") {
    const q = query.toLowerCase();
    const matches = state.repos.filter((r) =>
      r.name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q)
    ).slice(0, 20);
    if (matches.length === 0) {
      resultsEl.innerHTML = `<p class="text-sm text-hub-dim text-center py-8">No repositories match "${escapeHtml(query)}".</p>`;
      return;
    }
    resultsEl.innerHTML = matches.map((r) => `
      <div class="searchResultRow flex items-center gap-3 p-3 rounded-xl hover:bg-white/[0.03] cursor-pointer transition-colors" data-repo="${escapeAttr(r.full_name)}">
        <div class="w-8 h-8 rounded-lg ${r.private ? "bg-hub-violet/15" : "bg-hub-teal/15"} flex items-center justify-center shrink-0">
          <svg class="w-4 h-4 ${r.private ? "text-hub-violet" : "text-hub-teal"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium font-mono truncate">${escapeHtml(r.full_name)}</p>
          ${r.description ? `<p class="text-xs text-hub-dim truncate">${escapeHtml(r.description)}</p>` : ""}
        </div>
      </div>
    `).join("");
    $all(".searchResultRow", resultsEl).forEach((row) => {
      row.onclick = () => {
        closeModal();
        openRepoDetailModal(row.dataset.repo);
      };
    });
    return;
  }

  // Code search across GitHub (scoped implicitly to what the token can access)
  try {
    const data = await ghFetch(`/search/code?q=${encodeURIComponent(query)}&per_page=20`);
    const items = data?.items || [];
    if (items.length === 0) {
      resultsEl.innerHTML = `<p class="text-sm text-hub-dim text-center py-8">No code results for "${escapeHtml(query)}".</p>`;
      return;
    }
    resultsEl.innerHTML = items.map((item) => `
      <a href="${safeExternalUrl(item.html_url)}" target="_blank" rel="noopener noreferrer" class="flex items-center gap-3 p-3 rounded-xl hover:bg-white/[0.03] transition-colors">
        <div class="w-8 h-8 rounded-lg bg-white/[0.05] flex items-center justify-center shrink-0">
          <svg class="w-4 h-4 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-mono truncate">${escapeHtml(item.name)}</p>
          <p class="text-xs text-hub-dim truncate">${escapeHtml(item.repository?.full_name || "")} · ${escapeHtml(item.path)}</p>
        </div>
      </a>
    `).join("");
  } catch (err) {
    resultsEl.innerHTML = `<p class="text-sm text-hub-coral text-center py-8">${escapeHtml(err.message)}</p>`;
  }
}

/* ---------------------------------------------------------------------- */
/* NOTIFICATIONS: GitHub notification inbox                               */
/* ---------------------------------------------------------------------- */

async function refreshNotificationBadge() {
  if (!state.token) return;
  try {
    const notifs = await ghFetch(`/notifications?per_page=50`);
    const count = (notifs || []).length;
    const badge = $("#notifBadge");
    if (count > 0) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  } catch {
    // Notifications scope may not be granted — fail silently, badge just stays hidden.
  }
}

function openNotificationsModal() {
  if (!state.token) { openTokenModal(); return; }
  const html = `
    <div class="p-5 sm:p-6">
      <div class="flex items-center justify-between mb-5">
        <h2 class="font-mono font-bold text-lg">Notifications</h2>
        <div class="flex items-center gap-2">
          <button id="btnMarkAllRead" type="button" class="text-xs text-hub-teal font-medium hover:underline">Mark all as read</button>
          <button id="mClose" type="button" class="text-hub-dim hover:text-hub-ink transition-colors ml-2">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
      </div>
      <div id="notifList" class="max-h-96 overflow-y-auto space-y-2">
        <div class="flex items-center justify-center py-8"><span class="spinner text-hub-teal" style="width:20px;height:20px;"></span></div>
      </div>
    </div>
  `;
  openModal(html, {
    wide: true,
    onMount: async (root) => {
      $("#mClose", root).onclick = closeModal;
      $("#btnMarkAllRead", root).onclick = async () => {
        const btn = $("#btnMarkAllRead", root);
        btn.disabled = true;
        try {
          await ghFetch(`/notifications`, { method: "PUT", body: JSON.stringify({ read: true }) });
          toast("All notifications marked as read", "success", 1800);
          await loadNotificationsInto(root);
          await refreshNotificationBadge();
        } catch (err) {
          toast(err.message, "error");
        } finally {
          btn.disabled = false;
        }
      };
      await loadNotificationsInto(root);
    },
  });
}

async function loadNotificationsInto(root) {
  const listEl = $("#notifList", root);
  try {
    const notifs = await ghFetch(`/notifications?per_page=50`);
    if (!notifs || notifs.length === 0) {
      listEl.innerHTML = `<p class="text-sm text-hub-dim text-center py-8">You're all caught up — no unread notifications.</p>`;
      return;
    }
    const typeIcon = {
      Issue: `<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>`,
      PullRequest: `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 009 9"/>`,
    };
    listEl.innerHTML = notifs.map((n) => `
      <div class="flex items-start gap-3 p-3 rounded-xl border border-hub-line bg-white/[0.02]">
        <div class="w-8 h-8 rounded-lg bg-hub-cyan/15 flex items-center justify-center shrink-0 mt-0.5">
          <svg class="w-4 h-4 text-hub-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${typeIcon[n.subject?.type] || `<path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>`}</svg>
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium truncate">${escapeHtml(n.subject?.title || "Notification")}</p>
          <p class="text-[11px] text-hub-dim mt-0.5 font-mono">${escapeHtml(n.repository?.full_name || "")} · ${escapeHtml(n.reason || "")} · ${timeAgo(n.updated_at)}</p>
        </div>
      </div>
    `).join("");
  } catch (err) {
    listEl.innerHTML = `<p class="text-sm text-hub-coral text-center py-8">${escapeHtml(err.message.includes("denied") ? "Notifications require the 'notifications' token scope." : err.message)}</p>`;
  }
}

/* ---------------------------------------------------------------------- */
/* GITIGNORE TEMPLATES                                                    */
/* ---------------------------------------------------------------------- */

const GITIGNORE_TEMPLATES = {
  Node: "node_modules/\nnpm-debug.log*\n.env\ndist/\nbuild/\n.DS_Store",
  Python: "__pycache__/\n*.pyc\n.venv/\nvenv/\n.env\ndist/\nbuild/\n*.egg-info/",
  Java: "*.class\ntarget/\n.gradle/\nbuild/\n*.jar\n*.war",
  "React/Next.js": "node_modules/\n.next/\nout/\nbuild/\n.env*.local\n.DS_Store",
  Android: "*.apk\n*.ap_\n.gradle/\nlocal.properties\n.idea/\nbuild/",
  General: ".DS_Store\nThumbs.db\n*.log\n.env\n.vscode/\n.idea/",
};

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
  toast(`${arr.length} file${arr.length === 1 ? "" : "s"} added — pushing automatically...`, "info", 2200);
  autoPushIfReady();
}

async function stageZipFile(zipFile) {
  if (typeof JSZip === "undefined") {
    toast("Could not load the ZIP library. Check your connection and reload the page.", "error");
    return;
  }
  toast(`Extracting ${zipFile.name}...`, "info", 2500);
  try {
    const zip = await JSZip.loadAsync(zipFile);
    const entries = Object.values(zip.files).filter((e) => !e.dir);
    if (entries.length === 0) {
      toast("The ZIP file is empty or contains no files", "warn");
      return;
    }
    for (const entry of entries) {
      const blob = await entry.async("blob");
      const name = entry.name.split("/").pop();
      const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
      state.stagedFiles.push({ path: entry.name, file, size: blob.size });
    }
    renderStagedList();
    toast(`${entries.length} file${entries.length === 1 ? "" : "s"} extracted from ${zipFile.name} — pushing automatically...`, "success");
    autoPushIfReady();
  } catch (err) {
    toast("Failed to extract ZIP: " + err.message, "error");
  }
}

/**
 * Automatically pushes staged files as soon as a target repository (or, in bulk mode,
 * at least one target repository) is selected. If nothing is targeted yet, files stay
 * staged and a reminder toast fires; picking a target then triggers the push.
 */
function autoPushIfReady() {
  const targets = getUploadTargets();
  if (targets.length === 0) {
    toast("Select a target repository to push automatically", "warn", 3000);
    return;
  }
  if (state.stagedFiles.length === 0) return;
  pushStagedFiles();
}

function getUploadTargets() {
  if (state.bulkUpload.enabled) return state.bulkUpload.selectedRepos.slice();
  const single = $("#targetRepoSelect").value;
  return single ? [single] : [];
}

async function readFileAsBase64(file) {
  const buffer = await file.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

/**
 * Checks whether any staged files would overwrite existing content that differs from
 * what's being uploaded. Returns the list of conflicting paths (empty if none / repo
 * doesn't exist yet). Used to prompt the user once per push instead of overwriting silently.
 */
async function detectConflicts(repoFullName, branch, subPath) {
  const conflicts = [];
  for (const item of state.stagedFiles) {
    const fullPath = subPath ? `${subPath}/${item.path}` : item.path;
    try {
      const existing = await ghFetch(`/repos/${repoFullName}/contents/${encodeURI(fullPath)}?ref=${encodeURIComponent(branch)}`);
      if (existing && existing.sha) {
        // Compare content only for reasonably small text-ish files to avoid excessive base64 work;
        // larger or binary files are flagged as "existing" conflicts by presence alone.
        conflicts.push({ path: fullPath, sha: existing.sha, size: existing.size });
      }
    } catch {
      // 404 — file doesn't exist yet, no conflict.
    }
  }
  return conflicts;
}

function openConflictConfirmModal(conflicts, repoLabel) {
  return new Promise((resolve) => {
    const html = `
      <div class="p-5 sm:p-6">
        <div class="w-12 h-12 rounded-full bg-hub-amber/15 flex items-center justify-center mb-4">
          <svg class="w-6 h-6 text-hub-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
        </div>
        <h2 class="font-mono font-bold text-lg mb-1.5">${conflicts.length} file(s) already exist</h2>
        <p class="text-sm text-hub-dim mb-4 leading-relaxed">These files already exist in <strong class="text-hub-ink font-mono">${escapeHtml(repoLabel)}</strong> and will be overwritten:</p>
        <div class="bg-white/[0.02] border border-hub-line rounded-xl p-3 mb-5 max-h-32 overflow-y-auto">
          ${conflicts.slice(0, 12).map((c) => `<p class="text-xs font-mono text-hub-dim truncate">${escapeHtml(c.path)}</p>`).join("")}
          ${conflicts.length > 12 ? `<p class="text-xs font-mono text-hub-dim mt-1">…and ${conflicts.length - 12} more</p>` : ""}
        </div>
        <div class="flex gap-3">
          <button id="mCancelConflict" type="button" class="flex-1 border border-hub-line py-3 rounded-xl text-sm font-medium hover:bg-white/[0.05] transition-all">Skip these files</button>
          <button id="btnConfirmOverwrite" type="button" class="flex-1 bg-hub-amber text-hub-bg font-semibold py-3 rounded-xl hover:brightness-110 transition-all text-sm">Overwrite All</button>
        </div>
      </div>
    `;
    openModal(html, {
      onMount: (root) => {
        $("#mCancelConflict", root).onclick = () => { closeModal(); resolve(false); };
        $("#btnConfirmOverwrite", root).onclick = () => { closeModal(); resolve(true); };
      },
    });
  });
}

async function pushStagedFiles() {
  const targets = getUploadTargets();
  const branch = $("#targetBranch").value.trim() || "main";
  const subPath = $("#targetPath").value.trim().replace(/^\/+|\/+$/g, "");
  const message = $("#commitMessage").value.trim() || `Upload ${state.stagedFiles.length} file(s) via RepoHub`;

  if (targets.length === 0) { toast("Select a target repository first", "error"); return; }
  if (state.stagedFiles.length === 0) { toast("No files staged for upload", "error"); return; }
  if (state.uploadInProgress) return; // guard against overlapping auto-triggers
  state.uploadInProgress = true;

  const btn = $("#btnDoUpload");
  const btnText = $("#btnDoUploadText");
  if (btn) { btn.disabled = true; btnText.innerHTML = `<span class="spinner"></span>`; }

  const progressWrap = $("#uploadProgressWrap");
  const progressBar = $("#uploadProgressBar");
  const progressPct = $("#uploadProgressPct");
  const progressLabel = $("#uploadProgressLabel");
  progressWrap.classList.remove("hidden");
  progressBar.style.width = "0%";
  progressPct.textContent = "0%";

  // Conflict check runs once against the first target as a representative sample —
  // for bulk pushes each repo is still checked individually below before writing.
  let skipConflicting = false;
  const firstTargetConflicts = await detectConflicts(targets[0], branch, subPath);
  if (firstTargetConflicts.length > 0) {
    const label = targets.length > 1 ? `${targets[0]} (+${targets.length - 1} more)` : targets[0];
    const proceedOverwrite = await openConflictConfirmModal(firstTargetConflicts, label);
    if (!proceedOverwrite) skipConflicting = true;
  }

  let grandTotalFiles = 0;
  let grandFailCount = 0;
  const perRepoResults = [];

  const totalOps = targets.length * state.stagedFiles.length;
  let doneOps = 0;

  for (const repoFullName of targets) {
    const conflictPaths = new Set((await detectConflicts(repoFullName, branch, subPath)).map((c) => c.path));
    let repoFail = 0;
    const failedNames = [];

    for (const item of state.stagedFiles) {
      const fullPath = subPath ? `${subPath}/${item.path}` : item.path;
      progressLabel.textContent = `Uploading ${item.path} → ${repoFullName}...`;

      if (skipConflicting && conflictPaths.has(fullPath)) {
        doneOps++;
        const pct = Math.round((doneOps / totalOps) * 100);
        progressBar.style.width = `${pct}%`;
        progressPct.textContent = `${pct}%`;
        continue;
      }

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
        grandTotalFiles++;
      } catch (err) {
        repoFail++;
        grandFailCount++;
        failedNames.push(item.path);
        console.error(`Failed to upload ${item.path} to ${repoFullName}:`, err.message);
      }
      doneOps++;
      const pct = Math.round((doneOps / totalOps) * 100);
      progressBar.style.width = `${pct}%`;
      progressPct.textContent = `${pct}%`;
    }
    perRepoResults.push({ repoFullName, failCount: repoFail, failedNames });
  }

  state.pushCount += 1;
  $("#statPushCount").textContent = state.pushCount;

  const total = state.stagedFiles.length;
  if (targets.length === 1) {
    const { repoFullName, failCount, failedNames } = perRepoResults[0];
    if (failCount === 0) {
      logActivity("push", `Pushed to ${repoFullName}`, `${total} file(s) · branch ${branch}`);
      toast(`${total} file(s) pushed to ${repoFullName}`, "success");
    } else if (failCount < total) {
      logActivity("push", `Partial push to ${repoFullName}`, `${total - failCount}/${total} file(s) succeeded`);
      toast(`${total - failCount}/${total} file(s) succeeded, ${failCount} failed (${failedNames.slice(0, 3).join(", ")}${failedNames.length > 3 ? "..." : ""})`, "warn", 6000);
    } else {
      logActivity("error", `Push failed for ${repoFullName}`, "All files failed to upload");
      toast("All files failed to upload. Check your token, repository name, or connection.", "error", 6000);
    }
  } else {
    const successRepos = perRepoResults.filter((r) => r.failCount === 0).length;
    logActivity("push", `Bulk push to ${targets.length} repositories`, `${successRepos}/${targets.length} repos fully succeeded`);
    if (grandFailCount === 0) {
      toast(`${total} file(s) pushed to ${targets.length} repositories`, "success");
    } else {
      toast(`Bulk push finished with ${grandFailCount} failure(s) across ${targets.length} repositories`, "warn", 6000);
    }
  }

  clearStaged();
  $("#commitMessage").value = "";
  if (btn) { btn.disabled = false; btnText.textContent = "Push to GitHub"; }
  state.uploadInProgress = false;
  setTimeout(() => progressWrap.classList.add("hidden"), 1500);

  await refreshRepos();
  if (targets.includes(state.explorer.repoFullName)) {
    await loadExplorerFolder();
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
    <div class="flex items-center gap-3 p-3.5 stagedFileRow" data-idx="${idx}" draggable="true">
      <svg class="w-3.5 h-3.5 text-hub-dim shrink-0 cursor-grab active:cursor-grabbing" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.4"/><circle cx="8" cy="12" r="1.4"/><circle cx="8" cy="18" r="1.4"/><circle cx="16" cy="6" r="1.4"/><circle cx="16" cy="12" r="1.4"/><circle cx="16" cy="18" r="1.4"/></svg>
      <div class="w-8 h-8 rounded-lg bg-white/[0.05] flex items-center justify-center shrink-0">
        <svg class="w-4 h-4 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${iconForFileName(item.path)}</svg>
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-mono truncate">${escapeHtml(item.path)}</p>
        <p class="text-[11px] text-hub-dim">${fmtBytes(item.size)}</p>
      </div>
      <button type="button" class="btnRemoveStaged text-hub-dim hover:text-hub-coral transition-colors shrink-0" data-idx="${idx}" aria-label="Remove file">
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

  // Drag-to-reorder: simple HTML5 drag/drop swap on the queue before it auto-pushes.
  let dragSrcIdx = null;
  $all(".stagedFileRow", list).forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      dragSrcIdx = Number(row.dataset.idx);
      e.dataTransfer.effectAllowed = "move";
      row.style.opacity = "0.4";
    });
    row.addEventListener("dragend", () => { row.style.opacity = "1"; });
    row.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const targetIdx = Number(row.dataset.idx);
      if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;
      const [moved] = state.stagedFiles.splice(dragSrcIdx, 1);
      state.stagedFiles.splice(targetIdx, 0, moved);
      renderStagedList();
    });
  });
}

function clearStaged() {
  state.stagedFiles = [];
  renderStagedList();
  $("#uploadProgressWrap").classList.add("hidden");
}

/* ---------------------------------------------------------------------- */
/* Event bindings                                                         */
/* ---------------------------------------------------------------------- */

function bindEvents() {
  $("#btnGlobalSearch").addEventListener("click", openGlobalSearchModal);
  $("#btnNotifications").addEventListener("click", openNotificationsModal);

  $("#bulkUploadToggle").addEventListener("change", (e) => {
    state.bulkUpload.enabled = e.target.checked;
    $("#targetRepoSelect").classList.toggle("hidden", state.bulkUpload.enabled);
    $("#bulkRepoChecklist").classList.toggle("hidden", !state.bulkUpload.enabled);
  });

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

  $("#repoSearch").addEventListener("input", debounce(renderRepoGrid, 150));
  $("#repoSortSelect").addEventListener("change", renderRepoGrid);
  $("#repoLangFilter").addEventListener("change", renderRepoGrid);
  $("#repoVisFilter").addEventListener("change", renderRepoGrid);
  $("#repoPinnedFilter").addEventListener("change", renderRepoGrid);

  // If files are already staged and the user then picks a repo, push right away.
  $("#targetRepoSelect").addEventListener("change", () => {
    if (state.stagedFiles.length > 0) autoPushIfReady();
  });

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
    else toast("Select a repository first", "info", 2000);
  });
  $("#btnExplorerNewFile").addEventListener("click", openNewFileModal);
  $("#btnExplorerNewFolder").addEventListener("click", openNewFolderModal);

  // Issues
  $("#issuesRepoSelect").addEventListener("change", (e) => {
    const val = e.target.value;
    if (val) openRepoInIssues(val);
  });
  $("#issuesStateFilter").addEventListener("change", () => {
    if (state.issues.repoFullName) loadIssuesList();
  });
  $("#btnNewIssue").addEventListener("click", openNewIssueModal);

  // Collaborate
  $("#collabRepoSelect").addEventListener("change", (e) => onCollabRepoSelected(e.target.value));
  $all(".collabTab").forEach((tab) => {
    tab.addEventListener("click", () => switchCollabTab(tab.dataset.tab));
  });
  $("#btnCollabInvite").addEventListener("click", async () => {
    const username = $("#collabInviteUsername").value.trim();
    const repoFullName = state.collaborate.repoFullName;
    if (!repoFullName) { toast("Select a repository first", "error"); return; }
    if (!username) { toast("Enter a GitHub username", "error"); return; }
    const btn = $("#btnCollabInvite");
    btn.disabled = true;
    try {
      await ghFetch(`/repos/${repoFullName}/collaborators/${encodeURIComponent(username)}`, {
        method: "PUT",
        body: JSON.stringify({ permission: "push" }),
      });
      toast(`Invitation sent to ${username}`, "success");
      $("#collabInviteUsername").value = "";
      await loadCollaborators(repoFullName);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
  $("#btnAddWebhook").addEventListener("click", () => {
    addWebhook(state.collaborate.repoFullName, $("#webhookUrl").value.trim());
  });

  // Account (Gists + SSH Keys)
  $all(".accountTab").forEach((tab) => {
    tab.addEventListener("click", () => switchAccountTab(tab.dataset.tab));
  });
  $("#btnNewGist").addEventListener("click", openNewGistModal);
  $("#btnAddSshKey").addEventListener("click", () => {
    addSshKey($("#sshKeyTitle").value, $("#sshKeyValue").value);
  });

  // Activity
  $("#btnClearActivity").addEventListener("click", clearActivityLog);

  // Security center
  $("#btnRevokeLocalToken").addEventListener("click", () => {
    openWipeTokenConfirmModal();
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

  // Defense in depth: block any accidental javascript: URLs from being followed via delegated click.
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (a && /^\s*javascript:/i.test(a.getAttribute("href") || "")) {
      e.preventDefault();
    }
  }, true);

  // Offline queue: if the connection drops mid-session, staged files wait; when it
  // returns, any files still staged (upload interrupted or never started) auto-retry.
  window.addEventListener("offline", () => {
    toast("You're offline. Uploads will resume automatically once reconnected.", "warn", 5000);
  });
  window.addEventListener("online", () => {
    toast("Back online.", "success", 2200);
    if (state.stagedFiles.length > 0 && !state.uploadInProgress) {
      autoPushIfReady();
    }
  });
}

function openWipeTokenConfirmModal() {
  const html = `
    <div class="p-5 sm:p-6">
      <div class="w-12 h-12 rounded-full bg-hub-coral/15 flex items-center justify-center mb-4">
        <svg class="w-6 h-6 text-hub-coral" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
      </div>
      <h2 class="font-mono font-bold text-lg mb-1.5">Wipe token from this browser?</h2>
      <p class="text-sm text-hub-dim mb-5 leading-relaxed">This removes the token from local storage and logs you out of RepoHub on this device. This does not revoke the token on GitHub — for that, visit your <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" class="text-hub-teal hover:underline">GitHub token settings</a>.</p>
      <div class="flex gap-3">
        <button id="mCancel" type="button" class="flex-1 border border-hub-line py-3 rounded-xl text-sm font-medium hover:bg-white/[0.05] transition-all">Cancel</button>
        <button id="btnConfirmWipe" type="button" class="flex-1 bg-hub-coral text-white font-semibold py-3 rounded-xl hover:brightness-110 transition-all text-sm">Wipe Token</button>
      </div>
    </div>
  `;
  openModal(html, {
    onMount: (root) => {
      $("#mCancel", root).onclick = closeModal;
      $("#btnConfirmWipe", root).onclick = () => {
        logout();
      };
    },
  });
}

/* ---------------------------------------------------------------------- */
/* Init                                                                    */
/* ---------------------------------------------------------------------- */

async function init() {
  bindEvents();
  loadFavorites();
  loadActivity();
  renderActivity();
  renderAuthUI();
  await tryAutoConnect();
}

document.addEventListener("DOMContentLoaded", init);
