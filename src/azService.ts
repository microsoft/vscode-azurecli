/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { join } from 'path';
import * as semver from 'semver';

import { exec, realpath, exists, readdir } from './utils';

const isWindows = process.platform === 'win32';

export type CompletionKind = 'group' | 'command' | 'argument_name' | 'argument_value' | 'snippet';

export interface Completion {
    name: string;
    kind: CompletionKind;
    detail?: string;
    documentation?: string;
    snippet?: string;
    sortText?: string;
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
    private listeners: { [sequence: number]: ((err: undefined | any, response: Message<any> | undefined) => void); } = {};
    private nextSequenceNumber = 1;

    constructor(azNotFound: (wrongVersion: boolean) => void) {
        this.getProcess()
            .catch(err => {
                console.log(err);
                azNotFound(err === 'wrongVersion');
            });
    }

    async getCompletions(query: CompletionQuery, onCancel: (handle: () => void) => void): Promise<Completion[]> {
        try {
            return this.send<CompletionQuery, Completion[]>(query, onCancel);
        } catch (err) {
            console.error(err);
            return [];
        }
    }

    async getStatus(): Promise<Status> {
        return this.send<StatusQuery, Status>({ request: 'status' });
    }

    async getHover(command: Command, onCancel: (handle: () => void) => void): Promise<HoverText> {
        return this.send<HoverQuery, HoverText>({
            request: 'hover',
            command
        }, onCancel);
    }

    private async send<T, R>(data: T, onCancel?: (handle: () => void) => void): Promise<R> {
        const process = await this.getProcess();
        return new Promise<R>((resolve, reject) => {
            if (onCancel) {
                onCancel(() => reject('canceled'));
            }
            const sequence = this.nextSequenceNumber++;
            this.listeners[sequence] = (err, response) => {
                if (err) {
                    reject(err);
                } else {
                    try {
                        resolve(response!.data);
                    } catch (err) {
                        reject(err);
                    }
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
        return this.process = (async () => {
            const { stdout } = await exec('az --version');
            let version = (
                /azure-cli\s+\(([^)]+)\)/m.exec(stdout)
                || /azure-cli\s+(\S+)/m.exec(stdout)
                || []
            )[1];
            if (version) {
                const r = /[^-][a-z]/ig;
                if (r.exec(version)) {
                    version = version.substr(0, r.lastIndex - 1) + '-' + version.substr(r.lastIndex - 1);
                }
            }
            if (version && semver.valid(version) && !semver.gte(version, '2.0.5')) {
                throw 'wrongVersion';
            }
            const pythonLocation = (/^Python location '([^']*)'/m.exec(stdout) || [])[1];
            const processOptions = await this.getSpawnProcessOptions();
            return this.spawn(pythonLocation, processOptions);
        })().catch(err => {
            this.process = undefined;
            throw err;
        });
    }

    private async getSpawnProcessOptions() {
        if (process.platform === 'darwin') {
            try {
                const which = await exec('which az');
                const binPath = await realpath(which.stdout.trim());
                const cellarBasePath = '/usr/local/Cellar/azure-cli/';
                if (binPath.startsWith(cellarBasePath)) {
                    const installPath = binPath.substr(0, binPath.indexOf('/', cellarBasePath.length));
                    const libPath = `${installPath}/libexec/lib`;
                    const entries = await readdir(libPath);
                    for (const entry of entries) {
                        const packagesPath = `${libPath}/${entry}/site-packages`;
                        if (await exists(packagesPath)) {
                            return { env: { 'PYTHONPATH': packagesPath } };
                        }
                    }
                }
            } catch (err) {
                console.error(err);
            }
        }
        return undefined;
    }

    private spawn(pythonLocation: string, processOptions?: SpawnOptions) {
        const process = spawn(join(__dirname, `../../service/az-service${isWindows ? '.bat' : ''}`), [pythonLocation], processOptions);
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
                    listener(undefined, response);
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
            for (const sequence in this.listeners) {
                const listener = this.listeners[sequence];
                delete this.listeners[sequence];
                listener(`Python process terminated with exit code ${code}, signal ${signal}.`, undefined);
            }
        });
        return process;
    }
}