/** cicloDeVida.js */
/**
 * LifeCicle
 *
 * Único lugar donde vive el estado del ciclo de vida y sus constantes.
 * Todo es estático a propósito: no hay instancias, no hay DI, solo un objeto
 * central donde queda claro qué existe y para qué sirve cada cosa.
 */
class LifeCicle {
  static #LIFECYCLE_EVENT_NAME = '__spectreqa_lifecycle_event__';
  static #UNEXPECTED_ERROR_EVENT_NAME = '__spectreqa_error_unexpected__';
  static #EXTENSION_READY_EVENT_NAME = '__spectreqa_extension_ready__';

  static #LIFECYCLE_STATUS = Object.freeze({
    IDLE: 'IDLE',
    RUNNING: 'RUNNING',
    WAITING: 'WAITING',
    PAUSED: 'PAUSED',
    SUCCESS: 'SUCCESS',
    ERROR: 'ERROR',
    TERMINATED: 'TERMINATED'
  });

  static #RUST_FLAG = Object.freeze({
    ASYNC_WAIT: 'ASYNC_WAIT',
    ASYNC_CONTINUE: 'ASYNC_CONTINUE',
    TEST_COMPLETE: 'TEST_COMPLETE',
    EXTENSION_FAILURE: 'EXTENSION_FAILURE'
  });

  static #LIFECYCLE_EVENT_TYPE = Object.freeze({
    WAIT: 'WAIT',
    CONTINUE: 'CONTINUE',
    RESUME: 'RESUME',
    TEST_COMPLETE: 'TEST_COMPLETE',
    ERROR: 'ERROR',
    PAUSE: 'PAUSE',
    TERMINATE: 'TERMINATE'
  });

  // --- estado mutable ---
  static #status = LifeCicle.#LIFECYCLE_STATUS.IDLE;
  static #isPaused = false;
  static #isWaiting = false;
  static #currentPhase = 0;
  static #lastFlagSent = null;
  static #lastStatusMessage = null;
  /** no hay una lista de eventos: si se emite otro evento en PAUSED, sobreescribe al anterior */
  static #currentEvent = null;

  // --- constantes (solo lectura, sin setter: son Object.freeze) ---
  static get eventName() { return this.#LIFECYCLE_EVENT_NAME; }
  static get unexpectedErrorEventName() { return this.#UNEXPECTED_ERROR_EVENT_NAME; }
  static get extensionReadyEventName() { return this.#EXTENSION_READY_EVENT_NAME; }
  static get status_enum() { return this.#LIFECYCLE_STATUS; }
  static get flag() { return this.#RUST_FLAG; }
  static get eventType() { return this.#LIFECYCLE_EVENT_TYPE; }

  // --- estado mutable ---
  static get status() { return this.#status; }
  static set status(value) { this.#status = value; }

  static get isPaused() { return this.#isPaused; }
  static set isPaused(value) { this.#isPaused = value; }

  static get isWaiting() { return this.#isWaiting; }
  static set isWaiting(value) { this.#isWaiting = value; }

  static get currentPhase() { return this.#currentPhase; }
  static set currentPhase(value) { this.#currentPhase = value; }

  static get lastFlagSent() { return this.#lastFlagSent; }
  static set lastFlagSent(value) { this.#lastFlagSent = value; }

  static get lastStatusMessage() { return this.#lastStatusMessage; }
  static set lastStatusMessage(value) { this.#lastStatusMessage = value; }

  static get currentEvent() { return this.#currentEvent; }
  static set currentEvent(value) { this.#currentEvent = value; }

  /** Snapshot de depuración, útil para loguear o inspeccionar en consola. */
  static snapshot() {
    return {
      status: this.#status,
      isPaused: this.#isPaused,
      isWaiting: this.#isWaiting,
      currentPhase: this.#currentPhase,
      lastFlagSent: this.#lastFlagSent,
      lastStatusMessage: this.#lastStatusMessage,
      hasPendingEvent: this.#currentEvent !== null
    };
  }

  /** Reset para una nueva prueba. */
  static reset() {
    this.#status = this.#LIFECYCLE_STATUS.IDLE;
    this.#isPaused = false;
    this.#isWaiting = false;
    this.#currentPhase = 0;
    this.#lastFlagSent = null;
    this.#lastStatusMessage = null;
    this.#currentEvent = null;
  }
}

/**
 * LifecycleManager
 *
 * Clase estática, sin instancias, sin inyección de dependencias: recibe la
 * referencia al orquestador una sola vez vía attachOrchestrator() y a partir
 * de ahí todo se resuelve contra ese global.
 *
 * NOTA / SUPUESTO: mientras no tenga la versión estática de task_orchestrator.js,
 * asumo que expone esta interfaz (la misma que usaba la versión con instancias):
 *   TaskOrchestrator.getState()              -> { status, ... }
 *   TaskOrchestrator.pause()
 *   TaskOrchestrator.resume()
 *   TaskOrchestrator.completeSuccess()
 *   TaskOrchestrator.completeWithError(msg)
 *   TaskOrchestrator.captureAndSendDom()
 *   TaskOrchestrator.sendToBackground(type, payload)
 *   TaskOrchestrator.terminate(reason, phase)
 * Si el nombre real difiere, solo hay que ajustar `LifecycleManager.orchestrator`.
 */
class LifecycleManager {
  /** Referencia estática al comunicador (TaskOrchestrator). Nula hasta attachOrchestrator(). */
  static orchestrator = null;

  static attachOrchestrator(orchestrator) {
    this.orchestrator = orchestrator;
    if (IS_DEBUG) console.log('[SpectreQA] LifecycleManager vinculado al orquestador');
  }

  static #isOrchestratorFinished() {
    if (!this.orchestrator) return false;
    const { status } = this.orchestrator.getState();
    return status === 'TERMINATED' || status === 'SUCCESS';
  }

  static #sendFlag(flag, payload) {
    LifeCicle.lastFlagSent = flag;
    this.orchestrator.sendToBackground('TEST_STATUS_UPDATE', { ...payload, flag });
  }

  /**
   * Punto de entrada único: recibe el CustomEvent crudo y decide qué hacer.
   * Es lo único que debería llamar el listener de window.
   */
  static handleEvent(event) {
    const detail = event.detail || {};
    const newStatus = detail.status;

    if (IS_DEBUG) console.log('[SpectreQA] Evento de ciclo de vida recibido:', newStatus, detail.message || '');

    if (!this.orchestrator) {
      console.warn('[SpectreQA] Orquestador no disponible, evento ignorado');
      return;
    }

    if (this.#isOrchestratorFinished()) {
      if (IS_DEBUG) console.log('[SpectreQA] Evento ignorado: orquestador ya finalizado');
      return;
    }

    // En PAUSED, todo evento que no sea CONTINUE, RESUME o TERMINATE se guarda
    // (sobreescribiendo el anterior) para reproducirse cuando se resuelva la
    // pausa. TERMINATE nunca espera: detener la prueba debe funcionar de
    // inmediato, sin importar si está pausada.
    if (
      LifeCicle.isPaused &&
      newStatus !== LifeCicle.eventType.CONTINUE &&
      newStatus !== LifeCicle.eventType.RESUME &&
      newStatus !== LifeCicle.eventType.TERMINATE
    ) {
      LifeCicle.currentEvent = detail;
      if (IS_DEBUG) console.log('[SpectreQA] Evento guardado (estado PAUSED), sobreescribe al anterior:', newStatus);
      return;
    }

    switch (newStatus) {
      case LifeCicle.eventType.WAIT:
        this.wait(detail);
        break;
      case LifeCicle.eventType.CONTINUE:
        this.continue(detail);
        break;
      case LifeCicle.eventType.RESUME:
        this.resume(detail);
        break;
      case LifeCicle.eventType.TEST_COMPLETE:
        this.testComplete(detail);
        break;
      case LifeCicle.eventType.ERROR:
        this.error(detail);
        break;
      case LifeCicle.eventType.PAUSE:
        this.pause(detail);
        break;
      case LifeCicle.eventType.TERMINATE:
        this.terminate(detail);
        break;
      default:
        console.warn('[SpectreQA] Evento de ciclo de vida desconocido:', newStatus);
    }
  }

  /**
   * PAUSA: click del usuario en pausar. Detiene indefinidamente la ejecución;
   * el último comando en curso, si lo hay, termina de ejecutarse.
   * Envía ASYNC_WAIT a Rust (misma bandera que WAIT: para Rust, ambos casos
   * significan "no dispares el watchdog todavía").
   *
   * Puede pausar tanto desde RUNNING como desde WAITING: isPaused e isWaiting
   * son flags independientes, así que un WAIT activo (por navegación, por
   * ejemplo) no impide que el usuario también quiera pausar manualmente.
   */
  static pause(detail = {}) {
    const message = detail.message || 'Pausa manual desde la UI';
    const phase = detail.phase ?? LifeCicle.currentPhase;
    const currentStatus = this.orchestrator.getState().status;

    if (currentStatus !== 'RUNNING' && currentStatus !== 'WAITING') {
      console.warn('[SpectreQA] PAUSE ignorado: orquestador no está en RUNNING ni en WAITING');
      return;
    }

    if (LifeCicle.isPaused) {
      if (IS_DEBUG) console.log('[SpectreQA] PAUSE ignorado: ya estaba pausado');
      return;
    }

    console.log('[SpectreQA] PAUSE - Pausa manual:', message);

    LifeCicle.status = LifeCicle.status_enum.PAUSED;
    LifeCicle.isPaused = true;
    LifeCicle.currentPhase = phase;
    LifeCicle.lastStatusMessage = message;

    this.orchestrator.pause();

    this.#sendFlag(LifeCicle.flag.ASYNC_WAIT, { status: 'PAUSED', phase, message });
  }

  /**
   * CONTINUAR: resuelve un WAIT (lo emite el QA, o el sistema cuando termina
   * de esperar). Solo toca isWaiting; si isPaused sigue activo (pausa manual
   * separada), la ejecución se queda en PAUSED en vez de reanudar de verdad.
   */
  static continue(detail = {}) {
    const message = detail.message || 'Reanudando desde WAIT';
    const phase = detail.phase ?? LifeCicle.currentPhase;

    if (!LifeCicle.isWaiting) {
      console.warn('[SpectreQA] CONTINUE ignorado: no está en WAITING');
      return;
    }

    console.log('[SpectreQA] CONTINUE - Resolviendo WAIT:', message);

    LifeCicle.isWaiting = false;
    LifeCicle.currentPhase = phase;
    LifeCicle.lastStatusMessage = message;

    this.#resolveIfFullyClear(phase, message);
  }

  /**
   * REANUDAR: click del usuario en continuar tras una pausa manual. Solo toca
   * isPaused; si isWaiting sigue activo (por ejemplo, seguimos esperando una
   * navegación), la ejecución se queda en WAITING en vez de reanudar de verdad.
   * También reproduce el evento que haya quedado guardado durante la pausa.
   */
  static resume(detail = {}) {
    const message = detail.message || 'Reanudando desde pausa manual';
    const phase = detail.phase ?? LifeCicle.currentPhase;
    const pending = LifeCicle.currentEvent;

    if (!LifeCicle.isPaused) {
      console.warn('[SpectreQA] RESUME ignorado: no está en PAUSED');
      return;
    }

    console.log('[SpectreQA] RESUME - Resolviendo pausa manual:', message);

    LifeCicle.isPaused = false;
    LifeCicle.currentEvent = null;
    LifeCicle.currentPhase = phase;
    LifeCicle.lastStatusMessage = message;

    if (pending) {
      // Un evento llegó mientras estábamos pausados: se procesa ya, en vez de
      // reanudar nosotros mismos (ese evento decide qué pasa a continuación).
      this.handleEvent({ detail: pending });
      return;
    }

    this.#resolveIfFullyClear(phase, message);
  }

  /**
   * Si tanto isPaused como isWaiting ya están en false, ahora sí reanuda de
   * verdad: status a RUNNING, se le avisa al orquestador y se notifica a Rust.
   * Si todavía queda alguno de los dos activo, el status refleja cuál sigue
   * bloqueando y no se manda nada (Rust ya sabe que seguimos esperando).
   */
  static #resolveIfFullyClear(phase, message) {
    if (LifeCicle.isPaused) {
      LifeCicle.status = LifeCicle.status_enum.PAUSED;
      return;
    }
    if (LifeCicle.isWaiting) {
      LifeCicle.status = LifeCicle.status_enum.WAITING;
      return;
    }

    LifeCicle.status = LifeCicle.status_enum.RUNNING;
    this.orchestrator.resume();
    this.#sendFlag(LifeCicle.flag.ASYNC_CONTINUE, { status: 'RUNNING', phase, message });

    setTimeout(() => {
      this.orchestrator.captureAndSendDom();
    }, 300);
  }

  /**
   * ERROR: puede venir del backend o de un evento explícito del QA.
   * Detiene la ejecución y marca la prueba como error.
   */
  static error(detail = {}) {
    const message = detail.message || 'Error controlado en la aplicación';
    const phase = detail.phase ?? LifeCicle.currentPhase;

    if (this.#isOrchestratorFinished()) {
      if (IS_DEBUG) console.log('[SpectreQA] ERROR ignorado: prueba ya finalizada');
      return;
    }

    console.log('[SpectreQA] ERROR - Fallo controlado:', message);

    LifeCicle.status = LifeCicle.status_enum.ERROR;
    LifeCicle.isWaiting = false;
    LifeCicle.currentPhase = phase;
    LifeCicle.lastStatusMessage = message;

    this.#sendFlag(LifeCicle.flag.EXTENSION_FAILURE, { status: 'TEST_ERROR', phase, message });

    this.orchestrator.completeWithError(message);
  }

  /**
   * TEST_COMPLETE: el QA emitió el evento de éxito explícito.
   * Detiene la ejecución y marca la prueba como completada.
   */
  static testComplete(detail = {}) {
    const message = detail.message || 'Prueba completada con éxito';
    const phase = detail.phase ?? LifeCicle.currentPhase;

    if (this.#isOrchestratorFinished()) {
      if (IS_DEBUG) console.log('[SpectreQA] TEST_COMPLETE ignorado: prueba ya finalizada');
      return;
    }

    console.log('[SpectreQA] TEST_COMPLETE - Éxito explícito:', message);

    LifeCicle.status = LifeCicle.status_enum.SUCCESS;
    LifeCicle.isWaiting = false;
    LifeCicle.currentPhase = phase;
    LifeCicle.lastStatusMessage = message;

    this.#sendFlag(LifeCicle.flag.TEST_COMPLETE, { status: 'TEST_SUCCESS', phase, message });

    this.orchestrator.completeSuccess();
  }

  /**
   * WAIT: viaje a otra página, recarga de la app, o el QA emitió WAIT por un
   * motivo async. Puede activarse tanto desde RUNNING como desde PAUSED (una
   * pausa manual no debería impedir registrar que además hay un WAIT en curso).
   */
  static wait(detail = {}) {
    const message = detail.message || 'Esperando evento asíncrono';
    const phase = detail.phase ?? LifeCicle.currentPhase;
    const currentStatus = this.orchestrator.getState().status;

    if (currentStatus !== 'RUNNING' && currentStatus !== 'PAUSED') {
      console.warn('[SpectreQA] WAIT ignorado: orquestador no está en RUNNING ni en PAUSED');
      return;
    }

    if (LifeCicle.isWaiting) {
      if (IS_DEBUG) console.log('[SpectreQA] WAIT ignorado: ya estaba esperando');
      return;
    }

    console.log('[SpectreQA] WAIT - Pausando ejecución:', message);

    LifeCicle.isWaiting = true;
    LifeCicle.currentPhase = phase;
    LifeCicle.lastStatusMessage = message;

    if (!LifeCicle.isPaused) {
      LifeCicle.status = LifeCicle.status_enum.WAITING;
    }

    this.orchestrator.pause();

    this.#sendFlag(LifeCicle.flag.ASYNC_WAIT, { status: 'WAITING', phase, message });
  }

  /**
   * TERMINATE: el usuario le dio click a "Detener" en el menú flotante.
   * A diferencia de ERROR, esto no es un fallo: es una detención voluntaria.
   * Limpia todo y notifica a Rust con TEST_TERMINATED (no con EXTENSION_FAILURE).
   */
  static terminate(detail = {}) {
    const message = detail.message || 'Usuario detuvo la prueba';
    const phase = detail.phase ?? LifeCicle.currentPhase;

    console.log('[SpectreQA] TERMINATE - Detención voluntaria:', message);

    LifeCicle.status = LifeCicle.status_enum.TERMINATED;
    LifeCicle.isWaiting = false;
    LifeCicle.isPaused = false;
    LifeCicle.currentEvent = null;
    LifeCicle.lastStatusMessage = message;

    LifecycleManager.orchestrator.terminate(message, phase);
  }

  /**
   * Fallo inesperado (excepción no controlada, crash del engine, etc.).
   * A diferencia de error(), no respeta la cola de PAUSED: un fallo inesperado
   * se reporta de inmediato, sin importar el estado, porque silenciarlo
   * mientras se espera un CONTINUE podría dejar la prueba colgada para siempre.
   */
  static unexpectedFailure(detail = {}) {
    const message = detail.message || 'Fallo inesperado en la extensión';

    console.error('[SpectreQA] Fallo inesperado:', message);

    if (!this.orchestrator) {
      console.error('[SpectreQA] Orquestador no disponible, no se pudo reportar el fallo');
      return;
    }

    LifeCicle.status = LifeCicle.status_enum.ERROR;
    LifeCicle.lastStatusMessage = message;

    this.#sendFlag(LifeCicle.flag.EXTENSION_FAILURE, {
      status: 'TEST_ERROR',
      phase: LifeCicle.currentPhase,
      message
    });

    this.orchestrator.completeWithError(message);
  }
}

/** listener de eventos emitidos por el QA: delega todo en LifecycleManager */
window.addEventListener(LifeCicle.eventName, (event) => {
  LifecycleManager.handleEvent(event);
});

/** listener de fallos inesperados: notifica a Rust sin pasar por la cola de PAUSED */
window.addEventListener(LifeCicle.unexpectedErrorEventName, (event) => {
  LifecycleManager.unexpectedFailure(event.detail || {});
});

/**
 * Avisa a la aplicación bajo prueba que el listener de ciclo de vida ya está
 * registrado. Antes, una página que disparaba WAIT de forma síncrona en
 * cuanto cargaba (por ejemplo, tras una reinyección post-navegación) perdía
 * ese evento sin remedio: se disparaba antes de que este archivo existiera
 * para escucharlo. Con esto, el contrato cambia: la página no debe asumir
 * que la extensión ya está lista — debe esperar este evento primero.
 *
 * Se dispara aquí, inmediatamente después de registrar el listener de
 * arriba, porque es el punto más temprano posible en el que ya podemos
 * recibir un WAIT sin perderlo.
 */
window.dispatchEvent(new CustomEvent(LifeCicle.extensionReadyEventName, {
  detail: { timestamp: Date.now() }
}));

window.__spectreqa_lifecycle__ = LifeCicle;
window.__spectreqa_lifecycle_manager__ = LifecycleManager;