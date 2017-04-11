import { readFile } from 'fs';
import { execFile } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import * as equal from 'deep-equal';

import { Event, EventEmitter, Disposable } from 'vscode';

import { Subscription, SubscriptionWatcher } from './subscriptionWatcher';

export interface Group {
    id: string;
    name: string;
}

export class GroupCache implements Disposable {

    private current: { [subscriptionId: string]: Promise<Group[]>; } = {};
    private updates: { [subscriptionId: string]: Promise<Group[]>; } = {};

    private defaultSubscriptionId: string | undefined;

    private disposables: Disposable[] = [];

    constructor(private watcher: SubscriptionWatcher) {
        this.disposables.push(watcher.onUpdated(() => this.onSubscriptionUpdated()))
        this.onSubscriptionUpdated()
    }

    private onSubscriptionUpdated() {
        const defaultSubscription = this.watcher.subscriptions.find(s => s.isDefault);
        const id = defaultSubscription && defaultSubscription.id;
        if (this.defaultSubscriptionId !== id) {
            this.defaultSubscriptionId = id;
            if (id) {
                this.updateGroups(id);
            }
        }
    }

    fetchGroups() {
        return this.defaultSubscriptionId ? this.updateGroups(this.defaultSubscriptionId) : Promise.reject('No subscription');
    }

    private updateGroups(subscriptionId: string) {
        if (this.updates[subscriptionId]) {
            return this.current[subscriptionId] || this.updates[subscriptionId];
        }

        const promise =  new Promise((resolve, reject) => {
            execFile('az', ['group', 'list'], (err, stdout, stderr) => {
                if (err || stderr) {
                    reject(err || stderr);
                } else {
                    const groups: Group[] = JSON.parse(stdout);
                    const filtered: Group[] = groups.filter(group => group.id.startsWith(`/subscriptions/${subscriptionId}/`));
                    if (groups.length && !filtered.length) {
                        reject('Subscription changed');
                    } else {
                        resolve(filtered);
                    }
                }
            });
        });
        
        this.updates[subscriptionId] = promise;
        promise.then(groups => {
            delete this.updates[subscriptionId];
            this.current[subscriptionId] = promise;
        }, err => {
            delete this.updates[subscriptionId];
            console.error(err);
        });

        return this.current[subscriptionId] || promise;
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
