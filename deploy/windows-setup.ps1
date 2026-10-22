# One-command Ledgerline setup for Windows.
# Run from PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\deploy\windows-setup.ps1
# Add -NoDeploy to prepare only; the Node helper also accepts --skip-install,
# --skip-seed, --skip-smtp, --skip-build.
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $RemainingArgs
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org/ and reopen PowerShell."
  exit 1
}

Write-Host "Ledgerline deployment setup" -ForegroundColor Cyan
Write-Host "Repository: $repoRoot"
Write-Host "Secrets are read locally and written only to .env.deploy.local (git-ignored)."
Write-Host ""

$mappedArgs = @()
foreach ($argument in $RemainingArgs) {
  switch ($argument) {
    "-NoDeploy" { $mappedArgs += "--no-deploy" }
    "-SkipInstall" { $mappedArgs += "--skip-install" }
    "-SkipSeed" { $mappedArgs += "--skip-seed" }
    "-SkipSmtp" { $mappedArgs += "--skip-smtp" }
    "-SkipBuild" { $mappedArgs += "--skip-build" }
    default { $mappedArgs += $argument }
  }
}

node .\scripts\windows-setup.mjs @mappedArgs
exit $LASTEXITCODE
