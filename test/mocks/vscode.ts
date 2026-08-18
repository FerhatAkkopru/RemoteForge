export const window = {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    createOutputChannel: () => ({
        appendLine: () => {},
        show: () => {},
        dispose: () => {},
    }),
    withProgress: async (_options: any, task: (progress: any) => Promise<any>) => {
        return task({ report: () => {} });
    },
};

export class Uri {
    static parse(str: string) {
        return { toString: () => str, scheme: 'remoteforge', path: str };
    }
    static file(str: string) {
        return { toString: () => str, scheme: 'file', path: str };
    }
}

export class EventEmitter<T = any> {
    private listeners: ((e: T) => void)[] = [];
    event = (listener: (e: T) => void) => {
        this.listeners.push(listener);
        return { dispose: () => {} };
    };
    fire(data: T) {
        this.listeners.forEach((l) => l(data));
    }
    dispose() {}
}

export const commands = {
    executeCommand: async (_command: string, ..._args: any[]) => undefined,
};

export const workspace = {
    configStore: new Map<string, any>(),
    getConfiguration: (_section?: string) => ({
        get: <T>(key: string, defaultValue: T): T => {
            return workspace.configStore.has(key) ? workspace.configStore.get(key) : defaultValue;
        },
    }),
    openTextDocument: async (options: { content?: string }) => ({
        uri: Uri.parse('untitled:temp-draft'),
        getText: () => options.content || '',
    }),
};

export const ProgressLocation = {
    Notification: 15,
};

export const FileType = {
    Unknown: 0,
    File: 1,
    Directory: 2,
    SymbolicLink: 64,
};

export const FileChangeType = {
    Changed: 1,
    Created: 2,
    Deleted: 3,
};

export class FileSystemError extends Error {
    static FileNotFound(message?: any) { return new FileSystemError(String(message)); }
    static FileExists(message?: any) { return new FileSystemError(String(message)); }
    static Unavailable(message?: any) { return new FileSystemError(String(message)); }
}
