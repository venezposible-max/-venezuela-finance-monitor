chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'play_audio') {
        playSiren(message.isTest);
    }
});

function playSiren(isTest) {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const duration = isTest ? 3 : 15; // 3 segundos para pruebas, 15 segundos para alerta real
        const startTime = audioCtx.currentTime;
        
        // Oscilador de sirena
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(800, startTime); // Frecuencia base de 800Hz
        
        // Oscilador LFO para la modulación de frecuencia (sirena de dos tonos)
        const lfo = audioCtx.createOscillator();
        const lfoGain = audioCtx.createGain();
        
        lfo.frequency.value = 2.0; // 2 ciclos por segundo
        lfoGain.gain.value = 150; // Variación +- 150Hz
        
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);
        
        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        // Control de volumen suave
        gainNode.gain.setValueAtTime(0.15, startTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration); // Rampa de apagado
        
        lfo.start(startTime);
        osc.start(startTime);
        
        lfo.stop(startTime + duration);
        osc.stop(startTime + duration);
    } catch (err) {
        console.error('Error al reproducir audio en Offscreen:', err);
    }
}
