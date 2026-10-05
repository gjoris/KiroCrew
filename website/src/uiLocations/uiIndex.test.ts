/**
 * The find_ui index generator (`scripts/lib/ui-index.mjs`): marker scanning,
 * label resolution and index assembly on synthetic sources, plus golden
 * assertions on the committed index. The full freshness check
 * (`npm run gen:ui -- --check`) runs once in frontend-lint and in the build, not
 * here.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as React from 'react'
import { render } from '@testing-library/react'

import {
  buildUiIndex,
  checkSettingsExtraction,
  collectKeyMap,
  collectObjectList,
  collectRouteTable,
  matchRoute,
  mergeLocationAreas,
  resolveSiteLabel,
  scanMarkerSource,
  serializeIndex,
} from '../../scripts/lib/ui-index.mjs'
import AddJobSplitButton from '../components/AddJobSplitButton'
import { Glass } from '../components/Glass'
import { MemoryModeChip } from '../components/MemoryModeChip'
import { Btn, IconButton, SendBtn } from '../components/ui'
import Clickable from '../components/Clickable'
import SegmentedControl from '../components/SegmentedControl'
import SimpleSelect from '../components/SimpleSelect'
import { Link, MemoryRouter } from 'react-router-dom'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu'
import { SETTINGS_REGISTRY } from '../components/commandPalette/settingsRegistry.gen'
import { UI_CONDITIONS, UI_REVEAL_STATES } from './conditions'
import { LEGACY_PAGE_CANONICAL, UI_LOCATION_AREAS, UI_LOCATIONS } from './descriptors'
import { UI_LOCATION_ATTR, uiLocation } from './uiLocation'

const FIXTURE = '/virtual/src/Fixture.tsx'

interface Site { id: string; rel: string; line: number; resolved?: { error?: string; source?: { key?: string; literal?: string }; excluded?: { tag: string }[] } }
interface Index {
  locations: { id: string; kind: string; label_key: string; setting_id?: string; terms?: Record<string, string[]>; placements: { surface_id: string; route: string; parent_ids: string[]; requires: { kind: string; location?: string }[] }[] }[]
  labels: Record<string, Record<string, string>>
  locales: string[]
}

function sitesOf(source: string, descriptors: Record<string, unknown> = {}) {
  const { sites, errors } = scanMarkerSource(source, FIXTURE, 'Fixture.tsx') as { sites: Site[]; errors: string[] }
  for (const s of sites) {
    const d = descriptors[s.id] as object | undefined
    s.resolved = resolveSiteLabel(s, d ?? {})
  }
  return { sites, errors }
}

const HEADER = "import { i18nT } from '../i18n/t'\nimport { uiLocation } from './uiLocation'\n"

describe('marker label resolution', () => {
  it('reads the visible text and excludes a nested control (Older Sessions and its Clear button)', () => {
    const { sites, errors } = sitesOf(`${HEADER}
export function Footer({ open, n }: { open: boolean; n: number }) {
  return (
    <div role="button" {...uiLocation('chat.older-sessions')} aria-label={i18nT('k.aria')}>
      <span><Clock size={14} /><span>{i18nT('k.older')}</span></span>
      <span>
        {open && n > 0 && (<button onClick={() => {}}>{i18nT('k.clear')}</button>)}
        <DisclosureChevron open={open} />
      </span>
    </div>
  )
}`)
    expect(errors).toEqual([])
    expect(sites).toHaveLength(1)
    expect(sites[0].resolved?.source).toEqual({ key: 'k.older' })
    expect(sites[0].resolved?.excluded?.map(x => x.tag)).toEqual(['button'])
  })

  it('reads a label wrapped in presentation spans and a resolvable const', () => {
    const { sites } = sitesOf(`${HEADER}
const KEY = 'k.wrapped'
export const A = () => <Btn {...uiLocation('a.wrapped')}><span><b>{i18nT(KEY)}</b></span></Btn>`)
    expect(sites[0].resolved?.source).toEqual({ key: 'k.wrapped' })
  })

  it('reads a forwarded label prop when the descriptor names the attribute', () => {
    const { sites } = sitesOf(`${HEADER}
export const A = () => <Row {...uiLocation('a.row')} label={i18nT('k.row')} />`,
    { 'a.row': { label: { from: 'attr', attr: 'label' } } })
    expect(sites[0].resolved?.source).toEqual({ key: 'k.row' })
  })

  it('picks one branch of a conditional label only when the descriptor names it', () => {
    const src = `${HEADER}
export const A = ({ on }: { on: boolean }) => (
  <button {...uiLocation('a.toggle')} aria-label={on ? i18nT('k.hide') : i18nT('k.show')} />
)`
    expect(sitesOf(src, { 'a.toggle': { label: { from: 'attr', attr: 'aria-label', key: 'k.show' } } }).sites[0].resolved?.source)
      .toEqual({ key: 'k.show' })
    expect(sitesOf(src, { 'a.toggle': { label: { from: 'attr', attr: 'aria-label' } } }).sites[0].resolved?.error)
      .toMatch(/several labels/)
    expect(sitesOf(src, { 'a.toggle': { label: { from: 'attr', attr: 'aria-label', key: 'k.other' } } }).sites[0].resolved?.error)
      .toMatch(/not what the site renders/)
  })

  it('refuses a dynamic label instead of guessing one', () => {
    const variable = sitesOf(`${HEADER}
export const A = ({ name }: { name: string }) => <button {...uiLocation('a.dyn')}>{name}</button>`)
    expect(variable.sites[0].resolved?.error).toMatch(/dynamic/)
    const computedKey = sitesOf(`${HEADER}
export const A = ({ k }: { k: string }) => <button {...uiLocation('a.dyn')}>{i18nT(k)}</button>`)
    expect(computedKey.sites[0].resolved?.error).toMatch(/dynamic/)
    const nothing = sitesOf(`${HEADER}
export const A = () => <button {...uiLocation('a.dyn')}><Icon /></button>`)
    expect(nothing.sites[0].resolved?.error).toMatch(/no label text/)
  })

  it('refuses a non-literal id and a marker that is not spread onto an element', () => {
    const { errors } = sitesOf(`${HEADER}
const id = 'a.b'
const props = uiLocation('a.c')
export const A = () => <div {...uiLocation(id as never)} {...props}>x</div>`)
    expect(errors.some(e => /string literal/.test(e))).toBe(true)
    expect(errors.some(e => /spread directly onto a JSX element/.test(e))).toBe(true)
  })

  it('reads a marker spread into one segment of a SegmentedControl, labelled by that segment', () => {
    const { sites, errors } = sitesOf(`${HEADER}
export const A = ({ v }: { v: string }) => (
  <SegmentedControl value={v} onChange={() => {}} segments={[
    { key: 'list', label: i18nT('k.list') },
    { key: 'runs', label: i18nT('k.runs'), icon: <History />, ...uiLocation('a.runs') },
  ]} />
)`)
    expect(errors).toEqual([])
    expect(sites.map(s => s.id)).toEqual(['a.runs'])
    expect(sites[0].resolved?.source).toEqual({ key: 'k.runs' })
  })

  it('refuses a segment marker anywhere but a SegmentedControl segments array, and a dynamic segment label', () => {
    const elsewhere = sitesOf(`${HEADER}
export const A = () => <Tabs items={[{ key: 'x', label: i18nT('k.x'), ...uiLocation('a.x') }]} />
export const B = () => <SegmentedControl segments={[]} other={[{ key: 'y', ...uiLocation('a.y') }]} />
export const C = () => <Tabs segments={[{ key: 'z', label: i18nT('k.z'), ...uiLocation('a.z') }]} />`)
    expect(elsewhere.sites).toEqual([])
    expect(elsewhere.errors.filter(e => /spread directly onto a JSX element/.test(e))).toHaveLength(3)
    const dynamic = sitesOf(`${HEADER}
export const A = ({ n }: { n: string }) => <SegmentedControl segments={[{ key: 'r', label: n, ...uiLocation('a.r') }]} />`)
    expect(dynamic.sites[0].resolved?.error).toMatch(/segment label is missing or dynamic/)
    const attrRule = sitesOf(`${HEADER}
export const A = () => <SegmentedControl segments={[{ key: 'r', label: i18nT('k.r'), ...uiLocation('a.r') }]} />`,
    { 'a.r': { label: { from: 'attr', attr: 'aria-label' } } })
    expect(attrRule.sites[0].resolved?.error).toMatch(/label.from must be 'text'/)
  })

  it('skips a file that has no marker without parsing it', () => {
    expect(scanMarkerSource('export const x = <div />', FIXTURE, 'Fixture.tsx')).toEqual({ sites: [], errors: [] })
  })
})

describe('translator binding is resolved by lexical scope', () => {
  const MARK = "import { uiLocation } from './uiLocation'\n"
  const label = (src: string) => sitesOf(`${MARK}${src}`).sites[0].resolved

  it('refuses a parameter named t that shadows an imported translator', () => {
    const r = label(`import { t } from 'i18next'
export function A(t: (k: string) => string) { return <button {...uiLocation('a.x')}>{t('k')}</button> }`)
    expect(r?.error).toMatch(/dynamic/)
  })

  it('refuses a map callback t inside a component that also binds useTranslation', () => {
    const r = label(`import { useTranslation } from 'react-i18next'
export function A({ rows }: { rows: { t: () => string }[] }) {
  const { t } = useTranslation()
  return <>{rows.map(t => <button key="x" {...uiLocation('a.x')}>{t('k')}</button>)}</>
}`)
    expect(r?.error).toMatch(/dynamic/)
  })

  it('refuses i18nT shadowed by a local, and an i18nT that was never imported', () => {
    expect(label(`import { i18nT } from '../i18n/t'
export function A() { const i18nT = (k: string) => k; return <button {...uiLocation('a.x')}>{i18nT('k')}</button> }`)?.error).toMatch(/dynamic/)
    expect(label(`export const A = () => <button {...uiLocation('a.x')}>{i18nT('k')}</button>`)?.error).toMatch(/dynamic/)
  })

  it('accepts aliased translator imports and an aliased useTranslation binding', () => {
    expect(label(`import { t as tr } from 'i18next'
export const A = () => <button {...uiLocation('a.x')}>{tr('k.alias')}</button>`)?.source).toEqual({ key: 'k.alias' })
    expect(label(`import { i18nT as tt } from '../../i18n/t'
export const A = () => <button {...uiLocation('a.x')}>{tt('k.i18nt')}</button>`)?.source).toEqual({ key: 'k.i18nt' })
    expect(label(`import { useTranslation } from 'react-i18next'
export function A() { const { t: tr } = useTranslation(); return <button {...uiLocation('a.x')}>{tr('k.hook')}</button> }`)?.source).toEqual({ key: 'k.hook' })
  })

  it('refuses i18next.t when i18next is a parameter, accepts it when imported', () => {
    expect(label(`export function A(i18next: { t: (k: string) => string }) { return <button {...uiLocation('a.x')}>{i18next.t('k')}</button> }`)?.error).toMatch(/dynamic/)
    expect(label(`import i18next from 'i18next'
export const A = () => <button {...uiLocation('a.x')}>{i18next.t('k.obj')}</button>`)?.source).toEqual({ key: 'k.obj' })
  })
})

describe('a marker on a custom component reaches the DOM only if the component forwards it', () => {
  it('lands on the element a person clicks when forwarded, and nowhere when dropped', () => {
    const Forwarding = (props: React.HTMLAttributes<HTMLButtonElement>) => React.createElement('button', props, 'Go')
    const Dropping = (props: React.HTMLAttributes<HTMLButtonElement>) => React.createElement('button', { onClick: props.onClick }, 'Go')
    const forwarded = render(React.createElement(Forwarding, { ...uiLocation('chat.older-sessions') }))
    expect(forwarded.container.querySelector(`button[${UI_LOCATION_ATTR}="chat.older-sessions"]`)).not.toBeNull()
    forwarded.unmount()
    const dropped = render(React.createElement(Dropping, { ...uiLocation('chat.older-sessions') }))
    expect(dropped.container.querySelector(`[${UI_LOCATION_ATTR}]`)).toBeNull()
    dropped.unmount()
  })

  it('every real render site is an intrinsic element or a component with a rendered forwarding test', () => {
    const SRC = path.resolve(__dirname, '..')
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'locales' || e.name === 'test') continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, out)
        else if (/\.tsx$/.test(e.name) && !/\.(test|stories|spec)\.tsx$/.test(e.name)) out.push(full)
      }
      return out
    }
    const tags: string[] = []
    for (const abs of walk(SRC)) {
      const text = fs.readFileSync(abs, 'utf-8')
      if (!text.includes('uiLocation(')) continue
      const { sites } = scanMarkerSource(text, abs, path.relative(SRC, abs)) as { sites: { id: string; opening: { tagName: { getText(): string } } }[] }
      for (const s of sites) tags.push(s.opening.tagName.getText())
    }
    expect(tags.length).toBe(Object.keys(UI_LOCATIONS).length)
    for (const t of tags) if (!/^[a-z]/.test(t)) expect(FORWARDING_PROVEN).toContain(t)
  })
})

/**
 * Custom components a marker is spread onto in production, each proven below
 * to put the attribute on the element a person clicks. A new one fails the
 * site test above until it is added here with its own rendered test.
 */
const FORWARDING_PROVEN = [
  'Btn', 'SendBtn', 'DropdownMenuItem', 'Glass',
  // Proven ahead of the wave-3 area batches (so none of them edits this file):
  // each forwards unknown props to the element a person activates.
  'IconButton', 'Clickable', 'Link',
  // Proven against the real component in src/test/App.navItemUiLocation.test.tsx
  // (importing App here would load the whole shell into this file).
  'NavItem',
  // Proven below: SimpleSelect forwards only the marker, to its trigger (Radix)
  // or its native <select> (touch); SegmentedControl draws a segment's own
  // marker on that segment's radio.
  'SimpleSelect', 'SegmentedControl',
]

describe('the custom components real markers sit on forward them', () => {
  it('Btn and SendBtn put the marker on their <button>', () => {
    const h = React.createElement
    const r = render(h(React.Fragment, null,
      h(Btn, { ...uiLocation('artifacts.new') }, 'New'),
      h(SendBtn, { ...uiLocation('schedule.create-first') }, 'Create'),
    ))
    expect(r.container.querySelector(`button[${UI_LOCATION_ATTR}="artifacts.new"]`)?.textContent).toBe('New')
    expect(r.container.querySelector(`button[${UI_LOCATION_ATTR}="schedule.create-first"]`)?.textContent).toBe('Create')
    r.unmount()
  })

  it('DropdownMenuItem puts the marker on the menu item a person picks', () => {
    const h = React.createElement
    const r = render(h(DropdownMenu, { open: true },
      h(DropdownMenuTrigger, { asChild: true }, h(Btn, { ...uiLocation('artifacts.add-menu') }, 'More')),
      h(DropdownMenuContent, null, h(DropdownMenuItem, { ...uiLocation('artifacts.import') }, 'Import')),
    ))
    const item = document.body.querySelector(`[${UI_LOCATION_ATTR}="artifacts.import"]`)
    expect(item?.getAttribute('role')).toBe('menuitem')
    expect(item?.textContent).toBe('Import')
    // The trigger keeps its marker through Radix's asChild slot.
    expect(document.body.querySelector(`button[${UI_LOCATION_ATTR}="artifacts.add-menu"]`)).not.toBeNull()
    r.unmount()
  })

  it('IconButton, Clickable and a router Link put the marker on the element a person activates', () => {
    const h = React.createElement
    const r = render(h(MemoryRouter, null,
      h(IconButton, { 'aria-label': 'Refresh', ...uiLocation('artifacts.new') }, 'R'),
      h(Clickable, { onClick: () => {}, ...uiLocation('schedule.create-first') }, 'Open'),
      h(Link, { to: '/schedule', ...uiLocation('schedule.add-job') }, 'Schedule'),
    ))
    expect(r.container.querySelector(`button[${UI_LOCATION_ATTR}="artifacts.new"]`)?.getAttribute('aria-label')).toBe('Refresh')
    expect(r.container.querySelector(`[${UI_LOCATION_ATTR}="schedule.create-first"]`)?.getAttribute('role')).toBe('button')
    expect(r.container.querySelector(`a[${UI_LOCATION_ATTR}="schedule.add-job"]`)?.getAttribute('href')).toBe('/schedule')
    r.unmount()
  })

  it('SimpleSelect puts the marker on the control a person opens, on desktop and on touch', () => {
    const props = { options: ['a', 'b'], value: 'a', onChange: () => {}, 'aria-label': 'Pick', ...uiLocation('artifacts.detail.versions') }
    const r = render(React.createElement(SimpleSelect, props))
    const trigger = r.container.querySelector(`[${UI_LOCATION_ATTR}="artifacts.detail.versions"]`)
    expect(trigger?.getAttribute('role')).toBe('combobox')
    expect(trigger?.getAttribute('aria-label')).toBe('Pick')
    expect(r.container.querySelectorAll(`[${UI_LOCATION_ATTR}]`)).toHaveLength(1)
    r.unmount()
    // Touch draws a native <select>; the marker moves with the control.
    const coarse = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia
    try {
      const t = render(React.createElement(SimpleSelect, props))
      const select = t.container.querySelector(`select[${UI_LOCATION_ATTR}="artifacts.detail.versions"]`)
      expect(select?.getAttribute('aria-label')).toBe('Pick')
      t.unmount()
    } finally {
      window.matchMedia = coarse
    }
    // No marker, no attribute: nothing else is forwarded.
    const bare = render(React.createElement(SimpleSelect, { options: ['a'], value: 'a', onChange: () => {} }))
    expect(bare.container.querySelector(`[${UI_LOCATION_ATTR}]`)).toBeNull()
    bare.unmount()
  })

  it("SegmentedControl puts a segment's marker on that segment's radio only", () => {
    const segments = [
      { key: 'list', label: 'List' },
      { key: 'runs', label: 'Runs', ...uiLocation('schedule.view-executions') },
    ]
    const r = render(React.createElement(SegmentedControl, { segments, value: 'list', onChange: () => {}, collapse: false }))
    const marked = r.container.querySelectorAll(`[${UI_LOCATION_ATTR}]`)
    expect(marked).toHaveLength(1)
    expect(marked[0].getAttribute(UI_LOCATION_ATTR)).toBe('schedule.view-executions')
    expect(marked[0].getAttribute('role')).toBe('radio')
    expect(marked[0].textContent).toContain('Runs')
    r.unmount()
  })

  it('Glass puts the marker on the element it renders as', () => {
    const r = render(React.createElement(Glass, { as: 'button', radius: 8, ...uiLocation('chat.memory-mode') }, 'Mode'))
    const el = r.container.querySelector(`[${UI_LOCATION_ATTR}="chat.memory-mode"]`)
    expect(el?.tagName).toBe('BUTTON')
    expect(el?.textContent).toBe('Mode')
    r.unmount()
  })

  it('the memory-mode chip carries its marker in every mode, on the button it is', () => {
    for (const mode of ['persistent', 'incognito', 'temporary']) {
      const r = render(React.createElement(MemoryModeChip, { memoryMode: mode, onSwitchMode: () => {} }))
      const marked = r.container.querySelectorAll(`[${UI_LOCATION_ATTR}]`)
      expect(marked).toHaveLength(1)
      expect(marked[0].getAttribute(UI_LOCATION_ATTR)).toBe('chat.memory-mode')
      expect(marked[0]).toBe(r.getByTestId('memory-mode-chip'))
      expect(marked[0].tagName).toBe('BUTTON')
      r.unmount()
    }
  })

  it('the Add Job half of AddJobSplitButton carries the populated-schedule marker, the caret does not', () => {
    const r = render(React.createElement(AddJobSplitButton, { onBlank: () => {}, onBrowseTemplates: () => {} }))
    const marked = r.container.querySelectorAll(`[${UI_LOCATION_ATTR}]`)
    expect(marked).toHaveLength(1)
    expect(marked[0].getAttribute(UI_LOCATION_ATTR)).toBe('schedule.add-job')
    expect(marked[0].tagName).toBe('BUTTON')
    expect(marked[0].textContent).toContain('Add Job')
    r.unmount()
  })
})

describe('bounded list adapters', () => {
  it('reads key/label objects from one named declaration', () => {
    const src = `${HEADER}
function buildTabs() { return [{ key: 'chat', label: i18nT('k.chat'), icon: <I /> }, { key: 'x', label: 'Literal' }] }
const other = [{ key: 'nope', label: i18nT('k.nope') }]`
    const { items, errors } = collectObjectList(src, FIXTURE, 'Fixture.tsx', { container: 'buildTabs' })
    expect(errors).toEqual([])
    expect(items.map((i: { id: string }) => i.id)).toEqual(['chat', 'x'])
  })

  it('names a missing container and a key map that is not literal', () => {
    expect(collectObjectList('const a = 1', FIXTURE, 'F.tsx', { container: 'tabs' }).errors[0]).toMatch(/no declaration/)
    expect(collectKeyMap("export const M = { a: 'k.a', b: f() }", FIXTURE, 'F.tsx', 'M').errors[0]).toMatch(/not a string literal/)
  })
})

// ---------------------------------------------------------------- assembly

const EN = {
  'nav.chat': 'Sessions', 'nav.settings': 'Settings', 'tab.chat': 'Chat', 'k.older': 'Older Sessions',
  'k.toggle': 'Show sessions', 'k.inner': 'Inner', 'k.setting': 'A setting', 'k.count': '{{count}} items',
}
const ZH = { 'nav.chat': '会话', 'k.older': '较早的会话' }

const ROUTES = [
  { path: '/chat/:slug?', line: 1, catchAll: false, redirect: null },
  { path: '/settings/*', line: 2, catchAll: false, redirect: null },
  { path: '/old', line: 3, catchAll: false, redirect: '/settings/chat' },
  { path: '/:builtinApp/*', line: 4, catchAll: true, redirect: null },
  { path: '*', line: 5, catchAll: true, redirect: '/chat' },
]

function baseInputs(over: Record<string, unknown> = {}) {
  const site = (id: string, key: string, line = 1) => ({ id, rel: 'F.tsx', line, resolved: { source: { key }, excluded: [] } })
  return {
    surfaces: [
      { navId: 'chat', route: '/chat', label: 'Sessions', labelKey: 'nav.chat', group: 'Main' },
      { navId: 'settings', route: '/settings', label: 'Settings', labelKey: 'nav.settings', group: 'Bottom' },
    ],
    extraPages: [],
    extraTitleKeys: {},
    capabilityTabs: [],
    settingsTabs: [{ id: 'chat', key: 'tab.chat' }],
    settingsSubs: {},
    settingsTabPreview: {},
    settingsEntries: [{ id: 'chat.a-setting', label: 'A setting', labelKey: 'k.setting', tab: 'chat', type: 'toggle', occurrence: 1 }],
    agentSettings: [{ id: 'chat.a-setting', label: 'A setting', tab: 'chat', route: '/settings/chat?highlight=chat.a-setting' }],
    descriptors: {
      'chat.toggle': { kind: 'toggle', placements: [{ surface: 'chat', parent: 'page.chat', entry: 'toolbar' }] },
      'chat.older': {
        kind: 'disclosure',
        placements: [{ surface: 'chat', parent: 'page.chat', entry: 'sidebar', requires: [{ kind: 'shown_by', location: 'chat.toggle' }] }],
      },
    },
    previewEnablers: {},
    markerSites: [site('chat.toggle', 'k.toggle'), site('chat.older', 'k.older', 2)],
    catalogs: { en: EN, 'zh-CN': ZH },
    locales: ['en', 'zh-CN'],
    productName: 'Kiro Crew',
    inputDigest: 'sha256:test',
    routes: ROUTES,
    conditions: UI_CONDITIONS,
    revealStates: UI_REVEAL_STATES,
    resolveGuide: (action: string) => (action === 'ok.action' ? { ok: true } : { ok: false, reason: 'unknown_action' }),
    ...over,
  }
}

function build(over: Record<string, unknown> = {}) {
  return buildUiIndex(baseInputs(over)) as { index: Index; errors: string[]; missing: Record<string, string[]> }
}

describe('index assembly', () => {
  it('builds pages, tabs, settings and registered controls with explicit paths', () => {
    const { index, errors, missing } = build()
    expect(errors).toEqual([])
    const byId = Object.fromEntries(index.locations.map(l => [l.id, l]))
    expect(byId['chat.older'].placements[0].parent_ids).toEqual(['page.chat'])
    expect(byId['chat.older'].placements[0].route).toBe('/chat')
    expect(byId['setting:chat.a-setting'].placements[0].parent_ids).toEqual(['page.settings', 'settings.tab.chat'])
    expect(index.labels['zh-CN']['k.older']).toBe('较早的会话')
    expect(missing['zh-CN']).toContain('k.toggle')
  })

  it('derives a chain through a registered parent', () => {
    const descriptors = {
      ...baseInputs().descriptors,
      'chat.inner': { kind: 'button', placements: [{ surface: 'chat', parent: 'chat.older', entry: 'menu' }] },
    }
    const markerSites = [...baseInputs().markerSites, { id: 'chat.inner', rel: 'F.tsx', line: 3, resolved: { source: { key: 'k.inner' }, excluded: [] } }]
    const { index, errors } = build({ descriptors, markerSites })
    expect(errors).toEqual([])
    expect(index.locations.find(l => l.id === 'chat.inner')?.placements[0].parent_ids).toEqual(['page.chat', 'chat.older'])
  })

  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['an unknown marker', { markerSites: [...baseInputs().markerSites, { id: 'chat.ghost', rel: 'G.tsx', line: 9, resolved: {} }] }, /unknown ui location 'chat.ghost'/],
    ['an unused descriptor', { markerSites: baseInputs().markerSites.slice(0, 1) }, /no render site carries/],
    ['a duplicate render site', { markerSites: [...baseInputs().markerSites, { id: 'chat.older', rel: 'H.tsx', line: 4, resolved: {} }] }, /marked twice/],
    ['an unknown parent', { descriptors: { ...baseInputs().descriptors, 'chat.older': { kind: 'disclosure', placements: [{ surface: 'chat', parent: 'page.nope', entry: 'sidebar' }] } } }, /unknown parent 'page.nope'/],
    ['an unknown surface', { descriptors: { ...baseInputs().descriptors, 'chat.older': { kind: 'disclosure', placements: [{ surface: 'nope', parent: 'page.chat', entry: 'sidebar' }] } } }, /unknown surface 'nope'/],
    ['a reserved id prefix', { descriptors: { ...baseInputs().descriptors, 'page.fake': { kind: 'button', placements: [] } } }, /must be lowercase/],
    ['a preview flag with no enabler', { surfaces: [...baseInputs().surfaces, { navId: 'x', route: '/x', label: 'X', labelKey: 'nav.chat', group: 'Main', previewFlag: 'mc-preview-x' }] }, /has no enabling setting/],
    ['an interpolated label', { settingsEntries: [{ id: 'chat.a-setting', labelKey: 'k.count', label: 'n', tab: 'chat' }] }, /interpolates a value/],
    ['a label key absent from English', { settingsTabs: [{ id: 'chat', key: 'tab.missing' }] }, /not in the English catalog/],
    ['settings that drifted from the agent registry', { agentSettings: [] }, /run npm run gen:settings/],
    ['a resolution error at the render site', { markerSites: [baseInputs().markerSites[0], { id: 'chat.older', rel: 'F.tsx', line: 2, resolved: { error: 'F.tsx:2: label text is dynamic' } }] }, /label text is dynamic/],
  ]
  for (const [name, over, re] of cases) {
    it(`fails on ${name}`, () => {
      expect(build(over).errors.some(e => re.test(e))).toBe(true)
    })
  }

  it('carries curated search terms from a descriptor and from SEARCH_TERMS, in locale order', () => {
    const descriptors = { ...baseInputs().descriptors, 'chat.older': { ...baseInputs().descriptors['chat.older'], terms: { 'zh-CN': ['历史对话'], en: ['old chats'] } } }
    const { index, errors } = build({ descriptors, searchTerms: { 'page.chat': { en: ['chats'] }, 'setting:chat.a-setting': { en: ['  a knob '] } } })
    expect(errors).toEqual([])
    const byId = Object.fromEntries(index.locations.map(l => [l.id, l]))
    expect(byId['chat.older'].terms).toEqual({ en: ['old chats'], 'zh-CN': ['历史对话'] })
    expect(Object.keys(byId['chat.older'].terms!)).toEqual(['en', 'zh-CN'])
    expect(byId['page.chat'].terms).toEqual({ en: ['chats'] })
    expect(byId['setting:chat.a-setting'].terms).toEqual({ en: ['a knob'] })
    expect(byId['chat.toggle'].terms).toBeUndefined()
  })

  const termCases: [string, Record<string, unknown>, RegExp][] = [
    ['an unknown id', { searchTerms: { 'page.nope': { en: ['x'] } } }, /SEARCH_TERMS names unknown location 'page.nope'/],
    ['a registered id in the overlay', { searchTerms: { 'chat.older': { en: ['x'] } } }, /put its terms in its descriptor/],
    ['an unknown locale', { searchTerms: { 'page.chat': { tlh: ['x'] } } }, /unknown locale 'tlh'/],
    ['a blank term', { searchTerms: { 'page.chat': { en: ['  '] } } }, /blank or non-string term/],
    ['an empty list', { searchTerms: { 'page.chat': { en: [] } } }, /must be a nonempty list/],
    ['a repeated term', { searchTerms: { 'page.chat': { en: ['Chats', 'chats!'] } } }, /listed twice/],
    ['a term that only repeats the label', { searchTerms: { 'page.chat': { 'zh-CN': ['会话'] } } }, /only repeats the zh-CN label/],
    ['an overlong term', { searchTerms: { 'page.chat': { en: ['x'.repeat(61)] } } }, /longer than 60/],
  ]
  for (const [name, over, re] of termCases) {
    it(`fails on search terms with ${name}`, () => {
      expect(build(over).errors.some(e => re.test(e))).toBe(true)
    })
  }

  it('fails on a parent cycle', () => {
    const descriptors = {
      'chat.a': { kind: 'button', placements: [{ surface: 'chat', parent: 'chat.b', entry: 'menu' }] },
      'chat.b': { kind: 'button', placements: [{ surface: 'chat', parent: 'chat.a', entry: 'menu' }] },
    }
    const markerSites = ['chat.a', 'chat.b'].map((id, i) => ({ id, rel: 'F.tsx', line: i, resolved: { source: { key: 'k.inner' }, excluded: [] } }))
    expect(build({ descriptors, markerSites }).errors.some(e => /parent cycle/.test(e))).toBe(true)
  })

})

// ---------------------------------------------------------------- routes, legacy pages, nesting, guides

const markerFor = (id: string, line: number) => ({ id, rel: 'F.tsx', line, resolved: { source: { key: 'k.inner' }, excluded: [] } })

describe('the route table', () => {
  const APP = `import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
function GoProjects() { const { search } = useLocation(); return <Navigate to={'/projects' + search} replace /> }
function Shell() { return <div><Navigate to="/x" /></div> }
export const App = () => (
  <Routes>
    <Route path="/chat/:slug?" element={<ChatPage />} />
    <Route path="/old" element={<Navigate to="/capabilities?tab=mcp" replace />} />
    <Route path="/tasks" element={<GoProjects />} />
    <Route path="/shell" element={<Shell />} />
    <Route path="/apps/:name" element={<AppPage />} />
    <Route path="/apps/library" element={<Library />} />
    <Route path="/:builtinApp/*" element={<Builtin />} />
    <Route path="*" element={<Navigate to={dynamicPath} />} />
  </Routes>
)`
  const { routes, errors } = collectRouteTable(APP, '/virtual/App.tsx', 'App.tsx') as { routes: { path: string; redirect: string | null; catchAll: boolean }[]; errors: string[] }

  it('reads redirects (direct and via a redirect-only component) and catch-alls', () => {
    expect(errors).toEqual([])
    const by = Object.fromEntries(routes.map(r => [r.path, r]))
    expect(by['/old'].redirect).toBe('/capabilities?tab=mcp')
    expect(by['/tasks'].redirect).toBe('/projects')
    // A component that renders more than a Navigate is a page, not a redirect.
    expect(by['/shell'].redirect).toBeNull()
    expect(by['/:builtinApp/*'].catchAll).toBe(true)
    expect(by['*'].catchAll).toBe(true)
  })

  it('matches the most static route and never a catch-all', () => {
    expect(matchRoute(routes, '/apps/library')?.path).toBe('/apps/library')
    expect(matchRoute(routes, '/apps/foo')?.path).toBe('/apps/:name')
    expect(matchRoute(routes, '/chat')?.path).toBe('/chat/:slug?')
    expect(matchRoute(routes, '/nowhere')).toBeNull()
  })
})

describe('settings freshness', () => {
  it('passes only when the live extraction reproduces both committed files', () => {
    const same = { liveRegistrySource: 'a', committedRegistrySource: 'a', liveAgentJson: 'b', committedAgentJson: 'b' }
    expect(checkSettingsExtraction(same)).toEqual([])
    expect(checkSettingsExtraction({ ...same, liveRegistrySource: 'a2' })).toEqual([expect.stringMatching(/settingsRegistry\.gen\.ts .*gen:settings/)])
    expect(checkSettingsExtraction({ ...same, liveAgentJson: 'b2' })).toEqual([expect.stringMatching(/settings-registry\.generated\.json .*gen:settings/)])
  })
})

describe('legacy pages and emitted routes', () => {
  const extra = { extraPages: [{ key: 'old', route: '/old' }], extraTitleKeys: { old: 'k.inner' } }

  it('refuses a redirecting page with no canonical location', () => {
    expect(build(extra).errors).toContainEqual(expect.stringMatching(/'\/old' redirects to '\/settings\/chat'; name its canonical location/))
  })

  it('folds a redirecting page into its canonical location as a search alias', () => {
    const { index, errors } = build({ ...extra, legacyPages: { old: 'settings.tab.chat' } })
    expect(errors).toEqual([])
    const ids = index.locations.map(l => l.id)
    expect(ids).not.toContain('page.old')
    const tab = index.locations.find(l => l.id === 'settings.tab.chat') as { alias_keys?: string[] }
    expect(tab.alias_keys).toEqual(['k.inner'])
  })

  it('refuses a canonical location that is not where the redirect lands, and a stale mapping', () => {
    expect(build({ ...extra, legacyPages: { old: 'page.chat' } }).errors).toContainEqual(expect.stringMatching(/redirects to '\/settings\/chat', but 'page.chat' is at '\/chat'/))
    const live = { extraPages: [{ key: 'live', route: '/chat' + '/x' }], extraTitleKeys: { live: 'k.inner' }, legacyPages: { live: 'page.chat' } }
    expect(build(live).errors).toContainEqual(expect.stringMatching(/does not redirect; remove the mapping/))
  })

  it('refuses a registered route that is not in the route table, or only redirects', () => {
    const withRoute = (route: string) => ({
      descriptors: { ...baseInputs().descriptors, 'chat.older': { kind: 'disclosure', placements: [{ surface: 'chat', parent: 'page.chat', entry: 'sidebar', route }] } },
    })
    expect(build(withRoute('/not-a-real-page')).errors).toContainEqual(expect.stringMatching(/'\/not-a-real-page' is not in the dashboard route table/))
    expect(build(withRoute('/old')).errors).toContainEqual(expect.stringMatching(/'\/old' only redirects/))
    expect(build(withRoute('')).errors).toContainEqual(expect.stringMatching(/route '' is empty/))
  })

  it('refuses a generated location whose route is not routed', () => {
    const surfaces = [...baseInputs().surfaces, { navId: 'ghost', route: '/ghost', label: 'G', labelKey: 'nav.chat', group: 'Main' }]
    expect(build({ surfaces }).errors).toContainEqual(expect.stringMatching(/location 'page.ghost' placement 0: route '\/ghost' is not in the dashboard route table/))
  })
})

describe('nested registered placements', () => {
  const inner = { kind: 'button', placements: [{ surface: 'chat', parent: 'chat.older', entry: 'menu' }] }

  it('resolves a child declared before its parent exactly like one declared after', () => {
    const { descriptors: d } = baseInputs()
    const after = build({ descriptors: { ...d, 'chat.inner': inner }, markerSites: [...baseInputs().markerSites, markerFor('chat.inner', 3)] })
    const before = build({ descriptors: { 'chat.inner': inner, ...d }, markerSites: [markerFor('chat.inner', 3), ...baseInputs().markerSites] })
    expect(after.errors).toEqual([])
    expect(before.errors).toEqual([])
    const pick = (r: typeof after) => r.index.locations.find(l => l.id === 'chat.inner')!.placements
    expect(pick(before)).toEqual(pick(after))
    expect(pick(before)[0]).toMatchObject({ route: '/chat', parent_ids: ['page.chat', 'chat.older'] })
    // The parent's prerequisite is inherited, not dropped.
    expect(pick(before)[0].requires).toContainEqual({ kind: 'shown_by', location: 'chat.toggle' })
  })

  const twoPlacementParent = {
    'chat.toggle': { kind: 'toggle', placements: [{ surface: 'chat', parent: 'page.chat', entry: 'toolbar' }] },
    'chat.older': {
      kind: 'disclosure',
      placements: [
        { surface: 'chat', parent: 'page.chat', entry: 'sidebar', requires: [{ kind: 'viewport', value: 'desktop' }, { kind: 'shown_by', location: 'chat.toggle' }] },
        { surface: 'chat', parent: 'page.chat', entry: 'sidebar', requires: [{ kind: 'viewport', value: 'mobile' }] },
      ],
    },
  }
  const sites3 = [...baseInputs().markerSites, markerFor('chat.inner', 3)]

  it('refuses an unqualified child of a parent with two different placements', () => {
    const { errors } = build({ descriptors: { 'chat.inner': inner, ...twoPlacementParent }, markerSites: sites3 })
    expect(errors).toContainEqual(expect.stringMatching(/has 2 different compatible placements; add a viewport requirement or name parentPlacement/))
  })

  it('picks the viewport-compatible parent placement and inherits its requirements', () => {
    const mobileInner = { kind: 'button', placements: [{ surface: 'chat', parent: 'chat.older', entry: 'menu', requires: [{ kind: 'viewport', value: 'mobile' }] }] }
    const { index, errors } = build({ descriptors: { 'chat.inner': mobileInner, ...twoPlacementParent }, markerSites: sites3 })
    expect(errors).toEqual([])
    expect(index.locations.find(l => l.id === 'chat.inner')!.placements[0].requires).toEqual([{ kind: 'viewport', value: 'mobile' }])
    const named = { kind: 'button', placements: [{ surface: 'chat', parent: 'chat.older', entry: 'menu', parentPlacement: 0 }] }
    const r = build({ descriptors: { 'chat.inner': named, ...twoPlacementParent }, markerSites: sites3 })
    expect(r.errors).toEqual([])
    expect(r.index.locations.find(l => l.id === 'chat.inner')!.placements[0].requires).toEqual([
      { kind: 'viewport', value: 'desktop' }, { kind: 'shown_by', location: 'chat.toggle' },
    ])
  })
})

describe('prerequisite vocabulary and guide bindings', () => {
  const older = (requires: unknown[], extra: Record<string, unknown> = {}) => ({
    descriptors: { ...baseInputs().descriptors, 'chat.older': { kind: 'disclosure', placements: [{ surface: 'chat', parent: 'page.chat', entry: 'sidebar', requires }], ...extra } },
  })

  it('refuses a condition or reveal state the shared table does not define', () => {
    expect(build(older([{ kind: 'condition', id: 'nope' }])).errors).toContainEqual(expect.stringMatching(/unknown condition 'nope' \(add it to src\/uiLocations\/conditions\.ts\)/))
    expect(build(older([{ kind: 'shown_by', location: 'chat.toggle', when: 'nope' }])).errors).toContainEqual(expect.stringMatching(/unknown reveal state 'nope'/))
  })

  it('carries a conditional reveal step and the vocabulary descriptions into the index', () => {
    const { index, errors } = build(older([{ kind: 'shown_by', location: 'chat.toggle', when: 'sessions_sidebar_collapsed' }]))
    expect(errors).toEqual([])
    const loc = index.locations.find(l => l.id === 'chat.older')!
    expect(loc.placements[0].requires).toEqual([{ kind: 'shown_by', location: 'chat.toggle', when: 'sessions_sidebar_collapsed' }])
    const raw = index as unknown as { conditions: Record<string, string>; reveal_states: Record<string, string> }
    expect(raw.conditions).toEqual(UI_CONDITIONS)
    expect(raw.reveal_states).toEqual(UI_REVEAL_STATES)
  })

  it('emits a guide binding only when the guide catalog accepts it', () => {
    const ok = build(older([], { guide: { action: 'ok.action' } }))
    expect(ok.errors).toEqual([])
    expect((ok.index.locations.find(l => l.id === 'chat.older') as { guide_ref?: unknown }).guide_ref).toEqual({ action_id: 'ok.action' })
    const sensitive = build(older([], { guide: { action: 'settings.show', params: { setting_id: 'developer.jev-api-key' } } }))
    expect(sensitive.errors).toContainEqual(expect.stringMatching(/guide binding settings\.show is refused by the guide catalog/))
    expect(build({ ...older([], { guide: { action: 'ok.action' } }), resolveGuide: null }).errors)
      .toContainEqual(expect.stringMatching(/no guide catalog was given/))
  })
})

describe('index assembly, continued', () => {
  it('fails on an id generated twice', () => {
    const settingsTabs = [{ id: 'chat', key: 'tab.chat' }, { id: 'chat', key: 'tab.chat' }]
    expect(build({ settingsTabs }).errors.some(e => /duplicate location id 'settings.tab.chat'/.test(e))).toBe(true)
  })

  it('serializes deterministically and changes when a label changes (the --check oracle)', () => {
    const a = serializeIndex(build().index)
    expect(serializeIndex(build().index)).toBe(a)
    const mutated = serializeIndex(build({ catalogs: { en: EN, 'zh-CN': { ...ZH, 'k.older': '旧会话' } } }).index)
    expect(mutated).not.toBe(a)
    expect(JSON.parse(a).locations.length).toBeGreaterThan(0)
  })
})

describe('per-area descriptor files', () => {
  const d = (surface = 'chat') => ({ kind: 'button', placements: [{ surface, parent: 'page.chat', entry: 'toolbar' }] })

  it('merges disjoint areas into one table', () => {
    const r = mergeLocationAreas({ chat: { 'chat.a': d() }, schedule: { 'schedule.b': d() } }, ['chat', 'schedule'])
    expect(r.errors).toEqual([])
    expect(Object.keys(r.descriptors)).toEqual(['chat.a', 'schedule.b'])
  })

  it('refuses an id two areas declare, naming both', () => {
    const r = mergeLocationAreas({ chat: { 'chat.a': d() }, shell: { 'chat.a': d('shell') } }, ['chat', 'shell'])
    expect(r.errors).toEqual([expect.stringMatching(/ui location 'chat\.a' is declared in two areas \('chat' and 'shell'\)/)])
  })

  it('refuses an area file the aggregator does not list, and an area with no file', () => {
    const unlisted = mergeLocationAreas({ chat: {} }, ['chat', 'apps'])
    expect(unlisted.errors).toEqual([expect.stringMatching(/areas\/apps\.ts is not listed in UI_LOCATION_AREAS/)])
    const fileless = mergeLocationAreas({ chat: {}, ghost: {} }, ['chat'])
    expect(fileless.errors).toEqual([expect.stringMatching(/names area 'ghost', but there is no src\/uiLocations\/areas\/ghost\.ts/)])
  })

  it('the shipped areas match their files and lose no id to the aggregating spread', () => {
    const areasDir = path.resolve(__dirname, 'areas')
    const files = fs.readdirSync(areasDir).filter(n => n.endsWith('.ts')).map(n => n.replace(/\.ts$/, '')).sort()
    const r = mergeLocationAreas(UI_LOCATION_AREAS, files)
    expect(r.errors).toEqual([])
    const total = Object.values(UI_LOCATION_AREAS).reduce((n, area) => n + Object.keys(area).length, 0)
    expect(Object.keys(UI_LOCATIONS)).toHaveLength(total)
    expect(Object.keys(r.descriptors).sort()).toEqual(Object.keys(UI_LOCATIONS).sort())
  })
})

describe('shell placements', () => {
  const shell = (placement: Record<string, unknown>) => ({
    descriptors: { ...baseInputs().descriptors, 'shell.x': { kind: 'button', placements: [placement] } },
    markerSites: [...baseInputs().markerSites, { id: 'shell.x', rel: 'F.tsx', line: 7, resolved: { source: { key: 'k.inner' }, excluded: [] } }],
  })

  it('is on every page: no parent, no route, its own surface id', () => {
    const { index, errors } = build(shell({ surface: 'shell', entry: 'header', requires: [{ kind: 'viewport', value: 'desktop' }] }))
    expect(errors).toEqual([])
    expect(index.locations.find(l => l.id === 'shell.x')!.placements).toEqual([
      { surface_id: 'shell', route: '', parent_ids: [], entry_kind: 'header', requires: [{ kind: 'viewport', value: 'desktop' }] },
    ])
    expect((index as unknown as { surfaces: string[] }).surfaces).toContain('shell')
  })

  it('refuses a route on a shell placement, and a page parent', () => {
    expect(build(shell({ surface: 'shell', entry: 'header', route: '/chat' })).errors)
      .toContainEqual(expect.stringMatching(/a 'shell' placement takes no route/))
    expect(build(shell({ surface: 'shell', entry: 'header', parent: 'page.chat' })).errors)
      .toContainEqual(expect.stringMatching(/can only hang under another registered shell location, not 'page\.chat'/))
    // A registered page control is no shell parent either.
    expect(build(shell({ surface: 'shell', entry: 'menu', parent: 'chat.older' })).errors)
      .toContainEqual(expect.stringMatching(/can only hang under another registered shell location, not 'chat\.older'/))
  })

  // Two shell controls: a menu button and a row inside the menu it opens.
  const menu = (row: Record<string, unknown>, button: Record<string, unknown> = { surface: 'shell', entry: 'header', requires: [{ kind: 'viewport', value: 'mobile' }] }) => ({
    descriptors: {
      ...baseInputs().descriptors,
      // Declared child first: resolution order must not depend on it.
      'shell.row': { kind: 'button', placements: [row] },
      'shell.menu': { kind: 'button', placements: [button] },
    },
    markerSites: [...baseInputs().markerSites, markerFor('shell.row', 8), markerFor('shell.menu', 9)],
  })

  it('hangs a shell child under a shell parent, inheriting its path and requirements', () => {
    const { index, errors } = build(menu({
      surface: 'shell', parent: 'shell.menu', entry: 'menu', requires: [{ kind: 'condition', id: 'search_bar_unclaimed' }],
    }))
    expect(errors).toEqual([])
    expect(index.locations.find(l => l.id === 'shell.row')!.placements).toEqual([{
      surface_id: 'shell', route: '', parent_ids: ['shell.menu'], entry_kind: 'menu',
      requires: [{ kind: 'viewport', value: 'mobile' }, { kind: 'condition', id: 'search_bar_unclaimed' }],
    }])
  })

  it('picks among a shell parent\'s placements like a page child does', () => {
    const two = { surface: 'shell', entry: 'header' }
    const desktop = { ...two, requires: [{ kind: 'viewport', value: 'desktop' }] }
    const mobile = { ...two, requires: [{ kind: 'viewport', value: 'mobile' }] }
    const over = (row: Record<string, unknown>) => {
      const m = menu(row)
      return { ...m, descriptors: { ...m.descriptors, 'shell.menu': { kind: 'button', placements: [desktop, mobile] } } }
    }
    expect(build(over({ surface: 'shell', parent: 'shell.menu', entry: 'menu' })).errors)
      .toContainEqual(expect.stringMatching(/parent 'shell\.menu' has 2 different compatible placements/))
    const { index, errors } = build(over({ surface: 'shell', parent: 'shell.menu', entry: 'menu', requires: [{ kind: 'viewport', value: 'mobile' }] }))
    expect(errors).toEqual([])
    expect(index.locations.find(l => l.id === 'shell.row')!.placements[0].requires).toEqual([{ kind: 'viewport', value: 'mobile' }])
  })

  it('refuses a page child of a shell child too', () => {
    const m = menu({ surface: 'shell', parent: 'shell.menu', entry: 'menu' })
    const r = build({
      descriptors: { ...m.descriptors, 'chat.deep': { kind: 'button', placements: [{ surface: 'chat', parent: 'shell.row', entry: 'menu' }] } },
      markerSites: [...m.markerSites, markerFor('chat.deep', 10)],
    })
    expect(r.errors).toContainEqual(expect.stringMatching(/parent 'shell\.row' has no placement on surface 'chat'/))
  })

  it('refuses a page child of a shell control (no shared surface to hang under)', () => {
    const r = build({
      ...shell({ surface: 'shell', entry: 'header' }),
      descriptors: { ...shell({ surface: 'shell', entry: 'header' }).descriptors, 'chat.inner': { kind: 'button', placements: [{ surface: 'chat', parent: 'shell.x', entry: 'menu' }] } },
      markerSites: [...shell({}).markerSites, { id: 'chat.inner', rel: 'F.tsx', line: 8, resolved: { source: { key: 'k.inner' }, excluded: [] } }],
    })
    expect(r.errors).toContainEqual(expect.stringMatching(/parent 'shell\.x' has no placement on surface 'chat'/))
  })

  it('refuses a rail surface that takes the reserved id', () => {
    const surfaces = [...baseInputs().surfaces, { navId: 'shell', route: '/chat', label: 'S', labelKey: 'nav.chat', group: 'Main' }]
    expect(build({ surfaces }).errors).toContainEqual(expect.stringMatching(/collides with the reserved shell surface id/))
  })
})

describe('tabs of other side-panel pages', () => {
  it('indexes each tab under its page at the explicit ?tab= route, with the page\'s gates', () => {
    const surfaces = [...baseInputs().surfaces, { navId: 'dev', route: '/chat', label: 'Dev', labelKey: 'nav.chat', group: 'Main' }]
    const { index, errors } = build({ surfaces, pageTabs: { dev: [{ id: 'logs', key: 'tab.chat' }] } })
    expect(errors).toEqual([])
    expect(index.locations.find(l => l.id === 'tab.dev.logs')!.placements).toEqual([
      { surface_id: 'dev', route: '/chat?tab=logs', parent_ids: ['page.dev'], entry_kind: 'tab', requires: [] },
    ])
  })

  it('refuses tabs for a page the index does not have', () => {
    expect(build({ pageTabs: { ghost: [{ id: 'x', key: 'tab.chat' }] } }).errors).toContainEqual("page tabs for unknown page 'ghost'")
  })
})

describe('gen:ui --out', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/gen-ui-index.mjs'), ...args], { encoding: 'utf-8' })
  const COMMITTED = path.resolve(__dirname, '../../../src/kiro_crew/docs/ui-index.generated.json')

  it('refuses the committed index as a target, so a batch can never overwrite it', () => {
    const before = fs.readFileSync(COMMITTED)
    const r = run('--out', COMMITTED)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--out must not be the committed index/)
    expect(fs.readFileSync(COMMITTED).equals(before)).toBe(true)
  })

  it('refuses --out with --check, and --out with no file', () => {
    expect(run('--out', 'scratch-index.json', '--check').stderr).toMatch(/Pick one/)
    expect(run('--out').stderr).toMatch(/--out needs a file path/)
    expect(run('--out', '--check').stderr).toMatch(/--out needs a file path/)
  })

  it('refuses to write the build-time auto tier next to the committed index, or with no file', () => {
    const r = run('--auto-out', path.join(path.dirname(COMMITTED), 'ui-index.auto.json'))
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--auto-out must not be in src\/kiro_crew\/docs/)
    expect(fs.existsSync(path.join(path.dirname(COMMITTED), 'ui-index.auto.json'))).toBe(false)
    expect(run('--auto-out').stderr).toMatch(/--auto-out needs a file path/)
  })
})

describe('labels that are runtime data (label.from description)', () => {
  const DESC = 'uiLocations.description.chip'
  const chip = (attrs: string, body = 'Go') => `${HEADER}
export function Chip({ name }: { name: string }) {
  const shown = i18nT('k.model', { name })
  return <button {...uiLocation('chat.chip')} ${attrs}>${body}</button>
}`
  const resolved = (source: string, label: Record<string, unknown>) =>
    sitesOf(source, { 'chat.chip': { label } }).sites[0].resolved as { error?: string; source?: { key: string }; description?: boolean }

  it('takes the static description when the named attribute really is dynamic', () => {
    const r = resolved(chip('aria-label={shown}'), { from: 'description', attr: 'aria-label', key: DESC })
    expect(r.error).toBeUndefined()
    expect(r.source).toEqual({ key: DESC })
    expect(r.description).toBe(true)
  })

  it('takes it for dynamic visible text too', () => {
    const r = resolved(chip('', '<span>{shown}</span>'), { from: 'description', key: DESC })
    expect(r.error).toBeUndefined()
    expect(r.description).toBe(true)
  })

  it('refuses a description where the site has a static label to read', () => {
    expect(resolved(chip("aria-label={i18nT('k.static')}"), { from: 'description', attr: 'aria-label', key: DESC }).error)
      .toMatch(/renders a static label \(k\.static\); use label\.from 'attr', not a description/)
    expect(resolved(chip('', "{i18nT('k.static')}"), { from: 'description', key: DESC }).error)
      .toMatch(/renders a static label/)
  })

  it('refuses a missing attribute and a key outside the description namespace', () => {
    expect(resolved(chip(''), { from: 'description', attr: 'aria-label', key: DESC }).error).toMatch(/has no aria-label attribute/)
    expect(resolved(chip('aria-label={shown}'), { from: 'description', attr: 'aria-label', key: 'k.model' }).error)
      .toMatch(/description key must be a catalog key under 'uiLocations\.description\.'/)
  })

  const described = (over: { en?: Record<string, string>; zh?: Record<string, string>; extra?: Record<string, unknown> } = {}) => ({
    descriptors: { ...baseInputs().descriptors, 'chat.chip': { kind: 'button', placements: [{ surface: 'chat', parent: 'page.chat', entry: 'toolbar' }] }, ...over.extra },
    markerSites: [...baseInputs().markerSites, { id: 'chat.chip', rel: 'F.tsx', line: 5, resolved: { source: { key: DESC }, excluded: [], description: true } }],
    catalogs: { en: { ...EN, [DESC]: 'The model chip', ...over.en }, 'zh-CN': { ...ZH, [DESC]: '模型按钮', ...over.zh } },
  })

  it('marks the location label_kind description in the index', () => {
    const { index, errors } = build(described())
    expect(errors).toEqual([])
    const loc = index.locations.find(l => l.id === 'chat.chip') as unknown as { label_key: string; label_kind?: string }
    expect(loc).toMatchObject({ label_key: DESC, label_kind: 'description' })
    expect(index.labels['zh-CN'][DESC]).toBe('模型按钮')
    expect((index.locations.find(l => l.id === 'chat.older') as unknown as { label_kind?: string }).label_kind).toBeUndefined()
  })

  it('requires the description in every shipped locale', () => {
    const r = build({ ...described(), catalogs: { en: { ...EN, [DESC]: 'The model chip' }, 'zh-CN': ZH } })
    expect(r.errors).toContainEqual(expect.stringMatching(/description 'uiLocations\.description\.chip' is missing in zh-CN/))
  })

  it('never lets a description be a step in another path', () => {
    const under = described({ extra: { 'chat.older': { kind: 'disclosure', placements: [{ surface: 'chat', parent: 'chat.chip', entry: 'menu' }] } } })
    expect(build(under).errors).toContainEqual(expect.stringMatching(/parent 'chat\.chip' has only a description/))
    const shownBy = described({ extra: { 'chat.older': { kind: 'disclosure', placements: [{ surface: 'chat', parent: 'page.chat', entry: 'menu', requires: [{ kind: 'shown_by', location: 'chat.chip' }] }] } } })
    expect(build(shownBy).errors).toContainEqual(expect.stringMatching(/shown_by 'chat\.chip' has only a description/))
  })

  it('never lets an ordinary label or alias be a description key', () => {
    const asLabel = { ...described(), markerSites: [...baseInputs().markerSites, { id: 'chat.chip', rel: 'F.tsx', line: 5, resolved: { source: { key: DESC }, excluded: [] } }] }
    expect(build(asLabel).errors).toContainEqual(expect.stringMatching(/is a find_ui description, only for label\.from 'description'/))
    const asAlias = described({ extra: { 'chat.older': { ...baseInputs().descriptors['chat.older'], aliasKeys: [DESC] } } })
    expect(build(asAlias).errors).toContainEqual(expect.stringMatching(/alias key 'uiLocations\.description\.chip' is a find_ui description/))
  })
})

// ---------------------------------------------------------------- the committed index

// UI_INDEX_FILE points these goldens at an index written by
// `npm run gen:ui -- --out <file>`, so parallel area batches each check their
// own index; unset, they read the committed one.
const INDEX_FILE = process.env.UI_INDEX_FILE
  ? path.resolve(process.env.UI_INDEX_FILE)
  : path.resolve(__dirname, '../../../src/kiro_crew/docs/ui-index.generated.json')
const committed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8')) as Index
const byId = new Map(committed.locations.map(l => [l.id, l]))

describe('the committed index', () => {
  it('ships the 12 authored locales and not the pseudolocale', () => {
    expect(committed.locales).toHaveLength(12)
    expect(committed.locales).not.toContain('en-XA')
  })

  it('places Older Sessions under Sessions in English and Chinese', () => {
    const older = byId.get('chat.older-sessions')!
    expect(older.placements.map(p => p.parent_ids)).toEqual([['page.chat'], ['page.chat']])
    expect(committed.labels.en[older.label_key]).toBe('Older Sessions')
    expect(committed.labels['zh-CN'][older.label_key]).toBe('较早的会话')
    expect(committed.labels.en[byId.get('page.chat')!.label_key]).toBe('Sessions')
    expect(committed.labels['zh-CN'][byId.get('page.chat')!.label_key]).toBe('会话')
    expect(older.placements[0].requires).toContainEqual({ kind: 'shown_by', location: 'chat.sessions-sidebar-toggle', when: 'sessions_sidebar_collapsed' })
    expect(older.placements[1].requires).toContainEqual({ kind: 'shown_by', location: 'chat.mobile-sessions-toggle', when: 'sessions_drawer_closed' })
    // The toggle keeps its own qualifications; find_ui hands them on with the step.
    expect(byId.get('chat.sessions-sidebar-toggle')!.placements[0].requires).toEqual([
      { kind: 'viewport', value: 'desktop' },
      { kind: 'condition', id: 'has_open_sessions' },
      { kind: 'condition', id: 'full_dashboard' },
    ])
  })

  it('projects every Settings control, joined by its stable id', () => {
    const settings = committed.locations.filter(l => l.kind === 'setting')
    expect(settings.map(s => s.setting_id).sort()).toEqual(SETTINGS_REGISTRY.map(e => e.id).sort())
    const preview = byId.get('setting:chat.link-previews')!
    expect(preview.placements[0].parent_ids).toEqual(['page.settings', 'settings.tab.chat', 'settings.sub.chat.transcript'])
  })

  it('gates Crewmates on its preview flag and names the setting that enables it', () => {
    expect(byId.get('page.members')!.placements[0].requires).toEqual([
      { kind: 'preview_flag', flag: 'mc-preview-crew', location: 'setting:developer.crewmates' },
    ])
  })

  it('resolves every parent, prerequisite and label it references', () => {
    for (const loc of committed.locations) {
      expect(committed.labels.en[loc.label_key] ?? '').not.toBe('')
      for (const p of loc.placements) {
        for (const id of p.parent_ids) expect(byId.has(id)).toBe(true)
        for (const r of p.requires) if (r.location) expect(byId.has(r.location)).toBe(true)
      }
    }
  })

  it('ships the newcomer terms for Older Sessions in English and Chinese', () => {
    const terms = byId.get('chat.older-sessions')!.terms!
    expect(terms.en).toEqual(expect.arrayContaining(['old chats', 'past conversations', 'chat history']))
    expect(terms['zh-CN']).toEqual(expect.arrayContaining(['历史对话', '以前的聊天']))
    expect(byId.get('setting:display.mode')!.terms!.en).toContain('dark mode')
  })

  it('registers every described location', () => {
    for (const id of Object.keys(UI_LOCATIONS)) expect(byId.has(id)).toBe(true)
  })

  it('never hands out a route that only redirects, and every route is routed', () => {
    const appPath = path.resolve(__dirname, '../App.tsx')
    const { routes } = collectRouteTable(fs.readFileSync(appPath, 'utf-8'), appPath, 'src/App.tsx') as { routes: { path: string; redirect: string | null; catchAll: boolean }[] }
    const appOnly = new Set(['/projects'])
    for (const loc of committed.locations) {
      for (const p of loc.placements) {
        if (p.surface_id === 'shell') {
          // On every page; there is no route to hand out.
          expect(p.route).toBe('')
          continue
        }
        const hit = matchRoute(routes, p.route) as { redirect: string | null } | null
        if (!hit) expect(appOnly.has(p.route.split('?')[0])).toBe(true)
        else expect(hit.redirect).toBeNull()
      }
    }
  })

  it('folds the legacy Search Everywhere pages into explicit canonical locations', () => {
    for (const key of Object.keys(LEGACY_PAGE_CANONICAL)) expect(byId.has(`page.${key}`)).toBe(false)
    const crews = byId.get('tab.capabilities.crews') as { alias_keys?: string[]; placements: { route: string }[] }
    expect(crews.placements[0].route).toBe('/capabilities?tab=crews')
    expect(crews.alias_keys).toContain('components.commandPalette.providers.pagesProvider.kirocrew_agents')
    // "Tasks" keeps the Task Runner page's own gate.
    const projects = byId.get('page.projects')!
    expect(projects.placements[0].requires).toEqual([{ kind: 'condition', id: 'app_enabled' }])
  })

  it('names an explicit tab for every Customize location, so a remembered tab cannot answer instead', () => {
    for (const loc of committed.locations) {
      if (loc.id === 'page.capabilities') continue
      for (const p of loc.placements) if (p.route.startsWith('/capabilities')) expect(p.route).toMatch(/^\/capabilities\?tab=[a-z-]+$/)
    }
  })

  it('places the wave-2 creation controls under their real hosts, qualified by the state that draws them', () => {
    const en = committed.labels.en
    const zh = committed.labels['zh-CN']
    const at = (id: string) => byId.get(id)!
    // New chat: the sidebar button (reached like Older Sessions) and the empty pane.
    expect(at('chat.new-session').placements.map(p => p.parent_ids)).toEqual([['page.chat'], ['page.chat']])
    expect(en[at('chat.new-session').label_key]).toBe('New chat session')
    expect(at('chat.start-new-chat').placements[0].requires).toEqual([{ kind: 'condition', id: 'no_active_session' }])
    // Schedule: both creation sites, never on screen together.
    expect(at('schedule.create-first').placements[0].requires).toEqual([{ kind: 'condition', id: 'no_schedules' }])
    expect(at('schedule.add-job').placements[0]).toMatchObject({ route: '/schedule', parent_ids: ['page.schedule'], requires: [{ kind: 'condition', id: 'has_schedules' }] })
    expect(en[at('schedule.add-job').label_key]).toBe('Add Job')
    expect(zh[at('schedule.add-job').label_key]).toBe('添加任务')
    // Artifacts: import hangs under the desktop caret menu.
    expect(at('artifacts.import').placements[0]).toMatchObject({ route: '/artifacts', parent_ids: ['page.artifacts', 'artifacts.add-menu'], entry_kind: 'menu' })
    // MCP: Connections opens on Services, so the MCP Servers sub-tab is in the path.
    for (const id of ['mcp.add-custom', 'mcp.add-server']) {
      expect(at(id).placements[0]).toMatchObject({
        route: '/capabilities?tab=mcp',
        parent_ids: ['page.capabilities', 'tab.capabilities.mcp', 'connections.mcp-servers-tab'],
      })
    }
    expect(zh[at('connections.mcp-servers-tab').label_key]).toBe('MCP 服务器')
    expect((at('mcp.add-custom') as { guide_ref?: unknown }).guide_ref).toEqual({ action_id: 'mcp.open_add' })
    expect((at('mcp.add-server') as { guide_ref?: unknown }).guide_ref).toBeUndefined()
    // Search Everywhere: shell chrome, on every page.
    expect(at('shell.search').placements[0]).toMatchObject({ surface_id: 'shell', route: '', parent_ids: [] })
  })

  it('hangs the phone menu Search row under the menu button, with the button\'s gates', () => {
    const at = (id: string) => byId.get(id)!
    expect(at('shell.menu-search').placements).toEqual([{
      surface_id: 'shell', route: '', parent_ids: ['shell.mobile-menu'], entry_kind: 'menu',
      requires: [
        { kind: 'viewport', value: 'mobile' },
        { kind: 'condition', id: 'not_on_sessions_page' },
        { kind: 'condition', id: 'search_bar_unclaimed' },
      ],
    }])
    expect(committed.labels.en[at('shell.mobile-menu').label_key]).toBe('Open menu')
    expect(committed.labels['zh-CN'][at('shell.menu-search').label_key]).toBe('搜索会话、文件和命令')
  })

  it('describes the runtime-labelled chips instead of quoting a label, in every locale', () => {
    for (const id of ['chat.model-picker', 'chat.memory-mode']) {
      const loc = byId.get(id) as unknown as { label_key: string; label_kind?: string }
      expect(loc.label_kind).toBe('description')
      expect(loc.label_key.startsWith('uiLocations.description.')).toBe(true)
      for (const locale of committed.locales) expect(committed.labels[locale][loc.label_key] ?? '').not.toBe('')
    }
    expect(byId.get('chat.model-picker')!.placements[0].requires).toEqual([
      { kind: 'condition', id: 'session_open' },
      // The shelf unmounts with a collapsed message box.
      { kind: 'shown_by', location: 'composer.expand', when: 'composer_collapsed' },
      { kind: 'condition', id: 'no_response_running' },
    ])
    expect(byId.get('chat.memory-mode')!.placements[0].requires).toEqual([{ kind: 'condition', id: 'empty_session' }])
    // Only a description location carries a description key.
    for (const loc of committed.locations as unknown as { label_key: string; label_kind?: string }[]) {
      expect(loc.label_key.startsWith('uiLocations.description.')).toBe(loc.label_kind === 'description')
    }
  })
})
