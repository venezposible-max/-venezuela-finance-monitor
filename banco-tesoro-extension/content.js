let monitorTimeout = null;
let alertIntervalId = null;

function logToStorage(text) {
    const time = new Date().toLocaleTimeString();
    chrome.storage.local.get({ logs: [] }, (data) => {
        const newLogs = [[time, text], ...data.logs].slice(0, 30);
        chrome.storage.local.set({ logs: newLogs });
    });
}

// Reproducción de Alerta de Divisas usando Web Audio API local
function playAlert() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const t = ctx.currentTime;
        // Melodía tipo arpegio brillante
        [[523, 0, 0.15], [659, 0.2, 0.15], [784, 0.4, 0.3], [523, 0.9, 0.15], [659, 1.1, 0.15], [784, 1.3, 0.5]]
            .forEach(([f, d, dur]) => {
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.connect(g);
                g.connect(ctx.destination);
                o.frequency.value = f;
                g.gain.setValueAtTime(0.4, t + d);
                g.gain.exponentialRampToValueAtTime(0.001, t + d + dur);
                o.start(t + d);
                o.stop(t + d + dur);
            });
    } catch (e) {
        console.error('Audio error:', e);
    }
}

function startContinuousAlert() {
    if (alertIntervalId) return;
    playAlert();
    alertIntervalId = setInterval(playAlert, 2500);
}

function stopContinuousAlert() {
    if (alertIntervalId) {
        clearInterval(alertIntervalId);
        alertIntervalId = null;
    }
}

function showBanner() {
    let b = document.getElementById('bt-banner');
    if (b) return;

    b = document.createElement('div');
    b.id = 'bt-banner';
    b.style.cssText = `position:fixed;bottom:0;left:0;right:0;z-index:9999999;
      background:linear-gradient(135deg,#064e3b,#022c22);color:#fff;padding:16px 20px;
      text-align:center;font-family:Arial,sans-serif;border-top:4px solid #10b981;
      box-shadow: 0 -4px 20px rgba(0,0,0,0.4);`;
    
    b.innerHTML = `
      <div style="font-size:24px;font-weight:bold;margin-bottom:6px;">
        🎉 ¡COMPRA DE DIVISAS DISPONIBLE EN EL TESORO! 🎉
      </div>
      <div style="font-size:14px;color:#a7f3d0;margin-bottom:12px;">
        El botón "Ordinaria" ha sido detectado en la cabecera. El monitoreo automático se ha detenido.
      </div>
    `;

    const btn = document.createElement('button');
    btn.innerText = 'Silenciar Alarma 🔊';
    btn.style.cssText = `background:#10b981;color:#022c22;border:none;padding:8px 18px;
      border-radius:6px;font-weight:bold;cursor:pointer;font-size:13px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2); transition: all 0.2s;`;
    
    btn.onmouseover = () => btn.style.background = '#34d399';
    btn.onmouseout = () => btn.style.background = '#10b981';
    btn.onclick = () => {
        stopContinuousAlert();
        btn.innerText = 'Alarma Silenciada 🔇';
        btn.style.background = '#1e293b';
        btn.style.color = '#94a3b8';
        btn.disabled = true;
    };

    b.appendChild(btn);
    document.body.appendChild(b);
}

function removeBanner() {
    const b = document.getElementById('bt-banner');
    if (b) b.remove();
}

function getClickableElementWithCoords(el) {
    let current = el;
    while (current) {
        const rect = current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            return { element: current, rect };
        }
        current = current.parentElement;
    }
    return { element: el, rect: el.getBoundingClientRect() };
}

function simulatePhysicalClick(el) {
    if (!el) return Promise.resolve(false);
    return new Promise((resolve) => {
        try {
            const target = getClickableElementWithCoords(el);
            if (typeof target.element.scrollIntoView === 'function') {
                target.element.scrollIntoView({ block: 'center', inline: 'center' });
            }
            
            const rect = target.element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;

            chrome.runtime.sendMessage({
                type: 'NATIVE_CLICK',
                x: x,
                y: y
            }, (res) => {
                if (chrome.runtime.lastError || !res || !res.success) {
                    try {
                        if (typeof el.focus === 'function') el.focus();
                        if (typeof el.click === 'function') el.click();
                    } catch (clickErr) {}
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        } catch (e) {
            try { el.click(); } catch(err) {}
            resolve(false);
        }
    });
}

function runCheck() {
    chrome.storage.local.get({ isEnabled: false, interval: 30000 }, (data) => {
        if (!data.isEnabled) return;

        // Registrar tiempo de chequeo
        chrome.storage.local.set({ lastCheck: Date.now() });

        // 1. Buscar y hacer clic únicamente en la opción "Intervención" del menú
        const menuElements = Array.from(document.querySelectorAll('a, span, div, li, p'));
        const targetLink = menuElements.find(el => {
            const txt = el.textContent.trim().toLowerCase();
            const href = el.getAttribute ? (el.getAttribute('href') || '') : '';
            return (txt === 'intervención' || href.includes('int')) && el.offsetWidth > 0;
        });

        if (targetLink) {
            const clickTarget = targetLink.closest('a') || targetLink.closest('li') || targetLink;
            
            logToStorage('Haciendo clic en el menú "Intervención"...');
            simulatePhysicalClick(clickTarget).then((success) => {
                if (success) {
                    logToStorage('🎯 Clic nativo enviado.');
                }
            });
        } else {
            logToStorage('❌ No se encontró el botón de menú "Intervención".');
        }

        // 2. Esperar 3.5 segundos a que la tabla o datos de la página carguen para escanear
        if (monitorTimeout) clearTimeout(monitorTimeout);
        monitorTimeout = setTimeout(() => {
            chrome.storage.local.get({ isEnabled: false, interval: 30000 }, (resFinal) => {
                if (!resFinal.isEnabled) return;

                // Buscar la franja azul del título de la tarjeta
                const headers = Array.from(document.querySelectorAll('div, header, span, h1, h2, h3'))
                    .filter(el => el.textContent.includes('Operaciones de Intervención') && el.offsetWidth > 0);
                
                let hasOrdinariaActive = false;
                
                if (headers.length > 0) {
                    headers.sort((a, b) => a.textContent.length - b.textContent.length);
                    const blueStripe = headers[0];
                    const parentContainer = blueStripe.parentElement || blueStripe;

                    // Buscar el botón verde "Ordinaria" únicamente dentro de la cabecera, excluyendo la tabla
                    const matches = Array.from(parentContainer.querySelectorAll('*')).filter(el => {
                        const txt = el.textContent.trim().toLowerCase();
                        if (txt !== 'ordinaria' && txt !== 'ordinario') return false;

                        // Excluir la tabla histórica
                        const isTable = el.closest('table') || el.closest('tbody') || el.closest('tr') || el.closest('td');
                        return !isTable && el.offsetWidth > 0;
                    });

                    hasOrdinariaActive = matches.length > 0;
                }

                if (hasOrdinariaActive) {
                    logToStorage('🚨 ¡ATENCIÓN! Intervención detectada en la franja azul. Deteniendo monitoreo.');
                    
                    chrome.storage.local.set({ isEnabled: false }, () => {
                        chrome.runtime.sendMessage({ action: 'triggerAlarm' });
                        showBanner();
                        startContinuousAlert();
                    });
                } else {
                    logToStorage('Chequeo completado: Sin botón verde de intervención en la franja azul.');
                    
                    // Programar el siguiente clic según el intervalo configurado
                    if (monitorTimeout) clearTimeout(monitorTimeout);
                    monitorTimeout = setTimeout(runCheck, resFinal.interval);
                }
            });
        }, 3500);
    });
}

// Escuchar órdenes de encendido y apagado desde el Popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'start') {
        removeBanner();
        stopContinuousAlert();
        if (monitorTimeout) clearTimeout(monitorTimeout);
        runCheck();
    } else if (message.action === 'stop') {
        if (monitorTimeout) clearTimeout(monitorTimeout);
        stopContinuousAlert();
        removeBanner();
        logToStorage('Monitoreo automático detenido.');
    }
});

// Iniciar automáticamente si la extensión estaba activada al refrescar/cargar la página
chrome.storage.local.get({ isEnabled: false }, (data) => {
    if (data.isEnabled) {
        if (monitorTimeout) clearTimeout(monitorTimeout);
        monitorTimeout = setTimeout(runCheck, 4000);
    }
});
