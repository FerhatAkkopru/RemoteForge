import * as vscode from 'vscode';
import { SftpClient } from '../fs/sftpClient.js';
import { ConflictDetector, ConflictResolution } from './conflictDetector.js';
import { Logger } from '../ui/outputChannel.js';

interface PendingChange {
    uri: vscode.Uri;
    remotePath: string;
    content: Uint8Array;
    timestamp: number;
}

export class SyncEngine {
    private pendingChanges = new Map<string, PendingChange>();
    private logger = Logger.getInstance();

    private readonly _onPendingCountChange = new vscode.EventEmitter<number>();
    readonly onPendingCountChange = this._onPendingCountChange.event;

    constructor(
        private readonly sftpClient: SftpClient,
        private readonly conflictDetector: ConflictDetector,
    ) {}

    get pendingCount(): number {
        return this.pendingChanges.size;
    }

    isPending(uri: vscode.Uri): boolean {
        return this.pendingChanges.has(uri.toString());
    }

    getSyncMode(): 'auto' | 'manual' {
        return vscode.workspace.getConfiguration('remoteforge').get<'auto' | 'manual'>('syncMode', 'auto');
    }

    /**
     * Called by FileSystemProvider.writeFile().
     * In auto mode: writes immediately (with conflict check).
     * In manual mode: queues the change for later push.
     * Returns true if the write was handled (either written or queued).
     */
    async handleWrite(
        uri: vscode.Uri,
        remotePath: string,
        content: Uint8Array,
    ): Promise<boolean> {
        const mode = this.getSyncMode();

        if (mode === 'auto') {
            return this.writeWithConflictCheck(uri, remotePath, content);
        }

        // Manual mode — queue the change
        this.pendingChanges.set(uri.toString(), {
            uri, remotePath, content,
            timestamp: Date.now(),
        });
        this._onPendingCountChange.fire(this.pendingChanges.size);
        this.logger.info(`Queued change for ${remotePath} (${this.pendingChanges.size} pending)`);
        return true;
    }

    private async writeWithConflictCheck(
        uri: vscode.Uri,
        remotePath: string,
        content: Uint8Array,
    ): Promise<boolean> {
        const resolution = await this.conflictDetector.checkConflict(uri, remotePath, content);

        switch (resolution) {
            case ConflictResolution.Overwrite:
                await this.sftpClient.writeFile(remotePath, content);
                try {
                    const newMtime = await this.sftpClient.getMtime(remotePath);
                    this.conflictDetector.recordMtime(uri, newMtime);
                } catch { /* mtime update failure is non-critical */ }
                return true;

            case ConflictResolution.FetchRemote:
                // Re-read the remote file — the FileSystemProvider will pick up the change
                this.logger.info(`User chose to fetch remote version of ${remotePath}`);
                return false;

            case ConflictResolution.Cancel:
                this.logger.info(`User cancelled write to ${remotePath}`);
                return false;
        }
    }

    /**
     * Push all pending changes (manual mode).
     * Shows a progress notification and writes each pending file.
     */
    async pushAllChanges(): Promise<void> {
        if (this.pendingChanges.size === 0) {
            void vscode.window.showInformationMessage('RemoteForge: No pending changes to push.');
            return;
        }

        const changes = [...this.pendingChanges.values()];
        this.logger.info(`Pushing ${changes.length} pending change(s)...`);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'RemoteForge: Pushing changes',
                cancellable: false,
            },
            async (progress) => {
                let pushed = 0;
                for (const change of changes) {
                    progress.report({
                        message: `${pushed + 1}/${changes.length}: ${change.remotePath}`,
                        increment: (1 / changes.length) * 100,
                    });

                    const ok = await this.writeWithConflictCheck(
                        change.uri, change.remotePath, change.content
                    );
                    if (ok) {
                        this.pendingChanges.delete(change.uri.toString());
                        pushed++;
                    }
                }

                this._onPendingCountChange.fire(this.pendingChanges.size);
                this.logger.info(`Pushed ${pushed}/${changes.length} changes`);

                if (this.pendingChanges.size > 0) {
                    void vscode.window.showWarningMessage(
                        `RemoteForge: ${this.pendingChanges.size} change(s) were not pushed (conflict or cancellation).`
                    );
                } else {
                    void vscode.window.showInformationMessage(
                        `RemoteForge: All ${pushed} change(s) pushed successfully.`
                    );
                }
            }
        );
    }

    dispose(): void {
        this.pendingChanges.clear();
        this._onPendingCountChange.dispose();
    }
}
