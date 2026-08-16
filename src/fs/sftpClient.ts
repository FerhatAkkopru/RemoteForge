import * as vscode from 'vscode';
import { Stats } from 'ssh2';
import { ConnectionManager } from '../connection/connectionManager.js';
import { Logger } from '../ui/outputChannel.js';

const OPERATION_TIMEOUT = 30_000;

interface CacheEntry<T> {
    data: T;
    timestamp: number;
}

const CACHE_TTL_MS = 30_000; // 30 seconds — long enough to survive Explorer folder switching

export class SftpClient {
    private logger = Logger.getInstance();
    private statCache = new Map<string, CacheEntry<vscode.FileStat>>();
    private dirCache = new Map<string, CacheEntry<[string, vscode.FileType][]>>();

    constructor(private readonly connectionManager: ConnectionManager) {
        // Clear caches on state change
        this.connectionManager.onStateChange((state) => {
            if (state === 'disconnected') {
                this.clearCache();
            }
        });
    }

    clearCache(): void {
        this.statCache.clear();
        this.dirCache.clear();
    }

    private invalidatePath(remotePath: string): void {
        this.statCache.delete(remotePath);
        // Invalidate parent directory cache as well
        const parent = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
        this.dirCache.delete(parent);
        this.statCache.delete(parent);
    }

    private withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Operation timed out after ${OPERATION_TIMEOUT / 1000}s: ${operation}`));
            }, OPERATION_TIMEOUT);

            promise.then(
                (result) => { clearTimeout(timer); resolve(result); },
                (err) => { clearTimeout(timer); reject(err as Error); }
            );
        });
    }

    async stat(remotePath: string): Promise<vscode.FileStat> {
        const now = Date.now();
        const cached = this.statCache.get(remotePath);
        if (cached && now - cached.timestamp < CACHE_TTL_MS) {
            return cached.data;
        }

        this.logger.info(`STAT ${remotePath}`);
        const sftp = await this.connectionManager.getSftp();

        const fileStat = await this.withTimeout(new Promise<vscode.FileStat>((resolve, reject) => {
            sftp.stat(remotePath, (err, stats) => {
                if (err) { reject(err); return; }
                resolve(this.toFileStat(stats));
            });
        }), `stat ${remotePath}`);

        this.statCache.set(remotePath, { data: fileStat, timestamp: Date.now() });
        return fileStat;
    }

    async readDirectory(remotePath: string): Promise<[string, vscode.FileType][]> {
        const now = Date.now();
        const cachedDir = this.dirCache.get(remotePath);
        if (cachedDir && now - cachedDir.timestamp < CACHE_TTL_MS) {
            return cachedDir.data;
        }

        this.logger.info(`READDIR ${remotePath}`);
        const sftp = await this.connectionManager.getSftp();

        return this.withTimeout(new Promise<[string, vscode.FileType][]>((resolve, reject) => {
            sftp.readdir(remotePath, (err, list) => {
                if (err) { reject(err); return; }
                const entries: [string, vscode.FileType][] = [];
                const readTime = Date.now();

                for (const item of list) {
                    if (item.filename === '.' || item.filename === '..') { continue; }

                    let type: vscode.FileType;
                    if (item.attrs.isDirectory()) {
                        type = vscode.FileType.Directory;
                    } else if (item.attrs.isSymbolicLink()) {
                        type = vscode.FileType.SymbolicLink;
                    } else {
                        type = vscode.FileType.File;
                    }
                    entries.push([item.filename, type]);

                    // Pre-populate statCache for every child in this directory!
                    // This avoids N individual SFTP STAT network calls when VS Code requests child stats!
                    const childPath = remotePath === '/' ? `/${item.filename}` : `${remotePath}/${item.filename}`;
                    const childStat = this.toFileStat(item.attrs);
                    this.statCache.set(childPath, { data: childStat, timestamp: readTime });
                }

                this.dirCache.set(remotePath, { data: entries, timestamp: readTime });
                resolve(entries);
            });
        }), `readdir ${remotePath}`);
    }

    async readFile(remotePath: string): Promise<Uint8Array> {
        this.logger.info(`READ ${remotePath}`);
        const sftp = await this.connectionManager.getSftp();

        return this.withTimeout(new Promise<Uint8Array>((resolve, reject) => {
            const chunks: Buffer[] = [];
            const stream = sftp.createReadStream(remotePath);
            stream.on('data', (chunk: Buffer) => { chunks.push(chunk); });
            stream.on('end', () => { resolve(new Uint8Array(Buffer.concat(chunks))); });
            stream.on('error', (err: Error) => { reject(err); });
        }), `read ${remotePath}`);
    }

    async writeFile(remotePath: string, content: Uint8Array): Promise<void> {
        this.logger.info(`WRITE ${remotePath} (${content.byteLength} bytes)`);
        const sftp = await this.connectionManager.getSftp();

        await this.withTimeout(new Promise<void>((resolve, reject) => {
            const stream = sftp.createWriteStream(remotePath);
            stream.on('close', () => { resolve(); });
            stream.on('error', (err: Error) => { reject(err); });
            stream.end(Buffer.from(content));
        }), `write ${remotePath}`);

        this.invalidatePath(remotePath);
    }

    async mkdir(remotePath: string): Promise<void> {
        this.logger.info(`MKDIR ${remotePath}`);
        const sftp = await this.connectionManager.getSftp();

        await this.withTimeout(new Promise<void>((resolve, reject) => {
            sftp.mkdir(remotePath, (err) => {
                if (err) { reject(err); return; }
                resolve();
            });
        }), `mkdir ${remotePath}`);

        this.invalidatePath(remotePath);
    }

    async delete(remotePath: string, isDirectory: boolean): Promise<void> {
        this.logger.info(`DELETE ${remotePath}`);
        const sftp = await this.connectionManager.getSftp();

        const op = isDirectory ? 'rmdir' : 'unlink';
        await this.withTimeout(new Promise<void>((resolve, reject) => {
            sftp[op](remotePath, (err) => {
                if (err) { reject(err); return; }
                resolve();
            });
        }), `${op} ${remotePath}`);

        this.invalidatePath(remotePath);
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        this.logger.info(`RENAME ${oldPath} → ${newPath}`);
        const sftp = await this.connectionManager.getSftp();

        await this.withTimeout(new Promise<void>((resolve, reject) => {
            sftp.rename(oldPath, newPath, (err) => {
                if (err) { reject(err); return; }
                resolve();
            });
        }), `rename ${oldPath}`);

        this.invalidatePath(oldPath);
        this.invalidatePath(newPath);
    }

    async getMtime(remotePath: string): Promise<number> {
        const stat = await this.stat(remotePath);
        return stat.mtime;
    }

    private toFileStat(stats: Stats): vscode.FileStat {
        let type = vscode.FileType.Unknown;
        if (stats.isDirectory()) {
            type = vscode.FileType.Directory;
        } else if (stats.isSymbolicLink()) {
            type = vscode.FileType.SymbolicLink;
        } else if (stats.isFile()) {
            type = vscode.FileType.File;
        }

        return {
            type,
            ctime: stats.mtime * 1000,
            mtime: stats.mtime * 1000,
            size: stats.size,
        };
    }
}
