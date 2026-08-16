import './setup.ts';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionManager } from '../src/connection/connectionManager.ts';

describe('ConnectionManager Unit Tests', () => {
    it('should calculate exponential backoff delay correctly using ConnectionManager.computeBackoffDelay', () => {
        // Direct call to ConnectionManager static method to ensure true regression coverage
        assert.equal(ConnectionManager.computeBackoffDelay(1), 1000);   // 1s
        assert.equal(ConnectionManager.computeBackoffDelay(2), 2000);   // 2s
        assert.equal(ConnectionManager.computeBackoffDelay(3), 4000);   // 4s
        assert.equal(ConnectionManager.computeBackoffDelay(4), 8000);   // 8s
        assert.equal(ConnectionManager.computeBackoffDelay(5), 16000);  // 16s
        assert.equal(ConnectionManager.computeBackoffDelay(6), 30000);  // 30s (capped)
        assert.equal(ConnectionManager.computeBackoffDelay(10), 30000); // 30s (capped)
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
