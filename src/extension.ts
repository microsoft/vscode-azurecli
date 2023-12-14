/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as jmespath from 'jmespath';
import { HoverProvider, Hover, SnippetString, StatusBarAlignment, StatusBarItem, ExtensionContext, TextDocument, TextDocumentChangeEvent, Disposable, TextEditor, Selection, languages, commands, Range, ViewColumn, Position, CancellationToken, ProviderResult, CompletionItem, CompletionList, CompletionItemKind, CompletionItemProvider, window, workspace, env, Uri, WorkspaceEdit, l10n,  } from 'vscode';
import * as process from "process";

import { AzService, CompletionKind, Arguments, Status } from './azService';
import { parse, findNode } from './parser';
import { exec } from './utils';
import * as spinner from 'elegant-spinner';

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
    private commandRunningStatusBarItem: StatusBarItem;
    private statusBarUpdateInterval!: NodeJS.Timer;
    private statusBarSpinner = spinner();
    private hideStatusBarItemTimeout! : NodeJS.Timeout;
    private statusBarItemText : string = '';
    // using backtick (`) as continuation character on Windows, backslash (\) on other systems
    private continuationCharacter : string = process.platform === "win32" ? "`" : "\\";

    constructor(private status: StatusBarInfo) {
        this.disposables.push(commands.registerTextEditorCommand('ms-azurecli.toggleLiveQuery', editor => this.toggleQuery(editor)));
        this.disposables.push(commands.registerTextEditorCommand('ms-azurecli.runLineInEditor', editor => this.run(editor)));
        this.disposables.push(workspace.onDidCloseTextDocument(document => this.close(document)));
        this.disposables.push(workspace.onDidChangeTextDocument(event => this.change(event)));

        this.commandRunningStatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
        this.disposables.push(this.commandRunningStatusBarItem);        
    }

    private runningCommandCount : number = 0;
    private run(source: TextEditor) {
        this.refreshContinuationCharacter();
        const command = this.getSelectedCommand(source);
        if (command.length > 0) {
            this.runningCommandCount += 1;
            const t0 = Date.now();
            if (this.runningCommandCount === 1) {
                this.statusBarItemText = l10n.t('Azure CLI: Waiting for response');
                this.statusBarUpdateInterval = setInterval(() => {
                    if (this.runningCommandCount === 1) {
                        this.commandRunningStatusBarItem.text = `${this.statusBarItemText} ${this.statusBarSpinner()}`;
                    }
                    else {
                        this.commandRunningStatusBarItem.text = `${this.statusBarItemText} [${this.runningCommandCount}] ${this.statusBarSpinner()}`;
                    }
                }, 50);
            }
            this.commandRunningStatusBarItem.show();
            clearTimeout(this.hideStatusBarItemTimeout);

            this.parsedResult = undefined;
            this.query = undefined; // TODO
            return this.findResultDocument()
                .then(document => window.showTextDocument(document, ViewColumn.Two, true))
                .then(target => replaceContent(target, JSON.stringify({ [l10n.t('Running command')]: command }) + '\n')
                    .then(() => exec(command))
                    .then(({ stdout }) => stdout, ({ stdout, stderr }) => JSON.stringify({ stderr, stdout }, null, '    '))
                    .then(content => replaceContent(target, content)
                            .then(() => this.parsedResult = JSON.parse(content))
                            .then(undefined, err => {})
                    )
                    .then(() => this.commandFinished(t0))
                )
                .then(undefined, console.error);
        }
    }

    private refreshContinuationCharacter() {
        // the continuation character setting can be changed after the extension is loaded
        const settingsContinuationCharacter = workspace.getConfiguration('azureCLI', null).get<string>('lineContinuationCharacter', "");
        if (settingsContinuationCharacter.length > 0) {
            this.continuationCharacter = settingsContinuationCharacter;
        }
        else {
            this.continuationCharacter = process.platform === "win32" ? "`" : "\\";
        }
    }

    private getSelectedCommand(source: TextEditor) {
        const commandPrefix = "az";

        if (source.selection.isEmpty) {
            var lineNumber = source.selection.active.line;
            if (source.document.lineAt(lineNumber).text.length === 0) {
                window.showInformationMessage<any>(l10n.t("Please put the cursor on a line that contains a command (or part of a command)."));
                return "";
            }
            
            // look upwards find the start of the command (if necessary)
            while(!source.document.lineAt(lineNumber).text.trim().toLowerCase().startsWith(commandPrefix)) {
                lineNumber--;
            }

            // this will be the first (maybe only) line of the command
            var command = this.stripComments(source.document.lineAt(lineNumber).text);

            while (command.trim().endsWith(this.continuationCharacter)) {
                // concatenate all lines into a single command
                lineNumber ++;
                command = command.trim().slice(0, -1) + this.stripComments(source.document.lineAt(lineNumber).text);
            }
            return command;
        } 
        else {
            // execute only the selected text
            const selectionStart = source.selection.start;
            const selectionEnd = source.selection.end;
            if (selectionStart.line === selectionEnd.line) {
                // single line command
                return this.stripComments(source.document.getText(new Range(selectionStart, selectionEnd)));
            }
            else {
                // multiline command
                command = this.stripComments(source.document.lineAt(selectionStart.line).text.substring(selectionStart.character));
                for (let index = selectionStart.line+1; index <= selectionEnd.line; index++) {
                    if (command.trim().endsWith(this.continuationCharacter)) {
                        command = command.trim().slice(0, -1);  // remove continuation character from command
                    }

                    var line = this.stripComments(source.document.lineAt(index).text);

                    if (line.trim().toLowerCase().startsWith(commandPrefix)) {
                        window.showErrorMessage<any>(l10n.t("Multiple command selection not supported"));
                        return "";
                    }

                    // append this line to the command string
                    if (index === selectionEnd.line) {
                        command = command + line.substring(0, selectionEnd.character);  // only append up to the end of the selection
                    }
                    else {
                        command = command + line;
                    }
                }
                return command;
            }
        }
    }

    private stripComments(text: string) {
        if (text.trim().startsWith("#")) {
            return this.continuationCharacter;  // don't let a whole line comment terminate a sequence of command fragments
        }

        var i = text.indexOf("#");
        if (i !== -1) {
            // account for hash characters that are embedded in strings in the JMESPath query
            while (this.isEmbeddedInString(text, i)) {
                i = text.indexOf("#", i + 1);  // find next #
            }
            return text.substring(0, i);
        }

        // no comment found
        return text;
    }

    // true if the specified position is in a string literal (surrounded by single quotes)
    private isEmbeddedInString(text: string, position: number) : boolean {
        var stringStart = text.indexOf("'");  // start of string literal
        if (stringStart !== -1) {
            while (stringStart !== -1) {
                var stringEnd = text.indexOf("'", stringStart + 1);  // end of string literal
                if ((stringEnd !== -1) && (stringStart < position) && (stringEnd > position)) {
                    return true;  // the given position is embedded in a string literal
                }
                stringStart = text.indexOf("'", stringEnd + 1);
            }
        }
        return false;
    }

    private commandFinished(startTime: number) {
        this.runningCommandCount -= 1
        this.statusBarItemText = l10n.t('Azure CLI: Executed in {0} milliseconds', Date.now() - startTime);
        this.commandRunningStatusBarItem.text = this.statusBarItemText;

        if (this.runningCommandCount === 0) {
            clearInterval(this.statusBarUpdateInterval);

            // hide status bar item after 10 seconds to keep status bar uncluttered
            this.hideStatusBarItemTimeout = setTimeout(() => this.commandRunningStatusBarItem.hide(), 10000);
        }
    }

    private toggleQuery(source: TextEditor) {
        this.queryEnabled = !this.queryEnabled;
        this.status.liveQuery = this.queryEnabled;
        this.status.update();
        this.updateResult();
    }

    private findResultDocument() {
        const showResultInNewEditor = workspace.getConfiguration('azureCLI', null).get<boolean>('showResultInNewEditor', false)
        if (this.resultDocument && !showResultInNewEditor) {
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
                } catch (err: any) {
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
    const edit = new WorkspaceEdit();
    edit.replace(document.uri, all, content);
    return workspace.applyEdit(edit)
        .then(() => editor.selections = [new Selection(0, 0, 0, 0)]);
}

async function azNotFound(wrongVersion: boolean): Promise<void> {
    const message = 
        wrongVersion
            ? l10n.t("'az' >= 2.0.5 required, please update your installation.")
            : l10n.t("'az' not found on PATH, please make sure it is installed.");
    const result = await window.showInformationMessage<any>(message,
        {
            title: l10n.t('Documentation'),
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
