/** agenteVisual.js */
/**
 * ContentScriptUI
 * 
 * Responsabilidad única: Interfaz de usuario (overlay bloqueante, menú flotante y pila visual).
 * Utiliza la clase estática `Pila` para la renderización de pensamientos y comandos.
 */
class ContentScriptUI {
  // Estado privado encapsulado en un único objeto
  #state = {
    isAuditing: false,
    glassOverlay: null,
    floatingMenu: null,
    glassEnabled: true,
    navHandlersInitialized: false,
    unsubscribePila: null,
    statusCheckInterval: null
  };

  constructor() {
    this.#init();
  }

  // --- INICIALIZACIÓN ---

  #init() {
    this.injectStyles();
    this.setupNavigationHandlers();
    // this.linkLifecycleManager();
    this.setupMessageListeners();

    chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' }, (res) => {
      if (res && (res.status === 'RUNNING' || res.status === 'WAITING') && !res.testFinished) {
        this.activateAudit();
        if (window.__spectreqa_orchestrator__) {
          window.__spectreqa_orchestrator__.connect();
        }
      } else {
        console.log("[SpectreQA] Inyectado en modo pasivo a la espera de activación.");
      }
    });
  }

  // --- CONTROL DE AUDITORÍA ---

  activateAudit() {
    if (this.#state.isAuditing) return;
    this.#state.isAuditing = true;
    this.#state.glassEnabled = true;

    console.log("[SpectreQA] Auditoría activa en:", location.href);
    
    this.injectStyles();
    this.createGlassOverlay();
    this.createFloatingMenu();
    this.setupNavigationHandlers();
    // this.linkLifecycleManager();

    chrome.runtime.sendMessage({ type: "REGISTER_TAB" }).catch(() => {});

    window.addEventListener("error", this.#onPageError);
    window.addEventListener("unhandledrejection", this.#onUnhandledRejection);
  }

  deactivateAudit() {
    if (!this.#state.isAuditing) return;
    this.#state.isAuditing = false;

    console.log("[SpectreQA] Auditoría desactivada en:", location.href);

    this.removeGlassOverlay();
    this.removeFloatingMenu();

    const stack = document.getElementById("spectreqa-visual-stack");
    if (stack) stack.remove();

    window.removeEventListener("error", this.#onPageError);
    window.removeEventListener("unhandledrejection", this.#onUnhandledRejection);
  }

  // --- GLASS OVERLAY ---

  createGlassOverlay() {
    if (this.#state.glassOverlay) return;
    this.injectStyles();

    const glass = document.createElement("div");
    glass.id = "spectreqa-glass";

    const BLOCK = [
      "click", "mousedown", "mouseup", "mousemove",
      "pointerdown", "pointerup", "pointermove",
      "touchstart", "touchend", "touchmove",
      "keydown", "keyup", "keypress",
      "contextmenu", "dblclick"
    ];

    BLOCK.forEach((evtName) => {
      glass.addEventListener(evtName, (e) => {
        e.stopPropagation();
        e.preventDefault();
      }, { capture: true });
    });

    glass.addEventListener("wheel", (e) => {
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

    glass.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      chrome.runtime.sendMessage({
        type: "USER_INTERACTION",
        event: { kind: "CLICK", x: e.clientX, y: e.clientY, url: location.href, timestamp: Date.now() }
      });
    }, { capture: true });

    document.documentElement.appendChild(glass);
    this.#state.glassOverlay = glass;
  }

  removeGlassOverlay() {
    if (this.#state.glassOverlay) {
      this.#state.glassOverlay.remove();
      this.#state.glassOverlay = null;
    }
  }

  showGlass() {
    if (this.#state.glassOverlay) this.#state.glassOverlay.style.display = "block";
  }

  hideGlass() {
    if (this.#state.glassOverlay) this.#state.glassOverlay.style.display = "none";
  }

  // --- MENÚ FLOTANTE Y CONTROLES ---

  createFloatingMenu() {
    if (this.#state.floatingMenu) return;

    const wrapper = document.createElement("div");
    wrapper.id = "spectreqa-wrapper";

    const menu = document.createElement("div");
    menu.id = "spectreqa-menu";

    let menuOpen = false;

    menu.innerHTML = `
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
          <span class="spectreqa-action-icon"></span>
          <span class="spectreqa-action-text">Desactivar vidrio</span>
        </button>
      </div>
    `;

    wrapper.appendChild(menu);

    const stackContainer = document.createElement("div");
    stackContainer.id = "spectreqa-visual-stack";
    wrapper.appendChild(stackContainer);

    document.documentElement.appendChild(wrapper);
    this.#state.floatingMenu = menu;

    // Event Listeners del menú
    const toggleBtn = menu.querySelector("#spectreqa-toggle-btn");
    const dropdown = menu.querySelector("#spectreqa-dropdown");
    const chevron = menu.querySelector("#spectreqa-chevron");

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

    menu.querySelector("#spectreqa-btn-run").addEventListener("click", () => {
      // run() ya sabe distinguir arranque nuevo vs. reanudar desde PAUSED/WAITING.
      window.__spectreqa_orchestrator__?.run();
      this.updateAgentStatusDisplay();
    });

    menu.querySelector("#spectreqa-btn-pause").addEventListener("click", () => {
      const currentStatus = window.__spectreqa_lifecycle__?.status;
      if (currentStatus === "RUNNING") {
        window.dispatchEvent(new CustomEvent('__spectreqa_lifecycle_event__', {
          detail: { status: 'PAUSE', message: 'Pausado por usuario' }
        }));
      } else if (currentStatus === "PAUSED" || currentStatus === "WAITING") {
        window.dispatchEvent(new CustomEvent('__spectreqa_lifecycle_event__', {
          detail: { status: 'CONTINUE', message: 'Reanudado por usuario' }
        }));
      }
      this.updateAgentStatusDisplay();
    });

    menu.querySelector("#spectreqa-btn-stop").addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent('__spectreqa_lifecycle_event__', {
        detail: { status: 'TERMINATE', message: 'Usuario detuvo la prueba' }
      }));
      this.updateAgentStatusDisplay();
    });

    const glassToggle = menu.querySelector("#spectreqa-glass-toggle");
    const glassToggleText = glassToggle.querySelector(".spectreqa-action-text");
    glassToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#state.glassEnabled = !this.#state.glassEnabled;
      if (this.#state.glassEnabled) {
        this.showGlass();
        glassToggleText.textContent = "Desactivar vidrio";
      } else {
        this.hideGlass();
        glassToggleText.textContent = "Activar vidrio";
      }
    });

    this.makeDraggable(wrapper, menu.querySelector("#spectreqa-handle"));
    this.#state.statusCheckInterval = setInterval(() => this.updateAgentStatusDisplay(), 500);

    // --- SUSCRIPCIÓN A LA CLASE ESTÁTICA PILA ---
    this.renderVisualHistory(window.Pila ? window.Pila.responses : []);
    if (window.Pila && typeof window.Pila.suscribir === 'function') {
      if (this.#state.unsubscribePila) this.#state.unsubscribePila();
      this.#state.unsubscribePila = window.Pila.suscribir((responses) => {
        this.renderVisualHistory(responses);
      });
    }
  }

  updateAgentStatusDisplay() {
    const statusSpan = document.getElementById("spectreqa-agent-status");
    if (!statusSpan) return;

    const currentStatus = window.__spectreqa_lifecycle__?.status || "IDLE";
    let displayStatus = currentStatus;
    if (displayStatus === "TERMINATED") displayStatus = "STOPPED";
    statusSpan.innerText = displayStatus;

    switch (currentStatus) {
      case "RUNNING": statusSpan.style.color = "#a6e3a1"; break;
      case "PAUSED":  statusSpan.style.color = "#f9e2af"; break;
      case "WAITING": statusSpan.style.color = "#fbbf24"; break;
      case "TERMINATED": statusSpan.style.color = "#f38ba8"; break;
      default: statusSpan.style.color = "#cdd6f4";
    }
  }

  removeFloatingMenu() {
    if (this.#state.unsubscribePila) {
      this.#state.unsubscribePila();
      this.#state.unsubscribePila = null;
    }
    if (this.#state.statusCheckInterval) {
      clearInterval(this.#state.statusCheckInterval);
      this.#state.statusCheckInterval = null;
    }
    const wrapper = document.getElementById("spectreqa-wrapper");
    if (wrapper) wrapper.remove();
    this.#state.floatingMenu = null;
  }

  // --- RENDERIZADO DE LA PILA VISUAL ---

  renderVisualHistory(responses = []) {
    const stackContainer = document.getElementById('spectreqa-visual-stack');
    if (!stackContainer) return;

    stackContainer.innerHTML = '';
    const itemsToShow = responses.slice(-10);

    itemsToShow.forEach(resp => {
      // Pensamiento
      if (resp.thought) {
        const thoughtCard = document.createElement('div');
        thoughtCard.className = 'spectreqa-card thought';
        thoughtCard.textContent = resp.thought;
        stackContainer.appendChild(thoughtCard);
      }
      // Comandos
      if (Array.isArray(resp.commands)) {
        resp.commands.forEach(cmd => {
          const cmdCard = document.createElement('div');
          cmdCard.className = 'spectreqa-card command';
          cmdCard.textContent = cmd;
          stackContainer.appendChild(cmdCard);
        });
      }
    });
  }

  // --- MODAL DE RESULTADO ---

  showResultModal(success, message) {
    const existing = document.getElementById("spectreqa-result-modal");
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.id = "spectreqa-result-modal";
    modal.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
      background: ${success ? "#10b981" : "#ef4444"}; color: white;
      padding: 16px 20px; border-radius: 12px; font-family: sans-serif;
      font-size: 14px; font-weight: 500; box-shadow: 0 8px 24px rgba(0,0,0,0.2);
      display: flex; align-items: center; gap: 12px; backdrop-filter: blur(4px);
    `;

    modal.innerHTML = `
      <span style="font-size: 20px;">${success ? "✅" : "❌"}</span>
      <span style="flex: 1; max-width: 300px;">${message || (success ? "Prueba exitosa" : "Prueba fallida")}</span>
      <button style="background: rgba(255,255,255,0.2); border: none; border-radius: 8px; padding: 6px 12px; color: white; cursor: pointer;">Cerrar</button>
    `;

    modal.querySelector("button").onclick = () => modal.remove();
    document.body.appendChild(modal);
    setTimeout(() => { if (modal.parentNode) modal.remove(); }, 8000);
  }

  // --- ARRASTRE DE ELEMENTOS ---

  makeDraggable(wrapper, handle) {
    let startX, startY, origX, origY, dragging = false;

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

      const onDragMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        wrapper.style.left = Math.max(0, Math.min(window.innerWidth - wrapper.offsetWidth, origX + dx)) + "px";
        wrapper.style.top = Math.max(0, Math.min(window.innerHeight - wrapper.offsetHeight, origY + dy)) + "px";
      };

      const onDragEnd = () => {
        dragging = false;
        document.removeEventListener("mousemove", onDragMove, { capture: true });
        document.removeEventListener("mouseup", onDragEnd, { capture: true });
      };

      document.addEventListener("mousemove", onDragMove, { capture: true });
      document.addEventListener("mouseup", onDragEnd, { capture: true });
      e.preventDefault();
    });
  }

  // --- EVENTOS DE ERROR JS ---

  #onPageError = (event) => {
    chrome.runtime.sendMessage({
      type: "AUDIT_EVENT",
      event: { kind: "JS_ERROR", message: event.message, filename: event.filename, line: event.lineno, col: event.colno, url: location.href, timestamp: Date.now() }
    });
  };

  #onUnhandledRejection = (event) => {
    chrome.runtime.sendMessage({
      type: "AUDIT_EVENT",
      event: { kind: "UNHANDLED_REJECTION", message: String(event.reason), url: location.href, timestamp: Date.now() }
    });
  };

  // --- MENSAJES Y NAVEGACIÓN ---

  setupNavigationHandlers() {
    if (this.#state.navHandlersInitialized) return;
    this.#state.navHandlersInitialized = true;

    window.addEventListener('beforeunload', () => {
      // FIX: antes solo avisábamos NAVIGATION_DETECTED (informativo para Rust),
      // pero isWaiting nunca pasaba a true en este lado. El watchdog de Rust
      // necesita ver la flag ASYNC_WAIT llegar ANTES de que el puerto se caiga
      // por la navegación/recarga, o interpreta el silencio como fallo.
      // Reusamos el mismo evento de ciclo de vida que usa el QA para WAIT,
      // así LifeCicle sigue siendo la única fuente de verdad (isWaiting=true
      // aquí también, no solo cuando el QA lo emite explícitamente).
      window.dispatchEvent(new CustomEvent('__spectreqa_lifecycle_event__', {
        detail: { status: 'WAIT', message: 'Página recargando o navegando a otra vista' }
      }));

      const orchestrator = window.__spectreqa_orchestrator__;
      if (orchestrator) {
        const state = orchestrator.getState();
        chrome.runtime.sendMessage({
          type: 'NAVIGATION_DETECTED',
          data: {
            from: window.location.href,
            phase: state.phase,
            timestamp: Date.now()
          }
        }).catch(() => {
          // Es esperable que esto falle a veces: la página ya se está cerrando.
        });
      }
    });
  }

  linkLifecycleManager() {
    // 👉 Corregidos los nombres globales con __
    const orchestrator = window.__spectreqa_orchestrator__;
    const lifecycleManager = window.__spectreqa_lifecycle_manager__;

    if (!orchestrator || !lifecycleManager) {
      console.warn('[SpectreQA] No se pudo vincular: falta orquestador o lifecycle manager');
      return false;
    }

    if (lifecycleManager.orchestrator === orchestrator) {
      return true; // Ya está vinculado
    }

    // Al llamar a attachOrchestrator, se drena el búfer de eventos pendientes automáticamente
    lifecycleManager.attachOrchestrator(orchestrator);
    console.log('[SpectreQA] Componentes vinculados correctamente');

    return true;
  }

  setupMessageListeners() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "AUDIT_STATE") {
        if (msg.active && !this.#state.isAuditing) {
          this.activateAudit();
          window.__spectreqa_orchestrator__?.connect();
        }
        if (!msg.active && this.#state.isAuditing) {
          this.deactivateAudit();
          window.__spectreqa_orchestrator__?.destroy();
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "PING_ORCHESTRATOR") {
        sendResponse({ alive: true, isAuditing: this.#state.isAuditing });
        return;
      }

      if (msg.type === "SHOW_RESULT_MODAL") {
        this.showResultModal(msg.success, msg.message);
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "UPDATE_VISUAL_UI") {
        if (window.Pila && Array.isArray(msg.history)) {
          window.Pila.setResponses(msg.history);
        }
        sendResponse({ ok: true });
        return;
      }

      sendResponse({});
    });
  }

  // --- ESTILOS INYECTADOS ---

  injectStyles() {
    if (document.getElementById("spectreqa-styles")) return;
    const style = document.createElement("style");
    style.id = "spectreqa-styles";
    style.textContent = `
      @keyframes spectreqa-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.4); } }
      @keyframes spectreqa-fadein { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes spectreqa-card-slide { from { opacity: 0; transform: translateY(-8px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
      #spectreqa-glass { position: fixed; inset: 0; z-index: 2147483646; background: rgba(83, 74, 183, 0.04); cursor: not-allowed; pointer-events: all; user-select: none; }
      #spectreqa-wrapper { position: fixed; top: 16px; right: 16px; z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; min-width: 220px; max-width: 280px; font-family: sans-serif; user-select: none; }
      #spectreqa-menu { width: 100%; filter: drop-shadow(0 4px 20px rgba(0,0,0,0.18)); }
      #spectreqa-handle { background: #1e1b4b; color: white; padding: 8px 10px; border-radius: 10px; display: flex; align-items: center; gap: 7px; cursor: grab; }
      #spectreqa-grip { display: flex; flex-direction: column; gap: 2.5px; opacity: 0.45; }
      #spectreqa-grip span { display: block; width: 14px; height: 2px; background: white; border-radius: 2px; }
      #spectreqa-label { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; flex: 1; }
      #spectreqa-dot-pulse { width: 7px; height: 7px; background: #a5b4fc; border-radius: 50%; display: inline-block; animation: spectreqa-pulse 1.5s ease infinite; }
      #spectreqa-toggle-btn { background: rgba(255,255,255,0.12); border: none; color: white; width: 22px; height: 22px; border-radius: 6px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
      #spectreqa-dropdown { display: none; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.12); padding: 6px 0; margin-top: 2px; }
      #spectreqa-dropdown.spectreqa-open { display: block; animation: spectreqa-fadein 0.15s ease; }
      .spectreqa-section-label { font-size: 10px; font-weight: 600; color: #94a3b8; text-transform: uppercase; padding: 4px 12px 2px; }
      .spectreqa-divider { height: 1px; background: #f1f5f9; margin: 5px 0; }
      .spectreqa-action { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 12px; background: none; border: none; color: #1e293b; font-size: 12px; cursor: pointer; text-align: left; }
      .spectreqa-agent-btn { border: none; padding: 5px 0; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; flex: 1; color: #11111b; }
      #spectreqa-visual-stack { width: 100%; display: flex; flex-direction: column; gap: 6px; max-height: 400px; overflow: hidden; pointer-events: none; }
      .spectreqa-card { padding: 8px 12px; border-radius: 6px; font-size: 12px; line-height: 1.5; font-weight: 500; box-shadow: 0 2px 8px rgba(0,0,0,0.15); word-break: break-word; color: #ffffff; animation: spectreqa-card-slide 0.25s ease; pointer-events: auto; }
      .spectreqa-card.thought { background-color: #2563eb; border-left: 4px solid #1d4ed8; }
      .spectreqa-card.command { background-color: #16a34a; border-left: 4px solid #15803d; }
    `;
    document.documentElement.appendChild(style);
  }
}

// Instanciación automática
window.__spectreqa_ui__ = new ContentScriptUI();

/** pila.js */
/**
 * Estructura de datos para la respuesta del modelo de IA.
 * Representa un bloque de pensamiento y la lista de comandos a ejecutar.
 */
class IAResponse {
  constructor(thought = "", commands = []) {
    this.thought = thought;
    this.commands = Array.isArray(commands) ? commands : [];
    this.timestamp = Date.now();
  }
}

/**
 * Pila (Visual History Stack)
 * 
 * Clase 100% estática. Única fuente de verdad para la pila visual en memoria.
 * Ya no gestiona persistencia en localStorage ni sincronización directa.
 */
class Pila {
  // Lista de respuestas de la IA (array privado estático)
  static #responses = [];

  // Suscriptores (callbacks de la UI)
  static #subscribers = [];

  /**
   * Apila un nuevo IAResponse en la historia visual.
   * @param {IAResponse|Object} value
   */
  static apilar(value) {
    if (!value) return;

    // Instanciar IAResponse si nos pasan un objeto llano
    const responseObj = value instanceof IAResponse 
      ? value 
      : new IAResponse(value.thought || value.tought, value.commands || value.comands);

    Pila.#responses.push(responseObj);
    Pila.#notificar();
  }

  /**
   * Quita y retorna el primer elemento en entrar (Comportamiento FIFO/Queue)
   * @returns {IAResponse|null}
   */
  static desapilarPrimerEntrada() {
    if (Pila.#responses.length === 0) return null;
    
    const removed = Pila.#responses.shift();
    Pila.#notificar();
    return removed;
  }

  /**
   * Quita y retorna el último elemento ingresado (Comportamiento LIFO / Pila tradicional)
   * @returns {IAResponse|null}
   */
  static desapilar() {
    if (Pila.#responses.length === 0) return null;

    const removed = Pila.#responses.pop();
    Pila.#notificar();
    return removed;
  }

  /**
   * Obtiene una copia readonly de la pila actual
   * @returns {Array<IAResponse>}
   */
  static get responses() {
    return [...Pila.#responses];
  }

  /**
   * Limpia toda la pila
   */
  static clear() {
    Pila.#responses = [];
    Pila.#notificar();
  }

  /**
   * Reemplaza el contenido completo de la pila (por ejemplo, si se recibe una sync del background)
   * @param {Array} newResponses 
   */
  static setResponses(newResponses = []) {
    Pila.#responses = newResponses.map(
      item => new IAResponse(item.thought || item.tought, item.commands || item.comands)
    );
    Pila.#notificar();
  }

  // --- Patrón Observer para la UI ---

  /**
   * Permite a la UI suscribirse a los cambios de la pila
   * @param {Function} callback 
   * @returns {Function} Función para desuscribirse
   */
  static suscribir(callback) {
    if (typeof callback === 'function') {
      Pila.#subscribers.push(callback);
    }
    return () => {
      Pila.#subscribers = Pila.#subscribers.filter(sub => sub !== callback);
    };
  }

  static #notificar() {
    const currentSnapshot = Pila.responses;
    Pila.#subscribers.forEach(cb => {
      try {
        cb(currentSnapshot);
      } catch (err) {
        console.error('[Pila] Error notificando suscriptor:', err);
      }
    });
  }
}

// Exposición global
window.IAResponse = IAResponse;
window.Pila = Pila;
window.__spectreqa_pila__ = Pila;
