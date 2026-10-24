import { describe, expect, it } from 'vitest';

import {
  formatArchitectureUri,
  formatInitiativeUri,
  formatObservationUri,
  formatProjectUri,
  formatSessionUri,
  parseObservationUri,
} from '@/modules/cockpit/observationUri';

/**
 * AC4 — the observation URI grammar used by the cockpit's deep links.
 *
 * The round trip is the reading that matters: the formatter and the parser must agree on the
 * EXACT spelling, including the scheme (`cloudcli://` vs `quay://`), the kind segment and the
 * `board` suffix, because that string is the server's object key. Everything outside the
 * grammar is rejected rather than coerced, so a mis-spelled link cannot address a second object
 * for the same conversation.
 */
describe('observation URI grammar', () => {
  it('round-trips a session URI', () => {
    const uri = formatSessionUri('5f0c1f3a-session');
    expect(uri).toBe('cloudcli://session/5f0c1f3a-session');
    const parsed = parseObservationUri(uri);
    expect(parsed).toEqual({
      scheme: 'cloudcli',
      kind: 'session',
      id: '5f0c1f3a-session',
      uri,
    });
    expect(parsed === null ? null : formatObservationUri(parsed)).toBe(uri);
  });

  it('round-trips an architecture URI', () => {
    const uri = formatArchitectureUri('fleet-project-7');
    expect(uri).toBe('cloudcli://architecture/fleet-project-7');
    const parsed = parseObservationUri(uri);
    expect(parsed).toEqual({
      scheme: 'cloudcli',
      kind: 'architecture',
      id: 'fleet-project-7',
      uri,
    });
    expect(parsed === null ? null : formatObservationUri(parsed)).toBe(uri);
  });

  it('round-trips the fleet board URI unchanged', () => {
    const uri = formatProjectUri('MyProject');
    expect(uri).toBe('quay://MyProject/board');
    const parsed = parseObservationUri(uri);
    expect(parsed).toEqual({ scheme: 'quay', kind: 'project', id: 'MyProject', uri });
    expect(parsed === null ? null : formatObservationUri(parsed)).toBe(uri);
  });

  it('round-trips the fleet initiative URI (the reserved segment the initiative view pins)', () => {
    const uri = formatInitiativeUri('cockpit-observation-wall');
    expect(uri).toBe('quay://fleet/initiative/cockpit-observation-wall');
    const parsed = parseObservationUri(uri);
    expect(parsed).toEqual({
      scheme: 'quay',
      kind: 'initiative',
      id: 'cockpit-observation-wall',
      uri,
    });
    expect(parsed === null ? null : formatObservationUri(parsed)).toBe(uri);
  });

  it.each([
    '',
    'quay://fleet/initiative/',
    'quay://fleet/task/abc',
    'quay://fleet/initiative/a/b',
    'quay://fleet/initiative/a b',
    '   ',
    'cloudcli://session/',
    'cloudcli://session/a/b',
    'cloudcli://sessions/abc',
    'cloudcli://architecture//x',
    'cloudcli://session/a b',
    'cloudcli://session/a?x=1',
    'cloudcli://session/a#frag',
    'quay://project',
    'quay://project/Board',
    'quay:///board',
    'http://session/abc',
  ])('rejects the malformed form %j', (value) => {
    expect(parseObservationUri(value)).toBeNull();
  });

  it('rejects non-string input without throwing', () => {
    expect(parseObservationUri(undefined)).toBeNull();
    expect(parseObservationUri(null)).toBeNull();
    expect(parseObservationUri(42)).toBeNull();
    expect(parseObservationUri({ uri: 'cloudcli://session/x' })).toBeNull();
  });
});
