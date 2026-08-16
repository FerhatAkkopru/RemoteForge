import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Logger } from '../ui/outputChannel.js';

interface StoredHostKey {
    fingerprint: string;   // SHA-256 hex digest
    algorithm: string;     // e.g. 'ssh-rsa', 'ssh-ed25519'
    trustedAt: number;     // Date.now() timestamp
}

const STORAGE_KEY = 'remoteforge.knownHosts';

/**
 * Trust On First Use (TOFU) host key store.
 * Stores trusted SSH server fingerprints in VS Code globalState.
 * Mimics OpenSSH's known_hosts behaviour:
 *   - Unknown host → ask user to trust
 *   - Known & matching → allow silently
 *   - Known but CHANGED → warn loudly (possible MITM)
 */
export class HostKeyStore {
    private logger = Logger.getInstance();

    constructor(private readonly globalState: vscode.Memento) {}

    private getAll(): Record<string, StoredHostKey> {
        return this.globalState.get<Record<string, StoredHostKey>>(STORAGE_KEY, {});
    }

    private hostId(host: string, port: number): string {
        return `${host}:${port}`;
    }

    /**
     * Compute SHA-256 fingerprint of a host key buffer.
     */
    fingerprint(key: Buffer): string {
        return crypto.createHash('sha256').update(key).digest('hex');
    }

    /**
     * Verify a host key. Returns true if the connection should proceed.
     * Shows appropriate dialogs for unknown or changed keys.
     */
    async verify(
        host: string,
        port: number,
        keyAlgorithm: string,
        key: Buffer,
    ): Promise<boolean> {
        const id = this.hostId(host, port);
        const fp = this.fingerprint(key);
        const all = this.getAll();
        const stored = all[id];

        if (!stored) {
            // First connection to this host — ask user to trust
            return this.promptFirstUse(id, host, port, keyAlgorithm, fp, all);
        }

        if (stored.fingerprint === fp) {
            // Known host, fingerprint matches — proceed silently
            return true;
        }

        // DANGER: fingerprint changed — possible MITM attack
        return this.promptKeyChanged(id, host, port, keyAlgorithm, fp, stored, all);
    }

    private async promptFirstUse(
        id: string,
        host: string,
        port: number,
        algorithm: string,
        fp: string,
        all: Record<string, StoredHostKey>,
    ): Promise<boolean> {
        const shortFp = fp.substring(0, 16) + '...';
        const choice = await vscode.window.showWarningMessage(
            `RemoteForge: The authenticity of host "${host}:${port}" can't be established.\n` +
            `SSH Host Key Fingerprint is SHA256:${shortFp}\n` +
            `Are you sure you want to continue connecting?`,
            { modal: true },
            'Yes, Trust This Host',
            'No, Abort'
        );

        if (choice === 'Yes, Trust This Host') {
            all[id] = { fingerprint: fp, algorithm, trustedAt: Date.now() };
            await this.globalState.update(STORAGE_KEY, all);
            this.logger.info(`Trusted new host key for ${host}:${port} (${algorithm})`);
            return true;
        }

        this.logger.warn(`User rejected host key for ${host}:${port}`);
        return false;
    }

    private async promptKeyChanged(
        id: string,
        host: string,
        port: number,
        algorithm: string,
        newFp: string,
        stored: StoredHostKey,
        all: Record<string, StoredHostKey>,
    ): Promise<boolean> {
        const oldShortFp = stored.fingerprint.substring(0, 16) + '...';
        const newShortFp = newFp.substring(0, 16) + '...';

        this.logger.error(
            `HOST KEY CHANGED for ${host}:${port}!\n` +
            `Old: ${stored.algorithm} SHA256:${oldShortFp}\n` +
            `New: ${algorithm} SHA256:${newShortFp}\n` +
            `This could indicate a man-in-the-middle attack!`
        );

        const choice = await vscode.window.showWarningMessage(
            `⚠️ WARNING: HOST KEY FOR "${host}:${port}" HAS CHANGED!\n\n` +
            `Old fingerprint: SHA256:${oldShortFp}\n` +
            `New fingerprint: SHA256:${newShortFp}\n\n` +
            `This could indicate a man-in-the-middle attack.\n` +
            `Only proceed if you know the server was reinstalled or its keys were regenerated.`,
            { modal: true },
            'Update and Trust New Key',
            'Abort Connection'
        );

        if (choice === 'Update and Trust New Key') {
            all[id] = { fingerprint: newFp, algorithm, trustedAt: Date.now() };
            await this.globalState.update(STORAGE_KEY, all);
            this.logger.warn(`User accepted changed host key for ${host}:${port}`);
            return true;
        }

        this.logger.warn(`User rejected changed host key for ${host}:${port} — connection aborted`);
        return false;
    }

    /**
     * Remove a stored host key (e.g. when deleting a profile).
     */
    async remove(host: string, port: number): Promise<void> {
        const id = this.hostId(host, port);
        const all = this.getAll();
        delete all[id];
        await this.globalState.update(STORAGE_KEY, all);
    }
}
