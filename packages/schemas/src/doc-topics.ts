// Doc topics — guidance that is ABOUT USING the tool surface rather than about one tool. One
// constant feeds three surfaces with zero drift by construction: (a) `cork_capabilities`
// topic:"signing" (and aliases), (b) the MCP server `instructions` string (the summary,
// verbatim), and (c) the HTTP `/docs/signing` page (the body, verbatim). The first topic exists
// because a REMOTE deployment's clients receive UNSIGNED artifacts and must learn in-band how to
// complete them: the server never signs and never holds keys [K1], and there is deliberately no
// broadcast/relay tool (a public relay would be farmed) — clients broadcast through their own
// RPC endpoint after validating the signed bytes with cork_decode kind:"tx".

export interface DocTopic {
  name: string;
  /** Alternate lookup keys (case-insensitive, like the name). */
  aliases: readonly string[];
  /** ≤5 sentences; doubles verbatim as the MCP server `instructions` core. */
  summary: string;
  /** The full markdown doc served by the topic lookup (and the HTTP /docs page). */
  body: string;
  /** Space-separated phrases users and agents actually say — the search index for this topic. */
  searchText: string;
}

export const SIGNING_TOPIC_REFERENCE = 'cork_capabilities topic:"signing"' as const;

export const DOC_TOPICS: Record<string, DocTopic> = {
  signing: {
    name: "signing",
    aliases: ["execute", "broadcast", "sign-and-broadcast"],
    summary:
      "Every cork_prepare_* result is UNSIGNED — this server never signs and never holds keys. Sign artifacts client-side with your own wallet: unsigned Ethereum transactions via eth_signTransaction, EIP-712 typed-data via eth_signTypedData_v4. Broadcast on-chain transactions yourself through your own RPC endpoint (chainlist.org lists free public ones per chain) — there is no server-side broadcast tool, by design. cork_submit only relays venue payloads you already signed. Call cork_capabilities topic:\"signing\" for the exact per-artifact completion path.",
    body: `# Signing and executing prepared artifacts

Every \`cork_prepare_*\` result is **UNSIGNED**. This server never signs, never holds keys, and
never broadcasts on-chain transactions [K1]. Each prepare result carries a \`data.execution\`
block naming its exact completion path; the two artifact families are:

## Family A — unsigned Ethereum transactions

Producers: \`cork_prepare_phoenix\` (Bundler3 bundles and the authority-onboard/revoke approve
txs), \`cork_prepare_market\` (both actions), \`cork_prepare_orders\` taker-fill and cancel.
The result carries \`{to, data|calldata|multicall, value, chainId}\`.

1. **Simulate first** — \`cork_track\` mode:"simulate" dry-runs the frozen bytes and answers
   \`wouldRevert\` (with the revert reason) BEFORE anyone signs. Simulate-first is the norm, not
   optional.
2. **Sign client-side** with any wallet that speaks \`eth_signTransaction\` — cast, viem, ethers,
   a Safe, Fireblocks. The server plays no part in this step.
3. **Validate the SIGNED bytes** with \`cork_decode kind:"tx"\` before anything leaves your
   machine: confirm the recovered signer is your account, \`to\` is the contract you expect (the
   decode names known Cork deployment addresses and warns plainly on unknown targets), the
   chainId matches, and the inner leg \`summary\` reads as the action you intended.
4. **Broadcast through your own RPC endpoint** — construct the raw JSON-RPC call yourself:

   \`\`\`
   POST https://<your-rpc-endpoint>
   {"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x<signed bytes>"]}
   \`\`\`

   The result is the transaction hash. Endpoint selection: chainlist.org lists free public
   endpoints per chainId; run an \`eth_chainId\` sanity check first (the same discipline this
   server's own resolver applies — wrong-chain endpoints are refused). Re-submitting identical
   signed bytes to a second endpoint is safe (same hash, same tx). Public endpoints are
   best-effort — prefer your own node for anything latency- or reliability-sensitive.
5. **Reconcile** with \`cork_track\` subject kind:"txHash" — \`receipt_not_found\` is a normal
   pending outcome, not a failure.

## Family B — EIP-712 typed-data

Producers: \`cork_prepare_orders\` maker-order (1inch LOP v4 domain) and rollover-intent
(CorkSettler domain). The result carries the full \`typedData\` (domain/types/primaryType/message).

- Sign with \`eth_signTypedData_v4\` over the returned domain and message, client-side.
- **Maker orders** then go through \`cork_prepare_orders\` finalize-maker-order (signature
  recovery + exact-bytes reconstruction check); its \`submitInput\` passes VERBATIM to
  \`cork_submit\` lop-order.
- **Rollover intents** go straight to \`cork_submit\` rollover-order.
- \`cork_submit\` relays only — it recomputes every commitment locally before relaying [K3] and
  never signs [K1].

## Security norms

- Read the bundle \`summary\` (prepare results and \`cork_decode\`) before signing — it is the
  plain-English statement of what the bytes do, leg by leg.
- Allowance prerequisites: a taker-fill needs the taker-asset allowance to the LOP;
  permit2-funded bundles need BOTH Permit2 layers in place (\`cork_query\`
  resource:"account-state" shows both).
- The server reads chains through its own server-side RPC configuration; there is no per-call
  RPC override on the tool surface, and broadcasting is always client-side.`,
    searchText:
      "sign signing execute broadcast send raw transaction eth_sendRawTransaction eth_signTransaction eth_signTypedData_v4 wallet client-side signature unsigned artifact next steps complete finish submit on-chain typed data how do i execute this prepared bundle",
  },
};

/** Resolve a doc topic by name or alias, case-insensitively. */
export function findDocTopic(key: string): DocTopic | undefined {
  const k = key.toLowerCase();
  return Object.values(DOC_TOPICS).find((t) => t.name === k || t.aliases.some((a) => a.toLowerCase() === k));
}

// ── data.execution block — the per-result pointer every prepare result carries ──────────────
// Typed once here (an output convention, like `summary`) so the three emitting handlers cannot
// drift: the block names the artifact family, the client-side signing method, and the ordered
// next steps with exact tool names.

export interface ExecutionBlock {
  kind: "eth-transaction" | "eip712-typed-data";
  sign: "eth_signTransaction" | "eth_signTypedData_v4";
  /** Ordered next steps naming exact tools. */
  then: string[];
  reference: typeof SIGNING_TOPIC_REFERENCE;
}

/** Family A: an unsigned Ethereum transaction (bundle, approve, deploy, fill, cancel). */
export function executionEthTransaction(): ExecutionBlock {
  return {
    kind: "eth-transaction",
    sign: "eth_signTransaction",
    then: [
      "cork_track simulate (wouldRevert before signing)",
      "sign client-side with your own wallet",
      "cork_decode kind:'tx' (validate the signed bytes: signer, to, chainId, legs)",
      "eth_sendRawTransaction via your own RPC endpoint (chainlist.org lists public ones)",
      "cork_track txHash (reconcile; receipt_not_found = still pending)",
    ],
    reference: SIGNING_TOPIC_REFERENCE,
  };
}

/** Family B: EIP-712 typed-data. `then` differs per artifact (maker-order vs rollover-intent). */
export function executionTypedData(then: string[]): ExecutionBlock {
  return { kind: "eip712-typed-data", sign: "eth_signTypedData_v4", then, reference: SIGNING_TOPIC_REFERENCE };
}

/** Family B, maker-order path. */
export function executionMakerOrder(): ExecutionBlock {
  return executionTypedData([
    "sign the typed-data client-side (eth_signTypedData_v4, LOP v4 domain)",
    "cork_prepare_orders finalize-maker-order (recovers + verifies the signature)",
    "cork_submit lop-order (pass submitInput verbatim)",
  ]);
}

/** Family B, rollover-intent path. */
export function executionRolloverIntent(): ExecutionBlock {
  return executionTypedData([
    "sign the typed-data client-side (eth_signTypedData_v4, CorkSettler domain)",
    "cork_submit rollover-order (relays the caller-signed order; never signs)",
  ]);
}
