import * as vscode from 'vscode';
import { ConnectionManager } from './connection/connectionManager.js';
import { ConnectionProfile, ProfileStore } from './connection/profileStore.js';
import { SftpClient } from './fs/sftpClient.js';
import { RemoteFileSystemProvider } from './fs/remoteFileSystemProvider.js';
import { SyncEngine } from './sync/syncEngine.js';
import { ConflictDetector } from './sync/conflictDetector.js';
import { Logger } from './ui/outputChannel.js';
import { StatusBar } from './ui/statusBar.js';
import { showAddProfileDialog, showProfilePicker } from './ui/quickPick.js';

export function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    logger.info('RemoteForge is activating...');

    // --- Core services ---
    const profileStore = new ProfileStore(context);
    const connectionManager = new ConnectionManager();
    const sftpClient = new SftpClient(connectionManager);
    const conflictDetector = new ConflictDetector(sftpClient);
    const syncEngine = new SyncEngine(sftpClient, conflictDetector);
    const fsProvider = new RemoteFileSystemProvider(sftpClient, syncEngine, conflictDetector);

    // --- UI ---
    const statusBar = new StatusBar();

    // Wire status bar to connection state changes
    connectionManager.onStateChange((state) => {
        const profile = connectionManager.activeProfile;
        statusBar.setState(state, profile?.label);
    });

    // Wire status bar to pending changes count
    syncEngine.onPendingCountChange((count) => {
        statusBar.setPendingCount(count);
    });

    // --- Register FileSystemProvider ---
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('remoteforge', fsProvider, {
            isCaseSensitive: true,
        })
    );

    // --- Commands ---

    // Connect to server
    const connectCmd = vscode.commands.registerCommand('remoteforge.connect', async () => {
        try {
            const picked = await showProfilePicker(profileStore);

            let profile: ConnectionProfile | undefined;
            if (picked === 'add_new') {
                profile = await showAddProfileDialog(profileStore);
            } else {
                profile = picked;
            }

            if (!profile) { return; }

            const secret = await profileStore.getSecret(profile.id);
            if (!secret) {
                void vscode.window.showErrorMessage(
                    'RemoteForge: Could not retrieve credentials for this profile.'
                );
                return;
            }

            await connectionManager.connect(profile, secret);

            // Ask for remote path to open
            const remotePath = await vscode.window.showInputBox({
                title: 'RemoteForge: Remote Path',
                prompt: 'Enter the remote directory path to open',
                value: '/',
                validateInput: (v) => v.startsWith('/') ? undefined : 'Path must be absolute (start with /)',
            });

            if (!remotePath) { return; }

            // Add workspace folder with remoteforge:// URI
            const uri = vscode.Uri.parse(`remoteforge://${profile.id}${remotePath}`);
            const folderName = `${profile.label} (${remotePath})`;

            vscode.workspace.updateWorkspaceFolders(
                vscode.workspace.workspaceFolders?.length ?? 0,
                null,
                { uri, name: folderName }
            );

            logger.info(`Opened remote folder: ${folderName}`);
            void vscode.window.showInformationMessage(
                `RemoteForge: Connected to ${profile.label}`
            );
        } catch (err) {
            logger.error('Connection failed', err);
            void vscode.window.showErrorMessage(
                `RemoteForge: Connection failed — ${err instanceof Error ? err.message : String(err)}`
            );
        }
    });

    // Disconnect
    const disconnectCmd = vscode.commands.registerCommand('remoteforge.disconnect', async () => {
        if (connectionManager.state === 'disconnected') {
            void vscode.window.showInformationMessage('RemoteForge: Not connected.');
            return;
        }

        // Remove remoteforge workspace folders
        const folders = vscode.workspace.workspaceFolders ?? [];
        const remoteFolderIndices = folders
            .map((f, i) => (f.uri.scheme === 'remoteforge' ? i : -1))
            .filter((i) => i >= 0)
            .reverse(); // Remove from end to preserve indices

        for (const idx of remoteFolderIndices) {
            vscode.workspace.updateWorkspaceFolders(idx, 1);
        }

        await connectionManager.disconnect();
        void vscode.window.showInformationMessage('RemoteForge: Disconnected.');
    });

    // Add profile
    const addProfileCmd = vscode.commands.registerCommand('remoteforge.addProfile', async () => {
        const profile = await showAddProfileDialog(profileStore);
        if (profile) {
            void vscode.window.showInformationMessage(
                `RemoteForge: Profile "${profile.label}" saved.`
            );
        }
    });

    // Delete profile
    const deleteProfileCmd = vscode.commands.registerCommand('remoteforge.deleteProfile', async () => {
        const profiles = profileStore.getProfiles();
        if (profiles.length === 0) {
            void vscode.window.showInformationMessage('RemoteForge: No profiles to delete.');
            return;
        }

        interface ProfileItem extends vscode.QuickPickItem {
            profileId: string;
        }

        const items: ProfileItem[] = profiles.map((p) => ({
            label: p.label,
            description: `${p.username}@${p.host}:${p.port}`,
            profileId: p.id,
        }));

        const pick = await vscode.window.showQuickPick(items, {
            title: 'RemoteForge: Delete Profile',
            placeHolder: 'Select a profile to delete',
        });

        if (!pick) { return; }

        const confirm = await vscode.window.showWarningMessage(
            `Delete profile "${pick.label}"? This cannot be undone.`,
            { modal: true },
            'Delete'
        );

        if (confirm === 'Delete') {
            await profileStore.deleteProfile(pick.profileId);
            void vscode.window.showInformationMessage(
                `RemoteForge: Profile "${pick.label}" deleted.`
            );
        }
    });

    // Push changes (manual sync mode)
    const pushChangesCmd = vscode.commands.registerCommand('remoteforge.pushChanges', async () => {
        await syncEngine.pushAllChanges();
    });

    // Show log
    const showLogCmd = vscode.commands.registerCommand('remoteforge.showLog', () => {
        logger.show();
    });

    // --- Register disposables ---
    context.subscriptions.push(
        connectCmd,
        disconnectCmd,
        addProfileCmd,
        deleteProfileCmd,
        pushChangesCmd,
        showLogCmd,
        statusBar,
        connectionManager,
        fsProvider,
        syncEngine,
        conflictDetector,
        logger,
    );

    logger.info('RemoteForge activated successfully');

    // --- Auto-reconnect if remoteforge:// workspace folders exist from a previous session ---
    const existingRemoteFolders = (vscode.workspace.workspaceFolders ?? []).filter(
        (f) => f.uri.scheme === 'remoteforge'
    );

    if (existingRemoteFolders.length > 0) {
        const profileId = existingRemoteFolders[0].uri.authority;
        const profile = profileStore.getProfiles().find((p) => p.id === profileId);

        if (profile) {
            // Set the gate SYNCHRONOUSLY so all FileSystemProvider queries wait
            connectionManager.prepareConnection();

            void (async () => {
                try {
                    const secret = await profileStore.getSecret(profile.id);
                    if (secret) {
                        logger.info(`Auto-reconnecting to ${profile.label}...`);
                        await connectionManager.connect(profile, secret);
                        logger.info(`Auto-reconnected to ${profile.label}`);
                    } else {
                        logger.warn(`No credentials found for ${profile.label}, skipping auto-reconnect`);
                    }
                } catch (err) {
                    logger.error('Auto-reconnect failed', err);
                    void vscode.window.showWarningMessage(
                        `RemoteForge: Auto-reconnect to "${profile.label}" failed. Use "Connect to Server" to reconnect manually.`
                    );
                }
            })();
        }
    }
}

export function deactivate() {
    // All cleanup handled by disposables registered in context.subscriptions
}