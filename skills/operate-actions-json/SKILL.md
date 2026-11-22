---
name: operate-actions-json
description: Use when operating websites through the actions.json CLI, including discovery, reads, mutations, pairing, profiles, targets, leases, recovery, diagnostics, and safe scripting. The CLI is primary; MCP is compatibility only.
---

# Operate actions.json

Use `actions-json` as the canonical command. Use `aj` only when installation
reported that the alias was safe to create. The program is non-interactive:
JSON goes in on stdin, one JSON result comes out on stdout, and normal operation
does not write prose to stderr. Never paste secrets into argv.

## Install

Download `install-actions-json.sh` from the public repository on Linux/macOS or
`install-actions-json.ps1` on Windows, inspect it, and pass the desired release
version explicitly:

```sh
./install-actions-json.sh --version <release-version>
```

```powershell
.\install-actions-json.ps1 -Version <release-version>
```

The installer verifies `release-manifest.json` with
`release-manifest.sig` and the embedded trusted key, selects the unique `cli`
asset for the platform/architecture, verifies its byte count and SHA-256, and
only then activates it. It refuses a lower release counter unless explicit
recovery was requested and refuses a version that conflicts with an upward
discovered `.actions-json-version` project pin. Linux/macOS install to
`~/.local/bin` by default; Windows installs under
`%LOCALAPPDATA%\ActionsJson`. The installer creates `aj` only if that name is
unused. Native archives are `actions-json-<version>-<slug>.tar.gz`; the
similarly named `actions-json-mcp-...` archives exist for npm/MCP compatibility
and are not the canonical CLI installer asset.

## First run

1. Run `actions-json doctor` and read the structured result.
2. Pairing uses one shared secret, which may be a passphrase the human chose
   when the installer asked (at least 8 characters). If it was generated
   instead, run `actions-json pair inspect` (redacted by default). Use
   `--reveal-secret` only when the human is ready to paste it into the
   extension's Bridge pairing field; do not log or repeat it. Never ask the
   human to say a passphrase aloud or paste it into chat.
3. In the extension, set the bridge socket, enter the pairing secret, and take
   control of the intended ordinary website tab. Extension settings pages can
   configure the connection but are not operable site targets.
4. Run `actions-json status`, then `actions-json target list`. Treat a runtime as
   usable only when the returned status and target inventory say it is connected.

Pairing is durable per OS user. Inspect it with `actions-json pair inspect`,
replace it with `pair rotate`, and remove it with `pair revoke`. Rotation or
revocation terminates authority derived from the old secret.

## Discover before calling

```sh
actions-json list --target-id "$target_id"
actions-json describe trello.card.create --target-id "$target_id"
```

Do not invent operation names or arguments. `list` returns the catalog for the
selected target and `describe` returns one operation's current contract. Catalog
and target revisions in results are provenance, not decoration: preserve them in
logs and use `--catalog-revision` when stale discovery would make a mutation unsafe.

## Call an operation

The shortest form names the operation and reads its argument object from stdin:

```sh
printf '%s\n' '{"list_name":"Next","title":"Investigate flaky upload"}' |
  actions-json trello.card.create \
    --profile "$profile" --profile-token "$profile_token" \
    --target-id "$target_id"
```

Bare `actions-json` and `actions-json run` accept the full versioned envelope:

```json
{
  "protocol_version": 1,
  "operation": "trello.board.visible_cards_by_list.read",
  "arguments": {},
  "request_id": "board-read-01",
  "profile": { "name": "agent-a", "token": "<from profile create>" },
  "target": { "target_id": "<from target list>" },
  "expected_catalog_revision": "<optional revision>",
  "timeout_ms": 30000,
  "output": { "mode": "auto", "max_inline_bytes": 65536 }
}
```

Never put a profile token, pairing secret, OpenAI key, or operation body in a
command-line argument. Use stdin or a literal file redirected to stdin.

## Compose streams

`actions-json stream` consumes NDJSON and emits exactly one result per nonblank
input line, in order. A malformed line produces its own error and does not stop
later lines. A final valid line does not need a trailing newline. The process
exit code summarizes the worst outcome, so inspect every output row as well as
the exit code.

For large output use the envelope's `output.mode`:

- `inline` requires the result inline and fails if it cannot fit.
- `file` requires an explicit path and returns metadata rather than printing the
  payload through the agent context.
- `auto` keeps small results inline and spills larger results to a file.

Treat a spill path as a capability. Read only what the task needs and retain or
delete it according to the returned retention metadata.

## Profiles and targets

Profiles are cooperative caller identities, not security boundaries. OS-user
separation remains the security boundary.

```sh
actions-json profile create --name agent-a --label 'Agent A coding agent'
actions-json profile inspect --name agent-a --token "$profile_token"
actions-json profile rotate --name agent-a --token "$profile_token"
actions-json profile delete --name agent-a --token "$profile_token"

actions-json target list
actions-json target set --profile agent-a --profile-token "$profile_token" --target-id "$target_id"
actions-json target get --profile agent-a --profile-token "$profile_token"
```

Prefer an explicit `--target-id` on scripts. A profile-scoped selected target is
a convenience, not a daemon-global active tab. Two profiles may deliberately
share one target, while their selections and mutation attribution remain distinct.
Runtime IDs, URL filters, target generations, and catalog revisions may further
constrain routing; never reuse a remembered browser-local tab number by itself.

## Concurrent mutation and leases

Mutations on a target are serialized and return mutation revision/interference
metadata. There is no mandatory read-before-write gate: that would wedge ordinary
scripts. If another profile changed the target, re-read and reconsider the next
mutation rather than assuming the old page state.

For a short multi-step critical section, acquire a target lease:

```sh
actions-json lease acquire --profile agent-a --profile-token "$profile_token" \
  --target-id "$target_id" --duration-ms 60000
```

Pass the returned lease token as `--lease-token` on covered mutations, then
release it with `lease release`. A competing mutation fails quickly with a
structured refusal; it must not wait, interleave, or be blindly retried. Leases
are bounded and renewable, not indefinite locks.

## Outcomes and recovery

Every result has `protocol_version`, `ok`, `outcome`, `status`, `request_id`, and
`operation_id` fields. Stable exit codes are:

| Exit | Outcome |
|---:|---|
| 0 | success |
| 2 | invalid input |
| 3 | unavailable |
| 4 | refused |
| 5 | failed |
| 6 | indeterminate |
| 7 | transport failure |

An indeterminate mutation may have committed. Do not retry it. Read the website
through an independent projection, and query durable operation state:

```sh
actions-json operation status --operation-id "$operation_id"
```

Retry only after independent evidence proves the mutation did not commit. A
successful write result is also not proof: verify every mutation through a
separate model/projection read.

## Diagnostics, updates, and compatibility

- `actions-json status` reports resident and connection state.
- `actions-json doctor` checks installation, local state, resident, and runtime
  prerequisites without changing website state.
- `actions-json logs` returns a bounded, redacted audit view. Use operation IDs
  to correlate a call and confirm its caller adapter.
- `actions-json shutdown` ends this OS user's resident cleanly.
- `actions-json update check` reports the installed version, any staged
  candidate version, whether its executable is ready, the update directory,
  and the nearest `.actions-json-version` project pin. It does not fetch or
  mutate anything.
- `actions-json update apply` consumes a candidate already verified and staged
  by the POSIX installer. It creates a copy-on-write candidate state store,
  stops the resident, opens a U3 fence over executable and store, proves the
  candidate's exact `version`, starts the candidate resident, and commits only
  after readiness. Failure rolls the fenced files back and returns a structured
  unavailable outcome; absence returns `verified_update_absent`.
- `actions-json update recover` uses the same fenced activation path for an
  explicitly staged verified candidate. At distribution level, installer
  `--recover`/`-Recover` additionally permits an intentional release-counter
  downgrade; ordinary install refuses one. Recovery is explicit and does not
  weaken signature, asset identity, byte-count, digest, or project-pin checks.

The update commands do not download arbitrary bytes. Use the signed platform
installer to obtain and stage a release. Never manufacture files in the update
directory or treat a staged candidate as active before `update apply` succeeds.

The resident is per OS user and starts on demand. Clients perform an exact
protocol/version handshake; a mismatched client must fail clearly instead of
driving an unknown resident. The MCP adapter remains available for hosts that
need MCP, but it routes through the same resident contracts. New automation and
skills should teach the CLI first because it installs without editing an agent's
MCP configuration, does not require an agent restart, and composes with ordinary
shell tools.
