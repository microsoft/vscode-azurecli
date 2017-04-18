import { ResourceManagementClient } from 'azure-arm-resource';
import { ServiceClientCredentials } from 'ms-rest';

import { Disposable, window, CompletionItem, CompletionItemKind } from 'vscode';

import { Subscription, SubscriptionWatcher } from './subscriptionWatcher';
import { LoginWatcher } from './loginWatcher';
import { UIError } from './utils';

export interface Resource {
    id: string;
    name: string;
}

export function createGroupCache(loginWatcher: LoginWatcher, subscriptionWatcher: SubscriptionWatcher) {
    return new Cache<Resource>(loginWatcher, subscriptionWatcher, async (credentials: ServiceClientCredentials, subscription: Subscription): Promise<Resource[]> => {
        const client = new ResourceManagementClient(credentials, subscription.id);
        const groups = await client.resourceGroups.list();
        return groups as Resource[];
    });
}

export function createWebsiteCache(loginWatcher: LoginWatcher, subscriptionWatcher: SubscriptionWatcher) {
    return new Cache<Resource>(loginWatcher, subscriptionWatcher, async (credentials: ServiceClientCredentials, subscription: Subscription): Promise<Resource[]> => {
        const client = new ResourceManagementClient(credentials, subscription.id);
        const websites = await client.resources.list({ filter: 'resourceType eq \'Microsoft.Web/sites\'' });
        return websites as Resource[];
    });
}

export class Cache<T extends Resource> implements Disposable {

    private current: { [subscriptionId: string]: Promise<T[]>; } = {};
    private updates: { [subscriptionId: string]: Promise<T[]>; } = {};

    constructor(
        private loginWatcher: LoginWatcher,
        private subscriptionWatcher: SubscriptionWatcher,
        private load: (credentials: ServiceClientCredentials, subscription: Subscription) => Promise<T[]>) {
    }

    async getCompletions() {
        return this.fetch().then(resources => {
            return resources.map(resource => {
                const item = new CompletionItem(resource.name, CompletionItemKind.Folder);
                item.insertText = resource.name + ' ';
                return item;
            });
        }, err => {
            if (err instanceof UIError) {
                window.showInformationMessage(err.message);
                return [];
            }
            throw err;
        });
    }

    private async fetch() {
        const defaultSubscription = this.subscriptionWatcher.subscriptions.find(s => s.isDefault);
        if (!defaultSubscription) {
            throw new UIError('Not logged in, use "az login" to do so.');
        }
        const credentials = this.loginWatcher.lookupCredentials(defaultSubscription.tenantId);
        if (!credentials) {
            throw new UIError('Not logged in, use "az login" to do so.');
        }
        return this.update(credentials, defaultSubscription);
    }

    private async update(credentials: ServiceClientCredentials, subscription: Subscription): Promise<T[]> {

        let update = this.updates[subscription.id];
        if (!update) {

            update = this.load(credentials, subscription);
            this.updates[subscription.id] = update;

            update.then(() => {
                delete this.updates[subscription.id];
                this.current[subscription.id] = update;
            }, err => {
                delete this.updates[subscription.id];
                console.error(err);
            });
        }

        const current = this.current[subscription.id];
        if (current) {
            return Promise.race([new Promise<T[]>(resolve => setTimeout(resolve, 500, current)), update.catch(() => current)]);
        }
        return update;
    }

    dispose() {
    }
}
