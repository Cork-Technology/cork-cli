// Offline consumer proof for optional API119 effectiveStatus, not a real API/DB/EVM proof.
// Run only in an explicitly admitted serial window. Requires SMOKE_OUTPUT and
// CLI39_SOURCE_MANIFEST; optional CLI39_NATIVE_BINARY selects the separately built binary.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, encodeFunctionResult, multicall3Abi } from 'viem';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { settlerStatusAbi } from '../packages/core/src/rollover-verify.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.env.SMOKE_OUTPUT, 'SMOKE_OUTPUT required');
assert.ok(process.env.CLI39_SOURCE_MANIFEST, 'CLI39_SOURCE_MANIFEST required');
assert.equal(process.env.CLI39_OWNED_MCP_SHUTDOWN_ADMITTED, '1', 'separate admission required for SDK EOF/SIGTERM/SIGKILL on only this runner-owned MCP child');
const OUT = resolve(process.env.SMOKE_OUTPUT);
const manifestBytes = await readFile(process.env.CLI39_SOURCE_MANIFEST);
const manifest = JSON.parse(manifestBytes);
for (const [path, expected] of Object.entries(manifest.files)) {
  if (expected.gitlink || expected.deleted) continue;
  const bytes = await readFile(join(ROOT, path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, 'source changed: ' + path);
}
await mkdir(OUT, { recursive: true });
const home = join(OUT, 'home');
await mkdir(home, { recursive: true });
Object.assign(process.env, { CORK_CONFIG_NO_FETCH: '1', CORK_CONFIG_NO_OVERRIDE: '1' });
const { rolloverRow, CHAIN } = await import('../packages/core/test/rollover-status-fixtures.ts');
const now = BigInt(Math.floor(Date.now() / 1000));
const cases = [
  ['unopened_elapsed', 'PENDING', 0], ['future_pending', 'PENDING', 0],
  ['opened_late', 'OPENED', 1], ['partial_late', 'PARTIALLY_FILLED', 1],
  ['premium_late', 'AWAITING_PREMIUM', 1], ['settled_late', 'SETTLED', 2],
  ['cancelled', 'CANCELLED', 4], ['closing', 'CLOSING', 5], ['onchain_expired', 'EXPIRED', 3],
  ['raw_expired_none', 'EXPIRED', 0], ['unknown_venue', 'FUTURE_STATUS', 0],
  ['unknown_chain', 'PENDING', 99], ['rpc_unavailable', 'PENDING', 'error'],
  ['unknown_effective', 'PENDING', 0], ['status_rpc_unavailable', 'PENDING', 'error'],
];
const fixtures = cases.map(([label, status, chain], i) => ({
  label, chain, row: { ...rolloverRow(label === 'future_pending' ? now + 3600n : now - 3600n - BigInt(i)), status },
}));
const states = new Map(fixtures.map((f) => [f.row.orderDigest.toLowerCase(), f.chain]));
const unavailableHistoryDigest = fixtures.find((f) => f.label === 'rpc_unavailable').row.orderDigest.toLowerCase();
const settler = fixtures[0].row.settler;
const native = process.env.CLI39_NATIVE_BINARY && resolve(process.env.CLI39_NATIVE_BINARY);
const guard = join(ROOT, 'scripts/rollover-expiry-network-guard.mjs');
const cli = native ? [native] : [process.execPath, '--preload', guard, 'packages/cli/src/bin.ts'];
const mcp = native ? { command: native, args: ['mcp'] } : { command: process.execPath, args: ['--preload', guard, 'packages/mcp/src/bin.ts'] };
const report = {
  status: 'NOT_STARTED', sourceFingerprint: manifest.fingerprint,
  manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  native: native ? { path: native, sha256: createHash('sha256').update(await readFile(native)).digest('hex') } : null,
  limits: 'Authored production-c10ae6b/additive-9a8b35d HTTP shapes and state-backed RPC fixture; not real API/DB, EVM, deployed-state or rollout verification',
  variants: [], rpcCalls: [], venueCalls: [], cleanup: {},
};
let rpc, venue;
try {
  rpc = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json();
    const respond = (call) => {
      report.rpcCalls.push(call);
      try {
        let result;
        if (call.method === 'eth_chainId') result = '0x2105';
        else if (call.method === 'eth_blockNumber') result = '0x100000';
        else if (call.method === 'eth_getLogs') {
          const digestSelector = call.params[0].topics?.[1];
          const selectedDigests = Array.isArray(digestSelector) ? digestSelector : [digestSelector];
          if (selectedDigests.some((digest) => typeof digest === 'string' && digest.toLowerCase() === unavailableHistoryDigest)) {
            throw new Error('fixture event history unavailable');
          }
          result = []; // Every other digest retains successful authored history.
        }
        else if (call.method === 'eth_call') {
          const readStatus = (target, data) => {
            assert.equal(target.toLowerCase(), settler.toLowerCase(), 'unexpected settler');
            const decoded = decodeFunctionData({ abi: settlerStatusAbi, data });
            assert.equal(decoded.functionName, 'orderStatus');
            const state = states.get(decoded.args[0].toLowerCase());
            assert.notEqual(state, undefined, 'unexpected digest');
            if (state === 'error') throw new Error('fixture RPC unavailable');
            return encodeFunctionResult({ abi: settlerStatusAbi, functionName: 'orderStatus', result: state });
          };
          const { to, data } = call.params[0];
          if (to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') {
            const decoded = decodeFunctionData({ abi: multicall3Abi, data });
            assert.equal(decoded.functionName, 'aggregate3');
            result = encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: decoded.args[0].map((c) => {
              try { return { success: true, returnData: readStatus(c.target, c.callData) }; }
              catch { return { success: false, returnData: '0x' }; }
            }) });
          } else result = readStatus(to, data);
        } else throw new Error('unexpected RPC method ' + call.method);
        return { jsonrpc: '2.0', id: call.id, result };
      } catch (error) { return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: String(error) } }; }
    };
    return Response.json(Array.isArray(body) ? body.map(respond) : respond(body));
  } });
  for (const producer of ['old-missing', 'additive']) {
    const rows = fixtures.map((f) => {
      const effectiveStatus = f.label === 'unknown_effective' ? 'FUTURE_STATUS' : f.row.status === 'PENDING' && BigInt(f.row.fillDeadline) <= now ? 'EXPIRED' : f.row.status;
      return producer === 'additive' ? { ...f.row, effectiveStatus } : f.row;
    });
    venue = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
      const u = new URL(req.url);
      report.venueCalls.push({ producer, url: u.pathname + u.search });
      if (u.pathname === '/rollover/v1/orders') {
        assert.equal(u.searchParams.has('status'), false, 'unexpected default status filter');
        assert.equal(u.searchParams.has('fillable'), false, 'unexpected default eligibility filter');
        return Response.json({ items: rows, hasMore: false });
      }
      const row = rows.find((r) => u.pathname === '/rollover/v1/orders/' + r.orderDigest);
      assert.ok(row, 'unexpected venue route: ' + u.pathname);
      return Response.json({ order: row, fills: [], slots: [] });
    } });
    const env = { ...process.env, HOME: home, CORK_VENUE_URL: venue.url.href, CORK_RPC_URL: rpc.url.href, CORK_LOGS_RPC_URL: rpc.url.href,
      CORK_AUTO_UPDATE: '0', CORK_RPC_NO_FAILOVER: '1', CORK_CREDENTIALS_FILE: join(home, 'no-credentials'), CORK_CONFIG_CACHE_FILE: join(home, 'config-cache'),
      CORK_RPC_CACHE_FILE: join(home, 'rpc-cache'), CORK_SCAN_CACHE_FILE: join(home, 'scan-cache'), CORK_CONST_CACHE_FILE: join(home, 'constant-cache'), NO_COLOR: '1' };
    delete env.ENVIO_API_TOKEN;
    delete env.ENVIO_HYPERRPC_TOKEN;
    const variant = { producer, cli: [], mcp: [] };
    report.variants.push(variant);
    const client = new Client({ name: 'rollover-effective-status-smoke', version: '1' });
    const transport = new StdioClientTransport({ ...mcp, cwd: ROOT, env, stderr: 'pipe' });
    let childClosed;
    let mcpStderr = '';
    transport.stderr?.on('data', (chunk) => { mcpStderr += chunk.toString(); });
    try {
      await client.connect(transport);
      variant.mcpPid = transport.pid;
      const onclose = transport.onclose;
      childClosed = new Promise((resolve) => {
        transport.onclose = () => {
          variant.mcpChildCloseObserved = true;
          onclose?.();
          resolve();
        };
      });
      for (const [i, fixture] of fixtures.entries()) {
        const input = { mode: 'reconcile', chainId: CHAIN, subject: { kind: 'orderHash', orderHash: fixture.row.orderDigest } };
        const child = Bun.spawn([...cli, 'track', '--json', JSON.stringify(input)], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        variant.cli.push({ label: fixture.label, code, stdout, stderr });
        const envelope = JSON.parse(stdout);
        const conflict = ['raw_expired_none', 'unknown_venue', 'unknown_chain'].includes(fixture.label);
        assert.equal(code, conflict ? 4 : 0, producer + '/' + fixture.label);
        assert.equal(envelope.state, conflict ? 'conflict' : 'ok');
        assert.deepEqual(envelope.data.order, rows[i]);
        assert.equal(Object.hasOwn(envelope.data, 'effectiveStatus'), false, 'redundant summary alias');
        if (!conflict) assert.equal(envelope.data.lifecycle, fixture.row.status);
        if (fixture.label === 'unopened_elapsed') {
          assert.equal(envelope.data.chainVerification.chainStatus, 'None');
          assert.equal(Object.hasOwn(envelope.data.chainVerification, 'expiry'), false);
          assert.deepEqual(envelope.data.chainVerification.events, []);
          assert.equal(envelope.data.order.expiredAt, null);
        }
        if (fixture.label === 'rpc_unavailable') {
          assert.equal(envelope.provenance.source, 'indexer');
          assert.ok(envelope.warnings.some((w) => w.code === 'chain_read_failed'));
          assert.ok(envelope.warnings.some((w) => w.code === 'logs_unavailable'));
          assert.equal(Object.hasOwn(envelope.data, 'chainVerification'), false);
        }
        if (fixture.label === 'status_rpc_unavailable') {
          assert.equal(envelope.provenance.source, 'chain');
          assert.ok(envelope.warnings.some((w) => w.code === 'chain_read_failed'));
          assert.equal(envelope.warnings.some((w) => w.code === 'logs_unavailable'), false);
          assert.deepEqual(envelope.data.chainVerification.events, []);
          assert.equal(Object.hasOwn(envelope.data.chainVerification, 'chainStatus'), false);
          assert.equal(Object.hasOwn(envelope.data.chainVerification, 'consistent'), false);
        }
        const output = await client.callTool({ name: 'cork_track', arguments: input });
        variant.mcp.push({ label: fixture.label, output });
        assert.equal(output.structuredContent.state, envelope.state);
        assert.deepEqual(output.structuredContent.data, envelope.data);
      }
      const queryInput = { resource: 'rollover-orders', chainId: CHAIN, pageSize: 100 };
      const child = Bun.spawn([...cli, 'query', '--json', JSON.stringify(queryInput)], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      variant.query = { code, stdout, stderr };
      assert.equal(code, 0, stderr);
      const envelope = JSON.parse(stdout);
      assert.deepEqual(envelope.data.items.map((r) => r.orderDigest), fixtures.filter((f) => f.label !== 'raw_expired_none').map((f) => f.row.orderDigest));
      for (const item of envelope.data.items) {
        const fixture = fixtures.find((f) => f.row.orderDigest === item.orderDigest);
        assert.equal(item.status, fixture.row.status);
        assert.equal(item.verification, ['unknown_venue', 'unknown_chain', 'rpc_unavailable', 'status_rpc_unavailable'].includes(fixture.label) ? 'unverified' : 'confirmed');
        assert.equal(Object.hasOwn(item, 'effectiveStatus'), producer === 'additive');
        if (producer === 'additive') assert.equal(item.effectiveStatus, rows.find((r) => r.orderDigest === item.orderDigest).effectiveStatus);
        assert.equal(Object.hasOwn(item, 'expiry'), false);
      }
      const output = await client.callTool({ name: 'cork_query', arguments: queryInput });
      variant.mcpQuery = output;
      assert.deepEqual(output.structuredContent.data, envelope.data);
      const input = { mode: 'reconcile', chainId: CHAIN, subject: { kind: 'orderHash', orderHash: fixtures[0].row.orderDigest } };
      const human = Bun.spawn([...cli, 'track', '--input', JSON.stringify(input)], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
      const [humanOut, humanErr, humanCode] = await Promise.all([new Response(human.stdout).text(), new Response(human.stderr).text(), human.exited]);
      variant.human = { stdout: humanOut, stderr: humanErr, code: humanCode };
      assert.equal(humanCode, 0, humanErr);
      assert.match(humanOut, /lifecycle\s+PENDING/);
      assert.match(humanOut, /chainStatus\s+None/);
      if (producer === 'additive') assert.match(humanOut, /effectiveStatus\s+EXPIRED/);
      else assert.equal(humanOut.includes('effectiveStatus'), false);
    } finally {
      await client.close();
      if (childClosed) await childClosed;
      variant.mcpStderr = mcpStderr;
    }
    await venue.stop();
    venue = undefined;
  }
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (venue) await venue.stop();
  if (rpc) await rpc.stop();
  report.cleanup.listenersClosed = true;
  await writeFile(join(OUT, 'RESULT.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, sourceFingerprint: report.sourceFingerprint, native: report.native, cleanup: report.cleanup, error: report.error }));
