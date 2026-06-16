// background.js
// Service Worker de la extensión GlassTest.

let activeProjectId = null;
let pendingTestStarted = null;

const BASE_PORT = 9999;
const RECONNECT_DELAY = 5000;
const EXTENSION_ID = chrome.runtime.id;

let socket = null;
let reconnecting = false;

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
    console.log('[GlassTest] SW despertó sin socket activo, reconectando...');
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
  console.log(`[GlassTest] Intentando conectar al servidor en ws://127.0.0.1:${port}`);

  socket = new WebSocket(`ws://127.0.0.1:${port}`);

  socket.onopen = () => {
    console.log('[GlassTest] WebSocket conectado con el backend en Rust.');
    reconnecting = false;
    socket.send(JSON.stringify({ type: 'HANDSHAKE', extensionId: EXTENSION_ID }));
  };

  socket.onmessage = (event) => {
    try {
      const rawMsg = JSON.parse(event.data);
      console.log("[GlassTest WebSocket] Mensaje recibido desde Rust:", rawMsg);

      const msgType = rawMsg.type || rawMsg.message_type;
      const payload = { ...rawMsg, ...(rawMsg.payload || {}) };

      switch (msgType) {
        case 'HANDSHAKE_ACK':
          if (payload.status === 'ok') {
            chrome.storage.session.set({ connected: true });
            console.log("[GlassTest] Handshake validado con éxito.");
          } else {
            console.error("[GlassTest] Handshake rechazado por Rust:", payload.reason);
          }
          break;

        case 'TEST_STARTED':
          console.log(`[TEST_STARTED] orquestadorPort existe? ${!!orchestratorPort}`);
          if (orchestratorPort) {
            console.log('[TEST_STARTED] Enviando mensaje al orquestador');
            orchestratorPort.postMessage({ type: 'TEST_STARTED', project_id: payload.project_id });
          } else {
            console.warn('[TEST_STARTED] orquestadorPort es null, guardando pendiente');
            pendingTestStarted = payload;
          }
          break;

        case 'EXECUTE_PHASE':
          currentTestPhase = payload.phase ?? currentTestPhase;
          globalTestStatus = 'RUNNING';
          currentPhasePayload = payload;

          console.log(`[GlassTest] Procesando Fase de IA #${currentTestPhase}. Status: ${payload.status}`);

          if (orchestratorPort) {
            orchestratorPort.postMessage({
              type: 'EXECUTE_PHASE',
              phase: currentTestPhase,
              thought: payload.thought || '',
              status: payload.status || 'CONTINUE',
              commands: payload.commands || []
            });
            console.log("[GlassTest] Fase enviada al TaskOrchestrator.");
          } else {
            console.warn("[GlassTest] EXECUTE_PHASE recibido pero el TaskOrchestrator no está conectado.");
          }
          break;

        case 'AUDIT_URL': {
          const urls = payload.urls || [];
          chrome.storage.session.set({ auditingUrls: urls });
          console.log('[GlassTest] URLs de auditoría guardadas:', urls);

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
          console.log(`[GlassTest] Proyecto activo en extensión: ${activeProjectId}`);
          break;

        case 'PONG':
          break;

        default:
          console.log("[GlassTest WebSocket] Tipo de mensaje no manejado:", msgType);
      }
    } catch (error) {
      console.error("[GlassTest WebSocket] Error procesando JSON de Rust:", error);
    }
  };

  socket.onclose = () => {
    console.log('[GlassTest] WebSocket cerrado. Reintentando conexión...');
    chrome.storage.session.set({ connected: false });
    reconnecting = false;
    socket = null;
    setTimeout(connectWebSocket, RECONNECT_DELAY);
  };

  socket.onerror = (err) => {
    console.error('[GlassTest] Error en WebSocket:', err);
    socket.close();
  };
}

function sendToWebSocket(msg) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  } else {
    console.error('[GlassTest] No se pudo enviar mensaje; WebSocket cerrado:', msg);
  }
}

// Función para enviar un mensaje al content script de la pestaña activa
async function sendToContentScript(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    console.log(`[GlassTest] Mensaje enviado al content script (tab ${tabId}):`, message);
  } catch (error) {
    console.error(`[GlassTest] Error enviando mensaje al content script (tab ${tabId}):`, error);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'task_orchestrator') {
    orchestratorPort = port;
    console.log('[GlassTest] Puerto de comunicación abierto con el TaskOrchestrator.');

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'READY_TO_START':
          globalTestStatus = 'RUNNING';
          currentTestPhase = 0;
          currentPhasePayload = null;
          console.log(`[GlassTest] Iniciando prueba. URL: ${msg.url}, Proyecto: ${activeProjectId ?? 'no definido'}`);
          sendToWebSocket({
            type: 'START_TEST',
            url: msg.url,
            project_id: activeProjectId ?? null,
          });
          break;

        case 'DOM_SNAPSHOT':
          console.log(`[GlassTest] Enviando DOM al backend — fase ${msg.phase}, elementos: ${msg.elements?.length ?? 0}`);
          console.log('[GlassTest] DOM snapshot:', JSON.stringify(msg.elements));
          sendToWebSocket({
            type: 'DOM_SNAPSHOT',
            payload: { phase: msg.phase, url: msg.url, elements: msg.elements }
          });
          break;

        case 'GET_CURRENT_STATE':
          console.log(`[GlassTest] Restaurando pestaña. Estado: ${globalTestStatus}, Fase: ${currentTestPhase}`);
          port.postMessage({
            type: 'RESTORE_STATE',
            globalStatus: globalTestStatus,
            currentPhase: currentTestPhase,
            activeProjectId: activeProjectId,
          });
          if (globalTestStatus === 'RUNNING' && currentPhasePayload) {
            console.log("[GlassTest] Re-inyectando comandos de la fase activa.");
            port.postMessage({
              type: 'EXECUTE_PHASE',
              phase: currentTestPhase,
              thought: currentPhasePayload.thought || '',
              status: currentPhasePayload.status || 'CONTINUE',
              commands: currentPhasePayload.commands || []
            });
          }
          if (pendingTestStarted) {
            console.log("[GlassTest] Reenviando TEST_STARTED pendiente al orquestador.");
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

        // Nuevo: recibir solicitud para mostrar modal de resultado
        case 'SHOW_RESULT_MODAL':
          console.log('[GlassTest] Recibido SHOW_RESULT_MODAL:', msg);
          if (currentTestTabId) {
            sendToContentScript(currentTestTabId, {
              type: 'SHOW_RESULT_MODAL',
              success: msg.success,
              message: msg.message
            });
          } else {
            console.warn('[GlassTest] No hay currentTestTabId para enviar el modal');
            // Intentar enviar a todas las pestañas con content script activo
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
      console.log('[GlassTest] Puerto con el TaskOrchestrator cerrado.');
      orchestratorPort = null;
      // Limpiar el tabId cuando se desconecta el orquestador
      currentTestTabId = null;
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CHECK_AUDIT_STATE' && sender.tab?.url) {
    chrome.storage.session.get('auditingUrls').then(({ auditingUrls = [] }) => {
      try {
        const hostname = new URL(sender.tab.url).hostname;
        const active = auditingUrls.some((u) => hostname.includes(u) || u.includes(hostname));
        sendResponse({ active });
      } catch (_) {
        sendResponse({ active: false });
      }
    });
    return true;
  }
  if (msg.type === 'GET_CONNECTION_STATE') {
    chrome.storage.session.get(['connected']).then((data) => {
      sendResponse({ connected: data.connected, status: globalTestStatus });
    });
    return true;
  }
  // Registrar el tabId del content script que se conecta
  if (msg.type === 'REGISTER_TAB' && sender.tab?.id) {
    currentTestTabId = sender.tab.id;
    console.log(`[GlassTest] Tab registrado para pruebas: ${currentTestTabId}`);
    sendResponse({ ok: true });
    return true;
  }
});

connectWebSocket();