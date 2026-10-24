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
| `initiative-list` | `initiative list --json` | cockpit initiative view |
| `initiative-show` | `initiative show <slug> --json` | cockpit initiative view + decision queue |
| `liveness` | `liveness --json` | cockpit observation wall |
| `status` | `status --json` | cockpit / operator status reading |
| `registry-interface-session-set` | `registry interface-session set <project> <id> --json` | `quay-fleet-registry.ts` (write) |
| `registry-interface-session-clear` | `registry interface-session clear <project> --json` | `quay-fleet-registry.ts` (write) |
| `initiative-create` | `initiative create <slug> --charter <json> --json` | cockpit initiative view (write) |
| `initiative-decide` | `initiative decide <slug> … --by human --json` | cockpit decision queue (write) |

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

## Initiative and liveness contracts

`fleet-initiative-store-and-cli` added `initiative create|show|list|link|edge|decide|escalate|close`;
the cockpit's initiative view and decision queue read `show`/`list` and write `create`/`decide`.
The declarations pin:

- both edge endpoints match `quay://<project>/<type>/<id>` (`QUAY_PROJECT_SCOPED_URI`) — the
  project-less `quay://task/<id>` form the fleet itself refuses is a RED here;
- `edge.kind ∈ {blocks, contract, release}`;
- `decision.kind ∈ {fact, inference, experience, llm}`. Today's producers emit only `fact`
  (`--by human`) and `inference` (a liaison self-decision); the four-value vocabulary is what the
  decision queue is written against, so an unknown tag reds instead of silently rendering;
- a charter's `completionCriteria` / `exitConditions` accept the fleet's string-or-list spelling.

`initiative show`/`list` run against the operator's home (the real initiative when it has one; a
seeded temporary home otherwise, so the shapes are never skipped). `create`/`decide` are
`writes: true` and therefore run ONLY against a temporary home, in that order (decide addresses the
initiative create stored there).

`liveness` is the cockpit wall's read-only three-state projection (`ok` / `stale` / `unknown`, with
`null` fields meaning 「读数取不到」, never a guessed value). `initiative predict|score` had not
landed when this was written; when it does, it gets a declaration and a case here first — see the
rule above.

## The operator's fleet home is read-only to this suite

- Read-only verbs run against the configured home. They do not write it.
- The four writing contracts (`interface-session set|clear`, `initiative create|decide`) run
  against a `mkdtempSync` home seeded with a registry row for this checkout. `assertTemporaryHome`
  makes that structural: a write contract with no temp `QUAY_FLEET_HOME` throws before spawning
  anything.
- AC3's guard stamps EVERY file under the real home before and after the run. The resident fleet
  service rewrites a documented set (`RESIDENT_SERVICE_FILES`: heartbeat, snapshot, state, and its
  event/attention ledgers, …) on its own 60-second schedule; those are exempt, because asserting on
  them would make this test a timer, not a contract. Every other file must be identical, and
  `registry.json`, `initiatives.json` and `ledgers/initiative-decisions.jsonl` — the files an
  exercised verb could write — are additionally required to be untouched in the literal sense.

## Control arms (the test can actually go red)

Four in-test mutations prove the checks are not vacuous:

- Rename a required field in a **copy** of `WALL_RESOLVE_SHAPE` (`label` → `labelRenamed`); the
  real answer must fail validation and the violation path must name the field.
- Run the production handshake reader with `supportedContracts.wallUri` set to a value the fleet
  does not speak; the reading must be `incompatible` and its reason must name `wallUri`.
- Rewrite one edge's `from` (in a copy of a real `initiative show` answer) to the project-less
  `quay://task/x`; validation must red and name `$.initiative.edges[0].from`.
- Rewrite one decision's `kind` (in a copy of a real answer) to an unknown tag; validation must
  red and name `$.decisions[0].kind`.

All mutate in-test constructions only — the shipping declarations are never modified.
