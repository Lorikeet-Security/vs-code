<!--
  Every image below MUST use an absolute https URL. VS Code's extension details
  view and the Marketplace both render this file detached from the repository,
  so a relative path like images/icon.png resolves against nothing and shows as
  a broken-image placeholder.
-->
<p align="center">
  <img src="https://lorikeetsecurity.com/talon/assets/images/lory/lory-avatar.png?v=4" width="120" alt="Lory">
</p>

<h1 align="center">Lory</h1>

<p align="center"><strong>Security review while you write, not three weeks after you ship.</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/status-production-20c997" alt="production">
  <img src="https://img.shields.io/badge/release-v1.0.0-ba5663" alt="v1.0.0">
  <img src="https://img.shields.io/badge/vscode-%5E1.85-007acc" alt="vscode ^1.85">
  <img src="https://img.shields.io/badge/license-MIT-20c997" alt="MIT">
</p>

---

Lory is [Lorikeet Security](https://lorikeetsecurity.com)'s AI security analyst. This
extension puts it in your editor: it reads the file you are working on and marks the
lines that carry a vulnerability, as you write them.

Findings land as ordinary editor diagnostics. They squiggle in the gutter, count in the
Problems panel, and carry a quick fix. There is no separate panel to check and no scan to
remember to run.

## What it catches

Injection reachable from user input (SQL, OS command, template, deserialization, path
traversal, XXE), hardcoded secrets and private keys, missing authorisation on sensitive
handlers, broken crypto and predictable randomness, unsafe DOM sinks, SSRF, insecure
direct object references, and unsafe framework, container, and cloud configuration.

It deliberately does **not** report style, formatting, naming, or performance. A security
marker on a style nit teaches you to ignore security markers.

## Install & Activation

Search **Lory** in the Extensions view, or:

```
ext install LorikeetSecurity.lory
```

### Activation & Authentication

Lory requires an active Lorikeet Security subscription or API access token (`lkmcp_...`).

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **`Lory: Set Access Token`**.
3. Paste your access token from your [Lorikeet Security MCP Settings](https://lorikeetsecurity.com/talon/dashboard/mcp).
4. If you don't have a token, subscribe or manage your plan at [Lorikeet Pricing](https://lorikeetsecurity.com/pricing).

## How it works

```
        you type
            │
            ▼
  debounce (1.5s, configurable)
            │
            ▼
  the active file  ──HTTPS──▶  lorikeetsecurity.com/ptaas/ajax/lory-code-review.php
                                            │
                                            ▼
                                   Lory, running the code-review
                                   and findings-format skills
                                            │
            ┌───────────────────────────────┘
            ▼
  findings stream back, one at a time
            │
            ▼
  anchored to lines · filtered · rendered as diagnostics
```

Every line sent is numbered before it reaches the model, so a finding points at the
statement that causes it rather than a line the model counted to. Findings whose line
number falls outside the reviewed range are discarded rather than moved to the nearest
line: a marker on innocent code is worse than a marker you never saw.

Reviews are cached by content hash. Editing a comment and pressing save does not spend a
request, and neither does switching tabs and back.

## Using it

| | |
|---|---|
| **See a finding** | Hover the squiggle, or open the Problems panel. |
| **Fix it** | `Ctrl/Cmd + .` on the line, then *Lory: apply fix*. |
| **Understand it** | `Ctrl/Cmd + .`, then *Lory: explain*. Opens the full write-up with the CWE reference. |
| **Silence it** | `Ctrl/Cmd + .`, then *Lory: ignore this finding*. Inserts a `lory-ignore` comment. |
| **Review a fragment** | Select the lines, right click, *Lory: Scan Selection*. Use this on files too large to review whole. |

### Ignore comments

```js
// lory-ignore  the id is an internal enum, not user input
db.query(`SELECT * FROM t WHERE kind='${KIND}'`);
```

`lory-ignore` and `lory-ignore-next-line` both silence the following line, and either
also works at the end of the offending line. `lory-ignore-file` anywhere in the first 20
lines skips the whole file.

## Settings

| Setting | Default | |
|---|---|---|
| `lory.enable` | `true` | Turn the extension off for a folder or workspace. |
| `lory.scanOn` | `type` | `type` reviews after you pause and on save, `save` only on save, `manual` only on command. |
| `lory.debounceMs` | `1500` | How long to wait after the last keystroke. |
| `lory.minimumSeverity` | `low` | Hide findings below this severity. |
| `lory.minimumConfidence` | `low` | Set to `high` to see only defects visible in the reviewed lines. |
| `lory.languages` | 25 languages | Which language ids get reviewed. |
| `lory.exclude` | deps, builds, minified | Globs that are never sent. |
| `lory.maxFileLines` | `1500` | Files longer than this are skipped; scan a selection instead. |
| `lory.stream` | `true` | Render findings as they arrive. |
| `lory.baseUrl` | lorikeetsecurity.com | Point at a self-hosted instance. |

`lory.scanOn`, the filters, `lory.languages`, and `lory.exclude` are all resource-scoped,
so a monorepo can review its services and ignore its generated clients.

## What leaves your machine

**Reviewing code means uploading it.** The extension asks before the first review and
does nothing until you agree. `Lory: Reset Code-Sharing Consent` revokes it.

Sent, per review:

- the text of the file or selection being reviewed
- its **base** filename, never its path
- its language id

Not sent, ever: any other file, your repository, its git history, its remotes, your
credentials, or your workspace layout. The extension reads no file you do not have open,
and the request carries no identifier tying it to you or your machine.

Nothing is retained after the review returns. If a path must never be uploaded, put it in
`lory.exclude` and it is skipped before any request is built.

## Limits

**It reviews a fragment, not a system.** It usually cannot see the caller, your
middleware, or your ORM's escaping, so it states the precondition and marks its
confidence rather than guessing. Filter on `lory.minimumConfidence` if you want only what
is provable from the lines on screen.

**It is an assistant, not an audit.** It finds defects that are visible in source. It does
not prove exploitability, and a clean file is not a certified one. For an actual
assessment, Lorikeet runs [penetration tests](https://lorikeetsecurity.com) that a human
reviews and signs.

**Requests are rate limited.** Thirty a minute anonymously, keyed to your IP — generous
for one developer and tight for a team behind one egress address. If you hit it, raise
`lory.debounceMs`, switch `lory.scanOn` to `save`, or add a token (below).

## Authentication & Subscription Plans

Lory operates as a commercial AI security analyst. To protect infrastructure and deliver dedicated compute, an active Lorikeet Security account with a valid subscription or API token is required.

| Account Tier | Features | Capacity |
|---|---|---|
| **Developer / Pro** | Real-time inline security reviews, AST-aware diagnostics, Quick Auto-Fixes | 120 reviews/min |
| **Enterprise / PTaaS** | Dedicated team quotas, full PTaaS web scanner integration, custom rulesets | Custom / Unlimited |

### Managing Your Credentials
- Run **Lory: Set Access Token** to save or rotate your token.
- Tokens are stored securely in VS Code's encrypted `SecretStorage`, never in plaintext `settings.json`.
- Run **Lory: Open Lorikeet Dashboard & API Keys** to jump directly to your account.
- Run **Lory: View Subscription Plans & Pricing** to view available upgrades.

## Development

```bash
npm install
npm run watch      # esbuild, rebuilds on change
# then press F5 in VS Code to launch the Extension Development Host

npm run check      # tsc --noEmit && eslint
npm test           # node --test, no editor required
npm run package    # produces lory-<version>.vsix
```

The logic worth testing is deliberately free of `vscode` imports — [src/glob.ts](src/glob.ts),
[src/sse.ts](src/sse.ts), and [src/types.ts](src/types.ts) — so the suite runs on plain Node.

| | |
|---|---|
| [src/extension.ts](src/extension.ts) | Activation, commands, event wiring |
| [src/analyzer.ts](src/analyzer.ts) | Debounce, cache, cancellation, rendering |
| [src/client.ts](src/client.ts) | HTTP and streaming against the review endpoint |
| [src/sse.ts](src/sse.ts) | Server-sent event parsing |
| [src/diagnostics.ts](src/diagnostics.ts) | Findings to diagnostics, anchoring, suppression |
| [src/actions.ts](src/actions.ts) | Quick fixes |
| [src/config.ts](src/config.ts) | Settings, filters, scan eligibility |
| [src/glob.ts](src/glob.ts) | Exclusion matching |

### Server side

The extension talks to `/ptaas/ajax/lory-code-review.php` in the `lorikeet-security`
repo, which assembles its prompt from the `code` context of `LorySkillLoader`:
`identity` + `code-review` + `response-format-findings`. That context carries no sales
skills, so this surface cannot answer with pricing or a booking.

## Legal

Use this on code you are authorised to review. Findings are advisory and reviewing code
with it does not constitute a penetration test, a security audit, or a compliance
attestation.

## License

MIT. See [LICENSE](LICENSE).
