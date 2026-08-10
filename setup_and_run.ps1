# setup_and_run.ps1 - run from the bgdealers folder in PowerShell
Set-StrictMode -Version Latest
Write-Host "Installing npm packages..."
npm install
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed"; exit $LASTEXITCODE }

Write-Host "Installing Playwright browsers..."
npx playwright install
if ($LASTEXITCODE -ne 0) { Write-Error "playwright install failed"; exit $LASTEXITCODE }

Write-Host "Running local test (local_input.json) ..."
npm run start:local
