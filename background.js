/**
 * conectorDeComunicacion.js
 * 
 * Responsabilidad única: Ser el puente/comunicador entre el backend local en Rust
 * y los scripts inyectados en el navegador.
 * 
 * Maneja:
 * - Conexión WebSocket persistente con Rust (puerto dinámico).
 * - Persistencia del estado global en chrome.storage.session.
 * - Re-inyección de scripts tras navegaciones en pestañas auditadas.
 * - Enrutamiento de mensajes entre pestañas, orquestador y backend.
 */
class BackgroundService {
  // Configuración
  #isDebug = true;
  #basePort = 9999;
  #reconnectDelay = 5000;
  #extensionId = chrome.runtime.id;

  // Estado Privado de la Prueba
  #state = {
    activeProjectId: null,
    globalTestStatus: 'IDLE',
    currentTestPhase: 0,
    currentPhasePayload: null,
    currentTestTabId: null,
    visualHistory: [],
    testFinished: false
  };

  // Conexiones y Control Interno
  #socket = null;
  #reconnecting = false;
  #currentPort = 9999;
  #orchestratorPort = null;
  #pendingMessages = [];
  #pendingTestStarted = null;

  constructor() {
    this.#init();
  }

  // --- INICIALIZACIÓN ---

  async #init() {
    this.#log('Inicializando BackgroundService...');
    await this.#restoreState();
    this.#setupListeners();
    this.#setupAlarms();
    this.#connectWebSocket();
  }

  #log(...args) {
    if (this.#isDebug) console.log('[SpectreQA]', ...args);
  }

  #error(...args) {
    console.error('[SpectreQA]', ...args);
  }

  // --- PERSISTENCIA Y ESTADO ---

  async #persistState() {
    try {
      await chrome.storage.session.set({
        activeProjectId: this.#state.activeProjectId,
        globalTestStatus: this.#state.globalTestStatus,
        currentTestPhase: this.#state.currentTestPhase,
        currentPhasePayload: this.#state.currentPhasePayload,
        currentTestTabId: this.#state.currentTestTabId,
        visualHistory: this.#state.visualHistory,
        testFinished: this.#state.testFinished
      });
      this.#log('Estado persistido en storage.session');
    } catch (err) {
      this.#error('Error persistiendo estado:', err);
    }
  }

  async #restoreState() {
    try {
      const data = await chrome.storage.session.get([
        'activeProjectId',
        'globalTestStatus',
        'currentTestPhase',
        'currentPhasePayload',
        'currentTestTabId',
        'visualHistory',
        'testFinished'
      ]);

      this.#state.activeProjectId = data.activeProjectId || null;
      this.#state.globalTestStatus = data.globalTestStatus || 'IDLE';
      this.#state.currentTestPhase = data.currentTestPhase || 0;
      this.#state.currentPhasePayload = data.currentPhasePayload || null;
      this.#state.currentTestTabId = data.currentTestTabId || null;
      this.#state.visualHistory = data.visualHistory || [];
      this.#state.testFinished = data.testFinished || false;

      this.#log('Estado restaurado:', { ...this.#state });

      if (this.#state.globalTestStatus === 'RUNNING' && !this.#orchestratorPort) {
        console.warn('[SpectreQA] Prueba en ejecución pero sin puerto. Notificando a Rust.');
        this.#sendToWebSocket({
          type: 'TEST_STATUS_UPDATE',
          status: 'ORCHESTRATOR_LOST',
          phase: this.#state.currentTestPhase
        });
      }
    } catch (err) {
      this.#error('Error restaurando estado:', err);
    }
  }

  #setGlobalTestStatus(value) {
    this.#state.globalTestStatus = value;
    if (['IDLE', 'SUCCESS', 'ERROR', 'TERMINATED'].includes(value)) {
      this.#state.testFinished = true;
    } else if (['RUNNING', 'WAITING'].includes(value)) {
      this.#state.testFinished = false;
    }
    this.#persistState();
  }

  // --- HISTORIAL VISUAL ---

  #addToVisualHistory(type, text) {
    this.#state.visualHistory.push({ type, text });
    if (this.#state.visualHistory.length > 10) {
      this.#state.visualHistory.shift();
    }
    this.#persistState();
    this.#broadcastToActiveTabs({ type: 'UPDATE_VISUAL_UI', history: this.#state.visualHistory });
    this.#log('Historial visual actualizado:', this.#state.visualHistory.length, 'elementos');
  }

  #clearVisualHistory() {
    this.#state.visualHistory = [];
    this.#persistState();
    this.#broadcastToActiveTabs({ type: 'UPDATE_VISUAL_UI', history: this.#state.visualHistory });
    this.#log('Historial visual limpiado');
  }

  #broadcastToActiveTabs(message) {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    });
  }

  // --- WEBSOCKET Y RED ---

  async #discoverPort() {
    try {
      const res = await fetch(`http://localhost:${this.#basePort}/port`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return this.#basePort;
      const data = await res.json();
      return data.port || this.#basePort;
    } catch (e) {
      return this.#basePort;
    }
  }

  #sendToWebSocket(msg) {
    const { globalTestStatus, testFinished } = this.#state;

    // Bloquear DOM_SNAPSHOT si la prueba ya terminó
    if (msg.type === 'DOM_SNAPSHOT' && (globalTestStatus === 'SUCCESS' || globalTestStatus === 'ERROR' || testFinished)) {
      this.#log('DOM_SNAPSHOT bloqueado: prueba ya finalizada');
      return false;
    }

    // Bloquear mensajes generales si la prueba terminó (salvo handshake / pings)
    if (testFinished && !['PING', 'PONG', 'HANDSHAKE'].includes(msg.type)) {
      this.#log('Mensaje bloqueado: prueba ya finalizada', msg.type);
      return false;
    }

    if (this.#socket?.readyState === WebSocket.OPEN) {
      try {
        this.#socket.send(JSON.stringify(msg));
        this.#log('Mensaje enviado al WebSocket:', msg.type);
        return true;
      } catch (err) {
        this.#error('Error enviando mensaje:', err);
        this.#pendingMessages.push(msg);
        return false;
      }
    } else {
      this.#log('WebSocket no disponible, encolando mensaje:', msg.type);
      this.#pendingMessages.push(msg);
      if (!this.#reconnecting) {
        this.#connectWebSocket();
      }
      return false;
    }
  }

  async #connectWebSocket() {
    if (this.#reconnecting) return;
    this.#reconnecting = true;

    this.#currentPort = await this.#discoverPort();
    this.#log('Intentando conectar a ws://127.0.0.1:', this.#currentPort);

    try {
      this.#socket = new WebSocket(`ws://127.0.0.1:${this.#currentPort}`);

      this.#socket.onopen = () => {
        console.log('[SpectreQA] WebSocket conectado con el backend en Rust.');
        this.#reconnecting = false;

        this.#socket.send(JSON.stringify({ type: 'HANDSHAKE', extensionId: this.#extensionId }));

        if (this.#pendingMessages.length > 0) {
          this.#log('Enviando', this.#pendingMessages.length, 'mensajes pendientes...');
          const messages = [...this.#pendingMessages];
          this.#pendingMessages = [];
          messages.forEach((msg) => this.#sendToWebSocket(msg));
        }

        if (this.#state.globalTestStatus === 'RUNNING' && !this.#orchestratorPort) {
          this.#sendToWebSocket({
            type: 'TEST_STATUS_UPDATE',
            status: 'ORCHESTRATOR_LOST',
            phase: this.#state.currentTestPhase
          });
        }
      };

      this.#socket.onmessage = (event) => this.#handleSocketMessage(event);

      this.#socket.onclose = () => {
        console.log('[SpectreQA] WebSocket cerrado. Reintentando...');
        chrome.storage.session.set({ connected: false });
        this.#reconnecting = false;
        this.#socket = null;
        setTimeout(() => this.#connectWebSocket(), this.#reconnectDelay);
      };

      this.#socket.onerror = (err) => {
        this.#error('Error en WebSocket:', err);
        this.#socket?.close();
      };
    } catch (err) {
      this.#error('Error creando WebSocket:', err);
      this.#reconnecting = false;
      this.#socket = null;
      setTimeout(() => this.#connectWebSocket(), this.#reconnectDelay);
    }
  }

  #handleSocketMessage(event) {
    try {
      const rawMsg = JSON.parse(event.data);
      const msgType = rawMsg.type || rawMsg.message_type;
      this.#log('[WebSocket] Mensaje recibido:', msgType);

      const payload = { ...rawMsg, ...(rawMsg.payload || {}) };

      switch (msgType) {
        case 'HANDSHAKE_ACK':
          if (payload.status === 'ok') {
            chrome.storage.session.set({ connected: true });
            console.log('[SpectreQA] Handshake validado.');
          } else {
            this.#error('Handshake rechazado:', payload.reason);
          }
          break;

        case 'TEST_STARTED':
          this.#state.testFinished = false;
          this.#setGlobalTestStatus('RUNNING');
          this.#clearVisualHistory();

          if (this.#orchestratorPort) {
            this.#orchestratorPort.postMessage({ type: 'TEST_STARTED', project_id: payload.project_id });
          } else {
            this.#pendingTestStarted = payload;
          }
          break;

        case 'EXECUTE_PHASE':
          if (this.#state.globalTestStatus === 'SUCCESS' || this.#state.globalTestStatus === 'ERROR' || this.#state.testFinished) {
            console.warn('[SpectreQA] EXECUTE_PHASE ignorado: prueba finalizada');
            break;
          }

          this.#state.currentTestPhase = payload.phase ?? this.#state.currentTestPhase;
          this.#setGlobalTestStatus('RUNNING');
          this.#state.currentPhasePayload = payload;
          this.#persistState();

          console.log('[SpectreQA] Procesando Fase de IA #', this.#state.currentTestPhase, '. Status:', payload.status);

          if (this.#orchestratorPort) {
            this.#orchestratorPort.postMessage({
              type: 'EXECUTE_PHASE',
              phase: this.#state.currentTestPhase,
              thought: payload.thought || '',
              status: payload.status || 'CONTINUE',
              commands: payload.commands || []
            });
          } else {
            console.warn('[SpectreQA] EXECUTE_PHASE recibido pero TaskOrchestrator no está conectado.');
          }
          break;

        case 'AUDIT_URL': {
          const urls = payload.urls || [];
          chrome.storage.session.set({ auditingUrls: urls });

          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (!tab.url) continue;
              try {
                const hostname = new URL(tab.url).hostname;
                if (urls.some((u) => hostname.includes(u) || u.includes(hostname))) {
                  chrome.tabs.sendMessage(tab.id, { type: 'AUDIT_STATE', active: true }).catch(() => {});
                }
              } catch (_) {}
            }
          });
          break;
        }

        case 'SET_ACTIVE_PROJECT':
          this.#state.activeProjectId = payload.project_id;
          this.#persistState();
          chrome.storage.session.set({ activeProjectId: payload.project_id });
          break;

        case 'PONG':
          break;
      }
    } catch (err) {
      this.#error('Error procesando JSON de Rust:', err);
    }
  }

  // --- LISTENERS Y MANEJADORES DE CHROME ---

  #setupListeners() {
    // Conexión del Orquestador
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === 'task_orchestrator') {
        this.#orchestratorPort = port;
        this.#log('Puerto abierto con TaskOrchestrator.');

        port.onMessage.addListener((msg) => this.#handleOrchestratorMessage(msg));

        port.onDisconnect.addListener(() => {
          console.log('[SpectreQA] Puerto con TaskOrchestrator cerrado.');
          this.#orchestratorPort = null;

          if (this.#state.globalTestStatus === 'RUNNING' && !this.#state.testFinished) {
            this.#sendToWebSocket({
              type: 'TEST_STATUS_UPDATE',
              status: 'ORCHESTRATOR_LOST',
              phase: this.#state.currentTestPhase
            });
          }
        });
      }
    });

    // Mensajes generales (Popup, Content Scripts)
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      this.#handleRuntimeMessage(msg, sender, sendResponse);
      return true;
    });

    // Navegación y Re-inyección
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      this.#handleTabUpdate(tabId, changeInfo, tab);
    });

    // Suspensión del SW
    chrome.runtime.onSuspend.addListener(() => {
      console.log('[SpectreQA] SW suspendido. Persistiendo...');
      this.#persistState();
    });
  }

  #handleOrchestratorMessage(msg) {
    switch (msg.type) {
      case 'READY_TO_START':
        this.#state.testFinished = false;
        this.#setGlobalTestStatus('RUNNING');
        this.#state.currentTestPhase = 0;
        this.#state.currentPhasePayload = null;
        this.#clearVisualHistory();
        this.#sendToWebSocket({
          type: 'START_TEST',
          url: msg.url,
          project_id: this.#state.activeProjectId ?? null,
        });
        break;

      case 'DOM_SNAPSHOT':
        if (this.#state.globalTestStatus === 'SUCCESS' || this.#state.globalTestStatus === 'ERROR' || this.#state.testFinished) {
          break;
        }
        this.#sendToWebSocket({
          type: 'DOM_SNAPSHOT',
          payload: { 
            phase: msg.phase, 
            url: msg.url, 
            elements: msg.elements,
            lifecycleStatus: msg.lifecycleStatus || 'READY'
          }
        });
        break;

      case 'CLIENT_CONSOLE_ERROR':
        this.#sendToWebSocket({
          type: 'CLIENT_CONSOLE_ERROR',
          payload: { phase: msg.phase, command: msg.command, errors: msg.errors }
        });
        break;

      case 'GET_CURRENT_STATE':
        this.#orchestratorPort?.postMessage({
          type: 'RESTORE_STATE',
          globalStatus: this.#state.globalTestStatus,
          currentPhase: this.#state.currentTestPhase,
          activeProjectId: this.#state.activeProjectId,
        });

        if (this.#state.globalTestStatus === 'RUNNING' && this.#state.currentPhasePayload) {
          this.#orchestratorPort?.postMessage({
            type: 'EXECUTE_PHASE',
            phase: this.#state.currentTestPhase,
            thought: this.#state.currentPhasePayload.thought || '',
            status: this.#state.currentPhasePayload.status || 'CONTINUE',
            commands: this.#state.currentPhasePayload.commands || []
          });
        }

        if (this.#pendingTestStarted) {
          this.#orchestratorPort?.postMessage({ type: 'TEST_STARTED', project_id: this.#pendingTestStarted.project_id });
          this.#pendingTestStarted = null;
        }
        break;

      case 'TEST_STATUS_UPDATE':
        if (msg.status === 'TEST_SUCCESS' || msg.status === 'TEST_ERROR') {
          // Mandar PRIMERO: si testFinished se pone en true antes, el propio
          // guard de #sendToWebSocket bloquea este mismo mensaje.
          this.#sendToWebSocket({
            type: 'TEST_STATUS_UPDATE',
            status: msg.status,
            phase: msg.phase,
            message: msg.message
          });
          this.#state.testFinished = true;
          this.#setGlobalTestStatus('IDLE');
          this.#state.currentPhasePayload = null;
        } else if (msg.status === 'WAITING') {
          this.#sendToWebSocket({
            type: 'TEST_STATUS_UPDATE',
            status: 'WAITING',
            phase: msg.phase,
            message: msg.message,
            flag: msg.flag || 'ASYNC_WAIT'
          });
        } else if (msg.status === 'ORCHESTRATOR_LOST') {
          // NOTA: esta rama nunca se dispara en la práctica — TaskOrchestrator.js
          // no manda ORCHESTRATOR_LOST por este canal (lo maneja background.js
          // directamente en onDisconnect/onopen/restauración de estado, mandando
          // a Rust sin pasar por acá). Se deja el relay genérico por si algún
          // día algo la usa, pero ya no arma ningún timeout propio: Rust tiene
          // su propio watchdog de navegación (is_navigating / navigation_timeout_secs
          // en session.rs) para decidir cuándo una navegación se abandonó de
          // verdad. Tener dos relojes independientes para lo mismo era la causa
          // del bloqueo: este timeout de 5s podía dispararse aunque la
          // reinyección ya hubiera funcionado, marcando testFinished=true y
          // bloqueando todo lo que viniera después.
          this.#sendToWebSocket({
            type: 'TEST_STATUS_UPDATE',
            status: 'RECOVERING',
            phase: msg.phase,
            message: 'Esperando recuperación de navegación'
          });
        } else {
          this.#sendToWebSocket({ 
            type: 'TEST_STATUS_UPDATE', 
            status: msg.status, 
            phase: msg.phase,
            message: msg.message,
            flag: msg.flag
          });
        }
        break;

      case 'TEST_TERMINATED':
      case 'TEST_FINISHED_SUCCESS':
      case 'TEST_ERROR':
        // Mismo orden que arriba: mandar antes de marcar testFinished.
        this.#sendToWebSocket({ type: 'TEST_STATUS_UPDATE', status: msg.type, phase: msg.phase });
        this.#state.testFinished = true;
        this.#setGlobalTestStatus('IDLE');
        this.#state.currentPhasePayload = null;
        break;

      case 'SHOW_RESULT_MODAL':
        if (this.#state.currentTestTabId) {
          chrome.tabs.sendMessage(this.#state.currentTestTabId, {
            type: 'SHOW_RESULT_MODAL',
            success: msg.success,
            message: msg.message
          }).catch(() => {});
        } else {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
              chrome.tabs.sendMessage(tabs[0].id, {
                type: 'SHOW_RESULT_MODAL',
                success: msg.success,
                message: msg.message
              }).catch(() => {});
            }
          });
        }
        break;

      case 'ADD_TO_VISUAL_HISTORY':
        this.#addToVisualHistory(msg.payload.type, msg.payload.text);
        break;

      case 'CLEAR_VISUAL_HISTORY':
        this.#clearVisualHistory();
        break;

      case 'NAVIGATION_DETECTED':
        this.#sendToWebSocket({
          type: 'NAVIGATION_DETECTED',
          data: {
            from: msg.data.from,
            phase: msg.data.phase,
            timestamp: msg.data.timestamp
          }
        });
        break;
    }
  }

  #handleRuntimeMessage(msg, sender, sendResponse) {
    if (msg.type === 'CHECK_AUDIT_STATE') {
      const targetUrl = msg.url || sender.tab?.url;
      if (!targetUrl) return sendResponse({ active: false });

      chrome.storage.session.get('auditingUrls').then(({ auditingUrls = [] }) => {
        try {
          const hostname = new URL(targetUrl).hostname;
          const active = auditingUrls.some((u) => hostname.includes(u) || u.includes(hostname));
          sendResponse({ active });
        } catch (_) {
          sendResponse({ active: false });
        }
      });
      return;
    }

    if (msg.type === 'GET_CONNECTION_STATE') {
      chrome.storage.session.get(['connected']).then((data) => {
        sendResponse({ 
          connected: data.connected, 
          status: this.#state.globalTestStatus, 
          port: this.#currentPort,
          projectId: this.#state.activeProjectId,
          testFinished: this.#state.testFinished
        });
      });
      return;
    }

    if (msg.type === 'REGISTER_TAB' && sender.tab?.id) {
      this.#state.currentTestTabId = sender.tab.id;
      this.#persistState();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'GET_VISUAL_HISTORY') {
      sendResponse({ history: this.#state.visualHistory });
      return;
    }

    if (msg.type === 'NAVIGATION_DETECTED') {
      this.#sendToWebSocket({
        type: 'NAVIGATION_DETECTED',
        data: {
          from: msg.data.from,
          phase: msg.data.phase,
          timestamp: msg.data.timestamp
        }
      });
      sendResponse({ ok: true });
      return;
    }

    sendResponse({});
  }

  async #handleTabUpdate(tabId, changeInfo, tab) {
    if (changeInfo.status !== 'complete' || !tab.url) return;

    try {
      const { auditingUrls = [] } = await chrome.storage.session.get('auditingUrls');
      const hostname = new URL(tab.url).hostname;
      const isAllowedUrl = auditingUrls.some((u) => hostname.includes(u) || u.includes(hostname));

      if (isAllowedUrl && this.#state.globalTestStatus === 'RUNNING' && !this.#state.testFinished) {
        this.#log('Navegación detectada en test activo. Re-inyectando en:', tab.url);
        
        this.#state.currentTestTabId = tabId;
        this.#persistState();

        // FIX: cicloDeVida.js debe ir primero, ver nota equivalente en popup.js
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['cicloDeVida.js', 'agent_engine.js', 'task_orchestrator.js', 'content_script.js']
        }).catch((err) => {
          this.#error('Error inyectando scripts:', err);
        });

        // FIX: antes solo se mandaba UPDATE_VISUAL_UI. Nada le avisaba al
        // content script recién inyectado que debía llamar a connect() —
        // #init() no puede deducirlo solo, porque LifeCicle siempre nace en
        // IDLE en un documento nuevo, sin importar que el test siga activo
        // en Rust. Reusamos AUDIT_STATE, el mismo mensaje que ya dispara
        // activateAudit() + orchestrator.connect() cuando el popup activa
        // la auditoría manualmente.
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { type: 'AUDIT_STATE', active: true }).catch(() => {});
          chrome.tabs.sendMessage(tabId, {
            type: 'UPDATE_VISUAL_UI',
            history: this.#state.visualHistory
          }).catch(() => {});
        }, 500);
      }
    } catch (err) {
      this.#error('Error crítico controlando navegación:', err);
    }
  }

  // --- ALARMAS Y KEEPALIVE ---

  #setupAlarms() {
    chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== 'keepalive') return;
      if (this.#socket?.readyState === WebSocket.OPEN) {
        this.#socket.send(JSON.stringify({ type: 'PING' }));
      } else if (!this.#reconnecting) {
        this.#log('SW despertó sin socket activo, reconectando...');
        this.#connectWebSocket();
      }
    });
  }
}

// Instanciación automática al cargar el Service Worker
new BackgroundService();