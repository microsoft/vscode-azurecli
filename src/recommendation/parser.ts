export function parse(line: string) {

}


export function parseLine(line: string) {
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
    const json = JSON.stringify(command)
    
    return command
}


export function validateLine(line: string) {
    const regex = /"[^"]*"|'[^']*'|\#.*|[^\s"'#]+/g;
    let m;
    let validLine: string = '';
    while (m = regex.exec(line)) {
        const text = m[0];
        const isComment = text.startsWith('#');
        if (isComment) {
            break;
        }
        validLine = validLine + ' ' + text;
    }
    validLine = validLine.trim()
    if (!validLine.startsWith('az ')) {
        validLine = ''
    }
    return validLine;
}