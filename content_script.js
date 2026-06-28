// content_script.js
// Interfaz de usuario: vidrio bloqueante + menú flotante.
// Se comunica exclusivamente con el orquestador (no con el engine directamente).

let isAuditing = false;
let glassOverlay = null;
let floatingMenu = null;
let glassEnabled = true;

// ─────────────────────────────────────────────
// GLASS OVERLAY (bloquea interacción)
// ─────────────────────────────────────────────
function createGlassOverlay() {
  if (glassOverlay) return;
  injectStyles();

  glassOverlay = document.createElement("div");
  glassOverlay.id = "glasstest-glass";

  const BLOCK = [
    "click", "mousedown", "mouseup", "mousemove",
    "pointerdown", "pointerup", "pointermove",
    "touchstart", "touchend", "touchmove",
    "keydown", "keyup", "keypress",
    "contextmenu", "dblclick"
  ];

  BLOCK.forEach((evtName) => {
    glassOverlay.addEventListener(evtName, (e) => {
      e.stopPropagation();
      e.preventDefault();
    }, { capture: true });
  });

  // Scroll: solo bloqueamos si NO es scroll automático del agente
  glassOverlay.addEventListener("wheel", (e) => {
    if (window.__glasstest_engine__?.isAutoScrolling) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    chrome.runtime.sendMessage({
      type: "USER_INTERACTION",
      event: { kind: "SCROLL", deltaX: e.deltaX, deltaY: e.deltaY, url: location.href, timestamp: Date.now() }
    });
  }, { capture: true, passive: false });

  glassOverlay.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    chrome.runtime.sendMessage({
      type: "USER_INTERACTION",
      event: { kind: "CLICK", x: e.clientX, y: e.clientY, url: location.href, timestamp: Date.now() }
    });
  }, { capture: true });

  document.documentElement.appendChild(glassOverlay);
}

function removeGlassOverlay() {
  if (glassOverlay) {
    glassOverlay.remove();
    glassOverlay = null;
  }
}

function showGlass() {
  if (glassOverlay) glassOverlay.style.display = "block";
}
function hideGlass() {
  if (glassOverlay) glassOverlay.style.display = "none";
}

// ─────────────────────────────────────────────
// MENÚ FLOTANTE (arrastrable + controles del orquestador)
// ─────────────────────────────────────────────
function createFloatingMenu() {
  if (floatingMenu) return;

  floatingMenu = document.createElement("div");
  floatingMenu.id = "glasstest-menu";

  let menuOpen = false;

  floatingMenu.innerHTML = `
    <div id="glasstest-handle">
      <div id="glasstest-grip"><span></span><span></span><span></span></div>
      <div id="glasstest-label">
        <span id="glasstest-dot-pulse"></span>
        GlassTest
      </div>
      <button id="glasstest-toggle-btn" title="Abrir opciones">
        <svg id="glasstest-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 4L6 8L10 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
    <div id="glasstest-dropdown">
      <div class="glasstest-section-label">Estado del agente</div>
      <div style="display:flex; align-items:center; justify-content:space-between; padding:4px 12px;">
        <span style="font-size:12px;">Estado:</span>
        <strong id="glasstest-agent-status" style="color:#a6e3a1;">IDLE</strong>
      </div>
      <div class="glasstest-divider"></div>
      <div class="glasstest-section-label">Controles</div>
      <div style="display:flex; gap:6px; padding:6px 12px;">
        <button id="glasstest-btn-run" class="glasstest-agent-btn" style="background:#a6e3a1;">▶ Correr</button>
        <button id="glasstest-btn-pause" class="glasstest-agent-btn" style="background:#f9e2af;">⏸ Pausa</button>
        <button id="glasstest-btn-stop" class="glasstest-agent-btn" style="background:#f38ba8;">⏹ Detener</button>
      </div>
      <div class="glasstest-divider"></div>
      <div class="glasstest-section-label">Interfaz</div>
      <button class="glasstest-action" id="glasstest-glass-toggle">
        <span class="glasstest-action-icon">🪟</span>
        <span class="glasstest-action-text">Desactivar vidrio</span>
      </button>
    </div>
  `;

  document.documentElement.appendChild(floatingMenu);

  const toggleBtn = floatingMenu.querySelector("#glasstest-toggle-btn");
  const dropdown = floatingMenu.querySelector("#glasstest-dropdown");
  const chevron = floatingMenu.querySelector("#glasstest-chevron");

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuOpen = !menuOpen;
    dropdown.classList.toggle("glasstest-open", menuOpen);
    chevron.style.transform = menuOpen ? "rotate(180deg)" : "rotate(0deg)";
  });

  document.addEventListener("click", (e) => {
    if (!floatingMenu.contains(e.target)) {
      menuOpen = false;
      dropdown.classList.remove("glasstest-open");
      chevron.style.transform = "rotate(0deg)";
    }
  });

  // Botones -> orquestador
  const btnRun = floatingMenu.querySelector("#glasstest-btn-run");
  const btnPause = floatingMenu.querySelector("#glasstest-btn-pause");
  const btnStop = floatingMenu.querySelector("#glasstest-btn-stop");

  btnRun.addEventListener("click", () => {
    const orch = window.__glasstest_orchestrator__;
    if (orch) orch.run();
    updateAgentStatusDisplay();
  });

  btnPause.addEventListener("click", () => {
    const orch = window.__glasstest_orchestrator__;
    if (orch) {
      if (orch.getState().status === "RUNNING") orch.pause();
      else if (orch.getState().status === "PAUSED") orch.resume();
    }
    updateAgentStatusDisplay();
  });

  btnStop.addEventListener("click", () => {
    const orch = window.__glasstest_orchestrator__;
    if (orch) orch.terminate("Usuario detuvo la prueba");
    updateAgentStatusDisplay();
  });

  const glassToggle = floatingMenu.querySelector("#glasstest-glass-toggle");
  const glassToggleText = glassToggle.querySelector(".glasstest-action-text");
  glassToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    glassEnabled = !glassEnabled;
    if (glassEnabled) {
      showGlass();
      glassToggleText.textContent = "Desactivar vidrio";
      glassToggle.querySelector(".glasstest-action-icon").textContent = "🪟";
    } else {
      hideGlass();
      glassToggleText.textContent = "Activar vidrio";
      glassToggle.querySelector(".glasstest-action-icon").textContent = "👁️";
    }
  });

  makeDraggable(floatingMenu, floatingMenu.querySelector("#glasstest-handle"));

  setInterval(updateAgentStatusDisplay, 500);
}

function updateAgentStatusDisplay() {
  const statusSpan = document.getElementById("glasstest-agent-status");
  if (!statusSpan) return;
  const orch = window.__glasstest_orchestrator__;
  if (!orch) return;
  const state = orch.getState();
  let displayStatus = state.status;
  if (displayStatus === "TERMINATED") displayStatus = "STOPPED";
  statusSpan.innerText = displayStatus;
  switch (state.status) {
    case "RUNNING": statusSpan.style.color = "#a6e3a1"; break;
    case "PAUSED":  statusSpan.style.color = "#f9e2af"; break;
    case "TERMINATED": statusSpan.style.color = "#f38ba8"; break;
    default: statusSpan.style.color = "#cdd6f4";
  }
}

function removeFloatingMenu() {
  if (floatingMenu) {
    floatingMenu.remove();
    floatingMenu = null;
  }
}

// ─────────────────────────────────────────────
// MODAL DE RESULTADO (injectado en la página)
// ─────────────────────────────────────────────
function showResultModal(success, message) {
  // Eliminar modal anterior si existe
  const existing = document.getElementById("glasstest-result-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "glasstest-result-modal";
  modal.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    background: ${success ? "#10b981" : "#ef4444"};
    color: white;
    padding: 16px 20px;
    border-radius: 12px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
    display: flex;
    align-items: center;
    gap: 12px;
    cursor: default;
    animation: glasstest-fadein 0.25s ease;
    backdrop-filter: blur(4px);
  `;

  modal.innerHTML = `
    <span style="font-size: 20px;">${success ? "✅" : "❌"}</span>
    <span style="flex: 1; max-width: 300px;">${message || (success ? "Prueba exitosa" : "Prueba fallida")}</span>
    <button style="
      background: rgba(255,255,255,0.2);
      border: none;
      border-radius: 8px;
      padding: 6px 12px;
      color: white;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: background 0.15s;
    " onmouseover="this.style.background='rgba(255,255,255,0.3)'" onmouseout="this.style.background='rgba(255,255,255,0.2)'">Cerrar</button>
  `;

  const closeBtn = modal.querySelector("button");
  closeBtn.onclick = () => modal.remove();

  // Cerrar al hacer clic fuera del modal (opcional)
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };

  document.body.appendChild(modal);

  // Auto-ocultar después de 8 segundos
  setTimeout(() => {
    if (modal.parentNode) modal.remove();
  }, 8000);
}

// ─────────────────────────────────────────────
// DRAG HELPER
// ─────────────────────────────────────────────
function makeDraggable(el, handle) {
  let startX, startY, origX, origY, dragging = false;
  el.style.top = "16px";
  el.style.right = "16px";
  el.style.left = "auto";

  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest("#glasstest-toggle-btn")) return;
    dragging = true;
    const rect = el.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    origX = rect.left;
    origY = rect.top;
    el.style.left = origX + "px";
    el.style.top = origY + "px";
    el.style.right = "auto";
    document.addEventListener("mousemove", onDragMove, { capture: true });
    document.addEventListener("mouseup", onDragEnd, { capture: true });
    e.preventDefault();
  });

  function onDragMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const newLeft = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, origX + dx));
    const newTop = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, origY + dy));
    el.style.left = newLeft + "px";
    el.style.top = newTop + "px";
  }

  function onDragEnd() {
    dragging = false;
    document.removeEventListener("mousemove", onDragMove, { capture: true });
    document.removeEventListener("mouseup", onDragEnd, { capture: true });
  }
}

// ─────────────────────────────────────────────
// ESTILOS (renombrados a glasstest-)
// ─────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById("glasstest-styles")) return;
  const style = document.createElement("style");
  style.id = "glasstest-styles";
  style.textContent = `
    @keyframes glasstest-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.4); }
    }
    @keyframes glasstest-fadein {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    #glasstest-glass {
      position: fixed; inset: 0; z-index: 2147483646;
      background: rgba(83, 74, 183, 0.04); cursor: not-allowed;
      pointer-events: all; user-select: none;
      animation: glasstest-fadein 0.25s ease;
    }
    #glasstest-menu {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px; user-select: none;
      filter: drop-shadow(0 4px 20px rgba(0,0,0,0.18));
      min-width: 220px;
    }
    #glasstest-handle {
      background: #1e1b4b; color: white; padding: 8px 10px;
      border-radius: 10px; display: flex; align-items: center; gap: 7px;
      cursor: grab;
    }
    #glasstest-handle:active { cursor: grabbing; }
    #glasstest-grip { display: flex; flex-direction: column; gap: 2.5px; opacity: 0.45; flex-shrink: 0; }
    #glasstest-grip span { display: block; width: 14px; height: 2px; background: white; border-radius: 2px; }
    #glasstest-label { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; flex: 1; }
    #glasstest-dot-pulse {
      width: 7px; height: 7px; background: #a5b4fc; border-radius: 50%;
      display: inline-block; animation: glasstest-pulse 1.5s ease infinite;
      flex-shrink: 0;
    }
    #glasstest-toggle-btn {
      background: rgba(255,255,255,0.12); border: none; color: white;
      width: 22px; height: 22px; border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0; transition: background 0.15s;
    }
    #glasstest-toggle-btn:hover { background: rgba(255,255,255,0.22); }
    #glasstest-chevron { transition: transform 0.2s ease; }
    #glasstest-dropdown {
      display: none; background: white; border-radius: 0 0 10px 10px;
      overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      padding: 6px 0; margin-top: 2px; border-radius: 10px;
    }
    #glasstest-dropdown.glasstest-open { display: block; animation: glasstest-fadein 0.15s ease; }
    .glasstest-section-label {
      font-size: 10px; font-weight: 600; color: #94a3b8;
      text-transform: uppercase; letter-spacing: 0.06em; padding: 4px 12px 2px;
    }
    .glasstest-divider { height: 1px; background: #f1f5f9; margin: 5px 0; }
    .glasstest-action {
      display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 12px;
      background: none; border: none; color: #1e293b; font-size: 12px;
      font-family: inherit; cursor: pointer; text-align: left; transition: background 0.12s;
    }
    .glasstest-action:hover { background: #f8fafc; }
    .glasstest-agent-btn {
      border: none; padding: 5px 0; border-radius: 6px; font-size: 11px;
      font-weight: bold; cursor: pointer; flex: 1; transition: opacity 0.2s;
      color: #11111b;
    }
    .glasstest-agent-btn:hover { opacity: 0.8; }
  `;
  document.documentElement.appendChild(style);
}

// ─────────────────────────────────────────────
// ACTIVAR / DESACTIVAR AUDITORÍA
// ─────────────────────────────────────────────
function activateAudit() {
  if (isAuditing) return;
  isAuditing = true;
  glassEnabled = true;
  console.log("[GlassTest] Auditoría activa en:", location.href);
  injectStyles();
  createGlassOverlay();
  createFloatingMenu();

  // Registrar el tab actual para que el background sepa a quién enviar el modal
  chrome.runtime.sendMessage({ type: "REGISTER_TAB" }).catch(() => {});

  window.addEventListener("error", onPageError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
}

function deactivateAudit() {
  if (!isAuditing) return;
  isAuditing = false;
  console.log("[GlassTest] Auditoría desactivada en:", location.href);
  removeGlassOverlay();
  removeFloatingMenu();
  window.removeEventListener("error", onPageError);
  window.removeEventListener("unhandledrejection", onUnhandledRejection);
}

// ─────────────────────────────────────────────
// MANEJO DE MENSAJES (MODIFICADO)
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Activar/Desactivar auditoría
  if (msg.type === "AUDIT_STATE") {
    if (msg.active && !isAuditing) {
      activateAudit();
      if (window.__glasstest_orchestrator__) {
        window.__glasstest_orchestrator__.connect(); // Conectar al SW
      }
    }
    if (!msg.active && isAuditing) {
      deactivateAudit();
      // Forzar desconexión del puerto si el usuario apaga manualmente
      if (window.__glasstest_orchestrator__?.port) {
        window.__glasstest_orchestrator__.port.disconnect();
        window.__glasstest_orchestrator__.port = null;
      }
    }
    sendResponse({ ok: true });
    return;
  }

  // Responder al popup para verificar si el script ya está inyectado
  if (msg.type === "PING_ORCHESTRATOR") {
    sendResponse({ alive: true, isAuditing: isAuditing });
    return;
  }

  // Mostrar modal de resultado
  if (msg.type === "SHOW_RESULT_MODAL") {
    showResultModal(msg.success, msg.message);
    sendResponse({ ok: true });
    return;
  }

  // NUEVO: Activar auditoría desde el popup después de la inyección
  if (msg.type === "ACTIVATE_AUDIT") {
    if (!isAuditing) activateAudit();
    if (window.__glasstest_orchestrator__) {
      window.__glasstest_orchestrator__.connect();
    }
    sendResponse({ ok: true });
    return;
  }

  sendResponse({});
});

// ─────────────────────────────────────────────
// EVENTOS DE AUDITORÍA (errores JS)
// ─────────────────────────────────────────────
function onPageError(event) {
  chrome.runtime.sendMessage({
    type: "AUDIT_EVENT",
    event: { kind: "JS_ERROR", message: event.message, filename: event.filename, line: event.lineno, col: event.colno, url: location.href, timestamp: Date.now() }
  });
}
function onUnhandledRejection(event) {
  chrome.runtime.sendMessage({
    type: "AUDIT_EVENT",
    event: { kind: "UNHANDLED_REJECTION", message: String(event.reason), url: location.href, timestamp: Date.now() }
  });
}

// ─────────────────────────────────────────────
// INICIALIZACIÓN (MODIFICADA)
// ─────────────────────────────────────────────
(async function init() {
  // Preguntar al background el estado global antes de auto-activarse
  chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' }, (res) => {
    if (res && res.status === 'RUNNING') {
      // Venimos de una recarga en pleno test: auto-activar sin esperar al popup
      activateAudit();
      if (window.__glasstest_orchestrator__) {
        window.__glasstest_orchestrator__.connect();
      }
    } else {
      // Si no hay test activo, nos quedamos inyectados de forma pasiva 
      // esperando a que el popup mande "ACTIVATE_AUDIT" o "AUDIT_STATE" con active: true
      console.log("[GlassTest] Inyectado en modo pasivo a la espera de activación.");
    }
  });
})();