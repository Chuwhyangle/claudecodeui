import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enCommon from '@/modules/i18n/locales/en/common.json';
import type { ApiLatencyProbeResult, ApiLatencySeries } from '@/shared/apiLatencyType';
import { ApiSpeedPanel } from '@/modules/api-speed/ApiSpeedPanel';

/**
 * The API-speed panel as the user meets it: the empty state, the staged
 * breakdown of a stored sample, the missing-credential banner and the Ping
 * button's request.
 *
 * The transport is replaced at the `@/shared/api` seam with responses shaped like
 * the real ones (`{ ok, status, json }`), so `readApiJson` — the reader the hook
 * actually calls — stays in play rather than being stubbed out of the test.
 *
 * The controller's own rules (overlap, auto-probe scheduling, disposal) are
 * covered without React in `apiSpeedController.test.ts`; this file is about what
 * the user sees and what a click sends.
 */

const apiLatencyMock = vi.hoisted(() => ({ series: vi.fn(), probe: vi.fn() }));

vi.mock('@/shared/api', () => ({
  api: { apiLatency: apiLatencyMock },
  readApiJson: async (response: Response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return data;
  },
}));

/** A response double with the five members `readApiJson` reads. */
function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

function probe(overrides: Partial<ApiLatencyProbeResult> = {}): ApiLatencyProbeResult {
  return {
    id: 'probe-one',
    at: '2026-11-20T12:00:00.000Z',
    ok: true,
    mode: 'ping',
    stream: true,
    model: 'test-model',
    transport: 'reused',
    status: 200,
    requestBytes: 120,
    responseBytes: 40,
    timings: { dnsMs: null, tcpMs: null, tlsMs: null, uploadMs: 0, firstByteMs: 400, downloadMs: 2, totalMs: 402 },
    firstTokenMs: 410,
    error: null,
    ...overrides,
  };
}

function series(probes: ApiLatencyProbeResult[], overrides: Partial<ApiLatencySeries['target']> = {}): ApiLatencySeries {
  return {
    target: {
      baseUrl: 'https://gateway.example.test',
      host: 'gateway.example.test',
      model: 'test-model',
      hasCredential: true,
      credentialSource: 'env',
      ...overrides,
    },
    probes,
  };
}

function renderPanel() {
  return render(
    <I18nextProvider i18n={i18next}>
      <ApiSpeedPanel />
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  apiLatencyMock.series.mockReset();
  apiLatencyMock.probe.mockReset();
  apiLatencyMock.probe.mockImplementation(async (input: { mode?: string; stream?: boolean }) =>
    jsonResponse(probe({ id: 'probe-new', mode: input.mode === 'upload' ? 'upload' : 'ping' })));

  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      ns: ['common'],
      defaultNS: 'common',
      resources: { en: { common: enCommon } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  }
});

describe('ApiSpeedPanel', () => {
  it('shows the empty state when the store has no samples yet', async () => {
    apiLatencyMock.series.mockResolvedValue(jsonResponse(series([])));

    renderPanel();

    expect(await screen.findByText(enCommon.apiSpeed.empty)).toBeTruthy();
    // The gateway line proves the reading reached the panel, not just the spinner.
    await waitFor(() => expect(screen.getByText(/gateway\.example\.test/)).toBeTruthy());
  });

  it('draws the staged breakdown and the total for a stored sample', async () => {
    apiLatencyMock.series.mockResolvedValue(jsonResponse(series([probe()])));

    renderPanel();

    // A reused connection reports "reused" for the connection leg instead of three zeroes.
    expect(await screen.findAllByText(enCommon.apiSpeed.reused)).toBeTruthy();
    expect(screen.getAllByText(enCommon.apiSpeed.stageGateway).length).toBeGreaterThan(0);
    // 402 ms renders as 0.40 s in the breakdown's own total row.
    expect(screen.getAllByText('0.40 s').length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(`^${enCommon.apiSpeed.firstToken} `))).toBeTruthy();
  });

  it('warns when the gateway has no credential', async () => {
    apiLatencyMock.series.mockResolvedValue(
      jsonResponse(series([], { hasCredential: false, credentialSource: null })),
    );

    renderPanel();

    expect(await screen.findByText(enCommon.apiSpeed.noCredential)).toBeTruthy();
    // The target line says the source is "none" rather than printing an empty value.
    await waitFor(() => {
      expect(document.body.textContent).toContain(`credential: ${enCommon.apiSpeed.noCredentialShort}`);
    });
  });

  it('the Ping button asks the server for a streaming ping', async () => {
    apiLatencyMock.series.mockResolvedValue(jsonResponse(series([])));

    renderPanel();

    const ping = await screen.findByRole('button', { name: new RegExp(enCommon.apiSpeed.probePing) });
    fireEvent.click(ping);

    await waitFor(() => expect(apiLatencyMock.probe).toHaveBeenCalledWith({ mode: 'ping', stream: true }));
    // The probe result is followed by a re-read, so the store — not this tab — decides
    // what the chart shows once two tabs have probed.
    await waitFor(() => expect(apiLatencyMock.series).toHaveBeenCalledTimes(2));
  });

  it('the auto-probe toggle reports its own on/off state', async () => {
    apiLatencyMock.series.mockResolvedValue(jsonResponse(series([])));

    renderPanel();

    const auto = await screen.findByRole('button', { name: new RegExp(enCommon.apiSpeed.autoOff) });
    expect(auto.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(auto);

    await waitFor(() => {
      const pressed = screen.getByRole('button', { name: new RegExp(enCommon.apiSpeed.autoOn) });
      expect(pressed.getAttribute('aria-pressed')).toBe('true');
    });
  });
});
