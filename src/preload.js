"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flowdeck", {
  providers: {
    list: () => ipcRenderer.invoke("providers:list"),
  },
  accounts: {
    load: () => ipcRenderer.invoke("accounts:load"),
    save: (accounts) => ipcRenderer.invoke("accounts:save", accounts),
  },
  view: {
    setBounds: (bounds) => ipcRenderer.invoke("view:setBounds", bounds),
    open: (accountId, provider) =>
      ipcRenderer.invoke("view:open", { accountId, provider }),
    hide: () => ipcRenderer.invoke("view:hide"),
    remove: (accountId) => ipcRenderer.invoke("view:remove", accountId),
    reload: () => ipcRenderer.invoke("view:reload"),
  },
  prompts: {
    list: () => ipcRenderer.invoke("prompts:list"),
    create: (data) => ipcRenderer.invoke("prompts:create", data),
    update: (data) => ipcRenderer.invoke("prompts:update", data),
    remove: (id) => ipcRenderer.invoke("prompts:delete", id),
    togglePin: (id) => ipcRenderer.invoke("prompts:togglePin", id),
  },
  onDownloadDone: (cb) =>
    ipcRenderer.on("download:done", (_e, payload) => cb(payload)),
});
