/**
 * Strict UUID v4 validation.
 *
 * Job IDs are minted server-side by `uuid` v4 (see routes/upload.ts) and are
 * the only legitimate value for the `:jobId` path param on /status and
 * /download routes. Validating before any filesystem helper runs is
 * defence-in-depth: it stops malformed segments (path traversal, oversized
 * strings, control chars) from ever reaching `findUploadFor`, `outputDirFor`
 * or `mp3PathFor`.
 *
 * Pattern matches uuid v4 specifically (version digit `4`, variant digit
 * `8|9|a|b`). Case-insensitive — `uuid` emits lowercase but we accept both.
 */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidJobId(s: string): boolean {
  return typeof s === 'string' && UUID_V4_RE.test(s);
}
