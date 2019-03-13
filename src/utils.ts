import * as cp from 'child_process';
import * as fs from 'fs';

export interface ExecResult {
    error: Error | null;
    stdout: string;
    stderr: string;
}

export function exec(command: string) {
    return new Promise<ExecResult>((resolve, reject) => {
        cp.exec(command, (error, stdout, stderr) => {
            (error ? reject : resolve)({ error, stdout, stderr });
        });
    });
}

export function realpath(path: string) {
    return new Promise<string>((resolve, reject) => {
        fs.realpath(path, (error, resolvedPath) => {
            if (error) {
                reject(error);
            } else {
                resolve(resolvedPath);
            }
        });
    });
}

export function exists(path: string) {
    return new Promise<boolean>(resolve => {
        fs.exists(path, resolve);
    });
}

export function readdir(path: string) {
    return new Promise<string[]>((resolve, reject) => {
        fs.readdir(path, (error, files) => {
            if (error) {
                reject(error);
            } else {
                resolve(files);
            }
        });
    });
}

export function never(n: never) {
    throw new Error(`Should not happen: ${n}`);
}
