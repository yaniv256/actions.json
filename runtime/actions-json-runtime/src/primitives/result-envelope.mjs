export function primitiveSuccess({ primitive, adapter, value }) {
  return {
    ok: true,
    primitive,
    adapter,
    value,
  };
}

export function primitiveError({
  primitive,
  adapter,
  code,
  message,
  recoverable = true,
  evidence = {},
}) {
  return {
    ok: false,
    primitive,
    adapter,
    error: {
      code,
      message,
      recoverable,
      evidence,
    },
  };
}
