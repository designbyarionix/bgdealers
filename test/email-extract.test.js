const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const GENERIC_JUNK_EMAILS = new Set(['example@example.com', 'name@example.com', 'you@example.com']);

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
    const candidate = hrefMatches.find((h) => /kontakt|contact/i.test(h))
        || hrefMatches.find((h) => /za-nas|about/i.test(h));
    if (!candidate) return null;
    try {
        return new URL(candidate, baseUrl).toString();
    } catch {
        return null;
    }
}

const sampleHomeHtml = `
<html><body>
  <header><a href="/">Home</a><a href="/za-nas">За нас</a><a href="/kontakti">Контакти</a></header>
  <footer>Follow us on <img src="logo@2x.png"> facebook</footer>
</body></html>
`;

const sampleContactHtml = `
<html><body>
  <h1>Контакти</h1>
  <p>Пишете ни на <a href="mailto:office@primer-avtokashta.bg">office@primer-avtokashta.bg</a></p>
  <p>Или на sales@primer-avtokashta.bg / OFFICE@Primer-Avtokashta.bg (дублирано, различен регистър)</p>
</body></html>
`;

(async () => {
    const homeEmails = extractEmailsFromHtml(sampleHomeHtml);
    console.log('Home emails (очаквано: none):', homeEmails);

    const contactUrl = await findContactPageUrl('https://primer-avtokashta.bg', sampleHomeHtml);
    console.log('Contact URL found:', contactUrl);

    const contactEmails = extractEmailsFromHtml(sampleContactHtml);
    console.log('Contact emails:', contactEmails);

    let ok = true;
    if (homeEmails.length !== 0) { console.error('FAIL: home page trebva da e bez email (imalo lazhliv logo@2x.png match?)'); ok = false; }
    if (contactUrl !== 'https://primer-avtokashta.bg/kontakti') { console.error('FAIL: contact url'); ok = false; }
    if (contactEmails.length !== 2 || !contactEmails.includes('office@primer-avtokashta.bg') || !contactEmails.includes('sales@primer-avtokashta.bg')) {
        console.error('FAIL: contact emails', contactEmails);
        ok = false;
    }

    console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
    process.exit(ok ? 0 : 1);
})();
