import * as vscode from 'vscode';

export class Logger {
    private static instance: Logger;
    private outputChannel?: vscode.OutputChannel;

    private constructor() {
        if (typeof vscode !== 'undefined' && vscode?.window?.createOutputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('RemoteForge');
        }
    }

    static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    private timestamp(): string {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }

    info(message: string): void {
        this.outputChannel?.appendLine(`[${this.timestamp()}] [INFO] ${message}`);
    }

    warn(message: string): void {
        this.outputChannel?.appendLine(`[${this.timestamp()}] [WARN] ${message}`);
    }

    error(message: string, err?: unknown): void {
        const errorMsg = err instanceof Error ? err.message : String(err ?? '');
        const line = errorMsg
            ? `[${this.timestamp()}] [ERROR] ${message}: ${errorMsg}`
            : `[${this.timestamp()}] [ERROR] ${message}`;
        this.outputChannel?.appendLine(line);
    }

    show(): void {
        this.outputChannel?.show(true);
    }

    dispose(): void {
        this.outputChannel?.dispose();
    }
}
