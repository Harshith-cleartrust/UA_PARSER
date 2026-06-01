const COPY_ICON = `<svg class="api-copy-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8.5A2.5 2.5 0 0 1 10.5 6h7A2.5 2.5 0 0 1 20 8.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 8 15.5v-7Z"/><path d="M4 12.5A2.5 2.5 0 0 0 6.5 15H7v-2h-.5a.5.5 0 0 1-.5-.5v-7a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5V6h2v-.5A2.5 2.5 0 0 0 13.5 3h-7A2.5 2.5 0 0 0 4 5.5v7Z"/></svg>`;

function copyText(text, btn) {
  const value = String(text ?? "").trim();
  if (!value) return;
  navigator.clipboard.writeText(value).then(
    () => showCopied(btn),
    () => {
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      showCopied(btn);
    },
  );
}

function showCopied(btn) {
  if (!btn) return;
  const label = btn.querySelector(".api-copy-label");
  const prev = label?.textContent || "Copy";
  btn.classList.add("copied");
  if (label) label.textContent = "Copied";
  window.setTimeout(() => {
    btn.classList.remove("copied");
    if (label) label.textContent = prev;
  }, 1400);
}

function initApiDocsCopy() {
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    if (!btn.querySelector(".api-copy-icon")) {
      btn.insertAdjacentHTML("afterbegin", COPY_ICON);
      if (!btn.querySelector(".api-copy-label")) {
        const span = document.createElement("span");
        span.className = "api-copy-label";
        span.textContent = "Copy";
        btn.appendChild(span);
      }
    }
    btn.addEventListener("click", () => copyText(btn.dataset.copy, btn));
  });

  document.querySelectorAll("[data-copy-target]").forEach((btn) => {
    if (!btn.querySelector(".api-copy-icon")) {
      btn.insertAdjacentHTML("afterbegin", COPY_ICON);
      const span = document.createElement("span");
      span.className = "api-copy-label";
      span.textContent = "Copy";
      btn.appendChild(span);
    }
    btn.addEventListener("click", () => {
      const el = document.getElementById(btn.dataset.copyTarget);
      copyText(el?.textContent, btn);
    });
  });
}

initApiDocsCopy();
