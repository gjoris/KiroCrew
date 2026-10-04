---
title: A crewmate's session tree for apps — a session-rooted crew-log fold, read-only App SDK access, and propose_seed
status: draft
author: iamwhatever
created: 2026-10-04
last-audited: 2026-10-04
audited-at: fd705fb7c7
doc-pr: 16790
implementation-prs: []
tracking-issues: []
supersedes: []
superseded-by: []
---

# RFC: A crewmate's session tree for apps — a session-rooted crew-log fold, read-only App SDK access, and propose_seed

**Status:** draft — proposed, nothing built. Acceptance is the product owner's call, recorded by moving `status` to `accepted`. Every "exists today" claim below was read at main `fd705fb7c7` (2026-10-04); citations name files and symbols.

- Author: iamwhatever
- Related: [rfc-crewmates-launch.md](rfc-crewmates-launch.md) (the Crewmates page, which this RFC leaves unchanged), [rfc-conductor-work-ledger.md](rfc-conductor-work-ledger.md) (the ledger a conductor keeps), [rfc-append-only-ledger.md](rfc-append-only-ledger.md) (the crew log the fold reads), [rfc-everything-is-an-app.md](rfc-everything-is-an-app.md) (why new views start in an app).

## 1. Summary

A crewmate can open conductor sessions, and those can open workers. Together they are the crewmate's **session tree**. Today an app cannot see that tree at all, so an app that ships such a crewmate cannot show its own progress view.

This RFC adds the smallest core an app needs to build that view itself:

1. **A session-rooted crew-log fold.** Given a root session, it walks `session/opened` parent edges and sums the descendants: running sessions, work items by status, credits, host auto-declines, pending approvals.
2. **Read-only App SDK access**, scoped to a crewmate the app shipped and the owner created: that crewmate's descendant tree, its descendant conductors' work-ledger goals, and the fold.
3. **`propose_seed`**: the app proposes a message to the crewmate; it is sent only when the owner clicks Send.

The Crewmates page does not change. The crewmate shows as an ordinary crewmate. Any tree, board or Needs-you view is built inside the app first. Nothing here is written for one app; the first intended user is the harness-rsi app.

## 2. Current state

| Part | Today | Where | Gap |
|---|---|---|---|
| Session tree | `session/opened.parent` edges, folded per tree | `src/kiro_crew/crew_log/session_tree.py` `fold_tree` | Already has the edges the fold walks |
| Crew-log folds | Named folds served from the projection | `src/kiro_crew/crew_log/projection.py` `FOLD_NAMES` | No fold rooted at a session |
| Entries the fold sums | `session/opened`, `session/closed`, `turn/completed` (carries `credits`), `turn/refused` (host `cause` for an auto-decline), `approval/requested`, `approval/decided`, `work/recorded` | `src/kiro_crew/crew_log/entry_types.py` | Already logged |
| Crewmate and team routes for apps | Every route calls `_deny_app_caller`; an app token gets 404 | `src/kiro_crew/dashboard/handlers/members.py` `_deny_app_caller`, `handlers/teams.py` | An app cannot see any crewmate |
| Work ledger board | `require_owner_dashboard_request` | `src/kiro_crew/dashboard/handlers/work_ledger_board.py` | An app cannot read goals |
| App-shipped agents | Manifest `agents` installed as `<app>--<agent>.json` | `src/kiro_crew/apps/bridges.py` `_register_agents` | The owner can create a crewmate on one; nothing links the two for reads |
| App backend context | `cron`, `events`, `storage`, `spawn`, `job`, `audit`, … — no crewmate handle | `src/kiro_crew/apps/context.py` `AppContext` | No read handle |
| `permissions.sessionApproval` | Lets an app act on the user's own sessions after a consent re-prompt | `src/kiro_crew/apps/manifest.py` `Permissions`, `apps/manager.py` | Must not reach this tree (§ 4.4) |

Built-in apps reach the crew log by importing `kiro_crew` in the gateway process. An external app cannot, and core code written for one app is what [rfc-everything-is-an-app.md](rfc-everything-is-an-app.md) rules out.

## 3. Goals and non-goals

Goals:

- An app can build its own view of a crewmate's session tree from data it cannot overstate: numbers come from the crew log, not from what any session reports.
- The app gets no authority the owner did not click.

Non-goals:

- Any Crewmates page change: no Sessions-tree, Needs-you, Goals or Dashboard-tab change, no new page, no new concept.
- A team, a team lead, or any `crew_teams.py` change.
- A host UI component for apps, or a dashboard template.
- Trust, approvals, or direct sends through the SDK.

## 4. Design

### 4.1 Session-rooted fold

- `projection.py` gains a generic fold keyed by a root session. Its members are the root and every session reachable from it by `session/opened` parent edges, as `session_tree.py` already computes.
- Per member and in total, it carries: state (running or closed), work items by status from `work/recorded`, credits from `turn/completed`, host auto-declines from `turn/refused`, and pending approvals (`approval/requested` without a matching `approval/decided`).
- It knows nothing about apps or crewmates. Any caller with a root session key can use it; owner routes may serve it too.

### 4.2 Which crewmate an app may read

An app may read a crewmate only when both hold:

- the crewmate runs on an agent the app ships (manifest `agents`, installed by `_register_agents`), and the app names that agent in a new manifest field, `contributes.crewmates[]: {agent}`;
- the owner created the crewmate, through the existing owner routes.

The host records the link on the crewmate as the app's install, not its name. Uninstalling the app clears it, so a later app reusing the name reads nothing until the owner creates a crewmate for it again. A disabled app gets no handle.

### 4.3 Read-only SDK access

New `apps/crewmate_sdk.py`; `AppContext` gains `crewmate: CrewmateSDK | None`, set only when the manifest declares `permissions.crewmate: "read"` and at least one `contributes.crewmates` entry. Page-side hooks call the matching routes with the app token.

| Call | Returns | Never returns |
|---|---|---|
| `ctx.crewmate.tree(name)` | Each descendant's session key, role (crewmate, conductor, worker), depth, state, open-question and pending-approval counts | Transcript text, prompts, tool arguments |
| `ctx.crewmate.goals(name)` | For each descendant conductor: goal, item titles, item states, acceptance kinds | Worker report text |
| `ctx.crewmate.fold(name)` | The § 4.1 fold rooted at the crewmate's thread | — |

The routes behind these are new. Each checks that the named crewmate is linked to the calling app's install, and answers 404 otherwise, the same answer `_deny_app_caller` gives. Every existing members, teams and work-ledger route keeps its current owner gate.

### 4.4 propose_seed

`ctx.crewmate.propose_seed(name, text)` adds a card for the owner: "App X wants to send <crewmate>: …". Nothing is sent until the owner clicks Send; the send uses the existing thread path under the owner's session.

Not in the SDK, by design: creating or deleting a crewmate, turning trust on or off, approving or answering anything in the tree, sending directly. `permissions.sessionApproval` does not reach sessions in a linked crewmate's tree.

Each implementation PR updates `docs/app-kit/manifest-reference.md` and `docs/app-kit/api-reference.md` in the same change.

## 5. Migration plan

| Phase | Change | Exit criteria |
|---|---|---|
| 1 Fold | Session-rooted fold in `projection.py` | A worker two levels under the root is counted; its pending approval clears when `approval/decided` lands; credits sum across the tree |
| 2 Link and tree | `contributes.crewmates`, `permissions.crewmate`, install link, `ctx.crewmate.tree` and its route | An app reading a crewmate it did not ship, or one the owner has not created, gets 404; the response holds no transcript text; after uninstall and reinstall under the same name, the old crewmate is not readable |
| 3 Goals and fold for apps | `ctx.crewmate.goals`, `ctx.crewmate.fold` | Goals list each descendant conductor's items; `ctx.crewmate` is `None` without `permissions.crewmate: read` |
| 4 propose_seed | Owner card and send path | A proposed seed is not delivered until the owner clicks Send |

Order: 1 → 2 → 3; 4 after 2.

## 6. Backward compatibility

Compatible: the fold is new, the manifest fields are optional, and the routes are new. No existing route changes its gate, and no existing app gains a capability without declaring `permissions.crewmate` and being re-enabled.

## 7. Security considerations

- An app reads only crewmates linked to its own install, and only state, counts and goals — no conversation text.
- Every existing members, teams and work-ledger route keeps its owner gate.
- The SDK holds no trust, approval or send call. Tests pin that an app-token approve or answer call on a session in the tree is refused, and that an app holding `sessionApproval` cannot switch one to Trust.
- The link clears on uninstall, so a name reuse inherits nothing.

## 8. Alternatives considered

- **Change the Crewmates page now** (Sessions tree, Needs you across the tree, Goals, a team board). Deferred: views are tried inside an app first and move into core only once they prove useful.
- **Teams with a lead.** Dropped: a new concept the owner does not need for this.
- **Let apps read the crew log directly**, as built-in apps do. Rejected: it only works in-process and turns each app's needs into core code.
- **Embeddable host components.** Deferred with the page change: the app draws its own view from the read calls.

## 9. Future work

If an app-built view proves useful, a later RFC may move it onto the Crewmates page — for example, a crewmate's Sessions tab listing the whole tree, or its Needs-you state counting descendants. That is not decided here.

## 10. Open questions

1. Whether one session may sit in two linked crewmates' trees. This RFC assumes no: a session belongs to the tree of the one crewmate its chain starts from.
