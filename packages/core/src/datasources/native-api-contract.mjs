// Reviewed source identities; served metadata may use an unambiguous Git abbreviation.
// A declared revision does not attest DB state or execution permission.
export const requiredApiRevision = "72010c8";
export const supportedApiRevisions = Object.freeze([
  "72010c88a2d591796d90a99b32f33abbf77dd3be",
  "6c459d5dd403a73455f4172f533040fd7a0957ee",
  "b5c3405d15867f2bbbf383bb7729651c88ef18b6",
  "c0bbf0552de9687612ce58a73b0d5cc819ad7059",
]);
export const apiComponent = "cork-api";

const revisionPattern = /^[0-9a-f]{7,40}$/;

/**
 * @param {unknown} revision
 * @returns {revision is string}
 */
export function isReviewedApiRevision(revision) {
  if (typeof revision !== "string" || !revisionPattern.test(revision)) return false;
  let matches = 0;
  for (const sourceRevision of supportedApiRevisions) {
    if (sourceRevision.startsWith(revision)) matches++;
  }
  return matches === 1;
}
