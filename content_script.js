/** content_script.js */

/**
 * Interfaz de usuario: vidrio bloqueante + menú flotante + pila visual FIFO.
 * Se comunica exclusivamente con el orquestador (no con el engine directamente).
 * Responsabilidad unica: ser la interfaz de usuario de SpectreQA.
 * Responsabilidades adyacentes:
 * - capturar interacciones del usuario
 * - mostrar feedback visual
 */

let isAuditing = false;
let glassOverlay = null;
let floatingMenu = null;
let glassEnabled = true;
let navigationDetected = false;
let navigationTargetUrl = null;
let navHandlersInitialized = false;

/**
 * GLASS OVERLAY (bloquea interacción para no interrumpir al agente)
 * solo se activa cuando el usuario da click en el boton para permitirlo en el popup
 */
function createGlassOverlay() {
  if (glassOverlay) return;
  injectStyles();

  glassOverlay = document.createElement("div");
  glassOverlay.id = "spectreqa-glass";

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

  glassOverlay.addEventListener("wheel", (e) => {
    if (window.__spectreqa_engine__?.isAutoScrolling) {
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

/**
 * MENÚ FLOTANTE (arrastrable + controles del orquestador)
 */
function createFloatingMenu() {
  if (floatingMenu) return;

  const wrapper = document.createElement("div");
  wrapper.id = "spectreqa-wrapper";
  wrapper.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    min-width: 220px;
    max-width: 280px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  `;

  floatingMenu = document.createElement("div");
  floatingMenu.id = "spectreqa-menu";
  floatingMenu.style.cssText = `
    width: 100%;
    filter: drop-shadow(0 4px 20px rgba(0,0,0,0.18));
  `;

  let menuOpen = false;

  floatingMenu.innerHTML = `
    <div id="spectreqa-handle">
      <div id="spectreqa-grip"><span></span><span></span><span></span></div>
      <div id="spectreqa-label">
        <span id="spectreqa-dot-pulse"></span>
        SpectreQA
      </div>
      <button id="spectreqa-toggle-btn" title="Abrir opciones">
        <svg id="spectreqa-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 4L6 8L10 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
    <div id="spectreqa-dropdown">
      <div class="spectreqa-section-label">Estado del agente</div>
      <div style="display:flex; align-items:center; justify-content:space-between; padding:4px 12px;">
        <span style="font-size:12px;">Estado:</span>
        <strong id="spectreqa-agent-status" style="color:#a6e3a1;">IDLE</strong>
      </div>
      <div class="spectreqa-divider"></div>
      <div class="spectreqa-section-label">Controles</div>
      <div style="display:flex; gap:6px; padding:6px 12px;">
        <button id="spectreqa-btn-run" class="spectreqa-agent-btn" style="background:#a6e3a1;">Correr</button>
        <button id="spectreqa-btn-pause" class="spectreqa-agent-btn" style="background:#f9e2af;">Pausa</button>
        <button id="spectreqa-btn-stop" class="spectreqa-agent-btn" style="background:#f38ba8;">Detener</button>
      </div>
      <div class="spectreqa-divider"></div>
      <div class="spectreqa-section-label">Interfaz</div>
      <button class="spectreqa-action" id="spectreqa-glass-toggle">
        <span class="spectreqa-action-icon"> </span>
        <span class="spectreqa-action-text">Desactivar vidrio</span>
      </button>
    </div>
  `;

  wrapper.appendChild(floatingMenu);

  let stackContainer = document.createElement("div");
  stackContainer.id = "spectreqa-visual-stack";
  stackContainer.style.cssText = `
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 400px;
    overflow: hidden;
    pointer-events: none;
  `;
  wrapper.appendChild(stackContainer);

  document.documentElement.appendChild(wrapper);

  const toggleBtn = floatingMenu.querySelector("#spectreqa-toggle-btn");
  const dropdown = floatingMenu.querySelector("#spectreqa-dropdown");
  const chevron = floatingMenu.querySelector("#spectreqa-chevron");

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuOpen = !menuOpen;
    dropdown.classList.toggle("spectreqa-open", menuOpen);
    chevron.style.transform = menuOpen ? "rotate(180deg)" : "rotate(0deg)";
  });

  document.addEventListener("click", (e) => {
    if (!wrapper.contains(e.target)) {
      menuOpen = false;
      dropdown.classList.remove("spectreqa-open");
      chevron.style.transform = "rotate(0deg)";
    }
  });

  const btnRun = floatingMenu.querySelector("#spectreqa-btn-run");
  const btnPause = floatingMenu.querySelector("#spectreqa-btn-pause");
  const btnStop = floatingMenu.querySelector("#spectreqa-btn-stop");

  btnRun.addEventListener("click", () => {
    const orch = window.__spectreqa_orchestrator__;
    if (orch) {
      const state = orch.getState();
      if (state.status === 'WAITING') {
        window.dispatchEvent(new CustomEvent('__spectreqa_lifecycle_event__', {
          detail: { status: 'CONTINUE', message: 'Reanudado desde WAITING por usuario' }
        }));
      } else {
        orch.run();
      }
    }
    updateAgentStatusDisplay();
  });

  btnPause.addEventListener("click", () => {
    const orch = window.__spectreqa_orchestrator__;
    if (orch) {
      const state = orch.getState();
      if (state.status === "RUNNING") {
        orch.pause();
      } else if (state.status === "PAUSED" || state.status === "WAITING") {
        window.dispatchEvent(new CustomEvent('__spectreqa_lifecycle_event__', {
          detail: { status: 'CONTINUE', message: 'Reanudado por usuario desde ' + state.status }
        }));
      }
    }
    updateAgentStatusDisplay();
  });

  btnStop.addEventListener("click", () => {
    const orch = window.__spectreqa_orchestrator__;
    if (orch) orch.terminate("Usuario detuvo la prueba");
    updateAgentStatusDisplay();
  });

  const glassToggle = floatingMenu.querySelector("#spectreqa-glass-toggle");
  const glassToggleText = glassToggle.querySelector(".spectreqa-action-text");
  glassToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    glassEnabled = !glassEnabled;
    if (glassEnabled) {
      showGlass();
      glassToggleText.textContent = "Desactivar vidrio";
      glassToggle.querySelector(".spectreqa-action-icon").textContent = "";
    } else {
      hideGlass();
      glassToggleText.textContent = "Activar vidrio";
      glassToggle.querySelector(".spectreqa-action-icon").textContent = "";
    }
  });

  makeDraggable(wrapper, floatingMenu.querySelector("#spectreqa-handle"));

  setInterval(updateAgentStatusDisplay, 500);

  chrome.runtime.sendMessage({ type: 'GET_VISUAL_HISTORY' }, (response) => {
    if (response && response.history) {
      renderVisualHistory(response.history);
    }
  });
}

function updateAgentStatusDisplay() {
  const statusSpan = document.getElementById("spectreqa-agent-status");
  if (!statusSpan) return;
  const orch = window.__spectreqa_orchestrator__;
  if (!orch) return;
  const state = orch.getState();
  let displayStatus = state.status;
  if (displayStatus === "TERMINATED") displayStatus = "STOPPED";
  if (displayStatus === "WAITING") displayStatus = "WAITING";
  statusSpan.innerText = displayStatus;
  switch (state.status) {
    case "RUNNING": statusSpan.style.color = "#a6e3a1"; break;
    case "PAUSED":  statusSpan.style.color = "#f9e2af"; break;
    case "WAITING": statusSpan.style.color = "#fbbf24"; break;
    case "TERMINATED": statusSpan.style.color = "#f38ba8"; break;
    default: statusSpan.style.color = "#cdd6f4";
  }
}

function removeFloatingMenu() {
  const wrapper = document.getElementById("spectreqa-wrapper");
  if (wrapper) {
    wrapper.remove();
  }
  floatingMenu = null;
}

/**
 * PILA VISUAL FIFO (Pensamientos + Comandos)
 */
function renderVisualHistory(history) {
  const stackContainer = document.getElementById('spectreqa-visual-stack');
  if (!stackContainer) return;

  stackContainer.innerHTML = '';

  const itemsToShow = history.slice(-10);  // <-- Límite aumentado a 10

  itemsToShow.forEach(item => {
    const card = document.createElement('div');
    card.className = `spectreqa-card ${item.type}`;
    card.textContent = item.text;
    stackContainer.appendChild(card);
  });
}

/**
 * MODAL DE RESULTADO (inyectado en la página)
 */
function showResultModal(success, message) {
  const existing = document.getElementById("spectreqa-result-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "spectreqa-result-modal";
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
    animation: spectreqa-fadein 0.25s ease;
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

  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };

  document.body.appendChild(modal);

  setTimeout(() => {
    if (modal.parentNode) modal.remove();
  }, 8000);
}

/**
 * DRAG HELPER (arrastra el wrapper completo)
 */
function makeDraggable(wrapper, handle) {
  let startX, startY, origX, origY, dragging = false;
  wrapper.style.top = "16px";
  wrapper.style.right = "16px";
  wrapper.style.left = "auto";

  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest("#spectreqa-toggle-btn")) return;
    dragging = true;
    const rect = wrapper.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    origX = rect.left;
    origY = rect.top;
    wrapper.style.left = origX + "px";
    wrapper.style.top = origY + "px";
    wrapper.style.right = "auto";
    document.addEventListener("mousemove", onDragMove, { capture: true });
    document.addEventListener("mouseup", onDragEnd, { capture: true });
    e.preventDefault();
  });

  function onDragMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const newLeft = Math.max(0, Math.min(window.innerWidth - wrapper.offsetWidth, origX + dx));
    const newTop = Math.max(0, Math.min(window.innerHeight - wrapper.offsetHeight, origY + dy));
    wrapper.style.left = newLeft + "px";
    wrapper.style.top = newTop + "px";
  }

  function onDragEnd() {
    dragging = false;
    document.removeEventListener("mousemove", onDragMove, { capture: true });
    document.removeEventListener("mouseup", onDragEnd, { capture: true });
  }
}

/**
 * ESTILOS (incluyendo los de la pila visual)
 */
function injectStyles() {
  if (document.getElementById("spectreqa-styles")) return;
  const style = document.createElement("style");
  style.id = "spectreqa-styles";
  style.textContent = `
    @keyframes spectreqa-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.4); }
    }
    @keyframes spectreqa-fadein {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes spectreqa-card-slide {
      from { opacity: 0; transform: translateY(-8px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    
    #spectreqa-glass {
      position: fixed; inset: 0; z-index: 2147483646;
      background: rgba(83, 74, 183, 0.04); cursor: not-allowed;
      pointer-events: all; user-select: none;
      animation: spectreqa-fadein 0.25s ease;
    }
    
    #spectreqa-wrapper {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
      min-width: 220px;
      max-width: 280px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      user-select: none;
    }
    
    #spectreqa-menu {
      width: 100%;
      filter: drop-shadow(0 4px 20px rgba(0,0,0,0.18));
    }
    
    #spectreqa-handle {
      background: #1e1b4b; color: white; padding: 8px 10px;
      border-radius: 10px; display: flex; align-items: center; gap: 7px;
      cursor: grab;
    }
    #spectreqa-handle:active { cursor: grabbing; }
    
    #spectreqa-grip { display: flex; flex-direction: column; gap: 2.5px; opacity: 0.45; flex-shrink: 0; }
    #spectreqa-grip span { display: block; width: 14px; height: 2px; background: white; border-radius: 2px; }
    
    #spectreqa-label { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; flex: 1; }
    #spectreqa-dot-pulse {
      width: 7px; height: 7px; background: #a5b4fc; border-radius: 50%;
      display: inline-block; animation: spectreqa-pulse 1.5s ease infinite;
      flex-shrink: 0;
    }
    
    #spectreqa-toggle-btn {
      background: rgba(255,255,255,0.12); border: none; color: white;
      width: 22px; height: 22px; border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0; transition: background 0.15s;
    }
    #spectreqa-toggle-btn:hover { background: rgba(255,255,255,0.22); }
    #spectreqa-chevron { transition: transform 0.2s ease; }
    
    #spectreqa-dropdown {
      display: none; background: white; border-radius: 0 0 10px 10px;
      overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      padding: 6px 0; margin-top: 2px; border-radius: 10px;
    }
    #spectreqa-dropdown.spectreqa-open { display: block; animation: spectreqa-fadein 0.15s ease; }
    
    .spectreqa-section-label {
      font-size: 10px; font-weight: 600; color: #94a3b8;
      text-transform: uppercase; letter-spacing: 0.06em; padding: 4px 12px 2px;
    }
    .spectreqa-divider { height: 1px; background: #f1f5f9; margin: 5px 0; }
    
    .spectreqa-action {
      display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 12px;
      background: none; border: none; color: #1e293b; font-size: 12px;
      font-family: inherit; cursor: pointer; text-align: left; transition: background 0.12s;
    }
    .spectreqa-action:hover { background: #f8fafc; }
    
    .spectreqa-agent-btn {
      border: none; padding: 5px 0; border-radius: 6px; font-size: 11px;
      font-weight: bold; cursor: pointer; flex: 1; transition: opacity 0.2s;
      color: #11111b;
    }
    .spectreqa-agent-btn:hover { opacity: 0.8; }

    #spectreqa-visual-stack {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 400px;
      overflow: hidden;
      pointer-events: none;
    }

    .spectreqa-card {
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.5;
      font-weight: 500;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      word-break: break-word;
      color: #ffffff;
      animation: spectreqa-card-slide 0.25s ease;
      pointer-events: auto;
      transition: all 0.2s ease;
      flex-shrink: 0;
      opacity: 1 !important;
    }

    .spectreqa-card.thought {
      background-color: #2563eb;
      border-left: 4px solid #1d4ed8;
    }

    .spectreqa-card.command {
      background-color: #16a34a;
      border-left: 4px solid #15803d;
    }
  `;
  document.documentElement.appendChild(style);
}

/**
 * DETECCIÓN DE NAVEGACIÓN Y RECUPERACIÓN DE ESTADO
 */
function setupNavigationHandlers() {
  if (navHandlersInitialized) return;
  navHandlersInitialized = true;

  window.addEventListener('beforeunload', function(e) {
    console.log('[SpectreQA] Navegación detectada');
    navigationDetected = true;
    navigationTargetUrl = window.location.href;
    
    const orch = window.__spectreqa_orchestrator__;
    if (orch) {
      const state = orch.getState();
      
      try {
        const backupData = {
          phase: state.phase,
          status: state.status,
          commandQueue: orch.commandQueue || [],
          currentCommandIndex: orch.currentCommandIndex || -1,
          thought: state.thought,
          url: window.location.href,
          timestamp: Date.now(),
          isNavigation: true
        };
        localStorage.setItem('__spectreqa_backup__', JSON.stringify(backupData));
        console.log('[SpectreQA] Estado guardado en localStorage antes de navegar');
      } catch (err) {
        console.warn('[SpectreQA] No se pudo guardar estado:', err);
      }
      
      chrome.runtime.sendMessage({
        type: 'NAVIGATION_DETECTED',
        data: {
          from: window.location.href,
          phase: state.phase,
          timestamp: Date.now()
        }
      });
    }
    
    // Pequeño delay para asegurar que el mensaje se envía
    return undefined;
  });

  window.addEventListener('load', function() {
    console.log('[SpectreQA] Nueva página cargada:', window.location.href);
    
    // LIMPIAR FLAG DE NAVEGACIÓN
    const wasNavigation = navigationDetected;
    navigationDetected = false;
    navigationTargetUrl = null;
    
    if (wasNavigation) {
      console.log('[SpectreQA] Recuperando estado después de navegación');
      
      try {
        const savedRaw = localStorage.getItem('__spectreqa_backup__');
        if (savedRaw) {
          const saved = JSON.parse(savedRaw);
          console.log('[SpectreQA] Estado recuperado:', saved);
          
          const orch = window.__spectreqa_orchestrator__;
          if (orch && orch.status !== 'SUCCESS' && orch.status !== 'TERMINATED') {
            orch.restoreFromBackup(saved);
            orch.status = 'WAITING';
            orch.isWaiting = true;
            
            window.dispatchEvent(new CustomEvent('__spectreqa_lifecycle_event__', {
              detail: {
                status: 'WAIT',
                message: 'Navegación completada, esperando reanudación',
                fromUrl: saved.url,
                toUrl: window.location.href,
                phase: saved.phase,
                isNavigation: true
              }
            }));
          } else if (orch && (orch.status === 'SUCCESS' || orch.status === 'TERMINATED')) {
            console.log('[SpectreQA] Orquestador ya finalizado, ignorando backup');
            localStorage.removeItem('__spectreqa_backup__');
            return;
          }
          
          // Limpiar backup después de restaurar
          setTimeout(() => {
            localStorage.removeItem('__spectreqa_backup__');
          }, 1000);
        }
      } catch (err) {
        console.warn('[SpectreQA] No se pudo recuperar estado:', err);
      }
    }
  });
}

/**
 * ACTIVAR / DESACTIVAR AUDITORÍA
 */
function activateAudit() {
  if (isAuditing) return;
  isAuditing = true;
  glassEnabled = true;
  navigationDetected = false;
  console.log("[SpectreQA] Auditoría activa en:", location.href);
  injectStyles();
  createGlassOverlay();
  createFloatingMenu();
  setupNavigationHandlers();

  chrome.runtime.sendMessage({ type: "REGISTER_TAB" }).catch(() => {});

  window.addEventListener("error", onPageError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
}

function deactivateAudit() {
  if (!isAuditing) return;
  isAuditing = false;
  console.log("[SpectreQA] Auditoría desactivada en:", location.href);
  removeGlassOverlay();
  removeFloatingMenu();
  const stack = document.getElementById("spectreqa-visual-stack");
  if (stack) stack.remove();
  window.removeEventListener("error", onPageError);
  window.removeEventListener("unhandledrejection", onUnhandledRejection);
  // No removemos los handlers de navegación para mantener consistencia
}

/**
 * MANEJO DE MENSAJES
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "AUDIT_STATE") {
    if (msg.active && !isAuditing) {
      activateAudit();
      if (window.__spectreqa_orchestrator__) {
        window.__spectreqa_orchestrator__.connect();
      }
    }
    if (!msg.active && isAuditing) {
      deactivateAudit();
      if (window.__spectreqa_orchestrator__?.port) {
        window.__spectreqa_orchestrator__.port.disconnect();
        window.__spectreqa_orchestrator__.port = null;
      }
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "PING_ORCHESTRATOR") {
    sendResponse({ alive: true, isAuditing: isAuditing });
    return;
  }

  if (msg.type === "SHOW_RESULT_MODAL") {
    showResultModal(msg.success, msg.message);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "ACTIVATE_AUDIT") {
    if (!isAuditing) activateAudit();
    if (window.__spectreqa_orchestrator__) {
      window.__spectreqa_orchestrator__.connect();
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "UPDATE_VISUAL_UI") {
    renderVisualHistory(msg.history);
    sendResponse({ ok: true });
    return;
  }

  sendResponse({});
});

/**
 * EVENTOS DE AUDITORÍA (errores JS)
 */
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

/**
 * INICIALIZACIÓN
 */
(async function init() {
  // Siempre inyectar estilos y configurar handlers de navegación
  injectStyles();
  setupNavigationHandlers();
  
  chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' }, (res) => {
    if (res && (res.status === 'RUNNING' || res.status === 'WAITING') && !res.testFinished) {
      activateAudit();
      if (window.__spectreqa_orchestrator__) {
        window.__spectreqa_orchestrator__.connect();
      }
    } else {
      console.log("[SpectreQA] Inyectado en modo pasivo a la espera de activación.");
    }
  });
})();