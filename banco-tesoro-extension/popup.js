document.addEventListener('DOMContentLoaded', () => {
    const statusBadge = document.getElementById('status-badge');
    const lastCheckSpan = document.getElementById('last-check');
    const intervalSelect = document.getElementById('interval-select');
    const toggleBtn = document.getElementById('toggle-btn');
    const testAlarmBtn = document.getElementById('test-alarm-btn');
    const logList = document.getElementById('log-list');

    function addLog(text) {
        const time = new Date().toLocaleTimeString();
        const line = document.createElement('div');
        line.className = 'log-line';
        line.innerText = `[${time}] ${text}`;
        logList.prepend(line);
        
        // Guardar logs en storage para no perderlos
        chrome.storage.local.get({ logs: [] }, (data) => {
            const newLogs = [[time, text], ...data.logs].slice(0, 30);
            chrome.storage.local.set({ logs: newLogs });
        });
    }

    function updateUI(isEnabled, lastCheck, savedLogs) {
        if (isEnabled) {
            statusBadge.innerText = 'ACTIVO';
            statusBadge.className = 'badge badge-active';
            toggleBtn.innerText = 'DETENER MONITOREO';
            toggleBtn.className = 'btn btn-stop';
        } else {
            statusBadge.innerText = 'DESACTIVADO';
            statusBadge.className = 'badge badge-inactive';
            toggleBtn.innerText = 'INICIAR MONITOREO';
            toggleBtn.className = 'btn btn-start';
        }
        
        lastCheckSpan.innerText = lastCheck ? new Date(lastCheck).toLocaleTimeString() : 'Nunca';
        
        if (savedLogs && savedLogs.length > 0) {
            logList.innerHTML = '';
            savedLogs.forEach(([time, text]) => {
                const line = document.createElement('div');
                line.className = 'log-line';
                line.innerText = `[${time}] ${text}`;
                logList.appendChild(line);
            });
        }
    }

    // Cargar estado inicial
    chrome.storage.local.get({
        isEnabled: false,
        interval: 30000,
        lastCheck: null,
        logs: []
    }, (data) => {
        intervalSelect.value = data.interval;
        updateUI(data.isEnabled, data.lastCheck, data.logs);
    });

    // Guardar cambio de intervalo
    intervalSelect.addEventListener('change', () => {
        const interval = parseInt(intervalSelect.value);
        chrome.storage.local.set({ interval });
        addLog(`Intervalo cambiado a ${interval / 1000}s`);
    });

    // Encender / Apagar
    toggleBtn.addEventListener('click', () => {
        chrome.storage.local.get({ isEnabled: false }, (data) => {
            const nextState = !data.isEnabled;
            chrome.storage.local.set({ isEnabled: nextState }, () => {
                addLog(nextState ? 'Monitoreo INICIADO' : 'Monitoreo DETENIDO');
                
                // Enviar mensaje a la pestaña activa para iniciar/detener
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs && tabs[0]) {
                        chrome.tabs.sendMessage(tabs[0].id, { action: nextState ? 'start' : 'stop' }).catch(err => {
                            addLog('⚠️ Recuerda recargar la página del banco para activar la extensión.');
                        });
                    }
                });

                // Cargar logs actualizados
                chrome.storage.local.get(['isEnabled', 'lastCheck', 'logs'], (res) => {
                    updateUI(res.isEnabled, res.lastCheck, res.logs);
                });
            });
        });
    });

    // Probar Alarma
    testAlarmBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'playTestAlarm' });
        addLog('🔊 Alarma de prueba activada.');
    });

    // Escuchar cambios en el storage para actualizar logs en tiempo real
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local') {
            chrome.storage.local.get(['isEnabled', 'lastCheck', 'logs'], (data) => {
                updateUI(data.isEnabled, data.lastCheck, data.logs);
            });
        }
    });
});
