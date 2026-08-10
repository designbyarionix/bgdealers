#!/usr/bin/env bash
set -euo pipefail

echo "Installing npm packages..."
npm install

echo "Installing Playwright browsers..."
npx playwright install

echo "Running local test (local_input.json)..."
npm run start:local
