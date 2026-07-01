// background.js
// Service Worker de la extensión SpectreQA.

// Flag de depuración: true solo en desarrollo, para ver logs técnicos detallados.
const IS_DEBUG = false;

let activeProjectId = null;
let pendingTestStarted = null;

const BASE_PORT = 9999;
const RECONNECT_DELAY = 5000;
const EXTENSION_ID = chrome.runtime.id;

let socket = null;
let reconnecting = false;
let currentPort = BASE_PORT; // guarda el puerto real descubierto

// Variables de persistencia global del Service Worker (Soportan recargas de página)
let globalTestStatus = 'IDLE';
let currentTestPhase = 0;
let orchestratorPort = null;
let currentPhasePayload = null;

// Guardar el tabId de la pestaña que está ejecutando la prueba actualmente
let currentTestTabId = null;

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepalive') return;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'PING' }));
  } else if (!reconnecting) {
    console.log('[SpectreQA] SW despertó sin socket activo, reconectando...');
    connectWebSocket();
  }
});

async function discoverPort() {
  try {
    const res = await fetch(`http://localhost:${BASE_PORT}/port`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return BASE_PORT;
    const data = await res.json();
    return data.port || BASE_PORT;
  } catch (e) {
    return BASE_PORT;
  }
}

async function connectWebSocket() {
  if (reconnecting) return;
  reconnecting = true;

  const port = await discoverPort();
  currentPort = port; // guardamos el puerto real
  if (IS_DEBUG) console.log(`[SpectreQA] Intentando conectar al servidor en ws://127.0.0.1:${port}`);

  socket = new WebSocket(`ws://127.0.0.1:${port}`);

  socket.onopen = () => {
    console.log('[SpectreQA] WebSocket conectado con el backend en Rust.');
    reconnecting = false;
    socket.send(JSON.stringify({ type: 'HANDSHAKE', extensionId: EXTENSION_ID }));
  };

  socket.onmessage = (event) => {
    try {
      const rawMsg = JSON.parse(event.data);
      const msgType = rawMsg.type || rawMsg.message_type;
      if (IS_DEBUG) console.log("[SpectreQA WebSocket] Mensaje recibido:", msgType);

      const payload = { ...rawMsg, ...(rawMsg.payload || {}) };

      switch (msgType) {
        case 'HANDSHAKE_ACK':
          if (payload.status === 'ok') {
            chrome.storage.session.set({ connected: true });
            console.log("[SpectreQA] Handshake validado con éxito.");
          } else {
            console.error("[SpectreQA] Handshake rechazado por Rust:", payload.reason);
          }
          break;

        case 'TEST_STARTED':
          if (IS_DEBUG) console.log(`[TEST_STARTED] orquestadorPort existe? ${!!orchestratorPort}`);
          if (orchestratorPort) {
            if (IS_DEBUG) console.log('[TEST_STARTED] Enviando mensaje al orquestador');
            orchestratorPort.postMessage({ type: 'TEST_STARTED', project_id: payload.project_id });
          } else {
            if (IS_DEBUG) console.warn('[TEST_STARTED] orquestadorPort es null, guardando pendiente');
            pendingTestStarted = payload;
          }
          break;

        case 'EXECUTE_PHASE':
          currentTestPhase = payload.phase ?? currentTestPhase;
          globalTestStatus = 'RUNNING';
          currentPhasePayload = payload;

          console.log(`[SpectreQA] Procesando Fase de IA #${currentTestPhase}. Status: ${payload.status}`);

          if (orchestratorPort) {
            orchestratorPort.postMessage({
              type: 'EXECUTE_PHASE',
              phase: currentTestPhase,
              thought: payload.thought || '',
              status: payload.status || 'CONTINUE',
              commands: payload.commands || []
            });
            if (IS_DEBUG) console.log("[SpectreQA] Fase enviada al TaskOrchestrator.");
          } else {
            console.warn("[SpectreQA] EXECUTE_PHASE recibido pero el TaskOrchestrator no está conectado.");
          }
          break;

        case 'AUDIT_URL': {
          const urls = payload.urls || [];
          chrome.storage.session.set({ auditingUrls: urls });
          if (IS_DEBUG) console.log('[SpectreQA] URLs de auditoría guardadas:', urls);

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
          activeProjectId = payload.project_id;
          chrome.storage.session.set({ activeProjectId: payload.project_id });
          if (IS_DEBUG) console.log(`[SpectreQA] Proyecto activo en extensión: ${activeProjectId}`);
          break;

        case 'PONG':
          break;

        default:
          console.log("[SpectreQA WebSocket] Tipo de mensaje no manejado:", msgType);
      }
    } catch (error) {
      console.error("[SpectreQA WebSocket] Error procesando JSON de Rust:", error);
    }
  };

  socket.onclose = () => {
    console.log('[SpectreQA] WebSocket cerrado. Reintentando conexión...');
    chrome.storage.session.set({ connected: false });
    reconnecting = false;
    socket = null;
    setTimeout(connectWebSocket, RECONNECT_DELAY);
  };

  socket.onerror = (err) => {
    console.error('[SpectreQA] Error en WebSocket:', err);
    socket.close();
  };
}

function sendToWebSocket(msg) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  } else {
    console.error('[SpectreQA] No se pudo enviar mensaje; WebSocket cerrado. Tipo:', msg.type);
  }
}

// Función para enviar un mensaje al content script de la pestaña activa
async function sendToContentScript(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    if (IS_DEBUG) console.log(`[SpectreQA] Mensaje enviado al content script (tab ${tabId}):`, message);
  } catch (error) {
    console.error(`[SpectreQA] Error enviando mensaje al content script (tab ${tabId}):`, error);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'task_orchestrator') {
    orchestratorPort = port;
    if (IS_DEBUG) console.log('[SpectreQA] Puerto de comunicación abierto con el TaskOrchestrator.');

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'READY_TO_START':
          globalTestStatus = 'RUNNING';
          currentTestPhase = 0;
          currentPhasePayload = null;
          console.log(`[SpectreQA] Iniciando prueba. URL: ${msg.url}, Proyecto: ${activeProjectId ?? 'no definido'}`);
          sendToWebSocket({
            type: 'START_TEST',
            url: msg.url,
            project_id: activeProjectId ?? null,
          });
          break;

        case 'DOM_SNAPSHOT':
          console.log(`[SpectreQA] Enviando DOM al backend — fase ${msg.phase}, elementos: ${msg.elements?.length ?? 0}`);
          sendToWebSocket({
            type: 'DOM_SNAPSHOT',
            payload: { phase: msg.phase, url: msg.url, elements: msg.elements }
          });
          break;

        case 'GET_CURRENT_STATE':
          console.log(`[SpectreQA] Restaurando pestaña. Estado: ${globalTestStatus}, Fase: ${currentTestPhase}`);
          port.postMessage({
            type: 'RESTORE_STATE',
            globalStatus: globalTestStatus,
            currentPhase: currentTestPhase,
            activeProjectId: activeProjectId,
          });
          if (globalTestStatus === 'RUNNING' && currentPhasePayload) {
            if (IS_DEBUG) console.log("[SpectreQA] Re-inyectando comandos de la fase activa.");
            port.postMessage({
              type: 'EXECUTE_PHASE',
              phase: currentTestPhase,
              thought: currentPhasePayload.thought || '',
              status: currentPhasePayload.status || 'CONTINUE',
              commands: currentPhasePayload.commands || []
            });
          }
          if (pendingTestStarted) {
            if (IS_DEBUG) console.log("[SpectreQA] Reenviando TEST_STARTED pendiente al orquestador.");
            port.postMessage({ type: 'TEST_STARTED', project_id: pendingTestStarted.project_id });
            pendingTestStarted = null;
          }
          break;

        case 'TEST_TERMINATED':
        case 'TEST_FINISHED_SUCCESS':
        case 'TEST_ERROR':
          globalTestStatus = 'IDLE';
          currentPhasePayload = null;
          sendToWebSocket({ type: 'TEST_STATUS_UPDATE', status: msg.type, phase: msg.phase });
          break;

        case 'SHOW_RESULT_MODAL':
          if (IS_DEBUG) console.log('[SpectreQA] Recibido SHOW_RESULT_MODAL:', msg);
          if (currentTestTabId) {
            sendToContentScript(currentTestTabId, {
              type: 'SHOW_RESULT_MODAL',
              success: msg.success,
              message: msg.message
            });
          } else {
            console.warn('[SpectreQA] No hay currentTestTabId para enviar el modal');
            chrome.tabs.query({}, (tabs) => {
              for (const tab of tabs) {
                sendToContentScript(tab.id, {
                  type: 'SHOW_RESULT_MODAL',
                  success: msg.success,
                  message: msg.message
                }).catch(() => {});
              }
            });
          }
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      console.log('[SpectreQA] Puerto con el TaskOrchestrator cerrado.');
      orchestratorPort = null;
      currentTestTabId = null;
    });
  }
});

// ========== LISTENER DE MENSAJES MODIFICADO ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // CHECK_AUDIT_STATE: ahora usa msg.url (desde popup) o sender.tab.url (desde content)
  if (msg.type === 'CHECK_AUDIT_STATE') {
    const targetUrl = msg.url || sender.tab?.url;
    if (!targetUrl) {
      sendResponse({ active: false });
      return true;
    }
    chrome.storage.session.get('auditingUrls').then(({ auditingUrls = [] }) => {
      try {
        const hostname = new URL(targetUrl).hostname;
        const active = auditingUrls.some((u) => hostname.includes(u) || u.includes(hostname));
        sendResponse({ active });
      } catch (_) {
        sendResponse({ active: false });
      }
    });
    return true;
  }

  // GET_CONNECTION_STATE: ahora incluye 'port'
  if (msg.type === 'GET_CONNECTION_STATE') {
    chrome.storage.session.get(['connected']).then((data) => {
      sendResponse({ 
        connected: data.connected, 
        status: globalTestStatus, 
        port: currentPort 
      });
    });
    return true;
  }

  // Registrar el tabId del content script que se conecta
  if (msg.type === 'REGISTER_TAB' && sender.tab?.id) {
    currentTestTabId = sender.tab.id;
    if (IS_DEBUG) console.log(`[SpectreQA] Tab registrado para pruebas: ${currentTestTabId}`);
    sendResponse({ ok: true });
    return true;
  }

  // Por si necesitas manejar otros mensajes...
  sendResponse({});
});

// ========== RE-INYECCIÓN EN NAVEGACIÓN (ya presente) ==========
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  try {
    const { auditingUrls = [] } = await chrome.storage.session.get('auditingUrls');
    const hostname = new URL(tab.url).hostname;
    const isAllowedUrl = auditingUrls.some((u) => hostname.includes(u) || u.includes(hostname));

    if (isAllowedUrl && globalTestStatus === 'RUNNING') {
      console.log(`[SpectreQA] Navegación detectada en test activo. Re-inyectando en: ${tab.url}`);
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['agent_engine.js', 'task_orchestrator.js', 'content_script.js']
      });
    }
  } catch (error) {
    console.error('[SpectreQA] Error crítico controlando la navegación:', error);
  }
});

// Iniciar la conexión WebSocket al arrancar el SW
connectWebSocket();