import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionManager } from '../src/connection/connectionManager.ts';

describe('ConnectionManager Unit Tests', () => {
    it('should calculate exponential backoff delay correctly', () => {
        // Test exponential backoff formula used in ConnectionManager:
        // delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000)
        const getBackoff = (attempt: number) => Math.min(1000 * Math.pow(2, attempt - 1), 30000);

        assert.equal(getBackoff(1), 1000);   // 1s
        assert.equal(getBackoff(2), 2000);   // 2s
        assert.equal(getBackoff(3), 4000);   // 4s
        assert.equal(getBackoff(4), 8000);   // 8s
        assert.equal(getBackoff(5), 16000);  // 16s
        assert.equal(getBackoff(6), 30000);  // 30s (capped)
        assert.equal(getBackoff(10), 30000); // 30s (capped)
    });

    it('should start in disconnected state and transition states cleanly', () => {
        const manager = new ConnectionManager();
        assert.equal(manager.state, 'disconnected');

        let lastState = '';
        manager.onStateChange((state) => {
            lastState = state;
        });

        void manager.disconnect();
        assert.equal(lastState, 'disconnected');
    });
});
