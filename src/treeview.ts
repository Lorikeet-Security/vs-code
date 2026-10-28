import * as vscode from 'vscode';
import type { Analyzer } from './analyzer.ts';
import type { TokenStore } from './token.ts';
import type { Finding, Severity } from './types.ts';
import { SEVERITIES } from './types.ts';
import type { AnchoredFinding } from './diagnostics.ts';

// ── Open Findings Tree Provider ──────────────────────────────────────────

export class LoryFindingsTreeProvider
  implements vscode.TreeDataProvider<FindingTreeItem | SeverityGroupItem | EmptyTreeItem>
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    FindingTreeItem | SeverityGroupItem | EmptyTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly analyzer: Analyzer) {
    analyzer.onDidChangeFindings(() => this.refresh());
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(
    element: FindingTreeItem | SeverityGroupItem | EmptyTreeItem
  ): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: SeverityGroupItem
  ): Promise<(FindingTreeItem | SeverityGroupItem | EmptyTreeItem)[]> {
    const allFindingsMap = this.analyzer.getAllFindings();
    let totalFindingsCount = 0;

    for (const findings of allFindingsMap.values()) {
      totalFindingsCount += findings.length;
    }

    if (!element) {
      // Top-level: Severity Groups or Empty state
      if (totalFindingsCount === 0) {
        return [
          new EmptyTreeItem(
            'No open security findings',
            'Run "Scan Workspace" or open a file to review.',
            'shield'
          ),
        ];
      }

      // Group findings by severity
      const groups: SeverityGroupItem[] = [];
      const counts = this.analyzer.getAggregateFindingCounts();

      for (const sev of SEVERITIES) {
        const count = counts[sev] ?? 0;
        if (count > 0) {
          groups.push(new SeverityGroupItem(sev, count));
        }
      }

      return groups;
    }

    // Children of a SeverityGroupItem: individual findings
    const items: FindingTreeItem[] = [];
    const targetSeverity = element.severity;

    for (const [uriStr, anchoredFindings] of allFindingsMap.entries()) {
      const uri = vscode.Uri.parse(uriStr);
      for (const anchored of anchoredFindings) {
        if (anchored.finding.severity === targetSeverity) {
          items.push(new FindingTreeItem(uri, anchored));
        }
      }
    }

    // Sort findings by line number
    items.sort((a, b) => a.anchored.finding.line - b.anchored.finding.line);
    return items;
  }
}

export class SeverityGroupItem extends vscode.TreeItem {
  constructor(public readonly severity: Severity, public readonly count: number) {
    super(
      `${severity.toUpperCase()} (${count})`,
      vscode.TreeItemCollapsibleState.Expanded
    );

    this.iconPath = iconForSeverity(severity);
    this.tooltip = `${count} ${severity} severity finding(s)`;
    this.contextValue = 'lorySeverityGroup';
  }
}

export class FindingTreeItem extends vscode.TreeItem {
  public readonly finding: Finding;
  public readonly uri: vscode.Uri;
  public readonly anchored: AnchoredFinding;

  constructor(uri: vscode.Uri, anchored: AnchoredFinding) {
    const finding = anchored.finding;
    super(finding.title, vscode.TreeItemCollapsibleState.None);

    this.finding = finding;
    this.uri = uri;
    this.anchored = anchored;

    const filename = uri.path.split('/').pop() || 'file';
    const cweStr = finding.cwe ? `${finding.cwe} · ` : '';
    this.description = `${cweStr}${filename}:${finding.line}`;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`### ${finding.title}\n\n`);
    md.appendMarkdown(`**File:** ${vscode.workspace.asRelativePath(uri)}:${finding.line}\n\n`);
    md.appendMarkdown(`**Severity:** ${finding.severity.toUpperCase()} · **Confidence:** ${finding.confidence}\n\n`);
    if (finding.cwe) {
      md.appendMarkdown(`**CWE:** [${finding.cwe}](https://cwe.mitre.org/data/definitions/${finding.cwe.replace(/^CWE-/i, '')}.html)\n\n`);
    }
    md.appendMarkdown(`${finding.detail}\n\n`);
    if (finding.fix) {
      md.appendMarkdown(`**Suggested Fix:**\n\`\`\`\n${finding.fix}\n\`\`\`\n`);
    }
    this.tooltip = md;

    this.iconPath = iconForSeverity(finding.severity);
    this.contextValue = finding.fix ? 'loryFindingWithFix' : 'loryFinding';

    // Click navigates directly to the line in editor
    this.command = {
      command: 'vscode.open',
      title: 'Open Finding',
      arguments: [
        uri,
        {
          selection: anchored.range,
          preview: true,
        },
      ],
    };
  }
}

// ── Scanned Assets & Files Tree Provider ─────────────────────────────────

export class LoryAssetsTreeProvider
  implements vscode.TreeDataProvider<AssetTreeItem | EmptyTreeItem>
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    AssetTreeItem | EmptyTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly analyzer: Analyzer) {
    analyzer.onDidChangeFindings(() => this.refresh());
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: AssetTreeItem | EmptyTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<(AssetTreeItem | EmptyTreeItem)[]> {
    const scannedUris = this.analyzer.getScannedFiles();

    if (scannedUris.length === 0) {
      return [
        new EmptyTreeItem(
          'No files scanned yet',
          'Open files or click "Scan Workspace" to inspect assets.',
          'file-code'
        ),
      ];
    }

    const items: AssetTreeItem[] = [];
    const allFindings = this.analyzer.getAllFindings();

    for (const uriStr of scannedUris) {
      const uri = vscode.Uri.parse(uriStr);
      const findings = allFindings.get(uriStr) ?? [];
      items.push(new AssetTreeItem(uri, findings.length));
    }

    // Sort: files with findings first, then alphabetically
    items.sort((a, b) => b.findingsCount - a.findingsCount || a.filename.localeCompare(b.filename));
    return items;
  }
}

export class AssetTreeItem extends vscode.TreeItem {
  public readonly filename: string;

  constructor(public readonly uri: vscode.Uri, public readonly findingsCount: number) {
    const basename = uri.path.split('/').pop() || 'untitled';
    super(basename, vscode.TreeItemCollapsibleState.None);

    this.filename = basename;
    const relPath = vscode.workspace.asRelativePath(uri);
    this.description = findingsCount === 0 ? '✓ Clean' : `${findingsCount} finding(s)`;

    this.tooltip = `File: ${relPath}\n${
      findingsCount === 0
        ? 'No security vulnerabilities detected.'
        : `${findingsCount} vulnerability findings anchored.`
    }`;

    this.iconPath =
      findingsCount === 0
        ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
        : new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));

    this.contextValue = 'loryScannedAsset';

    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [uri],
    };
  }
}

// ── Account & Subscription Tree Provider ─────────────────────────────────

export class LoryAccountTreeProvider implements vscode.TreeDataProvider<AccountItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    AccountItem | undefined | void
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly tokenStore: TokenStore) {
    tokenStore.onDidChange(() => this.refresh());
    tokenStore.onDidChangeAccount(() => this.refresh());
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: AccountItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<AccountItem[]> {
    const token = this.tokenStore.current();
    const account = this.tokenStore.getAccountInfo();
    const items: AccountItem[] = [];

    // 1. Token / Auth status
    if (token) {
      const masked = token.length > 12 ? `${token.slice(0, 8)}...${token.slice(-4)}` : 'Active';
      items.push(
        new AccountItem(
          'Token Status',
          `Active (${masked})`,
          new vscode.ThemeIcon('key', new vscode.ThemeColor('testing.iconPassed')),
          'Lory subscription token is securely configured.'
        )
      );
    } else {
      items.push(
        new AccountItem(
          'Token Status',
          'Missing (Subscription Required)',
          new vscode.ThemeIcon('alert', new vscode.ThemeColor('problemsErrorIcon.foreground')),
          'An active Lorikeet subscription and token are required for AI code reviews.'
        )
      );
    }

    // 2. User Email
    const email = account?.userEmail ?? (token ? 'Authenticated Subscriber' : 'Unauthenticated');
    items.push(
      new AccountItem(
        'User Email',
        email,
        new vscode.ThemeIcon('account'),
        `Signed in user: ${email}`
      )
    );

    // 3. Organization / Company
    const org = account?.companyName ?? (token ? 'Lorikeet Workspace' : 'None');
    items.push(
      new AccountItem(
        'Organization',
        org,
        new vscode.ThemeIcon('organization'),
        `Account Organization: ${org}`
      )
    );

    // 4. Plan & Tier
    const tier = account?.tier ?? (token ? 'Enterprise / Pro' : 'Free (Expired / Inactive)');
    items.push(
      new AccountItem(
        'Plan & Tier',
        tier,
        new vscode.ThemeIcon('verified'),
        `Lorikeet Security Subscription Tier: ${tier}`
      )
    );

    // 5. Action Items
    items.push(
      new AccountActionItem(
        'Sign In via Talon SSO',
        'lory.login',
        new vscode.ThemeIcon('sign-in')
      ),
      new AccountActionItem(
        'Set Access Token Manually',
        'lory.setToken',
        new vscode.ThemeIcon('key')
      ),
      new AccountActionItem(
        'View Subscription Plans & Pricing',
        'lory.subscribe',
        new vscode.ThemeIcon('credit-card')
      ),
      new AccountActionItem(
        'Open Lorikeet Dashboard',
        'lory.openDashboard',
        new vscode.ThemeIcon('dashboard')
      )
    );

    if (token) {
      items.push(
        new AccountActionItem(
          'Clear Token / Sign Out',
          'lory.clearToken',
          new vscode.ThemeIcon('sign-out')
        )
      );
    }

    return items;
  }
}

export class AccountItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    icon: vscode.ThemeIcon,
    tooltip?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = icon;
    this.tooltip = tooltip ?? `${label}: ${description}`;
  }
}

export class AccountActionItem extends vscode.TreeItem {
  constructor(
    label: string,
    commandId: string,
    icon: vscode.ThemeIcon
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = icon;
    this.command = {
      command: commandId,
      title: label,
    };
  }
}

export class EmptyTreeItem extends vscode.TreeItem {
  constructor(label: string, description: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = `${label} - ${description}`;
  }
}

function iconForSeverity(severity: Severity): vscode.ThemeIcon {
  switch (severity) {
    case 'critical':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
    case 'high':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsErrorIcon.foreground'));
    case 'medium':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    case 'low':
      return new vscode.ThemeIcon('info', new vscode.ThemeColor('problemsInfoIcon.foreground'));
    case 'info':
      return new vscode.ThemeIcon('info', new vscode.ThemeColor('charts.foreground'));
  }
}
