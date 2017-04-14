import { readFile } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as equal from 'deep-equal';
import { TokenCredentials, ServiceClientCredentials } from 'ms-rest';

import { Disposable } from 'vscode';

interface AccessToken {
    accessToken: string;
    _authority: string;
    expiresOn: string;
}

export class LoginWatcher implements Disposable {

    private tokens: AccessToken[];
    private credentials: { [authority: string]: ServiceClientCredentials } = {};

    private timer: NodeJS.Timer;
    private disposed = false;

    constructor() {
        this.pollTokens();
    }

    lookupCredentials(tenantId: string) {
        return this.credentials[`https://login.microsoftonline.com/${tenantId}`];
    }

    private async pollTokens() {
        let tokens: AccessToken[] = [];
        try {
            tokens = await this.loadTokens();
        } catch (e) {
            if (!e || e.code !== 'ENOENT') {
                console.error(e);
                return;
            }
        }

        if (!equal(this.tokens, tokens, { strict: true })) {
            this.tokens = tokens;
            this.credentials = (this.tokens || []).reduce((credentials, token) => Object.assign(credentials, { [token._authority]: new TokenCredentials(token.accessToken) }), {});
        }
        this.timer = setTimeout(() => {
            if (!this.disposed) {
                this.pollTokens();
            }
        }, 1000);
    }

    private async loadTokens() {
        return new Promise<AccessToken[]>((resolve, reject) => {
            readFile(join(homedir(), '.azure/accessTokens.json'), 'utf8', (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(JSON.parse(data.replace(/^\uFEFF/, '')));
                }
            });
        });
    }

    dispose() {
        this.disposed = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
    }
}
