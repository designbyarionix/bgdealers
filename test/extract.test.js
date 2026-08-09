import * as cheerio from 'cheerio';

// Този HTML имитира реалната структура на страницата
// https://<dealer>.mobile.bg/contacts, каквато я видях на живо за
// atlanticdrive.mobile.bg/contacts (текст, адрес, телефон).
const sampleHtml = `
<html>
<body>
  <h1>Контакти - ATLANTIC DRIVE - Внос на леки автомобили, джипове и лек транспорт.</h1>
  <nav>Начало 29 За нас Контакти</nav>
  <div class="contacts-block">
    Контакти с нас
    0878119140
    в mobile.bg от 2025 г.
    Виж всичките обяви на дилъра
    Адрес: гр. София, Столична община
    Кореспондентски адрес: Столична община, ул. Съборна поляна №38
  </div>
  <div class="msg-form">Изпратете съобщение</div>
</body>
</html>
`;

const PHONE_REGEX = /(\+359[\s.-]?\d{1,3}[\s.-]?\d{3}[\s.-]?\d{3,4}|0\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4})/g;
function cleanPhone(raw) { return raw.replace(/[\s.-]/g, ''); }
function extractBetween(text, startMarker, endMarkers) {
    const startIdx = text.indexOf(startMarker);
    if (startIdx === -1) return null;
    let sliceStart = startIdx + startMarker.length;
    let sliceEnd = text.length;
    for (const marker of endMarkers) {
        const idx = text.indexOf(marker, sliceStart);
        if (idx !== -1 && idx < sliceEnd) sliceEnd = idx;
    }
    return text.slice(sliceStart, sliceEnd).trim() || null;
}

const $ = cheerio.load(sampleHtml);
const pageText = $.root().text().replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();

let dealerName = $('h1').first().text().trim().replace(/^Контакти\s*-\s*/i, '').trim();
const phones = [...new Set((pageText.match(PHONE_REGEX) || []).map(cleanPhone))];
const address = extractBetween(pageText, 'Адрес:', ['Кореспондентски адрес:', 'Обяви', 'Контакти']);
const correspondenceAddress = extractBetween(pageText, 'Кореспондентски адрес:', ['Обяви', 'Контакти', 'Powered by']);
const memberSinceMatch = pageText.match(/в mobile\.bg\s+от\s+(\d{4})\s*г\./i);
const memberSince = memberSinceMatch ? memberSinceMatch[1] : null;

const result = { dealerName, phones, address, correspondenceAddress, memberSince };
console.log(JSON.stringify(result, null, 2));

const expected = {
    dealerName: 'ATLANTIC DRIVE - Внос на леки автомобили, джипове и лек транспорт.',
    phones: ['0878119140'],
    memberSince: '2025',
};

let ok = true;
if (result.dealerName !== expected.dealerName) { console.error('FAIL dealerName'); ok = false; }
if (JSON.stringify(result.phones) !== JSON.stringify(expected.phones)) { console.error('FAIL phones'); ok = false; }
if (result.memberSince !== expected.memberSince) { console.error('FAIL memberSince'); ok = false; }
if (!result.address || !result.address.includes('София')) { console.error('FAIL address'); ok = false; }
if (!result.correspondenceAddress || !result.correspondenceAddress.includes('Съборна поляна')) { console.error('FAIL correspondenceAddress'); ok = false; }

console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
