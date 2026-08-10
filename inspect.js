import playwright from "playwright";
import fs from "fs";
(async () => {
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://triumphcars.mobile.bg/contacts', { waitUntil: 'networkidle', timeout: 60000 });
  const html = await page.content();
  console.log('HTML_LENGTH=' + html.length);
  console.log(html.slice(0, 2000));
  const forms = await page.$$eval('form', forms => forms.map(f => ({ action: f.action, method: f.method, innerHTML: f.innerHTML.slice(0, 1000) })));
  console.log(JSON.stringify(forms, null, 2));
  await browser.close();
})();
