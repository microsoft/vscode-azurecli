import { readFile } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as equal from 'deep-equal';
import { TokenCredentials, ServiceClientCredentials } from 'ms-rest';

import { Event, EventEmitter, Disposable } from 'vscode';

interface AccessToken {
    expiresOn: string;
    accessToken: string;
}

export class LoginWatcher implements Disposable {

    private token: AccessToken;
    credentials: ServiceClientCredentials;

    private timer: NodeJS.Timer;
    private disposed = false;

    constructor() {
        this.pollTokens();
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

        const token = tokens && tokens[0];
        if ((this.token && this.token.accessToken) !== (token && token.accessToken)) {
            this.token = token;
            this.credentials = token && new TokenCredentials(token.accessToken);
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
