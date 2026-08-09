import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrl = 'https://www.mobile.bg/dealers',
    maxListingPages = 0, // 0 = без лимит
    maxDealers = 0, // 0 = без лимит
    maxConcurrency = 10,
} = input;

/**
 * ---------------------------------------------------------------------------
 * ФАЗА 1: Обхождаме https://www.mobile.bg/dealers (и пагинацията му) и
 * събираме уникалните под-домейни на дилърите, напр. https://atlanticdrive.mobile.bg
 * ---------------------------------------------------------------------------
 */
const dealerLinks = new Map(); // url -> name (както е показано в списъка)
let listingPagesVisited = 0;

const listingCrawler = new CheerioCrawler({
    maxConcurrency: 3,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 60,
    async requestHandler({ request, $, enqueueLinks, log: reqLog }) {
        listingPagesVisited += 1;
        reqLog.info(`[Списък] ${request.url} (страница ${listingPagesVisited})`);

        // Всеки дилър в списъка има линк към собствения си под-домейн
        // (напр. https://atlanticdrive.mobile.bg), който се среща по няколко
        // пъти на страницата (име, лого, "Виж всички обяви"). Събираме ги
        // уникално по домейн.
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;

            const m = href.match(/^https?:\/\/([a-z0-9-]+)\.mobile\.bg\/?(?:[?#].*)?$/i);
            if (!m) return;

            const subdomain = m[1].toLowerCase();
            if (subdomain === 'www') return; // прескачаме самия www.mobile.bg

            const dealerUrl = `https://${subdomain}.mobile.bg`;
            const text = $(el).text().trim();

            if (!dealerLinks.has(dealerUrl)) {
                dealerLinks.set(dealerUrl, text || null);
            } else if (text && !dealerLinks.get(dealerUrl)) {
                // допълваме името, ако предният път сме хванали линк без текст (напр. лого)
                dealerLinks.set(dealerUrl, text);
            }
        });

        if (maxListingPages > 0 && listingPagesVisited >= maxListingPages) {
            reqLog.info('Достигнат е лимитът за страници от списъка, спирам пагинацията.');
            return;
        }

        // Пагинация: търсим линк "Напред" или /dealers/p-N
        let nextHref = $('a')
            .filter((_, el) => $(el).text().trim().toLowerCase() === 'напред')
            .attr('href');

        if (!nextHref) {
            nextHref = $('a[href*="/dealers/p-"]')
                .attr('href');
        }

        if (nextHref) {
            const nextUrl = new URL(nextHref, request.url).toString();
            await enqueueLinks({ urls: [nextUrl] });
        }
    },
    failedRequestHandler({ request, log: reqLog }) {
        reqLog.warning(`Провалена страница от списъка: ${request.url}`);
    },
});

await listingCrawler.run([startUrl]);

log.info(`Намерени ${dealerLinks.size} уникални дилъра в ${listingPagesVisited} страници от списъка.`);

let dealerEntries = [...dealerLinks.entries()]; // [ [url, name], ... ]
if (maxDealers > 0) {
    dealerEntries = dealerEntries.slice(0, maxDealers);
}

/**
 * ---------------------------------------------------------------------------
 * ФАЗА 2: За всеки дилър отваряме {dealerUrl}/contacts (бутонът "Контакти")
 * и извличаме телефон, адрес и дата на регистрация.
 * ---------------------------------------------------------------------------
 */
const PHONE_REGEX = /(\+359[\s.-]?\d{1,3}[\s.-]?\d{3}[\s.-]?\d{3,4}|0\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4})/g;

function cleanPhone(raw) {
    return raw.replace(/[\s.-]/g, '');
}

function extractBetween(text, startMarker, endMarkers) {
    const startIdx = text.indexOf(startMarker);
    if (startIdx === -1) return null;
    let sliceStart = startIdx + startMarker.length;
    let sliceEnd = text.length;
    for (const marker of endMarkers) {
        const idx = text.indexOf(marker, sliceStart);
        if (idx !== -1 && idx < sliceEnd) sliceEnd = idx;
    }
    const value = text.slice(sliceStart, sliceEnd).trim();
    return value || null;
}

const contactsCrawler = new CheerioCrawler({
    maxConcurrency,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 60,
    async requestHandler({ request, $, log: reqLog }) {
        const { dealerUrl, listedName } = request.userData;

        const pageText = $.root().text().replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();

        // Име на дилъра: заглавието на страницата е "Контакти - <Име>"
        let dealerName = $('h1').first().text().trim();
        dealerName = dealerName.replace(/^Контакти\s*-\s*/i, '').trim();
        if (!dealerName) dealerName = listedName || null;

        const phonesRaw = pageText.match(PHONE_REGEX) || [];
        const phones = [...new Set(phonesRaw.map(cleanPhone))];

        const address = extractBetween(pageText, 'Адрес:', ['Кореспондентски адрес:', 'Обяви', 'Изпратете', 'За да се свържете', 'Powered by']);
        const correspondenceAddress = extractBetween(
            pageText,
            'Кореспондентски адрес:',
            ['Обяви', 'Изпратете', 'За да се свържете', 'Powered by'],
        );

        // Защитна мярка: ако маркерите липсват, не позволяваме адресът да
        // "погълне" целия остатък на страницата.
        const trimTo200 = (v) => (v && v.length > 200 ? `${v.slice(0, 200).trim()}…` : v);

        const memberSinceMatch = pageText.match(/в mobile\.bg\s+от\s+(\d{4})\s*г\./i);
        const memberSince = memberSinceMatch ? memberSinceMatch[1] : null;

        const result = {
            dealerName,
            dealerUrl,
            contactsUrl: request.url,
            phones,
            address: trimTo200(address),
            correspondenceAddress: trimTo200(correspondenceAddress),
            memberSince,
            scrapedAt: new Date().toISOString(),
        };

        if (phones.length === 0) {
            reqLog.warning(`Не е намерен телефон за ${dealerUrl} — записвам все пак с празен масив.`);
        }

        await Actor.pushData(result);
    },
    failedRequestHandler({ request, log: reqLog }) {
        reqLog.warning(`Провалена страница с контакти: ${request.url}`);
    },
});

await contactsCrawler.run(
    dealerEntries.map(([dealerUrl, listedName]) => ({
        url: `${dealerUrl}/contacts`,
        userData: { dealerUrl, listedName },
    })),
);

log.info('Готово.');

await Actor.exit();
