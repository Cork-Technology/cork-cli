/** How the eval runner authenticates — the decision that keeps two contracts honest at once.
 *
 *  CI documents "self-skips without credentials" (forks/PRs without secrets stay green);
 *  local keyless-gateway runs (ANTHROPIC_BASE_URL) must NOT skip — a configured gateway that
 *  fails auth should fail LOUD, never no-op green. The 2026-08-10 regression: the runner
 *  proceeded on "ambient auth" with nothing configured and died 401 in CI, turning every main
 *  push red. The rule, exactly:
 *    aws     — Claude Platform on AWS is configured (ANTHROPIC_AWS_WORKSPACE_ID, or an
 *              ANTHROPIC_AWS_API_KEY): construct the AnthropicAws client, which signs SigV4
 *              via the AWS credential chain (in CI: GitHub OIDC → assumed role — no stored
 *              secret, nothing to expire) or sends the AWS-issued key as a bearer token.
 *              AWS config is two coordinated variables set on purpose, so it outranks a
 *              possibly-stale leftover ANTHROPIC_API_KEY; a half-configured AWS setup
 *              (missing region, no resolvable credentials) fails LOUD in the client, never
 *              skips.
 *    keyed   — an explicit first-party key/token is set: pass it (reproducible runs).
 *    ambient — no key, but ANTHROPIC_BASE_URL names a gateway: omit auth headers, let the
 *              gateway supply auth; a broken gateway fails on the first request.
 *    skip    — nothing is configured: print the skip line and exit 0 (the documented CI/fork
 *              contract; EVAL_GATE only gates runs that actually happen).
 */
export type EvalAuthMode = "aws" | "keyed" | "ambient" | "skip";

export function evalAuthMode(env: Record<string, string | undefined>): EvalAuthMode {
  if (env.ANTHROPIC_AWS_WORKSPACE_ID || env.ANTHROPIC_AWS_API_KEY) return "aws";
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return "keyed";
  if (env.ANTHROPIC_BASE_URL) return "ambient";
  return "skip";
}
