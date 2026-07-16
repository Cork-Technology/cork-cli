import { describe, expect, it } from "vitest";
import { getContractAddress, keccak256 } from "viem";
import { create2FromInitCode, create2FromInitCodeHash, toSalt } from "@cork/core";

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
