const axios = require('axios');
const cheerio = require('cheerio');

axios.get('https://t.me/s/E_positivo').then(r => {
    const $ = cheerio.load(r.data);
    $('.tgme_widget_message_text').toArray().forEach(m => {
        const text = $(m).text();
        console.log(text);
        console.log('---');
    });
}).catch(console.error);
