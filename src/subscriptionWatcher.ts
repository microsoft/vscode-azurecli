import { readFile } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as equal from 'deep-equal';

import { Event, EventEmitter, Disposable } from 'vscode';

interface Profile {
    subscriptions: Subscription[];
}

export interface Subscription {
    tenantId: string;
    name: string;
    id: string;
    isDefault: boolean;
}

export class SubscriptionWatcher implements Disposable {

    subscriptions: Subscription[] = [];
    private onUpdatedEmitter = new EventEmitter<void>();
    onUpdated = this.onUpdatedEmitter.event;

    private timer: NodeJS.Timer;
    private disposed = false;

    constructor() {
        this.pollProfile();
    }

    private pollProfile() {
        this.loadProfile()
        .then(profile => profile.subscriptions, err => {
            if (err && err.code === 'ENOENT') {
                return [];
            }
            throw err;
        })
        .then(subscriptions => {
            if (!this.disposed) {
                if (!equal(this.subscriptions, subscriptions, { strict: true })) {
                    this.subscriptions.splice(0, this.subscriptions.length, ...subscriptions);
                    this.onUpdatedEmitter.fire();
                }
                this.timer = setTimeout(() => {
                    this.pollProfile();
                }, 1000);
            }
        }).catch(console.error);
    }

    private loadProfile() {
        return new Promise<Profile>((resolve, reject) => {
            readFile(join(homedir(), '.azure/azureProfile.json'), 'utf8', (err, data) => {
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
