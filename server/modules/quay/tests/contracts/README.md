# Cross-repository CLI contract tests (CloudCLI ↔ quay-fleet)

CloudCLI does not link against quay-fleet; it **runs the installed binary** and parses its JSON.
The two repositories are versioned and merged independently, so a reader on this side and a
producer on the other can both pass their own unit tests and still disagree the moment they meet.
That is not hypothetical: the `quay://task/<id>` vs `quay://<project>/task/<id>` project-segment
disagreement shipped on both sides before anyone noticed.

This directory closes that gap mechanically. `fleet-cli-contracts.test.ts` invokes the **real,
installed** `quay-fleet` and validates every answer against the declarations in `shapes.ts`:

| Contract | Invocation | CloudCLI consumer |
| --- | --- | --- |
| `version-handshake` | `--version --json` | `quay-fleet-locator.ts` |
| `wall-resolve` | `wall resolve quay://<project>/task/<id>#ac-2 --json` | `quay-uri-resolve.ts` (`readFleetL1`) |
| `wall-summary` | `wall summary <uri> --root <dir> --json` | `quay-uri-resolve.ts` (`readFleetL2`) |
| `registry-list` | `registry list --json` | `quay-fleet-project-id.ts`, `quay-fleet-registry.ts` |
| `registry-interface-session-get` | `registry interface-session get <project> --json` | `quay-fleet-registry.ts` |
| `status` | `status --json` | cockpit / operator status reading |
| `registry-interface-session-set` | `registry interface-session set <project> <id> --json` | `quay-fleet-registry.ts` (write) |
| `registry-interface-session-clear` | `registry interface-session clear <project> --json` | `quay-fleet-registry.ts` (write) |

## Running it

```bash
npx tsx --tsconfig server/tsconfig.json --test \
  server/modules/quay/tests/contracts/fleet-cli-contracts.test.ts
```

The suite is **fail-closed**: if no fleet binary can be located it FAILS and says why. A contract
test that skips on the machine that would have caught the break protects nothing. Hosts that
genuinely have no fleet (a bare CI image, for example) opt out explicitly:

```bash
CONTRACT_TESTS_ALLOW_MISSING_FLEET=1 npx tsx --tsconfig server/tsconfig.json --test \
  server/modules/quay/tests/contracts/fleet-cli-contracts.test.ts
# → one SKIPPED case whose reason names the missing binary and the switch
```

## Adding a consumer — the rule

**Whenever CloudCLI starts invoking a new quay-fleet verb, or starts reading a new field from an
existing one, the same change MUST add a declaration and a test case here.** A new call site
without a contract is exactly the drift this directory exists to prevent, and it will not be
caught by any other test in this repository — the other side's tests do not run here.

Concretely:

1. Add the invocation and its shape to `FLEET_CLI_CONTRACTS` in `shapes.ts`, naming the consuming
   reader in `consumer`.
2. If the verb writes the fleet home, set `writes: true`. The test then refuses to run it unless
   it was handed a temporary `QUAY_FLEET_HOME` (see `assertTemporaryHome`).
3. Keep a field CloudCLI reads **required**; keep an optional/nullable field optional/nullable.
   Undeclared fields are allowed on purpose — a fleet that only ADDS fields stays compatible.
4. Pin closed vocabularies with `values` (the fleet's trivalent readings are load-bearing:
   `wall summary` distinguishes `ok` / `absent` / `invalid`, and an interface-session pin is
   `string | null`).

The declarations are plain data, deliberately not JSON Schema: the validator is ~60 lines and the
failure message names the JSON path (`$.projects[0].root`), which is the whole point.

## The operator's fleet home is read-only to this suite

- Read-only verbs run against the configured home. They do not write it.
- The two `interface-session set|clear` verbs run against a `mkdtempSync` home seeded with a
  registry row for this checkout. `assertTemporaryHome` makes that structural: a write contract
  with no temp `QUAY_FLEET_HOME` throws before spawning anything.
- AC4's guard re-stamps the real home's `registry.json` before and after the run and reds if its
  mtime/size moved. `registry.json` is the only durable file the exercised verbs can write. The
  rest of `~/.quay-fleet/` belongs to the resident fleet service, which rewrites its heartbeat and
  ledgers on its own schedule — asserting on those would make this test flaky without making it
  safer.

## Control arms (the test can actually go red)

Two in-test mutations prove the checks are not vacuous:

- Rename a required field in a **copy** of `WALL_RESOLVE_SHAPE` (`label` → `labelRenamed`); the
  real answer must fail validation and the violation path must name the field.
- Run the production handshake reader with `supportedContracts.wallUri` set to a value the fleet
  does not speak; the reading must be `incompatible` and its reason must name `wallUri`.

Both mutate in-test constructions only — the shipping declarations are never modified.
