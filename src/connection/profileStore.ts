import * as vscode from 'vscode';
import { AuthSecret } from './connectionManager';

export type AuthMethod =
| { type: 'password' }
| { type: 'privateKey'; keyPath: string };

export interface ConnectionProfile {
    id: string;
    label: string;
    host: string;
    port: number;
    username: string;
    auth: AuthMethod;
}

export class ProfileStore {
  constructor(private readonly context: vscode.ExtensionContext) {};
  async saveProfile(profile: ConnectionProfile, secret: AuthSecret): Promise<void> {
    const secretKey = `remoteforge.secret.${profile.id}`;
    await this.context.secrets.store(secretKey, JSON.stringify(secret));
    const existing = this.context.globalState.get<ConnectionProfile[]>('remoteforge.profiles') ?? [];
    const updated = [...existing, profile];
    await this.context.globalState.update('remoteforge.profiles', updated);  
  }

   getProfiles(): ConnectionProfile[] {
        return this.context.globalState.get<ConnectionProfile[]>('remoteforge.profiles') ?? [];
   }

   async getSecret(profileId: string): Promise<AuthSecret | undefined> {
    const secretKey = `remoteforge.secret.${profileId}`;
    const raw = await this.context.secrets.get(secretKey);
    if (!raw) {
        return undefined;
    }
    return JSON.parse(raw) as AuthSecret;
    }

    async deleteProfile(profileId: string): Promise<void> {
    const secretKey = `remoteforge.secret.${profileId}`;
    await this.context.secrets.delete(secretKey);

    const existing = this.context.globalState.get<ConnectionProfile[]>('remoteforge.profiles') ?? [];
    const updated = existing.filter((p) => p.id !== profileId);
    await this.context.globalState.update('remoteforge.profiles', updated);
    }
}
