# Built-in dynamic-dashboard templates

Templates in the format `kiro_crew.dashboard_templates.manifest` defines: one
directory per template, holding `manifest.json` and `template.html`. The registry
discovers this directory; `load_template` is the only gate, and a user template passes
the same one.

This directory is empty of pages on purpose. This change carries the contract, the
folds, the agentic write path, the owner-only read route and the tab that hosts a page;
the built-in pages arrive in the change stacked on it, starting with the one
`kiro_crew.dashboard_templates.instance.DEFAULT_TEMPLATE_ID` names. Until then a
crewmate that adopted nothing is served the frame's own empty state, which
`default_instance` reports by answering `None` and logging the absent default.

## The two rules every page here follows

**Absent is not zero.** Each fold reports how many turns reported a measurement next to
the measurement itself: `usage.turns.credits_reported`, `usage.turns.tokens_reported`,
`usage.turns.duration_reported`, and `usage.credits_by_source.*.reported`. A total of 0
beside a reporter count of 0 means nobody said, so the page draws a dash. Printing 0
would state an amount the record never claimed. The same applies to a fold's empty
string, which is a key the fold declares and nothing has filled.

Session-wide credits gate on the SUM of `usage.credits_by_source.*.reported`, not on
`usage.turns.credits_reported`. A crewmate that only delegates has a turn-scoped
reporter count of zero beside a real total.

**A truncated list says so.** Every fold here is bounded and reports what it dropped
(`timeline.dropped`, `tools.names_omitted`, `work.omitted`). Each page draws that number
beside the list it belongs to, so a partial picture is never shown as a whole one.

## How a page gets its values

The host fills every `data-dashboard-field` element by `textContent` and sets
`window.kirocrew = {fields, agentic, seq, stale}`. A field whose type is `array` or
`object` therefore reaches its bound element as JSON, which is unreadable in a cell, so
each page overwrites that one cell with a count and draws the real thing from
`window.kirocrew.fields` in its own script. Every page renders on load and again on each
`message`, because the order of the host's first fill against the script is not the
page's to assume.

No page fetches anything: the frame's CSP blocks the network, so a chart drawn from a CDN
renders as a hole. The charts are plain elements sized in the page's own JS.

## Agentic fields

A field is agentic when the fact it carries is one no fold records -- a crewmate's own
judgment, or a reading of a system nothing here polls. The page draws the
`crewmate wrote this` tag only when the host says the field IS agentic, so a value
arriving some other way cannot borrow the label. `window.kirocrew.agentic` is a LIST of
names, so it is read with `indexOf` and not as an object property: a page that asks that
list for a property answers "nobody wrote this" on every render while looking correct in
review.

Anything with a fold has a fold. A manifest declaring a field both agentic and
fold-bound is refused, so the two sources cannot disagree about one number.

## Adding one

Add the directory with both files and check the packaging globs still cover it
(`[options.package_data]` in `setup.cfg` and the `recursive-include` lines in
`MANIFEST.in`). A template absent from the wheel leaves the loader shipped and working
while the registry discovers nothing, with every test green.

Resolve every declared `{fold, path}` against a real fold payload in its own test.
Nothing in `load_template` can tell whether a path EXISTS, so a plausible path that
resolves to nothing would otherwise ship and render a blank cell forever.
