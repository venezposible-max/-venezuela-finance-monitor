const axios = require('axios');
const cheerio = require('cheerio');

async function testScraper() {
    try {
        const res = await axios.get('https://t.me/s/E_positivo');
        const $ = cheerio.load(res.data);
        const messages = $('.tgme_widget_message_text').toArray();
        
        console.log(`Found ${messages.length} messages.`);
        
        for (let i = messages.length - 1; i >= Math.max(0, messages.length - 50); i--) {
            const text = $(messages[i]).text();
            if (text.includes('BCV') || text.includes('Intervención')) {
                 console.log(`--- Message ${i} ---`);
                 console.log(text);
                 const matches = text.match(/(\d+[\.,]\d{2})/g);
                 if (matches) console.log(`  Matches: ${matches.join(', ')}`);
            }
        }

    } catch (e) {
        console.error(e);
    }
}

testScraper();
