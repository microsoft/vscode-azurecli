import { readFile } from 'fs';
import { execFile } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import * as equal from 'deep-equal';
import { ResourceManagementClient } from 'azure-arm-resource';

import { Event, EventEmitter, Disposable } from 'vscode';

import { Subscription, SubscriptionWatcher } from './subscriptionWatcher';
import { LoginWatcher } from './loginWatcher';
import { UIError } from './utils';

export interface Group {
    id: string;
    name: string;
}

export class GroupCache implements Disposable {

    private current: { [subscriptionId: string]: Promise<Group[]>; } = {};
    private updates: { [subscriptionId: string]: Promise<Group[]>; } = {};

    private defaultSubscriptionId: string | undefined;

    private disposables: Disposable[] = [];

    constructor(private loginWatcher: LoginWatcher, private subscriptionWatcher: SubscriptionWatcher) {
        this.disposables.push(subscriptionWatcher.onUpdated(() => this.onSubscriptionUpdated()))
        this.onSubscriptionUpdated()
    }

    private onSubscriptionUpdated() {
        const defaultSubscription = this.subscriptionWatcher.subscriptions.find(s => s.isDefault);
        const id = defaultSubscription && defaultSubscription.id;
        if (this.defaultSubscriptionId !== id) {
            this.defaultSubscriptionId = id;
            if (id) {
                this.updateGroups(id);
            }
        }
    }

    async fetchGroups() {
        if (!this.loginWatcher.credentials) {
            throw new UIError('Not logged in, use "az login" to do so.');
        }
        if (!this.defaultSubscriptionId) {
            throw new UIError('No subscription set, use "az account set <subscription> to do so.');
        }
        return this.updateGroups(this.defaultSubscriptionId);
    }

    private async updateGroups(subscriptionId: string): Promise<Group[]> {

        let update = this.updates[subscriptionId];
        if (!update) {

            update = this.loadGroups(subscriptionId);
            this.updates[subscriptionId] = update;

            update.then(groups => {
                delete this.updates[subscriptionId];
                this.current[subscriptionId] = update;
            }, err => {
                delete this.updates[subscriptionId];
                console.error(err);
            });
        }

        const current = this.current[subscriptionId];
        if (current) {
            return Promise.race([new Promise<Group[]>(resolve => setTimeout(resolve, 500, current)), update.catch(() => current)]);
        }
        return update;
    }

    private async loadGroups(subscriptionId: string): Promise<Group[]> {
        const client = new ResourceManagementClient(this.loginWatcher.credentials, subscriptionId);
        const groups = await client.resourceGroups.list();
        return groups as Group[];
    }

    private loadGroupsOld(subscriptionId: string): Promise<Group[]> {
        return new Promise((resolve, reject) => {
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
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
