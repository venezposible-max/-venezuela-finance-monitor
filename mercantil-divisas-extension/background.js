let isCreating = null;

async function setupOffscreen() {
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (contexts.length > 0) return;

    if (isCreating) {
        await isCreating;
    } else {
        isCreating = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['AUDIO_PLAYBACK'],
            justification: 'Reproducir alarma sonora de intervención bancaria'
        });
        await isCreating;
        isCreating = null;
    }
}

async function playAudio(isTest) {
    try {
        await setupOffscreen();
        chrome.runtime.sendMessage({ action: 'play_audio', isTest });
    } catch (e) {
        console.error('Error al iniciar audio offscreen:', e);
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'triggerAlarm') {
        chrome.notifications.create('mercantil-intervention-alert', {
            type: 'basic',
            iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
            title: '🚨 ¡INTERVENCIÓN MERCANTIL DETECTADA! 🚨',
            message: 'Se ha habilitado la opción de compra de divisas en Mercantil.',
            priority: 2,
            requireInteraction: true
        });

        playAudio(false);
    } else if (message.action === 'playTestAlarm') {
        playAudio(true);
    } else if (message.type === 'NATIVE_CLICK') {
        const tabId = sender.tab ? sender.tab.id : null;
        if (!tabId) {
            sendResponse({ success: false, error: 'No tab found' });
            return true;
        }

        const { x, y } = message;

        chrome.debugger.attach({ tabId }, '1.3', () => {
            if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
                return;
            }

            chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
                type: 'mousePressed',
                button: 'left',
                x: Math.round(x),
                y: Math.round(y),
                clickCount: 1
            }, () => {
                if (chrome.runtime.lastError) {
                    chrome.debugger.detach({ tabId });
                    sendResponse({ success: false, error: chrome.runtime.lastError.message });
                    return;
                }

                setTimeout(() => {
                    chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
                        type: 'mouseReleased',
                        button: 'left',
                        x: Math.round(x),
                        y: Math.round(y),
                        clickCount: 1
                    }, () => {
                        const lastErr = chrome.runtime.lastError;
                        chrome.debugger.detach({ tabId }, () => {
                            if (lastErr) {
                                sendResponse({ success: false, error: lastErr.message });
                            } else {
                                sendResponse({ success: true });
                            }
                        });
                    });
                }, 80);
            });
        });
        return true;
    }
});
