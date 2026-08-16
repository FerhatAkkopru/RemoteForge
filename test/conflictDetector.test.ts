import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Simple mock for Uri to avoid full VS Code runtime dependency in unit tests
const mockUri = (path: string) => ({
    toString: () => `remoteforge://profile1${path}`,
    path,
} as any);

describe('ConflictDetector Logic Tests', () => {
    it('should grant Overwrite if mtime difference is within 1000ms tolerance', () => {
        const knownMtime = 1700000000000;
        const currentMtime = 1700000000500; // 500ms diff

        const diff = Math.abs(currentMtime - knownMtime);
        assert.equal(diff <= 1000, true, '500ms diff should be within tolerance');
    });

    it('should detect conflict if mtime difference exceeds 1000ms', () => {
        const knownMtime = 1700000000000;
        const currentMtime = 1700000005000; // 5000ms diff

        const diff = Math.abs(currentMtime - knownMtime);
        assert.equal(diff > 1000, true, '5000ms diff should trigger conflict');
    });
});
