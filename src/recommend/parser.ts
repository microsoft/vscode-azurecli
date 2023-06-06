import { TextDocument, Position } from 'vscode';


export class RecommendParser {

    private static readonly MAX_COMMAND_LIST_SIZE = 30;

    static parseLines(document: TextDocument, position: Position): { commandListJson: string } {
        const commandListArr: string[] = [];
        let line;
        for (let i = 0; i <= position.line && commandListArr.length < RecommendParser.MAX_COMMAND_LIST_SIZE; i++) {
            line = document.lineAt(i).text;
            const command = RecommendParser.parseLine(line)
            if (command != null && command.command.length > 0) {
                commandListArr.push(JSON.stringify(command));
            }
        }
        if (commandListArr.length == 0) {
            return { commandListJson: "" };
        }
        const commandListJson = JSON.stringify(commandListArr) 
        return { commandListJson: commandListJson }
    }

    static formatRecommendSample(commandSample: string): string {
        const regex = /"[^"]*"|'[^']*'|\#.*|[^\s"'#]+/g;
        let m;
        let isSubCommand = true;
        let formattedSample: string = '';
        const args: string[] = [];
        const argsValues = new Map(); // : Map<string, string[]>

        while (m = regex.exec(commandSample)) {
            const text = m[0];
            if (text.startsWith('-')) {
                isSubCommand = false;
                args.push(text);
            } else if (isSubCommand) {
                formattedSample += text + ' ';
            } else {
                let arg = args[args.length - 1];
                if (!argsValues.has(arg)) {
                    argsValues.set(arg, []);
                }
                let values = argsValues.get(arg);
                values.push(text);
            }
        }

        for (let arg of args) {
            formattedSample += arg + ' ';
            if (!argsValues.has(arg)) {
                continue;
            }
            let curArgs = argsValues.get(arg);
            let curArg = curArgs.join(' ');
            if (curArg.startsWith('$')) {
                formattedSample += '<' + curArg.substring(1) + '> ';
            } else {
                formattedSample += curArg + ' ';
            }
        }

        return formattedSample;
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