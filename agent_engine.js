// agent_engine.js
// Motor de ejecución de SpectreQA.
// Responsabilidad única: captura de DOM, búsqueda de elementos y ejecución de comandos de la IA.
// El ciclo de vida (run/pause/stop/fases) es responsabilidad exclusiva de task_orchestrator.js.

// Flag de depuración: true solo en desarrollo, para ver logs técnicos detallados.
// Se usa "var" + comprobación porque este archivo se inyecta junto a
// task_orchestrator.js y content_script.js en el mismo contexto de ejecución
// (mismo "isolated world"); declarar la misma constante dos veces ahí
// rompería la inyección entera con un SyntaxError.
if (typeof IS_DEBUG === 'undefined') {
  var IS_DEBUG = false;
}

/**
 * Resumen seguro de un comando para warnings de parseo.
 * Nunca incluye el valor de texto de @Write (puede ser una contraseña).
 */
function summarizeCommand(raw) {
  if (typeof raw !== 'string') return String(raw);
  const match = raw.match(/^(@\w+)\s+([\w-]+)/);
  return match ? `${match[1]} ${match[2]}` : raw.split(/\s+/)[0];
}

// Definición de los selectores de elementos interactivos que la IA puede manipular
const INTERACTIVE_SELECTORS = [
  'input', 'textarea', 'button', 'select',
  'a', '[role="button"]', '[contenteditable="true"]'
];

let visualCursor = null;

function initVisualCursor() {
  if (visualCursor) return;
  visualCursor = document.createElement('div');
  visualCursor.id = 'spectreqa-ai-cursor';
  visualCursor.style.cssText = `
    position: fixed; top: -50px; left: -50px;
    width: 20px; height: 20px; z-index: 2147483647; pointer-events: none;
    transition: transform 0.5s cubic-bezier(0.25, 1, 0.5, 1);
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='black' stroke='white' stroke-width='1.5'><path d='M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z'/></svg>");
    background-size: contain;
    background-repeat: no-repeat;
  `;
  document.documentElement.appendChild(visualCursor);
}

/** @returns {string} slug de la última parte de la ruta actual */
function getRouteSlug() {
  const parts = location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'root';
}

/**
 * Captura todos los elementos del DOM relevantes y los serializa
 * en el formato que espera Rust: { id, content }.
 * El id se construye como "<tag>-<index>-<routeSlug>".
 * Los labels se incluyen para dar contexto a la IA aunque no sean interactivos.
 *
 * @returns {{ id: string, content: string }[]}
 */
function captureDom() {
  const routeSlug = getRouteSlug();
  const serializedElements = [];

  // 1. Elementos interactivos (inputs, botones, etc.)
  const interactiveElements = document.querySelectorAll(INTERACTIVE_SELECTORS.join(','));
  const tagCounters = {};

  interactiveElements.forEach((el) => {
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

    serializedElements.push({
      id: generatedId,
      content: content,
    });
  });

  // 2. Elementos <label> como contexto adicional (no interactivos)
  const labels = document.querySelectorAll('label');
  let labelCounter = 0;
  labels.forEach((label) => {
    if (label.closest('#spectreqa-menu') || label.closest('#spectreqa-glass')) return;
    labelCounter++;
    const labelId = `label-${labelCounter}-${routeSlug}`;
    serializedElements.push({
      id: labelId,
      content: label.innerText.trim(),
    });
  });

  if (IS_DEBUG) console.log('[SpectreQA Engine] DOM snapshot simplificado con labels como elementos separados.');
  return serializedElements;
}

/**
 * Encuentra un elemento del DOM a partir del id generado por captureDom.
 * El id tiene formato "<tag>-<index>-<slug>", donde index empieza en 1.
 * Reconstruye el mismo orden y contadores que usó captureDom.
 *
 * @param {string} backendId — ej: "input-text-1-login", "button-1-login"
 * @returns {Element|null}
 */
function findElementById(backendId) {
  // Buscar el primer segmento numérico (índice)
  const parts = backendId.split('-');
  const numPos = parts.findIndex(p => /^\d+$/.test(p));
  if (numPos === -1) return null;

  // Tag = partes antes del índice, unidas con '-', luego normalizado a la primera palabra
  const rawTag = parts.slice(0, numPos).join('-');
  const normalizedTag = rawTag.split('-')[0]; // "input-text" -> "input", "button" -> "button"
  const targetIndex = parseInt(parts[numPos], 10);

  const selector = INTERACTIVE_SELECTORS.join(', ');
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

/**
 * Fallback: encuentra un elemento por atributos cuando findElementById falla.
 *
 * @param {{ tag?, text?, role?, name?, placeholder?, type? }} query
 * @returns {Element|null}
 */
function findElementByQuery(query) {
  const selector = INTERACTIVE_SELECTORS.join(', ');
  const candidates = Array.from(document.querySelectorAll(selector));
  return candidates.find((el) => {
    if (query.tag         && el.tagName.toLowerCase() !== query.tag.toLowerCase()) return false;
    if (query.role        && el.getAttribute('role') !== query.role)               return false;
    if (query.name        && el.name !== query.name)                               return false;
    if (query.type        && el.type !== query.type)                               return false;
    if (query.placeholder && !el.placeholder?.includes(query.placeholder))         return false;
    if (query.text        && !el.innerText?.trim().includes(query.text))           return false;
    return true;
  }) ?? null;
}

/** Elemento actualmente "apuntado" por el cursor visual */
let _focusedElement = null;

/**
 * Mueve el cursor visual al elemento indicado, hace scroll si es necesario
 * y lo deja como _focusedElement para los comandos que actúan sobre él.
 *
 * @param {string} targetId
 */
async function cmdMoveCursor(targetId) {
  initVisualCursor();
  const el = findElementById(targetId);
  if (!el) {
    console.warn('[SpectreQA] @MoveCursor: no se encontró el elemento', targetId);
    return;
  }
  _focusedElement = el;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await cmdWait(400);
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  visualCursor.style.transform = `translate(${cx}px, ${cy}px)`;
  if (IS_DEBUG) console.log(`[SpectreQA] @MoveCursor → ${targetId} en [${cx}, ${cy}]`);
}

/**
 * @Click <id>
 * Mueve el cursor al elemento y hace click.
 *
 * @param {string} targetId
 */
async function cmdClick(targetId) {
  await cmdMoveCursor(targetId);
  const el = _focusedElement;
  if (!el) return;
  el.focus?.();
  el.click();
  console.log(`[SpectreQA] @Click → ${targetId}`);
}

/**
 * @Write <id> "<text>"
 * Mueve el cursor al elemento y escribe el texto.
 * Compatible con React, Vue y otros frameworks que usan setters nativos.
 *
 * @param {string} targetId
 * @param {string} text
 */
async function cmdWrite(targetId, text) {
  await cmdMoveCursor(targetId);
  const el = _focusedElement;
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
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  console.log(`[SpectreQA] @Write → ${targetId}`);
}

/**
 * @WriteRandom <id> <len>
 * Escribe una cadena aleatoria de letras y números.
 *
 * @param {string} targetId
 * @param {number} len
 */
async function cmdWriteRandom(targetId, len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const text = Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  await cmdWrite(targetId, text);
}

/**
 * @WriteRandomNum <id> <len>
 * Escribe una cadena aleatoria de dígitos.
 *
 * @param {string} targetId
 * @param {number} len
 */
async function cmdWriteRandomNum(targetId, len) {
  const text = Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join('');
  await cmdWrite(targetId, text);
}

/**
 * @Wait <ms>
 * Pausa la ejecución.
 *
 * @param {number} ms
 */
function cmdWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parsea y ejecuta una lista de comandos secuencialmente.
 * Formato nuevo (con id en cada comando):
 *   @Click button-1-login
 *   @Write input-1-login "texto"
 *   @WriteRandom input-1-login 10
 *   @WriteRandomNum input-2-login 6
 *   @Wait 500
 *   @MoveCursor button-1-login   ← solo mueve el cursor, sin acción
 *
 * @param {string[]} commands
 */
async function executeCommands(commands) {
  for (const raw of commands) {
    const cmd = raw.trim();

    if (cmd.startsWith('@Click ')) {
      const id = cmd.slice('@Click '.length).trim();
      await cmdClick(id);

    } else if (cmd.startsWith('@Write ')) {
      // @Write <id> "<text>"
      const match = cmd.match(/^@Write\s+([\w\-]+)\s+"(.*)"\s*$/);
      if (match) await cmdWrite(match[1], match[2]);
      else console.warn('[SpectreQA] @Write con formato inválido:', summarizeCommand(cmd));

    } else if (cmd.startsWith('@WriteRandom ')) {
      // @WriteRandom <id> <len>
      const parts = cmd.split(/\s+/);
      if (parts.length === 3) await cmdWriteRandom(parts[1], parseInt(parts[2], 10));
      else console.warn('[SpectreQA] @WriteRandom con formato inválido:', cmd);

    } else if (cmd.startsWith('@WriteRandomNum ')) {
      // @WriteRandomNum <id> <len>
      const parts = cmd.split(/\s+/);
      if (parts.length === 3) await cmdWriteRandomNum(parts[1], parseInt(parts[2], 10));
      else console.warn('[SpectreQA] @WriteRandomNum con formato inválido:', cmd);

    } else if (cmd.startsWith('@Wait ')) {
      const ms = parseInt(cmd.split(' ')[1], 10);
      if (!isNaN(ms)) await cmdWait(ms);

    } else if (cmd.startsWith('@MoveCursor ')) {
      const id = cmd.slice('@MoveCursor '.length).trim();
      await cmdMoveCursor(id);

    } else {
      console.warn('[SpectreQA] Comando desconocido:', summarizeCommand(cmd));
    }
  }
}

window.__spectreqa_engine__ = {
  captureDom,
  getRouteSlug,
  findElementById,
  findElementByQuery,
  cmdMoveCursor,
  cmdClick,
  cmdWrite,
  cmdWriteRandom,
  cmdWriteRandomNum,
  cmdWait,
  executeCommands,
};