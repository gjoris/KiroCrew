/** Output redaction — mirrors backend security.py patterns for frontend display. */

import { i18nT } from '../i18n/t'

// ── Credential patterns (matches redact_credentials in security.py) ──
//
// The three AWS key-value spellings are KEY-ANCHORED: they begin at the key
// naming the secret. Like the backend, only the VALUE is replaced -- the key,
// separator and quotes stay, so a redacted line still says what was redacted --
// and a value that IS a registered redaction tag (or a run of them) filling it is
// left alone (`isRedactionTag`), so this mirror is a fixed point over the
// backend's own output (`key=[REDACTED: credential]`) instead of re-collapsing
// it to `[REDACTED] credential]`. Where the value begins and ends is read by
// `scanKeyedValue`, a port of the backend's `scan_keyed_value`: one explicit
// scanner, one token per step, with the opener (bare or escaped), the
// escaped-whitespace head, the tag run, the escape pair, the doubled quote and
// the line end as its rules. A regex stood here before and was patched by hand
// for every new encoding the backend learned, and the copies drifted: a doubled
// or escaped interior quote ended the mirror's value early and showed the second
// fragment of a concatenated secret. `test/sanitizeCredentials.fixture.test.ts`
// pins this port to the backend's generated fixture, so the two cannot drift
// again. Every other pattern IS the secret and is replaced whole.
const REDACTION_TAGS = ['[REDACTED]', '[REDACTED: credential]', '[REDACTED: encoded credential]']
const WHITESPACE_ESCAPE_LETTERS = new Set(['n', 'r', 't', 'f', 'v'])
const QUOTES = new Set(['"', "'"])
const UNQUOTED_TERMINATORS = new Set([',', '}'])

// The backend's `_LABEL_QUOTE`: an optional quote closing a JSON key, bare or
// escaped as it reads inside an enclosing string literal. The key anchor ends at
// the separator; the opener belongs to the scanner.
const KEY_ANCHOR = new RegExp(
  `(?:SecretAccessKey|aws_secret_access_key|SessionToken|aws_session_token|AccessKeyId|aws_access_key_id)(?:\\\\?["'])?\\s*[:=]\\s*`,
  'gi',
)

interface KeyedValue {
  start: number
  end: number
  closes: boolean
  opener: string
}

function isWhitespace(c: string): boolean {
  return /\s/.test(c)
}

function tagRunEnd(text: string, i: number): number {
  for (;;) {
    const tag = REDACTION_TAGS.find((candidate) => text.startsWith(candidate, i))
    if (tag === undefined) return i
    i += tag.length
  }
}

// The inner token at `i` in the value's encoding -- what one byte of the value
// reads as. Bare encoding: every token is one byte. Escaped encoding (the pair is
// written inside an enclosing string literal, `key=\"<v>\"`): a backslash and
// the byte after it are ONE inner token, and a bare quote of the literal's own
// kind is the literal's end, which ends the inner line.
function innerToken(text: string, i: number, escaped: boolean, literalQuote: string): [string, number] {
  const c = text[i]
  if (c === '\\') {
    if (i + 1 >= text.length) return ['partial', 1]
    if (escaped) {
      const nxt = text[i + 1]
      if (nxt === '\\') return ['backslash', 2]
      if (QUOTES.has(nxt)) return ['quote', 2]
      if (nxt === 'n' || nxt === 'r') return ['newline', 2]
      if (nxt === 't' || nxt === 'f' || nxt === 'v') return ['space', 2]
      return ['char', 2]
    }
    return ['backslash', 1]
  }
  if (escaped && c === literalQuote) return ['newline', 1]
  if (c === '\r' || c === '\n') return ['newline', 1]
  if (isWhitespace(c)) return ['space', 1]
  if (QUOTES.has(c)) return ['quote', 1]
  return ['char', 1]
}

// The backend's `scan_keyed_value`, byte for byte: the value of a key-anchored
// pair whose separator ends at `at`. Every rule is a STOPPING rule, so an
// unknown spelling costs an over-redaction, never a byte left standing.
export function scanKeyedValue(text: string, at: number): KeyedValue {
  const n = text.length
  let opener = ''
  if (at < n && QUOTES.has(text[at])) opener = text[at]
  else if (at + 1 < n && text[at] === '\\' && QUOTES.has(text[at + 1])) opener = text.slice(at, at + 2)
  const escaped = opener.startsWith('\\')
  const literalQuote = opener ? opener[opener.length - 1] : ''
  const start = at + opener.length
  let i = start
  // The head: escaped whitespace, unbounded, consumed with the value.
  for (;;) {
    if (i >= n) break
    const [kind, width] = innerToken(text, i, escaped, literalQuote)
    if (kind !== 'backslash' || i + width >= n) break
    const [letterKind, letterWidth] = innerToken(text, i + width, escaped, literalQuote)
    if (letterKind !== 'char' || !WHITESPACE_ESCAPE_LETTERS.has(text[i + width])) break
    i += width + letterWidth
  }
  if (!opener) {
    while (i < n) {
      const run = tagRunEnd(text, i)
      if (run > i) {
        i = run
        continue
      }
      const [kind, width] = innerToken(text, i, false, '')
      if (kind === 'partial') return { start, end: i, closes: true, opener: '' }
      if (kind === 'space' || kind === 'newline' || kind === 'quote' || (kind === 'char' && UNQUOTED_TERMINATORS.has(text[i]))) {
        return { start, end: i, closes: true, opener: '' }
      }
      if (kind === 'backslash') {
        if (i + 1 >= n) return { start, end: i, closes: true, opener: '' }
        const nxt = text[i + 1]
        if (QUOTES.has(nxt) || isWhitespace(nxt) || WHITESPACE_ESCAPE_LETTERS.has(nxt)) {
          return { start, end: i, closes: true, opener: '' }
        }
        i += 2
        continue
      }
      i += width
    }
    return { start, end: n, closes: true, opener: '' }
  }
  while (i < n) {
    const run = tagRunEnd(text, i)
    if (run > i) {
      i = run
      continue
    }
    const [kind, width] = innerToken(text, i, escaped, literalQuote)
    if (kind === 'partial' || kind === 'newline') return { start, end: i, closes: false, opener }
    if (kind === 'backslash') {
      const j = i + width
      if (j >= n) return { start, end: i, closes: false, opener }
      const [nxtKind, nxtWidth] = innerToken(text, j, escaped, literalQuote)
      if (nxtKind === 'newline') {
        i = j
        continue
      }
      if (nxtKind === 'partial') return { start, end: j, closes: false, opener }
      i = j + nxtWidth
      continue
    }
    if (kind === 'quote' && text.slice(i, i + width) === opener) {
      const j = i + width
      if (j < n && text.slice(j, j + width) === opener) {
        // A doubled quote is an escaped interior quote, never the close.
        i = j + width
        continue
      }
      return { start, end: i, closes: true, opener }
    }
    i += width
  }
  return { start, end: n, closes: false, opener }
}

// Trust is byte identity of the ENTIRE value with a RUN of one or more of the
// tag literals above (this mirror's own, and the two the backend's
// `CREDENTIAL_REDACTION_TAGS` registers), never a shape and never a prefix:
// `[REDACTED<secret>` is a value and is redacted like any other, and so is
// `[REDACTED: credential]<secret>` -- and so is a run with bytes glued to its
// last `]`. No tag is a substring of another, so the parse of a run is unique.
function isRedactionTag(value: string): boolean {
  return value.length > 0 && tagRunEnd(value, 0) === value.length
}

// The key-anchored pass: every AWS key anchor, its value read by the scanner,
// replaced by the tag with the opener kept and -- when the quote never closed on
// its line -- the close WRITTEN as the backend writes it, so the output is a
// closed pair a re-screen leaves alone.
function redactKeyedValues(text: string): string {
  let out = ''
  let cursor = 0
  KEY_ANCHOR.lastIndex = 0
  for (const anchor of text.matchAll(KEY_ANCHOR)) {
    const at = anchor.index + anchor[0].length
    if (anchor.index < cursor) continue
    const value = scanKeyedValue(text, at)
    if (value.end <= value.start) continue
    const body = text.slice(value.start, value.end)
    if (isRedactionTag(body) && value.closes) continue
    const close = value.closes ? '' : value.opener
    out += text.slice(cursor, value.start) + '[REDACTED]' + close
    cursor = value.end
  }
  return out + text.slice(cursor)
}

const CRED_PATTERNS: RegExp[] = [
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  /BEGIN\s(?:RSA|DSA|EC|OPENSSH)\sPRIVATE\sKEY/g,
  /xox[bpas]-[0-9a-zA-Z-]{10,}/g,
  // JWS (3 segments) and compact JWE (5 segments). Post-header segments use `*`,
  // not `+`. A `dir`/`ECDH-ES` JWE has an EMPTY Encrypted Key segment
  // (`header..iv.ciphertext.tag`), so `*` is what makes it redact whole rather
  // than truncating and leaving the ciphertext and tag on screen.
  //
  // Byte-identical to the backend alternative, deliberately, and pinned as such
  // by `test/test_redaction_mirror_parity.py`. No left boundary is used here: a
  // left boundary would stop a two-dot identifier such as
  // `keyJson.parse.value` being redacted, but that trade is
  // the wrong one: the boundary MISSES a real token whenever a renderer
  // concatenates a label straight onto it (`compact=jwt<token>`,
  // `/session/jwe<token>`), which the backend redacts. It also does not prevent
  // the commonest false-positive form, a space-preceded identifier in a stack
  // trace (`at eyJsonSerializer.deserialize.value`), which matches either way.
  // So it would buy two avoided false positives and cost two leaks. A miss is a
  // leak; a false positive is mangled display text.
  //
  // The residual false positive is therefore shared with the backend rather than
  // unique to this mirror, which keeps it ONE defect to fix in one place. Closing
  // it needs a structural test, not a boundary: decode segment one as a JOSE
  // header and require `alg`/`enc`. That belongs in the backend first, with this
  // mirror following, so it is deliberately out of scope here.
  /eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){2,4}/g,
  // Two-segment dashboard link token (`base64url(payload).base64url(hmac_sig)`).
  // `security.py` carries the full derivation of both bounds and is the single
  // source for it; `test/test_redaction_mirror_parity.py` fails if this copy
  // drifts from it. The local invariant worth knowing here: the signature width
  // is PINNED (`{43}`, a property of the HMAC-SHA256 digest, not of the payload),
  // so a digest change fails a backend test loudly instead of silently disabling
  // redaction, and the payload bound is a generator-derived floor rather than a
  // guess because a guessed floor is beatable by a verbose enough identifier.
  //
  // ONE deliberate difference from the backend: its leading lookbehind boundary
  // is omitted here, and must stay omitted. Safari 16.3 and older cannot compile
  // a lookbehind. `vite.config.ts` declares no `build.target`, so the default
  // `'modules'` floor is `safari14`, and at that target esbuild rewrites the
  // literal into a `new RegExp(...)` call. That moves the failure from parse time
  // to run time, which does not help: this array is a module-level constant in
  // the eagerly loaded entry chunk, so the throw lands during module evaluation
  // and the dashboard renders blank rather than losing one feature. Verified by
  // execution, with `RegExp` patched to reject lookbehind: this shape throws on
  // import, a function-scoped one throws only when called.
  //
  // Removing a LEFT boundary cannot create a MISS, so the divergence is
  // one-directional: verified by execution, no input redacts in the backend and
  // not here. This mirror additionally catches a token a renderer concatenated
  // onto a label (`tok=jwt<token>`), which the backend's boundary makes it miss.
  //
  // The cost is the SAME mechanism, and it is not a benign extra replacement. A
  // lookbehind is zero-width, so the match still starts at an `eyJ`, but that
  // `eyJ` may be one INSIDE a preceding identifier: `keyJson<token>` matches from
  // index 1 and renders `k[REDACTED: credential]`, absorbing the identifier tail.
  // That is the same class of damage cited above as the reason the segment floor
  // was not relaxed to `{1,4}`. It needs an identifier containing `eyJ` glued with
  // no delimiter to 96+ identifier chars, a dot, then exactly 43 more. Not
  // reachable on the surfaces this function feeds: the longest `eyJ`-containing
  // identifier in the tree is 50 chars, the backend already redacts `agent`/`task`
  // before broadcast and truncates `tool` to 80 chars, and the output of this
  // function goes to in-memory store state only. The one surface rewritten before
  // persistence (file-diff chip bodies) is redacted in the BACKEND, so an
  // over-match here cannot reach disk.
  //
  // Ordering after the JWS alternative is defensive, not load-bearing for real
  // tokens: a conventional `{"alg":"HS256","typ":"JWT"}` header is only 33 chars
  // past `eyJ`, far below this alternative's first-segment floor, so it cannot
  // match a real JWS's `header.payload` at all. It becomes load-bearing only for
  // a JWS whose header clears that floor AND whose payload is exactly 43 chars,
  // because this pattern's right boundary is satisfied by a `.` and would leave
  // `.signature` rendered. That shape is covered by a test.
  /eyJ[A-Za-z0-9_-]{96,}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  /https?:\/\/[^:]+:[^@]+@/g,
]

// Base64 chunk: 40+ chars of base64 alphabet with optional trailing =
const B64_CHUNK = /[A-Za-z0-9+/]{40,}={0,2}/g

function decodeB64Safe(chunk: string): string {
  try {
    const decoded = atob(chunk)
    // Check if decoded content contains credential patterns
    for (const re of CRED_PATTERNS) {
      re.lastIndex = 0
      if (re.test(decoded)) return decoded
    }
  } catch { /* not valid base64 */ }
  return ''
}

export function sanitizeCredentials(text: string): string {
  // Key-anchored AWS pairs first: the value as the scanner reads it, key kept.
  let out = redactKeyedValues(text)
  // Plaintext credential patterns -- each IS the secret and is replaced whole.
  for (const re of CRED_PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, '[REDACTED]')
  }
  // Base64-encoded credentials
  B64_CHUNK.lastIndex = 0
  for (const m of text.matchAll(B64_CHUNK)) {
    if (decodeB64Safe(m[0])) {
      out = out.replace(m[0], '[REDACTED: encoded credential]')
    }
  }
  return out
}

// ── Exfiltration URL detection (mirrors redact_exfiltration_urls in security.py) ──
// Unlike the backend, a URL that stops at `)` is judged with the text after it (#8638),
// up to the next scheme or space (URL_TAIL_RE), then cut back to where its link ends.
const URL_RE = /https?:\/\/([a-zA-Z0-9._-]+\.[a-zA-Z]{2,})(:\d+)?(\/[^\s)"'>]*)?/g
const URL_TAIL_RE = /[^\s"'>]*?(?=https?:\/\/|[\s"'>]|$)/y
// Drop trailing `)` that have no `(` partner in the URL, plus punctuation after them.
function trimWrapperParen(url: string): string {
  let extra = url.split(')').length - url.split('(').length
  let keep = url.length
  for (let i = url.length - 1; i >= 0 && extra > 0; i--) {
    if (url[i] === ')') { extra--; keep = i } else if (!'.,;:!?'.includes(url[i])) break
  }
  return url.slice(0, keep)
}

// A markdown `](...)` target ends at its first `)` with no `(` partner, as CommonMark does.
function linkTarget(url: string): string {
  let depth = 0
  for (let i = 0; i < url.length; i++) {
    if (url[i - 1] === '\\') continue // a `\(` or `\)` escape stays in the target, as in CommonMark
    if (url[i] === '(') depth++
    else if (url[i] === ')' && --depth < 0) return url.slice(0, i)
  }
  return url
}

// True when the `]` at `i` closes a real `[label]` (CommonMark caps a label at 999 chars).
function closesLabel(text: string, i: number): boolean {
  let depth = 0
  for (let j = i - 1; j >= 0 && j >= i - 1000; j--) {
    if (text[j] === ']') depth++
    else if (text[j] === '[' && depth-- === 0) return true
  }
  return false
}
const EXFIL_QUERY_MIN_LEN = 200

// PATTERN signals: each names a shape rather than a size, and each runs for
// EVERY URL — no host and no carve-out escapes them — so this redactor still
// flags every pattern the undifferentiated check flagged. Non-global so `.test()`
// carries no sticky `.lastIndex` between calls.
//
// Heavy URL-encoding: 20+ CONSECUTIVE percent-encoded octets. Mirrors the
// backend's _EXFIL_PERCENT_RE.
const EXFIL_PERCENT_RE = /%[0-9A-Fa-f]{2}(?:%[0-9A-Fa-f]{2}){20,}/i

// Hard credential markers. Mirrors the backend's _HARD_CREDENTIAL_RE.
const EXFIL_CREDENTIAL_RE = new RegExp(
  '(?:' +
    '(?:AKIA|ASIA)[A-Z0-9]{16}' +                    // AWS access key ID
    '|(?:ssh-rsa|ssh-ed25519)[\\s+%]' +               // SSH public key
    '|BEGIN[\\s+%](?:RSA|DSA|EC|OPENSSH)[\\s+%]PRIVATE[\\s+%]KEY' + // private key header
    '|xox[bpas]-[0-9a-zA-Z-]+' +                     // Slack token
  ')',
  'i',
)

// Base64-like blob, 40+ chars — the shape an encoded payload has. Same spelling
// as the backend's `_EXFIL_PATTERNS` base64 branch, and it OVER-matches by
// design: `+` is the form-encoded spelling of a space, so ~7 words of
// unpunctuated prose in a `+`-encoded `body=` are one run in this class and are
// redacted. That is accepted rather than fixed, and this signal is deliberately
// NOT waivable, because both available narrowings — dropping `+` from the class,
// or splitting the query on `+` before testing — let an attacker `+`-chunk a 40+
// char secret straight past it. A false positive on prose costs a placeholder; a
// chunking bypass costs the payload.
//
// `=` is different: it counts only as trailing padding, never as a joiner, so a
// parameter name, its `=` and a short value (`trainingId=` plus a 32-char ID) do
// not fuse into one 40-char run. That opens no chunking channel `&`, `.`, `-` and
// `_` do not already provide, and the aggregate length signal still bounds the
// query. Padding still counts toward the 40 chars (38 plus `==`, 39 plus `=`),
// so a minimum-length encoded payload is caught. Same spelling as the backend.
const EXFIL_B64_RE = /[A-Za-z0-9+/]{40,}={0,2}|[A-Za-z0-9+/]{39}=|[A-Za-z0-9+/]{38}==/i

// Aggregate query LENGTH is the one signal that names no shape at all: it fires on
// any richly-parameterised URL, which is why prefilled issue links —
// `…/issues/new?title=…&body=<a paragraph of prose>&labels=…` — render as a
// `[REDACTED: suspicious URL]` placeholder.
//
// It is NOT waived for that shape, deliberately, and no future shape-based waiver
// belongs here either. `isPrefilledIssueUrl` used to waive it (#7824), first on
// shape alone and later pinned to this project's own tracker; both spellings are
// exfiltration primitives, because what this function sanitizes is MODEL-AUTHORED
// text. Injected content steers the model into emitting a prefill URL whose `body`
// carries percent-encoded private context, the waiver skips the length check, the
// link renders as the familiar "file an issue" affordance, the user submits it —
// and the issue is PUBLIC, so the attacker reads it. Pinning the repository does
// not help: this project's tracker is world-readable, which is the point of it.
//
// A URL's shape says nothing about who authored it, and a marker placed IN the
// text travels in the channel the injection already controls. Provenance has to
// come from a different channel, which the product already has: the backend's
// `diagnostics._issue_url` assembles the prefill link from STRUCTURED fields and
// the dashboard renders its own anchor from the `github_issue_url` JSON field,
// which no redactor scans (`ReportProblemModal`, `ReportProblemCard`). A link that
// never enters model prose never needs a waiver.
//
// If you are here to make a long legitimate URL render, narrow or replace this
// heuristic for EVERY host on its own merits (#7820 also reports
// monitorportal.amazon.com) — do not reintroduce a per-shape escape hatch.

export function sanitizeExfiltrationUrls(text: string): string {
  let out = ''
  let last = 0
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text))) {
    const domain = m[1]
    const end = m.index + m[0].length
    URL_TAIL_RE.lastIndex = end
    const full = m[0] + (text[end] === ')' ? (URL_TAIL_RE.exec(text)?.[0] ?? '') : '')
    const inLink = text.slice(m.index - 2, m.index) === '](' && closesLabel(text, m.index - 2)
    // End at the first unpaired `)` when that already keeps the `?`, so glued prose after it
    // never votes or is spliced; otherwise the query lies past the `)`, so keep scanning it.
    const cut = linkTarget(full)
    const url = inLink || cut.includes('?') ? cut : trimWrapperParen(full)
    // A pattern signal past the cut still counts (glued prose can only trip the length one).
    const past = inLink ? '' : full.slice(url.length)
    const hit = EXFIL_PERCENT_RE.test(past) || EXFIL_CREDENTIAL_RE.test(past) || EXFIL_B64_RE.test(past)
    const pathAndQuery = url.slice(m[0].length - (m[3] || '').length)
    const qmark = pathAndQuery.indexOf('?')
    if (qmark === -1 && !hit) continue
    const query = pathAndQuery.slice(qmark + 1)
    const redact = hit ||
      EXFIL_PERCENT_RE.test(query) ||
      EXFIL_CREDENTIAL_RE.test(query) ||
      EXFIL_B64_RE.test(query) ||
      query.length >= EXFIL_QUERY_MIN_LEN
    if (redact) {
      out += text.slice(last, m.index) + i18nT('utils.sanitize.redacted_suspicious_url', { domain })
      last = m.index + (hit ? trimWrapperParen(full) : url).length
    }
  }
  return out + text.slice(last)
}

/** Combined sanitizer — runs both credential and exfiltration redaction. */
export function sanitizeLlmOutput(text: string): string {
  return sanitizeExfiltrationUrls(sanitizeCredentials(text))
}

/** True for the three object keys that, when used to index a plain object,
 *  mutate ``Object.prototype`` instead of the object (prototype pollution).
 *  Reducers that index a state map with an id sourced from SSE/LLM payloads
 *  must early-return on these before the assignment. The literal ``===`` form
 *  (not a Set/array membership test) is what CodeQL's
 *  ``js/prototype-polluting-assignment`` query recognizes as a sanitizer. */
export function isUnsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype'
}
