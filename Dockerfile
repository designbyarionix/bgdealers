FROM apify/actor-node-playwright-chrome:24

COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true)

COPY . ./

CMD npm start --silent
