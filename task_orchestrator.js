/** orquestadorDeComandos.js */

/**
 * Responsabilidad única: Iterar sobre una lista de comandos y pasárselos al motor.
 * Ser el comunicador entre este contenido y background.js (puerto persistente).
 *
 * NO es dueño del estado del ciclo de vida: eso vive en LifeCicle (cicloDeVida.js).
 * Esta clase solo LEE ese estado (para saber si puede avanzar) y expone los
 * métodos que LifecycleManager necesita para reaccionar (pause/resume/
 * completeSuccess/completeWithError/terminate/captureAndSendDom/getState).
 *
 * DECISIÓN DE DISEÑO (documentada porque no estaba explícita en los archivos
 * que me pasaste): cuando el propio backend de IA (via EXECUTE_PHASE) o un
 * comando fallido deciden que la prueba terminó, este archivo YA NO llama a
 * sus propios completeSuccess()/completeWithError() directamente — en vez de
 * eso llama a LifecycleManager.testComplete()/.error(), para que LifeCicle
 * quede como única fuente de verdad del estado. LifecycleManager es quien,
 * a su vez, termina invocando completeSuccess()/completeWithError() aquí.
 */

if (typeof IS_DEBUG === 'undefined') {
  var IS_DEBUG = true;
}

/** Resumen seguro de un comando para logs/warnings (nunca incluye el texto de @Write). */
function summarizeCommand(raw) {
  if (typeof raw !== 'string') return String(raw);
  const match = raw.match(/^(@\w+)\s+([\w-]+)/);
  return match ? `${match[1]} ${match[2]}` : raw.split(/\s+/)[0];
}

/** Oculta el contenido real de @Write / @WriteRandom* antes de mandarlo a la pila visual. */
function anonymizeCommandText(rawCommand) {
  if (typeof rawCommand !== 'string') return rawCommand || '';

  if (rawCommand.startsWith('@Write ')) {
    const match = rawCommand.match(/^(@Write\s+([\w\-]+))\s+"(.*)"\s*$/);
    if (match) {
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
      const [cmd, targetId, len] = parts;
      return `${cmd} ${targetId} "[filled:${len}chars]"`;
    }
  }

  return rawCommand;
}

class TaskOrchestrator {
  #handleBackgroundMessageBound;
  #handleDisconnectBound;

  constructor() {
    this.COMMAND_DELAY_MS = 300;
    this.DELAY_BEFORE_PHASE_MS = 200;
    this.MAX_RECONNECT_ATTEMPTS = 3;
    this.RECONNECT_DELAY_MS = 500;

    // Estado exclusivo de la ejecución de comandos
    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.isProcessingQueue = false;
    this.captureTimeout = null;
    this.lastUrl = null;

    // Comunicación con background.js
    this.port = null;
    this.projectId = null;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;

    // Callbacks opcionales de UI (por si content_script.js quiere reaccionar a cada comando)
    this.onCommandUpdate = null;

    // Bindings estables: sin esto, addListener/removeListener con .bind(this) inline
    // crean funciones distintas cada vez y removeListener nunca quita nada.
    this.#handleBackgroundMessageBound = this.#handleBackgroundMessage.bind(this);
    this.#handleDisconnectBound = this.#handleDisconnect.bind(this);
  }

  // --- CARGA Y EJECUCIÓN DE COMANDOS ---

  /** Carga una nueva lista de comandos crudos recibida del background. */
  loadCommands(commandsRaw) {
    this.commandQueue = (commandsRaw || []).map((raw, idx) => ({
      id: `cmd_${idx}`,
      raw,
      status: 'PENDING'
    }));
    this.currentCommandIndex = -1;
  }

  /** Espera (polling simple) mientras LifeCicle diga PAUSED o WAITING. */
  async #waitForClearance() {
    const lifecycle = window.__spectreqa_lifecycle__;
    while (
      lifecycle.status === lifecycle.status_enum.PAUSED ||
      lifecycle.status === lifecycle.status_enum.WAITING
    ) {
      await this.delay(200);
    }
  }

  /** Loop principal de ejecución de la cola de comandos actual. */
  async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    await this.delay(this.DELAY_BEFORE_PHASE_MS);

    const lifecycle = window.__spectreqa_lifecycle__;

    while (this.currentCommandIndex + 1 < this.commandQueue.length) {
      await this.#waitForClearance();

      const currentStatus = lifecycle.status;
      if (
        currentStatus === lifecycle.status_enum.ERROR ||
        currentStatus === lifecycle.status_enum.SUCCESS ||
        currentStatus === lifecycle.status_enum.TERMINATED
      ) {
        break;
      }

      this.currentCommandIndex++;
      const cmd = this.commandQueue[this.currentCommandIndex];

      this.#updateCommandStatus(cmd.id, 'EXECUTING');
      this.addToVisualHistory('command', anonymizeCommandText(cmd.raw));

      try {
        await window.__spectreqa_engine__.executeCommands([cmd.raw]);
        this.#updateCommandStatus(cmd.id, 'COMPLETED');

        if (this.currentCommandIndex + 1 < this.commandQueue.length) {
          await this.delay(this.COMMAND_DELAY_MS);
        }
      } catch (err) {
        console.error('[SpectreQA] Fallo ejecutando', summarizeCommand(cmd.raw), ':', err);
        this.#updateCommandStatus(cmd.id, 'FAILED');
        // No terminamos la prueba nosotros mismos: se lo pedimos a LifecycleManager
        // para que LifeCicle siga siendo la única fuente de verdad del estado.
        window.__spectreqa_lifecycle_manager__.error({
          phase: lifecycle.currentPhase,
          message: 'Fallo en comando: ' + summarizeCommand(cmd.raw)
        });
        break;
      }
    }

    this.isProcessingQueue = false;

    const queueFinished = this.currentCommandIndex === this.commandQueue.length - 1;
    const stillRunning = lifecycle.status === lifecycle.status_enum.RUNNING;
    if (queueFinished && stillRunning) {
      this.commandQueue = [];
      this.currentCommandIndex = -1;
      await this.requestNextPhase();
    }
  }

  #updateCommandStatus(cmdId, newStatus) {
    this.onCommandUpdate?.(cmdId, newStatus);
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  addToVisualHistory(type, text) {
    this.sendToBackground('ADD_TO_VISUAL_HISTORY', { payload: { type, text } });
  }

  // --- ARRANQUE / CONTROL MANUAL (botones del menú flotante) ---

  /**
   * Arranca una prueba nueva, o reanuda si estaba PAUSED/WAITING.
   * Equivalente al viejo TaskOrchestrator.run(): content_script.js debe llamar
   * a esto desde el botón "Correr", no a processQueue() directamente (processQueue
   * solo itera lo que ya esté cargado; no reinicia ni avisa a Rust de un inicio nuevo).
   */
  run() {
    const lifecycle = window.__spectreqa_lifecycle__;

    if (lifecycle.status === lifecycle.status_enum.RUNNING) return;

    if (lifecycle.isPaused) {
      window.dispatchEvent(new CustomEvent(lifecycle.eventName, {
        detail: { status: lifecycle.eventType.RESUME, message: 'Reanudado por usuario' }
      }));
      return;
    }

    if (lifecycle.isWaiting) {
      window.dispatchEvent(new CustomEvent(lifecycle.eventName, {
        detail: { status: lifecycle.eventType.CONTINUE, message: 'Reanudado por usuario' }
      }));
      return;
    }

    console.log('[SpectreQA] run() - iniciando prueba nueva');

    this.sendToBackground('CLEAR_VISUAL_HISTORY', {});

    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.isProcessingQueue = false;
    this.lastUrl = location.href;

    lifecycle.reset();
    lifecycle.status = lifecycle.status_enum.RUNNING;

    this.sendToBackground('READY_TO_START', {
      url: location.href,
      project_id: this.projectId || null
    });

    this.captureAndSendDom();
  }

  // --- INTERFAZ QUE ESPERA LifecycleManager ---

  getState() {
    const lifecycle = window.__spectreqa_lifecycle__;
    return {
      status: lifecycle ? lifecycle.status : 'IDLE',
      phase: lifecycle ? lifecycle.currentPhase : 0,
      projectId: this.projectId
    };
  }

  /** LifeCicle ya cambió su propio status a PAUSED/WAITING antes de llamar esto. */
  pause() {
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
  }

  /** LifeCicle ya volvió a RUNNING antes de llamar esto: solo seguimos la cola si quedaba algo. */
  resume() {
    if (!this.isProcessingQueue && this.currentCommandIndex + 1 < this.commandQueue.length) {
      this.processQueue();
    }
  }

  completeSuccess() {
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.isProcessingQueue = false;

    this.sendToBackground('SHOW_RESULT_MODAL', {
      success: true,
      message: 'Prueba finalizada con éxito!'
    });
  }

  completeWithError(errorMsg) {
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.isProcessingQueue = false;

    this.sendToBackground('SHOW_RESULT_MODAL', {
      success: false,
      message: 'Prueba fallida: ' + errorMsg
    });
  }

  /** Detención voluntaria (botón "Detener"). No es un fallo, por eso no usa SHOW_RESULT_MODAL de error. */
  terminate(reason = 'Usuario detuvo la prueba', phase = 0) {
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
    this.commandQueue = [];
    this.currentCommandIndex = -1;
    this.isProcessingQueue = false;

    this.sendToBackground('TEST_TERMINATED', { reason, phase });
    console.log('[SpectreQA] Terminado:', reason);
  }

  async captureAndSendDom() {
    const lifecycle = window.__spectreqa_lifecycle__;

    if (lifecycle.status === lifecycle.status_enum.SUCCESS || lifecycle.status === lifecycle.status_enum.TERMINATED) {
      if (IS_DEBUG) console.log('[SpectreQA] captureAndSendDom bloqueado: status=' + lifecycle.status);
      return;
    }

    this.lastUrl = location.href;

    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
    }

    // Delay para dar tiempo a que la página emita su propio evento WAIT antes
    // de que tomemos la captura (si va a emitirlo, lo hace casi inmediatamente).
    this.captureTimeout = setTimeout(async () => {
      this.captureTimeout = null;

      if (lifecycle.status === lifecycle.status_enum.SUCCESS || lifecycle.status === lifecycle.status_enum.TERMINATED) {
        if (IS_DEBUG) console.log('[SpectreQA] Captura cancelada: estado cambió durante el timeout');
        return;
      }

      // El DOM es lo último que se hace en la fase: no se captura ni se manda
      // mientras siga habiendo un WAIT o una pausa manual activos. Se sondea
      // en vez de esperar un evento puntual (como CONTINUE), porque un WAIT
      // puede resolverse por vías distintas (p.ej. TEST_COMPLETE) que nunca
      // disparan CONTINUE.
      while (lifecycle.isWaiting || lifecycle.isPaused) {
        await this.delay(200);
        if (lifecycle.status === lifecycle.status_enum.SUCCESS || lifecycle.status === lifecycle.status_enum.TERMINATED) {
          if (IS_DEBUG) console.log('[SpectreQA] Captura cancelada: la prueba terminó mientras esperábamos');
          return;
        }
      }

      let attempts = 0;
      while (!window.__spectreqa_engine__ && attempts < 30) {
        await this.delay(100);
        attempts++;
      }

      const engine = window.__spectreqa_engine__;
      if (!engine) {
        console.error('[SpectreQA] Engine no disponible después de esperar');
        this.terminate('Engine no disponible', lifecycle.currentPhase);
        return;
      }

      const domSnapshot = engine.captureDom();
      console.log('[SpectreQA] DOM capturado, elementos:', domSnapshot?.length);

      // Si llegamos hasta acá, por definición ya no estamos esperando nada:
      // el sondeo de arriba no deja pasar mientras isWaiting/isPaused sigan activos.
      this.sendToBackground('DOM_SNAPSHOT', {
        phase: lifecycle.currentPhase,
        url: location.href,
        route: location.pathname,
        elements: domSnapshot,
        lifecycleStatus: 'READY'
      });
      console.log('[SpectreQA] DOM_SNAPSHOT enviado');
    }, 500);
  }

  requestNextPhase() {
    return this.captureAndSendDom();
  }

  /** Nueva fase recibida desde Rust (via background). */
  handleNewPhase(msg) {
    const lifecycle = window.__spectreqa_lifecycle__;

    if (lifecycle.status === lifecycle.status_enum.TERMINATED) {
      console.warn('[SpectreQA] Fase ignorada: la prueba ya terminó');
      return;
    }

    lifecycle.currentPhase = msg.phase;

    const newThought = msg.thought || '';
    if (newThought) {
      this.addToVisualHistory('thought', newThought);
    }

    this.loadCommands(msg.commands || []);

    if (this.commandQueue.length === 0) {
      this.requestNextPhase();
      return;
    }

    this.processQueue();
  }

  // --- COMUNICACIÓN CON background.js (puerto persistente) ---

  connect() {
    if (this.port || this.isReconnecting) return;

    try {
      this.port = chrome.runtime.connect({ name: 'task_orchestrator' });
      this.port.onMessage.addListener(this.#handleBackgroundMessageBound);
      this.port.onDisconnect.addListener(this.#handleDisconnectBound);

      this.reconnectAttempts = 0;
      this.isReconnecting = false;

      console.log('[SpectreQA] Conectado al background');
      this.sendToBackground('GET_CURRENT_STATE');
    } catch (error) {
      console.error('[SpectreQA] Error al conectar:', error);
      this.port = null;
      this.#handleDisconnect();
    }
  }

  #handleDisconnect() {
    const lifecycle = window.__spectreqa_lifecycle__;
    const wasRunning =
      lifecycle.status === lifecycle.status_enum.RUNNING ||
      lifecycle.status === lifecycle.status_enum.PAUSED ||
      lifecycle.status === lifecycle.status_enum.WAITING;

    this.port = null;
    console.warn('[SpectreQA] Desconectado del background');

    if (wasRunning && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS && !this.isReconnecting) {
      this.reconnectAttempts++;
      this.isReconnecting = true;
      console.log('[SpectreQA] Intento de reconexión', this.reconnectAttempts, '/', this.MAX_RECONNECT_ATTEMPTS);

      setTimeout(() => {
        this.isReconnecting = false;
        this.connect();
      }, this.RECONNECT_DELAY_MS);
    } else if (wasRunning && this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('[SpectreQA] Intentos de reconexión agotados. Terminando prueba.');
      // El puerto ya está caído: no se puede avisar a background por esta vía.
      this.terminate('Conexión perdida definitivamente', lifecycle.currentPhase);
    } else {
      console.log('[SpectreQA] Desconexión durante estado IDLE, esperando nueva conexión');
    }
  }

  #handleBackgroundMessage(msg) {
    if (IS_DEBUG) console.log('[SpectreQA] Mensaje recibido:', msg.type);
    this.reconnectAttempts = 0;

    switch (msg.type) {
      case 'EXECUTE_PHASE':
        this.handleNewPhase(msg);
        break;

      case 'RESTORE_STATE': {
        const lifecycle = window.__spectreqa_lifecycle__;
        if (msg.globalStatus === 'RUNNING' || msg.globalStatus === 'PAUSED' || msg.globalStatus === 'WAITING') {
          lifecycle.status = msg.globalStatus;
          lifecycle.currentPhase = msg.currentPhase;
          this.projectId = msg.activeProjectId || null;
          if (msg.globalStatus === 'WAITING') lifecycle.isWaiting = true;
          console.log('[SpectreQA] Estado restaurado:', lifecycle.status, '(Fase', lifecycle.currentPhase, ') Proyecto:', this.projectId);
        }
        break;
      }

      case 'TEST_STARTED':
        this.projectId = msg.project_id;
        console.log('[SpectreQA] Proyecto confirmado:', this.projectId);
        break;

      default:
        break;
    }
  }

  sendToBackground(type, payload = {}) {
    if (!this.port) {
      console.error('[SpectreQA] No hay conexión con background');
      return;
    }
    try {
      this.port.postMessage({ type, ...payload });
    } catch (error) {
      console.error('[SpectreQA] Error al enviar mensaje:', error);
      this.#handleDisconnect();
    }
  }

  destroy() {
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
    if (this.port) {
      try {
        this.port.onMessage.removeListener(this.#handleBackgroundMessageBound);
        this.port.onDisconnect.removeListener(this.#handleDisconnectBound);
        this.port.disconnect();
      } catch (e) { /* el puerto ya podría estar cerrado */ }
      this.port = null;
    }
  }
}

// Instanciación
window.__spectreqa_orchestrator__ = new TaskOrchestrator();