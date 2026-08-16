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

        await syncEngine.handleWrite(uri1, '/file1.txt', new TextEncoder().encode('Doc 1'));
        await syncEngine.handleWrite(uri2, '/file2.txt', new TextEncoder().encode('Doc 2'));

        assert.equal(syncEngine.pendingCount, 2);

        await syncEngine.pushAllChanges();

        assert.equal(syncEngine.pendingCount, 0, 'Pending changes should be flushed');
        assert.equal(writtenFiles.has('/file1.txt'), true);
        assert.equal(writtenFiles.has('/file2.txt'), true);
    });
});
