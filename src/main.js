"use strict";

const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  dialog,
  session,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// A real desktop-Chrome user agent. Google refuses sign-in from user agents
// that contain "Electron"/"flowdeck", so we present a plain Chrome string that
// matches the Chromium build shipped with Electron 32.
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// ---- Providers -------------------------------------------------------------
// The sites each account tab can host. Add or edit freely.
const PROVIDERS = {
  "google-flow": { label: "Google Flow", url: "https://flow.google" },
  dola: { label: "Dola", url: "https://www.dola.com/chat/" },
  migoo: { label: "Migoo", url: "https://migoo.ai/" },
};

// ---- Local JSON storage ----------------------------------------------------
const DATA_DIR = app.getPath("userData");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const PROMPTS_FILE = path.join(DATA_DIR, "prompts.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---- Window + per-account views --------------------------------------------
let mainWindow = null;
/** @type {Map<string, WebContentsView>} accountId -> view */
const views = new Map();
let activeAccountId = null;
// Bounds of the content region the renderer reserves for the web view.
let contentBounds = { x: 0, y: 0, width: 0, height: 0 };

function partitionFor(accountId) {
  return `persist:flowdeck-${accountId}`;
}

// Sites like Dola use the camera (QR / document scan), clipboard and
// notifications. Electron denies these by default, which surfaces as an error
// in the page. Grant the safe set to each account session.
function attachPermissionHandler(ses) {
  if (ses.__flowdeckPerms) return;
  ses.__flowdeckPerms = true;
  const ALLOWED = new Set([
    "media", // camera + microphone (scan)
    "clipboard-read",
    "clipboard-sanitized-write",
    "notifications",
    "fullscreen",
    "pointerLock",
  ]);
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));
}

function attachDownloadHandler(ses) {
  if (ses.__flowdeckDownloads) return;
  ses.__flowdeckDownloads = true;
  ses.on("will-download", (event, item) => {
    const suggested = item.getFilename() || "FlowDeck_download";
    const target = dialog.showSaveDialogSync(mainWindow, {
      title: "Save file",
      defaultPath: suggested,
    });
    if (!target) {
      item.cancel();
      return;
    }
    item.setSavePath(target);
    item.once("done", (_e, state) => {
      if (state === "completed" && mainWindow) {
        mainWindow.webContents.send("download:done", { path: target });
      }
    });
  });
}

function ensureView(accountId, provider) {
  if (views.has(accountId)) return views.get(accountId);

  const providerKey = PROVIDERS[provider] ? provider : "google-flow";
  const partition = partitionFor(accountId);
  const ses = session.fromPartition(partition);
  ses.setUserAgent(CHROME_UA);
  attachPermissionHandler(ses);
  attachDownloadHandler(ses);

  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  view.setBackgroundColor("#0b0f17");
  view.webContents.setUserAgent(CHROME_UA);
  // Strip the client hint that reveals we are not really Chrome.
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    delete details.requestHeaders["sec-ch-ua"];
    cb({ requestHeaders: details.requestHeaders });
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    // Google/OAuth sign-in often uses a real popup window that must keep its
    // opener and its own window (postMessage handshake). Let auth popups open
    // as genuine child windows sharing this account's session; everything else
    // stays inside the tab.
    if (/^https?:\/\/(accounts\.google\.|[^/]*\.?google\.com|[^/]*\.?googleusercontent\.com|appleid\.apple\.com|login\.microsoftonline\.com|github\.com|www\.facebook\.com)/.test(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true,
          webPreferences: { partition, contextIsolation: true },
        },
      };
    }
    if (url.startsWith("http")) view.webContents.loadURL(url);
    return { action: "deny" };
  });
  view.webContents.loadURL(PROVIDERS[providerKey].url);

  views.set(accountId, view);
  return view;
}

function layoutActiveView() {
  if (!activeAccountId) return;
  const view = views.get(activeAccountId);
  if (!view) return;
  const b = contentBounds;
  view.setBounds({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height)),
  });
}

function showAccount(accountId, provider) {
  const view = ensureView(accountId, provider);

  // Detach any other visible view.
  for (const [id, v] of views) {
    if (id !== accountId) mainWindow.contentView.removeChildView(v);
  }
  mainWindow.contentView.addChildView(view);
  activeAccountId = accountId;
  layoutActiveView();
}

function hideActiveView() {
  if (!activeAccountId) return;
  const view = views.get(activeAccountId);
  if (view) mainWindow.contentView.removeChildView(view);
  activeAccountId = null;
}

function destroyAccount(accountId) {
  const view = views.get(accountId);
  if (view) {
    if (activeAccountId === accountId) hideActiveView();
    mainWindow.contentView.removeChildView(view);
    view.webContents.close();
    views.delete(accountId);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: "#0b0f17",
    title: "FlowDeck",
    icon: path.join(__dirname, "renderer", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---- IPC: providers --------------------------------------------------------
ipcMain.handle("providers:list", () =>
  Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label }))
);

// ---- IPC: accounts ---------------------------------------------------------
ipcMain.handle("accounts:load", () => readJson(ACCOUNTS_FILE, []));
ipcMain.handle("accounts:save", (_e, accounts) => {
  if (!Array.isArray(accounts)) throw new Error("invalid accounts");
  writeJson(ACCOUNTS_FILE, accounts);
  return true;
});

// ---- IPC: account view control --------------------------------------------
ipcMain.handle("view:setBounds", (_e, bounds) => {
  contentBounds = bounds || contentBounds;
  layoutActiveView();
});
ipcMain.handle("view:open", (_e, { accountId, provider }) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) throw new Error("bad id");
  showAccount(accountId, provider);
});
ipcMain.handle("view:hide", () => hideActiveView());
ipcMain.handle("view:remove", (_e, accountId) => {
  destroyAccount(accountId);
  // Clear the isolated login session for this account.
  const ses = session.fromPartition(partitionFor(accountId));
  return ses.clearStorageData();
});
ipcMain.handle("view:reload", () => {
  if (activeAccountId) views.get(activeAccountId)?.webContents.reload();
});

// ---- IPC: prompt library ---------------------------------------------------
function loadPrompts() {
  const items = readJson(PROMPTS_FILE, []);
  return Array.isArray(items) ? items : [];
}

ipcMain.handle("prompts:list", () => loadPrompts());
ipcMain.handle("prompts:create", (_e, { title, prompt, category }) => {
  title = String(title || "").trim();
  prompt = String(prompt || "").trim();
  category = String(category || "").trim();
  if (!title || !prompt) throw new Error("title and prompt are required");
  const items = loadPrompts();
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(),
    title: title.slice(0, 200),
    prompt: prompt.slice(0, 100000),
    category: category.slice(0, 100),
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  items.push(item);
  writeJson(PROMPTS_FILE, items);
  return item;
});
ipcMain.handle("prompts:update", (_e, { id, title, prompt, category }) => {
  const items = loadPrompts();
  const item = items.find((p) => p.id === id);
  if (!item) throw new Error("prompt not found");
  item.title = String(title || "").trim().slice(0, 200) || item.title;
  item.prompt = String(prompt || "").trim().slice(0, 100000) || item.prompt;
  item.category = String(category || "").trim().slice(0, 100);
  item.updatedAt = new Date().toISOString();
  writeJson(PROMPTS_FILE, items);
  return item;
});
ipcMain.handle("prompts:delete", (_e, id) => {
  const items = loadPrompts().filter((p) => p.id !== id);
  writeJson(PROMPTS_FILE, items);
  return true;
});
ipcMain.handle("prompts:togglePin", (_e, id) => {
  const items = loadPrompts();
  const item = items.find((p) => p.id === id);
  if (item) {
    item.pinned = !item.pinned;
    item.updatedAt = new Date().toISOString();
    writeJson(PROMPTS_FILE, items);
  }
  return items;
});

// ---- App lifecycle ---------------------------------------------------------
app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
