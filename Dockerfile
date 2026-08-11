FROM apify/actor-node-playwright-chrome:20-1.59.1

# Тази база вече идва с инсталиран Chromium и всички системни зависимости,
# нужни на Playwright да го стартира headless (libnss3, libgbm и т.н.).
# apify/actor-node:20 (обикновената база) НЯМА тези неща и затова
# playwright.chromium.launch() гърмеше мигновено за всеки дилър.
#
# ВАЖНО: тагът на този image е закован към точна версия на Playwright
# (1.59.1), а не просто "20" (която сочи към каквато версия е най-нова
# към момента на build-а). package.json трябва да декларира СЪЩАТА точна
# версия ("playwright": "1.59.1"), иначе npm install ще дръпне различна
# версия на playwright пакета, чийто очакван път до Chromium binary-я
# (номериран по ревизия) няма да съвпада с вече инсталирания в image-а —
# точно грешката "Executable doesn't exist at /pw-browsers/...".
#
# Тази база работи с non-root потребител "myuser" (работна директория
# /home/myuser), затова копираните файлове трябва изрично да се дадат
# на него с --chown=myuser:myuser, иначе npm install няма права да пише
# package-lock.json в тази директория.

COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

COPY --chown=myuser:myuser . ./

CMD npm start --silent
