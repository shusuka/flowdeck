"use strict";

const api = window.flowdeck;

// Display metadata for the provider ids served by the backend.
const APP_META = {
  "google-flow": { short: "Flow", icon: "🎬" },
  dola: { short: "Dola", icon: "💬" },
  migoo: { short: "Migoo", icon: "✨" },
};
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5];

// ---- State -----------------------------------------------------------------
// An account is one login identity: { id, name, email, apps: [providerId] }.
// Every app of an account shares that account's login session, so a Google
// login made in Flow is already there when the same account opens Dola/Migoo.
let accounts = [];
let prompts = [];
let providers = [];
let active = null; // { accountId, provider } of the view on screen
let editingPromptId = null;
let editingAccountId = null;
let draftApps = new Set(); // app toggles in the account modal
let pickProvider = null; // app the "add account to app" flow is for
// Views created during this run; they keep running in the background.
const loaded = new Set();

// ---- Local UI preferences --------------------------------------------------
const PREFS_KEY = "flowdeck.prefs";
const prefs = { sidebarHidden: false, collapsedGroups: {}, zoom: {}, last: null };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"));
} catch {}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

// ---- Helpers ---------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

// crypto.randomUUID needs a secure context, which file:// is not guaranteed to
// be; fall back to a manual v4 UUID so account creation never fails.
function uuid() {
  if (window.crypto && crypto.randomUUID) {
    try {
      return crypto.randomUUID();
    } catch {}
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}

function providerLabel(id) {
  return providers.find((p) => p.id === id)?.label || id;
}
function appMeta(id) {
  return APP_META[id] || { short: providerLabel(id), icon: "🌐" };
}
function isProvider(id) {
  return providers.some((p) => p.id === id);
}
function findAccount(id) {
  return accounts.find((a) => a.id === id);
}
function viewKey(accountId, provider) {
  return `${accountId}::${provider}`;
}
function appsText(acc) {
  return acc.apps.map((id) => appMeta(id).short).join(", ");
}

// Stable colour per account, so the same login is recognisable in every group.
function accountAvatar(acc, cls) {
  let h = 0;
  for (const ch of acc.id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const a = el("div", "avatar " + (cls || ""));
  a.style.background = `linear-gradient(135deg, hsl(${h} 80% 62%), hsl(${(h + 40) % 360} 85% 58%))`;
  a.textContent = (acc.name.trim()[0] || "?").toUpperCase();
  return a;
}
function appBadge(id, cls) {
  const b = el("span", `app-badge prov-${id} ${cls || ""}`);
  b.textContent = appMeta(id).icon;
  return b;
}

// Older versions stored one app per account ({ id, name, provider }).
function normalizeAccounts(list) {
  let changed = false;
  const out = (Array.isArray(list) ? list : [])
    .filter((a) => a && a.id)
    .map((a) => {
      let apps = Array.isArray(a.apps) ? a.apps.filter(isProvider) : null;
      if (!apps) {
        changed = true;
        apps = [isProvider(a.provider) ? a.provider : providers[0].id];
      }
      return { id: String(a.id), name: String(a.name || "Akun"), email: String(a.email || ""), apps };
    });
  return { out, changed };
}

// ---- Native view bounds sync ----------------------------------------------
// Report the pixel region of #viewport so the main process can size the
// native web view to sit exactly over it.
function syncViewBounds() {
  const rect = $("#viewport").getBoundingClientRect();
  // WebContentsView.setBounds expects device-independent pixels — the same
  // coordinate space as getBoundingClientRect — so do NOT multiply by the
  // device pixel ratio (that misplaced the view / broke clicks on HiDPI).
  return api.view.setBounds({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  });
}
new ResizeObserver(() => syncViewBounds()).observe($("#viewport"));
window.addEventListener("resize", () => syncViewBounds());

// ---- Modals ----------------------------------------------------------------
// The native web view is painted above this page, so it would hide any modal.
// While at least one modal is open the view is taken off screen.
const openModals = new Set();
function showModal(sel) {
  $(sel).classList.remove("hidden");
  openModals.add(sel);
  if (openModals.size === 1) api.view.setCovered(true);
}
function hideModal(sel) {
  if (!openModals.has(sel)) return;
  $(sel).classList.add("hidden");
  openModals.delete(sel);
  if (openModals.size === 0) api.view.setCovered(false);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openModals.size) hideModal([...openModals].pop());
});
document.querySelectorAll(".modal").forEach((m) =>
  m.addEventListener("mousedown", (e) => {
    if (e.target === m) hideModal("#" + m.id);
  })
);

// ---- Sidebar + tabs --------------------------------------------------------
function applySidebar() {
  document.body.classList.toggle("sidebar-hidden", !!prefs.sidebarHidden);
  $("#sidebarBtn").title = prefs.sidebarHidden
    ? "Tampilkan panel akun"
    : "Sembunyikan panel (situs jadi lebih lebar)";
}
$("#sidebarBtn").addEventListener("click", () => {
  prefs.sidebarHidden = !prefs.sidebarHidden;
  savePrefs();
  applySidebar();
  syncViewBounds();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab;
    document.querySelectorAll(".panel").forEach((p) => {
      p.classList.toggle("hidden", p.dataset.panel !== target);
    });
  });
});

// ---- Accounts, grouped per app --------------------------------------------
function renderAccounts() {
  const list = $("#accountList");
  const q = $("#accountSearch").value.trim().toLowerCase();
  list.innerHTML = "";
  if (accounts.length === 0) {
    const empty = el("div", "muted empty-note");
    empty.textContent = "Belum ada akun. Klik “+ Akun” untuk mulai.";
    list.appendChild(empty);
    return;
  }
  const matches = (acc) =>
    !q || acc.name.toLowerCase().includes(q) || acc.email.toLowerCase().includes(q);

  let shownAny = false;
  providers.forEach((p) => {
    const members = accounts.filter((a) => a.apps.includes(p.id));
    const shown = members.filter(matches);
    if (q && shown.length === 0) return;
    shownAny = true;

    const collapsed = !q && !!prefs.collapsedGroups[p.id];
    const group = el("section", "group" + (collapsed ? " collapsed" : ""));

    const head = el("div", "group-head");
    const chev = el("span", "chev");
    chev.textContent = "▾";
    const title = el("span", "group-title");
    title.textContent = p.label;
    const count = el("span", "count");
    count.textContent = members.length;
    const add = el("button", "group-add");
    add.textContent = "+";
    add.title = `Tambah akun ke ${p.label}`;
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      openPickModal(p.id);
    });
    head.append(chev, appBadge(p.id), title, count, add);
    head.addEventListener("click", () => {
      prefs.collapsedGroups[p.id] = !prefs.collapsedGroups[p.id];
      savePrefs();
      renderAccounts();
    });

    const body = el("div", "group-body");
    if (shown.length === 0) {
      const none = el("button", "group-empty");
      none.textContent = `+ Tambah akun ke ${p.label}`;
      none.addEventListener("click", () => openPickModal(p.id));
      body.append(none);
    }
    shown.forEach((acc) => body.append(accountRow(acc, p.id)));

    group.append(head, body);
    list.appendChild(group);
  });

  if (!shownAny) {
    const empty = el("div", "muted empty-note");
    empty.textContent = "Tidak ada akun yang cocok.";
    list.appendChild(empty);
  }
}

function accountRow(acc, provider) {
  const isActive = active?.accountId === acc.id && active?.provider === provider;
  const row = el("div", "acc-row" + (isActive ? " active" : ""));
  row.title = `Buka ${providerLabel(provider)} dengan akun ${acc.name}`;

  const meta = el("div", "acc-meta");
  const name = el("div", "acc-name");
  name.textContent = acc.name;
  const sub = el("div", "acc-sub");
  sub.textContent =
    acc.email || (acc.apps.length > 1 ? `1 login untuk ${appsText(acc)}` : "Sesi login sendiri");
  meta.append(name, sub);
  row.append(accountAvatar(acc, "sm"), meta);

  if (loaded.has(viewKey(acc.id, provider))) {
    const dot = el("span", "live-dot");
    dot.title = "Sudah terbuka (berjalan di latar)";
    row.append(dot);
  }

  const edit = el("button", "mini");
  edit.textContent = "✎";
  edit.title = "Ubah akun / aplikasi";
  edit.addEventListener("click", (e) => {
    e.stopPropagation();
    openAccountModal(acc);
  });
  row.append(edit);

  row.addEventListener("click", () => openView(acc, provider));
  return row;
}
$("#accountSearch").addEventListener("input", renderAccounts);

// Show `provider` for `acc` in the viewport. Views of one account share one
// session, so switching apps never asks for a new login.
async function openView(acc, provider) {
  if (!acc.apps.includes(provider)) {
    acc.apps.push(provider);
    await api.accounts.save(accounts);
  }
  await syncViewBounds();
  await api.view.open(acc.id, provider);
  active = { accountId: acc.id, provider };
  loaded.add(viewKey(acc.id, provider));
  await api.view.setZoom(currentZoom());
  prefs.last = { ...active };
  prefs.collapsedGroups[provider] = false;
  savePrefs();
  $("#emptyState").classList.add("hidden");
  renderToolbar();
  renderAccounts();
}

function clearActive() {
  active = null;
  prefs.last = null;
  savePrefs();
  $("#emptyState").classList.remove("hidden");
}

async function closeActiveView() {
  await api.view.hide();
  clearActive();
  renderToolbar();
  renderAccounts();
}

// ---- Toolbar ---------------------------------------------------------------
function renderToolbar() {
  const acc = active && findAccount(active.accountId);

  const chip = $("#activeChip");
  chip.innerHTML = "";
  const text = el("div", "chip-text");
  const strong = el("strong");
  const span = el("span");
  if (acc) {
    strong.textContent = acc.name;
    span.textContent = acc.email || `Login bersama: ${appsText(acc)}`;
    chip.append(accountAvatar(acc, "sm"));
  } else {
    strong.textContent = "Belum ada akun terbuka";
    span.textContent = "Pilih akun di panel kiri";
  }
  text.append(strong, span);
  chip.append(text);

  const seg = $("#appSwitch");
  seg.innerHTML = "";
  providers.forEach((p) => {
    const isCurrent = !!acc && active.provider === p.id;
    const b = el("button", `seg-btn prov-${p.id}` + (isCurrent ? " active" : ""));
    b.disabled = !acc;
    b.title = acc
      ? `Buka ${p.label} dengan akun ${acc.name} (login yang sama)`
      : "Buka salah satu akun dulu";
    const icon = el("span", "seg-icon");
    icon.textContent = appMeta(p.id).icon;
    const label = el("span", "seg-label");
    label.textContent = appMeta(p.id).short;
    b.append(icon, label);
    if (acc && !isCurrent && loaded.has(viewKey(acc.id, p.id))) b.append(el("span", "live-dot"));
    b.addEventListener("click", () => {
      if (acc && !isCurrent) openView(acc, p.id);
    });
    seg.append(b);
  });

  for (const sel of [
    "#backBtn",
    "#forwardBtn",
    "#reloadBtn",
    "#zoomOutBtn",
    "#zoomResetBtn",
    "#zoomInBtn",
    "#closeViewBtn",
  ]) {
    $(sel).disabled = !acc;
  }
  $("#zoomResetBtn").textContent = Math.round(currentZoom() * 100) + "%";
}

function currentZoom() {
  return (active && prefs.zoom[viewKey(active.accountId, active.provider)]) || 1;
}
async function setZoom(factor) {
  if (!active) return;
  const key = viewKey(active.accountId, active.provider);
  if (factor === 1) delete prefs.zoom[key];
  else prefs.zoom[key] = factor;
  savePrefs();
  await api.view.setZoom(factor);
  renderToolbar();
}
function stepZoom(dir) {
  const z = currentZoom();
  const next =
    dir > 0
      ? ZOOM_STEPS.find((s) => s > z + 0.001)
      : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
  if (next) setZoom(next);
}

$("#backBtn").addEventListener("click", () => api.view.back());
$("#forwardBtn").addEventListener("click", () => api.view.forward());
$("#reloadBtn").addEventListener("click", () => api.view.reload());
$("#zoomOutBtn").addEventListener("click", () => stepZoom(-1));
$("#zoomInBtn").addEventListener("click", () => stepZoom(1));
$("#zoomResetBtn").addEventListener("click", () => setZoom(1));
$("#closeViewBtn").addEventListener("click", closeActiveView);

// ---- Account modal (new / edit) -------------------------------------------
function openAccountModal(acc, presetProvider) {
  editingAccountId = acc ? acc.id : null;
  pickProvider = acc ? null : presetProvider || null;
  $("#accModalTitle").textContent = acc ? "Ubah Akun" : "Tambah Akun";
  $("#accName").value = acc ? acc.name : "";
  $("#accEmail").value = acc ? acc.email : "";
  draftApps = new Set(
    acc ? acc.apps : presetProvider ? [presetProvider] : providers.map((p) => p.id)
  );
  renderAppChecks();
  $("#accDelete").hidden = !acc;
  showModal("#accountModal");
  $("#accName").focus();
}

function renderAppChecks() {
  const box = $("#accApps");
  box.innerHTML = "";
  providers.forEach((p) => {
    const on = draftApps.has(p.id);
    const b = el("button", "app-check" + (on ? " on" : ""));
    b.type = "button";
    b.setAttribute("aria-pressed", String(on));
    const tick = el("span", "tick");
    tick.textContent = on ? "✓" : "";
    b.append(tick, appBadge(p.id, "xs"), document.createTextNode(p.label));
    b.addEventListener("click", () => {
      if (on) draftApps.delete(p.id);
      else draftApps.add(p.id);
      renderAppChecks();
    });
    box.append(b);
  });
}

async function saveAccountModal() {
  const name = $("#accName").value.trim().slice(0, 100);
  const email = $("#accEmail").value.trim().slice(0, 200);
  const apps = providers.map((p) => p.id).filter((id) => draftApps.has(id));
  if (!name) return toast("Nama akun wajib diisi");
  if (apps.length === 0) return toast("Pilih minimal satu aplikasi");

  if (editingAccountId) {
    const acc = findAccount(editingAccountId);
    if (!acc) return hideModal("#accountModal");
    const dropped = acc.apps.filter((id) => !apps.includes(id));
    Object.assign(acc, { name, email, apps });
    await api.accounts.save(accounts);
    // An app taken off the account closes its view; the login is kept.
    for (const id of dropped) {
      if (active?.accountId === acc.id && active.provider === id) clearActive();
      if (loaded.delete(viewKey(acc.id, id))) await api.view.unload(acc.id, id);
    }
    hideModal("#accountModal");
    renderAccounts();
    renderToolbar();
    toast("Akun disimpan");
    return;
  }

  const acc = { id: uuid(), name, email, apps };
  accounts.push(acc);
  await api.accounts.save(accounts);
  const first = pickProvider && apps.includes(pickProvider) ? pickProvider : apps[0];
  // Opened while the modal still covers the view; closing it reveals the page.
  await openView(acc, first);
  hideModal("#accountModal");
}

$("#addAccountBtn").addEventListener("click", () => openAccountModal(null));
$("#emptyAddBtn").addEventListener("click", () => openAccountModal(null));
$("#accCancel").addEventListener("click", () => hideModal("#accountModal"));
$("#accSave").addEventListener("click", saveAccountModal);
for (const sel of ["#accName", "#accEmail"]) {
  $(sel).addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveAccountModal();
  });
}

$("#accDelete").addEventListener("click", async () => {
  const acc = findAccount(editingAccountId);
  if (!acc) return;
  if (!confirm(`Hapus akun "${acc.name}" beserta sesi login-nya di semua aplikasi?`)) return;
  await api.view.remove(acc.id);
  const prefix = acc.id + "::";
  for (const key of [...loaded]) if (key.startsWith(prefix)) loaded.delete(key);
  for (const key of Object.keys(prefs.zoom)) if (key.startsWith(prefix)) delete prefs.zoom[key];
  accounts = accounts.filter((a) => a.id !== acc.id);
  await api.accounts.save(accounts);
  if (active?.accountId === acc.id) clearActive();
  savePrefs();
  hideModal("#accountModal");
  renderAccounts();
  renderToolbar();
  toast("Akun dihapus");
});

// ---- Add an existing account to an app ------------------------------------
function openPickModal(providerId) {
  const candidates = accounts.filter((a) => !a.apps.includes(providerId));
  if (candidates.length === 0) return openAccountModal(null, providerId);

  pickProvider = providerId;
  const label = providerLabel(providerId);
  $("#pickTitle").textContent = `Tambah akun ke ${label}`;
  const list = $("#pickList");
  list.innerHTML = "";
  candidates.forEach((acc) => {
    const item = el("button", "pick-item");
    const meta = el("div", "acc-meta");
    const name = el("div", "acc-name");
    name.textContent = acc.name;
    const sub = el("div", "acc-sub");
    sub.textContent = `${acc.email ? acc.email + " · " : ""}login dari ${appsText(acc)}`;
    meta.append(name, sub);
    const go = el("span", "pick-go");
    go.textContent = "Pakai →";
    item.append(accountAvatar(acc, "sm"), meta, go);
    item.addEventListener("click", async () => {
      await openView(acc, providerId);
      hideModal("#pickModal");
      toast(`${acc.name} ditambahkan ke ${label}`);
    });
    list.append(item);
  });
  showModal("#pickModal");
}
$("#pickNew").addEventListener("click", () => {
  // Open the next modal before closing this one so the view stays covered.
  openAccountModal(null, pickProvider);
  hideModal("#pickModal");
});
$("#pickCancel").addEventListener("click", () => hideModal("#pickModal"));

// ---- Prompts ---------------------------------------------------------------
function renderPrompts() {
  const list = $("#promptList");
  const q = $("#promptSearch").value.trim().toLowerCase();
  list.innerHTML = "";
  const filtered = prompts
    .filter(
      (p) =>
        !q ||
        p.title.toLowerCase().includes(q) ||
        p.prompt.toLowerCase().includes(q) ||
        (p.category || "").toLowerCase().includes(q)
    )
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  if (filtered.length === 0) {
    const empty = el("div", "muted empty-note");
    empty.textContent = q ? "Tidak ada hasil." : "Belum ada prompt.";
    list.appendChild(empty);
    return;
  }

  filtered.forEach((p) => {
    const card = el("div", "card");
    const row = el("div", "row");
    const title = el("div", "name");
    title.textContent = (p.pinned ? "📌 " : "") + p.title;
    const actions = el("div", "mini-actions");

    const copy = el("button", "mini");
    copy.textContent = "⧉";
    copy.title = "Salin";
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(p.prompt);
      toast("Prompt disalin");
    });
    const pin = el("button", "mini");
    pin.textContent = p.pinned ? "📌" : "📍";
    pin.title = p.pinned ? "Lepas sematan" : "Sematkan";
    pin.addEventListener("click", async (e) => {
      e.stopPropagation();
      prompts = await api.prompts.togglePin(p.id);
      renderPrompts();
    });
    const edit = el("button", "mini");
    edit.textContent = "✎";
    edit.title = "Ubah";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      openPromptModal(p);
    });
    const del = el("button", "mini danger");
    del.textContent = "🗑";
    del.title = "Hapus";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Hapus prompt "${p.title}"?`)) return;
      await api.prompts.remove(p.id);
      prompts = prompts.filter((x) => x.id !== p.id);
      renderPrompts();
    });
    actions.append(copy, pin, edit, del);
    row.append(title, actions);

    const preview = el("div", "prompt-preview");
    preview.textContent = p.prompt;

    card.append(row, preview);
    if (p.category) {
      const cat = el("div", "sub");
      cat.textContent = "#" + p.category;
      card.append(cat);
    }
    card.addEventListener("click", () => {
      navigator.clipboard.writeText(p.prompt);
      toast("Prompt disalin");
    });
    list.appendChild(card);
  });
}
$("#promptSearch").addEventListener("input", renderPrompts);

function openPromptModal(p) {
  editingPromptId = p ? p.id : null;
  $("#promptModalTitle").textContent = p ? "Ubah Prompt" : "Prompt Baru";
  $("#promptId").value = p ? p.id : "";
  $("#promptTitle").value = p ? p.title : "";
  $("#promptCategory").value = p ? p.category || "" : "";
  $("#promptBody").value = p ? p.prompt : "";
  showModal("#promptModal");
  $("#promptTitle").focus();
}
$("#addPromptBtn").addEventListener("click", () => openPromptModal(null));
$("#promptCancel").addEventListener("click", () => hideModal("#promptModal"));
$("#promptSave").addEventListener("click", async () => {
  const data = {
    title: $("#promptTitle").value,
    category: $("#promptCategory").value,
    prompt: $("#promptBody").value,
  };
  if (!data.title.trim() || !data.prompt.trim()) {
    toast("Judul dan isi wajib diisi");
    return;
  }
  try {
    if (editingPromptId) {
      const updated = await api.prompts.update({ id: editingPromptId, ...data });
      prompts = prompts.map((p) => (p.id === updated.id ? updated : p));
    } else {
      const created = await api.prompts.create(data);
      prompts.push(created);
    }
    hideModal("#promptModal");
    renderPrompts();
    toast("Tersimpan");
  } catch (err) {
    toast(String(err.message || err));
  }
});

// Surface any unexpected invoke/runtime failure instead of failing silently.
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  toast(typeof reason === "string" ? reason : reason?.message || "Terjadi kesalahan");
});

// ---- Init ------------------------------------------------------------------
async function init() {
  providers = await api.providers.list();
  const { out, changed } = normalizeAccounts(await api.accounts.load());
  accounts = out;
  if (changed) await api.accounts.save(accounts);
  prompts = await api.prompts.list();
  applySidebar();
  renderAccounts();
  renderPrompts();
  renderToolbar();
  await syncViewBounds();
  api.onDownloadDone(({ path }) => toast("Tersimpan: " + path));

  // Reopen whatever was on screen when the app was last closed.
  const last = prefs.last;
  const acc = last && findAccount(last.accountId);
  if (acc && acc.apps.includes(last.provider)) await openView(acc, last.provider);
}
init();
