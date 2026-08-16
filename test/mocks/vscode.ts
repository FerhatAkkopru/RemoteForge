export const window = {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    createOutputChannel: () => ({
        appendLine: () => {},
        show: () => {},
        dispose: () => {},
    }),
};

export class Uri {
    static parse(str: string) {
        return { toString: () => str, scheme: 'remoteforge', path: str };
    }
    static file(str: string) {
        return { toString: () => str, scheme: 'file', path: str };
    }
}
