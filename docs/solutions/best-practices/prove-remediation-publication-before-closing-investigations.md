# Prove remediation publication before closing investigations

## Problem

A correct fix can exist locally while users and agents still execute the broken version. This is especially easy in nested storage repositories: a leaf map changes, but its public repository, full-storage aggregator, product submodule pin, or running browser bundle remains stale.

Marking the investigation complete at the local-patch stage turns an implementation draft into false operational truth.

## Publication chain

For every remediation, name and verify each authoritative hop:

1. source change and focused regression;
2. leaf repository commit and merged PR;
3. parent repository or submodule pin;
4. product repository pin or release artifact;
5. runtime reload, storage sync, deployment, or human install;
6. independent live postcondition against the final loaded artifact.

Record immutable commit IDs for the repository hops and a runtime-observable marker for the loaded artifact. A dirty working tree, staged index, open PR, packaged but uninstalled zip, or locally built binary satisfies none of the later hops.

## Verification design

Use two different authorities when the mutation and the durable effect differ. For Trello card archive:

- the open card's archive banner proves the requested card entered archived state;
- a board projection proving exact-title absence establishes that it left the active list;
- `safe_to_claim:false` makes the second proof mandatory even when the first succeeds.

## Closure gate

Only move an investigation to Done when every required publication hop is green. If a human-only install remains, move the investigation to Blocked and link the human delivery card; do not call the remediation complete.
