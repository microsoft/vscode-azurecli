/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';

import { exec } from './utils';

const isWindows = process.platform === 'win32';

export type CompletionKind = 'group' | 'command' | 'parameter_name' | 'parameter_value' | 'snippet';

export interface Completion {
    name: string;
    kind: CompletionKind;
    detail?: string;
    documentation?: string;
    snippet?: string;
}

export type Arguments = Record<string, string | null>;

export interface CompletionQuery {
    subcommand?: string;
    argument?: string;
    arguments?: Arguments
}

export interface Status {
    message: string;
}

interface StatusQuery {
    request: 'status';
}

export interface HoverText {
    paragraphs: (string | { language: string; value: string })[];
}

export interface Command {
    subcommand: string;
    argument?: string;
}

interface HoverQuery {
    request: 'hover';
    command: Command;
}

interface Message<T> {
    sequence: number;
    data: T;
}

export class AzService {

    private process: Promise<ChildProcess> | undefined;
    private data = '';
    private listeners: { [sequence: number]: ((response: Message<any>) => void); } = {};
    private nextSequenceNumber = 1;

    constructor(azNotFound: () => void) {
        this.getProcess()
            .catch(err => {
                console.log(err);
                azNotFound();
            });
    }

    async getCompletions(query: CompletionQuery): Promise<Completion[]> {
        try {
            return this.send<CompletionQuery, Completion[]>(query);
        } catch (err) {
            console.error(err);
            return [];
        }
    }

    async getStatus(): Promise<Status> {
        return this.send<StatusQuery, Status>({ request: 'status' });
    }

    async getHover(command: Command): Promise<HoverText> {
        return this.send<HoverQuery, HoverText>({
            request: 'hover',
            command
        });
    }

    private async send<T, R>(data: T): Promise<R> {
        const process = await this.getProcess();
        return new Promise<R>((resolve, reject) => {
            const sequence = this.nextSequenceNumber++;
            this.listeners[sequence] = response => {
                try {
                    resolve(response.data);
                } catch (err) {
                    reject(err);
                }
            };
            const request: Message<T> = { sequence, data };
            const str = JSON.stringify(request);
            process.stdin.write(str + '\n', 'utf8');
        });
    }

    private async getProcess(): Promise<ChildProcess> {
        if (this.process) {
            return this.process;
        }
        return this.process = exec('az --version').then(({stdout}) => {
            const pythonLocation = (/^Python location '([^']*)'/m.exec(stdout) || [])[1];
            return this.spawn(pythonLocation);
        }).catch(err => {
            this.process = undefined;
            throw err;
        });
    }

    private spawn(pythonLocation: string) {
        const process = spawn(join(__dirname, `../../service/az-service${isWindows ? '.bat' : ''}`), [pythonLocation]);
        process.stdout.setEncoding('utf8');
        process.stdout.on('data', data => {
            this.data += data;
            const nl = this.data.indexOf('\n');
            if (nl !== -1) {
                const line = this.data.substr(0, nl);
                this.data = this.data.substr(nl + 1);
                const response = JSON.parse(line);
                const listener = this.listeners[response.sequence];
                if (listener) {
                    delete this.listeners[response.sequence];
                    listener(response);
                }
            }
        });
        process.stderr.setEncoding('utf8');
        process.stderr.on('data', data => {
            console.error(data);
        });
        process.on('error', err => {
            console.error(err);
        });
        process.on('exit', (code, signal) => {
            console.error(`Exit code ${code}, signal ${signal}`);
            this.process = undefined;
        });
        return process;
    }
}