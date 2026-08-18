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

    private readonly _onDidPersist = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidPersist = this._onDidPersist.event;

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

    getPendingChange(uri: vscode.Uri): PendingChange | undefined {
        return this.pendingChanges.get(uri.toString());
    }

    getPendingChildren(dirUri: vscode.Uri): { name: string; type: vscode.FileType }[] {
        const results: { name: string; type: vscode.FileType }[] = [];
        const dirPath = dirUri.path.endsWith('/') ? dirUri.path : `${dirUri.path}/`;

        for (const change of this.pendingChanges.values()) {
            const path = change.remotePath;
            if (path.startsWith(dirPath)) {
                const relative = path.slice(dirPath.length);
                const firstSlash = relative.indexOf('/');
                const childName = firstSlash === -1 ? relative : relative.slice(0, firstSlash);
                if (childName && !results.some((r) => r.name === childName)) {
                    results.push({
                        name: childName,
                        type: firstSlash === -1 ? vscode.FileType.File : vscode.FileType.Directory,
                    });
                }
            }
        }
        return results;
    }

    discardPending(uri: vscode.Uri): boolean {
        const deleted = this.pendingChanges.delete(uri.toString());
        if (deleted) {
            this._onPendingCountChange.fire(this.pendingChanges.size);
        }
        return deleted;
    }

    discardPendingSubtree(dirUri: vscode.Uri): number {
        const dirPath = dirUri.path.endsWith('/') ? dirUri.path : `${dirUri.path}/`;
        let count = 0;
        for (const [key, change] of Array.from(this.pendingChanges.entries())) {
            if (change.remotePath === dirUri.path || change.remotePath.startsWith(dirPath)) {
                this.pendingChanges.delete(key);
                count++;
            }
        }
        if (count > 0) {
            this._onPendingCountChange.fire(this.pendingChanges.size);
        }
        return count;
    }

    renamePending(oldUri: vscode.Uri, newUri: vscode.Uri): boolean {
        let changed = false;
        const oldKey = oldUri.toString();
        if (this.pendingChanges.has(oldKey)) {
            const item = this.pendingChanges.get(oldKey)!;
            this.pendingChanges.delete(oldKey);
            this.pendingChanges.set(newUri.toString(), {
                ...item,
                uri: newUri,
                remotePath: newUri.path,
            });
            changed = true;
        }

        const oldDirPath = oldUri.path.endsWith('/') ? oldUri.path : `${oldUri.path}/`;
        const newDirPath = newUri.path.endsWith('/') ? newUri.path : `${newUri.path}/`;

        for (const [key, item] of Array.from(this.pendingChanges.entries())) {
            if (item.remotePath.startsWith(oldDirPath)) {
                const relPath = item.remotePath.slice(oldDirPath.length);
                const newRemotePath = newDirPath + relPath;
                const updatedUri = vscode.Uri.parse(
                    `${oldUri.scheme}://${oldUri.authority}${newRemotePath}`
                );
                this.pendingChanges.delete(key);
                this.pendingChanges.set(updatedUri.toString(), {
                    ...item,
                    uri: updatedUri,
                    remotePath: newRemotePath,
                });
                changed = true;
            }
        }

        if (changed) {
            this._onPendingCountChange.fire(this.pendingChanges.size);
        }
        return changed;
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
                this._onDidPersist.fire(uri);
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
        this._onDidPersist.dispose();
    }
}
