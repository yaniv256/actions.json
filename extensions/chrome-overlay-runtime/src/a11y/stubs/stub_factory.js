// U2 stub factory (docs/a11y-shim-spec.md §3 Tier B).
// Produces constructible, chainable, callable no-op stand-ins for platform
// modules the a11y bundle severs (tts/braille/panel/logging/...). Real seams
// (e.g. the TTS announcement sink) replace individual stubs in U5.
const CHAIN = new Proxy(function stubChain() {}, {
  get(target, prop) {
    if (prop === 'then' || typeof prop === 'symbol') return undefined; // await-safe
    if (prop === 'prototype') return target.prototype;
    return CHAIN;
  },
  apply() { return CHAIN; },
  construct() { return CHAIN; },
});

export function makeStub(name) {
  const base = function StubBase() {};
  base.stubName = name;
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      if (prop === 'prototype') return target.prototype; // keeps `extends` working
      if (prop === 'name' || prop === 'stubName') return name;
      return CHAIN;
    },
    construct() { return CHAIN; },
    apply() { return CHAIN; },
  });
}
