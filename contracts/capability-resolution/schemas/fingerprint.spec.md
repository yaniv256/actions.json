# Fingerprint specification

Normative. Two implementations that resolve identically must fingerprint
identically, byte for byte, or the cross-language conformance claim is
unverifiable. The previous draft said "deterministic over authority-affecting
non-secret normalized state" and specified none of the four things that makes
reproducible.

## 1. Domain separation

Every fingerprint is prefixed with a domain string, so an installation
revision and a catalog fingerprint over coincidentally equal material cannot
collide:

| fingerprint | domain | prefix on output |
|---|---|---|
| installation revision | `actions-json/installation-revision/v1` | `rev-` |
| catalog fingerprint | `actions-json/catalog-fingerprint/v2` | `cat-` |

The domain string is the first line of the preimage, followed by `\n`.

## 2. Canonical preimage

The preimage is UTF-8 text. No JSON serializer is involved — serializer
differences between languages (key order, number formatting, escaping) are
exactly the drift this avoids.

### 2.1 Installation revision

One record per active namespace, sorted by namespace name using **byte-wise
ordering of the UTF-8 encoding** (not locale collation):

```
<domain>\n
<namespace>\t<provider_id>\t<authority_mode>\t<implements>\n
...
```

- `<implements>` is the registered primitive subset, sorted byte-wise and
  joined with `,`. A provider registering the whole namespace emits `*`.
- A field that is absent emits the empty string; the tabs are still present, so
  field count is fixed at four.
- Records are terminated by `\n` including the last.

**Excluded from the preimage**, and this is normative rather than incidental:

- credentials, `config_ref`, and any secret-store handle;
- provider health (transient; a flapping provider must not churn the revision);
- session and call-context facts — active tab, site policy, viewport;
- `resolved_at` and any wall-clock value.

Health is excluded because a revision that changes on every health blip would
trigger catalog refreshes that carry no capability change. Health still affects
resolution; it just is not identity.

### 2.2 Catalog fingerprint

One record per resolved primitive, sorted byte-wise by primitive name:

```
<domain>\n
<primitive>\t<support>\t<reason>\t<decided_by>\t<descriptor_digest>\n
...
```

`<reason>` is the empty string when null. `decided_by` is included because two
catalogs with identical support that reached it through different layers are
not the same catalog — which is the same reason the trace exists.

`descriptor_digest` is the lowercase SHA-256 of the canonical effective
descriptor JSON (object keys sorted at every depth, compact JSON, UTF-8). It
is empty when no descriptor exists. Descriptor identity is load-bearing: two
catalogs advertising different executable schemas are not the same catalog.

## 3. Algorithm

**SHA-256** over the UTF-8 bytes of the preimage. Output is the lowercase hex
of the **first 16 bytes** (32 hex characters), prefixed per §1.

SHA-256 rather than a short non-cryptographic hash: these values are compared
across implementations and across a trust boundary, and a 32-bit FNV variant
collides at a few tens of thousands of inputs. Truncation to 16 bytes keeps the
value legible in a trace while leaving collision resistance far beyond the
number of distinct catalogs any installation will produce.

```
rev-3f2a9c1b8e4d5a6f0b7c2d1e9a8f4b3c
cat-a1b2c3d4e5f60718293a4b5c6d7e8f90
```

## 4. Golden vectors

`golden-fingerprints.json` carries preimage/output pairs. An implementation
that produces a different digest for a listed preimage is non-conforming,
regardless of whether its own tests pass — a fingerprint that is
self-consistent but disagrees across languages is precisely the failure this
specification exists to catch.

The goldens include the empty case (no namespaces, no primitives), because a
resolver that returns a constant for empty input would otherwise pass every
non-empty vector.
