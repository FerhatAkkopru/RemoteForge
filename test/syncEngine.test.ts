import './setup.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine } from '../src/sync/syncEngine.ts';
import { ConflictDetector, ConflictResolution } from '../src/sync/conflictDetector.ts';
import { workspace } from './mocks/vscode.js';

const mockUri = (path: string) => ({
    toString: () => `remoteforge://profile1${path}`,
    path,
} as any);

describe('SyncEngine Unit Tests', () => {
    let writtenFiles: Map<string, Uint8Array>;
    let fakeSftp: any;
    let fakeConflictDetector: any;

    beforeEach(() => {
        writtenFiles = new Map<string, Uint8Array>();
        fakeSftp = {
            writeFile: async (path: string, content: Uint8Array) => {
                writtenFiles.set(path, content);
            },
            getMtime: async () => 1700000000000,
        };
        fakeConflictDetector = {
            checkConflict: async () => ConflictResolution.Overwrite,
            recordMtime: () => {},
        };
        workspace.configStore.clear();
    });

    it('should write immediately in auto sync mode', async () => {
        workspace.configStore.set('syncMode', 'auto');
        const syncEngine = new SyncEngine(fakeSftp as any, fakeConflictDetector as any);

        const uri = mockUri('/test.txt');
        const content = new TextEncoder().encode('Hello World');

        const handled = await syncEngine.handleWrite(uri, '/test.txt', content);
        assert.equal(handled, true);
        assert.equal(syncEngine.pendingCount, 0);
        assert.equal(writtenFiles.has('/test.txt'), true);
    });

    it('should queue changes in manual sync mode', async () => {
        workspace.configStore.set('syncMode', 'manual');
        const syncEngine = new SyncEngine(fakeSftp as any, fakeConflictDetector as any);

        let eventFiredWith = -1;
        syncEngine.onPendingCountChange((count) => {
            eventFiredWith = count;
        });

        const uri = mockUri('/test.txt');
        const content = new TextEncoder().encode('Queued Content');

        const handled = await syncEngine.handleWrite(uri, '/test.txt', content);
        assert.equal(handled, true);
        assert.equal(syncEngine.pendingCount, 1);
        assert.equal(eventFiredWith, 1);
        assert.equal(writtenFiles.has('/test.txt'), false, 'Should not write to server yet in manual mode');
    });

    it('should push all queued changes when pushAllChanges is called', async () => {
        workspace.configStore.set('syncMode', 'manual');
        const syncEngine = new SyncEngine(fakeSftp as any, fakeConflictDetector as any);

        const uri1 = mockUri('/file1.txt');
        const uri2 = mockUri('/file2.txt');

        const persisted: string[] = [];
        syncEngine.onDidPersist((u) => {
            persisted.push(u.path);
        });

        await syncEngine.handleWrite(uri1, '/file1.txt', new TextEncoder().encode('Doc 1'));
        await syncEngine.handleWrite(uri2, '/file2.txt', new TextEncoder().encode('Doc 2'));

        assert.equal(syncEngine.pendingCount, 2);
        assert.equal(persisted.length, 0, 'No onDidPersist fired on queueing');

        await syncEngine.pushAllChanges();

        assert.equal(syncEngine.pendingCount, 0, 'Pending changes should be flushed');
        assert.equal(writtenFiles.has('/file1.txt'), true);
        assert.equal(writtenFiles.has('/file2.txt'), true);
        assert.deepEqual(persisted, ['/file1.txt', '/file2.txt'], 'onDidPersist should fire for pushed files');
    });

    it('should discard single pending change and subtrees cleanly', async () => {
        workspace.configStore.set('syncMode', 'manual');
        const syncEngine = new SyncEngine(fakeSftp as any, fakeConflictDetector as any);

        const uri1 = mockUri('/dir/file1.txt');
        const uri2 = mockUri('/dir/file2.txt');
        const uri3 = mockUri('/other.txt');

        await syncEngine.handleWrite(uri1, '/dir/file1.txt', new TextEncoder().encode('1'));
        await syncEngine.handleWrite(uri2, '/dir/file2.txt', new TextEncoder().encode('2'));
        await syncEngine.handleWrite(uri3, '/other.txt', new TextEncoder().encode('3'));

        assert.equal(syncEngine.pendingCount, 3);

        const discardedSingle = syncEngine.discardPending(uri3);
        assert.equal(discardedSingle, true);
        assert.equal(syncEngine.pendingCount, 2);

        const dirUri = mockUri('/dir');
        const count = syncEngine.discardPendingSubtree(dirUri);
        assert.equal(count, 2);
        assert.equal(syncEngine.pendingCount, 0);
    });

    it('should rename pending changes correctly', async () => {
        workspace.configStore.set('syncMode', 'manual');
        const syncEngine = new SyncEngine(fakeSftp as any, fakeConflictDetector as any);

        const oldUri = mockUri('/old.txt');
        const newUri = mockUri('/new.txt');

        await syncEngine.handleWrite(oldUri, '/old.txt', new TextEncoder().encode('Data'));
        assert.equal(syncEngine.isPending(oldUri), true);

        const renamed = syncEngine.renamePending(oldUri, newUri);
        assert.equal(renamed, true);
        assert.equal(syncEngine.isPending(oldUri), false);
        assert.equal(syncEngine.isPending(newUri), true);

        const pending = syncEngine.getPendingChange(newUri);
        assert.equal(pending?.remotePath, '/new.txt');
    });
});
