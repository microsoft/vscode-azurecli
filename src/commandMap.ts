import { execFile } from 'child_process';
import { readFile, writeFile } from 'fs';

export interface Group {
    name: string;
    type: 'group';
    description: string;
    subgroups: Group[];
    commands: Command[];
}

export interface Command {
    name: string;
    type: 'command';
    description: string;
}

interface RawEntry {
    help: string;
    parameters: { [parameterName: string]: RawParameter; };
    examples?: string;
}

interface RawParameter {
    required: string;
    name: string[];
    help: string;
}

interface ProcessedEntry extends RawEntry {
    name?: string;
    path?: string;
    children?: ProcessedEntry[];
}

export function loadMap(): Promise<Group> {
    return new Promise((resolve, reject) => {
        readFile(`${__dirname}/../../src/help_dump.json`, 'utf-8', (err, data) => {
            if (err) {
                reject(err);
            } else {
                try {
                    const raw: { [commandLine: string]: ProcessedEntry; } = JSON.parse(data);
                    const toplevel: ProcessedEntry[] = [];
                    for (const path in raw) {
                        const i = path.lastIndexOf(' ');
                        const entry = raw[path];
                        entry.name = i !== -1 ? path.substr(i + 1) : path;
                        entry.path = path;
                        if (i !== -1) {
                            const parent = raw[path.substr(0, i)];
                            if (parent) {
                                (parent.children || (parent.children = [])).push(entry);
                            }
                        } else {
                            toplevel.push(entry);
                        }
                    }
                    const az = createGroup('az', '', toplevel);
                    resolve(az)
                } catch (e) {
                    reject(e);
                }
            }
        });
    });
}

function createGroup(name: string, description: string, children: ProcessedEntry[]): Group {
    const subgroups: Group[] = [];
    const commands: Command[] = [];
    for (const child of children) {
        if (child.children && child.children.length) {
            subgroups.push(createGroup(child.name, child.help, child.children));
        } else {
            commands.push(createCommand(child.name, child.help));
        }
    }
    return {
        name,
        type: 'group',
        description,
        subgroups,
        commands
    };
}

function createCommand(name: string, description: string): Command {
    return {
        name,
        type: 'command',
        description
    };
}
