chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'play_audio') {
        playSiren(message.isTest);
    }
});

function playSiren(isTest) {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const duration = isTest ? 3 : 15;
        const startTime = audioCtx.currentTime;
        
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(800, startTime);
        
        const lfo = audioCtx.createOscillator();
        const lfoGain = audioCtx.createGain();
        
        lfo.frequency.value = 2.0;
        lfoGain.gain.value = 150;
        
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);
        
        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        gainNode.gain.setValueAtTime(0.15, startTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
        
        lfo.start(startTime);
        osc.start(startTime);
        
        lfo.stop(startTime + duration);
        osc.stop(startTime + duration);
    } catch (err) {
        console.error('Error al reproducir audio en Offscreen:', err);
    }
}
