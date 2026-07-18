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
    let b = document.getElementById('mercantil-banner');
    if (b) return;

    b = document.createElement('div');
    b.id = 'mercantil-banner';
    b.style.cssText = `position:fixed;bottom:0;left:0;right:0;z-index:9999999;
      background:linear-gradient(135deg,#064e3b,#022c22);color:#fff;padding:16px 20px;
      text-align:center;font-family:Arial,sans-serif;border-top:4px solid #10b981;
      box-shadow: 0 -4px 20px rgba(0,0,0,0.4);`;
    
    b.innerHTML = `
      <div style="font-size:24px;font-weight:bold;margin-bottom:6px;">
        🎉 ¡COMPRA DE DIVISAS DISPONIBLE EN MERCANTIL! 🎉
      </div>
      <div style="font-size:14px;color:#a7f3d0;margin-bottom:12px;">
        El sistema detectó disponibilidad y avanzó de la pantalla de error. El monitoreo se ha detenido.
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
    const b = document.getElementById('mercantil-banner');
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
    chrome.storage.local.get({ isEnabled: false, interval: 30000, monto: '100' }, (data) => {
        if (!data.isEnabled) return;

        // Registrar tiempo de chequeo
        chrome.storage.local.set({ lastCheck: Date.now() });

        const bodyText = document.body.innerText;
        const path = window.location.pathname + window.location.hash;

        // Caso 1: Pantalla de no disponibilidad (Error 9021)
        if (bodyText.includes('9021') || bodyText.includes('no hay disponibilidad de divisas')) {
            logToStorage('❌ Sin disponibilidad (Código 9021). Volviendo...');
            const btnRegresar = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.trim() === 'Regresar' && el.offsetWidth > 0);
            if (btnRegresar) {
                const clickTarget = btnRegresar.closest('button') || btnRegresar.closest('a') || btnRegresar;
                simulatePhysicalClick(clickTarget).then(() => {
                    // Esperar el intervalo de chequeo para reiniciar
                    scheduleNextCheck(data.interval);
                });
            } else {
                logToStorage('⚠️ No se encontró el botón Regresar. Reintentando en el próximo ciclo...');
                scheduleNextCheck(data.interval);
            }
            return;
        }

        // Caso 2: Formulario Paso 1 de 4 (Ingresar monto)
        if (bodyText.includes('Ingresa el monto a comprar') || bodyText.includes('Monto a comprar (USD)')) {
            logToStorage('✍️ Formulario Paso 1 detectado. Llenando...');
            
            // Clicar en Dólares
            const btnDolares = Array.from(document.querySelectorAll('button, div, span, label')).find(el => el.textContent.includes('Dólares') && el.offsetWidth > 0);
            if (btnDolares) {
                const clickTarget = btnDolares.closest('button') || btnDolares.closest('div') || btnDolares;
                simulatePhysicalClick(clickTarget).then(() => {
                    setTimeout(() => {
                        // Buscar el input del monto
                        const input = Array.from(document.querySelectorAll('input')).find(el => el.offsetWidth > 0 && !el.disabled && el.type !== 'checkbox' && el.type !== 'radio');
                        if (input) {
                            input.value = data.monto;
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            input.dispatchEvent(new Event('change', { bubbles: true }));
                            logToStorage(`Monto ${data.monto} USD ingresado.`);
                            
                            // Clicar en Continuar
                            setTimeout(() => {
                                const btnContinuar = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.trim() === 'Continuar' && el.offsetWidth > 0);
                                if (btnContinuar) {
                                    const clickTargetCont = btnContinuar.closest('button') || btnContinuar.closest('a') || btnContinuar;
                                    simulatePhysicalClick(clickTargetCont).then(() => {
                                        logToStorage('Continuar presionado. Esperando validación...');
                                        // Esperar el intervalo configurado antes de validar en el próximo ciclo
                                        scheduleNextCheck(data.interval);
                                    });
                                } else {
                                    logToStorage('❌ No se encontró el botón Continuar.');
                                    scheduleNextCheck(data.interval);
                                }
                            }, 800);
                        } else {
                            logToStorage('❌ No se encontró el campo de monto.');
                            scheduleNextCheck(data.interval);
                        }
                    }, 800);
                });
            } else {
                logToStorage('❌ No se encontró el botón "Dólares".');
                scheduleNextCheck(data.interval);
            }
            return;
        }

        // Caso 3: Éxito (Si ya pasamos de la pantalla de error 9021 y no está el Paso 1)
        if (path.includes('buy-currency') && (bodyText.includes('Paso 2 de 4') || bodyText.includes('Verifica') || bodyText.includes('pacto') || bodyText.includes('Confirmar'))) {
            logToStorage('🚨 ¡ATENCIÓN! Intervención ACTIVA detectada en Mercantil.');
            chrome.storage.local.set({ isEnabled: false }, () => {
                chrome.runtime.sendMessage({ action: 'triggerAlarm' });
                showBanner();
                startContinuousAlert();
            });
            return;
        }

        // Caso 4: Pantalla inicial (Resumen financiero / Summary)
        // Si el submenú de Compra ya está abierto
        const btnCompra = Array.from(document.querySelectorAll('a, span, div, li')).find(el => el.textContent.trim() === 'Compra de divisas' && el.offsetWidth > 0);
        if (btnCompra) {
            const clickTarget = btnCompra.closest('a') || btnCompra.closest('li') || btnCompra;
            logToStorage('Entrando a "Compra de divisas"...');
            simulatePhysicalClick(clickTarget).then(() => {
                scheduleNextCheck(data.interval);
            });
            return;
        }

        // Si el menú de divisas no está abierto
        const btnMercado = Array.from(document.querySelectorAll('a, span, div, li')).find(el => el.textContent.includes('Mercado de divisas') && el.offsetWidth > 0);
        if (btnMercado) {
            const clickTarget = btnMercado.closest('a') || btnMercado.closest('li') || btnMercado;
            logToStorage('Abriendo menú "Mercado de divisas"...');
            simulatePhysicalClick(clickTarget).then(() => {
                scheduleNextCheck(data.interval);
            });
            return;
        }

        logToStorage('⚠️ Esperando menú o formulario en pantalla...');
        scheduleNextCheck(data.interval);
    });
}

function scheduleNextCheck(interval) {
    if (monitorTimeout) clearTimeout(monitorTimeout);
    monitorTimeout = setTimeout(runCheck, interval);
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
