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

export function loadMap(): Promise<Group> {
    return new Promise((resolve, reject) => {
        readFile(`${__dirname}/../../src/commandMap.json`, 'utf-8', (err, data) => {
            if (err) {
                reject(err);
            } else {
                try {
                    resolve(JSON.parse(data))
                } catch (e) {
                    reject(e);
                }
            }
        });
    });
}

const sectionNameToType = {
    subgroups: 'group',
    commands: 'command',
}

function commandMap(...args: string[]): Promise<Group | Command> {
    return new Promise((resolve, reject) => {
        execFile('az', args.concat('--help'), (err, stdout, stderr) => {
            if (err || stderr) {
                reject(err || stderr);
            } else {
                const sectionTexts = stdout.split(/^(?=\S)/m)
                    .map(text => text.trim())
                    .filter(text => !!text);
                const sectionList = sectionTexts.map(section => {
                    const sectionName = /^[^:\n]*/.exec(section)[0].toLowerCase();
                    return {
                        key: sectionName,
                        value: section
                            .split('\n')
                            .slice(1)
                            .map(line => line.split(/:(.*)/))
                            .filter(parts => parts[0] && parts[0].trim())
                            .map(parts => {
                                return {
                                    name: parts[0].trim(),
                                    type: sectionNameToType[sectionName] || 'other',
                                    description: parts[1] && parts[1].trim(),
                                };
                            })
                    };
                }).filter(({ value }) => !!value.length);

                const first = sectionList.shift();
                const base = {
                    name: first.value[0].name
                            .split(' ').slice(-1)[0],
                    type: first.key,
                    description: first.value[0].description
                };
                if (base.type === 'group') {
                    Object.assign(base, {
                        subgroups: [],
                        commands: []
                    });
                }
                const sectionMap = sectionList.reduce((map, { key, value }) => Object.assign(map, { [key]: value }), base);
                resolve(sectionMap);
            }
        });
    });
}

function fullMap(...args: string[]): Promise<Group | Command> {
    return commandMap(...args).then(map => {
        if (map.type === 'command') {
            return map;
        }
        return Promise.all(map.subgroups.map((group, i) => fullMap(...args.concat(group.name)).then(resolved => {
            map.subgroups[i] = resolved as Group;
        }, console.error))).then(() => map);
    });
}

// fullMap().then(map => {
//     writeFile('src/commandMap.json', JSON.stringify(map, null, '  '), err => {
//         if (err) {
//             console.error(err);
//         }
//     });
// }, console.error);
