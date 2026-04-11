const axios = require('axios');

async function testBinance() {
    try {
        const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
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
        if (!ads || ads.length === 0) {
            console.log('No ads found');
            return;
        }
        const prices = ads.slice(0, 5).map(ad => parseFloat(ad.adv.price));
        console.log('Prices:', prices);
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        console.log('Average:', avg);
    } catch (e) {
        console.error(e.message);
    }
}

testBinance();
