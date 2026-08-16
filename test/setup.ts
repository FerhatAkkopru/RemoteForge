import Module from 'node:module';
import * as mockVscode from './mocks/vscode.js';

const originalRequire = (Module.prototype as any).require;
(Module.prototype as any).require = function (id: string) {
    if (id === 'vscode') {
        return mockVscode;
    }
    return originalRequire.apply(this, arguments);
};
