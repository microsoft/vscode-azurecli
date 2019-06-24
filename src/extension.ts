/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as jmespath from 'jmespath';
import { HoverProvider, Hover, SnippetString, StatusBarAlignment, StatusBarItem, ExtensionContext, TextDocument, TextDocumentChangeEvent, Disposable, TextEditor, Selection, languages, commands, Range, ViewColumn, Position, CancellationToken, ProviderResult, CompletionItem, CompletionList, CompletionItemKind, CompletionItemProvider, window, workspace, env, Uri } from 'vscode';

import { AzService, CompletionKind, Arguments, Status } from './azService';
import { parse, findNode } from './parser';
import { exec } from './utils';

export function activate(context: ExtensionContext) {
    const azService = new AzService(azNotFound);
    context.subscriptions.push(languages.registerCompletionItemProvider('azcli', new AzCompletionItemProvider(azService), ' '));
    context.subscriptions.push(languages.registerHoverProvider('azcli', new AzHoverProvider(azService)));
    const status = new StatusBarInfo(azService);
    context.subscriptions.push(status);
    context.subscriptions.push(new RunLineInTerminal());
    context.subscriptions.push(new RunLineInEditor(status));
    context.subscriptions.push(commands.registerCommand('ms-azurecli.installAzureCLI', installAzureCLI));
}

const completionKinds: Record<CompletionKind, CompletionItemKind> = {
    group: CompletionItemKind.Module,
    command: CompletionItemKind.Function,
    argument_name: CompletionItemKind.Variable,
    argument_value: CompletionItemKind.EnumMember,
    snippet: CompletionItemKind.Snippet
};

class AzCompletionItemProvider implements CompletionItemProvider {

    constructor(private azService: AzService) {
    }

    provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<CompletionItem[] | CompletionList> {
        const line = document.lineAt(position).text;
        const parsed = parse(line);
        const start = parsed.subcommand[0];
        if (start && start.offset + start.length < position.character && start.text !== 'az') {
            return;
        }
        const node = findNode(parsed, position.character - 1);
        if (node && node.kind === 'comment') {
            return;
        }
        // TODO: Use the above instead of parsing again.
        const upToCursor = line.substr(0, position.character);
        const rawSubcommand = (/^\s*(([^-\s][^\s]*\s+)*)/.exec(upToCursor) || [])[1];
        if (typeof rawSubcommand !== 'string') {
            return Promise.resolve([]);
        }
        const subcommand = rawSubcommand.trim()
            .split(/\s+/);
        const args = this.getArguments(line);
        const argument = (/\s(--?[^\s]+)\s+[^-\s]*$/.exec(upToCursor) || [])[1];
        const prefix = (/(^|\s)([^\s]*)$/.exec(upToCursor) || [])[2];
        const lead = /^-*/.exec(prefix)![0];
        return this.azService.getCompletions(subcommand[0] === 'az' ? { subcommand: subcommand.slice(1).join(' '), argument, arguments: args } : {}, token.onCancellationRequested)
            .then(completions => completions.map(({ name, kind, detail, documentation, snippet, sortText }) => {
                const item = new CompletionItem(name, completionKinds[kind]);
                if (snippet) {
                    item.insertText = new SnippetString(snippet);
                } else if (lead) {
                    item.insertText = name.substr(lead.length);
                }
                if (detail) {
                    item.detail = detail;
                }
                if (documentation) {
                    item.documentation = documentation;
                }
                if (sortText) {
                    item.sortText = sortText;
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

class AzHoverProvider implements HoverProvider {

    constructor(private azService: AzService) {
    }

    provideHover(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Hover> {
        const line = document.lineAt(position.line).text;
        const command = parse(line);
        const list = command.subcommand;
        if (list.length && list[0].text === 'az') {
            const node = findNode(command, position.character);
            if (node) {
                if (node.kind === 'subcommand') {
                    const i = list.indexOf(node);
                    if (i > 0) {
                        const subcommand = list.slice(1, i + 1)
                            .map(node => node.text).join(' ');
                        return this.azService.getHover({ subcommand }, token.onCancellationRequested)
                            .then(text => text && new Hover(text.paragraphs, new Range(position.line, node.offset, position.line, node.offset + node.length)));
                    }
                } else if (node.kind === 'argument_name') {
                    const subcommand = command.subcommand.slice(1)
                        .map(node => node.text).join(' ');
                    return this.azService.getHover({ subcommand, argument: node.text }, token.onCancellationRequested)
                        .then(text => text && new Hover(text.paragraphs, new Range(position.line, node.offset, position.line, node.offset + node.length)));
                }
            }
        }
    }
}

class RunLineInTerminal {

    private disposables: Disposable[] = [];

    constructor() {
        this.disposables.push(commands.registerTextEditorCommand('ms-azurecli.runLineInTerminal', editor => this.run(editor)));
    }

    private run(editor: TextEditor) {
        return commands.executeCommand('workbench.action.terminal.runSelectedText');
    }

    dispose() {
        this.disposables.forEach(disposable => disposable.dispose());
    }
}

class RunLineInEditor {

    private resultDocument: TextDocument | undefined;
    private parsedResult: object | undefined;
    private queryEnabled = false;
    private query: string | undefined;
    private disposables: Disposable[] = [];

    constructor(private status: StatusBarInfo) {
        this.disposables.push(commands.registerTextEditorCommand('ms-azurecli.toggleLiveQuery', editor => this.toggleQuery(editor)));
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

    private toggleQuery(source: TextEditor) {
        this.queryEnabled = !this.queryEnabled;
        this.status.liveQuery = this.queryEnabled;
        this.status.update();
        this.updateResult();
    }

    private findResultDocument() {
        var showResponseInDifferentTab = workspace.getConfiguration("ms-azurecli").get<boolean>("showResponseInDifferentTab", false)
        if (this.resultDocument && !showResponseInDifferentTab) {
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
        if (e.document.languageId === 'azcli' && e.contentChanges.length === 1) {
            const change = e.contentChanges[0];
            const range = change.range;
            if (range.start.line === range.end.line) {
                const line = e.document.lineAt(range.start.line).text;
                const query = this.getQueryArgument(line);
                if (query !== this.query) {
                    this.query = query;
                    if (this.queryEnabled) {
                        this.updateResult();
                    }
                }
            }
        }
    }

    private updateResult() {
        if (this.resultDocument && this.parsedResult) {
            const resultEditor = window.visibleTextEditors.find(editor => editor.document === this.resultDocument);
            if (resultEditor) {
                try {
                    const result = this.queryEnabled && this.query ? jmespath.search(this.parsedResult, this.query) : this.parsedResult;
                    replaceContent(resultEditor, JSON.stringify(result, null, '    '))
                        .then(undefined, console.error);
                } catch (err) {
                    if (!(err && err.name === 'ParserError')) {
                        // console.error(err); Ignore because jmespath sometimes fails on partial queries.
                    }
                }
            }
        }
    }

    private getQueryArgument(line: string) {
        return (/\s--query\s+("([^"]*)"|'([^']*)'|([^\s"']+))/.exec(line) as string[] || [])
            .filter(group => !!group)[2];
    }

    dispose() {
        this.disposables.forEach(disposable => disposable.dispose());
        this.runStatusBarItem.dispose();
    }
}

class StatusBarInfo {

    private info: StatusBarItem;
    private status?: Status;
    public liveQuery = false;

    private timer?: NodeJS.Timer;
    private disposables: Disposable[] = [];

    constructor(private azService: AzService) {
        this.disposables.push(this.info = window.createStatusBarItem(StatusBarAlignment.Left));
        this.disposables.push(window.onDidChangeActiveTextEditor(() => this.update()));
        this.disposables.push({ dispose: () => this.timer && clearTimeout(this.timer) });
        this.refresh()
            .catch(console.error);
    }

    public async refresh() {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.status = await this.azService.getStatus();
        this.update();
        this.timer = setTimeout(() => {
            this.refresh()
                .catch(console.error);
        }, 5000);
    }

    public update() {
        const texts: string[] = [];
        if (this.status && this.status.message) {
            texts.push(this.status.message);
        }
        if (this.liveQuery) {
            texts.push('Live Query');
        }
        this.info.text = texts.join(', ');
        const editor = window.activeTextEditor;
        const show = this.info.text && editor && editor.document.languageId === 'azcli';
        this.info[show ? 'show' : 'hide']();
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

async function azNotFound(wrongVersion: boolean): Promise<void> {
    const message = wrongVersion ? '\'az\' >= 2.0.5 required, please update your installation.' : '\'az\' not found on PATH, please make sure it is installed.';
    const result = await window.showInformationMessage<any>(message,
        {
            title: 'Documentation',
            run: installAzureCLI
        }
    );
    if (result && result.run) {
        result.run();
    }
}

function installAzureCLI() {
    env.openExternal(Uri.parse('https://aka.ms/GetTheAzureCLI'));
}

export function deactivate() {
}