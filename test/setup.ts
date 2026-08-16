import Module from 'node:module';

const mockVscode = {
    window: {
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        createOutputChannel: () => ({
            appendLine: () => {},
            show: () => {},
            dispose: () => {},
        }),
    },
    Uri: {
        parse: (str: string) => ({ toString: () => str, scheme: 'remoteforge', path: str }),
        file: (str: string) => ({ toString: () => str, scheme: 'file', path: str }),
    },
};

const originalRequire = (Module.prototype as any).require;
(Module.prototype as any).require = function (id: string) {
    if (id === 'vscode') {
        return mockVscode;
    }
    return originalRequire.apply(this, arguments);
};
