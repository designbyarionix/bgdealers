FROM apify/actor-node-playwright-chrome:20-1.59.1

# Тази база вече идва с инсталиран Chromium и всички системни зависимости,
# нужни на Playwright да го стартира headless (libnss3, libgbm и т.н.).
# apify/actor-node:20 (обикновената база) НЯМА тези неща и затова
# playwright.chromium.launch() гърмеше мигновено за всеки дилър.
#
# ВАЖНО: дори версиите на Playwright пакета и на base image-а да съвпадат
# точно, Playwright >=1.58 в Docker среда има известен бъг/промяна в
# поведението: chromium.launch({headless:true}) очаква отделен, по-малък
# browser build ("chrome-headless-shell"), който на моменти липсва или е
# с различна ревизия от вече вградения в image-а глобален кеш
# (/pw-browsers) — виж microsoft/playwright issue #39122. Затова НЕ
# разчитаме на вградения кеш, а изрично сваляме браузъра по време на
# build, локално в проекта (PLAYWRIGHT_BROWSERS_PATH=0 -> сваля вътре в
# node_modules/playwright-core/.local-browsers, независимо от глобалния
# кеш и неговата версия/ревизия).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0
ENV PLAYWRIGHT_BROWSERS_PATH=0
#
# Тази база работи с non-root потребител "myuser" (работна директория
# /home/myuser), затова копираните файлове трябва изрично да се дадат
# на него с --chown=myuser:myuser, иначе npm install няма права да пише
# package-lock.json в тази директория.

COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=dev --omit=optional \
    && npx playwright install chromium \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

COPY --chown=myuser:myuser . ./

CMD npm start --silent
