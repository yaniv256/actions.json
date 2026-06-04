const REQUIRED_DICTIONARY_FIELDS = ["version", "stage", "primitives"];

const REQUIRED_PRIMITIVE_FIELDS = [
  "name",
  "version",
  "stage",
  "summary",
  "capability_class",
  "portable",
  "capabilities",
  "input_schema",
  "output_schema",
  "adapters",
  "errors",
  "conformance",
];

export function validatePrimitiveDictionary(dictionary) {
  const errors = [];

  for (const field of REQUIRED_DICTIONARY_FIELDS) {
    if (!hasOwn(dictionary, field)) {
      errors.push({ path: field, message: `Missing required dictionary field: ${field}` });
    }
  }

  if (!Array.isArray(dictionary?.primitives)) {
    errors.push({ path: "primitives", message: "Dictionary primitives must be an array" });
    return { valid: false, errors };
  }

  const seenNames = new Map();
  dictionary.primitives.forEach((primitive, index) => {
    for (const field of REQUIRED_PRIMITIVE_FIELDS) {
      if (!hasOwn(primitive, field)) {
        errors.push({
          path: `primitives[${index}].${field}`,
          message: `Missing required primitive field: ${field}`,
        });
      }
    }
    if (typeof primitive?.name === "string") {
      if (seenNames.has(primitive.name)) {
        errors.push({
          path: `primitives[${index}].name`,
          message: `Duplicate primitive name: ${primitive.name}`,
        });
      } else {
        seenNames.set(primitive.name, index);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(Object(value), key);
}
