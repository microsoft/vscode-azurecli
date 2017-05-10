import { never } from './utils';

export type TokenKind = 'subcommand' | 'argument_name' | 'argument_value' | 'comment';

export interface Token {
    kind: TokenKind;
    offset: number;
    length: number;
    text: string;
}

export interface Argument {
    name?: Token;
    value?: Token;
}

export interface Command {
    tokens: Token[];
    subcommand: Token[];
    arguments: Argument[];
    comment?: Token;
}

export function parse(line: string) {
    const regex = /"[^"]*"|'[^']*'|\#.*|[^\s"'#]+/g;
    const tokens: Token[] = [];
    let subcommand = true;
    let m;
    while (m = regex.exec(line)) {
        const text = m[0];
        const length = text.length;
        const isArgument = text.startsWith('-');
        const isComment = text.startsWith('#');
        if (isArgument || isComment) {
            subcommand = false;
        }
        tokens.push({
            kind: subcommand ? 'subcommand' : isArgument ? 'argument_name' :
                    isComment ? 'comment' : 'argument_value',
            offset: regex.lastIndex - length,
            length,
            text
        });
    }
    
    const command: Command = {
        tokens,
        subcommand: [],
        arguments: []
    };
    const args = command.arguments;

    for (const token of tokens) {
        switch (token.kind) {
            case 'subcommand':
                command.subcommand.push(token);
                break;
            case 'argument_name':
                args.push({ name: token });
                break;
            case 'argument_value':
                if (args.length && !('value' in args[args.length - 1])) {
                    args[args.length - 1].value = token;
                } else {
                    args.push({ value: token });
                }
                break;
            case 'comment':
                command.comment = token;
                break;
            default:
                never(token.kind);
        }
    }

    return command;
}

export function findNode(command: Command, offset: number) {
    return command.tokens.find(token => token.offset <= offset && token.offset + token.length > offset);
}
