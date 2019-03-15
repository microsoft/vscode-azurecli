import { Event, EventEmitter, window, workspace } from 'vscode';

export interface IAzureCliToolsSettings {
    showResponseInDifferentTab: boolean;
}

export class AzureCliToolsSettings implements IAzureCliToolsSettings {
    public showResponseInDifferentTab: boolean = false;

    private static _instance: AzureCliToolsSettings;

    public static get Instance(): AzureCliToolsSettings {
        if (!AzureCliToolsSettings._instance) {
            AzureCliToolsSettings._instance = new AzureCliToolsSettings();
        }

        return AzureCliToolsSettings._instance;
    }

    public readonly configurationUpdateEventEmitter = new EventEmitter<void>();

    public get onDidChangeConfiguration(): Event<void> {
        return this.configurationUpdateEventEmitter.event;
    }

    private constructor() {
        workspace.onDidChangeConfiguration(() => {
            this.initializeSettings();
            this.configurationUpdateEventEmitter.fire();
        });
        window.onDidChangeActiveTextEditor(e => {
            if (e) {
                this.initializeSettings();
                this.configurationUpdateEventEmitter.fire();
            }
        });

        this.initializeSettings();
    }

    private initializeSettings() {
        const editor = window.activeTextEditor;
        const document = editor && editor.document;

        const azureCliToolsSettings = workspace.getConfiguration("ms-azurecli", document ? document.uri : null);

        this.showResponseInDifferentTab = azureCliToolsSettings.get<boolean>("showResponseInDifferentTab", false);
    }

}