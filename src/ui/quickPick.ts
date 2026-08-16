import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConnectionProfile, ProfileStore } from '../connection/profileStore.js';
import { AuthSecret } from '../connection/connectionManager.js';

export async function showAddProfileDialog(
    profileStore: ProfileStore
): Promise<ConnectionProfile | undefined> {
    // Step 1: Label
    const label = await vscode.window.showInputBox({
        title: 'RemoteForge: New Server Profile (1/5)',
        prompt: 'Enter a label for this profile',
        placeHolder: 'e.g. My Production Server',
        validateInput: (v) => v.trim() ? undefined : 'Label cannot be empty',
    });
    if (!label) { return undefined; }

    // Step 2: Host
    const host = await vscode.window.showInputBox({
        title: 'RemoteForge: New Server Profile (2/5)',
        prompt: 'Enter the hostname or IP address',
        placeHolder: 'e.g. 192.168.1.100 or myserver.com',
        validateInput: (v) => v.trim() ? undefined : 'Host cannot be empty',
    });
    if (!host) { return undefined; }

    // Step 3: Port
    const portStr = await vscode.window.showInputBox({
        title: 'RemoteForge: New Server Profile (3/5)',
        prompt: 'Enter the SSH port',
        value: '22',
        validateInput: (v) => {
            const n = parseInt(v, 10);
            return (n > 0 && n <= 65535) ? undefined : 'Port must be 1–65535';
        },
    });
    if (!portStr) { return undefined; }

    // Step 4: Username
    const username = await vscode.window.showInputBox({
        title: 'RemoteForge: New Server Profile (4/5)',
        prompt: 'Enter the SSH username',
        placeHolder: 'e.g. root',
        validateInput: (v) => v.trim() ? undefined : 'Username cannot be empty',
    });
    if (!username) { return undefined; }

    // Step 5: Auth method
    interface AuthPickItem extends vscode.QuickPickItem {
        value: 'password' | 'privateKey';
    }
    const authPick = await vscode.window.showQuickPick<AuthPickItem>(
        [
            { label: '$(key) Password', description: 'Authenticate with password', value: 'password' },
            { label: '$(file) SSH Private Key', description: 'Authenticate with private key file', value: 'privateKey' },
        ],
        { title: 'RemoteForge: New Server Profile (5/5)', placeHolder: 'Select authentication method' }
    );
    if (!authPick) { return undefined; }

    let secret: AuthSecret;
    let authMethod: ConnectionProfile['auth'];

    if (authPick.value === 'password') {
        const password = await vscode.window.showInputBox({
            title: 'RemoteForge: Enter Password',
            prompt: `Password for ${username}@${host}`,
            password: true,
            validateInput: (v) => v ? undefined : 'Password cannot be empty',
        });
        if (!password) { return undefined; }
        secret = { type: 'password', password };
        authMethod = { type: 'password' };
    } else {
        const defaultKeyPath = path.join(os.homedir(), '.ssh', 'id_rsa');
        const keyPath = await vscode.window.showInputBox({
            title: 'RemoteForge: SSH Key Path',
            prompt: 'Path to your private key file',
            value: fsSync.existsSync(defaultKeyPath) ? defaultKeyPath : '',
            validateInput: (v) => {
                if (!v.trim()) { return 'Key path cannot be empty'; }
                if (!fsSync.existsSync(v)) { return 'File does not exist'; }
                return undefined;
            },
        });
        if (!keyPath) { return undefined; }

        const privateKey = await fs.readFile(keyPath, 'utf-8');

        const passphrase = await vscode.window.showInputBox({
            title: 'RemoteForge: Key Passphrase',
            prompt: 'Enter passphrase (leave empty if none)',
            password: true,
        });
        if (passphrase === undefined) { return undefined; }

        secret = { type: 'privateKey', privateKey, passphrase: passphrase || undefined };
        authMethod = { type: 'privateKey', keyPath };
    }

    const profile: ConnectionProfile = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        label: label.trim(),
        host: host.trim(),
        port: parseInt(portStr, 10),
        username: username.trim(),
        auth: authMethod,
    };

    await profileStore.saveProfile(profile, secret);
    return profile;
}

export async function showProfilePicker(
    profileStore: ProfileStore
): Promise<ConnectionProfile | 'add_new' | undefined> {
    const profiles = profileStore.getProfiles();

    interface ProfilePickItem extends vscode.QuickPickItem {
        profileId?: string;
        action?: string;
    }

    const items: ProfilePickItem[] = profiles.map((p) => ({
        label: `$(server) ${p.label}`,
        description: `${p.username}@${p.host}:${p.port}`,
        profileId: p.id,
    }));

    items.push({
        label: '$(add) Add New Server Profile',
        description: '',
        action: 'add_new',
    });

    const pick = await vscode.window.showQuickPick(items, {
        title: 'RemoteForge: Select Server',
        placeHolder: 'Choose a server to connect to',
    });

    if (!pick) { return undefined; }
    if (pick.action === 'add_new') { return 'add_new'; }
    return profiles.find((p) => p.id === pick.profileId);
}
