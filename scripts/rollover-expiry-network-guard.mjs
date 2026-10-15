// Preloaded only by the offline expiry runner, never by production entrypoints.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') {
    throw new Error('expiry smoke blocked off-loopback fetch: ' + url.origin);
  }
  return originalFetch(input, init);
};
