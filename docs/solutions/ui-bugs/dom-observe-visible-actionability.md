# Separate visible geometry from clickable actionability

`dom.observe.visible` must not label every geometric center as a click target. A center is safe for
`pointer.click` only after hit testing confirms that the element receives events. Return
`visible_center` for geometry, and include `clickable_center` only for an actionable match; preserve
`receives_events`, `occluded_by`, and `visible_rect` so the caller can diagnose why a match is not
actionable. Keep this contract identical in the extension and embedded bookmarklet runtimes.
