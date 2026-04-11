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
    bcvRate: 571.75,
    binanceRate: 0,
    spread: 0,
    bankStatuses: { 
        'BDV': 'CERRADO 🔴', 
        'TESORO': 'CERRADO 🔴',
        'BDT': 'CERRADO 🔴',
        'ACTIVO': 'CERRADO 🔴'
    },
    logs: []
};

let monitorInterval = null;

function addLog(msg) {
    const log = { time: new Date().toLocaleTimeString(), text: msg };
    monitorState.logs.unshift(log);
    if (monitorState.logs.length > 50) monitorState.logs.pop();
    io.emit('log_update', log);
}

async function getBinanceRate() {
    try {
        const payload = { asset: 'USDT', fiat: 'VES', merchantCheck: false, page: 1, payTypes: [], publisherType: null, rows: 10, tradeType: 'BUY' };
        const res = await axios.post(BINANCE_P2P_URL, payload);
        const ads = res.data.data;
        if (!ads || ads.length === 0) return 0;
        const prices = ads.slice(0, 5).map(ad => parseFloat(ad.adv.price));
        return prices.reduce((a, b) => a + b, 0) / prices.length;
    } catch (e) {
        addLog(`❌ Error Binance: ${e.message}`);
        return 0;
    }
}

async function getTelegramData() {
    try {
        const res = await axios.get(`https://t.me/s/${TELEGRAM_CHANNEL_SOURCE}`);
        const $ = cheerio.load(res.data);
        const messages = $('.tgme_widget_message_text').toArray();
        
        let foundRate = null;
        let banks = { 'BDV': 'CERRADO 🔴', 'TESORO': 'CERRADO 🔴' };

        for (let i = messages.length - 1; i >= 0; i--) {
            const text = $(messages[i]).text();
            const lowerText = text.toLowerCase();
            
            if (text.includes('BCV') || text.includes('Intervención') || text.includes('Tasa')) {
                const matches = text.match(/(\d{2,3}[\.,]\d{2})/g);
                if (matches && !foundRate) {
                    const val = parseFloat(matches[0].replace(',', '.'));
                    if (val > 400 && val < 1000) foundRate = val;
                }
            }

            const isOpen = lowerText.includes('inició venta') || lowerText.includes('abrió venta') || lowerText.includes('hay cupo') || text.includes('✅');
            const isClosed = lowerText.includes('cerrado') || lowerText.includes('finalizó') || lowerText.includes('sin cupo') || lowerText.includes('terminó') || lowerText.includes('cerró');

            if (lowerText.includes('venezuela') || lowerText.includes('bdv')) {
                if (isOpen) banks['BDV'] = 'ABIERTO 🟢';
                else if (isClosed) banks['BDV'] = 'CERRADO 🔴';
            }
            if (lowerText.includes('tesoro') || lowerText.includes('bt ')) {
                if (isOpen) banks['TESORO'] = 'ABIERTO 🟢';
                else if (isClosed) banks['TESORO'] = 'CERRADO 🔴';
            }
            if (lowerText.includes('bdt')) {
                if (isOpen) banks['BDT'] = 'ABIERTO 🟢';
                else if (isClosed) banks['BDT'] = 'CERRADO 🔴';
            }
            if (lowerText.includes('activo')) {
                if (isOpen) banks['ACTIVO'] = 'ABIERTO 🟢';
                else if (isClosed) banks['ACTIVO'] = 'CERRADO 🔴';
            }
        }
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

    if (binance > 0) {
        monitorState.binanceRate = binance;
        monitorState.bcvRate = telegram.rate;
        monitorState.bankStatuses = telegram.banks;
        monitorState.spread = ((binance - telegram.rate) / telegram.rate) * 100;
        monitorState.lastUpdate = new Date().toLocaleTimeString();

        const report = `
📊 <b>MONITOR DE ECONOMÍA VENEZUELA</b>
⏱ <i>Actualización: ${monitorState.lastUpdate}</i>

🏦 <b>BCV (Intervención):</b> ${monitorState.bcvRate.toFixed(2)} VES

🏛 <b>MERCADO CAMBIARIO:</b>
🇻🇪 <b>Venezuela (BDV):</b> ${monitorState.bankStatuses['BDV']}
💰 <b>Tesoro:</b> ${monitorState.bankStatuses['TESORO']}
🏢 <b>BDT:</b> ${monitorState.bankStatuses['BDT']}
🏦 <b>Banco Activo:</b> ${monitorState.bankStatuses['ACTIVO']}

🔶 <b>Binance P2P (USDT):</b> ${monitorState.binanceRate.toFixed(2)} VES
📐 <b>Spread (Brecha):</b> ${monitorState.spread.toFixed(2)}%
        `;

        await sendTelegramAlert(report);
        io.emit('state_update', monitorState);
    }
}

// REST API
app.use(express.static('public'));

io.on('connection', (socket) => {
    socket.emit('state_update', monitorState);
});

app.post('/api/start', (req, res) => {
    if (!monitorState.isRunning) {
        monitorState.isRunning = true;
        addLog('🚀 Monitor INICIADO por el usuario');
        runMonitor();
        monitorInterval = setInterval(runMonitor, 5 * 60 * 1000);
    }
    res.json({ success: true, state: monitorState });
});

app.post('/api/stop', (req, res) => {
    monitorState.isRunning = false;
    if (monitorInterval) clearInterval(monitorInterval);
    addLog('🛑 Monitor DETENIDO por el usuario');
    res.json({ success: true, state: monitorState });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
