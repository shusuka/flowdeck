// Tauri bridge: exposes the same `window.flowdeck` API that the renderer uses,
// backed by Tauri commands. Under Electron this is a no-op (the preload script
// already defines window.flowdeck); under Tauri, window.__TAURI__ is present.
(function () {
  const T = window.__TAURI__;
  if (!T) return;
  const invoke = T.core.invoke;

  const PROVIDERS = [
    { id: "google-flow", label: "Google Flow" },
    { id: "dola", label: "Dola" },
    { id: "migoo", label: "Migoo" },
  ];

  window.flowdeck = {
    providers: {
      list: async () => PROVIDERS,
    },
    accounts: {
      load: () => invoke("load_accounts"),
      save: (accounts) => invoke("save_accounts", { accounts }),
    },
    view: {
      setBounds: (b) =>
        invoke("set_view_bounds", {
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
        }),
      open: (accountId, provider) =>
        invoke("open_view", { account_id: accountId, provider }),
      hide: () => invoke("hide_view"),
      remove: (accountId) => invoke("remove_view", { account_id: accountId }),
      reload: () => invoke("reload_view"),
    },
    prompts: {
      list: () => invoke("list_prompts"),
      create: (data) => invoke("create_prompt", data),
      update: (data) => invoke("update_prompt", data),
      remove: (id) => invoke("delete_prompt", { id }),
      togglePin: (id) => invoke("toggle_prompt_pinned", { id }),
    },
    // Downloads use WebView2's built-in handling for now.
    onDownloadDone: () => {},
  };
})();
