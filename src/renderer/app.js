"use strict";

const api = window.flowdeck;

// ---- State -----------------------------------------------------------------
let accounts = [];
let prompts = [];
let providers = [];
let activeAccountId = null;
let editingPromptId = null;

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
  toastTimer = setTimeout(() => t.classList.add("hidden"), 1800);
}

function providerLabel(id) {
  return providers.find((p) => p.id === id)?.label || id;
}

// ---- Native view bounds sync ----------------------------------------------
// Report the pixel region of #viewport so the main process can size the
// native web view to sit exactly over it.
function syncViewBounds() {
  const rect = $("#viewport").getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  api.view.setBounds({
    x: rect.left * dpr,
    y: rect.top * dpr,
    width: rect.width * dpr,
    height: rect.height * dpr,
  });
}
new ResizeObserver(syncViewBounds).observe(document.body);
window.addEventListener("resize", syncViewBounds);

// ---- Tabs ------------------------------------------------------------------
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

// ---- Accounts --------------------------------------------------------------
function renderAccounts() {
  const list = $("#accountList");
  list.innerHTML = "";
  if (accounts.length === 0) {
    const empty = el("div", "muted");
    empty.style.padding = "8px 2px";
    empty.textContent = "Belum ada akun.";
    list.appendChild(empty);
    return;
  }
  accounts.forEach((acc) => {
    const card = el("div", "card" + (acc.id === activeAccountId ? " active" : ""));
    const row = el("div", "row");
    const left = el("div");
    const name = el("div", "name");
    name.textContent = acc.name;
    const sub = el("div", "sub");
    sub.textContent = providerLabel(acc.provider);
    left.append(name, sub);

    const actions = el("div", "mini-actions");
    const del = el("button", "mini danger");
    del.textContent = "🗑";
    del.title = "Hapus akun & sesi login";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAccount(acc.id);
    });
    actions.append(del);

    row.append(left, actions);
    card.append(row);
    card.addEventListener("click", () => openAccount(acc));
    list.appendChild(card);
  });
}

async function openAccount(acc) {
  activeAccountId = acc.id;
  await api.view.open(acc.id, acc.provider);
  syncViewBounds();
  $("#emptyState").classList.add("hidden");
  $("#activeTitle").textContent = `${acc.name} — ${providerLabel(acc.provider)}`;
  $("#reloadBtn").disabled = false;
  $("#closeViewBtn").disabled = false;
  renderAccounts();
}

async function closeActiveView() {
  await api.view.hide();
  activeAccountId = null;
  $("#emptyState").classList.remove("hidden");
  $("#activeTitle").textContent = "Belum ada akun terbuka";
  $("#reloadBtn").disabled = true;
  $("#closeViewBtn").disabled = true;
  renderAccounts();
}

async function removeAccount(id) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  if (!confirm(`Hapus akun "${acc.name}" beserta sesi login-nya?`)) return;
  await api.view.remove(id);
  accounts = accounts.filter((a) => a.id !== id);
  await api.accounts.save(accounts);
  if (activeAccountId === id) await closeActiveView();
  renderAccounts();
  toast("Akun dihapus");
}

// Account modal
function openAccountModal() {
  $("#accName").value = "";
  const sel = $("#accProvider");
  sel.innerHTML = "";
  providers.forEach((p) => {
    const opt = el("option");
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  });
  $("#accountModal").classList.remove("hidden");
  $("#accName").focus();
}
$("#addAccountBtn").addEventListener("click", openAccountModal);
$("#accCancel").addEventListener("click", () =>
  $("#accountModal").classList.add("hidden")
);
$("#accSave").addEventListener("click", async () => {
  const name = $("#accName").value.trim();
  const provider = $("#accProvider").value;
  if (!name) {
    toast("Nama akun wajib diisi");
    return;
  }
  const acc = { id: uuid(), name, provider };
  accounts.push(acc);
  await api.accounts.save(accounts);
  $("#accountModal").classList.add("hidden");
  renderAccounts();
  openAccount(acc);
});

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
    const empty = el("div", "muted");
    empty.style.padding = "8px 2px";
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
  $("#promptModal").classList.remove("hidden");
  $("#promptTitle").focus();
}
$("#addPromptBtn").addEventListener("click", () => openPromptModal(null));
$("#promptCancel").addEventListener("click", () =>
  $("#promptModal").classList.add("hidden")
);
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
    $("#promptModal").classList.add("hidden");
    renderPrompts();
    toast("Tersimpan");
  } catch (err) {
    toast(String(err.message || err));
  }
});

// ---- Toolbar ---------------------------------------------------------------
$("#reloadBtn").addEventListener("click", () => api.view.reload());
$("#closeViewBtn").addEventListener("click", closeActiveView);

// ---- Init ------------------------------------------------------------------
async function init() {
  providers = await api.providers.list();
  accounts = await api.accounts.load();
  prompts = await api.prompts.list();
  renderAccounts();
  renderPrompts();
  syncViewBounds();
  api.onDownloadDone(({ path }) => toast("Tersimpan: " + path));
}
init();
