// site/shared/portal-store/record-id.ts
//
// THE IDENTITY OF A STORED RECORD (wave 12, B-1).
//
// WHY A RECORD NEEDS AN IDENTITY
//   The moderation log is a REVISION LOG: a client who changes their mind
//   appends a new record with the same `ref`, and the newest record wins.
//   Until wave 12 the only thing that named a revision was its NUMBER
//   (`revision`), and a number is not an identity:
//
//     two concurrent submits read the same current record
//       -> both compute revision = current + 1
//       -> two records share (ref, revision)
//       -> the signed approve link, which carried only (ref, revision),
//          matched BOTH of them and the store flipped the NEWEST one
//          -> the owner approved a quote they had never been shown.
//
//   The revision scope of wave 10 (F-2) closed "a decision landed on a
//   different NUMBER"; it could not close "a decision landed on a different
//   RECORD with the same number" (audit MAJOR-1).
//
// WHAT THE IDENTITY IS
//   An opaque string that names exactly one stored record. It is assigned by
//   the STORE when the record is appended — a caller cannot choose it, and
//   two records cannot share it.
//
//   It is NOT a secret: it travels inside a signed link, and its only job is
//   to say WHICH record the owner was shown.
//
// EDGE-SAFE BY DESIGN
//   No `node:` imports. The identity comes from the WebCrypto global, which
//   both runtimes provide (Node 20+ and Workers), so the file adapter and
//   the libSQL adapter cannot drift.

/** The prefix every record identity carries — it makes an id recognisable. */
const RECORD_ID_PREFIX = 'rec_';

/**
 * A fresh record identity.
 *
 * WebCrypto's randomUUID() is the source. The fallback is only there for a
 * runtime without it: the identity is not a credential (it is signed into the
 * link), so uniqueness — not unpredictability — is what matters, and the
 * fallback mixes the clock, a counter and Math.random.
 */
let fallbackCounter = 0;

export function newRecordId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return RECORD_ID_PREFIX + webCrypto.randomUUID().replace(/-/g, '');
  }
  fallbackCounter = (fallbackCounter + 1) % Number.MAX_SAFE_INTEGER;
  return (
    RECORD_ID_PREFIX +
    Date.now().toString(36) +
    '_' +
    fallbackCounter.toString(36) +
    '_' +
    Math.floor(Math.random() * 1e9).toString(36)
  );
}

/**
 * The identity a record carries, as a string.
 *
 * A record without an identity (one written before wave 12) reads as the
 * empty string — which is NOT an identity, so a link that names one can
 * never match it.
 */
export function recordIdentity(record: { recordId?: unknown } | null | undefined): string {
  if (!record) return '';
  const value = record.recordId;
  return typeof value === 'string' ? value : '';
}
