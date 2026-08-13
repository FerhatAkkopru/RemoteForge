import * as vscode from 'vscode';

export type ConnectionDisplayState = 'disconnected' | 'connecting' | 'connected' | 'error';

export class StatusBar {
    private item: vscode.StatusBarItem;
    private state: ConnectionDisplayState = 'disconnected';
    private pendingCount = 0;
    private profileLabel = '';

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.item.command = 'remoteforge.connect';
        this.update();
        this.item.show();
    }

    setState(state: ConnectionDisplayState, profileLabel?: string): void {
        this.state = state;
        if (profileLabel !== undefined) {
            this.profileLabel = profileLabel;
        }
        this.update();
    }

    setPendingCount(count: number): void {
        this.pendingCount = count;
        this.update();
    }

    private update(): void {
        switch (this.state) {
            case 'disconnected':
                this.item.text = '$(debug-disconnect) RemoteForge';
                this.item.tooltip = 'Click to connect to a server';
                this.item.backgroundColor = undefined;
                break;
            case 'connecting':
                this.item.text = '$(sync~spin) Connecting...';
                this.item.tooltip = `Connecting to ${this.profileLabel}`;
                this.item.backgroundColor = undefined;
                break;
            case 'connected': {
                let text = `$(remote) ${this.profileLabel}`;
                if (this.pendingCount > 0) {
                    text += ` $(cloud-upload) ${this.pendingCount}`;
                }
                this.item.text = text;
                this.item.tooltip = this.pendingCount > 0
                    ? `Connected — ${this.pendingCount} pending change(s)`
                    : `Connected to ${this.profileLabel}`;
                this.item.backgroundColor = undefined;
                break;
            }
            case 'error':
                this.item.text = '$(error) RemoteForge';
                this.item.tooltip = 'Connection error — click to reconnect';
                this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
        }
    }

    dispose(): void {
        this.item.dispose();
    }
}
