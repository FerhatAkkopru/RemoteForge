import './setup.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteFileSystemProvider } from '../src/fs/remoteFileSystemProvider.js';
import { SyncEngine } from '../src/sync/syncEngine.js';
import { ConflictDetector, ConflictResolution } from '../src/sync/conflictDetector.js';
import { workspace, FileType } from './mocks/vscode.js';
import * as vscode from 'vscode';

const mockUri = (path: string) => ({
    scheme: 'remoteforge',
    authority: 'profile1',
    path,
    toString: () => `remoteforge://profile1${path}`,
} as any);

describe('RemoteFileSystemProvider Unit Tests (Manual Sync Architecture)', () => {
    let serverFiles: Map<string, Uint8Array>;
    let deletedServerFiles: string[];
    let renamedServerPaths: Array<{ oldPath: string; newPath: string }>;
    let fakeSftp: any;
    let fakeConflictDetector: any;
    let syncEngine: SyncEngine;
    let provider: RemoteFileSystemProvider;

    beforeEach(() => {
        workspace.configStore.clear();
        serverFiles = new Map<string, Uint8Array>();
        deletedServerFiles = [];
        renamedServerPaths = [];

        fakeSftp = {
            writeFile: async (path: string, content: Uint8Array) => {
                serverFiles.set(path, content);
            },
            readFile: async (path: string) => {
                if (!serverFiles.has(path)) {
                    throw new Error('no such file or directory');
                }
                return serverFiles.get(path)!;
            },
            stat: async (path: string) => {
                if (!serverFiles.has(path)) {
                    throw new Error('no such file or directory');
                }
                const content = serverFiles.get(path)!;
                return {
                    type: FileType.File,
                    ctime: 1000,
                    mtime: 1000,
                    size: content.byteLength,
                };
            },
            getMtime: async (path: string) => {
                if (!serverFiles.has(path)) {
                    throw new Error('no such file or directory');
                }
                return 1000;
            },
            readDirectory: async (_path: string) => {
                const results: [string, number][] = [];
                for (const [p] of serverFiles.entries()) {
                    if (p.startsWith(_path === '/' ? '/' : `${_path}/`)) {
                        const name = p.slice((_path === '/' ? '/' : `${_path}/`).length);
                        if (!name.includes('/')) {
                            results.push([name, FileType.File]);
                        }
                    }
                }
                return results;
            },
            delete: async (path: string, _isDir: boolean) => {
                if (!serverFiles.has(path)) {
                    throw new Error('no such file or directory');
                }
                serverFiles.delete(path);
                deletedServerFiles.push(path);
            },
            rename: async (oldPath: string, newPath: string) => {
                if (!serverFiles.has(oldPath)) {
                    throw new Error('no such file or directory');
                }
                const content = serverFiles.get(oldPath)!;
                serverFiles.delete(oldPath);
                serverFiles.set(newPath, content);
                renamedServerPaths.push({ oldPath, newPath });
            },
        };

        fakeConflictDetector = {
            checkConflict: async () => ConflictResolution.Overwrite,
            recordMtime: () => {},
            clearMtime: () => {},
        };

        syncEngine = new SyncEngine(fakeSftp as any, fakeConflictDetector as any);
        provider = new RemoteFileSystemProvider(fakeSftp as any, syncEngine, fakeConflictDetector as any);
    });

    it('Finding 1: should NOT fire onDidChangeFile on queueing, but fire when pushed', async () => {
        workspace.configStore.set('syncMode', 'manual');
        const fileEvents: vscode.FileChangeEvent[][] = [];

        provider.onDidChangeFile((events) => {
            fileEvents.push(events);
        });

        const uri = mockUri('/manual_doc.txt');
        const content = new TextEncoder().encode('Hello Queue');

        await provider.writeFile(uri, content, { create: true, overwrite: true });

        // Give any short timer a moment
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(fileEvents.length, 0, 'No FileChangeType event should fire on queueing');

        await syncEngine.pushAllChanges();
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.equal(fileEvents.length, 1, 'FileChangeEvent should fire after actual server push');
        assert.equal(fileEvents[0][0].type, vscode.FileChangeType.Changed);
        assert.equal(fileEvents[0][0].uri.path, '/manual_doc.txt');
    });

    it('Finding 2: stat and readFile should return synthetic data for queued files not on server', async () => {
        workspace.configStore.set('syncMode', 'manual');

        const uri = mockUri('/new_queued_file.txt');
        const content = new TextEncoder().encode('Synthetic Content');

        await provider.writeFile(uri, content, { create: true, overwrite: true });

        // Server does NOT have this file
        assert.equal(serverFiles.has('/new_queued_file.txt'), false);

        // provider.stat should succeed via synthetic stat
        const stat = await provider.stat(uri);
        assert.equal(stat.size, content.byteLength);
        assert.equal(stat.type, FileType.File);

        // provider.readFile should return queued content directly
        const readData = await provider.readFile(uri);
        assert.deepEqual(readData, content);

        // provider.readDirectory should include queued file
        const rootUri = mockUri('/');
        const entries = await provider.readDirectory(rootUri);
        assert.equal(entries.some(([name]) => name === 'new_queued_file.txt'), true);
    });

    it('Finding 3 & Risk 1 Scenario A: deleting queued-only file removes from queue without server error', async () => {
        workspace.configStore.set('syncMode', 'manual');

        const uri = mockUri('/created_and_deleted.txt');
        await provider.writeFile(uri, new TextEncoder().encode('Temp'), { create: true, overwrite: true });
        assert.equal(syncEngine.pendingCount, 1);

        // Delete should succeed cleanly
        await provider.delete(uri, { recursive: false });
        assert.equal(syncEngine.pendingCount, 0);

        // Push should do nothing and not resurrect file
        await syncEngine.pushAllChanges();
        assert.equal(serverFiles.has('/created_and_deleted.txt'), false);
    });

    it('Finding 3 & Risk 1 Scenario B: deleting existing remote file with pending edits deletes from server AND clears queue', async () => {
        workspace.configStore.set('syncMode', 'manual');

        // File exists on server
        const initialContent = new TextEncoder().encode('Initial Server Content');
        serverFiles.set('/existing_remote.txt', initialContent);

        const uri = mockUri('/existing_remote.txt');

        // User edits file in manual mode (queued)
        await provider.writeFile(uri, new TextEncoder().encode('Pending Edit'), { create: false, overwrite: true });
        assert.equal(syncEngine.pendingCount, 1);

        // User deletes file
        await provider.delete(uri, { recursive: false });

        // 1. Queue is cleared
        assert.equal(syncEngine.pendingCount, 0);
        // 2. Server delete was executed
        assert.equal(deletedServerFiles.includes('/existing_remote.txt'), true);
        assert.equal(serverFiles.has('/existing_remote.txt'), false);

        // 3. Push changes does NOT resurrect the deleted file
        await syncEngine.pushAllChanges();
        assert.equal(serverFiles.has('/existing_remote.txt'), false);
    });

    it('Risk 2: renaming existing remote file with pending edits updates server AND pending queue', async () => {
        workspace.configStore.set('syncMode', 'manual');

        serverFiles.set('/old_remote.txt', new TextEncoder().encode('Remote Base'));
        const oldUri = mockUri('/old_remote.txt');
        const newUri = mockUri('/new_remote.txt');

        // Queue edit
        const editContent = new TextEncoder().encode('Edited Pending Content');
        await provider.writeFile(oldUri, editContent, { create: false, overwrite: true });
        assert.equal(syncEngine.isPending(oldUri), true);

        // Rename
        await provider.rename(oldUri, newUri, { overwrite: true });

        assert.equal(syncEngine.isPending(oldUri), false);
        assert.equal(syncEngine.isPending(newUri), true);
        assert.equal(renamedServerPaths.length, 1);
        assert.deepEqual(renamedServerPaths[0], { oldPath: '/old_remote.txt', newPath: '/new_remote.txt' });

        // Push edits to server
        await syncEngine.pushAllChanges();
        assert.equal(serverFiles.has('/old_remote.txt'), false);
        assert.equal(serverFiles.has('/new_remote.txt'), true);
        assert.deepEqual(serverFiles.get('/new_remote.txt'), editContent);
    });
});
