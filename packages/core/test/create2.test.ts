import { describe, expect, it } from "vitest";
import { getContractAddress, keccak256 } from "viem";
import { create2FromInitCode, create2FromInitCodeHash, toSalt, verifyCreate2 } from "@cork/core";

const DEPLOYER = "0x914d7Fec6aac8cd542e72Bca78B30650d45643d7"; // Cork Safe Singleton Factory
const SALT1 = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const INIT_CODE = "0x6080604052" as const;
const INIT_HASH = keccak256(INIT_CODE);

describe("CREATE2 (EIP-1014) address derivation", () => {
  it("matches independent `cast create2` ground-truth", () => {
    // cast create2 --deployer <DEPLOYER> --salt <SALT1> --init-code-hash keccak(0x6080604052)
    expect(create2FromInitCodeHash({ deployer: DEPLOYER, salt: SALT1, initCodeHash: INIT_HASH })).toBe(
      "0xa9862c8718897FeB2a2b111Ce26b51bFd6b59A30",
    );
  });

  it("from raw init code == from its hash", () => {
    expect(create2FromInitCode({ deployer: DEPLOYER, salt: SALT1, initCode: INIT_CODE })).toBe(
      create2FromInitCodeHash({ deployer: DEPLOYER, salt: SALT1, initCodeHash: INIT_HASH }),
    );
  });

  it("agrees with viem getContractAddress(CREATE2)", () => {
    const viemAddr = getContractAddress({
      opcode: "CREATE2",
      from: DEPLOYER,
      salt: SALT1,
      bytecodeHash: INIT_HASH,
    });
    expect(create2FromInitCodeHash({ deployer: DEPLOYER, salt: SALT1, initCodeHash: INIT_HASH })).toBe(viemAddr);
  });

  it("toSalt left-pads numeric seeds to bytes32", () => {
    expect(toSalt(1n)).toBe(SALT1);
    expect(toSalt(0)).toBe("0x0000000000000000000000000000000000000000000000000000000000000000");
  });
});

describe("verifyCreate2 against the REAL deployed CorkAdapter", () => {
  // Empirically anchored: salt from phoenix config/prod.toml [sepolia.bytes32].cork_adapter_salt,
  // initCodeHash = keccak(Sourcify creation bytecode of 0xCCcC…0407). `cast create2` reproduces
  // the deployed address from exactly these inputs (verified out-of-band before baking).
  const CORK_DEPLOYER = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7" as const;
  const SALT = "0x212fafd35b277528fa898ceaadcc917285f4666e2a87556d583e345956860f7d" as const;
  const INIT_CODE_HASH = "0x2e1204abee27192079350f3f17779da88e1940a2ac222eb9f3e5a66060f682cb" as const;
  const EXPECTED = "0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407" as const;

  it("reproduces the deployed address (match)", () => {
    const v = verifyCreate2({ deployer: CORK_DEPLOYER, salt: SALT, initCodeHash: INIT_CODE_HASH, expected: EXPECTED });
    expect(v.match).toBe(true);
    expect(v.computed).toBe(EXPECTED);
  });

  it("a wrong salt does NOT reproduce it (no false-positive)", () => {
    const badSalt = `0x${"00".repeat(31)}01` as const;
    const v = verifyCreate2({ deployer: CORK_DEPLOYER, salt: badSalt, initCodeHash: INIT_CODE_HASH, expected: EXPECTED });
    expect(v.match).toBe(false);
    expect(v.computed).not.toBe(EXPECTED);
  });
});
