import playwright from 'playwright';
(async () => {
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://triumphcars.mobile.bg/contacts', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const formExists = !!(await page.$('form'));
  console.log('formExists=', formExists);
  const form = await page.$('form');
  const outer = await form.evaluate((f) => f.outerHTML);
  console.log('FORM_OUTER_HTML_START');
  console.log(outer);
  console.log('FORM_OUTER_HTML_END');
  const fields = await form.$$eval('input, textarea, select', (els) => els.map((el) => ({
    tag: el.tagName,
    type: el.type || null,
    name: el.name || null,
    id: el.id || null,
    placeholder: el.placeholder || null,
    label: (() => {
      const id = el.id;
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) return label.innerText;
      }
      let parent = el.parentElement;
      for (let i = 0; i < 3 && parent; i += 1) {
        if (parent.tagName.toLowerCase() === 'label') return parent.innerText;
        parent = parent.parentElement;
      }
      return null;
    })(),
    outerHTML: el.outerHTML.slice(0, 300),
  })));
  console.log(JSON.stringify(fields, null, 2));
  const buttons = await form.$$eval('button, input[type=submit]', (els) => els.map((el) => ({ tag: el.tagName, type: el.type || null, value: el.value || null, innerText: el.innerText || null, outerHTML: el.outerHTML.slice(0,200) })));
  console.log(JSON.stringify(buttons, null, 2));
  await browser.close();
})();
