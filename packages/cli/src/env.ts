/** Strict env boolean: exactly "1" or "true" enables — ONE rule for every CORK_* toggle
 *  (CORK_JSON, CORK_EXPLAIN_JSON, CORK_NO_UPDATE_NOTIFIER). Before this, CORK_EXPLAIN_JSON
 *  accepted any non-"0"/"false" value while its siblings did not — two dialects of truthiness
 *  for adjacent flags is exactly the drift a caller cannot see coming. */
export function envFlag(env: Record<string, string | undefined>, name: string): boolean {
  const v = env[name];
  return v === "1" || v === "true";
}
