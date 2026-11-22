"""A narrow smoke test: is the RESOLUTION LAYER consumable from Python?

Scope, stated first because the previous version overclaimed. This exercises
exactly two of the corpus's ten operations -- `resolve` and `preflight` -- and
18 of 35 target vectors. It does NOT cover request-digest goldens, authority
keys, receipt variants or transitions, concurrent admission, reconstruction,
redaction, fingerprinting, catalog formatting, or cross-projection parity.

The earlier name and comments generalised this to "the contract is consumable
from a second language". An independent host implementation supplied the discriminator rather than the
objection: before its independent Python host was corrected, all 14 shared
request-digest goldens disagreed with its digest -- while this gate reported
"no mismatches" and stayed green. A gate whose name covers ground it never
walks is worse than no gate, because it answers a question nobody asked and
looks like it answered the one they did.

What it does prove: the resolution layer's precedence, layer ordering and
reason vocabulary can be reconstructed by reading
`docs/capability-resolution-contract.md` and the schemas rather than the
JavaScript. That is worth having -- the Snowflake-side Python backend
depends on that layer being reconstructible -- but it is one layer, not the
contract.

Digest, receipt and store conformance are proven by the Snowflake-side Python
host, which is the production Python boundary.
This is deliberately not a second Python host; that labour is already divided.

Run: python3 contracts/capability-resolution/conformance/python_resolver_contract_smoke.py
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
CORPUS = ROOT / "contracts/capability-resolution/host-resolution.vectors.json"

# Exactly the three states the spec defines. Anything else is not a state.
PREFLIGHT_STATES = {"durable_mutation_store_ready", "setup_required", "read_only_ready"}
KNOWN_HOSTS = {"extension", "embed", "bookmarklet"}

# Named so the output cannot imply coverage it does not have.
SUPPORTED_OPERATIONS = ("resolve", "preflight")

MINIMUM_SCHEMA_KEYS = ("minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties")
MAXIMUM_SCHEMA_KEYS = ("maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties")
EXACT_SCHEMA_KEYS = (
    "pattern", "format", "multipleOf", "uniqueItems", "$ref",
    "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
)
ANNOTATION_SCHEMA_KEYS = (
    "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
)
HANDLED_SCHEMA_KEYS = {
    "type", "enum", "const", "properties", "required", "additionalProperties", "items",
    *MINIMUM_SCHEMA_KEYS, *MAXIMUM_SCHEMA_KEYS, *EXACT_SCHEMA_KEYS, *ANNOTATION_SCHEMA_KEYS,
}
DESCRIPTOR_AUTHORITIES = {"same_as_primitive", "additional_policy"}
DESCRIPTOR_EFFECTS = {"same_as_primitive", "read", "mutation"}


def json_equal(left, right):
    """JSON equality: booleans are not numbers and object order is irrelevant."""
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, (int, float)) or isinstance(right, (int, float)):
        return (
            isinstance(left, (int, float)) and not isinstance(left, bool)
            and isinstance(right, (int, float)) and not isinstance(right, bool)
            and left == right
        )
    if isinstance(left, list) or isinstance(right, list):
        return (
            isinstance(left, list) and isinstance(right, list)
            and len(left) == len(right)
            and all(json_equal(a, b) for a, b in zip(left, right))
        )
    if isinstance(left, dict) or isinstance(right, dict):
        return (
            isinstance(left, dict) and isinstance(right, dict)
            and set(left) == set(right)
            and all(json_equal(left[key], right[key]) for key in left)
        )
    return type(left) is type(right) and left == right


def json_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def schema_narrows(base, candidate):
    if json_equal(base, candidate):
        return True
    if not isinstance(base, dict) or not isinstance(candidate, dict):
        return False
    if (set(base) | set(candidate)) - HANDLED_SCHEMA_KEYS:
        return False
    if "type" in base and not json_equal(base["type"], candidate.get("type")):
        return False
    if "enum" in base:
        values = candidate.get("enum")
        if not isinstance(values, list) or not values or any(
            not any(json_equal(value, allowed) for allowed in base["enum"])
            for value in values
        ):
            return False
    if "const" in base and not json_equal(base["const"], candidate.get("const")):
        return False
    for key in MINIMUM_SCHEMA_KEYS:
        if key in base and (not json_number(candidate.get(key)) or candidate[key] < base[key]):
            return False
    for key in MAXIMUM_SCHEMA_KEYS:
        if key in base and (not json_number(candidate.get(key)) or candidate[key] > base[key]):
            return False
    for key in EXACT_SCHEMA_KEYS:
        if key in base and not json_equal(base[key], candidate.get(key)):
            return False
    if not set(base.get("required", ())).issubset(candidate.get("required", ())):
        return False
    base_properties = base.get("properties", {})
    candidate_properties = candidate.get("properties", {})
    if any(name not in base_properties or not schema_narrows(base_properties[name], value)
           for name, value in candidate_properties.items()):
        return False
    if any(name not in candidate_properties for name in base.get("required", ())):
        return False
    if base.get("additionalProperties") is False and candidate.get("additionalProperties") is not False:
        return False
    if isinstance(base.get("additionalProperties"), dict) and not schema_narrows(
        base["additionalProperties"], candidate.get("additionalProperties")
    ):
        return False
    if "items" in base and not schema_narrows(base["items"], candidate.get("items")):
        return False
    return True


def effective_descriptor(entry, registration, primitive):
    fallback = {
        "summary": entry.get("summary", ""),
        "input_schema": entry.get("input_schema", {
            "type": "object", "properties": {}, "additionalProperties": False
        }),
        "source": "dictionary",
        "provider_extensions": {},
    }
    if "output_schema" in entry:
        fallback["output_schema"] = entry["output_schema"]
    descriptors = (registration or {}).get("descriptors") or {}
    if primitive not in descriptors:
        return fallback
    overlay = descriptors[primitive]
    if not isinstance(overlay, dict):
        raise ValueError("invalid_provider_descriptor")
    schema = overlay.get("input_schema", fallback["input_schema"])
    canonical_properties = fallback["input_schema"].get("properties", {})
    provider_properties = schema.get("properties", {})
    extensions = ((overlay.get("extensions") or {}).get("input") or {})
    for name, value in provider_properties.items():
        if name in canonical_properties:
            continue
        elif (
            (extensions.get(name) or {}).get("authority") not in DESCRIPTOR_AUTHORITIES
            or (extensions.get(name) or {}).get("effect") not in DESCRIPTOR_EFFECTS
        ):
            raise ValueError("undeclared_provider_extension")
    for name in extensions:
        if name not in provider_properties or name in canonical_properties:
            raise ValueError("invalid_provider_extension")
    canonical_with_extensions = json.loads(json.dumps(fallback["input_schema"]))
    canonical_with_extensions.setdefault("properties", {}).update({
        name: value for name, value in provider_properties.items()
        if name not in canonical_properties
    })
    if not schema_narrows(canonical_with_extensions, schema):
        raise ValueError("incompatible_provider_descriptor")
    if "output_schema" in overlay and (
        "output_schema" not in fallback
        or not json_equal(overlay["output_schema"], fallback["output_schema"])
    ):
        raise ValueError("incompatible_provider_descriptor")
    effective = {
        "summary": overlay.get("summary", fallback["summary"]),
        "input_schema": schema,
        "source": "provider_registration",
        "provider_extensions": extensions,
    }
    if "output_schema" in fallback:
        effective["output_schema"] = fallback["output_schema"]
    return effective


def resolve(dictionary, host_state, primitive):
    """Resolve one primitive, following the contract's layer precedence."""
    primitives = dictionary.get("primitives", [])
    entry = next((p for p in primitives if p["name"] == primitive), None)
    namespace = primitive.split(".")[0] if "." in primitive else primitive
    state = host_state or {}
    descriptor = effective_descriptor(entry, None, primitive) if entry else None

    def fail(reason, layer, remediation):
        return {"support": "unsupported", "reason": reason,
                "decided_by": layer, "remediation": remediation,
                "descriptor": descriptor}

    # Layer 1: the dictionary defines vocabulary; it never grants.
    if entry is None:
        return fail("primitive_not_found", "dictionary", "fix_request")
    if state.get("host") not in KNOWN_HOSTS:
        return fail("host_unknown", "host_state", "fix_request")

    # Layer 3: is a provider active for this namespace at all?
    namespace_state = (state.get("namespaces") or {}).get(namespace)
    if not namespace_state:
        return fail("namespace_unavailable", "host_state", "activate_provider")

    provider = namespace_state.get("provider") or namespace_state.get("selected")
    if not provider and len(namespace_state.get("candidates") or []) > 1:
        # Determinism is not consent.
        return fail("provider_conflict", "host_state", "fix_request")
    if not provider:
        return fail("namespace_unavailable", "host_state", "activate_provider")

    # Layer 2: support ORIGINATES at provider registration. Membership must be
    # an actual list -- a bare string has `in` semantics too, and would match
    # by substring.
    registration = (namespace_state.get("registrations") or {}).get(provider)
    implemented = (registration or {}).get("implements")
    registers = (
        (registration or {}).get("implements_namespace") is True
        or (isinstance(implemented, list) and primitive in implemented)
    )
    if not registers:
        return fail("capability_unavailable", "provider_registration", "none")

    descriptor = effective_descriptor(entry, registration, primitive)

    if namespace_state.get("health") and namespace_state["health"] != "available":
        return fail("provider_unavailable", "host_state", "retry_later")

    # A document declaring `effect` anywhere must declare it everywhere.
    declares_effect = any("effect" in p for p in primitives)
    if declares_effect and "effect" not in entry:
        return fail("capability_unavailable", "dictionary", "fix_request")

    # Rung 1 of the evidence ladder: transport gates every primitive.
    if "projection" in state and state.get("transport_status") != "supported":
        return fail("capability_unavailable", "host_state", "none")

    # Rung 2: durable receipt custody narrows mutations.
    if entry.get("effect") == "mutation":
        preflight = state.get("preflight")
        if preflight not in PREFLIGHT_STATES:
            return fail("durable_store_unavailable", "host_state", "provision_receipt_store")
        if preflight == "setup_required":
            return fail("durable_store_unavailable", "host_state", "provision_receipt_store")
        if preflight == "read_only_ready":
            return fail("capability_unavailable", "host_state", "none")

    # Layer 4: compatibility overrides narrow only when explicitly selected.
    override = None
    if state.get("compatibility_profile") == "dictionary_adapters":
        override = (entry.get("adapters") or {}).get(state["host"])
    if override and override.get("support") == "unsupported":
        return fail(override.get("reason") or "capability_unavailable",
                    "compatibility_override", "none")

    return {"support": "supported", "reason": None,
            "decided_by": "provider_registration", "remediation": "none",
            "descriptor": descriptor}


def main():
    corpus = json.loads(CORPUS.read_text())
    checked = 0
    mismatches = []

    for vector in corpus["vectors"]:
        if vector.get("expectation") != "target":
            continue
        if vector.get("operation") not in ("resolve", "preflight"):
            continue
        inputs = vector["input"] if isinstance(vector["input"], list) else [vector["input"]]
        expects = vector["expect"] if isinstance(vector["expect"], list) else [vector["expect"]]

        for index, given in enumerate(inputs):
            if not isinstance(given, dict) or "primitive" not in given:
                continue
            dictionary = given.get("dictionary_inline")
            if not dictionary:
                continue
            expected = expects[index] if index < len(expects) else expects[0]
            try:
                got = resolve(dictionary, given.get("host_state"), given["primitive"])
            except ValueError as error:
                if expected.get("contract_error") == str(error):
                    checked += 1
                    continue
                mismatches.append(
                    f"{vector['id']}[{index}].contract_error: "
                    f"python got {str(error)!r}, corpus expects {expected.get('contract_error')!r}"
                )
                checked += 1
                continue
            if "contract_error" in expected:
                mismatches.append(
                    f"{vector['id']}[{index}].contract_error: "
                    f"python got no error, corpus expects {expected['contract_error']!r}"
                )
            for field in ("support", "reason", "remediation"):
                if field in expected and expected[field] != got.get(field):
                    mismatches.append(
                        f"{vector['id']}[{index}].{field}: "
                        f"python got {got.get(field)!r}, corpus expects {expected[field]!r}"
                    )
            if "descriptor" in expected and expected["descriptor"] != got.get("descriptor"):
                mismatches.append(
                    f"{vector['id']}[{index}].descriptor: "
                    f"python got {got.get('descriptor')!r}, corpus expects {expected['descriptor']!r}"
                )
            checked += 1

    print(f"{checked} resolve/preflight expectations checked "
          f"({SUPPORTED_OPERATIONS}) by an independent Python reading of the contract")
    if mismatches:
        print(f"{len(mismatches)} mismatches:")
        for line in mismatches:
            print("  " + line)
        return 1
    # A run that checks nothing is not a passing run.
    if checked == 0:
        print("no expectations were checked -- the corpus or this harness is wrong")
        return 1
    print("no mismatches: the RESOLUTION LAYER is consumable from Python. "
          "This gate covers no other operation -- see the module docstring.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
