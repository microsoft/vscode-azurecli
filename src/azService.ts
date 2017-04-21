/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';

export type CompletionKind = 'group' | 'command' | 'parameter_name' | 'parameter_value';

export interface Completion {
    name: string;
    kind: CompletionKind;
    description?: string;
}

export type Arguments = Record<string, string | null>;

export interface CompletionQuery {
    subcommand: string;
    argument?: string;
    arguments?: Arguments
}

interface Request {
    sequence: number;
    query: CompletionQuery;
}

interface Response {
    sequence: number;
    completions: Completion[];
}

export class AzService {

    private process: ChildProcess | null;
    private data = '';
    private listeners: { [sequence: number]: ((response: Response) => void); } = {};
    private nextSequenceNumber = 1;

    constructor() {
        this.spawn();
    }

    getCompletions(query: CompletionQuery) {
        if (!this.process) {
            this.spawn();
        }
        return new Promise<Completion[]>((resolve, reject) => {
            const sequence = this.nextSequenceNumber++;
            this.listeners[sequence] = response => {
                try {
                    resolve(response.completions);
                } catch (err) {
                    reject(err);
                }
            };
            if (this.process) {
                const request: Request = { sequence, query };
                const data = JSON.stringify(request);
                this.process.stdin.write(data + '\n', 'utf8');
            } else {
                resolve([]);
            }
        });
    }

    private spawn() {
        this.process = spawn(join(__dirname, '../../service/az-service'));
        this.process.stdout.setEncoding('utf8');
        this.process.stdout.on('data', data => {
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
        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', data => {
            console.error(data);
        });
        this.process.on('error', err => {
            console.error(err);
        });
        this.process.on('exit', (code, signal) => {
            console.error(`Exit code ${code}, signal ${signal}`);
            this.process = null;
        });
    }
}