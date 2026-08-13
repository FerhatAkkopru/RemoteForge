import * as vscode from 'vscode';
import { SftpClient } from './sftpClient.js';
import { SyncEngine } from '../sync/syncEngine.js';
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
    ) {}

    // --- File metadata ---

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
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
        try {
            return await this.sftpClient.readDirectory(remotePath);
        } catch (err) {
            if (!this.isNotFoundError(err)) {
                this.logger.error(`readDirectory failed for ${remotePath}`, err);
            }
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    // --- File read/write ---

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const remotePath = uri.path;
        try {
            const content = await this.sftpClient.readFile(remotePath);
            // Record mtime after reading for conflict detection
            try {
                const mtime = await this.sftpClient.getMtime(remotePath);
                this.conflictDetector.recordMtime(uri, mtime);
            } catch { /* non-critical */ }
            return content;
        } catch (err) {
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

        // Check if file exists when overwrite is not allowed
        if (!options.overwrite) {
            try {
                await this.sftpClient.stat(remotePath);
                // File exists but overwrite is false
                throw vscode.FileSystemError.FileExists(uri);
            } catch (err) {
                if (err instanceof vscode.FileSystemError) { throw err; }
                // File doesn't exist — good, proceed to create
            }
        }

        if (!options.create) {
            try {
                await this.sftpClient.stat(remotePath);
            } catch {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
        }

        try {
            const written = await this.syncEngine.handleWrite(uri, remotePath, content);
            if (written) {
                this.fireSoon({ type: vscode.FileChangeType.Changed, uri });
            }
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
        try {
            if (options.recursive) {
                await this.deleteRecursive(remotePath);
            } else {
                const stat = await this.sftpClient.stat(remotePath);
                await this.sftpClient.delete(remotePath, stat.type === vscode.FileType.Directory);
            }
            this.conflictDetector.clearMtime(uri);
            this.fireSoon({ type: vscode.FileChangeType.Deleted, uri });
        } catch (err) {
            this.logger.error(`delete failed for ${remotePath}`, err);
            throw vscode.FileSystemError.Unavailable(uri);
        }
    }

    async rename(
        oldUri: vscode.Uri,
        newUri: vscode.Uri,
        options: { overwrite: boolean }
    ): Promise<void> {
        if (!options.overwrite) {
            try {
                await this.sftpClient.stat(newUri.path);
                throw vscode.FileSystemError.FileExists(newUri);
            } catch (err) {
                if (err instanceof vscode.FileSystemError) { throw err; }
                // Doesn't exist — proceed
            }
        }

        try {
            await this.sftpClient.rename(oldUri.path, newUri.path);
            this.conflictDetector.clearMtime(oldUri);
            this.fireSoon(
                { type: vscode.FileChangeType.Deleted, uri: oldUri },
                { type: vscode.FileChangeType.Created, uri: newUri }
            );
        } catch (err) {
            this.logger.error(`rename failed: ${oldUri.path} → ${newUri.path}`, err);
            throw vscode.FileSystemError.Unavailable(oldUri);
        }
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
