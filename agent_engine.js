/** agenteDeComandos.js */
/**
 * AgentEngine
 *
 * Clase utilitaria 100% estática.
 * Responsabilidad única: Interacción directa con el DOM (buscar, leer, escribir, clickear).
 * No guarda estado de la prueba, no sabe de fases ni de ciclos de vida.
 */

/**
 * Flag de depuración: se usa "var" + comprobación porque este archivo se
 * inyecta junto a cicloDeVida.js, task_orchestrator.js y content_script.js
 * en el mismo contexto de ejecución (mismo "isolated world"); declarar la
 * misma constante dos veces ahí rompería la inyección entera con un SyntaxError.
 */
if (typeof IS_DEBUG === 'undefined') {
  var IS_DEBUG = true;
}

class AgentEngine {
  static #INTERACTIVE_SELECTORS = [
    'input', 'textarea', 'button', 'select',
    'a', '[role="button"]', '[contenteditable="true"]'
  ];

  static #visualCursor = null;
  static #focusedElement = null;

  // --- Utilidades del DOM ---

  /**
   * Resumen seguro de un comando para warnings de parseo.
   * Nunca incluye el valor de texto de @Write (puede ser una contraseña).
   * @param {string} raw - Comando crudo
   * @returns {string} - Comando resumido
   */
  static #summarizeCommand(raw) {
    if (typeof raw !== 'string') return String(raw);
    const match = raw.match(/^(@\w+)\s+([\w-]+)/);
    return match ? `${match[1]} ${match[2]}` : raw.split(/\s+/)[0];
  }

  /**
   * Inicializa el cursor visual SVG que sigue al elemento que la IA está manipulando.
   * Se inyecta en el DOM con pointer-events: none para no interferir con la página.
   */
  static initVisualCursor() {
    if (AgentEngine.#visualCursor) return;
    const cursor = document.createElement('div');
    cursor.id = 'spectreqa-ai-cursor';
    cursor.style.cssText = `
      position: fixed; top: -50px; left: -50px;
      width: 20px; height: 20px; z-index: 2147483647; pointer-events: none;
      transition: transform 0.5s cubic-bezier(0.25, 1, 0.5, 1);
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='black' stroke='white' stroke-width='1.5'><path d='M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z'/></svg>");
      background-size: contain;
      background-repeat: no-repeat;
    `;
    document.documentElement.appendChild(cursor);
    AgentEngine.#visualCursor = cursor;
  }

  /**
   * Obtiene un slug de la última parte de la ruta actual.
   * Usado para generar IDs únicos por página.
   * @returns {string} - Slug de la ruta
   */
  static getRouteSlug() {
    const parts = location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : 'root';
  }

  /**
   * Captura todos los elementos del DOM relevantes y los serializa
   * en el formato que espera Rust: { id, content }.
   * El id se construye como "<tag>-<index>-<routeSlug>".
   * Los labels se incluyen para dar contexto a la IA aunque no sean interactivos.
   * @returns {{ id: string, content: string }[]}
   */
  static captureDom() {
    const routeSlug = AgentEngine.getRouteSlug();
    const serializedElements = [];

    // 1. Elementos interactivos (inputs, botones, etc.)
    const interactiveElements = document.querySelectorAll(AgentEngine.#INTERACTIVE_SELECTORS.join(','));
    const tagCounters = {};

    interactiveElements.forEach((el) => {
      // Omitir elementos propios de la extensión
      if (el.closest('#spectreqa-menu') || el.closest('#spectreqa-glass')) return;
      const tagName = el.tagName.toLowerCase();
      if (tagCounters[tagName] === undefined) tagCounters[tagName] = 0;
      tagCounters[tagName]++;

      const generatedId = `${tagName}-${tagCounters[tagName]}-${routeSlug}`;
      el.dataset.spectreqaId = generatedId;

      let content = '';
      if (tagName === 'input' || tagName === 'textarea') {
        content = el.value;
      } else {
        content = el.innerText.trim();
      }

      serializedElements.push({ id: generatedId, content });
    });

    // 2. Elementos <label> como contexto adicional (no interactivos)
    const labels = document.querySelectorAll('label');
    let labelCounter = 0;
    labels.forEach((label) => {
      if (label.closest('#spectreqa-menu') || label.closest('#spectreqa-glass')) return;
      labelCounter++;
      const labelId = `label-${labelCounter}-${routeSlug}`;
      serializedElements.push({ id: labelId, content: label.innerText.trim() });
    });

    if (IS_DEBUG) console.log('[SpectreQA Engine] DOM snapshot simplificado con labels como elementos separados.');
    return serializedElements;
  }

  /**
   * Encuentra un elemento del DOM a partir del id generado por captureDom.
   * El id tiene formato "<tag>-<index>-<slug>", donde index empieza en 1.
   * Reconstruye el mismo orden y contadores que usó captureDom.
   * @param {string} backendId — ej: "input-1-login", "button-1-login"
   * @returns {Element|null}
   */
  static findElementById(backendId) {
    const parts = backendId.split('-');
    const numPos = parts.findIndex((p) => /^\d+$/.test(p));
    if (numPos === -1) return null;

    const rawTag = parts.slice(0, numPos).join('-');
    const normalizedTag = rawTag.split('-')[0]; // "input-text" -> "input", "button" -> "button"
    const targetIndex = parseInt(parts[numPos], 10);

    const selector = AgentEngine.#INTERACTIVE_SELECTORS.join(', ');
    const allElements = Array.from(document.querySelectorAll(selector));

    let count = 0;
    for (const el of allElements) {
      const elTag = el.tagName.toLowerCase();
      if (elTag === normalizedTag) {
        count++;
        if (count === targetIndex) {
          if (IS_DEBUG) console.log(`[SpectreQA] Encontrado: ${backendId} -> ${elTag}-${count}`);
          return el;
        }
      }
    }

    if (IS_DEBUG) console.warn(`[SpectreQA] No encontrado: ${backendId} (tag=${normalizedTag}, index=${targetIndex})`);
    return null;
  }

  // --- Ejecución de Comandos Individuales ---

  /**
   * Mueve el cursor visual al elemento indicado, hace scroll si es necesario
   * y lo deja como #focusedElement para los comandos que actúan sobre él.
   * @param {string} targetId - ID del elemento destino
   */
  static async cmdMoveCursor(targetId) {
    AgentEngine.initVisualCursor();
    const el = AgentEngine.findElementById(targetId);
    if (!el) {
      console.warn('[SpectreQA] @MoveCursor: no se encontró el elemento', targetId);
      return;
    }
    AgentEngine.#focusedElement = el;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await AgentEngine.cmdWait(400);
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    AgentEngine.#visualCursor.style.transform = `translate(${cx}px, ${cy}px)`;
    if (IS_DEBUG) console.log(`[SpectreQA] @MoveCursor → ${targetId} en [${cx}, ${cy}]`);
  }

  /**
   * Determina si un elemento, al ser clickeado, va a disparar una navegación
   * de la pestaña (link real). Se excluyen anclas de sección (#...), links
   * "javascript:" (no navegan) y links con target="_blank" (abren pestaña
   * nueva, no destruyen el contexto actual).
   * @param {Element} el
   * @returns {boolean}
   */
  static #isNavigationLink(el) {
    if (!el || el.tagName !== 'A') return false;
    const href = el.getAttribute('href');
    if (!href) return false;
    const trimmed = href.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.toLowerCase().startsWith('javascript:')) {
      return false;
    }
    if (el.target === '_blank') return false;
    return true;
  }

  /**
   * @Click <id> — Mueve el cursor al elemento y hace click.
   * Devuelve { navigated } para que el orquestador sepa si debe detener
   * inmediatamente el resto de la fase: un link real destruye el contexto
   * de la página, así que cualquier comando posterior en la misma fase
   * (ej. un @Write que la IA agregó "adelantándose") ya no tiene sentido
   * y podría fallar o interactuar con la página equivocada.
   * @param {string} targetId
   * @returns {Promise<{navigated: boolean}>}
   */
  static async cmdClick(targetId) {
    await AgentEngine.cmdMoveCursor(targetId);
    const el = AgentEngine.#focusedElement;
    if (!el) return { navigated: false };

    const willNavigate = AgentEngine.#isNavigationLink(el);

    el.focus?.();
    el.click();
    console.log(`[SpectreQA] @Click → ${targetId}`);

    if (willNavigate) {
      console.log(`[SpectreQA] @Click → ${targetId} es un link real (href). Se descartará el resto de comandos pendientes de esta fase.`);
    }

    return { navigated: willNavigate };
  }

  /**
   * @Write <id> "<text>" — Mueve el cursor al elemento y escribe el texto.
   * Compatible con React, Vue y otros frameworks que usan setters nativos.
   * @param {string} targetId
   * @param {string} text
   */
  static async cmdWrite(targetId, text) {
    await AgentEngine.cmdMoveCursor(targetId);
    const el = AgentEngine.#focusedElement;
    if (!el) return;
    el.focus?.();

    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (el.tagName === 'SELECT') {
      const opt = Array.from(el.options).find((o) => o.text === text || o.value === text);
      if (opt) {
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else {
      const nativeInputValueSetter =
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ??
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    console.log(`[SpectreQA] @Write → ${targetId}`);
  }

  /**
   * @WriteRandom <id> <len> — Escribe una cadena aleatoria de letras y números.
   * @param {string} targetId
   * @param {number} len
   */
  static async cmdWriteRandom(targetId, len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const text = Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    await AgentEngine.cmdWrite(targetId, text);
  }

  /**
   * @WriteRandomNum <id> <len> — Escribe una cadena aleatoria de dígitos.
   * @param {string} targetId
   * @param {number} len
   */
  static async cmdWriteRandomNum(targetId, len) {
    const text = Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join('');
    await AgentEngine.cmdWrite(targetId, text);
  }

  /**
   * @Wait <ms> — Pausa la ejecución.
   * @param {number} ms
   */
  static cmdWait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Punto de entrada del parser ---

  /**
   * Parsea y ejecuta una lista de comandos secuencialmente.
   * Formato (con id en cada comando):
   *   @Click button-1-login
   *   @Write input-1-login "texto"
   *   @WriteRandom input-1-login 10
   *   @WriteRandomNum input-2-login 6
   *   @Wait 500
   *   @MoveCursor button-1-login   ← solo mueve el cursor, sin acción
   *
   * Si un @Click dispara una navegación real (link con href), se corta la
   * ejecución del resto del batch de inmediato: los comandos siguientes
   * fueron pensados para el DOM actual y ya no aplican una vez que la
   * página empieza a navegar.
   * @param {string[]} commands
   * @returns {Promise<{navigated: boolean}>}
   */
  static async executeCommands(commands) {
    for (const raw of commands) {
      const cmd = raw.trim();

      if (cmd.startsWith('@Click ')) {
        const id = cmd.slice('@Click '.length).trim();
        const result = await AgentEngine.cmdClick(id);
        if (result?.navigated) {
          return { navigated: true };
        }

      } else if (cmd.startsWith('@Write ')) {
        // @Write <id> "<text>"
        const match = cmd.match(/^@Write\s+([\w\-]+)\s+"(.*)"\s*$/);
        if (match) await AgentEngine.cmdWrite(match[1], match[2]);
        else console.warn('[SpectreQA] @Write con formato inválido:', AgentEngine.#summarizeCommand(cmd));

      } else if (cmd.startsWith('@WriteRandom ')) {
        const parts = cmd.split(/\s+/);
        if (parts.length === 3) await AgentEngine.cmdWriteRandom(parts[1], parseInt(parts[2], 10));
        else console.warn('[SpectreQA] @WriteRandom con formato inválido:', cmd);

      } else if (cmd.startsWith('@WriteRandomNum ')) {
        const parts = cmd.split(/\s+/);
        if (parts.length === 3) await AgentEngine.cmdWriteRandomNum(parts[1], parseInt(parts[2], 10));
        else console.warn('[SpectreQA] @WriteRandomNum con formato inválido:', cmd);

      } else if (cmd.startsWith('@Wait ')) {
        const ms = parseInt(cmd.split(' ')[1], 10);
        if (!isNaN(ms)) await AgentEngine.cmdWait(ms);

      } else if (cmd.startsWith('@MoveCursor ')) {
        const id = cmd.slice('@MoveCursor '.length).trim();
        await AgentEngine.cmdMoveCursor(id);

      } else {
        console.warn('[SpectreQA] Comando desconocido:', AgentEngine.#summarizeCommand(cmd));
      }
    }

    return { navigated: false };
  }
}

// Exposición global para el orquestador
window.__spectreqa_engine__ = AgentEngine;