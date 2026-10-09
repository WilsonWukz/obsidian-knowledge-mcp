/** MCP client-compatible Markdown path schema and server-enforced validation.
 *
 * Some clients reject valid paths when Zod's regex() is published as a JSON
 * Schema 'pattern'. Avoid regex in the external tool descriptor and enforce
 * the same (stronger) Markdown-only path restriction inside the Worker.
 * No file is read prior to this check.
 */
import { z } from "zod";

/** Transport contract only. Intentionally emits no JSON Schema pattern. */
export const NotePathInput = z.string().min(1).max(1024);

/** Exact, vault-relative Markdown path; permits UTF-8 filenames and nested paths. */
export function isSafeMarkdownPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 4 || value.length > 1024 ||
      !/\.md$/i.test(value) || value.startsWith("/") || value.includes("\\") ||
      value.includes("//") || value.includes("..") ||
      /[\x00-\x1f\x7f]/.test(value) || /%(?:2e|2f|5c)/i.test(value)) {
    return false;
  }
  return value.split("/").every(part => !!part && !part.startsWith("."));
}
