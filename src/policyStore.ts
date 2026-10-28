import * as vscode from 'vscode';
import { parseLoryIgnore, parseLorikeetJson, type LorikeetJsonConfig } from './policy.ts';

/**
 * Manages repository-level `.loryignore` and `.lorikeet.json` policy files.
 *
 * Automatically monitors workspace folders for policy updates and caches
 * active exclusions and configurations in memory for fast lookup during reviews.
 */
export class PolicyStore implements vscode.Disposable {
  private readonly ignores = new Map<string, string[]>();
  private readonly configs = new Map<string, LorikeetJsonConfig>();
  private watcher: vscode.FileSystemWatcher | undefined;

  async initialise(): Promise<vscode.Disposable> {
    await this.reloadAll();

    this.watcher = vscode.workspace.createFileSystemWatcher('**/.{loryignore,lorikeet.json}');
    const onTouch = async () => {
      await this.reloadAll();
    };

    const d1 = this.watcher.onDidChange(onTouch);
    const d2 = this.watcher.onDidCreate(onTouch);
    const d3 = this.watcher.onDidDelete(onTouch);

    return new vscode.Disposable(() => {
      d1.dispose();
      d2.dispose();
      d3.dispose();
      this.watcher?.dispose();
    });
  }

  async reloadAll(): Promise<void> {
    this.ignores.clear();
    this.configs.clear();

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      await this.reloadFolder(folder);
    }
  }

  private async reloadFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const folderKey = folder.uri.toString();

    // Check .loryignore
    const ignoreUri = vscode.Uri.joinPath(folder.uri, '.loryignore');
    try {
      const data = await vscode.workspace.fs.readFile(ignoreUri);
      const content = new TextDecoder('utf-8').decode(data);
      const patterns = parseLoryIgnore(content);
      this.ignores.set(folderKey, patterns);
    } catch {
      this.ignores.delete(folderKey);
    }

    // Check .lorikeet.json
    const configUri = vscode.Uri.joinPath(folder.uri, '.lorikeet.json');
    try {
      const data = await vscode.workspace.fs.readFile(configUri);
      const content = new TextDecoder('utf-8').decode(data);
      const parsed = parseLorikeetJson(content);
      this.configs.set(folderKey, parsed);
    } catch {
      this.configs.delete(folderKey);
    }
  }

  getIgnorePatterns(scope?: vscode.Uri): string[] {
    if (!scope) {
      const all: string[] = [];
      for (const pats of this.ignores.values()) {
        all.push(...pats);
      }
      return all;
    }

    const folder = vscode.workspace.getWorkspaceFolder(scope);
    if (!folder) {
      return [];
    }
    return this.ignores.get(folder.uri.toString()) ?? [];
  }

  getJsonConfig(scope?: vscode.Uri): LorikeetJsonConfig {
    if (!scope) {
      return {};
    }
    const folder = vscode.workspace.getWorkspaceFolder(scope);
    if (!folder) {
      return {};
    }
    return this.configs.get(folder.uri.toString()) ?? {};
  }

  dispose(): void {
    this.watcher?.dispose();
    this.ignores.clear();
    this.configs.clear();
  }
}
