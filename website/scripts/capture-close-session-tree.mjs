/**
 * Screenshot harness, and behaviour check, for the close-tree guard (#17253).
 *
 * Option B: the ✕ REFUSES while any descendant is running, and closes the whole
 * subtree silently when none are. There is no "close anyway" button.
 *
 * This ASSERTS as well as photographs. Every beat checks the behaviour before
 * photographing it; a wrong frame exits non-zero rather than ships as evidence.
 *
 * Beats:
 *   1. the conductor lane, tree expanded, nothing asked          tree.png
 *   2. ✕ on the lead (3 sessions mid-turn) → blocked notice      blocked.png
 *   3. dismiss the notice → nothing closed, tree unchanged        dismissed.png
 *   4. ✕ on the same tree with every worker now finished
 *      → closes whole subtree with NO prompt (pref off)           idle-before.png / idle-after.png
 *   4b. same tree, preference ON → in-app confirm, then closes    pref-confirm.png
 *   5. ✕ on a leaf card → no prompt                             (assertion only)
 *   6. one close refused by the server → partial-failure notice   refused.png
 *   7. phone: row menu close → same blocked notice               phone-menu.png / phone-blocked.png
 *
 * Usage:
 *   npx vite --host 127.0.0.1 --port 6186 --strictPort      # in another shell
 *   node scripts/capture-close-session-tree.mjs http://127.0.0.1:6186 [outDir]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { chromiumExecutable } from './lib/chromium-executable.mjs'
import { stubDashboardApi, logPageProblems } from './lib/stub-dashboard-api.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:6186'
const OUT = process.argv[3] || '../temp-screenshots/close-session-tree'
const LEAD = 'chat-lead'
const SOLO = 'chat-solo'
const SUBTREE = ['chat-babysit', 'chat-rerun', 'chat-logs', 'chat-locale']

mkdirSync(OUT, { recursive: true })

let failed = false
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

const browser = await chromium.launch({ executablePath: chromiumExecutable() })
// Wide enough that the sidebar renders its DESKTOP row cluster: below the mobile
// breakpoint a row drops the hover ✕ for a single ⋯ menu.
const context = await browser.newContext({ viewport: { width: 1040, height: 780 }, deviceScaleFactor: 2 })
const page = await context.newPage()
page.on('pageerror', e => { console.log(`FAIL pageerror — ${e.message}`); failed = true })

/** Every DELETE the close path sends, in order. */
const deleted = []
/** Keys whose DELETE the stub refuses (server-side close refusal). */
const refuse = new Set()
const REFUSED_ROW = {
  key: 'chat-babysit', title: 'worker: pull-request babysit', messages: 12, running: false,
  agent: 'kirocrew-worker', last_ts: new Date().toISOString(), last_message: 'Waiting on the review lane.',
  parent: null,
}
const SOLO_ROW = {
  key: SOLO, title: 'Notes: release checklist', messages: 12, running: false,
  agent: 'kirocrew', last_ts: new Date().toISOString(), last_message: 'Nothing under this one.',
  parent: null,
}
const PHONE = { width: 400, height: 820 }

await stubDashboardApi(page, {
  theme: 'dark',
  folders: [],
  extra: async (path, route) => {
    if (route.request().method() === 'DELETE' && path.startsWith('/api/chat/slots/')) {
      const key = decodeURIComponent(path.slice('/api/chat/slots/'.length))
      deleted.push(key)
      if (refuse.has(key)) {
        await route.fulfill({
          status: 500, contentType: 'application/json',
          body: JSON.stringify({
            error: 'a history write for this conversation is still running; the tab stays open, close it again in a moment',
            code: 'history_write_running',
          }),
        })
        return true
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
      return true
    }
    // A refused close refetches the slot list; answer with what would still be there.
    if (path === '/api/chat/slots' && refuse.size > 0) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([REFUSED_ROW, SOLO_ROW]) })
      return true
    }
    // The dev server serves source modules by their own path; the stub's `**/api/**`
    // pattern also matches `/src/api/client.ts`.
    if (path.startsWith('/api/')) return false
    await route.continue()
    return true
  },
})
logPageProblems(page)

const PANEL = { x: 0, y: 0, width: 540, height: 780 }
const rowKeys = () => page.$$eval('[data-slot-key]', els => els.map(el => el.getAttribute('data-slot-key')))
const dialog = () => page.locator('[role="dialog"]')

/** Press the ✕ on one row. Hover first: it is a reveal-on-hover control. */
async function pressClose(key) {
  const row = page.locator(`[data-slot-key="${key}"]`).first()
  await row.hover()
  await row.locator('[aria-label="Close session"]').first().click()
}

/** Load one case of the harness and wait for the lane to paint. */
async function open(query = '') {
  await page.goto(`${BASE}/capture/close-session-tree.html?theme=dark${query}`)
  await page.waitForSelector('[data-capture-ready]')
  await page.waitForSelector(`[data-slot-key="${LEAD}"]`)
  await page.waitForTimeout(400)
}

await open()

// ── 1. the tree, before anything is pressed ────────────────────────────────
const before = await rowKeys()
check('the lane nests the whole subtree under the lead',
  SUBTREE.every(k => before.includes(k)), before.join(', '))
await page.screenshot({ path: `${OUT}/tree.png`, clip: PANEL })

// ── 2. ✕ on a running lead → blocked notice (no "close anyway") ───────────
await pressClose(LEAD)
await dialog().waitFor({ state: 'visible', timeout: 5000 })
await page.locator('[data-testid="close-tree-levels"]').waitFor({ state: 'visible', timeout: 5000 })
await page.waitForTimeout(350)
check('nothing closed while the notice is open', deleted.length === 0, deleted.join(', '))

const text = await dialog().innerText()
const says = needle => text.toLowerCase().includes(needle.toLowerCase())
check('the notice counts running sessions', /3 of 5/.test(text), text.split('\n')[1])
for (const level of ['This session', 'Nested 1 deep', 'Nested 2 deep']) {
  check(`the notice lists ${level}`, says(level))
}
const marks = await page.$$eval('[data-testid^="close-tree-session-"]', els => Object.fromEntries(
  els.map(el => [el.getAttribute('data-testid').replace('close-tree-session-', ''), el.innerText.trim()]),
))
const marked = (key, word) => (marks[key] || '').toLowerCase().endsWith(word)
check('the notice marks mid-turn sessions',
  ['chat-lead', 'chat-babysit', 'chat-rerun'].every(k => marked(k, 'running')), JSON.stringify(marks))
check('the notice marks finished sessions',
  ['chat-logs', 'chat-locale'].every(k => marked(k, 'finished')), JSON.stringify(marks))
check('the notice names every session', Object.keys(marks).length === 5, Object.keys(marks).join(', '))
// Option B: dismiss only, NO "close anyway" button.
check('the dismiss button is present', await page.getByTestId('close-tree-dismiss').isVisible())
check('there is no close-all button', !(await page.getByRole('button', { name: /Close all/i }).isVisible()))
await page.screenshot({ path: `${OUT}/blocked.png` })

// ── 3. dismiss → nothing closes, tree unchanged ────────────────────────────
await page.getByTestId('close-tree-dismiss').click()
await dialog().waitFor({ state: 'hidden', timeout: 5000 })
await page.waitForTimeout(350)
check('dismiss closed nothing', deleted.length === 0, deleted.join(', '))
const afterDismiss = await rowKeys()
check('dismiss left every row on screen',
  [LEAD, ...SUBTREE].every(k => afterDismiss.includes(k)), afterDismiss.join(', '))
await page.screenshot({ path: `${OUT}/dismissed.png`, clip: PANEL })

// ── 4. finished subtree → closes whole tree with NO prompt ─────────────────
deleted.length = 0
await open('&finished=1')
await page.screenshot({ path: `${OUT}/idle-before.png`, clip: PANEL })
await pressClose(LEAD)
await page.waitForFunction(() => !document.querySelector('[data-slot-key="chat-lead"]'), null, { timeout: 8000 })
await page.waitForTimeout(400)
check('a finished subtree raises no prompt', await dialog().count() === 0)
check('a finished subtree closes whole, deepest first',
  deleted.length === 5 && deleted.at(-1) === LEAD, deleted.join(' -> '))
check('a child closes before its own parent',
  deleted.indexOf('chat-rerun') < deleted.indexOf('chat-babysit'), deleted.join(' -> '))
const afterIdle = await rowKeys()
check('only the unrelated session is left',
  afterIdle.includes(SOLO) && !afterIdle.includes(LEAD), afterIdle.join(', '))
await page.screenshot({ path: `${OUT}/idle-after.png`, clip: PANEL })

// ── 4b. same tree, preference ON → in-app confirm (useConfirm, not window.confirm) ─
deleted.length = 0
await open('&finished=1&confirmclose=1')
await pressClose(LEAD)
await dialog().waitFor({ state: 'visible', timeout: 5000 })
await page.waitForTimeout(350)
check('the preference confirm opens', await page.getByRole('button', { name: /Close all/i }).isVisible())
check('nothing closed while the pref confirm is open', deleted.length === 0, deleted.join(', '))
await page.screenshot({ path: `${OUT}/pref-confirm.png` })
await page.getByRole('button', { name: /Close all/i }).click()
await page.waitForFunction(() => !document.querySelector('[data-slot-key="chat-lead"]'), null, { timeout: 8000 })
check('pref confirm closes the whole tree', deleted.length === 5 && deleted.at(-1) === LEAD, deleted.join(' -> '))

// ── 5. leaf card → no prompt, delegates to single-session close ────────────
// Load a fresh page with preference off so the leaf close is not gated by
// window.confirm (which playwright dismisses automatically).
deleted.length = 0
await open('')
await pressClose(SOLO)
await page.waitForTimeout(600)
check('a leaf card raises no prompt', await dialog().count() === 0)
check('a leaf card closed anyway', deleted.length === 1 && deleted[0] === SOLO, deleted.join(', '))

// ── 6. one close in a finished tree REFUSED → partial-failure notice ────────
deleted.length = 0
refuse.add('chat-babysit')
await open('&finished=1')
await pressClose(LEAD)
await page.waitForFunction(() => !document.querySelector('[data-slot-key="chat-lead"]'), null, { timeout: 8000 })
const errNotice = page.locator('[data-testid="close-tree-refused"]')
await errNotice.waitFor({ state: 'visible', timeout: 8000 })
await page.waitForTimeout(400)
const noticeText = await errNotice.innerText()
check('the refused session is named', noticeText.includes('worker: pull-request babysit'), noticeText)
check('a session that closed is not named', !noticeText.includes('worker: locale sweep'), noticeText)
check('the rest of the tree still closed', deleted.length === 5 && deleted.at(-1) === LEAD, deleted.join(' -> '))
await page.screenshot({ path: `${OUT}/refused.png`, clip: PANEL })
refuse.clear()

// ── 7. phone: row's only close is its menu → same blocked notice ───────────
deleted.length = 0
await page.setViewportSize(PHONE)
await open()
const phoneRow = page.locator(`[data-slot-key="${LEAD}"]`).first()
await phoneRow.locator('[aria-label="More options"]').first().click()
const closeItem = page.getByRole('menuitem', { name: 'Close session' })
await closeItem.waitFor({ state: 'visible', timeout: 5000 })
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/phone-menu.png` })
await closeItem.click()
await dialog().waitFor({ state: 'visible', timeout: 5000 })
await page.waitForTimeout(350)
check('the phone menu raises the blocked notice', await page.getByTestId('close-tree-dismiss').isVisible())
check('no close-all on phone either', !(await page.getByRole('button', { name: /Close all/i }).isVisible()))
check('nothing closed from the phone menu', deleted.length === 0, deleted.join(', '))
await page.screenshot({ path: `${OUT}/phone-blocked.png` })

await context.close()
await browser.close()
console.log(failed ? '\nFAILED' : `\nOK — frames in ${OUT}`)
process.exit(failed ? 1 : 0)
