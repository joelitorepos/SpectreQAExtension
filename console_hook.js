/** console_hook.js */

/**
 * Hook para capturar errores y logs de la página.
 * Debe inyectarse con world: 'MAIN'.
 */
(function () {
  if (window.__spectreqa_console_hooked__) return;
  window.__spectreqa_console_hooked__ = true;

  const SUCCESS_MARKER = '__SPECTREQA_SUCCESS__';
  let successAlreadySignaled = false;

  const originalError = console.error.bind(console);
  console.error = function (...args) {
    const message = args.map(a => {
      try { return typeof a === 'string' ? a : JSON.stringify(a); }
      catch { return String(a); }
    }).join(' ');

    window.dispatchEvent(new CustomEvent('__spectreqa_console_error__', {
      detail: { message, timestamp: Date.now() }
    }));

    originalError(...args);
  };

  const originalLog = console.log.bind(console);
  console.log = function (...args) {
    if (!successAlreadySignaled) {
      const joined = args.map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); }
        catch { return String(a); }
      }).join(' ');
      if (joined.includes(SUCCESS_MARKER)) {
        successAlreadySignaled = true;
        window.dispatchEvent(new CustomEvent('__spectreqa_success_signal__', {
          detail: { message: joined, timestamp: Date.now() }
        }));
      }
    }
    originalLog(...args);
  };

  // 🔧 reset del marcador también por evento, ya no por función expuesta
  window.addEventListener('__spectreqa_reset_success__', () => {
    successAlreadySignaled = false;
  });

  window.__SPECTREQA_SUCCESS_MARKER__ = SUCCESS_MARKER;
})();