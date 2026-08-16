import * as vscode from 'vscode';
import { SyncEngine } from '../sync/syncEngine.js';

export class RemoteFileDecorationProvider implements vscode.FileDecorationProvider {
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    constructor(private readonly syncEngine: SyncEngine) {
        this.syncEngine.onPendingCountChange(() => {
            this._onDidChangeFileDecorations.fire(undefined);
        });
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme === 'remoteforge' && this.syncEngine.isPending(uri)) {
            return {
                badge: 'M',
                tooltip: 'RemoteForge: Pending local change (Manual Mode)',
                color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
            };
        }
        return undefined;
    }

    dispose(): void {
        this._onDidChangeFileDecorations.dispose();
    }
}
