import { TextDocument, Position } from 'vscode';


export class RecommendParser {

    private static readonly MAX_COMMAND_LIST_SIZE = 30;

    static parseLines(document: TextDocument, position: Position): { executedCommand: Set<string>, commandListJson: string } {
        const commandListArr: string[] = [];
        let line;
        const executedCommand = new Set<string>()
        for (let i = 0; i <= position.line && commandListArr.length < RecommendParser.MAX_COMMAND_LIST_SIZE; i++) {
            line = document.lineAt(i).text;
            const command = RecommendParser.parseLine(line)
            if (command != null && command.command.length > 0) {
                executedCommand.add('az ' + command.command)
                commandListArr.push(JSON.stringify(command));
            }
        }
        if (commandListArr.length == 0) {
            return { executedCommand: executedCommand, commandListJson: "" };
        }
        const commandListJson = JSON.stringify(commandListArr)
        return { executedCommand: executedCommand, commandListJson: commandListJson }
    }
    
    private static parseLine(line: string) {
        const regex = /"[^"]*"|'[^']*'|\#.*|[^\s"'#]+/g;
        let m;
        let isSubCommand = true;
        let subcommand: string = '';
        const args: string[] = [];
        let isFirstText = true;
        while (m = regex.exec(line)) {
            const text = m[0];
            if (text.startsWith('#')) {
                break;
            }
            if (isFirstText) {
                if (text != 'az') {
                    break;
                }
                isFirstText = false;
                continue;
            }
            if (text.startsWith('-')) {
                isSubCommand = false;
                args.push(text);
            } else if (isSubCommand) {
                subcommand = subcommand + ' ' + text;
            }
        }
        subcommand = subcommand.trim();
        if (subcommand.length == 0) {
            return null;
        }
    
        const command = {
            command: subcommand,
            arguments: args
        }
        return command
    }
}