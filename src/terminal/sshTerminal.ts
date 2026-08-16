import * as vscode from 'vscode';
import { Client, ClientChannel } from 'ssh2';
import { ConnectionManager } from '../connection/connectionManager.js';
import { Logger } from '../ui/outputChannel.js';

/**
 * SSH Pseudoterminal — opens an interactive shell on the remote server
 * inside VS Code's integrated terminal panel.
 *
 * Uses the existing SSH connection from ConnectionManager so no
 * separate auth is needed.
 */
export class SshTerminalProvider implements vscode.Pseudoterminal {
    private logger = Logger.getInstance();
    private channel: ClientChannel | undefined;

    private readonly _onDidWrite = new vscode.EventEmitter<string>();
    readonly onDidWrite = this._onDidWrite.event;

    private readonly _onDidClose = new vscode.EventEmitter<number | void>();
    readonly onDidClose = this._onDidClose.event;

    private readonly _onDidChangeName = new vscode.EventEmitter<string>();
    readonly onDidChangeName = this._onDidChangeName.event;

    private dimensions: { cols: number; rows: number } = { cols: 80, rows: 24 };

    constructor(private readonly connectionManager: ConnectionManager) {}

    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        if (initialDimensions) {
            this.dimensions = {
                cols: initialDimensions.columns,
                rows: initialDimensions.rows,
            };
        }

        void this.startShell();
    }

    private async startShell(): Promise<void> {
        try {
            const client = this.getClient();
            if (!client) {
                this._onDidWrite.fire(
                    '\r\n\x1b[31mRemoteForge: Not connected to any server. ' +
                    'Use "RemoteForge: Connect to Server" first.\x1b[0m\r\n'
                );
                this._onDidClose.fire(1);
                return;
            }

            const profile = this.connectionManager.activeProfile;
            const label = profile ? `${profile.username}@${profile.host}` : 'remote';
            this._onDidChangeName.fire(`RemoteForge: ${label}`);

            this._onDidWrite.fire(
                `\x1b[2mConnecting to ${label}...\x1b[0m\r\n`
            );

            this.channel = await this.openShellChannel(client);

            this.channel.on('data', (data: Buffer) => {
                this._onDidWrite.fire(data.toString('utf-8'));
            });

            this.channel.stderr.on('data', (data: Buffer) => {
                this._onDidWrite.fire(data.toString('utf-8'));
            });

            this.channel.on('close', () => {
                this._onDidWrite.fire(
                    '\r\n\x1b[2m[Connection closed]\x1b[0m\r\n'
                );
                this._onDidClose.fire(0);
                this.channel = undefined;
            });

            this.logger.info(`SSH terminal opened for ${label}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this._onDidWrite.fire(
                `\r\n\x1b[31mFailed to open SSH shell: ${msg}\x1b[0m\r\n`
            );
            this.logger.error('Failed to open SSH terminal', err);
            this._onDidClose.fire(1);
        }
    }

    private openShellChannel(client: Client): Promise<ClientChannel> {
        return new Promise((resolve, reject) => {
            client.shell(
                {
                    term: 'xterm-256color',
                    cols: this.dimensions.cols,
                    rows: this.dimensions.rows,
                },
                (err, stream) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(stream);
                }
            );
        });
    }

    handleInput(data: string): void {
        this.channel?.write(data);
    }

    setDimensions(dimensions: vscode.TerminalDimensions): void {
        this.dimensions = {
            cols: dimensions.columns,
            rows: dimensions.rows,
        };

        // Notify the SSH channel of the resize
        if (this.channel) {
            this.channel.setWindow(
                dimensions.rows,
                dimensions.columns,
                dimensions.rows * 12, // approximate pixel height
                dimensions.columns * 8  // approximate pixel width
            );
        }
    }

    close(): void {
        if (this.channel) {
            this.channel.close();
            this.channel = undefined;
        }
    }

    /**
     * Access the underlying SSH Client from ConnectionManager.
     * We use a getter method because ConnectionManager doesn't expose the client directly.
     */
    private getClient(): Client | undefined {
        // ConnectionManager.state tells us if connected
        if (this.connectionManager.state !== 'connected') {
            return undefined;
        }
        // We need to access the private client — use getSshClient() method we'll add
        return this.connectionManager.getSshClient();
    }
}
