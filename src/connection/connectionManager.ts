import * as vscode from 'vscode';
import { Client, ConnectConfig, SFTPWrapper, HostVerifier } from 'ssh2';
import { ConnectionProfile } from './profileStore.js';
import { HostKeyStore } from './hostKeyStore.js';
import { Logger } from '../ui/outputChannel.js';

export type AuthSecret =
    | { type: 'password'; password: string }
    | { type: 'privateKey'; privateKey: string; passphrase?: string };

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export class ConnectionManager {
    private client: Client | undefined;
    private sftp: SFTPWrapper | undefined;
    private sftpPromise: Promise<SFTPWrapper> | null = null;
    private _state: ConnectionState = 'disconnected';
    private currentProfile: ConnectionProfile | undefined;
    private currentSecret: AuthSecret | undefined;
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts = 5;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private logger = Logger.getInstance();
    private hostKeyStore: HostKeyStore | undefined;

    setHostKeyStore(store: HostKeyStore): void {
        this.hostKeyStore = store;
    }

    // Gate mechanism: getSftp() waits on this promise until connection is ready
    private connectGate: Promise<void> | null = null;
    private connectGateResolve: (() => void) | null = null;

    private readonly _onStateChange = new vscode.EventEmitter<ConnectionState>();
    readonly onStateChange = this._onStateChange.event;

    get state(): ConnectionState {
        return this._state;
    }

    get activeProfile(): ConnectionProfile | undefined {
        return this.currentProfile;
    }

    /**
     * Exposes the raw SSH2 Client for modules that need direct channel access
     * (e.g. the SSH terminal).
     */
    getSshClient(): Client | undefined {
        return this.client;
    }

    private setState(state: ConnectionState): void {
        this._state = state;
        this._onStateChange.fire(state);
    }

    /**
     * Call before async prep work (e.g. fetching secrets) to make
     * getSftp() wait instead of throwing 'Not connected'.
     */
    prepareConnection(): void {
        if (!this.connectGate) {
            this.connectGate = new Promise<void>((resolve) => {
                this.connectGateResolve = resolve;
            });
        }
    }

    private resolveGate(): void {
        if (this.connectGateResolve) {
            this.connectGateResolve();
            this.connectGate = null;
            this.connectGateResolve = null;
        }
    }

    async connect(profile: ConnectionProfile, secret: AuthSecret): Promise<void> {
        // Disconnect any existing connection first
        if (this.client) {
            await this.disconnect();
        }
        this.currentProfile = profile;
        this.currentSecret = secret;
        this.reconnectAttempts = 0;
        this.prepareConnection(); // Ensure gate is set
        try {
            await this.doConnect();
            this.resolveGate();
        } catch (err) {
            this.resolveGate(); // Unblock waiters even on failure
            throw err;
        }
    }

    private doConnect(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.currentProfile || !this.currentSecret) {
                reject(new Error('No profile or secret set'));
                return;
            }

            this.setState('connecting');
            this.logger.info(
                `Connecting to ${this.currentProfile.username}@${this.currentProfile.host}:${this.currentProfile.port}...`
            );

            const conn = new Client();
            let settled = false;

            conn.on('ready', () => {
                this.client = conn;
                this.reconnectAttempts = 0;
                this.setState('connected');
                this.logger.info(`Connected to ${this.currentProfile!.label}`);
                if (!settled) {
                    settled = true;
                    resolve();
                }
            });

            conn.on('error', (err: Error) => {
                this.logger.error('SSH connection error', err);
                this.setState('error');
                if (!settled) {
                    settled = true;
                    reject(err);
                }
            });

            conn.on('end', () => {
                this.logger.warn('SSH connection ended');
                this.sftp = undefined;
                this.sftpPromise = null;
                if (this._state === 'connected') {
                    this.setState('disconnected');
                    this.attemptReconnect();
                }
            });

            conn.on('close', () => {
                this.sftp = undefined;
                this.sftpPromise = null;
                if (this._state === 'connected') {
                    this.setState('disconnected');
                    this.attemptReconnect();
                }
            });

            const config: ConnectConfig = {
                host: this.currentProfile.host,
                port: this.currentProfile.port,
                username: this.currentProfile.username,
                readyTimeout: 15000,
            };

            // Host key verification (TOFU model — async callback pattern)
            if (this.hostKeyStore) {
                const store = this.hostKeyStore;
                const profile = this.currentProfile;
                config.hostVerifier = ((key: Buffer, verify: (valid: boolean) => void) => {
                    store.verify(
                        profile.host,
                        profile.port,
                        key.toString('hex').substring(0, 20), // algorithm hint
                        key
                    ).then((valid) => verify(valid))
                     .catch(() => verify(false));
                }) as HostVerifier;
            }

            if (this.currentSecret.type === 'password') {
                config.password = this.currentSecret.password;
            } else {
                config.privateKey = this.currentSecret.privateKey;
                config.passphrase = this.currentSecret.passphrase;
            }

            conn.connect(config);
        });
    }

    private attemptReconnect(): void {
        if (!this.currentProfile || !this.currentSecret) { return; }
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error(`Reconnection failed after ${this.maxReconnectAttempts} attempts`);
            this.setState('error');
            void vscode.window.showErrorMessage(
                `RemoteForge: Lost connection to ${this.currentProfile.label}. Max reconnection attempts reached.`,
                'Retry'
            ).then((choice) => {
                if (choice === 'Retry') {
                    this.reconnectAttempts = 0;
                    this.attemptReconnect();
                }
            });
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
        this.logger.info(
            `Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
        );

        this.reconnectTimer = setTimeout(() => {
            void this.doConnect().catch(() => {
                // doConnect failure triggers 'error' event → attemptReconnect cycles
            });
        }, delay);
    }

    async getSftp(): Promise<SFTPWrapper> {
        // Wait for any in-progress connection attempt to complete
        if (this.connectGate) {
            await this.connectGate;
        }

        if (this.sftp) { return this.sftp; }
        if (!this.client) {
            throw new Error('Not connected to any server');
        }

        // Deduplicate: if SFTP is already being initialized, reuse that promise
        if (this.sftpPromise) {
            return this.sftpPromise;
        }

        this.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
            this.client!.sftp((err, sftp) => {
                this.sftpPromise = null;
                if (err) {
                    this.logger.error('Failed to start SFTP subsystem', err);
                    reject(err);
                    return;
                }
                this.sftp = sftp;
                this.logger.info('SFTP subsystem started');
                resolve(sftp);
            });
        });

        return this.sftpPromise;
    }

    async disconnect(): Promise<void> {
        this.resolveGate(); // Unblock any waiters
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.sftp = undefined;
        this.sftpPromise = null;
        if (this.client) {
            this.client.end();
            this.client = undefined;
        }
        this.currentProfile = undefined;
        this.currentSecret = undefined;
        this.reconnectAttempts = 0;
        this.setState('disconnected');
        this.logger.info('Disconnected');
    }

    dispose(): void {
        void this.disconnect();
        this._onStateChange.dispose();
    }
}