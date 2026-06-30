// task_orchestrator.js
// Orquestador central de pruebas para GlassQA.
// Versión simplificada: sin espera de TEST_STARTED.

// Flag de depuración: true solo en desarrollo, para ver logs técnicos detallados.
// Se usa "var" + comprobación porque este archivo se inyecta junto a
// agent_engine.js y content_script.js en el mismo contexto de ejecución
// (mismo "isolated world"); declarar la misma constante dos veces ahí
// rompería la inyección entera con un SyntaxError.
if (typeof IS_DEBUG === 'undefined') {
  var IS_DEBUG = false;
}

/**
 * Resumen seguro de un comando para logs y mensajes de error visibles
 * (incluido el modal de resultado que se muestra en la página).
 * Nunca incluye el valor de texto de @Write (puede ser una contraseña).
 * Solo conserva el tipo de comando y el id del elemento objetivo.
 */
function summarizeCommand(raw) {
  if (typeof raw !== 'string') return String(raw);
  const match = raw.match(/^(@\w+)\s+([\w-]+)/);
  return match ? `${match[1]} ${match[2]}` : raw.split(/\s+/)[0];
}

class TaskOrchestrator {
  constructor() {
    // Configuración de tiempos visuales (en milisegundos)
    this.COMMAND_DELAY_MS = 625;      // Retraso entre comandos (2.5s / 4 comandos)
    this.DELAY_BEFORE_PHASE_MS = 500; // Pequeña pausa antes de iniciar una fase

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
  }

  // Método auxiliar para pausar la ejecución
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  connect() {
    if (this.port) return;
    this.port = chrome.runtime.connect({ name: 'task_orchestrator' });
    this.port.onMessage.addListener(this.handleBackgroundMessage.bind(this));
    this.port.onDisconnect.addListener(() => {
      console.warn('[GlassQA Orchestrator] Desconectado del background');
      this.port = null;
      if (this.status !== 'TERMINATED') this.terminate('Conexión perdida');
    });
    console.log('[GlassQA Orchestrator] Conectado al background');
    this.sendToBackground('GET_CURRENT_STATE');
  }

  handleBackgroundMessage(msg) {
    if (IS_DEBUG) console.log('[GlassQA Orchestrator] Mensaje recibido:', msg.type);
    switch (msg.type) {
      case 'EXECUTE_PHASE':
        this.handleNewPhase(msg);
        break;
      case 'RESTORE_STATE':
        if (msg.globalStatus === 'RUNNING' || msg.globalStatus === 'PAUSED') {
          this.status = msg.globalStatus;
          this.currentPhase = msg.currentPhase;
          this.projectId = msg.activeProjectId || null;
          this.notifyStateChange();
          console.log(`Estado restaurado: ${this.status} (Fase ${this.currentPhase}) Proyecto: ${this.projectId}`);
        }
        break;
      case 'TEST_STARTED':
        this.projectId = msg.project_id;
        console.log(`Proyecto confirmado: ${this.projectId}`);
        break;
      default:
        // Ignorar otros tipos (AUDIT_URLS, PING, etc.)
        break;
    }
  }

  sendToBackground(type, payload = {}) {
    if (!this.port) {
      console.error('[GlassQA Orchestrator] No hay conexión con background');
      return;
    }
    this.port.postMessage({ type, ...payload });
  }

  async run() {
    if (IS_DEBUG) console.log('[GlassQA Orchestrator] run() invocado, status:', this.status);
    if (this.status === 'RUNNING') return;
    if (this.status === 'PAUSED') {
      this.resume();
      return;
    }
    
    // Reiniciar estado
    this.status = 'RUNNING';
    this.currentPhase = 0;
    this.finishedSuccess = false;
    this.errorFlag = false;
    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.currentThought = '';
    this.isProcessingQueue = false;
    this.notifyStateChange();
    
    // 1. Avisar al backend que empezamos
    this.sendToBackground('READY_TO_START', { 
      url: location.href,
      project_id: this.projectId || null
    });
    
    // 2. Capturar y enviar DOM inicial inmediatamente (sin esperar confirmación)
    await this.captureAndSendDom();
  }

  pause() {
    if (this.status !== 'RUNNING') return;
    this.status = 'PAUSED';
    this.notifyStateChange();
  }

  resume() {
    if (this.status !== 'PAUSED') return;
    this.status = 'RUNNING';
    this.notifyStateChange();
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
    console.log('[GlassQA Orchestrator] Terminado:', reason);
  }

  handleNewPhase(msg) {
    if (this.status === 'TERMINATED') {
      console.warn('Fase ignorada porque la prueba terminó');
      return;
    }
    if (this.commandQueue.length > 0 && this.isProcessingQueue) {
      console.warn('Nueva fase recibida mientras se ejecutaba otra; reemplazando cola');
    }
    this.currentPhase = msg.phase;
    this.currentThought = msg.thought || '';
    // Reconocer tanto FINISHED_SUCCESSFULLY (antiguo) como SUCCESS (nuevo)
    this.finishedSuccess = (msg.status === 'FINISHED_SUCCESSFULLY' || msg.status === 'SUCCESS');
    // Reconocer ERROR_NO_CHANGE y FAILURE como errores
    this.errorFlag = (msg.status === 'ERROR_NO_CHANGE' || msg.status === 'FAILURE');
    this.currentCommandIndex = -1;
    this.commandQueue = (msg.commands || []).map((raw, idx) => ({
      id: `cmd_${this.currentPhase}_${idx}`,
      raw: raw,
      status: 'PENDING'
    }));
    this.notifyStateChange();
    
    if (this.finishedSuccess) {
      console.log('[GlassQA Orchestrator] Prueba completada con SUCCESS');
      this.completeSuccess();
      return;
    }
    if (this.errorFlag) {
      const errorMsg = msg.status === 'FAILURE' 
        ? 'La aplicación reportó un error (FAILURE)'
        : 'La IA detectó que el DOM no cambió';
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
      console.log('Fase recibida en pausa, esperando reanudación');
    }
  }

  async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    // Pequeña pausa visual antes de comenzar la fase
    await this.delay(this.DELAY_BEFORE_PHASE_MS);

    while (this.currentCommandIndex + 1 < this.commandQueue.length) {
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
      try {
        await this.executeCommand(cmd.raw);
        cmd.status = 'COMPLETED';
        this.updateCommandStatus(cmd.id, 'COMPLETED');

        // Pausa visual entre comandos (si no es el último comando)
        if (this.currentCommandIndex + 1 < this.commandQueue.length) {
          await this.delay(this.COMMAND_DELAY_MS);
        }
      } catch (err) {
        console.error(`Error ejecutando ${summarizeCommand(cmd.raw)}:`, err);
        cmd.status = 'FAILED';
        this.updateCommandStatus(cmd.id, 'FAILED');
        this.completeWithError(`Fallo en comando: ${summarizeCommand(cmd.raw)}`);
        break;
      }
    }
    this.isProcessingQueue = false;
    if (this.currentCommandIndex === this.commandQueue.length - 1 &&
        this.status === 'RUNNING' && !this.finishedSuccess && !this.errorFlag) {
      this.commandQueue = [];
      this.currentCommandIndex = -1;
      this.requestNextPhase();
    }
  }

  async executeCommand(rawCommand) {
    const engine = window.__glassqa_engine__;
    if (!engine) throw new Error('Engine no disponible');
    await engine.executeCommands([rawCommand]);
  }

  async requestNextPhase() {
    if (this.status !== 'RUNNING') return;
    await this.captureAndSendDom();
  }

  async captureAndSendDom() {
    if (IS_DEBUG) console.log('[GlassQA Orchestrator] captureAndSendDom()');
    // Esperar hasta que el engine esté listo (máx 3s)
    let attempts = 0;
    while (!window.__glassqa_engine__ && attempts < 30) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    const engine = window.__glassqa_engine__;
    if (!engine) {
      console.error('Engine no disponible después de esperar');
      this.terminate('Engine no disponible');
      return;
    }
    const domSnapshot = engine.captureDom();
    console.log(`DOM capturado, elementos: ${domSnapshot?.length}`);
    this.sendToBackground('DOM_SNAPSHOT', {
      phase: this.currentPhase,
      url: location.href,
      route: location.pathname,
      elements: domSnapshot
    });
  }

  completeSuccess() {
    if (this.status === 'TERMINATED') return;
    this.status = 'IDLE';
    this.finishedSuccess = true;
    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.isProcessingQueue = false;
    this.notifyStateChange();
    this.sendToBackground('TEST_FINISHED_SUCCESS', { phase: this.currentPhase });
    // Enviar mensaje para mostrar modal de éxito en la página
    this.sendToBackground('SHOW_RESULT_MODAL', { 
      success: true, 
      message: 'Prueba finalizada con éxito'
    });
    console.log('Prueba finalizada con éxito');
  }

  completeWithError(errorMsg) {
    if (this.status === 'TERMINATED') return;
    this.status = 'IDLE';
    this.errorFlag = true;
    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.isProcessingQueue = false;
    this.notifyStateChange();
    this.sendToBackground('TEST_ERROR', { error: errorMsg, phase: this.currentPhase });
    // Enviar mensaje para mostrar modal de error en la página
    this.sendToBackground('SHOW_RESULT_MODAL', { 
      success: false, 
      message: `Prueba fallida: ${errorMsg}`
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
}

window.__glassqa_orchestrator__ = new TaskOrchestrator();