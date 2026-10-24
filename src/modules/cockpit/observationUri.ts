/**
 * The observation wall's URI grammar, shared by Cockpit's future wall view and the deep links
 * that point at an observed object.
 *
 * One object is addressed by one string, and the string is the key the server joins the
 * observed-object row, its delta log and the user's seen cursor on. The grammar is the server's
 * (`server/modules/observation/observation-uri.ts`), restated here because the two compilers
 * have separate `@` roots and the repository forbids `server/` from importing the repo-root
 * `shared/` tree (the AC-394 unresolved-internal budget). Keep the two spellings in step: a
 * change to one without the other makes a deep link address an object the server never wrote.
 *
 *   cloudcli://session/<id>              — one CloudCLI session
 *   cloudcli://architecture/<projectId>  — one project's architecture graph
 *   quay://<fleetProjectId>/board        — one fleet project's board (the fleet's grammar)
 *
 * Consumers: the cockpit wall view and its deep-link builders.
 */

/** The object kinds the observation layer models. */
export type ObservationKind = 'session' | 'project' | 'architecture';

/**
 * A parsed observation URI. `uri` is the canonical spelling, so a caller can use the parsed
 * value as a map key without re-formatting it.
 */
export type ObservationUri =
  | { scheme: 'cloudcli'; kind: 'session'; id: string; uri: string }
  | { scheme: 'cloudcli'; kind: 'architecture'; id: string; uri: string }
  | { scheme: 'quay'; kind: 'project'; id: string; uri: string };

/** One path segment: at least one character, none of the URI's structural characters. */
const SEGMENT = '[^/?#\\s]+';

const CLOUDCLI_URI = new RegExp(`^cloudcli://(session|architecture)/(${SEGMENT})$`);
const QUAY_BOARD_URI = new RegExp(`^quay://(${SEGMENT})/board$`);

/** The canonical `cloudcli://session/<id>` spelling. */
export function formatSessionUri(id: string): string {
  return `cloudcli://session/${id}`;
}

/** The canonical `cloudcli://architecture/<id>` spelling. */
export function formatArchitectureUri(projectId: string): string {
  return `cloudcli://architecture/${projectId}`;
}

/** The canonical `quay://<fleetProjectId>/board` spelling. */
export function formatProjectUri(fleetProjectId: string): string {
  return `quay://${fleetProjectId}/board`;
}

/** Formats a parsed URI back to its canonical spelling. */
export function formatObservationUri(parsed: ObservationUri): string {
  switch (parsed.kind) {
    case 'session':
      return formatSessionUri(parsed.id);
    case 'architecture':
      return formatArchitectureUri(parsed.id);
    case 'project':
      return formatProjectUri(parsed.id);
  }
}

/** Parses one URI, returning `null` for anything outside the grammar (the server's answer too). */
export function parseObservationUri(value: unknown): ObservationUri | null {
  if (typeof value !== 'string') return null;
  const cloudcli = CLOUDCLI_URI.exec(value);
  if (cloudcli !== null) {
    const kind = cloudcli[1] === 'session' ? 'session' : 'architecture';
    const id = cloudcli[2]!;
    return { scheme: 'cloudcli', kind, id, uri: value };
  }
  const quay = QUAY_BOARD_URI.exec(value);
  if (quay !== null) {
    return { scheme: 'quay', kind: 'project', id: quay[1]!, uri: value };
  }
  return null;
}
