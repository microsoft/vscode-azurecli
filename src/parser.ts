import { never } from './utils';

export type TokenKind = 'subcommand' | 'parameter_name' | 'parameter_value' | 'comment';

export interface Token {
    kind: TokenKind;
    offset: number;
    length: number;
    text: string;
}

export interface Parameter {
    name?: Token;
    value?: Token;
}

export interface Command {
    tokens: Token[];
    subcommand: Token[];
    parameters: Parameter[];
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
        const isParameter = text.startsWith('-');
        const isComment = text.startsWith('#');
        if (isParameter || isComment) {
            subcommand = false;
        }
        tokens.push({
            kind: subcommand ? 'subcommand' : isParameter ? 'parameter_name' :
                    isComment ? 'comment' : 'parameter_value',
            offset: regex.lastIndex - length,
            length,
            text
        });
    }
    
    const command: Command = {
        tokens,
        subcommand: [],
        parameters: []
    };
    const parameters = command.parameters;

    for (const token of tokens) {
        switch (token.kind) {
            case 'subcommand':
                command.subcommand.push(token);
                break;
            case 'parameter_name':
                parameters.push({ name: token });
                break;
            case 'parameter_value':
                if (parameters.length && !('value' in parameters[parameters.length - 1])) {
                    parameters[parameters.length - 1].value = token;
                } else {
                    parameters.push({ value: token });
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
