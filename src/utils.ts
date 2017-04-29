import * as cp from 'child_process';

export interface ExecResult {
    error: Error;
    stdout: string;
    stderr: string;
}

export function exec(command: string) {
    return new Promise<ExecResult>((resolve, reject) => {
        cp.exec(command, (error, stdout, stderr) => {
            (error || stderr ? reject : resolve)({ error, stdout, stderr });
        });
    });
}
