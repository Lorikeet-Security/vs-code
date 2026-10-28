# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-10-28

Major enterprise feature release closing benchmark capabilities against commercial AppSec extensions.

### Added
- **Workspace & Multi-File Scanning**: Added `lory.scanWorkspace` command to crawl and batch-review repository files with concurrency pooling (3–5 workers) and aggregate progress reporting.
- **Dedicated Activity Bar Container**: Registered the `Lory Security` view container in the VS Code Activity Bar with three comprehensive views:
  - **Open Findings**: Categorized by severity (Critical, High, Medium, Low, Info) with line anchoring, CWE badges, and click-to-navigate.
  - **Scanned Assets & Files**: Project asset inventory displaying review status (Clean ✓ or vulnerability count).
  - **Account & Subscription**: Live display of account status, active plan, user email, and quick-action authentication controls.
- **Seamless In-IDE SSO OAuth Authentication**: Added `lory.login` command executing an ephemeral loopback OAuth listener (`127.0.0.1:54321` with dynamic port fallback) with PKCE and CSRF defense matching `lory login`.
- **Side-by-Side Diff Preview**: Introduced `lory.previewFix` to preview AI suggested fixes in VS Code's native diff editor before applying changes.
- **Policy & Ignore File Support**: Automatic parsing of `.loryignore` and `.lorikeet.json` configuration files in workspace roots, mirroring `lory-cli` policy rules.
- **False Positive Reporting**: Added `lory.reportFalsePositive` quick fix and TreeView action routing feedback directly to the Lorikeet PTaaS triage queue.

## [1.0.0] - 2026-10-28

Production release. Deprecates the unauthenticated free tier and requires an active Lorikeet Security account with a valid access token or commercial subscription.

### Changed
- Enforced authentication: Lory code reviews now require an active Lorikeet Security access token (`lkmcp_...`). Anonymous unauthenticated scanning is no longer supported.
- Updated status bar to reflect `Activate` / `Sign In` status when no token is present.
- Updated `Lory: Scan Active File` and `Lory: Scan Selection` to prompt for token configuration or subscription when unauthenticated.
- Replaced token rate limiting model with subscription-backed identity verification.
- Added commands `Lory: Open Lorikeet Dashboard & API Keys` and `Lory: View Subscription Plans & Pricing`.
- Bumped version to `1.0.0` and graduated from alpha status to general production availability.

## [0.1.0] - 2026-08-02

First alpha. The review loop works end to end; the settings surface may still
change before 1.0.

### Added

- Security review of the active file by Lory, with findings shown as editor
  diagnostics and in the Problems panel.
- Three triggers, selected by `lory.scanOn`: debounced while typing (default),
  on save, or on the `Lory: Scan Active File` command only.
- Streaming results, so the first finding renders before the review completes.
- Quick fixes on every finding: apply Lory's suggested fix, open a full
  explanation, or insert an ignore comment.
- `lory-ignore` and `lory-ignore-next-line` comments to silence one finding, and
  `lory-ignore-file` to skip a file entirely.
- Severity and confidence floors (`lory.minimumSeverity`,
  `lory.minimumConfidence`) to control how much reaches the Problems panel.
- Path exclusion through `lory.exclude`, defaulting to dependency, build, and
  minified output directories.
- One-time consent prompt before any source leaves the machine, revocable with
  `Lory: Reset Code-Sharing Consent`.
- Status bar item showing review state and the finding count for the active file.
- CWE codes linked to their MITRE definition from the Problems panel.
- Optional `lkmcp_` access token, raising the rate limit from 30/min keyed to your
  IP to 120/min keyed to the token. Set with `Lory: Set Access Token`, held in
  `SecretStorage` rather than settings, and removable with `Lory: Clear Access
  Token`. It grants no data access — this endpoint reads nothing owned by your
  company.
- Rate-limit and rejected-token failures raise a notification at most once until
  the next successful review, so the on-type trigger cannot spam toasts.

[Unreleased]: https://github.com/Lorikeet-Security/vs-code/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Lorikeet-Security/vs-code/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/Lorikeet-Security/vs-code/releases/tag/v0.1.0
