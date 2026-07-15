// background.js
// Service Worker de la extensión SpectreQA.
// Incluye soporte para estado WAITING y recuperación por navegación.

const IS_DEBUG = true;

const BASE_PORT = 9999;
const RECONNECT_DELAY = 5000;
const EXTENSION_ID = chrome.runtime.id;

let activeProjectId = null;
let globalTestStatus = 'IDLE';
let currentTestPhase = 0;
let currentPhasePayload = null;
let currentTestTabId = null;
let pendingTestStarted = null;

let visualHistory = [];

let socket = null;
let reconnecting = false;
let currentPort = BASE_PORT;
let orchestratorPort = null;

let pendingMessages = [];
let _recoveryTimeouts = {};

// NUEVA VARIABLE PARA BLOQUEAR MENSAJES POST-FINALIZACION
let testFinished = false;

/**
 * FUNCIONES DE PERSISTENCIA DE ESTADO
 */

async function persistState() {
  try {
    await chrome.storage.session.set({
      activeProjectId: activeProjectId,
      globalTestStatus: globalTestStatus,
      currentTestPhase: currentTestPhase,
      currentPhasePayload: currentPhasePayload,
      currentTestTabId: currentTestTabId,
      visualHistory: visualHistory,
      testFinished: testFinished
    });
    if (IS_DEBUG) console.log('[SpectreQA] Estado persistido en storage.session');
  } catch (error) {
    console.error('[SpectreQA] Error persistiendo estado:', error);
  }
}

async function restoreState() {
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
    
    activeProjectId = data.activeProjectId || null;
    globalTestStatus = data.globalTestStatus || 'IDLE';
    currentTestPhase = data.currentTestPhase || 0;
    currentPhasePayload = data.currentPhasePayload || null;
    currentTestTabId = data.currentTestTabId || null;
    visualHistory = data.visualHistory || [];
    testFinished = data.testFinished || false;
    
    if (IS_DEBUG) {
      console.log('[SpectreQA] Estado restaurado:', {
        activeProjectId,
        globalTestStatus,
        currentTestPhase,
        hasPhasePayload: !!currentPhasePayload,
        currentTestTabId,
        visualHistoryLength: visualHistory.length,
        testFinished
      });
    }
    
    if (globalTestStatus === 'RUNNING' && !orchestratorPort) {
      console.warn('[SpectreQA] Prueba en ejecución pero sin puerto. Notificando a Rust.');
      sendToWebSocket({
        type: 'TEST_STATUS_UPDATE',
        status: 'ORCHESTRATOR_LOST',
        phase: currentTestPhase
      });
    }
    
    return data;
  } catch (error) {
    console.error('[SpectreQA] Error restaurando estado:', error);
    return {};
  }
}

/**
 * FUNCIONES DE ACTUALIZACIÓN DE ESTADO (con persistencia)
 */

function setActiveProjectId(value) {
  activeProjectId = value;
  persistState();
}

function setGlobalTestStatus(value) {
  globalTestStatus = value;
  if (value === 'IDLE' || value === 'SUCCESS' || value === 'ERROR') {
    testFinished = true;
  } else if (value === 'RUNNING') {
    testFinished = false;
  }
  persistState();
}

function setCurrentTestPhase(value) {
  currentTestPhase = value;
  persistState();
}

function setCurrentPhasePayload(value) {
  currentPhasePayload = value;
  persistState();
}

function setCurrentTestTabId(value) {
  currentTestTabId = value;
  persistState();
}

/** 
 * Añade un elemento al historial visual manteniendo un máximo de 10 (FIFO).
 * Si se supera, se elimina el más antiguo.
 * Luego difunde el historial a todas las pestañas activas.
 */
function addToVisualHistory(type, text) {
  visualHistory.push({ type, text });
  if (visualHistory.length > 10) {   // <-- Límite aumentado a 10
    visualHistory.shift();
  }
  persistState();
  
  broadcastToActiveTabs({ type: 'UPDATE_VISUAL_UI', history: visualHistory });
  
  if (IS_DEBUG) console.log('[SpectreQA] Historial visual actualizado:', visualHistory.length, 'elementos');
}

function clearVisualHistory() {
  visualHistory = [];
  persistState();
  broadcastToActiveTabs({ type: 'UPDATE_VISUAL_UI', history: visualHistory });
  if (IS_DEBUG) console.log('[SpectreQA] Historial visual limpiado');
}

function broadcastToActiveTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

/**
 * FUNCIONES DE WEBSOCKET
 */

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

function sendToWebSocket(msg) {
  // BLOQUEAR DOM_SNAPSHOT SI LA PRUEBA YA TERMINO
  if (msg.type === 'DOM_SNAPSHOT' && (globalTestStatus === 'SUCCESS' || globalTestStatus === 'ERROR' || testFinished)) {
    if (IS_DEBUG) console.log('[SpectreQA] DOM_SNAPSHOT bloqueado: prueba ya finalizada');
    return false;
  }

  // BLOQUEAR CUALQUIER MENSAJE SI LA PRUEBA YA TERMINO (excepto PING/PONG)
  if (testFinished && msg.type !== 'PING' && msg.type !== 'PONG' && msg.type !== 'HANDSHAKE') {
    if (IS_DEBUG) console.log('[SpectreQA] Mensaje bloqueado: prueba ya finalizada', msg.type);
    return false;
  }

  if (socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(msg));
      if (IS_DEBUG) console.log('[SpectreQA] Mensaje enviado al WebSocket:', msg.type);
      return true;
    } catch (error) {
      console.error('[SpectreQA] Error enviando mensaje:', error);
      pendingMessages.push(msg);
      return false;
    }
  } else {
    if (IS_DEBUG) console.log('[SpectreQA] WebSocket no disponible, encolando mensaje:', msg.type);
    pendingMessages.push(msg);
    if (!reconnecting) {
      console.log('[SpectreQA] Intentando reconectar WebSocket para enviar mensaje pendiente...');
      connectWebSocket();
    }
    return false;
  }
}

async function connectWebSocket() {
  if (reconnecting) return;
  reconnecting = true;

  const port = await discoverPort();
  currentPort = port;
  if (IS_DEBUG) console.log('[SpectreQA] Intentando conectar al servidor en ws://127.0.0.1:', port);

  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);

    socket.onopen = () => {
      console.log('[SpectreQA] WebSocket conectado con el backend en Rust.');
      reconnecting = false;
      
      socket.send(JSON.stringify({ type: 'HANDSHAKE', extensionId: EXTENSION_ID }));
      
      if (pendingMessages.length > 0) {
        console.log('[SpectreQA] Enviando', pendingMessages.length, 'mensajes pendientes...');
        const messagesToSend = [...pendingMessages];
        pendingMessages = [];
        for (const msg of messagesToSend) {
          try {
            socket.send(JSON.stringify(msg));
          } catch (error) {
            console.error('[SpectreQA] Error enviando mensaje pendiente:', error);
            pendingMessages.push(msg);
          }
        }
      }
      
      if (globalTestStatus === 'RUNNING' && !orchestratorPort) {
        console.log('[SpectreQA] Notificando a Rust que hay prueba en ejecución sin puerto');
        sendToWebSocket({
          type: 'TEST_STATUS_UPDATE',
          status: 'ORCHESTRATOR_LOST',
          phase: currentTestPhase
        });
      }
    };

    socket.onmessage = (event) => {
      try {
        const rawMsg = JSON.parse(event.data);
        const msgType = rawMsg.type || rawMsg.message_type;
        if (IS_DEBUG) console.log('[SpectreQA WebSocket] Mensaje recibido:', msgType);

        const payload = { ...rawMsg, ...(rawMsg.payload || {}) };

        switch (msgType) {
          case 'HANDSHAKE_ACK':
            if (payload.status === 'ok') {
              chrome.storage.session.set({ connected: true });
              console.log('[SpectreQA] Handshake validado con éxito.');
            } else {
              console.error('[SpectreQA] Handshake rechazado por Rust:', payload.reason);
            }
            break;

          case 'TEST_STARTED':
            if (IS_DEBUG) console.log('[TEST_STARTED] orquestadorPort existe?', !!orchestratorPort);
            testFinished = false;
            setGlobalTestStatus('RUNNING');
            
            clearVisualHistory();
            
            if (orchestratorPort) {
              if (IS_DEBUG) console.log('[TEST_STARTED] Enviando mensaje al orquestador');
              orchestratorPort.postMessage({ type: 'TEST_STARTED', project_id: payload.project_id });
            } else {
              if (IS_DEBUG) console.warn('[TEST_STARTED] orquestadorPort es null, guardando pendiente');
              pendingTestStarted = payload;
            }
            break;

          case 'EXECUTE_PHASE':
            // IGNORAR FASES SI LA PRUEBA YA TERMINO
            if (globalTestStatus === 'SUCCESS' || globalTestStatus === 'ERROR' || testFinished) {
              if (IS_DEBUG) console.warn('[SpectreQA] EXECUTE_PHASE ignorado: prueba ya finalizada');
              break;
            }
            
            setCurrentTestPhase(payload.phase ?? currentTestPhase);
            setGlobalTestStatus('RUNNING');
            setCurrentPhasePayload(payload);

            console.log('[SpectreQA] Procesando Fase de IA #', currentTestPhase, '. Status:', payload.status);

            if (orchestratorPort) {
              orchestratorPort.postMessage({
                type: 'EXECUTE_PHASE',
                phase: currentTestPhase,
                thought: payload.thought || '',
                status: payload.status || 'CONTINUE',
                commands: payload.commands || []
              });
              if (IS_DEBUG) console.log('[SpectreQA] Fase enviada al TaskOrchestrator.');
            } else {
              console.warn('[SpectreQA] EXECUTE_PHASE recibido pero el TaskOrchestrator no está conectado.');
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
            setActiveProjectId(payload.project_id);
            chrome.storage.session.set({ activeProjectId: payload.project_id });
            if (IS_DEBUG) console.log('[SpectreQA] Proyecto activo en extensión:', activeProjectId);
            break;

          case 'PONG':
            break;

          default:
            console.log('[SpectreQA WebSocket] Tipo de mensaje no manejado:', msgType);
        }
      } catch (error) {
        console.error('[SpectreQA WebSocket] Error procesando JSON de Rust:', error);
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
  } catch (error) {
    console.error('[SpectreQA] Error creando WebSocket:', error);
    reconnecting = false;
    socket = null;
    setTimeout(connectWebSocket, RECONNECT_DELAY);
  }
}

/**
 * FUNCIONES DE CONTENT SCRIPT
 */

async function sendToContentScript(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    if (IS_DEBUG) console.log('[SpectreQA] Mensaje enviado al content script (tab', tabId, '):', message);
    return true;
  } catch (error) {
    console.error('[SpectreQA] Error enviando mensaje al content script (tab', tabId, '):', error);
    return false;
  }
}

/**
 * MANEJADOR DE CONEXIONES DEL ORQUESTADOR
 */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'task_orchestrator') {
    orchestratorPort = port;
    if (IS_DEBUG) console.log('[SpectreQA] Puerto de comunicación abierto con el TaskOrchestrator.');

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'READY_TO_START':
          testFinished = false;
          setGlobalTestStatus('RUNNING');
          setCurrentTestPhase(0);
          setCurrentPhasePayload(null);
          clearVisualHistory();
          console.log('[SpectreQA] Iniciando prueba. URL:', msg.url, 'Proyecto:', activeProjectId ?? 'no definido');
          sendToWebSocket({
            type: 'START_TEST',
            url: msg.url,
            project_id: activeProjectId ?? null,
          });
          break;

        case 'DOM_SNAPSHOT':
          // BLOQUEAR ENVIO DE SNAPSHOT SI LA PRUEBA YA TERMINO
          if (globalTestStatus === 'SUCCESS' || globalTestStatus === 'ERROR' || testFinished) {
            if (IS_DEBUG) console.log('[SpectreQA] DOM_SNAPSHOT bloqueado: prueba ya finalizada');
            break;
          }
          console.log('[SpectreQA] Enviando DOM al backend - fase', msg.phase, 'elementos:', msg.elements?.length ?? 0);
          sendToWebSocket({
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
          sendToWebSocket({
            type: 'CLIENT_CONSOLE_ERROR',
            payload: { phase: msg.phase, command: msg.command, errors: msg.errors }
          });
          break;

        case 'GET_CURRENT_STATE':
          console.log('[SpectreQA] Restaurando pestaña. Estado:', globalTestStatus, 'Fase:', currentTestPhase);
          port.postMessage({
            type: 'RESTORE_STATE',
            globalStatus: globalTestStatus,
            currentPhase: currentTestPhase,
            activeProjectId: activeProjectId,
          });
          if (globalTestStatus === 'RUNNING' && currentPhasePayload) {
            if (IS_DEBUG) console.log('[SpectreQA] Re-inyectando comandos de la fase activa.');
            port.postMessage({
              type: 'EXECUTE_PHASE',
              phase: currentTestPhase,
              thought: currentPhasePayload.thought || '',
              status: currentPhasePayload.status || 'CONTINUE',
              commands: currentPhasePayload.commands || []
            });
          }
          if (pendingTestStarted) {
            if (IS_DEBUG) console.log('[SpectreQA] Reenviando TEST_STARTED pendiente al orquestador.');
            port.postMessage({ type: 'TEST_STARTED', project_id: pendingTestStarted.project_id });
            pendingTestStarted = null;
          }
          break;

        case 'TEST_STATUS_UPDATE':
          if (msg.status === 'TEST_SUCCESS') {
            console.log('[SpectreQA] Prueba exitosa reportada por el orquestador');
            testFinished = true;
            setGlobalTestStatus('IDLE');
            setCurrentPhasePayload(null);
            if (_recoveryTimeouts[msg.phase]) {
              clearTimeout(_recoveryTimeouts[msg.phase]);
              delete _recoveryTimeouts[msg.phase];
            }
            sendToWebSocket({ 
              type: 'TEST_STATUS_UPDATE', 
              status: 'TEST_SUCCESS', 
              phase: msg.phase 
            });
          } else if (msg.status === 'TEST_ERROR') {
            console.log('[SpectreQA] Prueba con error reportada por el orquestador');
            testFinished = true;
            setGlobalTestStatus('IDLE');
            setCurrentPhasePayload(null);
            if (_recoveryTimeouts[msg.phase]) {
              clearTimeout(_recoveryTimeouts[msg.phase]);
              delete _recoveryTimeouts[msg.phase];
            }
            sendToWebSocket({ 
              type: 'TEST_STATUS_UPDATE', 
              status: 'TEST_ERROR', 
              phase: msg.phase,
              message: msg.message || 'Error en la prueba'
            });
          } else if (msg.status === 'WAITING') {
            console.log('[SpectreQA] Prueba en WAIT (fase', msg.phase, '):', msg.message || '');
            if (_recoveryTimeouts[msg.phase]) {
              clearTimeout(_recoveryTimeouts[msg.phase]);
              delete _recoveryTimeouts[msg.phase];
            }
            sendToWebSocket({
              type: 'TEST_STATUS_UPDATE',
              status: 'WAITING',
              phase: msg.phase,
              message: msg.message
            });
          } else if (msg.status === 'ORCHESTRATOR_LOST') {
            console.log('[SpectreQA] ORCHESTRATOR_LOST recibido - esperando recuperación...');
            const recoveryTimeout = setTimeout(() => {
              console.log('[SpectreQA] Tiempo de espera para recuperación agotado. Limpiando sesión.');
              testFinished = true;
              setGlobalTestStatus('IDLE');
              setCurrentPhasePayload(null);
              sendToWebSocket({ 
                type: 'TEST_STATUS_UPDATE', 
                status: 'TEST_ERROR', 
                phase: msg.phase,
                message: 'Recuperación fallida - timeout'
              });
            }, 5000);
            _recoveryTimeouts[msg.phase] = recoveryTimeout;
            sendToWebSocket({
              type: 'TEST_STATUS_UPDATE',
              status: 'RECOVERING',
              phase: msg.phase,
              message: 'Esperando recuperación de navegación'
            });
          } else {
            sendToWebSocket({ 
              type: 'TEST_STATUS_UPDATE', 
              status: msg.status, 
              phase: msg.phase 
            });
          }
          break;

        case 'TEST_TERMINATED':
        case 'TEST_FINISHED_SUCCESS':
        case 'TEST_ERROR':
          testFinished = true;
          setGlobalTestStatus('IDLE');
          setCurrentPhasePayload(null);
          if (_recoveryTimeouts[msg.phase]) {
            clearTimeout(_recoveryTimeouts[msg.phase]);
            delete _recoveryTimeouts[msg.phase];
          }
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
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs.length > 0) {
                sendToContentScript(tabs[0].id, {
                  type: 'SHOW_RESULT_MODAL',
                  success: msg.success,
                  message: msg.message
                }).catch(() => {});
              }
            });
          }
          break;

        case 'ADD_TO_VISUAL_HISTORY':
          addToVisualHistory(msg.payload.type, msg.payload.text);
          break;

        case 'CLEAR_VISUAL_HISTORY':
          clearVisualHistory();
          break;

        case 'NAVIGATION_DETECTED':
          console.log('[SpectreQA] Navegación detectada desde:', msg.data.from);
          sendToWebSocket({
            type: 'NAVIGATION_DETECTED',
            data: {
              from: msg.data.from,
              phase: msg.data.phase,
              timestamp: msg.data.timestamp
            }
          });
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      console.log('[SpectreQA] Puerto con el TaskOrchestrator cerrado.');
      orchestratorPort = null;
      
      if (globalTestStatus === 'RUNNING' && !testFinished) {
        console.warn('[SpectreQA] Puerto perdido durante prueba en ejecución. Notificando a Rust.');
        sendToWebSocket({
          type: 'TEST_STATUS_UPDATE',
          status: 'ORCHESTRATOR_LOST',
          phase: currentTestPhase
        });
      }
    });
  }
});

/**
 * MANEJADOR DE MENSAJES
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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

  if (msg.type === 'GET_CONNECTION_STATE') {
    chrome.storage.session.get(['connected']).then((data) => {
      sendResponse({ 
        connected: data.connected, 
        status: globalTestStatus, 
        port: currentPort,
        projectId: activeProjectId,
        testFinished: testFinished
      });
    });
    return true;
  }

  if (msg.type === 'REGISTER_TAB' && sender.tab?.id) {
    setCurrentTestTabId(sender.tab.id);
    if (IS_DEBUG) console.log('[SpectreQA] Tab registrado para pruebas:', currentTestTabId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_VISUAL_HISTORY') {
    sendResponse({ history: visualHistory });
    return true;
  }

  if (msg.type === 'NAVIGATION_DETECTED') {
    console.log('[SpectreQA] Navegación detectada desde:', msg.data.from);
    sendToWebSocket({
      type: 'NAVIGATION_DETECTED',
      data: {
        from: msg.data.from,
        phase: msg.data.phase,
        timestamp: msg.data.timestamp
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  sendResponse({});
});

/**
 * MANEJADOR DE NAVEGACIÓN (RE-INYECCIÓN)
 */

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  try {
    const { auditingUrls = [] } = await chrome.storage.session.get('auditingUrls');
    const hostname = new URL(tab.url).hostname;
    const isAllowedUrl = auditingUrls.some((u) => hostname.includes(u) || u.includes(hostname));

    if (isAllowedUrl && globalTestStatus === 'RUNNING' && !testFinished) {
      console.log('[SpectreQA] Navegación detectada en test activo. Re-inyectando en:', tab.url);
      
      setCurrentTestTabId(tabId);
      
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        files: ['console_hook.js']
      }).catch((err) => {
        console.error('[SpectreQA] Error inyectando console_hook.js (MAIN):', err);
      });

      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['agent_engine.js', 'task_orchestrator.js', 'content_script.js']
      }).catch((err) => {
        console.error('[SpectreQA] Error inyectando scripts (ISOLATED):', err);
        if (err.message?.includes('Cannot access contents of url')) {
          console.warn('[SpectreQA] Permiso insuficiente para reinyectar en:', tab.url);
        }
      });
      
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { 
          type: 'UPDATE_VISUAL_UI', 
          history: visualHistory 
        }).catch(() => {});
      }, 500);
    }
  } catch (error) {
    console.error('[SpectreQA] Error crítico controlando la navegación:', error);
  }
});

/**
 * INICIALIZACIÓN DEL SERVICE WORKER
 */

console.log('[SpectreQA] Inicializando Service Worker...');
restoreState().then(() => {
  connectWebSocket();
  chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepalive') return;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'PING' }));
  } else if (!reconnecting) {
    console.log('[SpectreQA] SW despertó sin socket activo, reconectando...');
    connectWebSocket();
  }
});

chrome.runtime.onSuspend.addListener(() => {
  console.log('[SpectreQA] Service Worker suspendido. Persistiendo estado final...');
  persistState();
});

console.log('[SpectreQA] Service Worker inicializado correctamente');