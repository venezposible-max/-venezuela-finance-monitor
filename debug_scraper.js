const axios = require('axios');
const cheerio = require('cheerio');

async function testScraper() {
    try {
        const res = await axios.get('https://t.me/s/E_positivo');
        const $ = cheerio.load(res.data);
        const messages = $('.tgme_widget_message_text').toArray();
        
        console.log(`Found ${messages.length} messages.`);
        
        messages.slice(-5).forEach((msg, i) => {
            console.log(`--- Message ${i + 1} ---`);
            console.log($(msg).text());
        });

        let foundRate = null;
        for (let i = messages.length - 1; i >= 0; i--) {
            const text = $(messages[i]).text();
            if (text.includes('BCV') || text.includes('Intervención') || text.includes('Tasa')) {
                const matches = text.match(/(\d{2,3}[\.,]\d{2})/g);
                if (matches && !foundRate) {
                    const val = parseFloat(matches[0].replace(',', '.'));
                    console.log(`Possible rate found: ${val}`);
                    if (val > 30 && val < 1000) { // Adjusted range for current reality
                        foundRate = val;
                    }
                }
            }
        }
        console.log(`Final Rate Found: ${foundRate}`);

    } catch (e) {
        console.error(e);
    }
}

testScraper();
