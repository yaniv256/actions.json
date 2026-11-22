"""Language-neutral provider descriptor validation for trusted Python hosts."""

from __future__ import annotations

import copy
import math
import re
from collections.abc import Mapping
from typing import Any

MINIMUM_KEYS = ("minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties")
MAXIMUM_KEYS = ("maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties")
EXACT_KEYS = (
    "pattern", "format", "multipleOf", "uniqueItems", "$ref",
    "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
)
ANNOTATION_KEYS = (
    "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
)
HANDLED_KEYS = {
    "type", "enum", "const", "properties", "required", "additionalProperties", "items",
    *MINIMUM_KEYS, *MAXIMUM_KEYS, *EXACT_KEYS, *ANNOTATION_KEYS,
}
AUTHORITIES = {"same_as_primitive", "additional_policy"}
EFFECTS = {"same_as_primitive", "read", "mutation"}


class ProviderDescriptorError(ValueError):
    """A stable, language-neutral descriptor contract error."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _json_equal(left: Any, right: Any) -> bool:
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
            and all(_json_equal(a, b) for a, b in zip(left, right))
        )
    if isinstance(left, Mapping) or isinstance(right, Mapping):
        return (
            isinstance(left, Mapping) and isinstance(right, Mapping)
            and set(left) == set(right)
            and all(_json_equal(left[key], right[key]) for key in left)
        )
    return type(left) is type(right) and left == right


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _clone(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _clone(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clone(child) for child in value]
    return copy.deepcopy(value)


def schema_narrows(base: Any, candidate: Any) -> bool:
    if _json_equal(base, candidate):
        return True
    if not isinstance(base, Mapping) or not isinstance(candidate, Mapping):
        return False
    if (set(base) | set(candidate)) - HANDLED_KEYS:
        return False
    if "type" in base and not _json_equal(base["type"], candidate.get("type")):
        return False
    if "enum" in base:
        values = candidate.get("enum")
        if not isinstance(values, list) or not values or any(
            not any(_json_equal(value, allowed) for allowed in base["enum"])
            for value in values
        ):
            return False
    if "const" in base and not _json_equal(base["const"], candidate.get("const")):
        return False
    for key in MINIMUM_KEYS:
        if key in base and (not _number(candidate.get(key)) or candidate[key] < base[key]):
            return False
    for key in MAXIMUM_KEYS:
        if key in base and (not _number(candidate.get(key)) or candidate[key] > base[key]):
            return False
    for key in EXACT_KEYS:
        if key in base and not _json_equal(base[key], candidate.get(key)):
            return False
    if not set(base.get("required", ())).issubset(candidate.get("required", ())):
        return False
    base_properties = base.get("properties", {})
    candidate_properties = candidate.get("properties", {})
    if not isinstance(base_properties, Mapping) or not isinstance(candidate_properties, Mapping):
        return False
    if any(
        name not in base_properties or not schema_narrows(base_properties[name], value)
        for name, value in candidate_properties.items()
    ):
        return False
    if any(name not in candidate_properties for name in base.get("required", ())):
        return False
    if base.get("additionalProperties") is False and candidate.get("additionalProperties") is not False:
        return False
    if isinstance(base.get("additionalProperties"), Mapping) and not schema_narrows(
        base["additionalProperties"], candidate.get("additionalProperties")
    ):
        return False
    if "items" in base and not schema_narrows(base["items"], candidate.get("items")):
        return False
    return True


def effective_descriptor(
    entry: Mapping[str, Any], registration: Mapping[str, Any], primitive: str
) -> dict[str, Any]:
    canonical_schema = entry.get(
        "input_schema", {"type": "object"}
    )
    fallback = {
        "summary": entry.get("summary", ""),
        "input_schema": canonical_schema,
        "source": "dictionary",
        "provider_extensions": {},
    }
    if "output_schema" in entry:
        fallback["output_schema"] = entry["output_schema"]
    descriptors = registration.get("descriptors", {})
    if primitive not in descriptors:
        return _clone(fallback)
    overlay = descriptors[primitive]
    if not isinstance(overlay, Mapping):
        raise ProviderDescriptorError("invalid_provider_descriptor")
    schema = overlay.get("input_schema", canonical_schema)
    if not isinstance(schema, Mapping) or schema.get("type") != "object":
        raise ProviderDescriptorError("invalid_provider_descriptor")
    canonical_properties = canonical_schema.get("properties", {})
    provider_properties = schema.get("properties", {})
    extensions = overlay.get("extensions", {}).get("input", {})
    if not isinstance(provider_properties, Mapping) or not isinstance(extensions, Mapping):
        raise ProviderDescriptorError("invalid_provider_descriptor")
    for name in provider_properties:
        if name in canonical_properties:
            continue
        declaration = extensions.get(name)
        if (
            not isinstance(declaration, Mapping)
            or declaration.get("authority") not in AUTHORITIES
            or declaration.get("effect") not in EFFECTS
        ):
            raise ProviderDescriptorError("undeclared_provider_extension")
    for name in extensions:
        if name not in provider_properties or name in canonical_properties:
            raise ProviderDescriptorError("invalid_provider_extension")
    canonical_with_extensions = _clone(canonical_schema)
    canonical_with_extensions.setdefault("properties", {}).update(
        {name: value for name, value in provider_properties.items() if name not in canonical_properties}
    )
    if not schema_narrows(canonical_with_extensions, schema):
        raise ProviderDescriptorError("incompatible_provider_descriptor")
    if "output_schema" in overlay and (
        "output_schema" not in entry or not _json_equal(overlay["output_schema"], entry["output_schema"])
    ):
        raise ProviderDescriptorError("incompatible_provider_descriptor")
    result = {
        "summary": overlay.get("summary", fallback["summary"]),
        "input_schema": _clone(schema),
        "source": "provider_registration",
        "provider_extensions": _clone(extensions),
    }
    if "output_schema" in entry:
        result["output_schema"] = _clone(entry["output_schema"])
    return result


def validate_instance(schema: Mapping[str, Any], value: Any) -> bool:
    """Validate the executable JSON-Schema subset accepted by this contract.

    Descriptor compatibility fails closed on keywords outside the same subset,
    so this is also the complete runtime authority check for effective inputs.
    """

    if not isinstance(schema, Mapping) or set(schema) - HANDLED_KEYS:
        return False
    expected_type = schema.get("type")
    type_checks = {
        "object": lambda item: isinstance(item, Mapping),
        "array": lambda item: isinstance(item, list),
        "string": lambda item: isinstance(item, str),
        "number": _number,
        "integer": lambda item: isinstance(item, int) and not isinstance(item, bool),
        "boolean": lambda item: isinstance(item, bool),
        "null": lambda item: item is None,
    }
    if expected_type is not None:
        allowed = expected_type if isinstance(expected_type, list) else [expected_type]
        if not allowed or any(item not in type_checks for item in allowed):
            return False
        if not any(type_checks[item](value) for item in allowed):
            return False
    if "enum" in schema and not any(_json_equal(value, item) for item in schema["enum"]):
        return False
    if "const" in schema and not _json_equal(value, schema["const"]):
        return False
    if _number(value):
        if "minimum" in schema and value < schema["minimum"]:
            return False
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            return False
        if "maximum" in schema and value > schema["maximum"]:
            return False
        if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
            return False
        if "multipleOf" in schema:
            divisor = schema["multipleOf"]
            if not _number(divisor) or divisor <= 0 or not math.isclose(value / divisor, round(value / divisor)):
                return False
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            return False
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            return False
        if "pattern" in schema:
            try:
                if re.search(schema["pattern"], value) is None:
                    return False
            except (re.error, TypeError):
                return False
        if "format" in schema and schema["format"] not in {"uri", "uri-reference"}:
            return False
        if schema.get("format") in {"uri", "uri-reference"} and any(char.isspace() for char in value):
            return False
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            return False
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            return False
        if schema.get("uniqueItems") is True and any(
            _json_equal(left, right)
            for index, left in enumerate(value)
            for right in value[index + 1 :]
        ):
            return False
        if "items" in schema and any(not validate_instance(schema["items"], item) for item in value):
            return False
    if isinstance(value, Mapping):
        if "minProperties" in schema and len(value) < schema["minProperties"]:
            return False
        if "maxProperties" in schema and len(value) > schema["maxProperties"]:
            return False
        required = schema.get("required", [])
        if not isinstance(required, list) or any(name not in value for name in required):
            return False
        properties = schema.get("properties", {})
        if not isinstance(properties, Mapping):
            return False
        additional = schema.get("additionalProperties", True)
        for name, child in value.items():
            if name in properties:
                if not validate_instance(properties[name], child):
                    return False
            elif additional is False:
                return False
            elif isinstance(additional, Mapping) and not validate_instance(additional, child):
                return False
    if "allOf" in schema and not all(validate_instance(item, value) for item in schema["allOf"]):
        return False
    if "anyOf" in schema and not any(validate_instance(item, value) for item in schema["anyOf"]):
        return False
    if "oneOf" in schema and sum(validate_instance(item, value) for item in schema["oneOf"]) != 1:
        return False
    if "not" in schema and validate_instance(schema["not"], value):
        return False
    if "if" in schema:
        branch = "then" if validate_instance(schema["if"], value) else "else"
        if branch in schema and not validate_instance(schema[branch], value):
            return False
    if "$ref" in schema:
        return False
    return True
