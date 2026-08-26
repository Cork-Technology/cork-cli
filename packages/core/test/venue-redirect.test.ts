// Redirect policy for venue HTTP (audit MCP-NET-004, 2026-08-24). The default `fetch` follows
// redirects itself, so the first the caller hears of a hop is AFTER the body has been delivered
// to wherever the redirect pointed — and a relay body is a caller-SIGNED order. These tests run
// REAL loopback HTTP servers (no fetch stub): the redirect has to actually be issued, and the
// destination server counts what it received.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getLopOrderbook, postLopOrder, VenueUnreachable } from "@cork/core";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A server that counts every request it receives and echoes an empty JSON body. */
async function destination(seen: { count: number; bodies: string[] }): Promise<string> {
  return listen((req, res) => {
    seen.count++;
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      seen.bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
}

const relayBody = { salt: "1", maker: "0x00000000000000000000000000000000000000aa", signature: "0xsigned-by-the-caller" };

describe("a POST relay never crosses an origin", () => {
  it("a cross-origin 307 is refused BEFORE the destination receives the signed body", async () => {
    const seen = { count: 0, bodies: [] as string[] };
    const elsewhere = await destination(seen);
    const venue = await listen((_req, res) => {
      res.writeHead(307, { location: `${elsewhere}/limit-orders/v1` });
      res.end();
    });
    await expect(postLopOrder({ baseUrl: venue, breaker: null }, relayBody)).rejects.toBeInstanceOf(VenueUnreachable);
    expect(seen.count, "the caller-signed body must never reach the redirect target").toBe(0);
  });

  it("a SAME-origin 307 is followed, with the method and body intact", async () => {
    const seen = { count: 0, bodies: [] as string[] };
    let hop = 0;
    const methods: string[] = [];
    const venue = await listen((req, res) => {
      methods.push(req.method ?? "");
      if (hop++ === 0) {
        res.writeHead(307, { location: "/limit-orders/v2" });
        res.end();
        return;
      }
      seen.count++;
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        seen.bodies.push(body);
        res.writeHead(201, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    const out = await postLopOrder({ baseUrl: venue, breaker: null }, relayBody);
    expect(out.httpStatus).toBe(201);
    expect(methods).toEqual(["POST", "POST"]); // 307 preserves the method
    expect(JSON.parse(seen.bodies[0]!)).toMatchObject({ signature: "0xsigned-by-the-caller" });
  });

  it.each([301, 302, 303])("a same-origin %i is refused for a write — it would rewrite the POST to a bodyless GET", async (status) => {
    const seen = { count: 0, bodies: [] as string[] };
    let hop = 0;
    const venue = await listen((req, res) => {
      if (hop++ === 0) {
        res.writeHead(status, { location: "/limit-orders/v2" });
        res.end();
        return;
      }
      seen.count++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      void req;
    });
    await expect(postLopOrder({ baseUrl: venue, breaker: null }, relayBody)).rejects.toBeInstanceOf(VenueUnreachable);
    expect(seen.count).toBe(0);
  });
});

describe("a GET read may follow same-origin redirects, within a bound", () => {
  it("follows a same-origin 302 and returns the final body", async () => {
    let hop = 0;
    const venue = await listen((_req, res) => {
      if (hop++ === 0) {
        res.writeHead(302, { location: "/limit-orders/v1/orderbook?moved=1" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [{ orderHash: `0x${"11".repeat(32)}` }], hasMore: false }));
    });
    const page = await getLopOrderbook({ baseUrl: venue, breaker: null }, {});
    expect(page.items).toHaveLength(1);
  });

  it("refuses a redirect chain longer than three hops", async () => {
    let hop = 0;
    const venue = await listen((_req, res) => {
      hop++;
      res.writeHead(302, { location: `/limit-orders/v1/orderbook?hop=${hop}` });
      res.end();
    });
    await expect(getLopOrderbook({ baseUrl: venue, breaker: null }, {})).rejects.toBeInstanceOf(VenueUnreachable);
    // 1 original + 3 followed hops, then the refusal. (The venue transport retries idempotent
    // GETs once, so the whole sequence runs twice.)
    expect(hop).toBe(8);
  });

  it("refuses a cross-origin redirect on a read too — a read carries our headers", async () => {
    const seen = { count: 0, bodies: [] as string[] };
    const elsewhere = await destination(seen);
    const venue = await listen((_req, res) => {
      res.writeHead(302, { location: `${elsewhere}/limit-orders/v1/orderbook` });
      res.end();
    });
    await expect(getLopOrderbook({ baseUrl: venue, breaker: null }, {})).rejects.toBeInstanceOf(VenueUnreachable);
    expect(seen.count).toBe(0);
  });

  it("refuses a redirect to a non-http scheme, and one carrying credentials", async () => {
    for (const location of ["file:///etc/passwd", "https://user:secret@127.0.0.1:1/x"]) {
      const venue = await listen((_req, res) => {
        res.writeHead(302, { location });
        res.end();
      });
      await expect(getLopOrderbook({ baseUrl: venue, breaker: null }, {})).rejects.toBeInstanceOf(VenueUnreachable);
    }
  });
});
