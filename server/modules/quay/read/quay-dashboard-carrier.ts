
import { asArray, asRecord, readCount } from './quay-snapshot-summaries.js';

/**
 * The `quay serve` dashboard link read from the `.quay/server.json` carrier instead of
 * `quay server status --json` (which costs one subprocess per driver kind). The carrier's own
 * `up` flag is NOT trusted — liveness is established by a live probe at the recorded address.
 *
 * Consumers: `service/quay-snapshot-read.service.ts`.
 */

/**
 * The state carrier `quay serve` publishes under the project's `.quay/`: which services
 * its one server process hosts and on which host/port each is bound. Read directly in
 * place of `quay server status --json`, which answers the same question only after
 * serially spawning one subprocess per driver kind — several seconds of work for the
 * single `web` entry the panel links to.
 */
export const QUAY_SERVER_STATE_FILE = 'server.json';

/**
 * Resolves the `web` service's recorded bind address from a parsed `.quay/server.json`
 * body, or `null` when there is no usable one: no `services` array, no `web` entry, or a
 * `web` entry without a non-empty `host` and a positive `port`.
 *
 * The carrier's own `up` flag is deliberately NOT consulted: it is a write-time claim, and
 * a killed server leaves it `true` on disk. Liveness is established by a live probe
 * instead, so a stale carrier cannot produce a link to a dashboard that is not there.
 */
export function readWebServiceAddress(value: unknown): { host: string; port: number } | null {
  const web = asArray(asRecord(value)?.services)
    .map((service) => asRecord(service))
    .find((service) => service?.name === 'web');
  if (!web) {
    return null;
  }

  const host = typeof web.host === 'string' && web.host ? web.host : null;
  const port = readCount(web.port);
  if (!host || port <= 0) {
    return null;
  }

  return { host, port };
}

/**
 * The address to dial and link to for a recorded bind host. A wildcard binding
 * (`0.0.0.0` / `::` / `*`) is not itself a destination — it is reachable on loopback, and
 * a browser cannot open `http://0.0.0.0:…/`. quay's own `server status` probe makes the
 * same substitution before dialling.
 */
export function probeAddress(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '*' ? '127.0.0.1' : host;
}
