// Standard CREATE2 address derivation (EIP-1014):
//   address = keccak256(0xff ++ deployer ++ salt ++ keccak256(initCode))[12:]
// Used by `cork config --verify` to reproduce Cork's Safe-Singleton-Factory deployments
// (deployer 0x914d7Fec…43d7) from prod.toml salt + Sourcify creation bytecode (verified C10).
import { concatHex, getAddress, keccak256, pad, slice, toHex } from "viem";

/** keccak256(0xff ++ deployer ++ salt ++ initCodeHash), last 20 bytes, checksummed. */
export function create2FromInitCodeHash(args: {
  deployer: `0x${string}`;
  salt: `0x${string}`;
  initCodeHash: `0x${string}`;
}): `0x${string}` {
  const salt32 = pad(args.salt, { size: 32 });
  const packed = concatHex(["0xff", getAddress(args.deployer), salt32, args.initCodeHash]);
  return getAddress(slice(keccak256(packed), 12));
}

/** Same, hashing raw creation bytecode (Sourcify `creationBytecode.onchainBytecode`) first. */
export function create2FromInitCode(args: {
  deployer: `0x${string}`;
  salt: `0x${string}`;
  initCode: `0x${string}`;
}): `0x${string}` {
  return create2FromInitCodeHash({
    deployer: args.deployer,
    salt: args.salt,
    initCodeHash: keccak256(args.initCode),
  });
}

/** Salt from a numeric/string seed → left-padded bytes32 (Cork uses raw bytes32 salts). */
export function toSalt(value: bigint | number | `0x${string}`): `0x${string}` {
  if (typeof value === "string") return pad(value, { size: 32 });
  return pad(toHex(value), { size: 32 });
}
