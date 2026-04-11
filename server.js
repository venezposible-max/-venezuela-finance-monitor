const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN ---
const TELEGRAM_CHANNEL_SOURCE = 'E_positivo';
const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

// Credenciales
const BOT_TOKEN = process.env.BOT_TOKEN || '8692351460:AAGuTRGkLEG6pt-nq5fMM5jqS-pXQflwfUM'; 
const CHAT_ID = process.env.CHAT_ID || '-1003812445382';    

let monitorState = {
    isRunning: false,
    lastUpdate: null,
    bcvRate: 570.75,
    binanceRate: 639.00,
    spread: 0,
    bankStatuses: { 
        'BDV': 'CERRADO 🔴', 
        'TESORO': 'CERRADO 🔴',
        'BDT': 'CERRADO 🔴',
        'ACTIVO': 'CERRADO 🔴',
        'BANCAMIGA': 'CERRADO 🔴'
    },
    manualOverrides: [], 
    interval: 5, // Intervalo en minutos
    logs: []
};

let monitorInterval = null;
let ninjaInterval = null;
let lastLiquidityVolume = 0;
let lastLiquidityAlert = 0;

function addLog(msg) {
    const log = { time: new Date().toLocaleTimeString(), text: msg };
    monitorState.logs.unshift(log);
    if (monitorState.logs.length > 50) monitorState.logs.pop();
    io.emit('log_update', log);
}

async function getBinanceRate() {
    try {
        const payload = {
            asset: 'USDT',
            fiat: 'VES',
            tradeType: 'SELL', 
            merchantCheck: false,
            page: 1,
            rows: 10,
            payTypes: [], // Sin filtros para agarrar el precio más competitivo del mercado
            transAmount: "63500", 
            publisherType: null
        };
        const res = await axios.post('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', payload);
        const ads = res.data.data;
        if (!ads || ads.length === 0) return monitorState.binanceRate;
        
        const prices = ads.slice(0, 5).map(ad => parseFloat(ad.adv.price));
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        
        addLog(`📊 Binance P2P: Precio de mercado actualizado (${avg.toFixed(2)})`);
        return avg;
    } catch (e) {
        addLog(`❌ Error Binance: ${e.message}`);
        return monitorState.binanceRate;
    }
}

async function checkLiquidity() {
    if (!monitorState.isRunning) return;
    try {
        const payload = {
            asset: 'USDT', fiat: 'VES', tradeType: 'SELL', 
            merchantCheck: false, page: 1, rows: 10, payTypes: [], transAmount: "63500", publisherType: null
        };
        const res = await axios.post('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', payload);
        const ads = res.data.data;
        if (!ads || ads.length === 0) return;
        
        // Sumar todo el USDT disponible en los top 7 anuncios
        const currentVolume = ads.slice(0, 7).reduce((acc, ad) => acc + parseFloat(ad.adv.tradableQuantity), 0);
        
        if (lastLiquidityVolume > 0 && currentVolume > 0) {
            const drop = ((lastLiquidityVolume - currentVolume) / lastLiquidityVolume) * 100;
            const now = Date.now();
            
            // Si la liquidez cae repentinamente más del 40%
            if (drop >= 40 && (now - lastLiquidityAlert > 3600000)) { // 1 hora de cooldown para no spamear
                lastLiquidityAlert = now;
                addLog(`🚨 ALERTA NINJA: Caída de liquidez del -${drop.toFixed(1)}%`);
                
                const time = new Date().toLocaleTimeString('es-VE', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit' });
                const alertMsg = `🚨 <b>¡ALERTA DE LIQUIDEZ P2P!</b> 🚨
                
El inventario de los comerciantes más baratos acaba de desplomarse un <b>${drop.toFixed(1)}%</b> repentinamente.

🔻 <b>Volumen anterior:</b> ${lastLiquidityVolume.toFixed(0)} USDT
📉 <b>Volumen actual:</b> ${currentVolume.toFixed(0)} USDT

💡 <i>Recomendación: Si tienes USDT producto de la intervención bancaria de hoy, <b>ESPERA</b>. Al haber escasez, es muy probable que el precio del USDT suba temporalmente en las próximas horas.</i>

<i>🕒 ${time}</i>`;

                await sendTelegramAlert(alertMsg);
            }
        }
        
        // Actualizar la línea base
        lastLiquidityVolume = currentVolume;
        
    } catch (e) {
        // Ignorar fallos de red en el radar ninja
    }
}

async function getTelegramData() {
    try {
        const res = await axios.get(`https://t.me/s/${TELEGRAM_CHANNEL_SOURCE}`);
        const $ = cheerio.load(res.data);
        const messages = $('.tgme_widget_message_text').toArray();
        
        let foundRate = null;
        let banks = { 
            'BDV': 'CERRADO 🔴', 
            'TESORO': 'CERRADO 🔴',
            'BDT': 'CERRADO 🔴',
            'ACTIVO': 'CERRADO 🔴',
            'BANCAMIGA': 'CERRADO 🔴'
        };

        // 1. Buscamos la Tasa de Intervención (Formato: TASA: 570,75 Bs.)
        for (let i = messages.length - 1; i >= 0; i--) {
            const text = $(messages[i]).text();
            if (text.includes('TASA:')) {
                const matches = text.match(/TASA:\s*(\d{2,3}[\.,]\d{2})/i);
                if (matches && !foundRate) {
                    const val = parseFloat(matches[1].replace(',', '.'));
                    if (val > 400 && val < 1000) {
                        foundRate = val;
                        addLog(`💎 Tasa de Intervención detectada: ${val} Bs.`);
                    }
                }
            }
        }

        // 2. Estado de Bancos (Detección por Emojis y Siglas)
        const recentMessages = messages.slice(-10);
        for (let i = 0; i < recentMessages.length; i++) {
            const text = $(recentMessages[i]).text().toUpperCase();
            const isOpen = text.includes('💸✔️') || text.includes('ACTIVO') || text.includes('ABRIÓ') || text.includes('INICIÓ');
            const isClosed = text.includes('🚫') || text.includes('CERRADO') || text.includes('FINALIZÓ') || text.includes('TERMINÓ');

            if (text.includes('BDV') || text.includes('VENEZUELA')) {
                if (isOpen) banks['BDV'] = 'ABIERTO 🟢';
                else if (isClosed) banks['BDV'] = 'CERRADO 🔴';
            }
            if (text.includes('BT ') || text.includes('TESORO')) {
                if (isOpen) banks['TESORO'] = 'ABIERTO 🟢';
                else if (isClosed) banks['TESORO'] = 'CERRADO 🔴';
            }
            if (text.includes('BDT') || text.includes('TRABAJADORES')) {
                if (isOpen) banks['BDT'] = 'ABIERTO 🟢';
                else if (isClosed) banks['BDT'] = 'CERRADO 🔴';
            }
            if (text.includes('ACTIVO')) {
                if (isOpen) banks['ACTIVO'] = 'ABIERTO 🟢';
                else if (isClosed) banks['ACTIVO'] = 'CERRADO 🔴';
            }
            if (text.includes('BANCAMIGA')) {
                if (isOpen) banks['BANCAMIGA'] = 'ABIERTO 🟢';
                else if (isClosed) banks['BANCAMIGA'] = 'CERRADO 🔴';
            }
        }

        // 3. Respetar Overrides Manuales (no sobrescribir si el banco está en modo manual)
        for (const bankId of monitorState.manualOverrides) {
            banks[bankId] = monitorState.bankStatuses[bankId];
        }

        // 4. Hora oficial de Venezuela (VET)
        monitorState.lastUpdate = new Date().toLocaleTimeString('es-VE', { 
            timeZone: 'America/Caracas',
            hour12: true,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        return { rate: foundRate || monitorState.bcvRate, banks };
    } catch (e) {
        addLog(`❌ Error Telegram: ${e.message}`);
        return { rate: monitorState.bcvRate, banks: monitorState.bankStatuses };
    }
}

async function sendTelegramAlert(message) {
    if (!BOT_TOKEN || !CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: CHAT_ID, text: message, parse_mode: 'HTML' });
        addLog('✅ Notificación enviada a Telegram');
    } catch (e) {
        addLog(`❌ Error Telegram API: ${e.message}`);
    }
}

async function runMonitor() {
    if (!monitorState.isRunning) return;
    
    addLog('🔍 Escaneando mercados...');
    const binance = await getBinanceRate();
    const telegram = await getTelegramData();

    // Función para calcular arbitraje por banco
    function calcReport(bcv, bin, bankName, comBank, comBin) {
        const usdt = 100;
        const bs = usdt * bin;
        const usdBruto = bs / bcv;
        const descBank = usdBruto * (comBank / 100);
        const usdNeto = usdBruto - descBank;
        const descBin = usdNeto * (comBin / 100);
        const usdtFinal = usdNeto - descBin;
        const ganancia = usdtFinal - usdt;
        const pct = (ganancia / usdt * 100).toFixed(2);
        const emoji = ganancia >= 0 ? '🟢' : '🔴';
        return `${emoji} <b>${bankName}</b> (${comBank}%): ${usdtFinal.toFixed(2)} USDT → <b>+${ganancia.toFixed(2)} USDT (${pct}%)</b>`;
    }

    if (binance > 0) {
        monitorState.binanceRate = binance;
        monitorState.bcvRate = telegram.rate;
        monitorState.bankStatuses = telegram.banks;
        monitorState.spread = ((binance - telegram.rate) / telegram.rate) * 100;
        monitorState.lastUpdate = new Date().toLocaleTimeString('es-VE', { 
            timeZone: 'America/Caracas',
            hour12: true,
            hour: '2-digit',
            minute: '2-digit'
        });

        const bcv = monitorState.bcvRate;
        const report = `
📊 <b>MONITOR DE ECONOMÍA VENEZUELA</b>
⏱ <i>Actualización: ${monitorState.lastUpdate}</i>

🏦 <b>BCV (Intervención):</b> ${bcv.toFixed(2)} VES

🏛 <b>MERCADO CAMBIARIO:</b>
🇻🇪 <b>Venezuela (BDV):</b> ${monitorState.bankStatuses['BDV']}
💰 <b>Tesoro:</b> ${monitorState.bankStatuses['TESORO']}
🏢 <b>BDT:</b> ${monitorState.bankStatuses['BDT']}
🏦 <b>Banco Activo:</b> ${monitorState.bankStatuses['ACTIVO']}
💎 <b>Bancamiga:</b> ${monitorState.bankStatuses['BANCAMIGA']}

🔶 <b>Binance P2P (USDT):</b> ${monitorState.binanceRate.toFixed(2)} VES
📐 <b>Spread (BCV vs P2P):</b> ${monitorState.spread.toFixed(2)}%

🧮 <b>ARBITRAJE — Base 100 USDT</b>
${calcReport(bcv, binance, 'BDV', 2.5, 3.3)}
${calcReport(bcv, binance, 'Tesoro', 2.5, 3.3)}
${calcReport(bcv, binance, 'Bancamiga', 5, 3.3)}

🔗 <a href="https://venezuela-finance-monitor-production.up.railway.app/calc.html">Calcula tu monto aquí</a>
        `;

        await sendTelegramAlert(report);
        io.emit('state_update', monitorState);
    }
}

// REST API
app.use(express.json());
app.use(express.static('public'));

app.post('/api/comment', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensaje vacío' });
    
    try {
        const time = new Date().toLocaleTimeString('es-VE', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit' });
        const telegramMsg = `📝 <b>NOTA DEL MONITOR:</b>\n\n${message}\n\n<i>🕒 ${time}</i>`;
        await sendTelegramAlert(telegramMsg);
        addLog(`💬 Comentario enviado a Telegram: "${message}"`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bank/toggle', (req, res) => {
    const { bankId } = req.body;
    if (monitorState.bankStatuses[bankId]) {
        const current = monitorState.bankStatuses[bankId];
        const next = current.includes('CERRADO') ? 'ABIERTO 🟢' : 'CERRADO 🔴';
        monitorState.bankStatuses[bankId] = next;
        
        // Agregar a la lista de manuales si no está
        if (!monitorState.manualOverrides.includes(bankId)) {
            monitorState.manualOverrides.push(bankId);
        }
        
        addLog(`🛠 MODO MANUAL: ${bankId} fijado en ${next}`);
        io.emit('state_update', monitorState);
        res.json({ success: true, status: next });
    } else {
        res.status(400).json({ success: false, error: 'Banco no encontrado' });
    }
});

app.post('/api/bank/auto', (req, res) => {
    const { bankId } = req.body;
    monitorState.manualOverrides = monitorState.manualOverrides.filter(id => id !== bankId);
    addLog(`🤖 MODO AUTO: ${bankId} ahora sigue al bot`);
    runMonitor(); // Actualizamos inmediatamente
    res.json({ success: true });
});

io.on('connection', (socket) => {
    socket.emit('state_update', monitorState);
});

app.post('/api/interval', (req, res) => {
    const { minutes } = req.body;
    const mins = parseInt(minutes);
    if (!isNaN(mins)) {
        monitorIntervalTime = mins * 60 * 1000;
        monitorState.interval = mins;
        addLog(`⏲ Intervalo actualizado a: ${mins} minutos`);
        
        if (monitorState.isRunning) {
            clearInterval(monitorInterval);
            monitorInterval = setInterval(runMonitor, monitorIntervalTime);
        }
        io.emit('state_update', monitorState);
        res.json({ success: true, interval: mins });
    } else {
        res.status(400).json({ error: 'Intervalo inválido' });
    }
});

app.post('/api/start', (req, res) => {
    if (!monitorState.isRunning) {
        monitorState.isRunning = true;
        addLog('🚀 Monitor INICIADO por el usuario');
        runMonitor();
        monitorInterval = setInterval(runMonitor, monitorState.interval * 60 * 1000);
        // Activar el radar ninja cada 60 segundos
        ninjaInterval = setInterval(checkLiquidity, 60000);
    }
    res.json({ success: true, state: monitorState });
});

app.post('/api/stop', (req, res) => {
    monitorState.isRunning = false;
    if (monitorInterval) clearInterval(monitorInterval);
    if (ninjaInterval) clearInterval(ninjaInterval);
    lastLiquidityVolume = 0; // resetear línea base
    addLog('🛑 Monitor DETENIDO por el usuario');
    res.json({ success: true, state: monitorState });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
