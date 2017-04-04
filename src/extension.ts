import { ExtensionContext, Range, TextDocument, languages, Position, CancellationToken, ProviderResult, CompletionItem, CompletionList, CompletionItemKind } from 'vscode';
import { execFile } from 'child_process';
import { loadMap, Group, Command } from './commandMap';

export function activate(context: ExtensionContext) {
    context.subscriptions.push(languages.registerCompletionItemProvider('sha', {
        provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<CompletionItem[] | CompletionList> {
            return new Promise((resolve, reject) => {
                const line = document.lineAt(position);
                const subcommand = (/az(\s+[^-\s][^\s]*)*/.exec(line.text.substr(0, position.character)) || [])[0];
                if (!subcommand) {
                    resolve([]);
                    return;
                }
                const args = subcommand.trim().split(/\s+/);
                return getCommandMap().then(map => {
                    const node = map[args.join(' ')];
                    if (node) {
                        switch (node.type) {
                            case 'group':
                                resolve(
                                    node.subgroups.map(group => {
                                        const item = new CompletionItem(group.name, CompletionItemKind.Module);
                                        item.documentation = group.description;
                                        return item;
                                    }).concat(node.commands.map(command => {
                                        const item = new CompletionItem(command.name, CompletionItemKind.Function);
                                        item.documentation = command.description;
                                        return item;
                                    }))
                                );
                                break;
                            case 'command':
                                resolve(
                                    node.parameters.map(parameter => parameter.names.map(name => {
                                        const item = new CompletionItem(name, CompletionItemKind.Variable);
                                        item.documentation = parameter.description;
                                        return item;
                                    }))
                                    .reduce((all, list) => all.concat(list), [])
                                );
                                break;
                            default:
                                resolve([]);
                                break;
                        }
                    } else {
                        resolve([]);
                    }
                });
            });
        }
    }, ' '));
}

let commandMap: Promise<{ [path: string]: Group | Command }>;
function getCommandMap() {
    return commandMap || (commandMap = loadMap().then(map => indexCommandMap({}, [], map)));
}

function indexCommandMap(index: { [path: string]: Group | Command }, path: string[], node: Group | Command) {
    const current = path.concat(node.name);
    index[current.join(' ')] = node;
    if (node.type === 'group') {
        (node.subgroups || []).forEach(group => indexCommandMap(index, current, group));
        (node.commands || []).forEach(command => indexCommandMap(index, current, command));
    }
    return index;
}

export function deactivate() {
}