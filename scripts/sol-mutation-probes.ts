// Solidity mutation probes for the ForSelf caller-whitelist gate — same contract as
// scripts/mutation-probes.ts, ported to the example contracts: each catalog entry applies one
// semantic mutant to a .sol source, runs the focused forge suite (in the pinned Foundry
// container), and expects it to FAIL. The run exits non-zero when a mutant SURVIVES, a `find`
// pattern no longer matches (rot — re-aim, don't lose coverage), a wiring count drifts, or the
// clean baseline is already red.
//
//   bun scripts/sol-mutation-probes.ts                 # offline mutants only
//   SOL_MUTATION_FORK_RPC=<arbitrum rpc> bun scripts/sol-mutation-probes.ts   # + fork mutants
//
// Offline mutants are killed by the mock-based suites (JitOrdering, ConstructorPairing) at zero
// RPC cost. Fork mutants need the live-stack suites (WhitelistGate, CombinedDeploy) and
// loud-skip without an RPC — mirroring how the repo's live vitest suites self-skip.
//
// Selection philosophy: mutants target where a silent defect becomes a BYPASSED ACCESS CHECK —
// the whitelist comparator, the checked identity, the constructor pairing proof, the modifier
// wiring, and the post-fill placement — not statement coverage.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface SolMutant {
  id: string;
  file: string;
  find: string;
  replace: string;
  /** forge --match-contract filter expected to catch the mutant. */
  matchContract: string;
  /** true = needs the fork suites (live stack); false = mock suites, offline. */
  fork: boolean;
}

const ROOT = resolve(import.meta.dir, "..", "example", "contracts");
const F = {
  common: "src/base/ForSelfCommon.sol",
  pool: "src/base/CorkPoolForSelfBase.sol",
  fill: "src/base/CorkLopFillForSelfBase.sol",
};

const CATALOG: SolMutant[] = [
  // ── the one comparator/emitter: bypass, inversion, wrong identity ────────────────────────
  {
    id: "wl-check-dropped",
    file: F.common,
    find: "require(WHITELIST.isWhitelisted(poolId, msg.sender), CallerNotWhitelisted(poolId, msg.sender));",
    replace: "// mutant: gate removed",
    matchContract: "JitOrderingTest",
    fork: false,
  },
  {
    id: "wl-check-inverted",
    file: F.common,
    find: "require(WHITELIST.isWhitelisted(poolId, msg.sender), CallerNotWhitelisted(poolId, msg.sender));",
    replace: "require(!WHITELIST.isWhitelisted(poolId, msg.sender), CallerNotWhitelisted(poolId, msg.sender));",
    matchContract: "JitOrderingTest",
    fork: false,
  },
  {
    id: "wl-check-wrong-identity",
    file: F.common,
    find: "require(WHITELIST.isWhitelisted(poolId, msg.sender), CallerNotWhitelisted(poolId, msg.sender));",
    replace: "require(WHITELIST.isWhitelisted(poolId, address(this)), CallerNotWhitelisted(poolId, msg.sender));",
    matchContract: "JitOrderingTest",
    fork: false,
  },
  // ── the constructor pairing proof ──────────────────────────────────────────────────────
  {
    id: "wl-pairing-dropped",
    file: F.common,
    find: "require(served == cork, WhitelistManagerMismatch(served, cork));",
    replace: "// mutant: pairing unproven",
    matchContract: "ConstructorPairingTest",
    fork: false,
  },
  {
    id: "wl-pairing-flipped",
    file: F.common,
    find: "require(served == cork, WhitelistManagerMismatch(served, cork));",
    replace: "require(served != cork, WhitelistManagerMismatch(served, cork));",
    matchContract: "ConstructorPairingTest",
    fork: false,
  },
  // ── modifier wiring: the gate must actually run before the pool actions ────────────────
  {
    id: "wl-modifier-hollowed",
    file: F.common,
    find: "modifier onlyWhitelistedCaller(MarketId poolId) {\n        _requireCallerWhitelisted(poolId);\n        _;\n    }",
    replace: "modifier onlyWhitelistedCaller(MarketId poolId) {\n        _;\n    }",
    matchContract: "WhitelistGateTest",
    fork: true,
  },
  // ── the fill path's post-fill call ──────────────────────────────────────────────────────
  {
    id: "wl-fill-check-dropped",
    file: F.fill,
    find: "_requireCallerWhitelisted(params.poolId);",
    replace: "// mutant: fill gate removed",
    matchContract: "JitOrderingTest",
    fork: false,
  },
];

/** Wiring counts that must hold — a moved/removed modifier is rot, not a passing run. */
const WIRING: Array<{ file: string; pattern: string; expected: number; why: string }> = [
  {
    file: F.pool,
    pattern: "onlyWhitelistedCaller(params.poolId)",
    expected: 13,
    why: "every pool entrypoint carries the caller-whitelist modifier",
  },
  {
    file: F.fill,
    pattern: "_requireCallerWhitelisted(params.poolId);",
    expected: 1,
    why: "the fill path calls the gate exactly once, post-fill",
  },
  {
    file: F.common,
    pattern: "WHITELIST.isWhitelisted(",
    expected: 1,
    why: "ONE comparator/emitter — duplicated checks defeat first-occurrence probes",
  },
];

const FORK_RPC = process.env.SOL_MUTATION_FORK_RPC ?? "";

function forge(matchContract: string): boolean {
  const args = [
    "run", "--rm",
    "-v", `${ROOT}:/app:z`,
    "-w", "/app",
    "--entrypoint", "sh",
    "ghcr.io/foundry-rs/foundry",
    "-c",
    `forge test --match-contract '${matchContract}'${FORK_RPC ? ` --fork-url '${FORK_RPC}'` : ""} >/dev/null 2>&1`,
  ];
  try {
    execFileSync("podman", args, { stdio: "ignore", timeout: 600_000 });
    return true; // suite green
  } catch {
    return false; // suite red
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

let failures = 0;
const say = (line: string) => console.log(line);

// 0. Wiring counts (rot guard) — before anything expensive.
for (const w of WIRING) {
  const src = readFileSync(resolve(ROOT, w.file), "utf8");
  const n = count(src, w.pattern);
  if (n !== w.expected) {
    say(`ROT      ${w.file}: expected ${w.expected}x "${w.pattern}" (${w.why}), found ${n}`);
    failures++;
  } else {
    say(`wired    ${w.file}: ${n}x "${w.pattern}"`);
  }
}
if (failures > 0) {
  say(`\n${failures} wiring check(s) failed — fix before running mutants.`);
  process.exit(1);
}

const runnable = CATALOG.filter((m) => !m.fork || FORK_RPC !== "");
const skipped = CATALOG.filter((m) => m.fork && FORK_RPC === "");

// 1. Clean baseline must be green for every suite the runnable mutants rely on.
const suites = [...new Set(runnable.map((m) => m.matchContract))];
for (const s of suites) {
  if (!forge(s)) {
    say(`BASELINE RED: ${s} fails before any mutant — fix the suite first.`);
    process.exit(1);
  }
  say(`baseline ${s}: green`);
}

// 2. Apply each mutant, expect the focused suite to fail, restore byte-exactly.
let caught = 0;
let survived = 0;
for (const m of runnable) {
  const path = resolve(ROOT, m.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(m.find)) {
    say(`ROT      ${m.id}: find-pattern no longer present in ${m.file} — re-aim the probe`);
    failures++;
    continue;
  }
  writeFileSync(path, original.replace(m.find, m.replace));
  try {
    const green = forge(m.matchContract);
    if (green) {
      say(`SURVIVED ${m.id} (${m.matchContract} stayed green) — write the killer test`);
      survived++;
    } else {
      say(`caught   ${m.id}`);
      caught++;
    }
  } finally {
    writeFileSync(path, original);
  }
}

for (const m of skipped) say(`skipped  ${m.id} (fork mutant; set SOL_MUTATION_FORK_RPC to run)`);

say(
  `\n${runnable.length} mutants: ${caught} caught, ${survived} survived, ${failures} rotted` +
    (skipped.length ? `; ${skipped.length} fork mutant(s) skipped` : ""),
);
process.exit(survived > 0 || failures > 0 ? 1 : 0);
