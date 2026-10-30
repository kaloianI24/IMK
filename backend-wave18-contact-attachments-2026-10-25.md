# Wave 18c — Backend: contact attachment transport

## Summary
Implemented the multipart attachment transport for the new on-site email page.
Both contact handlers (Vercel `api/contact.ts` and Cloudflare `site/functions/api/contact.ts`)
now share one parser (`site/shared/server/multipart.ts`), accept up to 3 files / 4 MiB total,
sniff magic bytes, sanitise filenames, and attach the files to the Resend email with
`reply_to` set to the visitor's address. Legacy urlencoded/JSON posts keep working.

## Files changed
- NEW `site/shared/server/multipart.ts` — edge-safe shared parser + `sniffMime`, `ALLOWED_MIMES`, `toBase64`.
- `api/contact.ts` — MAX.body 8192 -> 4194304; bytes read; Content-Length lie check; multipart path; subject field; attachments; emailed bool; redacted log adds fileCount/fileBytes.
- `site/functions/api/contact.ts` — same, CF style.
- `site/src/types/contracts.ts` — bodyBytes 8192 -> 4194304.
- NEW `backend-wave18-contact-attachments-harness.mjs` — 13 checks, 0 failures.

## Decisions implemented (Architect D1-D9)
1. Parser: `parseMultipart(body: Uint8Array, contentType)` -> `{ok, fields, files}` | `{ok:false, code}`. Guards: missing boundary, header block > 8 KB, > 24 parts, empty file part, truncated/missing closing boundary, total > 4 MiB. Repeated field names: last wins.
2. File safety: allowlist png/jpeg/webp/gif + mp4/quicktime/webm; magic-byte sniff must agree with declared Content-Type; SVG refused; filenames sanitised (basename, control chars/quotes stripped, outside `[A-Za-z0-9._-]` -> `_`, <= 120, fallback `file`).
3. Resend: `attachments: [{filename, content: base64}]`, `reply_to = visitor email`, `subject = "IMK enquiry - " + (subject || "New message")` after CR/LF+control stripping, <= 150 chars; HTML-escaped name/company/project/subject; encoded-size guard 5.6 MB.
4. Response contract: 200 `{ok, emailed, ref}`; errors `{ok:false, code}` with the documented statuses. `emailed` reflects whether Resend accepted the send.
5. Logging: counts and bytes only (`fileCount`, `fileBytes`); no filename, body, subject or unredacted address.

## Gate results
| Gate | Result |
|---|---|
| `npm run typecheck:api` | exit 0 |
| `npm run check:routes` | 16 routes / 0 missing; api/ holds 7 .ts files |
| `npm run test:store` | 72/72 |
| `backend-wave18-contact-attachments-harness.mjs` | 13/13 (12 guards + 1 mutation probe) |

## Harness checks
A1 1 image accepted (200, emailed true, reply_to set)
A2 3 mixed accepted
A3 4 files -> too-many-files (413)
A4 >4 MiB -> payload-too-large (413)
A5 SVG -> unsupported-file (415)
A6 PNG magic declared text/plain -> unsupported-file (415)
A7 traversal filename sanitised -> `passwd.png`
A8 CR/LF in subject cannot inject a header (single line)
A9 missing boundary -> clean 4xx
A10 truncated body -> clean 4xx
A11 Content-Length lie -> clean 4xx
A12 legacy urlencoded post still passes (303)
M1 mutation probe: removing the 3-file guard reddens A3 (probe bites)

## Unverified
- No real Resend send performed (stubbed fetch in tests).
- No Vercel/Cloudflare deploy; rewrites unproven (unchanged from prior waves).
- Frontend page and `/book` redirect are separate waves (Frontend/DevOps).