# site/qa/run-all-suites.ps1
# QA runner: executes every QA suite against the real handlers in isolated
# sandboxes and writes the transcripts next to the results.
#
#   pwsh -File site/qa/run-all-suites.ps1
#
# Every suite is sandboxed on its own port; port 4321 (the running dev
# server) is never used.

$ErrorActionPreference = 'Continue'
$SITE = $PSScriptRoot | Split-Path -Parent
$ART = Join-Path $SITE 'qa\artifacts'
# One transcript per day: a run must never overwrite the evidence of an
# earlier one.
$LOG = Join-Path $ART ("qa-full-run-" + (Get-Date -Format 'yyyy-MM-dd') + ".txt")

New-Item -ItemType Directory -Force -Path $ART | Out-Null

$out = New-Object System.Collections.Generic.List[string]
function Say([string]$s) {
  Write-Host $s
  $out.Add($s)
}

Say "IMK QA -- FULL RE-RUN, 2026-10-20"
Say ("started: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))
Say ("repo:    " + (Split-Path $SITE -Parent))
Say ("node:    " + (node --version))
Say ("git HEAD: " + (git -C (Split-Path $SITE -Parent) rev-parse --short HEAD))
Say ""

function RunSuite([string]$name, [string]$script, [string[]]$extra) {
  Say ("=" * 72)
  Say "SUITE: $name"
  Say ("node " + $script + " " + ($extra -join ' '))
  Say ("=" * 72)
  $tmp = [System.IO.Path]::GetTempFileName()
  Push-Location $SITE
  & node $script @extra *> $tmp
  $code = $LASTEXITCODE
  Pop-Location
  $text = Get-Content $tmp -Raw
  Remove-Item $tmp -Force
  # keep only the lines that carry evidence
  $text -split "`r?`n" | Where-Object { $_ -match '\[qa\]|PASS|FAIL' } | ForEach-Object { Say $_ }
  Say ("exit code: " + $code)
  Say ""
  return $code
}

function RunCommand([string]$name, [string]$cmd, [string[]]$extra) {
  Say ("=" * 72)
  Say "SUITE: $name"
  Say ($cmd + " " + ($extra -join ' '))
  Say ("=" * 72)
  $tmp = [System.IO.Path]::GetTempFileName()
  Push-Location $SITE
  & $cmd @extra *> $tmp
  $code = $LASTEXITCODE
  Pop-Location
  $text = Get-Content $tmp -Raw
  Remove-Item $tmp -Force
  $text -split "`r?`n" | Where-Object { $_ -match '\[qa\]|\[check-api-routes\]|PASS|FAIL' } | ForEach-Object { Say $_ }
  Say ("exit code: " + $code)
  Say ""
  return $code
}

# 1 -- the API suite (QA's original harness, re-run on current HEAD)
$apiJson = Join-Path $ART 'qa-testimonials-results.json'
$code1 = RunSuite 'qa-testimonials.mjs (API, real handlers)' 'qa\qa-testimonials.mjs' @('--keep', '--json', $apiJson)

# the build suite needs the sandbox the API suite just left behind
$sandbox = ($out | Where-Object { $_ -match '^\[qa\] sandbox: ' } | Select-Object -Last 1) -replace '^\[qa\] sandbox: ', ''
if (-not $sandbox) { $sandbox = '' }

# 2 -- the build suite (real astro build)
$code2 = RunSuite 'qa-testimonials-build.mjs (real astro build)' 'qa\qa-testimonials-build.mjs' @('--sandbox', $sandbox.Trim())

# 3 -- the Backend's hardening suite
$code3 = RunSuite 'qa-backend-hardening.mjs (Backend suite, re-run)' 'qa\qa-backend-hardening.mjs' @()

# 4 -- QA's new INDEPENDENT wave-2 suite
$waveJson = Join-Path $ART 'qa-wave2-independent-results.json'
$code4 = RunSuite 'qa-wave2-independent.mjs (QA independent wave-2)' 'qa\qa-wave2-independent.mjs' @('--json', $waveJson)

# 5 -- the mutation probe (proves the checks are not vacuous)
$code5 = RunSuite 'qa-mutation-probe.mjs (mutation probe)' 'qa\qa-mutation-probe.mjs' @()

# 6 -- the Backend's rate limiter suite (the counters behind a pluggable backend)
$code6 = RunSuite 'qa-rate-limit.mjs (Backend: the rate limiter backends)' 'qa\qa-rate-limit.mjs' @()

# 7 -- the Backend's Cloudflare parity suite (the CF tree, executed)
$code7 = RunSuite 'qa-cf-parity.mjs (Backend: the Cloudflare tree, executed)' 'qa\qa-cf-parity.mjs' @()

# 8 -- QA's own INDEPENDENT wave-3 suite (own harness, own signing, own sandbox)
$w3Json = Join-Path $ART 'qa-wave3-independent-results.json'
$code8 = RunSuite 'qa-wave3-independent.mjs (QA independent wave-3)' 'qa\qa-wave3-independent.mjs' @('--json', $w3Json)

# 9 -- the route manifest check (the machine check for F-1)
$code9 = RunCommand 'npm run check:routes (the route manifest check)' 'npm' @('run', 'check:routes')

# 10 -- QA's own INDEPENDENT wave-4 suite
$w4Json = Join-Path $ART 'qa-wave4-independent-results.json'
$code10 = RunSuite 'qa-wave4-independent.mjs (QA independent wave-4)' 'qa\qa-wave4-independent.mjs' @('--json', $w4Json)

# 11 -- QA's own INDEPENDENT wave-5 suite (F-2, F-3, F-4 + 3 mutation probes)
$w5Json = Join-Path $ART 'qa-wave5-independent-results.json'
$code11 = RunSuite 'qa-wave5-independent.mjs (QA independent wave-5)' 'qa\qa-wave5-independent.mjs' @('--json', $w5Json)

# 12 -- QA's own INDEPENDENT admin-inbox suite (the /admin owner gate, wave 6)
$admJson = Join-Path $ART 'qa-admin-independent-results.json'
$code12 = RunSuite 'qa-admin-independent.mjs (QA independent admin inbox)' 'qa\qa-admin-independent.mjs' @('--json', $admJson)

Say ("=" * 72)
Say "SUMMARY"
Say ("=" * 72)
Say ("qa-testimonials.mjs           exit " + $code1)
Say ("qa-testimonials-build.mjs     exit " + $code2)
Say ("qa-backend-hardening.mjs      exit " + $code3)
Say ("qa-wave2-independent.mjs      exit " + $code4)
Say ("qa-mutation-probe.mjs         exit " + $code5)
Say ("qa-rate-limit.mjs             exit " + $code6)
Say ("qa-cf-parity.mjs              exit " + $code7)
Say ("qa-wave3-independent.mjs      exit " + $code8)
Say ("check:routes (npm run)        exit " + $code9)
Say ("qa-wave4-independent.mjs      exit " + $code10)
Say ("qa-wave5-independent.mjs      exit " + $code11)
Say ("qa-admin-independent.mjs      exit " + $code12)
Say ("finished: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))

[System.IO.File]::WriteAllText($LOG, ($out -join "`r`n"))
Write-Host ""
Write-Host "transcript: $LOG"

if ($code1 -or $code2 -or $code3 -or $code4 -or $code5 -or $code6 -or $code7 -or $code8 -or $code9 -or $code10 -or $code11 -or $code12) { exit 1 }
exit 0
