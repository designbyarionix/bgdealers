# Mobile.bg Dealer Outreach Actor

Apify Actor that discovers Mobile.bg dealer profiles, contacts at most 50 new dealers per day, solves Mobile.bg image CAPTCHAs through 2Captcha, and permanently prevents duplicates by both dealer domain and phone number.

## Safety and duplicate rules

- `sendMessages` defaults to `false`. The first run is a dry run.
- Only a form response containing `Запитването е изпратено.` counts as sent.
- Successfully contacted domains are saved permanently in the named key-value store `mobile-bg-outreach-state`.
- Successfully contacted phone numbers are also saved. Another profile with the same phone is skipped permanently.
- Four dealers contacted manually before this Actor was created are included in the initial seed list.
- The four successful manual messages from 2026-08-13 are also seeded into that day's counter, leaving 46 available successful sends for the first live Actor run that day.
- A per-timezone daily counter prevents more than `dailySuccessfulLimit` successful messages, even if the Actor runs more than once in a day.
- Failed CAPTCHA attempts are logged but not marked as sent.

## Deploy to Apify

1. Create a new Actor in Apify Console and choose **Empty Actor**.
2. Upload this project or connect its Git repository.
3. Build the Actor.
4. Open **Input**, paste your current 2Captcha key into **2Captcha API key**, and save the task/input. The field is declared with `isSecret: true`, so Apify encrypts it.
5. Keep **Send messages** disabled for the first run. Check the Dataset for `dry_run_ready` records.
6. Enable **Send messages** only after the dry-run recipient list looks correct.
7. In **Schedules**, create one daily schedule. The Actor itself enforces the maximum of 50 successful submissions per day.

Do not put the 2Captcha key in source code, Git, Dockerfile, README, or ordinary non-secret environment variables.

## Run locally

Local execution is useful only for tests unless a compatible Chrome/Playwright installation is available.

```bash
npm install
npm test
npm start
```

For a local real run, create `storage/key_value_stores/default/INPUT.json` based on the input schema. Never commit that file if it contains an API key.

## Output

Each run writes one Dataset record per examined dealer with a status such as:

- `dry_run_ready`
- `sent`
- `skipped_duplicate_phone`
- `captcha_rejected`
- `failed`

The run summary is stored in the default key-value store as `OUTPUT`.

## Notes

The Actor uses Mobile.bg's current contact-form field names (`s0`, `s1`, `s2`, `s3`, `s4`, `accept2`). If Mobile.bg changes its HTML, update these selectors. Use the Actor in compliance with applicable anti-spam, privacy, platform, and commercial-communication rules.
