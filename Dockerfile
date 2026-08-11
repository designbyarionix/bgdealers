FROM apify/actor-node-playwright-chrome:20

# Тази база вече идва с инсталиран Chromium и всички системни зависимости,
# нужни на Playwright да го стартира headless (libnss3, libgbm и т.н.).
# apify/actor-node:20 (обикновената база) НЯМА тези неща и затова
# playwright.chromium.launch() гърмеше мигновено за всеки дилър.

COPY package*.json ./
RUN npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

COPY . ./

CMD npm start --silent
