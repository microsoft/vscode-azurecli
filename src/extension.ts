/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as cp from 'child_process';

import { ExtensionContext, TextDocument, Disposable, TextEditor, Selection, languages, commands, Range, ViewColumn, Position, CancellationToken, ProviderResult, CompletionItem, CompletionList, CompletionItemKind, CompletionItemProvider, window, workspace } from 'vscode';

import { loadMap, Group, Command } from './commandMap';
import { AzService } from './azService';

export function activate(context: ExtensionContext) {
    context.subscriptions.push(languages.registerCompletionItemProvider('sha', new AzCompletionItemProvider(loadMap()), ' '));
    context.subscriptions.push(new RunLineInEditor());
}

class AzCompletionItemProvider implements CompletionItemProvider {

    private commandMap: Promise<{ [path: string]: Group | Command }>;
    private azService = new AzService();

    constructor(
        map: Promise<Group>
    ) {
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
                const normalizedSubcommand = args.join(' ');
                const node = map[normalizedSubcommand];
                if (node) {
                    switch (node.type) {
                        case 'group':
                            return this.getGroupCompletions(node);
                        case 'command':
                            const parameters = this.getParameters(line.text);
                            const m = /\s(--?[^\s]+)\s+[^-\s]*$/.exec(upToCursor);
                            const parameter = m && m[1];
                            if (parameter) {
                                return this.azService.getCompletions(normalizedSubcommand.substr(3), parameter, parameters);
                            } else {
                                const m = /\s(--?[^\s]*)$/.exec(upToCursor);
                                const prefix = m && m[1] || '';
                                return this.getCommandCompletions(node, prefix, parameters);
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
            item.documentation = group.description;
            return item;
        }).concat(group.commands.map(command => {
            const item = new CompletionItem(command.name, CompletionItemKind.Function);
            item.documentation = command.description;
            return item;
        }));
    }

    private getParameters(line: string) {
        const parameters: { [parameter: string]: string | undefined; } = {};
        let name: string | undefined;
        for (const match of allMatches(/-[^\s"']*|"[^"]*"|'[^']*'|[^\s"']+/g, line, 0)) {
            if (match.startsWith('-')) {
                name = match as string;
                if (!(name in parameters)) {
                    parameters[name] = undefined;
                }
            } else {
                if (name) {
                    parameters[name] = match;
                }
                name = undefined;
            }
        }
        return parameters;
    }

    private getCommandCompletions(command: Command, prefix: string, parameters: { [parameter: string]: string | undefined; }) {
        const m = /^-*/.exec(prefix);
        const lead = m ? m[0] : '';
        return command.parameters.filter(parameter => !parameter.names.some(name => name in parameters))
            .map(parameter => parameter.names.filter(name => name.startsWith(lead)).map(name => {
                const item = new CompletionItem(name, CompletionItemKind.Variable);
                item.insertText = name.substr(lead.length);
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

class RunLineInEditor {

    private resultDocument: TextDocument | undefined;
    private disposables: Disposable[] = [];

    constructor() {
        this.disposables.push(commands.registerTextEditorCommand('ms-azurecli.runLineInEditor', editor => this.run(editor)));
        this.disposables.push(workspace.onDidCloseTextDocument(document => this.close(document)));
    }
    private run(editor: TextEditor) {
        const cursor = editor.selection.active;
        const line = editor.document.lineAt(cursor).text;
        return this.findResultDocument()
            .then(document => window.showTextDocument(document, ViewColumn.Two, true))
            .then(editor => replaceContent(editor, `{ "Running command": "${line}" }`)
                .then(() => exec(line))
                .then(({ stdout }) => stdout, ({ stdout, stderr }) => JSON.stringify({ stderr, stdout }, null, '    '))
                .then(content => replaceContent(editor, content))
            )
            .then(undefined, console.error);
    }

    private findResultDocument() {
        if (this.resultDocument) {
            return Promise.resolve(this.resultDocument);
        }
        return workspace.openTextDocument({ language: 'json' })
            .then(document => this.resultDocument = document);
    }

    private close(document: TextDocument) {
        if (document === this.resultDocument) {
            this.resultDocument = undefined;
        }
    }

    dispose() {
        this.disposables.forEach(disposable => disposable.dispose());
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

function replaceContent(editor: TextEditor, content: string) {
    const document = editor.document;
    const all = new Range(new Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
    return editor.edit(builder => builder.replace(all, content))
        .then(() => editor.selections = [new Selection(0, 0, 0, 0)]);
}

interface ExecResult {
    error: Error;
    stdout: string;
    stderr: string;
}

function exec(command: string) {
    return new Promise<ExecResult>((resolve, reject) => {
        cp.exec(command, (error, stdout, stderr) => {
            (error || stderr ? reject : resolve)({ error, stdout, stderr });
        });
    });
}

export function deactivate() {
}