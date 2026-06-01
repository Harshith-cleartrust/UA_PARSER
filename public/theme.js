(function () {
  const KEY = "ua-parser-theme";

  function applyTheme(theme) {
    const t = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* private mode */
    }
    for (const btn of document.querySelectorAll("[data-theme-btn]")) {
      const forLight = btn.dataset.themeBtn === "light";
      const active = (t === "light") === forLight;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  function readStoredTheme() {
    try {
      const t = localStorage.getItem(KEY);
      if (t === "light" || t === "dark") return t;
    } catch {
      /* ignore */
    }
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  if (!document.documentElement.dataset.theme) {
    applyTheme(readStoredTheme());
  } else {
    applyTheme(document.documentElement.dataset.theme);
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-btn]");
    if (!btn) return;
    applyTheme(btn.dataset.themeBtn);
  });
})();
