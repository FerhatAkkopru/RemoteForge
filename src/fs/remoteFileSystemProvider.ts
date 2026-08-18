import * as vscode from 'vscode';
import { SftpClient } from './sftpClient.js';
import { SyncEngine, PendingChange } from '../sync/syncEngine.js';
import { ConflictDetector } from '../sync/conflictDetector.js';
import { Logger } from '../ui/outputChannel.js';

/**
 * URI format: remoteforge://profileId/remote/path
 * - authority = profileId
 * - path = remote file path
 */
export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
    private logger = Logger.getInstance();

    private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;

    private changeBuffer: vscode.FileChangeEvent[] = [];
    private changeTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly sftpClient: SftpClient,
        private readonly syncEngine: SyncEngine,
        private readonly conflictDetector: ConflictDetector,
    ) {
        this.syncEngine.onDidPersist((uri) => {
            this.fireSoon({ type: vscode.FileChangeType.Changed, uri });
        });
    }

    // --- File metadata ---

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const pending = this.syncEngine.getPendingChange(uri);
        if (pending) {
            return {
                type: vscode.FileType.File,
                ctime: pending.timestamp,
                mtime: pending.timestamp,
                size: pending.content.byteLength,
            };
        }

        const remotePath = uri.path;
        try {
            const stat = await this.sftpClient.stat(remotePath);
            // Record mtime for conflict detection
            if (stat.type === vscode.FileType.File) {
                this.conflictDetector.recordMtime(uri, stat.mtime);
            }
            return stat;
        } catch (err) {
            if (!this.isNotFoundError(err)) {
                this.logger.error(`stat failed for ${remotePath}`, err);
            }
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const remotePath = uri.path;
        let entries: [string, vscode.FileType][] = [];
        let sftpError: unknown = undefined;

        try {
            entries = await this.sftpClient.readDirectory(remotePath);
        } catch (err) {
            sftpError = err;
            if (!this.isNotFoundError(err)) {
                this.logger.error(`readDirectory failed for ${remotePath}`, err);
                throw vscode.FileSystemError.Unavailable(uri);
            }
        }

        const pendingChildren = this.syncEngine.getPendingChildren(uri);
        if (pendingChildren.length > 0) {
            const existingNames = new Set(entries.map(([name]) => name));
            for (const child of pendingChildren) {
                if (!existingNames.has(child.name)) {
                    entries.push([child.name, child.type]);
                }
            }
            return entries;
        }

        if (sftpError) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        return entries;
    }

    // --- File read/write ---

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const pending = this.syncEngine.getPendingChange(uri);
        if (pending) {
            return pending.content;
        }

        const remotePath = uri.path;
        const LARGE_FILE_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50MB

        try {
            // Check file size before loading into memory
            const stat = await this.sftpClient.stat(remotePath);
            if (stat.size > LARGE_FILE_THRESHOLD_BYTES) {
                const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
                const choice = await vscode.window.showWarningMessage(
                    `File "${remotePath}" is large (${sizeMB} MB). Opening large files in memory may affect performance. Do you want to proceed?`,
                    { modal: true },
                    'Open File',
                    'Cancel'
                );
                if (choice !== 'Open File') {
                    throw vscode.FileSystemError.Unavailable(`Opening of large file (${sizeMB} MB) cancelled by user.`);
                }
            }

            const content = await this.sftpClient.readFile(remotePath);
            // Record mtime after reading for conflict detection
            try {
                const mtime = await this.sftpClient.getMtime(remotePath);
                this.conflictDetector.recordMtime(uri, mtime);
            } catch { /* non-critical */ }
            return content;
        } catch (err) {
            if (err instanceof vscode.FileSystemError) {
                throw err;
            }
            if (!this.isNotFoundError(err)) {
                this.logger.error(`readFile failed for ${remotePath}`, err);
            }
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async writeFile(
        uri: vscode.Uri,
        content: Uint8Array,
        options: { create: boolean; overwrite: boolean }
    ): Promise<void> {
        const remotePath = uri.path;

        const isPending = this.syncEngine.isPending(uri);
        let existsOnServer = false;
        if (!isPending) {
            try {
                await this.sftpClient.stat(remotePath);
                existsOnServer = true;
            } catch {
                existsOnServer = false;
            }
        }

        const exists = isPending || existsOnServer;

        if (!options.overwrite && exists) {
            throw vscode.FileSystemError.FileExists(uri);
        }

        if (!options.create && !exists) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        try {
            await this.syncEngine.handleWrite(uri, remotePath, content);
            // Note: FileChangeType.Changed is NOT fired here for manual mode queueing.
            // It will be fired via syncEngine.onDidPersist when actual remote write finishes.
        } catch (err) {
            this.logger.error(`writeFile failed for ${remotePath}`, err);
            throw vscode.FileSystemError.Unavailable(uri);
        }
    }

    // --- Directory operations ---

    async createDirectory(uri: vscode.Uri): Promise<void> {
        const remotePath = uri.path;
        try {
            await this.sftpClient.mkdir(remotePath);
            this.fireSoon({ type: vscode.FileChangeType.Created, uri });
        } catch (err) {
            this.logger.error(`createDirectory failed for ${remotePath}`, err);
            throw vscode.FileSystemError.Unavailable(uri);
        }
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const remotePath = uri.path;
        let savedSingle: PendingChange | undefined;
        let savedSubtree: Map<string, PendingChange> | undefined;

        if (options.recursive) {
            savedSubtree = this.syncEngine.discardPendingSubtree(uri);
        } else {
            savedSingle = this.syncEngine.discardPending(uri);
        }

        const hadPending = options.recursive ? (savedSubtree?.size ?? 0) > 0 : savedSingle !== undefined;

        try {
            if (options.recursive) {
                await this.deleteRecursive(remotePath);
            } else {
                const stat = await this.sftpClient.stat(remotePath);
                await this.sftpClient.delete(remotePath, stat.type === vscode.FileType.Directory);
            }
        } catch (err) {
            if (this.isNotFoundError(err) && hadPending) {
                this.logger.info(`Deleted pending item not present on server: ${remotePath}`);
            } else {
                // Rollback pending changes if deletion failed on server due to permission/network error
                if (options.recursive && savedSubtree) {
                    this.syncEngine.restorePendingMap(savedSubtree);
                } else if (savedSingle) {
                    this.syncEngine.restorePending(savedSingle);
                }
                this.logger.error(`delete failed for ${remotePath}`, err);
                throw vscode.FileSystemError.Unavailable(uri);
            }
        }

        this.conflictDetector.clearMtime(uri);
        this.fireSoon({ type: vscode.FileChangeType.Deleted, uri });
    }

    async rename(
        oldUri: vscode.Uri,
        newUri: vscode.Uri,
        options: { overwrite: boolean }
    ): Promise<void> {
        const targetPending = this.syncEngine.isPending(newUri);
        let targetExistsOnServer = false;
        if (!targetPending) {
            try {
                await this.sftpClient.stat(newUri.path);
                targetExistsOnServer = true;
            } catch {
                targetExistsOnServer = false;
            }
        }
        const targetExists = targetPending || targetExistsOnServer;

        if (!options.overwrite && targetExists) {
            throw vscode.FileSystemError.FileExists(newUri);
        }

        const hadPending = this.syncEngine.renamePending(oldUri, newUri);

        try {
            await this.sftpClient.rename(oldUri.path, newUri.path);
        } catch (err) {
            if (this.isNotFoundError(err) && hadPending) {
                this.logger.info(`Renamed pending item not present on server: ${oldUri.path} -> ${newUri.path}`);
            } else {
                // Rollback pending rename if server rename fails
                if (hadPending) {
                    this.syncEngine.renamePending(newUri, oldUri);
                }
                this.logger.error(`rename failed: ${oldUri.path} → ${newUri.path}`, err);
                throw vscode.FileSystemError.Unavailable(oldUri);
            }
        }

        this.conflictDetector.clearMtime(oldUri);
        this.fireSoon(
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri }
        );
    }

    // --- File watching (no-op for remote, but required by interface) ---

    watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
        // Remote file watching is not supported via SFTP.
        // Changes made outside VS Code won't be detected in real-time.
        return new vscode.Disposable(() => { /* no-op */ });
    }

    // --- Helpers ---

    private async deleteRecursive(remotePath: string): Promise<void> {
        const entries = await this.sftpClient.readDirectory(remotePath);
        for (const [name, type] of entries) {
            const childPath = `${remotePath}/${name}`;
            if (type === vscode.FileType.Directory) {
                await this.deleteRecursive(childPath);
            } else {
                await this.sftpClient.delete(childPath, false);
            }
        }
        await this.sftpClient.delete(remotePath, true);
    }

    /**
     * Batches file change events to avoid flooding VS Code.
     * Fires accumulated events after a short delay.
     */
    private fireSoon(...events: vscode.FileChangeEvent[]): void {
        this.changeBuffer.push(...events);

        if (this.changeTimer) {
            clearTimeout(this.changeTimer);
        }

        this.changeTimer = setTimeout(() => {
            this._onDidChangeFile.fire(this.changeBuffer);
            this.changeBuffer = [];
        }, 25);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private isNotFoundError(err: unknown): boolean {
        if (err instanceof Error) {
            const msg = err.message.toLowerCase();
            return msg.includes('no such file') || (err as any).code === 2;
        }
        return false;
    }

    dispose(): void {
        this._onDidChangeFile.dispose();
    }
}
