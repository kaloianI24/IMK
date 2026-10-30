// site/shared/server/multipart.ts
//
// ONE multipart/form-data parser shared by both contact handlers
// (api/contact.ts and site/functions/api/contact.ts). Edge-safe: no node:
// imports, so the Cloudflare Pages tree can bundle it unchanged.
//
// Exports:
//   parseMultipart(body, contentType) -> { ok:true, fields, files } | { ok:false, code }
//   sniffMime(buf) -> canonical mime | null
//   ALLOWED_MIMES
//
// Guards (each returns a clean {ok:false, code}, never throws):
//   - missing boundary                  -> 'validation'
//   - header block > 8 KB (per part)    -> 'payload-too-large'
//   - more than 24 parts               -> 'validation'
//   - filename > 120 chars             -> sanitised (truncated), not rejected
//   - total body > 4 MiB                -> 'payload-too-large' (checked by caller via MAX; parser also checks)
//   - truncated / missing closing b.   -> 'payload-too-large'
//   - Content-Length lie                -> handled by the caller (needs the header)
//   - repeated field name              -> last value wins
//   - empty file part                  -> 'validation'
//
// The parser never trusts the declared Content-Type of a part for safety;
// callers sniff magic bytes (sniffMime) and require agreement.

export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_PARTS = 24;
export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_FILENAME = 120;

export const ALLOWED_MIMES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

export interface ParsedFile {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface ParseOk {
  ok: true;
  fields: Record<string, string>;
  files: ParsedFile[];
}

export interface ParseFail {
  ok: false;
  code: string;
}

export type ParseResult = ParseOk | ParseFail;

function getBoundary(contentType: string): string | null {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!m) return null;
  const b = m[1] || m[2];
  if (!b || b.trim() === '') return null;
  return b.trim();
}

function findBytes(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  if (needle.length === 0) return -1;
  const limit = haystack.length - needle.length;
  for (let i = start; i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function sanitizeFilename(raw: string): string {
  let base = raw.replace(/\\/g, '/').split('/').pop() || '';
  base = base.replace(/[\x00-\x1f\x7f"']/g, '');
  base = base.replace(/[^A-Za-z0-9._-]/g, '_');
  if (base.length > MAX_FILENAME) base = base.slice(0, MAX_FILENAME);
  if (base === '' || base === '.' || base === '..') base = 'file';
  return base;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

export function sniffMime(buf: Uint8Array): string | null {
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif';
  }
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'image/webp';
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return 'video/webm';
  }
  if (buf.length >= 12 &&
      buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  return null;
}

export function parseMultipart(body: Uint8Array, contentType: string): ParseResult {
  if (body.length > MAX_TOTAL_BYTES) return { ok: false, code: 'payload-too-large' };

  const boundary = getBoundary(contentType);
  if (!boundary) return { ok: false, code: 'validation' };

  const enc = new TextEncoder();
  const boundaryBytes = enc.encode('--' + boundary);
  const closeMarker = enc.encode('--' + boundary + '--');
  const crlf = new Uint8Array([13, 10]);
  const headerSep = new Uint8Array([13, 10, 13, 10]);

  // Find first boundary.
  let cursor = findBytes(body, boundaryBytes, 0);
  if (cursor === -1) return { ok: false, code: 'validation' };

  const fields: Record<string, string> = {};
  const files: ParsedFile[] = [];
  const parts: Array<{ kind: 'field' | 'file'; name: string; value?: string; filename?: string; contentType?: string; data?: Uint8Array }> = [];

  // Loop over parts.
  // Guard against infinite loops with a max iteration count.
  let iterations = 0;
  while (iterations < MAX_PARTS + 5) {
    iterations++;

    // cursor points at a boundary.
    const after = cursor + boundaryBytes.length;

    // Closing boundary?
    if (body.length >= after + 2 && body[after] === 0x2d && body[after + 1] === 0x2d) {
      // done
      break;
    }

    // Expect CRLF after boundary.
    if (body.length < after + 2 || body[after] !== 13 || body[after + 1] !== 10) {
      return { ok: false, code: 'validation' };
    }
    const partStart = after + 2;

    // Find next boundary.
    const nextB = findBytes(body, boundaryBytes, partStart);
    if (nextB === -1) {
      // truncated: no closing boundary
      return { ok: false, code: 'payload-too-large' };
    }

    // part body ends before the CRLF that precedes the next boundary
    let partEnd = nextB;
    if (partEnd >= 2 && body[partEnd - 2] === 13 && body[partEnd - 1] === 10) {
      partEnd -= 2;
    }
    if (partEnd < partStart) {
      return { ok: false, code: 'validation' };
    }

    const partBytes = body.slice(partStart, partEnd);

    // Split headers / body.
    const sepIdx = findBytes(partBytes, headerSep, 0);
    if (sepIdx === -1) return { ok: false, code: 'validation' };

    const headerBytes = partBytes.slice(0, sepIdx);
    const fileBytes = partBytes.slice(sepIdx + 4);

    if (headerBytes.length > MAX_HEADER_BYTES) {
      return { ok: false, code: 'payload-too-large' };
    }

    const headersText = new TextDecoder('latin1').decode(headerBytes);
    const headers: Record<string, string> = {};
    for (const line of headersText.split(/\r\n/)) {
      if (line === '') continue;
      const idx = line.indexOf(':');
      if (idx > 0) {
        const name = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        headers[name] = value;
      }
    }

    const cd = headers['content-disposition'] || '';
    const nameMatch = cd.match(/name="([^"]*)"/) || cd.match(/name=([^\s;]+)/);
    const filenameMatch = cd.match(/filename="([^"]*)"/) || cd.match(/filename=([^\s;]+)/);
    const fieldName = nameMatch ? nameMatch[1] : '';
    const rawFilename = filenameMatch ? filenameMatch[1] : null;
    const partContentType = (headers['content-type'] || 'text/plain').split(';')[0].trim().toLowerCase();

    if (rawFilename !== null) {
      // file part
      if (fileBytes.length === 0) return { ok: false, code: 'validation' };
      const sanitized = sanitizeFilename(rawFilename);
      parts.push({ kind: 'file', name: fieldName, filename: sanitized, contentType: partContentType, data: fileBytes });
    } else {
      const value = new TextDecoder('utf-8', { fatal: false }).decode(fileBytes);
      parts.push({ kind: 'field', name: fieldName, value });
    }

    if (parts.length > MAX_PARTS) return { ok: false, code: 'validation' };

    cursor = nextB;
  }

  // Build fields (last wins) and files.
  for (const p of parts) {
    if (p.kind === 'field') {
      fields[p.name] = p.value ?? '';
    } else {
      files.push({ filename: p.filename || 'file', contentType: p.contentType || 'application/octet-stream', data: p.data || new Uint8Array(0) });
    }
  }

  return { ok: true, fields, files };
}