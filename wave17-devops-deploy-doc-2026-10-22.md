# Wave 17 DevOps — DEPLOY.md Correction Report

**Date:** 2026-10-22  
**Status:** DONE

## Summary

Fixed three incorrect wave attributions in `DEPLOY.md` that cited wave 11 for the `api/lib/jsonl.ts` deletion when it was actually wave 12, item B-3.

## Changes Made

| Location | Before | After |
|---|---|---|
| Line 98 | `api/lib/jsonl.ts` was deleted (zero product importers, wave 11) | `api/lib/jsonl.ts` was deleted (zero product importers, wave 12) |
| Line 301 | `api/lib/jsonl.ts` was deleted (wave 11, zero product importers) | `api/lib/jsonl.ts` was deleted (wave 12, zero product importers) |
| Line 326 | `api/lib/jsonl.ts` was deleted (wave 11, zero product importers) | `api/lib/jsonl.ts` was deleted (wave 12, zero product importers) |

## Gate Results (All Passed)

| Gate | Result |
|---|---|
| `npm run check:routes` | **16 routes / 0 missing**, 11 rewrites agree, every table route served by its entry point's HANDLERS map |
| `npm run typecheck:api` | **exit 0** |
| DEPLOY.md UTF-8 | **0 replacement chars (0xFFFD)**, **37 em-dashes** (unchanged), **no BOM** |

## Verification

- All three occurrences of the incorrect wave attribution have been corrected to wave 12
- No other content was modified in DEPLOY.md
- File size: 28,921 bytes (unchanged encoding properties)

## Unverified

- No git commit, no deploy, no Vercel/Cloudflare runtime booted, no real Turso contacted
- Platform's query-merge order unobserved — no preview deploy + `curl` to settle MAJOR-1's core question
- Dev server on 4321 still runs pre-wave-15 bundle