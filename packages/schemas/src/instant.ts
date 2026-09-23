// A venue TIMESTAMP crosses the boundary in exactly two unambiguous shapes (owner ruling
// 2026-09-23: normalise to a strict ISO string; live shapes verified the same day — every RFQ
// field (`valid_until`, `received_at`, `fresh_until`, option `expiry`, `expiry_window`) is integer
// unix SECONDS, while `/pools/v1` alone serves an ISO-8601 string). Everything else is refused:
// a zone-less date-time (Date.parse would read it as LOCAL time), a date-only or space-separated
// form, natural language, a negative or fractional number, and a digit string of 13+ digits
// (milliseconds masquerading as seconds — refused by the year-2100 bound the input schemas already
// enforce: every millisecond value of the current era exceeds it).
// The output is ONE canonical pair for every source: the instant as strict ISO-8601 UTC at second
// precision (`YYYY-MM-DDTHH:MM:SSZ`) and as decimal seconds, so two rows naming the same instant
// compare equal as strings whichever source they came from.

/** The canonical ISO spelling: UTC, second precision, no fraction. */
export function isoOfSeconds(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const STRICT_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
/** Unix seconds through year 2100 — the bound every absolute-timestamp INPUT schema enforces. */
const MAX_SECONDS = 4_102_444_800n;

export interface VenueInstant {
  /** strict ISO-8601 UTC, second precision */
  iso: string;
  /** decimal unix seconds */
  seconds: string;
  /** which admitted shape the source used */
  shape: "seconds" | "iso";
}

/** Parse a venue timestamp. `undefined` = not one of the two admitted shapes. */
export function venueInstant(v: unknown): VenueInstant | undefined {
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 0 || BigInt(v) > MAX_SECONDS) return undefined;
    return { iso: isoOfSeconds(BigInt(v)), seconds: String(v), shape: "seconds" };
  }
  if (typeof v !== "string") return undefined;
  if (/^\d+$/.test(v)) {
    const s = BigInt(v);
    if (s > MAX_SECONDS) return undefined; // 13-digit millisecond values land here and are refused
    return { iso: isoOfSeconds(s), seconds: s.toString(), shape: "seconds" };
  }
  const m = STRICT_ISO.exec(v);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, sec, , zone] = m as unknown as [string, string, string, string, string, string, string, string | undefined, string];
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}${zone}`); // fraction dropped, zone kept
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  // Round-trip the calendar fields in the INPUT's own zone: an out-of-range field (month 13, day
  // 30 of February, hour 24) parses to a shifted instant that no longer reproduces the fields —
  // refuse, never roll over.
  const offsetMin = zone === "Z" ? 0 : (zone.startsWith("-") ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  const local = new Date(ms + offsetMin * 60_000);
  const two = (n: number) => String(n).padStart(2, "0");
  const rebuilt = `${String(local.getUTCFullYear()).padStart(4, "0")}-${two(local.getUTCMonth() + 1)}-${two(local.getUTCDate())}T${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())}`;
  if (rebuilt !== `${y}-${mo}-${d}T${h}:${mi}:${sec}`) return undefined;
  const seconds = BigInt(Math.floor(ms / 1000));
  if (seconds > MAX_SECONDS) return undefined;
  return { iso: isoOfSeconds(seconds), seconds: seconds.toString(), shape: "iso" };
}
