import { Uri, ExtensionContext, Range, TextDocument, languages, Position, CancellationToken, ProviderResult, CompletionItem, CompletionList, CompletionItemKind, CompletionItemProvider, TextLine } from 'vscode';

import { loadMap, Group, Command } from './commandMap';
import { Subscription, SubscriptionWatcher } from './subscriptionWatcher';
import { Group as ResourceGroup, GroupCache } from './groupCache';

export function activate(context: ExtensionContext) {
    const watcher = new SubscriptionWatcher();
    context.subscriptions.push(watcher);
    const cache = new GroupCache(watcher);
    context.subscriptions.push(cache);
    context.subscriptions.push(languages.registerCompletionItemProvider('sha', new AzCompletionItemProvider(loadMap(), cache), ' '));
}

class AzCompletionItemProvider implements CompletionItemProvider {

    private commandMap: Promise<{ [path: string]: Group | Command }>;

    constructor(map: Promise<Group>, private groupCache: GroupCache) {
        this.commandMap = this.getCommandMap(map);
    }

    provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<CompletionItem[] | CompletionList> {
        return new Promise<CompletionItem[] | CompletionList>(resolve => {
            const line = document.lineAt(position);
            const upToCursor = line.text.substr(0, position.character);
            const subcommand = (/az(\s+[^-\s][^\s]*)*\s+/.exec(upToCursor) || [])[0];
            if (!subcommand) {
                resolve([]);
                return;
            }
            const args = subcommand.trim().split(/\s+/);
            resolve(this.commandMap.then(map => {
                const node = map[args.join(' ')];
                if (node) {
                    switch (node.type) {
                        case 'group':
                            return this.getGroupCompletions(node);
                        case 'command':
                            const m = /\s(-[^\s]+)\s+[^-\s]*$/.exec(upToCursor);
                            const parameter = m && m[1];
                            if (parameter === '-g' || parameter === '--resource-group') {
                                return this.getResourceGroupCompletions();
                            } else {
                                return this.getCommandCompletions(line, node);
                            }
                    }
                }
                return [];
            }));
        });
    }

    private getGroupCompletions(group: Group) {
        return group.subgroups.map(group => {
            const item = new CompletionItem(group.name, CompletionItemKind.Module);
            item.insertText = group.name + ' ';
            item.documentation = group.description;
            return item;
        }).concat(group.commands.map(command => {
            const item = new CompletionItem(command.name, CompletionItemKind.Function);
            item.insertText = command.name + ' ';
            item.documentation = command.description;
            return item;
        }));
    }

    private getResourceGroupCompletions() {
        return this.groupCache.fetchGroups().then(groups => {
            return groups.map(group => {
                const item = new CompletionItem(group.name, CompletionItemKind.Folder);
                item.insertText = group.name + ' ';
                return item;
            });
        });
    }

    private getCommandCompletions(line: TextLine, command: Command) {
        const parametersPresent = new Set(allMatches(/\s(-[^\s]+)/g, line.text, 1));
        return command.parameters.filter(parameter => !parameter.names.some(name => parametersPresent.has(name)))
            .map(parameter => parameter.names.map(name => {
                const item = new CompletionItem(name, CompletionItemKind.Variable);
                item.insertText = name + ' ';
                item.documentation = parameter.description;
                return item;
            }))
            .reduce((all, list) => all.concat(list), []);
    }

    private getCommandMap(map: Promise<Group>) {
        return map.then(map => this.indexCommandMap({}, [], map));
    }

    private indexCommandMap(index: { [path: string]: Group | Command }, path: string[], node: Group | Command) {
        const current = path.concat(node.name);
        index[current.join(' ')] = node;
        if (node.type === 'group') {
            (node.subgroups || []).forEach(group => this.indexCommandMap(index, current, group));
            (node.commands || []).forEach(command => this.indexCommandMap(index, current, command));
        }
        return index;
    }
}

function allMatches(regex: RegExp, string: string, group: number) {
    return {
        [Symbol.iterator]: function* () {
            let m;
            while (m = regex.exec(string)) {
                yield m[group];
            }
        }
    }
}

export function deactivate() {
}