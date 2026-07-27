/** popup.js */

/**
 * RESPONSABILIDADES
 * Popup de la extensión SpectreQA.
 * Responsabilidad única: manejar la lógica del popup de la extensión.
 * Responsabilidades subyacentes:
 * - permitir o denegar el acceso a la extensión en una pestaña
 * - mostrar el estado de la app de escritorio
 * - mostrar el estado de la prueba
 */

/**
 * COMO SE ESPERA QUE FUNCIONE:
 * al abrir el popup el usuario debe ser capaz de ver si la extensión está conectada correctamente
 * debe contener un botón con el contenido "Activar SpectreQA en esta pestaña"
 * al dar click en el botón la pestaña activa podrá inyectar la UI
 * también habrán permisos opcionales que el usuario deberá aceptar como el permiso de origen para una URL
 */

const IS_DEBUG = false;

/**
 * Asegura el permiso de origen para una URL.
 * @param {string} url - URL para la cual se solicita permiso.
 * @returns {Promise<boolean>} - True si el permiso fue concedido, false en caso contrario.
 */
async function ensureOriginPermission(url) {
  let origin;
  try {
    origin = new URL(url).origin + '/*';
  } catch {
    return false;
  }

  const already = await chrome.permissions.contains({ origins: [origin] });
  if (already) return true;

  // Esto abre el prompt nativo de Chrome pidiendo acceso solo a ese origen.
  // Debe llamarse dentro del gesto de usuario (el click del botón), si no falla.
  return await chrome.permissions.request({ origins: [origin] });
}

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  // Mostrar estado de la app de escritorio (conexión)
  chrome.runtime.sendMessage({ type: "GET_CONNECTION_STATE" }, (res) => {
    const badge = document.getElementById("conn-badge");
    const dot = document.getElementById("conn-dot");
    const text = document.getElementById("conn-text");
    const hint = document.getElementById("hint");
    const auditInfo = document.getElementById("audit-info");

    if (res?.connected) {
      badge.className = "status-badge badge-connected";
      dot.className = "dot dot-on";
      text.textContent = `Puerto ${res.port || '?'}`;
      hint.style.display = "none";

      chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
        if (!activeTab?.url) return;
        chrome.storage.session.get("auditingUrls", ({ auditingUrls = [] }) => {
          const auditing = auditingUrls.some((url) => {
            try {
              const norm = url.startsWith("http") ? url : `http://${url}`;
              return new URL(norm).host === new URL(activeTab.url).host;
            } catch { return false; }
          });
          if (auditing) {
            auditInfo.style.display = "block";
            auditInfo.textContent = `Auditando: ${new URL(activeTab.url).host}`;
          }
        });
      });
    }
  });

  const btn = document.getElementById('toggle-audit-btn');
  try {
    const pingRes = await chrome.tabs.sendMessage(tab.id, { type: "PING_ORCHESTRATOR" });
    if (pingRes && pingRes.alive) {
      btn.innerText = "Desactivar SpectreQA";
      btn.style.background = "#ef4444";
    } else {
      btn.innerText = "Activar SpectreQA en esta pestaña";
      btn.style.background = "#534AB7";
    }
  } catch (e) {
    btn.innerText = "Activar SpectreQA en esta pestaña";
    btn.style.background = "#534AB7";
  }

  btn.addEventListener('click', async () => {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!currentTab?.url) return;

    try {
      const ping = await chrome.tabs.sendMessage(currentTab.id, { type: "PING_ORCHESTRATOR" });
      if (ping && ping.alive) {
        await chrome.tabs.sendMessage(currentTab.id, { type: "AUDIT_STATE", active: false });
        btn.innerText = "Activar SpectreQA en esta pestaña";
        btn.style.background = "#534AB7";
        return;
      }
    } catch (e) {
      if (typeof IS_DEBUG !== 'undefined' && IS_DEBUG) console.error("Error haciendo ping:", e);
      btn.innerText = "Activar SpectreQA en esta pestaña";
      btn.style.background = "#534AB7";
    }

    chrome.runtime.sendMessage(
      { type: 'CHECK_AUDIT_STATE', url: currentTab.url },
      async (res) => {
        if (res && res.active) {
          const granted = await ensureOriginPermission(currentTab.url);
          if (!granted) {
            alert('SpectreQA necesita permiso sobre este sitio para seguir la prueba a través de cambios de página (ej. tras iniciar sesión). Sin este permiso, el test podría detenerse en la primera redirección.');
            return;
          }

          // NOTA: console_hook.js ha sido eliminado
          // FIX: cicloDeVida.js debe inyectarse antes que task_orchestrator.js y
          // content_script.js; ambos leen window.__spectreqa_lifecycle__ /
          // window.__spectreqa_lifecycle_manager__, que solo existen si este
          // archivo ya se cargó.
          chrome.scripting.executeScript({
            target: { tabId: currentTab.id },
            // world por defecto = ISOLATED (necesario para chrome.runtime.connect)
            files: ['cicloDeVida.js', 'agent_engine.js', 'task_orchestrator.js', 'content_script.js']
          }, () => {
            // Enviar mensaje para activar la auditoría
            chrome.tabs.sendMessage(currentTab.id, { type: "AUDIT_STATE", active: true }, () => {
              btn.innerText = "Desactivar SpectreQA";
              btn.style.background = "#ef4444";
              window.close();
            });
          });
        } else {
          alert("Esta URL no pertenece al proyecto activo en SpectreQA Desktop.");
        }
      }
    );
  });
});