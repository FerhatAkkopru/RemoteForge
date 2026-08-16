import * as vscode from 'vscode';
import { SftpClient } from '../fs/sftpClient.js';
import { Logger } from '../ui/outputChannel.js';

export const ConflictResolution = {
    Overwrite: 'overwrite',
    FetchRemote: 'fetchRemote',
    Cancel: 'cancel',
} as const;

export type ConflictResolution = typeof ConflictResolution[keyof typeof ConflictResolution];

export type WarningPrompter = (
    message: string,
    options: { modal: boolean },
    ...items: string[]
) => Promise<string | undefined>;

export class ConflictDetector {
    private knownMtimes = new Map<string, number>();
    private logger = Logger.getInstance();

    constructor(
        private readonly sftpClient: Pick<SftpClient, 'getMtime'>,
        private readonly prompter?: WarningPrompter
    ) {}

    recordMtime(uri: vscode.Uri, mtime: number): void {
        this.knownMtimes.set(uri.toString(), mtime);
    }

    async checkConflict(uri: vscode.Uri, remotePath: string): Promise<ConflictResolution> {
        const knownMtime = this.knownMtimes.get(uri.toString());
        if (knownMtime === undefined) {
            return ConflictResolution.Overwrite;
        }

        try {
            const currentMtime = await this.sftpClient.getMtime(remotePath);

            // 1-second tolerance for filesystem rounding
            if (Math.abs(currentMtime - knownMtime) <= 1000) {
                return ConflictResolution.Overwrite;
            }

            this.logger.warn(
                `Conflict detected for ${remotePath}: ` +
                `known mtime=${new Date(knownMtime).toISOString()}, ` +
                `remote mtime=${new Date(currentMtime).toISOString()}`
            );

            const showWarning = this.prompter ?? vscode?.window?.showWarningMessage;
            const choice = showWarning
                ? await showWarning(
                    `"${remotePath}" has been modified on the server since you last opened it.`,
                    { modal: true },
                    'Overwrite Remote',
                    'Fetch Remote Version',
                    'Cancel'
                  )
                : 'Overwrite Remote';

            switch (choice) {
                case 'Overwrite Remote':
                    return ConflictResolution.Overwrite;
                case 'Fetch Remote Version':
                    return ConflictResolution.FetchRemote;
                default:
                    return ConflictResolution.Cancel;
            }
        } catch (err) {
            this.logger.error('Failed to check for conflicts', err);
            return ConflictResolution.Overwrite;
        }
    }

    clearMtime(uri: vscode.Uri): void {
        this.knownMtimes.delete(uri.toString());
    }

    dispose(): void {
        this.knownMtimes.clear();
    }
}
