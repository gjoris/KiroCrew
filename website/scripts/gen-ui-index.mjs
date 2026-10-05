#!/usr/bin/env node
/**
 * Generate (or check) the find_ui location index the agent searches.
 *
 * Two outputs, because they change at different rates:
 *
 * - `../src/kiro_crew/docs/ui-index.generated.json` (COMMITTED): the generated
 *   tier (pages, tabs, Settings) and the curated tier (registered controls).
 *   It only moves when a registry, a marker, a descriptor or a catalog does.
 * - `ui-index.auto.json` (BUILD-TIME, never committed): the auto tier, every
 *   unregistered control whose one static label and one page (or only the app
 *   shell, i.e. every page) are proven from
 *   source. Any new static-label button moves it, so `npm run build` writes it
 *   into the vite output (website/dist, staged to src/kiro_crew/static/dist and
 *   shipped with the dashboard) instead of the repo.
 *
 *   node scripts/gen-ui-index.mjs                  # write the committed index
 *   node scripts/gen-ui-index.mjs --check          # fail if the committed index is stale
 *   node scripts/gen-ui-index.mjs --auto-out <f>   # also write the auto tier to <f>
 *   node scripts/gen-ui-index.mjs --report <file>  # also write a coverage report (markdown)
 *   node scripts/gen-ui-index.mjs --out <file>     # write the index to <file> instead; never the
 *                                                  # committed path (parallel area batches)
 *
 * Inputs are the registries the dashboard renders, never a parallel table: the
 * surface and extra-page data Search Everywhere uses, the Settings, Customize
 * and Developer tab lists, the committed settings extraction (`npm run gen:settings`, checked
 * against a live in-memory run of the same extraction), the router's own
 * `<Route>` table in App.tsx (every emitted route must be one it renders, not a
 * redirect), the registered locations (one file per area under
 * `src/uiLocations/areas/`, aggregated by `src/uiLocations/descriptors.ts`) with
 * their render-site markers and curated search terms (`SEARCH_TERMS` for
 * generated locations), the shared prerequisite vocabulary in
 * `src/uiLocations/conditions.ts`, the guide registry when a descriptor carries
 * a guide binding, and the 12 shipped catalogs. The pure logic is
 * `scripts/lib/ui-index.mjs`.
 *
 * `--check` regenerates in memory and byte-compares the COMMITTED index only;
 * it writes nothing (except `--auto-out`), so it is safe in CI and in
 * `npm run build`, and an unregistered button never makes it fail. The digest
 * covers the bytes of every input read (markers included, whether or not git
 * tracks them), never a clock or a git hash, so the same tree always yields
 * the same file.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AUTO_ARTIFACT_NAME,
  buildAutoArtifact,
  buildPageMap,
  buildUiIndex,
  candidateKind,
  checkSettingsExtraction,
  classifyUses,
  collectKeyMap,
  collectObjectList,
  collectRouteElementSpans,
  collectRouteTable,
  collectTabPanels,
  makeRouteLabel,
  mergeLocationAreas,
  parseSource,
  resolveSiteLabel,
  scanCandidates,
  scanImports,
  scanMarkerSource,
  serializeIndex,
  SHELL_SURFACE,
} from './lib/ui-index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const REPO = path.resolve(ROOT, '..')
const SRC = path.join(ROOT, 'src')
const OUT = path.join(REPO, 'src/kiro_crew/docs/ui-index.generated.json')

const args = process.argv.slice(2)
const CHECK = args.includes('--check')
const reportIdx = args.indexOf('--report')
const REPORT_PATH = reportIdx >= 0 ? args[reportIdx + 1] : null
const outIdx = args.indexOf('--out')
const OUT_PATH = outIdx >= 0 ? args[outIdx + 1] : null
const autoIdx = args.indexOf('--auto-out')
const AUTO_OUT = autoIdx >= 0 ? args[autoIdx + 1] : null
const valueAt = new Set([reportIdx, outIdx, autoIdx].filter((i) => i >= 0).map((i) => i + 1))
for (const [i, a] of args.entries()) {
  if (a === '--check' || a === '--report' || a === '--out' || a === '--auto-out') continue
  if (valueAt.has(i)) continue
  console.error(`gen-ui-index: unknown argument ${a}`)
  process.exit(2)
}
if (reportIdx >= 0 && !REPORT_PATH) {
  console.error('gen-ui-index: --report needs a file path')
  process.exit(2)
}
const realPath = (f) => { try { return fs.realpathSync(f) } catch { return path.resolve(f) } }
// `--auto-out <file>`: the build-time auto tier. Never the committed index,
// and never anywhere under src/kiro_crew/docs (tracked): the tier is not committed.
if (autoIdx >= 0) {
  if (!AUTO_OUT || AUTO_OUT.startsWith('--')) {
    console.error('gen-ui-index: --auto-out needs a file path')
    process.exit(2)
  }
  const docs = realPath(path.dirname(OUT))
  if (realPath(path.resolve(path.dirname(AUTO_OUT))) === docs) {
    console.error(`gen-ui-index: --auto-out must not be in ${path.relative(REPO, docs)}; the auto tier is a build artifact, never committed`)
    process.exit(2)
  }
}
// `--out <file>`: validate everything and write the index THERE, never the
// committed path, so several area batches can each check their own index
// without racing on one file. The committed index is regenerated once, last.
if (outIdx >= 0) {
  if (!OUT_PATH || OUT_PATH.startsWith('--')) {
    console.error('gen-ui-index: --out needs a file path')
    process.exit(2)
  }
  if (CHECK) {
    console.error('gen-ui-index: --out writes a scratch index; --check compares the committed one. Pick one.')
    process.exit(2)
  }
  const real = realPath
  if (real(OUT_PATH) === real(OUT)) {
    console.error(`gen-ui-index: --out must not be the committed index (${path.relative(REPO, OUT)}); run plain \`npm run gen:ui\` for that`)
    process.exit(2)
  }
}

/** Matches `DEFAULT_PRODUCT_NAME` in src/i18n/index.ts (not imported: it pulls i18next in). */
const PRODUCT_NAME = 'Kiro Crew'

const readInputs = new Map()
function read(abs) {
  const text = fs.readFileSync(abs, 'utf-8')
  readInputs.set(path.relative(REPO, abs).split(path.sep).join('/'), text)
  return text
}
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/')

async function loadTs(relPath) {
  const abs = path.join(ROOT, relPath)
  read(abs)
  const { runnerImport } = await import('vite')
  const { module } = await runnerImport(abs, { configFile: false, logLevel: 'error', root: ROOT })
  return module
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, dotted, out)
    else out[dotted] = v
  }
  return out
}

function walkSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'locales' || entry.name === 'test') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkSources(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|stories|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

const errors = []
const adapter = (relPath, opts) => {
  const abs = path.join(ROOT, relPath)
  const r = collectObjectList(read(abs), abs, relPath, opts)
  errors.push(...r.errors)
  return r.items
}
const keyMap = (relPath, name) => {
  const abs = path.join(ROOT, relPath)
  const r = collectKeyMap(read(abs), abs, relPath, name)
  errors.push(...r.errors)
  return r.items
}

const { BUILTIN_SURFACE_NAV, CAPABILITY_SUB_ITEM_NAV, capabilitySubItemNav } = await loadTs('src/surfaces/surfaceData.ts')
const { EXTRA_PAGES, EXTRA_PAGE_TITLE_KEY } = await loadTs('src/components/commandPalette/providers/pagesData.ts')
const { UI_LOCATION_AREAS, PREVIEW_FLAG_ENABLERS, SETTINGS_TAB_PREVIEW, SEARCH_TERMS, LEGACY_PAGE_CANONICAL } = await loadTs('src/uiLocations/descriptors.ts')
// The registered locations live one file per area; every file there is an
// input (digested whether or not git tracks it), and the merge refuses an id
// two areas declare or an area file the aggregator does not list.
const AREAS_DIR = path.join(SRC, 'uiLocations/areas')
const areaFiles = fs.readdirSync(AREAS_DIR).filter((n) => /\.ts$/.test(n) && !/\.(test|d)\.ts$/.test(n)).sort()
for (const f of areaFiles) read(path.join(AREAS_DIR, f))
read(path.join(SRC, 'uiLocations/types.ts'))
const merged = mergeLocationAreas(UI_LOCATION_AREAS, areaFiles.map((f) => f.replace(/\.ts$/, '')))
errors.push(...merged.errors)
const UI_LOCATIONS = merged.descriptors
const { UI_CONDITIONS, UI_REVEAL_STATES } = await loadTs('src/uiLocations/conditions.ts')
const { SUPPORTED_LANGUAGES } = await loadTs('src/i18n/languages.ts')
read(path.join(SRC, 'utils/previewFlags.ts'))

// The route table every emitted route is checked against (redirects included).
const appTsx = path.join(SRC, 'App.tsx')
const shellRoutesTsx = path.join(path.dirname(appTsx), 'shell', 'routes.tsx')
const routeTable = collectRouteTable(read(appTsx), appTsx, 'src/App.tsx', [{ text: read(shellRoutesTsx), absPath: shellRoutesTsx }])
errors.push(...routeTable.errors)

const locales = SUPPORTED_LANGUAGES.filter((l) => !l.devOnly).map((l) => l.code)
const catalogs = {}
for (const code of locales) {
  const base = flatten(JSON.parse(read(path.join(SRC, `i18n/locales/${code}.json`))))
  if (code === 'en') Object.assign(base, flatten(JSON.parse(read(path.join(SRC, 'i18n/locales/en.manual.json')))))
  catalogs[code] = base
}

// The committed settings extraction: one pass of `npm run gen:settings` feeds
// settings search, `settings.show` and this index alike. It is built from here
// only after the live extraction, run in memory over the same panel sources,
// reproduces both committed files byte for byte: a renamed Settings label must
// fail this check, not ride along in a stale registry.
const genTsPath = path.join(SRC, 'components/commandPalette/settingsRegistry.gen.ts')
const agentJsonPath = path.join(REPO, 'src/kiro_crew/docs/settings-registry.generated.json')
const genTs = read(genTsPath)
const agentJson = read(agentJsonPath)
{
  const extractor = await loadTs('scripts/settingsExtract.ts')
  const panelDir = path.join(SRC, 'pages/settings')
  for (const f of fs.readdirSync(panelDir).filter((n) => n.endsWith('.tsx')).sort()) read(path.join(panelDir, f))
  for (const f of ['settingsManual.ts', 'settingsRoute.ts', 'settingsTypes.ts']) read(path.join(SRC, 'components/commandPalette', f))
  const { entries } = extractor.extractAll(panelDir)
  errors.push(...checkSettingsExtraction({
    liveRegistrySource: extractor.generateRegistrySource(entries),
    liveAgentJson: extractor.generateAgentRegistryJson(entries),
    committedRegistrySource: genTs,
    committedAgentJson: agentJson,
  }))
}
const settingsEntries = JSON.parse(genTs.slice(genTs.indexOf('= ') + 2).trim())
const agentSettings = JSON.parse(agentJson).settings

// Guide bindings are checked against the page's own guide registry (the gateway
// re-checks them against its catalog when find_ui answers). Loaded only when a
// descriptor carries one.
let resolveGuide = null
if (Object.values(UI_LOCATIONS).some((d) => d.guide)) {
  const { resolveGuideAction } = await loadTs('src/guide/guideActions.ts')
  resolveGuide = (action, params) => {
    const r = resolveGuideAction({ id: action, params })
    return r.ok ? { ok: true } : { ok: false, reason: r.reason }
  }
}

const settingsTabs = adapter('src/pages/SettingsPage.tsx', { container: 'buildTabs' })
const capabilityTabs = adapter('src/pages/CapabilitiesPage.tsx', { container: 'tabs' })
// Other SidePanelLayout pages whose tabs are a literal list, keyed by the
// surface (rail page) they belong to: `tab.<surface>.<key>` at `/<surface>?tab=<key>`.
const pageTabs = {
  developer: adapter('src/pages/DeveloperPage.tsx', { container: 'buildTabs' }),
}
const settingsSubs = {
  chat: adapter('src/pages/settings/ChatPanel.tsx', { container: 'railItems' }),
  display: adapter('src/pages/settings/DisplayPanel.tsx', { container: 'railItems' }),
  notifications: adapter('src/pages/settings/NotificationsPanel.tsx', { container: 'railItems' }),
  security: keyMap('src/pages/settings/SecurityPanel.tsx', 'SECTION_LABEL_KEY'),
  // Channel names are product names, rendered untranslated in every locale.
  channels: adapter('src/pages/settings/ChannelsPanel.tsx', { container: 'CHANNELS', labelProp: 'name' }),
}

// Registered controls: scan production sources for markers. The same pass
// parses every source once for the auto tier: its module edges and its
// interactive elements.
const markerSites = []
const sources = new Map()
for (const abs of walkSources(SRC)) {
  const text = fs.readFileSync(abs, 'utf-8')
  const r = scanMarkerSource(text, abs, rel(abs))
  errors.push(...r.errors)
  if (r.sites.length > 0 || r.errors.length > 0) read(abs)
  for (const site of r.sites) {
    const d = UI_LOCATIONS[site.id]
    site.resolved = d ? resolveSiteLabel(site, d) : { error: null }
    markerSites.push(site)
  }
  const sf = parseSource(text, abs)
  sources.set(rel(abs), { abs, sf, edges: scanImports(sf), candidates: scanCandidates(text, abs, rel(abs), sf) })
}

for (const f of ['scripts/gen-ui-index.mjs', 'scripts/lib/ui-index.mjs', 'scripts/lib/i18n-key-resolve.mjs']) read(path.join(ROOT, f))

const surfaces = [
  ...Object.values(BUILTIN_SURFACE_NAV),
  ...CAPABILITY_SUB_ITEM_NAV.map(capabilitySubItemNav),
]
const indexInputs = {
  surfaces,
  extraPages: EXTRA_PAGES,
  extraTitleKeys: EXTRA_PAGE_TITLE_KEY,
  capabilityTabs,
  pageTabs,
  settingsTabs,
  settingsSubs,
  settingsTabPreview: SETTINGS_TAB_PREVIEW,
  settingsEntries,
  agentSettings,
  descriptors: UI_LOCATIONS,
  searchTerms: SEARCH_TERMS,
  previewEnablers: PREVIEW_FLAG_ENABLERS,
  legacyPages: LEGACY_PAGE_CANONICAL,
  routes: routeTable.routes,
  conditions: UI_CONDITIONS,
  revealStates: UI_REVEAL_STATES,
  resolveGuide,
  markerSites,
  catalogs,
  locales,
  productName: PRODUCT_NAME,
}

const digest = createHash('sha256')
for (const [name, text] of [...readInputs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
  digest.update(`${name}\0${text}\0`)
}
const committedDigest = `sha256:${digest.digest('hex')}`

// The committed index: generated + curated tiers. Built WITHOUT auto
// candidates, and its digest carries nothing the auto tier derived, so an
// unregistered control added to a page never stales it.
const built = buildUiIndex({ ...indexInputs, inputDigest: committedDigest })
errors.push(...built.errors)
errors.push(...attachStateLabels(built.index, UI_LOCATIONS, UI_CONDITIONS, UI_REVEAL_STATES))
const collisions = termCollisions(built.index, UI_LOCATION_AREAS)

// The auto tier: which one page each core candidate is drawn on, hung off the
// committed index's pages and tabs, then split into its own artifact.
const autoPlan = planAutoCandidates(built.index)
const autoBuilt = buildUiIndex({ ...indexInputs, autoCandidates: autoPlan.candidates, inputDigest: committedDigest })
const committedErrors = new Set(built.errors)
errors.push(...autoBuilt.errors.filter((e) => !committedErrors.has(e)))
const autoDigest = createHash('sha256')
  .update(`${committedDigest}\0auto\0${JSON.stringify(autoPlan.candidates.map(({ page, tab, key, kind }) => [page, tab, key, kind]))}\0`)
  .digest('hex')

if (errors.length > 0) {
  console.error(`gen-ui-index: ${errors.length} problem(s); the index was not written:\n${errors.map((e) => `  ${e}`).join('\n')}`)
  process.exit(1)
}

const bytes = serializeIndex(built.index)
const counts = built.index.coverage.counts
const tiers = built.index.coverage.tiers
const cov = coverageStats()
const autoArtifact = buildAutoArtifact(autoBuilt.index, {
  baseInputDigest: committedDigest,
  inputDigest: `sha256:${autoDigest}`,
  coverage: {
    core_controls: cov.total,
    core_covered_curated: cov.curated,
    core_covered_auto: cov.auto,
    core_coverage_pct: Number(cov.pct),
  },
})
const autoBytes = serializeIndex(autoArtifact)
// One-word English labels: indexed, but find_ui never answers with one in a
// locale where the label is a single word (see ui_index.py's auto rules).
const oneWordEn = autoArtifact.locations.filter((l) => {
  const t = autoArtifact.labels.en?.[l.label_key] ?? ''
  return t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().split(' ').length === 1
}).length
const summary = `committed index: ${built.index.locations.length} locations (${Object.entries(tiers).map(([k, v]) => `${v} ${k}`).join(', ')}; `
  + `${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}), ${Buffer.byteLength(bytes)} bytes; `
  + `auto tier (build-time ${AUTO_ARTIFACT_NAME}${AUTO_OUT ? '' : ', not written: pass --auto-out'}): `
  + `${autoArtifact.locations.length} entries (${oneWordEn} one-word in English), ${Buffer.byteLength(autoBytes)} bytes; `
  + `core control coverage ${cov.pct}% (${cov.curated} curated + ${cov.auto} auto of ${cov.total}; `
  + `${autoPlan.stats.ambiguous} skipped as shared by several pages), `
  + `${locales.length} locales, `
  + `${collisions.length} cross-area term collision(s)${collisions.length && !REPORT_PATH ? ' (list them with --report <file>)' : ''}`

if (REPORT_PATH) writeReport(REPORT_PATH)

if (CHECK) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : null
  if (current !== bytes) {
    console.error(
      `gen-ui-index: ${path.relative(REPO, OUT)} is ${current === null ? 'missing' : 'stale'}. `
      + 'Run `npm run gen:ui` in website/ and commit the result.',
    )
    process.exit(1)
  }
  console.log(`gen-ui-index: up to date — ${summary}`)
} else if (OUT_PATH) {
  fs.writeFileSync(OUT_PATH, bytes)
  console.log(`gen-ui-index: wrote ${OUT_PATH} (not the committed index) — ${summary}`)
} else {
  fs.writeFileSync(OUT, bytes)
  console.log(`gen-ui-index: wrote ${path.relative(REPO, OUT)} — ${summary}`)
}
// Last, so a stale committed index under --check never leaves a fresh auto
// tier behind (its base_input_digest would not match the shipped index anyway).
if (AUTO_OUT) {
  fs.mkdirSync(path.dirname(path.resolve(AUTO_OUT)), { recursive: true })
  fs.writeFileSync(AUTO_OUT, autoBytes)
  console.log(`gen-ui-index: wrote the auto tier to ${AUTO_OUT}`)
}

function writeReport(file) {
  const en = catalogs.en
  const full = autoBuilt.index
  const fullTiers = full.coverage.tiers
  const lines = ['# find_ui coverage report', '', `Generated from input ${built.index.input_digest}.`, '']
  lines.push('Files: the generated and curated tiers are the committed `src/kiro_crew/docs/ui-index.generated.json` '
    + `(${Buffer.byteLength(bytes)} bytes); the auto tier is the build-time \`${AUTO_ARTIFACT_NAME}\` `
    + `(${Buffer.byteLength(autoBytes)} bytes), written into website/dist by \`npm run build\` and shipped in `
    + 'src/kiro_crew/static/dist. It is never committed.', '')
  lines.push(`## Indexed (${full.locations.length})`, '')
  for (const [k, v] of Object.entries(fullTiers)) lines.push(`- tier ${k}: ${v}${k === 'auto' ? ` (${AUTO_ARTIFACT_NAME})` : ' (committed)'}`)
  for (const [k, v] of Object.entries(counts)) lines.push(`- ${k} (non-auto): ${v}`)
  lines.push('', '## Core control coverage', '')
  lines.push(`${cov.pct}% = (${cov.curated} curated + ${cov.auto} auto) / ${cov.total} interactive elements in core sources `
    + `(not src/apps/**): ${cov.staticOne} unregistered with one static label key, ${cov.unresolved} unresolved `
    + `(dynamic or no label), ${cov.other} with literal or several labels, ${cov.curated} registered.`, '')
  const s = autoPlan.stats
  lines.push(`Auto tier: ${autoBuilt.auto.entries} entries from ${cov.auto} candidates (${oneWordEn} one-word in English, `
    + `never an answer in a locale where the label is one word). Of the ${cov.staticOne} one-key candidates: `
    + `${s.mapped} map to one page (${s.withTab} to one tab too), ${s.shell} are drawn only by the app shell (on every page); `
    + `skipped ${s.ambiguous} shared by several pages or the shell and a page, `
    + `${s.nonPage} drawn only by an unindexed route or an app, ${s.unreached} not reached from any route; `
    + `of the mapped, ${Object.entries(autoBuilt.auto.skipped).map(([k, v]) => `${v} ${k.replaceAll('_', ' ')}`).join(', ')}.`, '')
  lines.push('', `## Registered controls (${built.registered.length})`, '')
  for (const r of built.registered) {
    const key = r.labelKey
    lines.push(`- \`${r.id}\` — "${en[key] ?? key}" (\`${key}\`) at ${r.site.rel}:${r.site.line}`
      + (r.excluded.length ? `; excluded nested ${r.excluded.map((x) => `<${x.tag}> line ${x.line}`).join(', ')}` : ''))
  }
  const candidates = [...sources.values()].flatMap((x) => x.candidates)
  const open = candidates.filter((c) => !c.marked)
  const resolved = open.filter((c) => c.resolved && c.keys.length === 1)
  const unresolved = open.filter((c) => !c.resolved)
  const autoAt = new Set(autoPlan.candidates.map((c) => `${c.rel}:${c.line}`))
  const autoIds = new Set(autoArtifact.locations.map((l) => l.id))
  lines.push('', `## Auto-indexed controls (${autoIds.size})`, '')
  for (const l of autoArtifact.locations) {
    lines.push(`- \`${l.id}\` — "${en[l.label_key]}" (${l.kind}) at ${l.placements[0].route}`)
  }
  lines.push('', '## Skipped as shared by several pages, per file', '')
  for (const [f, n] of [...autoPlan.stats.ambiguousFiles.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    lines.push(`- ${f}: ${n} (${[...(autoPlan.owners.get(f) ?? [])].sort().join(', ')})`)
  }
  lines.push('', `## Candidate controls (${resolved.length} with one static label key, ${unresolved.length} unresolved)`, '')
  lines.push('Interactive elements not yet registered, by file. A label shown is the English catalog text; [auto] marks one the auto tier mapped to a page.', '')
  const byFile = new Map()
  for (const c of resolved) byFile.set(c.rel, [...(byFile.get(c.rel) ?? []), c])
  for (const [f, list] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${f} (${list.length})`, '')
    for (const c of list) lines.push(`- ${c.line} <${c.tag}> "${en[c.keys[0]] ?? c.keys[0]}" (\`${c.keys[0]}\`)${autoAt.has(`${c.rel}:${c.line}`) ? ' [auto]' : ''}`)
    lines.push('')
  }
  const unresolvedByFile = new Map()
  for (const c of unresolved) unresolvedByFile.set(c.rel, (unresolvedByFile.get(c.rel) ?? 0) + 1)
  lines.push('## Unresolved candidates per file (dynamic or no label)', '')
  for (const [f, n] of [...unresolvedByFile.entries()].sort((a, b) => b[1] - a[1])) lines.push(`- ${f}: ${n}`)
  lines.push('', `## Cross-area term collisions (${collisions.length})`, '')
  lines.push('One search term, in one locale, carried by locations of different areas. Not an error; check each is meant.', '')
  if (collisions.length === 0) lines.push('None.')
  for (const c of collisions) lines.push(`- ${c.locale} "${c.term}": ${c.ids.map((i) => `\`${i}\``).join(', ')}`)
  lines.push('', '## Missing translations in the index', '')
  const missing = Object.entries(built.missing)
  if (missing.length === 0) lines.push('None: every indexed key resolves in all shipped locales.')
  for (const [loc, keys] of missing) lines.push(`- ${loc}: ${keys.length} (${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ', …' : ''})`)
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  console.log(`gen-ui-index: coverage report → ${file} (${resolved.length} candidates, ${unresolved.length} unresolved)`)
}

/**
 * The auto tier's inputs: every core candidate with one static label key,
 * mapped to the ONE indexed page (and, when proven, tab) whose module graph
 * reaches its file. See buildPageMap in scripts/lib/ui-index.mjs.
 */
function planAutoCandidates(index) {
  const files = new Set(sources.keys())
  const resolveSpec = (from, spec) => {
    let base
    if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
    else if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`
    else return null
    const stem = base.replace(/\.(m?js|jsx)$/, '')
    for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (files.has(c)) return c
    return null
  }
  const graph = new Map()
  for (const [f, s] of sources) {
    const out = []
    for (const e of s.edges) {
      const to = resolveSpec(f, e.spec)
      if (to && to !== f) out.push({ to, binds: e.binds })
    }
    graph.set(f, out)
  }
  const APP = 'src/App.tsx'
  const MAIN = 'src/main.tsx'
  const routeSpans = collectRouteElementSpans(sources.get(APP).sf)
  const namesOf = (f) => new Set(graph.get(f).flatMap((e) => e.binds))
  const appUses = classifyUses(sources.get(APP).sf, namesOf(APP), routeSpans)

  // The files each route's element renders, for makeRouteLabel's twin rule.
  const routeFiles = new Map()
  for (const e of graph.get(APP)) {
    for (const r of e.binds.flatMap((b) => [...(appUses.get(b) ?? [])])) {
      if (!r.startsWith('route:')) continue
      const p = r.slice('route:'.length)
      if (!routeFiles.has(p)) routeFiles.set(p, new Set())
      routeFiles.get(p).add(e.to)
    }
  }
  const pages = index.locations.filter((l) => l.kind === 'page')
  const routeLabel = makeRouteLabel({
    routes: routeTable.routes,
    pages: pages.map((p) => ({ id: p.id, route: p.placements[0].route })),
    routeFiles,
  })

  // Tab hosts: the page root whose tab panels are keyed to the page's own tabs.
  const tabHosts = new Map()
  for (const p of pages) {
    const tabs = new Map()
    for (const t of index.locations) {
      if (t.kind !== 'tab' || t.tier === 'curated') continue
      const pl = t.placements[0]
      if (pl.parent_ids.length !== 1 || pl.parent_ids[0] !== p.id) continue
      tabs.set(t.id.split('.').pop(), t.id)
    }
    if (tabs.size === 0) continue
    const roots = new Set()
    for (const e of graph.get(APP)) {
      for (const r of e.binds.flatMap((b) => [...(appUses.get(b) ?? [])])) {
        if (r.startsWith('route:') && routeLabel(r.slice(6)) === p.id) roots.add(e.to)
      }
    }
    for (const root of roots) {
      const spans = collectTabPanels(sources.get(root).sf, new Set(tabs.keys()))
      if (spans.length === 0) continue
      tabHosts.set(root, { page: p.id, tabs, spans, uses: classifyUses(sources.get(root).sf, namesOf(root), spans) })
    }
  }
  const { byFile, owners } = buildPageMap({
    graph, appRel: APP, mainRel: MAIN, appUses, routeLabel, tabHosts,
    isAppFile: (f) => f.startsWith('src/apps/'),
  })

  const stats = { mapped: 0, withTab: 0, shell: 0, ambiguous: 0, nonPage: 0, unreached: 0, ambiguousFiles: new Map() }
  const candidates = []
  for (const [f, s] of [...sources].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (f.startsWith('src/apps/')) continue
    for (const c of s.candidates) {
      if (c.marked || !c.resolved || c.keys.length !== 1 || c.literals.length !== 0) continue
      const m = byFile.get(f)
      const o = owners.get(f)
      if (!m && o?.size === 1 && o.has(SHELL_SURFACE)) {
        // Drawn only by the app shell (the rail, the top bar): on every page.
        stats.shell++
        candidates.push({ page: SHELL_SURFACE, tab: null, key: c.keys[0], kind: candidateKind(c), rel: f, line: c.line })
        continue
      }
      if (!m) {
        if (!o) stats.unreached++
        else if (o.size > 1) {
          stats.ambiguous++
          stats.ambiguousFiles.set(f, (stats.ambiguousFiles.get(f) ?? 0) + 1)
        } else stats.nonPage++
        continue
      }
      let tab = m.tab
      const host = tabHosts.get(f)
      if (host && host.page === m.page) {
        const span = host.spans.find((sp) => c.pos >= sp.start && c.pos < sp.end)
        tab = span ? host.tabs.get(span.key) : null
      }
      stats.mapped++
      if (tab) stats.withTab++
      candidates.push({ page: m.page, tab, key: c.keys[0], kind: candidateKind(c), rel: f, line: c.line })
    }
  }
  return { candidates, stats, owners }
}

/** Core (not src/apps/**) interactive elements and how many each tier covers. */
function coverageStats() {
  const core = [...sources].filter(([f]) => !f.startsWith('src/apps/')).flatMap(([, s]) => s.candidates)
  const curated = core.filter((c) => c.marked).length
  const open = core.filter((c) => !c.marked)
  const staticOne = open.filter((c) => c.resolved && c.keys.length === 1).length
  const unresolved = open.filter((c) => !c.resolved).length
  const auto = autoBuilt.auto.covered
  const total = core.length
  return {
    curated, auto, total, staticOne, unresolved, other: open.length - staticOne - unresolved,
    pct: total ? ((100 * (curated + auto)) / total).toFixed(1) : '0.0',
  }
}

/**
 * Copy each descriptor's `stateLabels` onto its index location as
 * `state_labels`: which of the element's labels is on screen in which state.
 * Every key must be the location's label key or one of its alias keys (so it
 * is in every locale's label table already), the label key must be among
 * them, and every `when` must be a condition or a reveal state.
 */
function attachStateLabels(index, descriptors, conditions, revealStates) {
  const out = []
  const byId = new Map(index.locations.map((l) => [l.id, l]))
  for (const [id, d] of Object.entries(descriptors)) {
    if (d.stateLabels === undefined) continue
    const where = `ui location '${id}' stateLabels`
    const loc = byId.get(id)
    if (!loc) continue
    if (!Array.isArray(d.stateLabels) || d.stateLabels.length < 2) {
      out.push(`${where}: name at least two states (one label per state)`)
      continue
    }
    const keys = new Set([loc.label_key, ...(loc.alias_keys ?? [])])
    const seenKeys = new Set()
    const seenWhen = new Set()
    for (const s of d.stateLabels) {
      if (!keys.has(s.key)) out.push(`${where}: '${s.key}' is neither the label key nor an alias key`)
      if (!Object.hasOwn(conditions, s.when) && !Object.hasOwn(revealStates, s.when)) {
        out.push(`${where}: unknown state '${s.when}' (add it to src/uiLocations/conditions.ts)`)
      }
      if (seenKeys.has(s.key) || seenWhen.has(s.when)) out.push(`${where}: '${s.key}' / '${s.when}' is listed twice`)
      seenKeys.add(s.key)
      seenWhen.add(s.when)
    }
    if (!seenKeys.has(loc.label_key)) out.push(`${where}: the label key '${loc.label_key}' must be one of the states`)
    loc.state_labels = d.stateLabels.map((s) => ({ label_key: s.key, when: s.when }))
  }
  return out
}

/**
 * Search terms shared by locations of DIFFERENT areas, per locale: a report,
 * never an error (two areas can legitimately both answer "create a reminder"),
 * so a broad shared term is seen before it is added, not after it steals
 * another area's question.
 */
function termCollisions(index, areas) {
  const areaOf = new Map()
  for (const [area, table] of Object.entries(areas)) for (const id of Object.keys(table)) areaOf.set(id, area)
  const fold = (t) => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
  const owners = new Map()
  for (const loc of index.locations) {
    for (const [locale, list] of Object.entries(loc.terms ?? {})) {
      for (const term of list) {
        const k = `${locale}\0${fold(term)}`
        if (!owners.has(k)) owners.set(k, [])
        owners.get(k).push(loc.id)
      }
    }
  }
  const out = []
  for (const [k, ids] of [...owners.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const distinctAreas = new Set(ids.map((id) => areaOf.get(id) ?? 'generated'))
    if (distinctAreas.size < 2) continue
    const [locale, term] = k.split('\0')
    out.push({ locale, term, ids: [...new Set(ids)].sort() })
  }
  return out
}
