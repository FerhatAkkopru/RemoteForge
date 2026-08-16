import './setup.ts';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictDetector, ConflictResolution } from '../src/sync/conflictDetector.ts';

const mockUri = (path: string) => ({
    toString: () => `remoteforge://profile1${path}`,
    path,
} as any);

describe('ConflictDetector Unit Tests', () => {
    it('should return Overwrite when no mtime is recorded', async () => {
        const fakeSftp = { getMtime: async () => 1700000000000 };
        const detector = new ConflictDetector(fakeSftp);

        const res = await detector.checkConflict(mockUri('/file.txt'), '/file.txt');
        assert.equal(res, ConflictResolution.Overwrite);
    });

    it('should return Overwrite when remote mtime is within 1000ms of known mtime', async () => {
        const fakeSftp = { getMtime: async () => 1700000000500 }; // 500ms difference
        const detector = new ConflictDetector(fakeSftp);

        const uri = mockUri('/file.txt');
        detector.recordMtime(uri, 1700000000000);

        const res = await detector.checkConflict(uri, '/file.txt');
        assert.equal(res, ConflictResolution.Overwrite);
    });

    it('should prompt user and return FetchRemote when remote mtime differs by >1000ms', async () => {
        const fakeSftp = { getMtime: async () => 1700000005000 }; // 5000ms difference
        let promptCalled = false;

        const fakePrompter = async (_msg: string, _opt: any, ..._items: string[]) => {
            promptCalled = true;
            return 'Fetch Remote Version';
        };

        const detector = new ConflictDetector(fakeSftp, fakePrompter);
        const uri = mockUri('/file.txt');
        detector.recordMtime(uri, 1700000000000);

        const res = await detector.checkConflict(uri, '/file.txt');
        assert.equal(promptCalled, true, 'User prompt should be triggered on conflict');
        assert.equal(res, ConflictResolution.FetchRemote);
    });

    it('should return Cancel when user cancels conflict prompt', async () => {
        const fakeSftp = { getMtime: async () => 1700000005000 };
        const fakePrompter = async () => 'Cancel';

        const detector = new ConflictDetector(fakeSftp, fakePrompter);
        const uri = mockUri('/file.txt');
        detector.recordMtime(uri, 1700000000000);

        const res = await detector.checkConflict(uri, '/file.txt');
        assert.equal(res, ConflictResolution.Cancel);
    });

    it('should open diff view and re-prompt user when Compare Differences is selected', async () => {
        const fakeSftp = { getMtime: async () => 1700000005000 };
        let promptCallCount = 0;

        const fakePrompter = async () => {
            promptCallCount++;
            if (promptCallCount === 1) {
                return 'Compare Differences';
            }
            return 'Overwrite Remote';
        };

        const detector = new ConflictDetector(fakeSftp, fakePrompter);
        const uri = mockUri('/file.txt');
        detector.recordMtime(uri, 1700000000000);

        const localContent = new TextEncoder().encode('Draft edits');
        const res = await detector.checkConflict(uri, '/file.txt', localContent);

        assert.equal(promptCallCount, 2, 'Should prompt once for Compare Differences, then re-prompt for final decision');
        assert.equal(res, ConflictResolution.Overwrite);
    });
});
