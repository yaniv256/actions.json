# Keep primitive metadata aligned with trusted text behavior

## Symptom

The shipped `text.type` metadata and its focused test still said trusted typing used
`Input.insertText`, even though the production path had moved to awaited, per-character
`Input.dispatchKeyEvent` calls. That left agents with a false capability description and made a
correct implementation fail its own test.

## Durable fix

Treat a primitive mechanism change as one capability-lifecycle transaction. Update the canonical
manifest, every generated dictionary, source comments, and the behavioral regression contract;
then package, inspect the zip, release, and re-read the live catalog. Tests should assert the
behavioral boundary (each character is dispatched and awaited, with no stale mechanism) rather
than pinning an obsolete implementation name.

## Prevention

For every trusted input change, search all shipped metadata copies and run the package/live
catalog checks before closure. Historical investigation notes may retain old mechanism names,
but current agent-facing metadata may not.
