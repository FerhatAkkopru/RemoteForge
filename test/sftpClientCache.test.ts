import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SftpClient } from '../src/fs/sftpClient.ts';
import { EventEmitter } from './mocks/vscode.js';

describe('SftpClient Cache & Invalidation Unit Tests', () => {
    it('should pre-populate child statCache when readDirectory is called', async () => {
        let readdirCalls = 0;
        let statCalls = 0;

        const fakeStats = {
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
            size: 1024,
            mtime: 1700000000,
        };

        const fakeSftp = {
            readdir: (_path: string, cb: any) => {
                readdirCalls++;
                cb(null, [
                    {
                        filename: 'index.html',
                        attrs: fakeStats,
                    },
                ]);
            },
            stat: (_path: string, cb: any) => {
                statCalls++;
                cb(null, fakeStats);
            },
        };

        const fakeConnectionManager = {
            onStateChange: new EventEmitter().event,
            getSftp: async () => fakeSftp,
        };

        const client = new SftpClient(fakeConnectionManager as any);

        // First call readDirectory
        const entries = await client.readDirectory('/var/www');
        assert.equal(entries.length, 1);
        assert.equal(readdirCalls, 1);

        // Now stat the child file — should hit pre-populated cache and NOT call sftp.stat!
        const fileStat = await client.stat('/var/www/index.html');
        assert.equal(fileStat.size, 1024);
        assert.equal(statCalls, 0, 'stat() should serve from cache without network call');
    });

    it('should clear caches when disconnected state is fired', async () => {
        let statCalls = 0;
        const fakeStats = {
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
            size: 512,
            mtime: 1700000000,
        };

        const fakeSftp = {
            stat: (_path: string, cb: any) => {
                statCalls++;
                cb(null, fakeStats);
            },
        };

        const stateEmitter = new EventEmitter<string>();
        const fakeConnectionManager = {
            onStateChange: stateEmitter.event,
            getSftp: async () => fakeSftp,
        };

        const client = new SftpClient(fakeConnectionManager as any);

        // Fetch stat first time
        await client.stat('/test.txt');
        assert.equal(statCalls, 1);

        // Fetch stat second time — served from cache
        await client.stat('/test.txt');
        assert.equal(statCalls, 1);

        // Trigger disconnect event
        stateEmitter.fire('disconnected');

        // Fetch stat third time — cache cleared, should call sftp.stat again
        await client.stat('/test.txt');
        assert.equal(statCalls, 2, 'Cache should be invalidated after disconnect');
    });
});
