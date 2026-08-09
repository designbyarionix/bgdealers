# mobile-bg-dealers-scraper

Apify Actor, който скрейпва **реално** дилъри и телефонни номера от
[mobile.bg/dealers](https://www.mobile.bg/dealers).

## Как работи (точно потокът, който описа)

1. **Фаза 1 — списък с дилъри.** Отваря `https://www.mobile.bg/dealers` и следва
   пагинацията (линка "Напред" / `/dealers/p-N`) докато свърши. От всяка
   страница събира линковете към под-домейните на всеки дилър (напр.
   `https://atlanticdrive.mobile.bg`), защото това е адресът, на който се
   озоваваш, когато **натиснеш върху дилъра**.
2. **Фаза 2 — контакти.** За всеки дилър отваря `{дилър}/contacts` — това е
   точно страницата, на която сайтът на mobile.bg завежда бутона
   **"Контакти"**. Оттам изважда:
   - име на дилъра
   - телефонен(и) номер(а)
   - адрес и кореспондентски адрес
   - от коя година е в mobile.bg
3. **Фаза 3 (опционална, `findOfficialWebsite`) — официален уебсайт чрез
   Google.** За всеки дилър се пуска готовият, официален Apify актор
   [`apify/google-search-scraper`](https://apify.com/apify/google-search-scraper)
   (не се прави Google scraping от нулата) със заявка от типа
   `"Име на дилъра" автокъща`. От органичните резултати се взима първият, чийто
   домейн не е mobile.bg, Facebook, Instagram, OLX, Bazar.bg и т.н. — това се
   записва като `officialWebsite`. Всички заявки за всички дилъри се пращат в
   **едно** извикване на актора (batch), за да е ефективно.
4. **Фаза 4 (опционална, `scrapeEmails`) — имейли от намерения сайт.** Ако е
   намерен официален уебсайт, actor-ът влиза в него, търси mailto: линкове и
   имейл адреси в текста, а ако не намери нищо на началната страница — опитва
   да засече линк към "Контакти"/"За нас" и проверява и там.
5. Резултатите се пишат в Apify Dataset (един запис на дилър), достъпни в
   табличен вид, JSON, CSV, Excel и т.н.

Реализирано е с `CheerioCrawler` (без headless браузър), защото сайтът е
сървърно рендериран — HTML-ът, който вижда crawler-ът, е същият, който виждаш
в браузъра, преди JS да е изпълнен.

## Вход (Input)

| Поле | По подразбиране | Описание |
|---|---|---|
| `startUrl` | `https://www.mobile.bg/dealers` | Начална страница със списъка |
| `maxListingPages` | `0` (без лимит) | Колко страници от списъка да обходи |
| `maxDealers` | `0` (без лимит) | Колко дилъра да скрейпне (за тестове) |
| `maxConcurrency` | `10` | Паралелни заявки към страниците "Контакти" |
| `findOfficialWebsite` | `false` | Търси официалния уебсайт на всеки дилър през `apify/google-search-scraper` |
| `scrapeEmails` | `false` | Работи само ако `findOfficialWebsite` е включено — вади имейли от намерения сайт |
| `googleSearchCountryCode` | `bg` | Държава за Google търсенето |
| `googleSearchLanguageCode` | `bg` | Език за Google търсенето |

Пример за тестов input (само 5 дилъра + търсене на сайт + имейли):

```json
{
  "maxDealers": 5,
  "findOfficialWebsite": true,
  "scrapeEmails": true
}
```

## Изход (пример за един запис в Dataset)

```json
{
  "dealerName": "ATLANTIC DRIVE - Внос на леки автомобили, джипове и лек транспорт.",
  "dealerUrl": "https://atlanticdrive.mobile.bg",
  "contactsUrl": "https://atlanticdrive.mobile.bg/contacts",
  "phones": ["0878119140"],
  "address": "гр. София, Столична община",
  "correspondenceAddress": "Столична община, ул. Съборна поляна №38",
  "memberSince": "2025",
  "officialWebsite": "https://atlantic-drive.example",
  "emails": ["office@atlantic-drive.example"],
  "scrapedAt": "2026-08-10T12:00:00.000Z"
}
```

## ⚠️ Важно за `findOfficialWebsite`

- Изисква Apify акаунт с наличен баланс/платен план, защото извиква друг
  платен актор (`apify/google-search-scraper`) от твоя акаунт — струва
  проксита/SERP заявки, отделно от този actor.
- Ако извикването се провали (напр. няма достатъчно credits или token), actor-ът
  не спира целия run — просто продължава без `officialWebsite`/`emails` и пише
  предупреждение в лога.
- Домейните в "черния списък" (mobile.bg, Facebook, Instagram, OLX, Bazar.bg,
  Auto.bg, Cars.bg и др.) са в `src/main.js` → константата `BLACKLISTED_DOMAINS`
  — добави/махни домейни оттам при нужда.

## Локално стартиране

```bash
npm install
npm start
```

(По подразбиране Apify SDK пише резултатите в `./storage/datasets/default`.)

## Deploy в Apify

```bash
npm install -g apify-cli
apify login
apify push
```

или качи папката директно през Apify Console → Actors → Create new → Import
from Git/ZIP.

## Бележки / поддръжка

- mobile.bg може да променя HTML структурата си с времето — ако в даден
  момент телефон не се извлича, най-вероятно маркерите на страницата
  "Контакти" ("Адрес:", "Кореспондентски адрес:", "в mobile.bg от ... г.") са
  се променили и трябва да се обнови regex-а в `src/main.js`.
- Actor-ът пази телефона си като масив (`phones`), защото част от дилърите
  имат по няколко номера.
- Скрейпването е с респект към сайта — листващата фаза е нарочно
  ограничена до 3 паралелни заявки; фазата за контакти е конфигурируема
  чрез `maxConcurrency`.
