const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

// Agent para BCV (SSL sin verificación estricta)
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN ---
const TELEGRAM_CHANNEL_SOURCE = 'E_positivo';
const SECONDARY_CHANNEL_SOURCE = 'httpsbancocompradedivisa';
const THIRD_CHANNEL_SOURCE = 'BancaVenezolana';
const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

// Credenciales
const BOT_TOKEN = process.env.BOT_TOKEN || '8692351460:AAGuTRGkLEG6pt-nq5fMM5jqS-pXQflwfUM'; 
const CHAT_ID = process.env.CHAT_ID || '-1003812445382';

// --- USERBOT (gramjs) para canal con vista pública desactivada ---
const USERBOT_API_ID = 34693713;
const USERBOT_API_HASH = 'ac85826864b1ee35fed41cd4966631f5';
let userBotSession = process.env.USERBOT_SESSION || '';
if (!userBotSession) {
    try {
        userBotSession = fs.readFileSync('session.txt', 'utf8').trim();
        console.log('[USERBOT] Sesión cargada desde archivo.');
    } catch (e) {
        console.log('[USERBOT] No se encontró session.txt ni USERBOT_SESSION. Espejo desactivado.');
    }
} else {
    console.log('[USERBOT] Sesión cargada desde variable de entorno.');
}    

let monitorState = {
    isRunning: false,
    lastUpdate: null,
    bcvRate: 670.39,
    isBcvManual: true,
    binanceRate: 639.00,
    binanceRateMaker: 639.00,
    binanceRateTaker: 630.00,
    spread: 0,
    spreadTaker: 0,
    trend: 'STABLE',
    buyingPressure: 50,
    bpayCommission: 4.1,
    visibleBanks: ['BDV', 'TESORO', 'BDT', 'ACTIVO', 'BANCAMIGA', 'PROVINCIAL'],
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

let priceHistory = [];

function addLog(msg) {
    const log = { time: new Date().toLocaleTimeString(), text: msg };
    monitorState.logs.unshift(log);
    if (monitorState.logs.length > 50) monitorState.logs.pop();
    io.emit('log_update', log);
}

async function getBinanceRate(tradeType = 'SELL') {
    try {
        const payload = {
            asset: 'USDT',
            fiat: 'VES',
            tradeType: tradeType, 
            merchantCheck: false,
            page: 1,
            rows: 10,
            payTypes: [], 
            transAmount: "63500", 
            publisherType: null
        };
        const res = await axios.post('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', payload);
        const ads = res.data.data;
        
        const defaultRate = tradeType === 'BUY' ? monitorState.binanceRateMaker : monitorState.binanceRateTaker;
        if (!ads || ads.length === 0) return { price: defaultRate, volume: 0 };
        
        const prices = ads.slice(0, 5).map(ad => parseFloat(ad.adv.price));
        const medianPrice = prices.length >= 3 ? prices[2] : prices[0];
        
        const volume = ads.reduce((acc, ad) => acc + parseFloat(ad.adv.surplusAmount), 0);
        
        addLog(`📊 Binance P2P (${tradeType === 'BUY' ? 'Maker' : 'Taker'}): Precio actualizado (${medianPrice.toFixed(2)})`);
        return { price: medianPrice, volume: volume };
    } catch (e) {
        addLog(`❌ Error Binance (${tradeType}): ${e.message}`);
        const defaultRate = tradeType === 'BUY' ? monitorState.binanceRateMaker : monitorState.binanceRateTaker;
        return { price: defaultRate, volume: 0 };
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
                // Ya no llamamos a runMonitor() aquí para respetar el ritmo de reporte programado
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
                // Ya no llamamos a runMonitor() aquí para respetar el ritmo de reporte programado
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
            'BANCAMIGA': '💎 Bancamiga',
            'PROVINCIAL': '💙 BBVA Provincial'
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
            // Ya no llamamos a runMonitor() aquí para respetar el ritmo de reporte programado
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

// ===== FUENTE 3: TELEGRAM (Multi-Canal) =====
async function getTelegramData() {
    try {
        // Escanear canales con vista pública (BANCO$$$ se maneja por UserBot aparte)
        const results = await Promise.allSettled([
            axios.get(`https://t.me/s/${TELEGRAM_CHANNEL_SOURCE}`, { timeout: 8000 }),
            axios.get(`https://t.me/s/${THIRD_CHANNEL_SOURCE}`, { timeout: 8000 })
        ]);

        let allMessages = [];
        results.forEach(res => {
            if (res.status === 'fulfilled') {
                const $ = cheerio.load(res.value.data);
                $('.tgme_widget_message_text').toArray().forEach(m => {
                    allMessages.push($(m).text());
                });
            }
        });

        if (allMessages.length === 0) {
            addLog(`⚠️ No se obtuvieron mensajes de Telegram (Fuentes caídas o vacías)`);
            return { rate: null, banks: null };
        }
        
        let foundRate = null;
        let banks = { ...monitorState.bankStatuses };

        // 1. Tasa de Intervención (Buscamos de atrás hacia adelante para la más reciente)
        for (let i = allMessages.length - 1; i >= 0; i--) {
            const text = allMessages[i];
            if (text.includes('TASA:')) {
                const matches = text.match(/TASA:\s*(\d{2,3}[\.,]\d{2})/i);
                if (matches && !foundRate) {
                    const val = parseFloat(matches[1].replace(',', '.'));
                    if (val > 600 && val < 1500) foundRate = val;
                }
            }
        }

        // 2. Estado de Bancos
        for (const text of allMessages) {
            const upperText = text.toUpperCase();
            
            // Detección de Apertura (más precisa)
            const isOpen = upperText.includes('💸✔️') || upperText.includes('ABRIÓ') || upperText.includes('INICIÓ') || 
                           upperText.includes('ACTIVA') || upperText.includes('ACTIVO') || upperText.includes('🟢') || 
                           upperText.includes('MÍNIMO') || upperText.includes('TASA:');
            
            // Detección de Cierre
            const isClosed = upperText.includes('🚫') || upperText.includes('CERRADO') || upperText.includes('CERRADA') || 
                             upperText.includes('FINALIZÓ') || upperText.includes('TERMINÓ') || upperText.includes('🔴');

            const updateBank = (key) => {
                // Prioridad absoluta a la apertura si se detecta en el mismo ciclo
                if (isOpen) banks[key] = 'ABIERTO 🟢';
                else if (isClosed && banks[key] !== 'ABIERTO 🟢') banks[key] = 'CERRADO 🔴';
            };

            // Mapeo preciso de palabras clave por banco
            if (upperText.includes('BDV') || upperText.includes('VENEZUELA') || upperText.includes('👍BDV')) {
                updateBank('BDV');
            }
            if (upperText.includes('BT ') || upperText.includes('TESORO') || upperText.includes('😇BT') || upperText.includes('🗣BT') || upperText.includes('BANCO DEL TESORO')) {
                updateBank('TESORO');
            }
            if (upperText.includes('BDT') || upperText.includes('TRABAJADORES') || upperText.includes('😝BDT') || upperText.includes('🗣BDT') || upperText.includes('BANCO DIGITAL')) {
                updateBank('BDT');
            }
            if (upperText.includes('ACTIVO') || upperText.includes('🗣ACTIVO')) {
                updateBank('ACTIVO');
            }
            if (upperText.includes('BANCAMIGA') || upperText.includes('😜BANCAMIGA')) {
                updateBank('BANCAMIGA');
            }
            if (upperText.includes('PROVINCIAL') || upperText.includes('BBVA') || upperText.includes('☺️BBVA')) {
                updateBank('PROVINCIAL');
            }
        }

        monitorState.dataSources.telegram = '✅';
        return { rate: foundRate, banks };
    } catch (e) {
        monitorState.dataSources.telegram = '❌';
        addLog(`❌ Error Crítico en Telegram: ${e.message}`);
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
    if (!monitorState.isBcvManual) {
        if (telegram.rate) {
            rate = telegram.rate;
            addLog(`💎 Tasa de Intervención (vía Telegram): ${telegram.rate} Bs.`);
        } else if (bcvRate) {
            rate = bcvRate;
            addLog(`🏛 Tasa de Intervención (vía BCV Directo): ${bcvRate} Bs.`);
        } else {
            addLog(`🏛 Manteniendo Tasa de Intervención guardada: ${rate} Bs.`);
        }
    } else {
        addLog(`🏛 Tasa de Intervención fijada manualmente en: ${rate} Bs.`);
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
        const errorDesc = e.response && e.response.data && e.response.data.description 
            ? e.response.data.description 
            : e.message;
        addLog(`❌ Error Telegram API: ${errorDesc}`);
    }
}

async function runMonitor() {
    if (!monitorState.isRunning) return;
    
    addLog('🔍 Escaneando mercados (multi-fuente)...');
    const [binanceMakerData, binanceTakerData, multiData] = await Promise.all([
        getBinanceRate('BUY'),  // Maker
        getBinanceRate('SELL'), // Taker
        getMultiSourceData()
    ]);
    const binanceMaker = binanceMakerData.price;
    const binanceTaker = binanceTakerData.price;

    function calcReport(bcv, bin, bankName, comBankReload, comBin, comBankPay = 0) {
        const usdt = 100;
        const bs = usdt * bin;
        const usdBruto = bs / bcv;
        
        // 1. Comisión de recarga de tarjeta
        const descReload = usdBruto * (comBankReload / 100);
        const usdAfterReload = usdBruto - descReload;
        
        // 2. Comisión de pago/pasarela de tarjeta
        const descPay = usdAfterReload * (comBankPay / 100);
        const usdAfterPay = usdAfterReload - descPay;
        
        // 3. Comisión BPay/Binance
        const descBin = usdAfterPay * (comBin / 100);
        const usdtFinal = usdAfterPay - descBin;
        
        const ganancia = usdtFinal - usdt;
        const pct = (ganancia / usdt * 100).toFixed(2);
        const emoji = ganancia >= 0 ? '🟢' : '🔴';
        const detailStr = comBankPay > 0 
            ? `Recarga: ${comBankReload}% | Pago: ${comBankPay}% | Bpay: ${comBin}%`
            : `Recarga: ${comBankReload}% | Bpay: ${comBin}%`;
        return `${emoji} <b>${bankName}</b> (${detailStr}): ${usdtFinal.toFixed(2)} USDT → <b>+${ganancia.toFixed(2)} USDT (${pct}%)</b>`;
    }

    if (binanceMaker > 0 && binanceTaker > 0) {
        monitorState.binanceRateMaker = binanceMaker;
        monitorState.binanceRateTaker = binanceTaker;
        monitorState.binanceRate = binanceMaker; // compatibilidad
        
        monitorState.bcvRate = multiData.rate;
        monitorState.bankStatuses = multiData.banks;
        
        monitorState.spread = ((binanceMaker - multiData.rate) / multiData.rate) * 100;
        monitorState.spreadTaker = ((binanceTaker - multiData.rate) / multiData.rate) * 100;
        
        // Calcular Presión de Compra
        const demandVolume = binanceMakerData.volume;
        const supplyVolume = binanceTakerData.volume;
        let pressure = 50;
        if (demandVolume + supplyVolume > 0) {
            pressure = (demandVolume / (demandVolume + supplyVolume)) * 100;
        }
        monitorState.buyingPressure = pressure;

        // Calcular Tendencia
        priceHistory.push(binanceMaker);
        if (priceHistory.length > 5) {
            priceHistory.shift();
        }
        let trend = 'STABLE';
        if (priceHistory.length >= 3) {
            const previousPrices = priceHistory.slice(0, -1);
            const avg = previousPrices.reduce((a, b) => a + b, 0) / previousPrices.length;
            if (binanceMaker > avg + 0.05) {
                trend = 'UP';
            } else if (binanceMaker < avg - 0.05) {
                trend = 'DOWN';
            }
        }
        monitorState.trend = trend;

        monitorState.lastUpdate = new Date().toLocaleTimeString('es-VE', { 
            timeZone: 'America/Caracas',
            hour12: true,
            hour: '2-digit',
            minute: '2-digit'
        });

        const bcv = monitorState.bcvRate;
        const effectiveBcv = bcv;
        const bcvStr = `${bcv.toFixed(2)}`;
        const src = monitorState.dataSources;

        const marketList = [];
        if (monitorState.visibleBanks.includes('BDV')) marketList.push(`🇻🇪 <b>Venezuela (BDV):</b> ${monitorState.bankStatuses['BDV']}`);
        if (monitorState.visibleBanks.includes('TESORO')) marketList.push(`💰 <b>Tesoro:</b> ${monitorState.bankStatuses['TESORO']}`);
        if (monitorState.visibleBanks.includes('BDT')) marketList.push(`🏢 <b>BDT:</b> ${monitorState.bankStatuses['BDT']}`);
        if (monitorState.visibleBanks.includes('ACTIVO')) marketList.push(`🏦 <b>Banco Activo:</b> ${monitorState.bankStatuses['ACTIVO']}`);
        if (monitorState.visibleBanks.includes('BANCAMIGA')) marketList.push(`💎 <b>Bancamiga:</b> ${monitorState.bankStatuses['BANCAMIGA']}`);
        if (monitorState.visibleBanks.includes('PROVINCIAL')) marketList.push(`💙 <b>Provincial:</b> ${monitorState.bankStatuses['PROVINCIAL']}`);

        const activeReportsMaker = [];
        const activeReportsTaker = [];
        
        const bdtVisible = monitorState.visibleBanks.includes('BDT');
        const bdvVisible = monitorState.visibleBanks.includes('BDV');
        const tesoroVisible = monitorState.visibleBanks.includes('TESORO');
        const activoVisible = monitorState.visibleBanks.includes('ACTIVO');
        const bancamigaVisible = monitorState.visibleBanks.includes('BANCAMIGA');
        const provincialVisible = monitorState.visibleBanks.includes('PROVINCIAL');

        const bpayCom = monitorState.bpayCommission || 4.1;

        // Maker
        if (bdtVisible) activeReportsMaker.push(calcReport(effectiveBcv, binanceMaker, 'BDT', 1.5, bpayCom, 1.5));
        if (bdvVisible) {
            activeReportsMaker.push(calcReport(effectiveBcv, binanceMaker, 'BDV (Digital)', 2.5, bpayCom));
            activeReportsMaker.push(calcReport(effectiveBcv, binanceMaker, 'BDV (Física)', 1.5, bpayCom));
        }
        if (tesoroVisible) activeReportsMaker.push(calcReport(effectiveBcv, binanceMaker, 'Tesoro', 2.5, bpayCom));
        if (activoVisible) activeReportsMaker.push(calcReport(effectiveBcv, binanceMaker, 'Activo', 1.5, bpayCom));
        if (bancamigaVisible) activeReportsMaker.push(calcReport(effectiveBcv, binanceMaker, 'Bancamiga', 5, bpayCom));
        if (provincialVisible) activeReportsMaker.push(calcReport(effectiveBcv, binanceMaker, 'Provincial', 0, bpayCom));

        // Taker
        if (bdtVisible) activeReportsTaker.push(calcReport(effectiveBcv, binanceTaker, 'BDT', 1.5, bpayCom, 1.5));
        if (bdvVisible) {
            activeReportsTaker.push(calcReport(effectiveBcv, binanceTaker, 'BDV (Digital)', 2.5, bpayCom));
            activeReportsTaker.push(calcReport(effectiveBcv, binanceTaker, 'BDV (Física)', 1.5, bpayCom));
        }
        if (tesoroVisible) activeReportsTaker.push(calcReport(effectiveBcv, binanceTaker, 'Tesoro', 2.5, bpayCom));
        if (activoVisible) activeReportsTaker.push(calcReport(effectiveBcv, binanceTaker, 'Activo', 1.5, bpayCom));
        if (bancamigaVisible) activeReportsTaker.push(calcReport(effectiveBcv, binanceTaker, 'Bancamiga', 5, bpayCom));
        if (provincialVisible) activeReportsTaker.push(calcReport(effectiveBcv, binanceTaker, 'Provincial', 0, bpayCom));

        const report = `
📊 <b>MONITOR DE ECONOMÍA VENEZUELA</b>
⏱ <i>Actualización: ${monitorState.lastUpdate}</i>

🏦 <b>BCV (Intervención):</b> ${bcvStr} VES

📈 <b>TENDENCIA DEL MERCADO:</b>
• <b>Dirección:</b> ${monitorState.trend === 'UP' ? '⬆️ ALCISTA' : (monitorState.trend === 'DOWN' ? '⬇️ BAJISTA' : '➡️ ESTABLE')}
• <b>Presión de Compra:</b> ${monitorState.buyingPressure.toFixed(1)}% (${monitorState.buyingPressure >= 53 ? 'Fuerte Demanda' : (monitorState.buyingPressure <= 47 ? 'Fuerte Oferta' : 'Equilibrado')})

 🏛 <b>MERCADO CAMBIARIO:</b>
${marketList.join('\n')}

🔶 <b>Binance P2P (USDT):</b>
• <b>Maker (Publicar):</b> ${monitorState.binanceRateMaker.toFixed(2)} VES
• <b>Taker (Rápido):</b> ${monitorState.binanceRateTaker.toFixed(2)} VES
📐 <b>Spread:</b> Maker: ${monitorState.spread.toFixed(2)}% | Taker: ${monitorState.spreadTaker.toFixed(2)}%

🧮 <b>ARBITRAJE — Base 100 USDT</b>

🛒 <b>Como MAKER (Publicando anuncio):</b>
${activeReportsMaker.join('\n')}

⚡️ <b>Como TAKER (Venta rápida):</b>
${activeReportsTaker.join('\n')}

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

app.post('/api/forecast/alert', async (req, res) => {
    try {
        const trend = monitorState.trend;
        const pressure = monitorState.buyingPressure;
        const bcv = monitorState.bcvRate;
        const maker = monitorState.binanceRateMaker;
        const taker = monitorState.binanceRateTaker;
        
        const trendEmoji = trend === 'UP' ? '⬆️' : (trend === 'DOWN' ? '⬇️' : '➡️');
        const trendLabel = trend === 'UP' ? 'ALCISTA' : (trend === 'DOWN' ? 'BAJISTA' : 'ESTABLE');
        const pressureStatus = pressure >= 53 ? 'Fuerte Demanda' : (pressure <= 47 ? 'Fuerte Oferta' : 'Equilibrado');
        
        let analysis = '';
        if (pressure <= 25) {
            analysis = '🚨 <b>FUERTE PRESIÓN BAJISTA OPERATIVA:</b> La oferta de USDT duplica o supera por mucho a la demanda. Los vendedores están compitiendo agresivamente bajando precios para captar bolívares. Se pronostica que la tasa P2P seguirá cayendo levemente o se mantendrá en mínimos en las próximas horas.';
        } else if (pressure < 47) {
            analysis = '📉 <b>PRESIÓN BAJISTA MODERADA:</b> Hay más vendedores que compradores en la cola. La tasa tiende a deslizarse hacia abajo lentamente.';
        } else if (pressure >= 75) {
            analysis = '🚀 <b>FUERTE PRESIÓN ALCISTA:</b> La demanda de USDT supera con creces la oferta disponible. Pocos comerciantes vendiendo, muchos comprando. Se pronostica tendencia alcista inmediata en la tasa P2P.';
        } else if (pressure > 53) {
            analysis = '📈 <b>PRESIÓN ALCISTA MODERADA:</b> La demanda es favorable. La tasa tiende a subir o mantenerse estable al alza.';
        } else {
            analysis = '➡️ <b>MERCADO EQUILIBRADO:</b> Oferta y demanda se encuentran en rangos estables. No se prevén variaciones bruscas de precio a muy corto plazo.';
        }
        
        const bpayCom = monitorState.bpayCommission || 4.1;
        const breakEven = bcv / (1 - bpayCom/100) / 0.985 / 0.985; // BDT/BPay formula dinámica
        const marginMaker = ((maker - breakEven) / breakEven) * 100;
        const marginTaker = ((taker - breakEven) / breakEven) * 100;
        
        const time = new Date().toLocaleTimeString('es-VE', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hour12: true });
        
        const message = `📊 <b>ANÁLISIS DE MERCADO & PREDICCIÓN</b>
⏱ <i>Generado: ${time}</i>

💵 <b>TASAS EN VIVO:</b>
• <b>BCV Intervención:</b> ${bcv.toFixed(2)} VES
• <b>P2P Maker:</b> ${maker.toFixed(2)} VES (Margen BDT: +${marginMaker.toFixed(2)}%)
• <b>P2P Taker:</b> ${taker.toFixed(2)} VES (Margen BDT: +${marginTaker.toFixed(2)}%)

📈 <b>MÉTRICAS DE FUERZA:</b>
• <b>Dirección:</b> ${trendEmoji} <b>${trendLabel}</b>
• <b>Presión de Compra:</b> <b>${pressure.toFixed(1)}%</b> (${pressureStatus})

🔍 <b>PROSPECTO / DIAGNÓSTICO:</b>
${analysis}

💡 <b>Recomendación operativa:</b>
${pressure <= 35 ? '⚠️ Si necesitas bolívares para la intervención, liquida antes del cierre de plataformas bancarias. Evita dejar saldos congelados por mantenimientos nocturnos.' : '✅ Buen momento para operar o mantener según tus objetivos de rentabilidad bancaria.'}

⚠️ <i>Nota: Este análisis automatizado es cuantitativo y no constituye asesoría financiera formal.</i>`;

        await sendTelegramAlert(message);
        addLog('📊 Análisis y predicción enviados a Telegram.');
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

app.post('/api/bcv/rate', (req, res) => {
    const { rate, isManual } = req.body;
    
    if (rate !== undefined) {
        const val = parseFloat(rate);
        if (!isNaN(val) && val > 0) {
            monitorState.bcvRate = val;
            monitorState.isBcvManual = true;
            addLog(`🛠 MODO MANUAL BCV: Tasa fijada en ${val.toFixed(2)} Bs`);
        } else {
            return res.status(400).json({ error: 'Tasa inválida' });
        }
    }
    
    if (isManual !== undefined) {
        monitorState.isBcvManual = !!isManual;
        if (!monitorState.isBcvManual) {
            addLog(`🤖 MODO AUTO BCV: La tasa de intervención seguirá a las fuentes automáticas`);
        }
    }
    
    // Recalcular spread
    if (monitorState.binanceRateMaker > 0 && monitorState.bcvRate > 0) {
        monitorState.spread = ((monitorState.binanceRateMaker - monitorState.bcvRate) / monitorState.bcvRate) * 100;
        monitorState.binanceRate = monitorState.binanceRateMaker; // compatibilidad
    }
    if (monitorState.binanceRateTaker > 0 && monitorState.bcvRate > 0) {
        monitorState.spreadTaker = ((monitorState.binanceRateTaker - monitorState.bcvRate) / monitorState.bcvRate) * 100;
    }
    
    // Emitir a sockets
    io.emit('state_update', monitorState);
    
    // Ejecutar actualización
    runMonitor();
    
    res.json({ success: true, state: monitorState });
});

app.post('/api/bpay/commission', (req, res) => {
    const { commission } = req.body;
    const val = parseFloat(commission);
    if (!isNaN(val) && val >= 0) {
        monitorState.bpayCommission = val;
        addLog(`🛠 COMISIÓN BPAY: Tasa fijada en ${val.toFixed(2)}%`);
        io.emit('state_update', monitorState);
        runMonitor();
        res.json({ success: true, state: monitorState });
    } else {
        res.status(400).json({ error: 'Comisión inválida' });
    }
});

app.post('/api/banks/visibility', (req, res) => {
    const { visibleBanks } = req.body;
    if (Array.isArray(visibleBanks)) {
        const validBanks = ['BDV', 'TESORO', 'BDT', 'ACTIVO', 'BANCAMIGA', 'PROVINCIAL'];
        monitorState.visibleBanks = visibleBanks.filter(b => validBanks.includes(b));
        addLog(`🛠 MONITOREAR BANCOS: Actualizado a [${monitorState.visibleBanks.join(', ')}]`);
        io.emit('state_update', monitorState);
        runMonitor();
        res.json({ success: true, state: monitorState });
    } else {
        res.status(400).json({ error: 'Formato inválido' });
    }
});

io.on('connection', (socket) => {
    socket.emit('state_update', monitorState);
});

app.post('/api/interval', (req, res) => {
    const { minutes } = req.body;
    const mins = parseInt(minutes);
    if (!isNaN(mins)) {
        monitorState.interval = mins;
        addLog(`⏲ Intervalo actualizado a: ${mins} minutos`);
        
        if (monitorState.isRunning) {
            clearInterval(monitorInterval);
            monitorInterval = setInterval(runMonitor, mins * 60 * 1000);
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

// ===== USERBOT: ESPEJO EN TIEMPO REAL =====
let userBotClient = null;

async function fetchLastMessage() {
    if (!userBotClient) {
        addLog('⚠️ UserBot no conectado. No se puede buscar último mensaje.');
        return { success: false, error: 'UserBot no conectado' };
    }

    try {
        const channel = await userBotClient.getEntity('httpsbancocompradedivisa');
        const messages = await userBotClient.getMessages(channel, { limit: 5 });
        
        if (messages.length === 0) {
            addLog('⚠️ No hay mensajes recientes en el canal BANCO $$$');
            return { success: false, error: 'Sin mensajes' };
        }

        // Buscar el primer mensaje con texto
        const lastMsg = messages.find(m => m.message && m.message.trim().length > 0);
        if (!lastMsg) {
            addLog('⚠️ No se encontró mensaje con texto en BANCO $$$');
            return { success: false, error: 'Sin mensajes de texto' };
        }

        const text = lastMsg.message;
        console.log(`[ESPEJO] Último mensaje de BANCO $$$: ${text.substring(0, 80)}...`);
        addLog(`📢 ESPEJO: Último mensaje obtenido de BANCO $$$ (${text.length} chars)`);

        // Replicar al canal destino
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: `📢 *BANCO \$ \$ \$* 📢\n\n${text}`,
            parse_mode: 'Markdown'
        });

        addLog('✅ Último mensaje replicado exitosamente');
        return { success: true, text: text.substring(0, 100) + '...' };
    } catch (e) {
        console.error('[ESPEJO] Error buscando último mensaje:', e.message);
        addLog(`❌ Error buscando último mensaje: ${e.message}`);
        return { success: false, error: e.message };
    }
}

async function startUserBot() {
    if (!userBotSession) {
        console.log('[USERBOT] Sin sesión. Espejo desactivado.');
        addLog('⚠️ UserBot sin sesión. Canal BANCO$$$ no será monitoreado en tiempo real.');
        return;
    }

    try {
        const client = new TelegramClient(
            new StringSession(userBotSession),
            USERBOT_API_ID,
            USERBOT_API_HASH,
            { connectionRetries: 5 }
        );

        await client.connect();
        userBotClient = client;
        console.log('[USERBOT] ✅ Conectado y escuchando canal BANCO $$$...');
        addLog('🔗 UserBot CONECTADO: Escuchando canal BANCO $$$ en tiempo real');

        // Buscar y reenviar el último mensaje al arrancar
        await fetchLastMessage();

        client.addEventHandler(async (event) => {
            try {
                const message = event.message;
                if (!message || !message.peerId || !message.message) return;

                const channel = await client.getEntity(message.peerId);
                const username = (channel.username || '').toLowerCase();

                // Verificar si el mensaje viene del canal objetivo
                if (username === 'httpsbancocompradedivisa' || username === 'bancocompradedivisa') {
                    const text = message.message;
                    console.log(`[ESPEJO] Mensaje capturado del canal BANCO $$$: ${text.substring(0, 80)}...`);
                    addLog(`📢 ESPEJO: Mensaje capturado de BANCO $$$ (${text.length} chars)`);

                    // Replicar exactamente al canal destino
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        chat_id: CHAT_ID,
                        text: `📢 *BANCO \$ \$ \$* 📢\n\n${text}`,
                        parse_mode: 'Markdown'
                    });

                    addLog('✅ Mensaje replicado exitosamente al canal destino');
                }
            } catch (err) {
                console.error('[ESPEJO] Error procesando mensaje:', err.message);
                addLog(`❌ Error espejo: ${err.message}`);
            }
        }, new NewMessage({}));

    } catch (e) {
        console.error('[USERBOT] Error de conexión:', e.message);
        addLog(`❌ UserBot error: ${e.message}`);
    }
}

// Endpoint manual para reenviar último mensaje
app.post('/api/mirror/last', async (req, res) => {
    const result = await fetchLastMessage();
    res.json(result);
});

app.get('/api/debug/userbot', (req, res) => {
    res.json({
        hasSession: !!userBotSession,
        sessionLength: userBotSession ? userBotSession.length : 0,
        isClientInitialized: !!userBotClient,
        clientConnected: userBotClient ? userBotClient.connected : false
    });
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

    // Iniciar UserBot para espejo en tiempo real con un delay de 15 segundos
    // Esto evita AUTH_KEY_DUPLICATED durante los despliegues progresivos (Rolling deploys) de Railway
    setTimeout(() => {
        startUserBot();
    }, 15000);
});
