// Codex app-server processes for one signed-in owner share a writable
// CODEX_HOME. Cold initialization touches that shared state; only the short
// initialization handshake is serialized. Once ready, their turns run freely.
export function createRuntimeStartCoordinator(cache) {
  const tailByOwner = new Map();

  async function ready(key, instance) {
    try {
      await instance.ready;
      return instance;
    } catch (error) {
      if (cache.get(key) === instance) {
        cache.delete(key);
        instance.close?.();
      }
      throw error;
    }
  }

  return async function start(owner, key, create) {
    const cached = cache.get(key);
    if (cached) return ready(key, cached);

    const previous = tailByOwner.get(owner) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    tailByOwner.set(owner, gate);
    await previous;
    try {
      const existing = cache.get(key);
      if (existing) return await ready(key, existing);
      const instance = create();
      cache.set(key, instance);
      return await ready(key, instance);
    } finally {
      release();
      if (tailByOwner.get(owner) === gate) tailByOwner.delete(owner);
    }
  };
}
