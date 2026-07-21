/** task_orchestrator.js */

/**
 * Orquestador central de pruebas para SpectreQA.
 * Flujo restaurado: ejecucion secuencial con listeners reactivos para WAIT/SUCCESS/ERROR.
 * Responsabilidad unica: ser el orquestador de pruebas de SpectreQA.
 * Responsabilidades adyacentes:
 * - ejecutar comandos en secuencia
 * - manejar el estado de la prueba
 * - comunicarse con el engine y el popup
 */

if (typeof IS_DEBUG === 'undefined') {
  var IS_DEBUG = true;
}

/**
 * Resume la ejecucion de la prueba.
 */
function summarizeCommand(raw) {
  if (typeof raw !== 'string') return String(raw);
  const match = raw.match(/^(@\w+)\s+([\w-]+)/);
  return match ? `${match[1]} ${match[2]}` : raw.split(/\s+/)[0];
}

function anonymizeCommandText(rawCommand) {
  if (typeof rawCommand !== 'string') return rawCommand || '';
  
  if (rawCommand.startsWith('@Write ')) {
    const match = rawCommand.match(/^(@Write\s+([\w\-]+))\s+"(.*)"\s*$/);
    if (match) {
      const cmdPrefix = match[1];
      const targetId = match[2];
      const textValue = match[3];
      return `@Write ${targetId} "[filled:${textValue.length}chars]"`;
    }
    
    const parts = rawCommand.split(/\s+/);
    if (parts.length >= 3) {
      const targetId = parts[1];
      const textValue = parts.slice(2).join(' ');
      return `@Write ${targetId} "[filled:${textValue.length}chars]"`;
    }
  }
  
  if (rawCommand.startsWith('@WriteRandom ') || rawCommand.startsWith('@WriteRandomNum ')) {
    const parts = rawCommand.split(/\s+/);
    if (parts.length >= 3) {
      const cmd = parts[0];
      const targetId = parts[1];
      const len = parts[2];
      return `${cmd} ${targetId} "[filled:${len}chars]"`;
    }
  }
  
  return rawCommand;
}

class TaskOrchestrator {
  constructor() {
    this.COMMAND_DELAY_MS = 300;
    this.DELAY_BEFORE_PHASE_MS = 200;

    this.MAX_RECONNECT_ATTEMPTS = 3;
    this.RECONNECT_DELAY_MS = 500;

    this.status = 'IDLE';
    this.currentPhase = 0;
    this.finishedSuccess = false;
    this.errorFlag = false;
    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.isProcessingQueue = false;
    this.currentThought = '';
    this.pauseResolve = null;
    this.port = null;
    this.projectId = null;
    this.onStateChange = null;
    this.onCommandUpdate = null;
    this.onPhaseComplete = null;
    this.autoCaptureOnQueueEmpty = true;

    this.lastUrl = null;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;

    this._consoleErrorBuffer = [];
    this._pendingWaitEvent = null;
    this._isWaitingForResume = false;
    this._backupRestored = false;
    this._pendingLifecycleEvent = null;

    // NUEVAS VARIABLES PARA CONTROL DE FLUJO
    this.isWaiting = false;
    this.captureTimeout = null;
    this.isNavigating = false;
    this.lastLifecycleStatus = 'READY';

    this.successListenerBound = this.handleSuccessSignal.bind(this);
    window.addEventListener('__spectreqa_success_signal__', this.successListenerBound);

    this.lifecycleListenerBound = this.handleLifecycleEvent.bind(this);
    window.addEventListener('__spectreqa_lifecycle_event__', this.lifecycleListenerBound);

    this._consoleErrorListenerBound = (e) => {
      this._consoleErrorBuffer.push(e.detail);
      if (IS_DEBUG) console.log('[SpectreQA] Error de consola capturado:', e.detail.message);
    };
    window.addEventListener('__spectreqa_console_error__', this._consoleErrorListenerBound);
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  emitLifecycleEvent(status, detail = {}) {
    window.dispatchEvent(new CustomEvent('__spectreqa_lifecycle_event__', {
      detail: {
        status: status,
        ...detail,
        timestamp: Date.now()
      }
    }));
  }

  async checkPause() {
    if (this.status === 'PAUSED') {
      console.log('[SpectreQA] Pausa detectada, esperando...');
      await new Promise((resolve) => { this.pauseResolve = resolve; });
      console.log('[SpectreQA] Reanudando ejecucion');
      return true;
    }
    
    if (this.status === 'WAITING') {
      console.log('[SpectreQA] WAITING detectado, esperando CONTINUE...');
      await new Promise((resolve) => {
        const waitListener = (e) => {
          if (e.detail.status === 'CONTINUE') {
            window.removeEventListener('__spectreqa_lifecycle_event__', waitListener);
            resolve();
          }
        };
        window.addEventListener('__spectreqa_lifecycle_event__', waitListener);
      });
      console.log('[SpectreQA] CONTINUE recibido, reanudando');
      return true;
    }
    
    return false;
  }

  restoreFromBackup(backup) {
    console.log('[SpectreQA] Restaurando desde backup:', backup);
    
    this.currentPhase = backup.phase || 0;
    this.currentThought = backup.thought || '';
    this._backupRestored = true;
    this.lastLifecycleStatus = 'WAIT';
    
    const fullQueue = backup.commandQueue || [];
    const executedIndex = backup.currentCommandIndex || -1;
    this.commandQueue = fullQueue.slice(executedIndex + 1);
    this.currentCommandIndex = -1;
    
    if (this.commandQueue.length === 0 && backup.isNavigation) {
      console.log('[SpectreQA] Backup restaurado: cola vacia, esperando nuevo DOM');
    }
    
    this.status = 'WAITING';
    this._isWaitingForResume = true;
    this.isWaiting = true;
    this.notifyStateChange();
    
    console.log('[SpectreQA] Estado restaurado. Modo: WAITING');
    console.log('[SpectreQA] Comandos pendientes:', this.commandQueue.length);
    
    // IMPORTANTE: Enviar DOM_SNAPSHOT para registrar la nueva página
    this.captureAndSendDom();
  }

  handleLifecycleEvent(event) {
    const detail = event.detail || {};
    console.log('[SpectreQA] Evento de ciclo de vida capturado:', detail.status, detail.message || '');

    // CANCELAR CUALQUIER CAPTURA PENDIENTE
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }

    // BLOQUEAR CAPTURA EN SUCCESS/ERROR
    if (detail.status === 'SUCCESS') {
      console.log('[SpectreQA] SUCCESS -> Finalizando prueba');
      this.isWaiting = false;
      this.isNavigating = false;
      this.lastLifecycleStatus = 'SUCCESS';
      this.commandQueue = [];
      this.currentCommandIndex = -1;
      this.isProcessingQueue = false;
      this.completeSuccess();
      return;
    }

    if (detail.status === 'ERROR') {
      const errorMsg = detail.message || 'Error reportado por la aplicacion';
      console.log('[SpectreQA] ERROR ->', errorMsg);
      this.isWaiting = false;
      this.isNavigating = false;
      this.lastLifecycleStatus = 'ERROR';
      this.commandQueue = [];
      this.currentCommandIndex = -1;
      this.isProcessingQueue = false;
      this.completeWithError(errorMsg);
      return;
    }

    if (this.status !== 'RUNNING' && this.status !== 'PAUSED' && this.status !== 'WAITING') {
      if (IS_DEBUG) console.log('[SpectreQA] Evento ignorado (status:', this.status, ')');
      return;
    }

    if (this.status === 'PAUSED') {
      console.log('[SpectreQA] Evento guardado para procesar al reanudar');
      this._pendingLifecycleEvent = detail;
      return;
    }

    switch (detail.status) {
      case 'WAIT':
        console.log('[SpectreQA] WAIT -> Pausando ejecucion asincrona');
        this.isWaiting = true;
        this.lastLifecycleStatus = 'WAIT';
        this.isNavigating = false;
        this._pendingWaitEvent = detail;
        this.status = 'WAITING';
        this._isWaitingForResume = true;
        this.notifyStateChange();
        this.sendToBackground('TEST_STATUS_UPDATE', {
          status: 'WAITING',
          phase: this.currentPhase,
          message: detail.message || 'Esperando evento asincrono'
        });
        // IMPORTANTE: Enviar DOM_SNAPSHOT con lifecycleStatus WAIT para detener watchdog
        this.captureAndSendDom();
        break;

      case 'CONTINUE':
        console.log('[SpectreQA] CONTINUE -> Reanudando ejecucion');
        if (this.status === 'WAITING' && this._isWaitingForResume) {
          this.isWaiting = false;
          this.lastLifecycleStatus = 'READY';
          this._isWaitingForResume = false;
          this.status = 'RUNNING';
          this._pendingWaitEvent = null;
          this._backupRestored = false;
          this.notifyStateChange();
          // CAPTURAR DOM SOLO DESPUES DE CONTINUE
          this.captureAndSendDom();
        } else if (this.status === 'PAUSED') {
          this.resume();
        } else {
          this.status = 'RUNNING';
          this.lastLifecycleStatus = 'READY';
          this.notifyStateChange();
        }
        break;

      case 'PAUSE':
        console.log('[SpectreQA] PAUSE -> Pausando ejecucion');
        this.pause();
        break;

      default:
        console.log('[SpectreQA] Evento desconocido:', detail.status);
    }
  }

  async resumeAfterWait() {
    console.log('[SpectreQA] Reanudando despues de WAIT');
    
    // LIMPIAR FLAG DE WAITING
    this.isWaiting = false;
    this.lastLifecycleStatus = 'READY';
    
    if (this.commandQueue.length > 0 && this.currentCommandIndex < this.commandQueue.length - 1) {
      console.log('[SpectreQA] Hay comandos pendientes, reanudando cola');
      this.processQueue();
      return;
    }

    console.log('[SpectreQA] Cola vacia o completada, capturando DOM');
    
    const engine = window.__spectreqa_engine__;
    if (!engine) {
      console.error('[SpectreQA] Engine no disponible');
      this.terminate('Engine no disponible');
      return;
    }
    
    const domSnapshot = engine.captureDom();
    console.log('[SpectreQA] DOM capturado:', domSnapshot?.length, 'elementos');
    
    this.sendToBackground('DOM_SNAPSHOT', {
      phase: this.currentPhase,
      url: location.href,
      route: location.pathname,
      elements: domSnapshot,
      lifecycleStatus: "READY"
    });
    console.log('[SpectreQA] DOM_SNAPSHOT enviado (READY), esperando nueva fase');
  }

  handleSuccessSignal(event) {
    if (this.status === 'RUNNING' || this.status === 'PAUSED' || this.status === 'WAITING') {
      const detail = event.detail || {};
      console.log('[SpectreQA] Marcador de exito detectado:', detail.message || 'sin mensaje');
      
      // CANCELAR CUALQUIER CAPTURA PENDIENTE
      if (this.captureTimeout) {
        clearTimeout(this.captureTimeout);
        this.captureTimeout = null;
      }
      
      this.isWaiting = false;
      this.lastLifecycleStatus = 'SUCCESS';
      this.commandQueue = [];
      this.currentCommandIndex = -1;
      this.isProcessingQueue = false;
      this.completeSuccess();
    } else {
      if (IS_DEBUG) console.log('[SpectreQA] Marcador de exito ignorado (status:', this.status, ')');
    }
  }

  resetSuccessSignal() {
    window.dispatchEvent(new CustomEvent('__spectreqa_reset_success__'));
    this._consoleErrorBuffer = [];
  }

  connect() {
    if (this.port) {
      return;
    }

    if (this.isReconnecting) {
      return;
    }

    try {
      this.port = chrome.runtime.connect({ name: 'task_orchestrator' });
      this.port.onMessage.addListener(this.handleBackgroundMessage.bind(this));
      this.port.onDisconnect.addListener(this.handleDisconnect.bind(this));

      this.reconnectAttempts = 0;
      this.isReconnecting = false;

      console.log('[SpectreQA] Conectado al background');
      this.sendToBackground('GET_CURRENT_STATE');
    } catch (error) {
      console.error('[SpectreQA] Error al conectar:', error);
      this.port = null;
      this.handleDisconnect();
    }
  }

  handleDisconnect() {
    const wasRunning = this.status === 'RUNNING' || this.status === 'PAUSED' || this.status === 'WAITING';

    if (this.port) {
      try {
        this.port.onMessage.removeListener(this.handleBackgroundMessage.bind(this));
        this.port.onDisconnect.removeListener(this.handleDisconnect.bind(this));
      } catch (e) {}
      this.port = null;
    }

    console.warn('[SpectreQA] Desconectado del background');

    if (wasRunning && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS && !this.isReconnecting) {
      this.reconnectAttempts++;
      this.isReconnecting = true;

      console.log('[SpectreQA] Intento de reconexion', this.reconnectAttempts, '/', this.MAX_RECONNECT_ATTEMPTS);

      setTimeout(() => {
        this.isReconnecting = false;
        this.connect();
      }, this.RECONNECT_DELAY_MS);
    } else if (wasRunning && this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('[SpectreQA] Intentos de reconexion agotados. Terminando prueba.');
      this.sendToBackground('SHOW_RESULT_MODAL', {
        success: false,
        message: 'Conexion perdida con el Service Worker. La prueba ha sido terminada.'
      });
      this.terminate('Conexion perdida definitivamente');
    } else if (!wasRunning) {
      console.log('[SpectreQA] Desconexion durante estado IDLE, esperando nueva conexion');
    }
  }

  handleBackgroundMessage(msg) {
    if (IS_DEBUG) console.log('[SpectreQA] Mensaje recibido:', msg.type);
    this.reconnectAttempts = 0;

    switch (msg.type) {
      case 'EXECUTE_PHASE':
        this.handleNewPhase(msg);
        break;
      case 'RESTORE_STATE':
        if (msg.globalStatus === 'RUNNING' || msg.globalStatus === 'PAUSED' || msg.globalStatus === 'WAITING') {
          this.status = msg.globalStatus;
          this.currentPhase = msg.currentPhase;
          this.projectId = msg.activeProjectId || null;
          if (msg.globalStatus === 'WAITING') {
            this.isWaiting = true;
            this.lastLifecycleStatus = 'WAIT';
          }
          this.notifyStateChange();
          console.log('Estado restaurado:', this.status, '(Fase', this.currentPhase, ') Proyecto:', this.projectId);
        }
        break;
      case 'TEST_STARTED':
        this.projectId = msg.project_id;
        console.log('Proyecto confirmado:', this.projectId);
        break;
      default:
        break;
    }
  }

  sendToBackground(type, payload = {}) {
    if (!this.port) {
      console.error('[SpectreQA] No hay conexion con background');
      return;
    }
    try {
      this.port.postMessage({ type, ...payload });
    } catch (error) {
      console.error('[SpectreQA] Error al enviar mensaje:', error);
      this.handleDisconnect();
    }
  }

  addToVisualHistory(type, text) {
    this.sendToBackground('ADD_TO_VISUAL_HISTORY', {
      payload: { type, text }
    });
  }

  async run() {
    if (IS_DEBUG) console.log('[SpectreQA] run() invocado, status:', this.status);
    
    if (this.status === 'RUNNING') return;
    if (this.status === 'PAUSED') {
      this.resume();
      return;
    }
    if (this.status === 'WAITING') {
      console.log('[SpectreQA] En WAITING, emitiendo CONTINUE para reanudar');
      this.emitLifecycleEvent('CONTINUE', { message: 'Reanudado por usuario' });
      return;
    }

    this.sendToBackground('CLEAR_VISUAL_HISTORY', {});

    this.status = 'RUNNING';
    this.currentPhase = 0;
    this.finishedSuccess = false;
    this.errorFlag = false;
    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.currentThought = '';
    this.isProcessingQueue = false;
    this.lastUrl = location.href;
    this._backupRestored = false;
    this.isWaiting = false;
    this.isNavigating = false;
    this.lastLifecycleStatus = 'READY';

    this.reconnectAttempts = 0;
    this.resetSuccessSignal();

    this.notifyStateChange();

    this.sendToBackground('READY_TO_START', {
      url: location.href,
      project_id: this.projectId || null
    });

    await this.captureAndSendDom();
  }

  pause() {
    if (this.status !== 'RUNNING' && this.status !== 'WAITING') return;
    this.status = 'PAUSED';
    this.notifyStateChange();
  }

  resume() {
    if (this.status !== 'PAUSED') return;
    this.status = 'RUNNING';
    this.lastLifecycleStatus = 'READY';
    this.notifyStateChange();
    
    if (this._pendingLifecycleEvent) {
      console.log('[SpectreQA] Procesando evento pendiente de la pausa:', this._pendingLifecycleEvent);
      const pendingDetail = this._pendingLifecycleEvent;
      this._pendingLifecycleEvent = null;
      
      if (pendingDetail.status === 'SUCCESS') {
        this.completeSuccess();
        return;
      } else if (pendingDetail.status === 'ERROR') {
        this.completeWithError(pendingDetail.message);
        return;
      }
    }
    
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
    
    if (!this.isProcessingQueue && this.currentCommandIndex + 1 < this.commandQueue.length) {
      this.processQueue();
    } else if (this.currentCommandIndex === this.commandQueue.length - 1 && this.status === 'RUNNING') {
      this.requestNextPhase();
    }
  }

  terminate(reason = 'Usuario detuvo la prueba') {
    if (this.status === 'TERMINATED') return;
    
    // CANCELAR CUALQUIER CAPTURA PENDIENTE
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
    
    this.isWaiting = false;
    this.isNavigating = false;
    this.lastLifecycleStatus = 'TERMINATED';
    this.status = 'TERMINATED';
    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.isProcessingQueue = false;
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
    this.notifyStateChange();
    this.sendToBackground('TEST_TERMINATED', { reason, phase: this.currentPhase });
    console.log('[SpectreQA] Terminado:', reason);
  }

  handleNewPhase(msg) {
    if (this.status === 'TERMINATED') {
      console.warn('Fase ignorada porque la prueba termino');
      return;
    }
    if (this.commandQueue.length > 0 && this.isProcessingQueue) {
      console.warn('Nueva fase recibida mientras se ejecutaba otra; reemplazando cola');
    }
    
    this.currentPhase = msg.phase;
    const newThought = msg.thought || '';
    
    if (newThought && newThought !== this.currentThought) {
      this.currentThought = newThought;
      this.addToVisualHistory('thought', newThought);
    }
    
    this.finishedSuccess = (msg.status === 'FINISHED_SUCCESSFULLY' || msg.status === 'SUCCESS');
    this.errorFlag = (msg.status === 'ERROR_NO_CHANGE' || msg.status === 'FAILURE');
    this.currentCommandIndex = -1;
    this.commandQueue = (msg.commands || []).map((raw, idx) => ({
      id: `cmd_${this.currentPhase}_${idx}`,
      raw: raw,
      status: 'PENDING'
    }));
    this.notifyStateChange();

    if (this.finishedSuccess) {
      console.log('[SpectreQA] Prueba completada con SUCCESS');
      // CANCELAR CUALQUIER CAPTURA PENDIENTE
      if (this.captureTimeout) {
        clearTimeout(this.captureTimeout);
        this.captureTimeout = null;
      }
      this.completeSuccess();
      return;
    }
    if (this.errorFlag) {
      const errorMsg = msg.status === 'FAILURE' 
        ? 'La aplicacion reporto un error (FAILURE)'
        : 'La IA detecto que el DOM no cambio';
      // CANCELAR CUALQUIER CAPTURA PENDIENTE
      if (this.captureTimeout) {
        clearTimeout(this.captureTimeout);
        this.captureTimeout = null;
      }
      this.completeWithError(errorMsg);
      return;
    }
    if (this.commandQueue.length === 0) {
      this.requestNextPhase();
      return;
    }
    if (this.status === 'RUNNING' && !this.isProcessingQueue) {
      this.processQueue();
    } else if (this.status === 'PAUSED') {
      console.log('Fase recibida en pausa, esperando reanudacion');
    } else if (this.status === 'WAITING') {
      console.log('Fase recibida en WAITING, guardando cola para reanudar');
    }
  }

  async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    await this.delay(this.DELAY_BEFORE_PHASE_MS);

    while (this.currentCommandIndex + 1 < this.commandQueue.length) {
      await this.checkPause();
      
      if (this.status === 'TERMINATED') break;
      
      if (this.status === 'PAUSED') {
        await new Promise((resolve) => { this.pauseResolve = resolve; });
        if (this.status !== 'RUNNING') continue;
        if (this.currentCommandIndex + 1 >= this.commandQueue.length) break;
      }

      this.currentCommandIndex++;
      const cmd = this.commandQueue[this.currentCommandIndex];
      cmd.status = 'EXECUTING';
      this.updateCommandStatus(cmd.id, 'EXECUTING');

      const anonymizedCmd = anonymizeCommandText(cmd.raw);
      this.addToVisualHistory('command', anonymizedCmd);

      try {
        await this.executeCommand(cmd.raw);
        cmd.status = 'COMPLETED';
        this.updateCommandStatus(cmd.id, 'COMPLETED');
        this._consoleErrorBuffer = [];

        if (this.currentCommandIndex + 1 < this.commandQueue.length) {
          await this.delay(this.COMMAND_DELAY_MS);
        }

        if (this.status === 'TERMINATED' || this.finishedSuccess || this.errorFlag) {
          break;
        }

      } catch (err) {
        console.error('Error ejecutando', summarizeCommand(cmd.raw), ':', err);
        cmd.status = 'FAILED';
        this.updateCommandStatus(cmd.id, 'FAILED');
        this.completeWithError('Fallo en comando: ' + summarizeCommand(cmd.raw));
        break;
      }
    }

    this.isProcessingQueue = false;

    if (this.currentCommandIndex === this.commandQueue.length - 1 &&
        this.status === 'RUNNING' && !this.finishedSuccess && !this.errorFlag) {
      this.commandQueue = [];
      this.currentCommandIndex = -1;
      await this.requestNextPhase();
    }
  }

  async captureAndSendDom() {
    // 1. Ya NO bloqueamos si está en WAITING.
    // Solo bloqueamos si la prueba terminó con éxito o fue abortada.
    if (this.status === 'SUCCESS' || this.status === 'TERMINATED') {
      if (IS_DEBUG) console.log('[SpectreQA] captureAndSendDom bloqueado: status=' + this.status);
      return;
    }

    const isNewView = this.lastUrl !== location.href;
    this.lastUrl = location.href;
    this._consoleErrorBuffer = [];
    if (IS_DEBUG) console.log('[SpectreQA] captureAndSendDom()');

    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
    }

    // Mantenemos el delay (500ms) para dar tiempo a que los scripts de la página
    // emitan su evento 'WAIT' antes de que tomemos la captura.
    this.captureTimeout = setTimeout(async () => {
      this.captureTimeout = null;

      // Volvemos a validar solo estados terminales por seguridad
      if (this.status === 'SUCCESS' || this.status === 'TERMINATED') {
        if (IS_DEBUG) console.log('[SpectreQA] Captura cancelada: estado cambio durante el timeout');
        return;
      }

      let attempts = 0;
      while (!window.__spectreqa_engine__ && attempts < 30) {
        await this.delay(100);
        attempts++;
      }

      const engine = window.__spectreqa_engine__;
      if (!engine) {
        console.error('Engine no disponible despues de esperar');
        this.terminate('Engine no disponible');
        return;
      }

      const domSnapshot = engine.captureDom();
      console.log('DOM capturado, elementos:', domSnapshot?.length);
      
      // 2. Determinar el estado actual del ciclo de vida para el backend
      const currentLifecycleStatus = this.isWaiting ? "WAIT" : "READY";
      this.lastLifecycleStatus = currentLifecycleStatus;

      // 3. Enviar el DOM al background INCLUYENDO el nuevo campo 'lifecycleStatus'
      this.sendToBackground('DOM_SNAPSHOT', {
        phase: this.currentPhase,
        url: location.href,
        route: location.pathname,
        elements: domSnapshot,
        lifecycleStatus: currentLifecycleStatus
      });
      console.log(`[SpectreQA] DOM_SNAPSHOT enviado con lifecycleStatus: ${currentLifecycleStatus}`);
      
    }, 500); 
  }

  async executeCommand(rawCommand) {
    const engine = window.__spectreqa_engine__;
    if (!engine) throw new Error('Engine no disponible');
    await engine.executeCommands([rawCommand]);
  }

  async requestNextPhase() {
    if (this.status !== 'RUNNING') return;
    await this.captureAndSendDom();
  }

  completeSuccess() {
    if (this.status === 'TERMINATED' || this.status === 'SUCCESS') return;

    // CANCELAR CUALQUIER TIMEOUT PENDIENTE
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
    
    this.isWaiting = false;
    this.isNavigating = false;
    this.lastLifecycleStatus = 'SUCCESS';
    this.status = 'SUCCESS';
    this.finishedSuccess = true;
    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.isProcessingQueue = false;
    this.notifyStateChange();

    this.sendToBackground('TEST_STATUS_UPDATE', {
      status: 'TEST_SUCCESS',
      phase: this.currentPhase
    });

    this.sendToBackground('SHOW_RESULT_MODAL', {
      success: true,
      message: 'Prueba finalizada con exito!'
    });

    console.log('[SpectreQA] Prueba completada con SUCCESS - notificado al backend');
  }

  completeWithError(errorMsg) {
    if (this.status === 'TERMINATED') return;

    // CANCELAR CUALQUIER TIMEOUT PENDIENTE
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
    
    this.isWaiting = false;
    this.isNavigating = false;
    this.lastLifecycleStatus = 'ERROR';
    this.status = 'IDLE';
    this.errorFlag = true;
    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.isProcessingQueue = false;
    this.notifyStateChange();
    this.sendToBackground('TEST_ERROR', { error: errorMsg, phase: this.currentPhase });
    this.sendToBackground('SHOW_RESULT_MODAL', {
      success: false,
      message: 'Prueba fallida: ' + errorMsg
    });
    console.error('Error:', errorMsg);
  }

  updateCommandStatus(cmdId, newStatus) {
    this.onCommandUpdate?.(cmdId, newStatus);
  }

  notifyStateChange() {
    this.onStateChange?.({
      status: this.status,
      phase: this.currentPhase,
      thought: this.currentThought,
      finishedSuccess: this.finishedSuccess,
      error: this.errorFlag,
      queueLength: this.commandQueue.length,
      currentCommandIndex: this.currentCommandIndex
    });
  }

  getState() {
    return {
      status: this.status,
      phase: this.currentPhase,
      thought: this.currentThought,
      finishedSuccess: this.finishedSuccess,
      errorFlag: this.errorFlag,
      projectId: this.projectId
    };
  }

  destroy() {
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
    window.removeEventListener('__spectreqa_success_signal__', this.successListenerBound);
    window.removeEventListener('__spectreqa_lifecycle_event__', this.lifecycleListenerBound);
    window.removeEventListener('__spectreqa_console_error__', this._consoleErrorListenerBound);
  }
}

const orchestrator = new TaskOrchestrator();
window.__spectreqa_orchestrator__ = orchestrator;
window.__SPECTREQA_SUCCESS_MARKER__ = '__SPECTREQA_SUCCESS__';