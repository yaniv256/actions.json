# Store preflight specification

Normative. A host that needs a durable receipt store must determine, before
advertising anything, whether it actually has one — and must reflect the answer
in the **resolved catalog**, not in a late refusal.

## 1. Why this is contract rather than deployment

A mutation primitive advertised without a durable store is the failure this
whole contract exists to prevent, one layer down. The agent is told it may
write; the write executes; a rerun destroys the host; the receipt is gone; the
next delivery writes again. Every individual component behaves as documented.

Provisioning can genuinely be unavailable. Snowflake's 2026_02 behavior bundle
splits out a separate `CREATE HYBRID TABLE` privilege, so a role that can create
ordinary tables may be unable to provision the reference store. That is a
normal, expected state — not misconfiguration, and not the user's error.

## 2. The three states

Exactly three. A host reports one of them; there is no fourth, and no
"probably fine".

### `durable_mutation_store_ready`

The receipt table exists and the app owner can perform the required atomic
operations — reserve-if-absent, compare-and-set to terminal. Mutation
primitives resolve normally.

**Verified by executing the operations, not by reading a privilege grant.** A
grant that looks sufficient and an operation that succeeds are different facts,
and only the second one is the property that matters.

### `setup_required`

The store is absent and the host can say exactly what would create it. The host
returns a **copyable bootstrap packet** — the SQL and the required privilege or
ownership — and **attempts no mutation**.

It does not escalate to an administrator on the user's behalf. If the role
already owns the target schema, ownership remains sufficient despite the
privilege split, so the packet is often runnable by the person reading it.

### `read_only_ready`

No durable store, and none can be provisioned by this role right now.

**Mutation primitives are absent from the resolved catalog.** Not advertised
and refused late: absent. A catalog that lists a capability the host cannot
honour is the defect, and moving the refusal from advertisement to execution
does not fix it — it only moves the moment the agent discovers it, past the
point where it has already told the user what it is about to do.

Read providers still resolve normally under their own policy. A read-only
deployment is a legitimate deployment, not a degraded one.

## 3. Resolution consequence

Preflight state is an input to resolution, not an annotation beside it.

| state | mutation primitives |
|---|---|
| `durable_mutation_store_ready` | resolve normally |
| `setup_required` | `unsupported` / `namespace_unavailable`, remediation `activate_provider` |
| `read_only_ready` | `unsupported` / `capability_unavailable`, remediation `none` |

`setup_required` and `read_only_ready` are deliberately different reasons: the
first is fixable by the person reading it, and telling them `none` would hide a
one-command remedy. The second is not, and offering `activate_provider` would
send them looking for a setting that does not exist.

## 4. What the host must not do

- Advertise a mutation primitive it cannot durably record.
- Probe by attempting a write. A preflight that mutates to discover whether it
  may mutate has already done the thing it was checking permission for.
- Treat an absent privilege as an error state, or auto-request escalation.
- Report `durable_mutation_store_ready` from a grant lookup alone.

## 5. Projection support is evidence, not intent

A projection is `supported` only when its platform is **proven** to provide
what the lifecycle needs. Until then it is `proposed`, and a proposed
projection resolves **no mutation primitives** — reads still work, so it is
usable rather than dead.

`streamlit-warehouse-v1` is `proposed`. Snowflake's limitations page documents
`st.components.v1.html` and `st.components.v1.iframe` for the warehouse
runtime; both are static. It does not document `declare_component` or
`setComponentValue`, which the bidirectional request/receipt lifecycle
requires. The August 2025 release note says only that custom components are
supported when they make no external calls — it names neither API.

**A static iframe succeeding is not evidence the bidirectional path works.**
That inference is the shape this whole contract exists to remove: a component
loads, the page renders, everything looks correct, and the return channel the
protocol depends on was never exercised.

### The acceptance gate

Warehouse becomes `supported` when this passes in a real target account, and
not before:

1. package locally served component assets;
2. register with `declare_component(path=...)`;
3. receive the initial render envelope;
4. send one frontend value back;
5. observe a rerun and reconstruction;
6. recover the same continuation and settled receipt from the durable store;
7. prove exactly one handler invocation.

Steps 4 and 7 are the ones a static-iframe implementation cannot fake.
