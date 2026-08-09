import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrl = 'https://www.mobile.bg/dealers',
    maxListingPages = 0, // 0 = без лимит
    maxDealers = 0, // 0 = без лимит
    maxConcurrency = 10,
    findOfficialWebsite = false,
    scrapeEmails = false,
    googleSearchCountryCode = 'bg',
    googleSearchLanguageCode = 'bg',
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

const dealerResults = [];

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
            officialWebsite: null,
            emails: [],
            scrapedAt: new Date().toISOString(),
        };

        if (phones.length === 0) {
            reqLog.warning(`Не е намерен телефон за ${dealerUrl} — записвам все пак с празен масив.`);
        }

        dealerResults.push(result);
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

log.info(`Извлечени контакти за ${dealerResults.length} дилъра.`);

/**
 * ---------------------------------------------------------------------------
 * ФАЗА 3 (опционална): Търсене на официалния уебсайт на всеки дилър в Google.
 * Използваме готовия официален Apify актор "apify/google-search-scraper" —
 * не правим Google scraping от нулата.
 * ---------------------------------------------------------------------------
 */
const BLACKLISTED_DOMAINS = [
    'mobile.bg',
    'facebook.com',
    'instagram.com',
    'tiktok.com',
    'youtube.com',
    'linkedin.com',
    'olx.bg',
    'bazar.bg',
    'imot.bg',
    'auto.bg',
    'cars.bg',
    'google.com',
    'g.page',
    'goo.gl',
    'zlatnistranici.bg',
    'wikipedia.org',
    'apify.com',
];

function isBlacklisted(urlString) {
    try {
        const host = new URL(urlString).hostname.replace(/^www\./, '').toLowerCase();
        return BLACKLISTED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
        return true; // невалиден URL -> третираме като неизползваем
    }
}

if (findOfficialWebsite && dealerResults.length > 0) {
    log.info('ФАЗА 3: Търсене на официални уебсайтове чрез apify/google-search-scraper…');

    const dealersWithName = dealerResults.filter((d) => d.dealerName);
    const queries = dealersWithName.map((d) => `"${d.dealerName}" автокъща`);

    try {
        const searchRun = await Actor.call('apify/google-search-scraper', {
            queries: queries.join('\n'),
            resultsPerPage: 10,
            maxPagesPerQuery: 1,
            countryCode: googleSearchCountryCode,
            languageCode: googleSearchLanguageCode,
        });

        const searchDataset = await Actor.openDataset(searchRun.defaultDatasetId, { forceCloud: true });
        const { items: searchItems } = await searchDataset.getData();

        // Мапваме резултата обратно към дилъра по точния текст на заявката.
        const queryToDealer = new Map();
        dealersWithName.forEach((d, i) => queryToDealer.set(queries[i], d));

        for (const item of searchItems) {
            const term = item?.searchQuery?.term;
            if (!term) continue;
            const dealer = queryToDealer.get(term);
            if (!dealer) continue;

            const organicResults = item.organicResults || [];
            const firstGood = organicResults.find((r) => r?.url && !isBlacklisted(r.url));
            if (firstGood) {
                dealer.officialWebsite = firstGood.url;
            }
        }

        const foundCount = dealerResults.filter((d) => d.officialWebsite).length;
        log.info(`Намерени официални уебсайтове за ${foundCount} от ${dealersWithName.length} дилъра.`);
    } catch (err) {
        log.warning(`Търсенето в Google се провали: ${err.message}. Продължавам без официални уебсайтове.`);
    }
}

/**
 * ---------------------------------------------------------------------------
 * ФАЗА 4 (опционална): Влизаме в намерения официален уебсайт и извличаме
 * имейл адреси (mailto: линкове + regex по видимия текст).
 * ---------------------------------------------------------------------------
 */
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const GENERIC_JUNK_EMAILS = new Set(['example@example.com', 'name@example.com', 'you@example.com']);

async function fetchHtml(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; DealerEmailBot/1.0)',
                Accept: 'text/html,application/xhtml+xml',
            },
            redirect: 'follow',
        });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function extractEmailsFromHtml(html) {
    if (!html) return [];
    const mailtoMatches = [...html.matchAll(/mailto:([^"'\s?>]+)/gi)].map((m) => m[1]);
    const textMatches = html.match(EMAIL_REGEX) || [];
    const all = [...mailtoMatches, ...textMatches]
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e && !GENERIC_JUNK_EMAILS.has(e) && !e.endsWith('.png') && !e.endsWith('.jpg'));
    return [...new Set(all)];
}

async function findContactPageUrl(baseUrl, html) {
    if (!html) return null;
    const hrefMatches = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
    // Първо търсим директно "контакти"/"contact", после падаме към "за нас"/"about"
    const candidate = hrefMatches.find((h) => /kontakt|contact/i.test(h))
        || hrefMatches.find((h) => /za-nas|about/i.test(h));
    if (!candidate) return null;
    try {
        return new URL(candidate, baseUrl).toString();
    } catch {
        return null;
    }
}

// Прост concurrency limiter, за да не заливаме десетки различни външни сайтове наведнъж.
async function runWithConcurrency(items, limit, worker) {
    const queue = [...items];
    const runners = Array.from({ length: Math.max(1, limit) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            await worker(item);
        }
    });
    await Promise.all(runners);
}

if (findOfficialWebsite && scrapeEmails) {
    const dealersWithWebsite = dealerResults.filter((d) => d.officialWebsite);
    log.info(`ФАЗА 4: Извличане на имейли от ${dealersWithWebsite.length} официални уебсайта…`);

    await runWithConcurrency(dealersWithWebsite, 5, async (dealer) => {
        const homeHtml = await fetchHtml(dealer.officialWebsite);
        let emails = extractEmailsFromHtml(homeHtml);

        if (emails.length === 0) {
            const contactUrl = await findContactPageUrl(dealer.officialWebsite, homeHtml);
            if (contactUrl) {
                const contactHtml = await fetchHtml(contactUrl);
                emails = extractEmailsFromHtml(contactHtml);
            }
        }

        dealer.emails = emails;
    });

    const foundEmails = dealerResults.filter((d) => d.emails.length > 0).length;
    log.info(`Намерени имейли за ${foundEmails} дилъра.`);
}

/**
 * ---------------------------------------------------------------------------
 * Финално записване в Dataset.
 * ---------------------------------------------------------------------------
 */
await Actor.pushData(dealerResults);

log.info('Готово.');

await Actor.exit();
