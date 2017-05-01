/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as jmespath from 'jmespath';
import * as opn from 'opn';

import { ExtensionContext, TextDocument, TextDocumentChangeEvent, Disposable, TextEditor, Selection, languages, commands, Range, ViewColumn, Position, CancellationToken, ProviderResult, CompletionItem, CompletionList, CompletionItemKind, CompletionItemProvider, window, workspace } from 'vscode';

import { AzService, CompletionKind, Arguments } from './azService';
import { exec } from './utils';

export function activate(context: ExtensionContext) {
    context.subscriptions.push(languages.registerCompletionItemProvider('azcli', new AzCompletionItemProvider(), ' '));
    context.subscriptions.push(new RunLineInEditor());
}

const completionKinds: Record<CompletionKind, CompletionItemKind> = {
    group: CompletionItemKind.Module,
    command: CompletionItemKind.Function,
    parameter_name: CompletionItemKind.Variable,
    parameter_value: CompletionItemKind.EnumMember
};

class AzCompletionItemProvider implements CompletionItemProvider {

    private azService = new AzService(azNotFound);

    provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<CompletionItem[] | CompletionList> {
        const line = document.lineAt(position);
        const upToCursor = line.text.substr(0, position.character);
        if (/^\s*(az?)?$/.test(upToCursor)) {
            const item = new CompletionItem('az', completionKinds['command']);
            item.documentation = 'Microsoft command-line tools for Azure.';
            return [item];
        }
        const rawSubcommand = (/^\s*az\s+(([^-\s][^\s]*\s+)*)/.exec(upToCursor) || [])[1];
        if (typeof rawSubcommand !== 'string') {
            return Promise.resolve([]);
        }
        const subcommand = rawSubcommand.trim()
            .split(/\s+/)
            .join(' ');
        const args = this.getArguments(line.text);
        const argument = (/\s(--?[^\s]+)\s+[^-\s]*$/.exec(upToCursor) || [])[1];
        const prefix = (/(^|\s)([^\s]*)$/.exec(upToCursor) || [])[2];
        const lead = /^-*/.exec(prefix)![0];
        return this.azService.getCompletions({ subcommand, argument, arguments: args })
            .then(completions => completions.map(({ name, kind, description }) => {
                const item = new CompletionItem(name, completionKinds[kind]);
                if (name.indexOf(' ') !== -1) {
                    item.insertText = `"${name}"`;
                } else if (lead) {
                    item.insertText = name.substr(lead.length);
                }
                if (description) {
                    item.documentation = description;
                }
                return item;
            }));
    }

    private getArguments(line: string) {
        const args: Arguments = {};
        let name: string | undefined;
        for (const match of allMatches(/-[^\s"']*|"[^"]*"|'[^']*'|[^\s"']+/g, line, 0)) {
            if (match.startsWith('-')) {
                name = match as string;
                if (!(name in args)) {
                    args[name] = null;
                }
            } else {
                if (name) {
                    args[name] = match;
                }
                name = undefined;
            }
        }
        return args;
    }
}

class RunLineInEditor {

    private resultDocument: TextDocument | undefined;
    private parsedResult: object | undefined;
    private query: string | undefined;
    private disposables: Disposable[] = [];

    constructor() {
        this.disposables.push(commands.registerTextEditorCommand('ms-azurecli.runLineInEditor', editor => this.run(editor)));
        this.disposables.push(workspace.onDidCloseTextDocument(document => this.close(document)));
        this.disposables.push(workspace.onDidChangeTextDocument(event => this.change(event)));
    }
    private run(source: TextEditor) {
        this.parsedResult = undefined;
        this.query = undefined; // TODO
        const cursor = source.selection.active;
        const line = source.document.lineAt(cursor).text;
        return this.findResultDocument()
            .then(document => window.showTextDocument(document, ViewColumn.Two, true))
            .then(target => replaceContent(target, JSON.stringify({ 'Running command': line }) + '\n')
                .then(() => exec(line))
                .then(({ stdout }) => stdout, ({ stdout, stderr }) => JSON.stringify({ stderr, stdout }, null, '    '))
                .then(content => replaceContent(target, content)
                    .then(() => this.parsedResult = JSON.parse(content))
                    .then(undefined, err => {})
                )
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

    private change(e: TextDocumentChangeEvent) {
        if (this.resultDocument && this.parsedResult && e.document.languageId === 'azcli' && e.contentChanges.length === 1) {
            const resultEditor = window.visibleTextEditors.find(editor => editor.document === this.resultDocument);
            const change = e.contentChanges[0];
            const range = change.range;
            if (resultEditor && range.start.line === range.end.line) {
                const line = e.document.lineAt(range.start.line).text;
                const query = this.getQueryParameter(line);
                if (query !== this.query) {
                    this.query = query;
                    const result = jmespath.search(this.parsedResult, query);
                    replaceContent(resultEditor, JSON.stringify(result, null, '    '))
                        .then(undefined, console.error);
                }
            }
        }
    }

    private getQueryParameter(line: string) {
        return (/\s--query\s+("([^"]*)"|'([^']*)'|([^\s"']+))/.exec(line) as string[] || [])
            .filter(group => !!group)[2];
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

async function azNotFound(): Promise<void> {
    const result = await window.showInformationMessage<any>('\'az\' not found on PATH, make sure it is installed.',
        {
            title: 'Download',
            run: () => {
                opn('https://docs.microsoft.com/en-us/cli/azure/');
            }
        },
        {
            title: 'Close',
            isCloseAffordance: true
        }
    );
    if (result && result.run) {
        result.run();
    }
}

export function deactivate() {
}