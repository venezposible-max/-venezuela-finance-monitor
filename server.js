const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

// Agent para BCV (SSL sin verificación estricta)
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

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
    bcvRate: 611,
    binanceRate: 639.00,
    spread: 0,
    bankStatuses: { 
        'BDV': 'CERRADO 🔴', 
        'TESORO': 'CERRADO 🔴',
        'BDT': 'CERRADO 🔴',
        'ACTIVO': 'CERRADO 🔴',
        'BANCAMIGA': 'CERRADO 🔴',
        'PROVINCIAL': 'CERRADO 🔴'
    },
    dataSources: { bcv: '---', bdv: '---', telegram: '---' }, // Estado de cada fuente
    manualOverrides: [], 
    interval: 5, // Intervalo en minutos
    logs: []
};

let monitorInterval = null;
let ninjaInterval = null;
let lastLiquidityVolume = 0;
let lastLiquidityAlert = 0;
let lastNinjaPrice = 0;
let lastPriceAlert = 0;

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
        // Usamos el 3er precio (la mediana de los top 5) para eludir anuncios falsos/trampa con precios inflados
        const medianPrice = prices.length >= 3 ? prices[2] : prices[0];
        
        addLog(`📊 Binance P2P: Precio de mercado actualizado (${medianPrice.toFixed(2)})`);
        return medianPrice;
    } catch (e) {
        addLog(`❌ Error Binance: ${e.message}`);
        return monitorState.binanceRate;
    }
}

async function checkLiquidity() {
    try {
        const payload = {
            asset: 'USDT', fiat: 'VES', tradeType: 'SELL', 
            merchantCheck: false, page: 1, rows: 10, payTypes: [], transAmount: "63500", publisherType: null
        };
        const res = await axios.post('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', payload);
        const ads = res.data.data;
        if (!ads || ads.length === 0) return;
        
        // Obtener el precio promedio usando la mediana para evitar picos falsos
        const topAdsPrice = ads.slice(0, 5);
        const prices = topAdsPrice.map(ad => parseFloat(ad.adv.price));
        const currentPrice = prices.length >= 3 ? prices[2] : prices[0];

        // Sumar todo el USDT disponible en los top 7 anuncios
        const currentVolume = ads.slice(0, 7).reduce((acc, ad) => acc + parseFloat(ad.adv.tradableQuantity), 0);
        
        const now = Date.now();
        const time = new Date().toLocaleTimeString('es-VE', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit' });

        // --- 1. SENSOR DE SUBIDA REPENTINA (Aumento >= 1 Bs) ---
        if (lastNinjaPrice > 0 && currentPrice > 0) {
            const priceJump = currentPrice - lastNinjaPrice;
            const priceIncrease = (priceJump / lastNinjaPrice) * 100;
            
            if (priceJump >= 1 && (now - lastPriceAlert > 900000)) { // 15 min de cooldown
                lastPriceAlert = now;
                addLog(`🚨 SUBIDA REPENTINA: +${priceJump.toFixed(2)} Bs (${priceIncrease.toFixed(2)}%)`);
                
                const alertMsgPrice = `🚨 <b>¡SUBIDA REPENTINA DEL USDT!</b> 🚨

El precio del USDT en Binance P2P acaba de subir <b>+${priceJump.toFixed(2)} Bs</b> (<b>+${priceIncrease.toFixed(2)}%</b>).

💵 <b>Precio anterior:</b> ${lastNinjaPrice.toFixed(2)} Bs
🔥 <b>Precio actual:</b> ${currentPrice.toFixed(2)} Bs
📈 <b>Salto:</b> +${priceJump.toFixed(2)} Bs

💡 <i>¡El dólar está subiendo! Buen momento para vender USDT y aprovechar el margen.</i>

<i>🕒 ${time}</i>`;
                await sendTelegramAlert(alertMsgPrice);
                
                // Forzar un reporte completo inmediatamente
                runMonitor();
            }
        }
        
        // --- 2. SENSOR DE ESCASEZ DE LIQUIDEZ (Caída >= 40%) ---
        if (lastLiquidityVolume > 0 && currentVolume > 0) {
            const drop = ((lastLiquidityVolume - currentVolume) / lastLiquidityVolume) * 100;
            
            if (drop >= 40 && (now - lastLiquidityAlert > 3600000)) { // 1 hora de cooldown
                lastLiquidityAlert = now;
                addLog(`🚨 ALERTA NINJA: Caída de liquidez del -${drop.toFixed(1)}%`);
                
                const alertMsgLiq = `🚨 <b>¡ALERTA DE LIQUIDEZ P2P!</b> 🚨
                
El inventario de los comerciantes más baratos acaba de desplomarse un <b>${drop.toFixed(1)}%</b> repentinamente.

🔻 <b>Volumen anterior:</b> ${lastLiquidityVolume.toFixed(0)} USDT
📉 <b>Volumen actual:</b> ${currentVolume.toFixed(0)} USDT

💡 <i>Recomendación: Si tienes USDT producto de la intervención de hoy, <b>ESPERA</b>. Al haber escasez, es muy probable que el precio suba en la próxima hora.</i>

<i>🕒 ${time}</i>`;
                await sendTelegramAlert(alertMsgLiq);
                
                // Forzar un reporte normal inmediatamente
                runMonitor();
            }
        }
        
        // Actualizar la línea base para el siguiente minuto
        lastLiquidityVolume = currentVolume;
        lastNinjaPrice = currentPrice;
        
    } catch (e) {
        // Ignorar fallos de red en el radar ninja
    }
}

async function checkBankStatus() {
    try {
        const data = await getMultiSourceData();
        const newBanks = data.banks;
        let alertMessages = [];

        const bankNames = {
            'BDV': '🇻🇪 Banco de Venezuela (BDV)',
            'TESORO': '💰 Banco del Tesoro',
            'BDT': '🏢 BDT',
            'ACTIVO': '🏦 Banco Activo',
            'BANCAMIGA': '💎 Bancamiga'
        };

        for (const [bankId, newStatus] of Object.entries(newBanks)) {
            if (monitorState.manualOverrides.includes(bankId)) continue;
            
            const oldStatus = monitorState.bankStatuses[bankId];
            if (oldStatus && oldStatus !== newStatus) {
                monitorState.bankStatuses[bankId] = newStatus;
                const source = (bankId === 'BDV' && monitorState.dataSources.bdv === '✅') ? '(vía Web BDV)' : '(vía Telegram)';
                addLog(`🔔 NINJA BANCARIO: ${bankId} cambió a ${newStatus} ${source}`);
                alertMessages.push(`• <b>${bankNames[bankId]}</b> cambió a: <b>${newStatus}</b> ${source}`);
            }
        }

        if (alertMessages.length > 0) {
            io.emit('state_update', monitorState);
            const time = new Date().toLocaleTimeString('es-VE', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit' });
            const finalAlert = `🔔 <b>¡ALERTA DE MERCADO BANCARIO!</b> 🔔\n\nSe acaba de detectar un cambio en la disponibilidad de intervención:\n\n${alertMessages.join('\n')}\n\n<i>🕒 ${time}</i>`;
            await sendTelegramAlert(finalAlert);
            runMonitor();
        }

    } catch (e) {}
}

// ===== FUENTE 1: BCV DIRECTO (Tasa Oficial) =====
async function getBCVRate() {
    try {
        const res = await axios.get('https://www.bcv.org.ve', {
            timeout: 12000, httpsAgent: insecureAgent,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $ = cheerio.load(res.data);
        const dolarText = $('#dolar').text().trim();
        const match = dolarText.match(/(\d{2,3}[.,]\d{2,8})/);
        if (match) {
            const rate = parseFloat(match[1].replace(',', '.'));
            if (rate > 50 && rate < 1000) {
                monitorState.dataSources.bcv = '✅';
                addLog(`🏛 BCV Directo: Tasa oficial USD = ${rate.toFixed(2)} Bs`);
                return rate;
            }
        }
        monitorState.dataSources.bcv = '⚠️';
        return null;
    } catch (e) {
        monitorState.dataSources.bcv = '❌';
        addLog(`⚠️ BCV web inaccesible: ${e.message.substring(0, 50)}`);
        return null;
    }
}

// ===== FUENTE 2: BDV WEB (Menudeo Abierto/Cerrado) =====
async function checkBDVWeb() {
    try {
        const res = await axios.get('https://www.bancodevenezuela.com', {
            timeout: 12000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $ = cheerio.load(res.data);
        
        // BDV tiene sección "Menudeo (USD-EUR)" con "Compra: $ X.XX / € X.XX"
        // Cuando está CERRADO los valores están vacíos: "Compra: $  / €"
        // Cuando está ABIERTO tiene números: "Compra: $ 570.75 / € 650.20"
        const bodyText = $('body').text();
        const menudeoMatch = bodyText.match(/Menudeo[\s\S]*?Compra:\s*\$\s*([\d.,]*)\s*\//);
        
        if (menudeoMatch) {
            const priceStr = menudeoMatch[1].trim();
            const hasPrice = priceStr.length > 0 && parseFloat(priceStr.replace(',', '.')) > 0;
            monitorState.dataSources.bdv = '✅';
            if (hasPrice) {
                addLog(`🏦 BDV Web: Menudeo ABIERTO (Compra: $${priceStr})`);
                return 'ABIERTO 🟢';
            } else {
                return 'CERRADO 🔴';
            }
        }
        
        // Fallback: buscar "Mesa de cambio" con valores
        const mesaMatch = bodyText.match(/BDV:\s*\$\s*([\d.,]*)\s*\//);
        if (mesaMatch) {
            const priceStr = mesaMatch[1].trim();
            const hasPrice = priceStr.length > 0 && parseFloat(priceStr.replace(',', '.')) > 0;
            monitorState.dataSources.bdv = '✅';
            return hasPrice ? 'ABIERTO 🟢' : 'CERRADO 🔴';
        }
        
        monitorState.dataSources.bdv = '⚠️';
        return null; // No se pudo determinar
    } catch (e) {
        monitorState.dataSources.bdv = '❌';
        return null;
    }
}

// ===== FUENTE 3: TELEGRAM @E_positivo (Todos los bancos) =====
async function getTelegramData() {
    try {
        const res = await axios.get(`https://t.me/s/${TELEGRAM_CHANNEL_SOURCE}`, { timeout: 10000 });
        const $ = cheerio.load(res.data);
        const messages = $('.tgme_widget_message_text').toArray();
        
        let foundRate = null;
        let banks = { ...monitorState.bankStatuses };

        // 1. Buscamos la Tasa de Intervención (Formato: TASA: 570,75 Bs.)
        for (let i = messages.length - 1; i >= 0; i--) {
            const text = $(messages[i]).text();
            if (text.includes('TASA:')) {
                const matches = text.match(/TASA:\s*(\d{2,3}[\.,]\d{2})/i);
                if (matches && !foundRate) {
                    const val = parseFloat(matches[1].replace(',', '.'));
                    if (val > 600 && val < 1500) {
                        foundRate = val;
                    }
                }
            }
        }

        // 2. Estado de Bancos (Detección por Emojis y Siglas)
        for (let i = 0; i < messages.length; i++) {
            const text = $(messages[i]).text().toUpperCase();
            const isOpen = text.includes('💸✔️') || text.includes('ABRIÓ') || text.includes('INICIÓ') || text.includes('ACTIVA');
            const isClosed = text.includes('🚫') || text.includes('CERRADO') || text.includes('CERRADA') || text.includes('FINALIZÓ') || text.includes('TERMINÓ');

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
            if (text.includes('PROVINCIAL')) {
                if (isOpen) banks['PROVINCIAL'] = 'ABIERTO 🟢';
                else if (isClosed) banks['PROVINCIAL'] = 'CERRADO 🔴';
            }
        }

        monitorState.dataSources.telegram = '✅';
        return { rate: foundRate, banks };
    } catch (e) {
        monitorState.dataSources.telegram = '❌';
        addLog(`❌ Error Telegram: ${e.message}`);
        return { rate: null, banks: null };
    }
}

// ===== ORQUESTADOR MULTI-FUENTE =====
async function getMultiSourceData() {
    // Lanzar las 3 fuentes en paralelo para máxima velocidad
    const [bcvRate, bdvStatus, telegram] = await Promise.all([
        getBCVRate(),
        checkBDVWeb(),
        getTelegramData()
    ]);

    let banks = { ...monitorState.bankStatuses };
    let rate = monitorState.bcvRate;

    // --- TASA: Prioridad Telegram (Intervención) ---
    if (telegram.rate) {
        rate = telegram.rate;
        addLog(`💎 Tasa de Intervención (vía Telegram): ${telegram.rate} Bs.`);
    } else {
        addLog(`🏛 Manteniendo Tasa de Intervención guardada: ${rate} Bs.`);
    }

    // --- BANCOS: Mezclar fuentes (web directo tiene prioridad) ---
    // Primero aplicar Telegram como base
    if (telegram.banks) {
        banks = { ...banks, ...telegram.banks };
    }
    // BDV web directo sobreescribe Telegram (más confiable)
    if (bdvStatus) {
        banks['BDV'] = bdvStatus;
    }

    // Respetar Overrides Manuales
    for (const bankId of monitorState.manualOverrides) {
        banks[bankId] = monitorState.bankStatuses[bankId];
    }

    // Hora oficial de Venezuela (VET)
    monitorState.lastUpdate = new Date().toLocaleTimeString('es-VE', { 
        timeZone: 'America/Caracas',
        hour12: true,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    const sourceLog = `📡 Fuentes: BCV=${monitorState.dataSources.bcv} | BDV=${monitorState.dataSources.bdv} | TG=${monitorState.dataSources.telegram}`;
    addLog(sourceLog);

    return { rate, banks };
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
    
    addLog('🔍 Escaneando mercados (multi-fuente)...');
    const [binance, multiData] = await Promise.all([
        getBinanceRate(),
        getMultiSourceData()
    ]);

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
        return `${emoji} <b>${bankName}</b> (${comBank}% | Bpay/Gpay: ${comBin}%): ${usdtFinal.toFixed(2)} USDT → <b>+${ganancia.toFixed(2)} USDT (${pct}%)</b>`;
    }

    if (binance > 0) {
        monitorState.binanceRate = binance;
        monitorState.bcvRate = multiData.rate;
        monitorState.bankStatuses = multiData.banks;
        monitorState.spread = ((binance - multiData.rate) / multiData.rate) * 100;
        monitorState.lastUpdate = new Date().toLocaleTimeString('es-VE', { 
            timeZone: 'America/Caracas',
            hour12: true,
            hour: '2-digit',
            minute: '2-digit'
        });

        const bcv = monitorState.bcvRate;
        const effectiveBcv = bcv * 1.005;
        const bcvStr = `${bcv.toFixed(2)} + Com: 0.5% (Total: ${effectiveBcv.toFixed(2)})`;
        const src = monitorState.dataSources;
        const report = `
📊 <b>MONITOR DE ECONOMÍA VENEZUELA</b>
⏱ <i>Actualización: ${monitorState.lastUpdate}</i>

🏦 <b>BCV (Intervención):</b> ${bcvStr} VES

🏛 <b>MERCADO CAMBIARIO:</b>
🇻🇪 <b>Venezuela (BDV):</b> ${monitorState.bankStatuses['BDV']}
💰 <b>Tesoro:</b> ${monitorState.bankStatuses['TESORO']}
🏢 <b>BDT:</b> ${monitorState.bankStatuses['BDT']}
🏦 <b>Banco Activo:</b> ${monitorState.bankStatuses['ACTIVO']}
💎 <b>Bancamiga:</b> ${monitorState.bankStatuses['BANCAMIGA']}
💙 <b>Provincial:</b> ${monitorState.bankStatuses['PROVINCIAL']}

🔶 <b>Binance P2P (USDT):</b> ${monitorState.binanceRate.toFixed(2)} VES
📐 <b>Spread (BCV vs P2P):</b> ${monitorState.spread.toFixed(2)}%

🧮 <b>ARBITRAJE — Base 100 USDT</b>
${calcReport(effectiveBcv, binance, 'BDV (Digital)', 2.5, 3.6)}
${calcReport(effectiveBcv, binance, 'BDV (Física)', 1.5, 3.6)}
${calcReport(effectiveBcv, binance, 'Tesoro', 2.5, 3.6)}
${calcReport(effectiveBcv, binance, 'Activo', 1.5, 3.6)}
${calcReport(effectiveBcv, binance, 'Bancamiga', 5, 3.6)}
${calcReport(effectiveBcv, binance, 'Provincial', 0, 3.6)}

📡 <i>Fuentes: BCV=${src.bcv} BDV=${src.bdv} TG=${src.telegram}</i>
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
    
    // El Radar Ninja inicia automáticamente al arrancar el servidor (24/7)
    addLog('🥷 Radars Ninjas activados en segundo plano (24/7)');
    ninjaInterval = setInterval(() => {
        checkLiquidity();
        checkBankStatus();
    }, 60000);
    checkLiquidity(); // Ejecución inicial
    checkBankStatus(); // Ejecución inicial
});
