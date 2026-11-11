/**
 * One in-flight token read per instance. Two requests that need a renewal at the same moment
 * would otherwise both spend the same refresh token, and with a provider that rotates it the
 * loser's `invalid_grant` would wipe the session the winner just stored.
 */
export function singleFlight<A extends { id: string }, R>(read: (key: A) => Promise<R>): (key: A) => Promise<R> {
  const inFlight = new Map<string, Promise<R>>();
  return (key) => {
    const pending = inFlight.get(key.id);
    if (pending) {
      return pending;
    }
    const started = read(key).finally(() => inFlight.delete(key.id));
    inFlight.set(key.id, started);
    return started;
  };
}
