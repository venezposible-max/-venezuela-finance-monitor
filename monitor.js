const axios = require('axios');
const cheerio = require('cheerio');

// --- CONFIGURACIÓN ---
const TELEGRAM_CHANNEL_SOURCE = 'E_positivo';
const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

// Credenciales (Ahora usando Variables de Entorno para Railway/GitHub)
const BOT_TOKEN = process.env.BOT_TOKEN; 
const CHAT_ID = process.env.CHAT_ID;    

async function getBinanceRate() {
    try {
        const payload = {
            asset: 'USDT',
            fiat: 'VES',
            merchantCheck: false,
            page: 1,
            payTypes: [],
            publisherType: null,
            rows: 10,
            tradeType: 'BUY'
        };
        const res = await axios.post(BINANCE_P2P_URL, payload);
        const ads = res.data.data;
        if (!ads || ads.length === 0) return 0;
        
        const prices = ads.slice(0, 5).map(ad => parseFloat(ad.adv.price));
        return prices.reduce((a, b) => a + b, 0) / prices.length;
    } catch (e) {
        console.error('Error Binance:', e.message);
        return 0;
    }
}

async function getTelegramData() {
    try {
        const res = await axios.get(`https://t.me/s/${TELEGRAM_CHANNEL_SOURCE}`);
        const $ = cheerio.load(res.data);
        const messages = $('.tgme_widget_message_text').toArray();
        
        let foundRate = null;
        let bankStatuses = {
            'BDV': 'CERRADO 🔴',
            'TESORO': 'CERRADO 🔴'
        };

        for (let i = messages.length - 1; i >= 0; i--) {
            const text = $(messages[i]).text();
            const lowerText = text.toLowerCase();
            
            // Tasa BCV
            if (text.includes('BCV') || text.includes('Intervención') || text.includes('Tasa')) {
                const matches = text.match(/(\d{2,3}[\.,]\d{2})/g);
                if (matches && !foundRate) {
                    const val = parseFloat(matches[0].replace(',', '.'));
                    if (val > 400 && val < 1000) foundRate = val;
                }
            }

            // Status por Banco
            const isExplicitlyOpen = lowerText.includes('inició venta') || lowerText.includes('abrió venta') || lowerText.includes('hay cupo') || (lowerText.includes('abierto') && !lowerText.includes('no'));
            const isExplicitlyClosed = lowerText.includes('cerrado') || lowerText.includes('finalizó') || lowerText.includes('terminó') || lowerText.includes('sin cupo') || lowerText.includes('concluyó');

            if (lowerText.includes('venezuela') || lowerText.includes('bdv')) {
                if (isExplicitlyOpen) bankStatuses['BDV'] = 'ABIERTO 🟢';
                else if (isExplicitlyClosed) bankStatuses['BDV'] = 'CERRADO 🔴';
            }
            if (lowerText.includes('tesoro')) {
                if (isExplicitlyOpen) bankStatuses['TESORO'] = 'ABIERTO 🟢';
                else if (isExplicitlyClosed) bankStatuses['TESORO'] = 'CERRADO 🔴';
            }
        }

        if (!foundRate) foundRate = 571.75;

        return { rate: foundRate, banks: bankStatuses };
    } catch (e) {
        console.error('Error Telegram Scrap:', e.message);
        return { rate: 571.75, status: 'Error' };
    }
}

async function sendTelegramAlert(message) {
    if (!BOT_TOKEN || !CHAT_ID) {
        console.warn('⚠️ BOT_TOKEN o CHAT_ID no configurados en las variables de entorno.');
        return;
    }
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log('✅ Alerta enviada a Telegram.');
    } catch (e) {
        console.error('❌ Error enviando a Telegram:', e.response ? e.response.data : e.message);
    }
}

async function update() {
    console.log(`\n[${new Date().toLocaleTimeString()}] Actualizando datos...`);

    const binance = await getBinanceRate();
    const telegram = await getTelegramData();

    if (binance === 0) return;

    const spread = ((binance - telegram.rate) / telegram.rate) * 100;
    
    const report = `
📊 <b>MONITOR DE ECONOMÍA VENEZUELA</b>
⏱ <i>Actualización: ${new Date().toLocaleTimeString()}</i>

🏦 <b>BCV (Intervención):</b> ${telegram.rate.toFixed(2)} VES

🏛 <b>MERCADO CAMBIARIO:</b>
🇻🇪 <b>Venezuela (BDV):</b> ${telegram.banks['BDV']}
💰 <b>Tesoro:</b> ${telegram.banks['TESORO']}

🔶 <b>Binance P2P (USDT):</b> ${binance.toFixed(2)} VES
📐 <b>Spread (Brecha):</b> ${spread.toFixed(2)}%
    `;

    console.log(report.replace(/<[^>]*>/g, '')); 
    await sendTelegramAlert(report);
}

setInterval(update, 5 * 60 * 1000);
update();

console.log('🚀 Monitor activo en modo producción.');
