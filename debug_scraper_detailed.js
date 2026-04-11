const axios = require('axios');
const cheerio = require('cheerio');

async function testScraper() {
    try {
        const res = await axios.get('https://t.me/s/E_positivo');
        const $ = cheerio.load(res.data);
        const messages = $('.tgme_widget_message_text').toArray();
        
        console.log(`Found ${messages.length} messages.`);
        
        for (let i = messages.length - 1; i >= 0; i--) {
            const text = $(messages[i]).text();
            console.log(`--- Message ${i} ---`);
            console.log(text);
            
            // Try to find the rate
            const matches = text.match(/(\d+[\.,]\d{2})/g);
            if (matches) {
                console.log(`Matches found: ${matches.join(', ')}`);
            }
        }

    } catch (e) {
        console.error(e);
    }
}

testScraper();
