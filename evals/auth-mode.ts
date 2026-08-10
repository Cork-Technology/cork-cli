/** How the eval runner authenticates — the decision that keeps two contracts honest at once.
 *
 *  CI documents "self-skips without ANTHROPIC_API_KEY" (forks/PRs without secrets stay green);
 *  local keyless-gateway runs (ANTHROPIC_BASE_URL) must NOT skip — a configured gateway that
 *  fails auth should fail LOUD, never no-op green. The 2026-08-10 regression: the runner
 *  proceeded on "ambient auth" with nothing configured and died 401 in CI, turning every main
 *  push red. The rule, exactly:
 *    keyed   — an explicit key/token is set: pass it (reproducible runs).
 *    ambient — no key, but ANTHROPIC_BASE_URL names a gateway: omit auth headers, let the
 *              gateway supply auth; a broken gateway fails on the first request.
 *    skip    — nothing is configured: print the skip line and exit 0 (the documented CI/fork
 *              contract; EVAL_GATE only gates runs that actually happen).
 */
export type EvalAuthMode = "keyed" | "ambient" | "skip";

export function evalAuthMode(env: Record<string, string | undefined>): EvalAuthMode {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return "keyed";
  if (env.ANTHROPIC_BASE_URL) return "ambient";
  return "skip";
}
