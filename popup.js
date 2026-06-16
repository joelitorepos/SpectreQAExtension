// popup.js
chrome.runtime.sendMessage({ type: "GET_CONNECTION_STATE" }, (res) => {
  const badge = document.getElementById("conn-badge");
  const dot = document.getElementById("conn-dot");
  const text = document.getElementById("conn-text");
  const hint = document.getElementById("hint");
  const auditInfo = document.getElementById("audit-info");

  if (res?.connected) {
    badge.className = "status-badge badge-connected";
    dot.className = "dot dot-on";
    text.textContent = `Puerto ${res.port}`;
    hint.style.display = "none";

    // Mostrar si esta pestaña está siendo auditada
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.url) return;
      chrome.storage.session.get("auditingUrls", ({ auditingUrls = [] }) => {
        const auditing = auditingUrls.some((url) => {
          try {
            const norm = url.startsWith("http") ? url : `http://${url}`;
            return new URL(norm).host === new URL(tab.url).host;
          } catch { return false; }
        });
        if (auditing) {
          auditInfo.style.display = "block";
          auditInfo.textContent = `Auditando: ${new URL(tab.url).host}`;
        }
      });
    });
  }
});
