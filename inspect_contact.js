import playwright from "playwright";
(async () => {
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://triumphcars.mobile.bg/contacts', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const forms = await page.$$eval('form', forms => forms.map(f => ({ action: f.action, method: f.method, innerHTML: f.innerHTML.slice(0, 1000) })));
  console.log(JSON.stringify(forms, null, 2));
  await browser.close();
})();
