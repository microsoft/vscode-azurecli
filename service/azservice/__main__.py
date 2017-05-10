"""az service"""
# --------------------------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
# --------------------------------------------------------------------------------------------
from __future__ import print_function

import os
import traceback
from importlib import import_module
from sys import stdin, stdout, stderr
import json
import pkgutil
import yaml
import time

from six.moves import configparser

from azure.cli.core.application import APPLICATION, Configuration
from azure.cli.core.commands import _update_command_definitions, BLACKLISTED_MODS
from azure.cli.core._profile import _SUBSCRIPTION_NAME, Profile
from azure.cli.core._session import ACCOUNT
from azure.cli.core._environment import get_config_dir as cli_config_dir
from azure.cli.core._config import az_config, GLOBAL_CONFIG_PATH, DEFAULTS_SECTION
from azure.cli.core.help_files import helps
from azure.cli.core.util import CLIError

NO_AZ_PREFIX_COMPLETION_ENABLED = True # Adds proposals without 'az' as prefix to trigger, 'az' is then inserted as part of the completion.
AUTOMATIC_SNIPPETS_ENABLED = True # Adds snippet proposals derived from the command table
TWO_SEGMENTS_COMPLETION_ENABLED = False # Adds 'webapp create', 'appservice plan', etc. as proposals.
REQUIRED_PARAMETERS_IN_COMMAND_COMPLETIONS = False # Adds required parameters to command completions (always for snippets)

AZ_COMPLETION = {
    'name': 'az',
    'kind': 'command',
    'documentation': 'Microsoft command-line tools for Azure.'
}

GLOBAL_ARGUMENTS = {
    'verbose': {
        'options': ['--verbose'],
        'help': 'Increase logging verbosity. Use --debug for full debug logs.'
    },
    'debug': {
        'options': ['--debug'],
        'help': 'Increase logging verbosity to show all debug logs.'
    },
    'output': {
        'options': ['--output', '-o'],
        'help': 'Output format',
        'choices': ['json', 'tsv', 'table', 'jsonc']
    },
    'help': {
        'options': ['--help', '-h'],
        'help': 'Get more information about a command'
    },
    'query': {
        'options': ['--query'],
        'help': 'JMESPath query string. See http://jmespath.org/ for more information and examples.'
    }
}

def load_command_table():
    APPLICATION.initialize(Configuration())
    command_table = APPLICATION.configuration.get_command_table()
    install_modules(command_table)
    return command_table

def install_modules(command_table):
    for cmd in command_table:
        command_table[cmd].load_arguments()

    try:
        mods_ns_pkg = import_module('azure.cli.command_modules')
        installed_command_modules = [modname for _, modname, _ in
                                     pkgutil.iter_modules(mods_ns_pkg.__path__)
                                     if modname not in BLACKLISTED_MODS]
    except ImportError:
        pass
    for mod in installed_command_modules:
        try:
            mod = import_module('azure.cli.command_modules.' + mod)
            mod.load_params(mod)
            mod.load_commands()

        except Exception:  # pylint: disable=broad-except
            print("Error loading: {}".format(mod), file=stderr)
            traceback.print_exc(file=stderr)
    _update_command_definitions(command_table)

def get_group_index(command_table):
    index = { '': [], '-': [] }
    for command in command_table.values():
        parts = command.name.split()
        len_parts = len(parts)
        for i in range(1, len_parts):
            group = ' '.join(parts[0:i])
            if group not in index:
                index[group] = []
                parent = ' '.join(parts[0:i - 1])
                completion = {
                    'name': parts[i - 1],
                    'kind': 'group',
                    'detail': group
                }
                if group in helps:
                    description = yaml.load(helps[group]).get('short-summary')
                    if description:
                        completion['documentation'] = description

                index[parent].append(completion)
                if NO_AZ_PREFIX_COMPLETION_ENABLED and i == 1:
                    add = completion.copy()
                    add['snippet'] = 'az ' + add['name']
                    index['-'].append(add)
                
                if TWO_SEGMENTS_COMPLETION_ENABLED and i > 1:
                    add = completion.copy()
                    add['name'] = ' '.join(parts[i - 2:i])
                    index[' '.join(parts[0:i - 2])].append(add)
                    if NO_AZ_PREFIX_COMPLETION_ENABLED and i == 2:
                        add = add.copy()
                        add['snippet'] = 'az ' + add['name']
                        index['-'].append(add)

        parent = ' '.join(parts[0:-1])
        completion = {
            'name': parts[-1],
            'kind': 'command',
            'detail': command.name
        }
        add_command_documentation(completion, command)

        index[parent].append(completion)

        if TWO_SEGMENTS_COMPLETION_ENABLED and len_parts > 1:
            add = completion.copy()
            add['name'] = ' '.join(parts[len_parts - 2:len_parts])
            index[' '.join(parts[0:len_parts - 2])].append(add)
            if NO_AZ_PREFIX_COMPLETION_ENABLED and len_parts == 2:
                add = add.copy()
                add['snippet'] = 'az ' + add['name']
                index['-'].append(add)
    return index

def get_snippets(command_table):
    snippets = []
    for command in command_table.values():
        if command.name.startswith('appservice web'):
            continue
        completion = {
            'name': ' '.join(reversed(command.name.split())),
            'kind': 'snippet',
            'detail': command.name
        }
        add_command_documentation(completion, command)
        snippets.append({
            'subcommand': command.name,
            'completion': completion
        })
    return snippets

def add_command_documentation(completion, command):
    if command.name in helps:
        help = yaml.load(helps[command.name])
        short_summary = help.get('short-summary')
        if short_summary:
            completion['documentation'] = short_summary
            long_summary = help.get('long-summary')
            if long_summary:
                completion['documentation'] += '\n\n' + long_summary
            examples = help.get('examples')
            if examples:
                for example in examples:
                    completion['documentation'] += '\n\n' + example['name'].strip() + '\n' + example['text'].strip()

def load_profile():
    azure_folder = cli_config_dir()
    if not os.path.exists(azure_folder):
        os.makedirs(azure_folder)

    ACCOUNT.load(os.path.join(azure_folder, 'azureProfile.json'))

def get_completions(group_index, command_table, snippets, query, verbose=False):
    if 'argument' in query:
        return get_parameter_value_completions(command_table, query, verbose)
    if 'subcommand' not in query:
        return get_snippet_completions(command_table, snippets) + get_prefix_command_completions(group_index, command_table) + [AZ_COMPLETION]
    command_name = query['subcommand']
    if command_name in command_table:
        return get_parameter_name_completions(command_table, query) + \
            get_global_parameter_name_completions(query)
    if command_name in group_index:
        return get_command_completions(group_index, command_table, command_name)
    if verbose: print('Subcommand not found ({})'.format(command_name), file=stderr)
    return []

def get_snippet_completions(command_table, snippets):
    return [
        with_snippet(command_table, snippet['subcommand'], 'az ' + snippet['subcommand'], snippet['completion'])
        for snippet in snippets
    ]

def get_command_completions(group_index, command_table, command_name):
    if not REQUIRED_PARAMETERS_IN_COMMAND_COMPLETIONS:
        return group_index[command_name]
    return [
        (with_snippet(command_table, (command_name + ' ' + completion['name']).strip(), completion['name'], completion)
            if completion['kind'] == 'command' else completion)
        for completion in group_index[command_name]
    ]

def get_prefix_command_completions(group_index, command_table):
    if not REQUIRED_PARAMETERS_IN_COMMAND_COMPLETIONS:
        return group_index['-']
    return [
        (with_snippet(command_table, completion['name'], completion['snippet'], completion)
            if completion['kind'] == 'command' else completion)
        for completion in group_index['-']
    ]

def with_snippet(command_table, subcommand, snippet_prefix, completion):
    parameters = get_parameter_name_completions(command_table, { 'subcommand': subcommand, 'arguments': [] })
    snippet = snippet_prefix
    tabstop = 1
    for parameter in parameters:
        if parameter['required'] and not parameter['default'] and parameter['name'].startswith('--'):
            snippet += ' ' + parameter['name'] + '$' + str(tabstop)
            tabstop += 1
    if snippet != completion['name']:
        completion = completion.copy()
        completion['snippet'] = snippet
    return completion

def get_parameter_name_completions(command_table, query):
    command_name = query['subcommand']
    command = command_table[command_name]
    arguments = query['arguments']
    unused = [ argument for argument in command.arguments.values()
        if not [ option for option in argument.options_list if option in arguments ] ]
    reload_config()
    return [ {
        'name': option,
        'kind': 'argument_name',
        'required': is_required(argument),
        'default': has_default(argument),
        'detail': 'required' if is_required(argument) and not has_default(argument) else None,
        'documentation': argument.type.settings.get('help'),
        'sortText': ('10_' if is_required(argument) and not has_default(argument) else '20_') + option
    } for argument in unused if argument.type.settings.get('help') != '==SUPPRESS==' for option in argument.options_list ]

def get_parameter_value_completions(command_table, query, verbose=False):
    list = get_parameter_value_list(command_table, query, verbose) + \
        get_global_parameter_value_list(query, verbose)
    return [ {
        'name': item,
        'kind': 'argument_value',
        'snippet': '"' + item + '"' if ' ' in item else item
    } for item in list ]

def get_parameter_value_list(command_table, query, verbose=False):
    command_name = query['subcommand']
    if command_name in command_table:
        command = command_table[command_name]
        argument_name = query['argument']
        _, argument = get_argument(command, argument_name)
        if argument:
            if argument.choices:
                return argument.choices
            if argument.completer:
                try:
                    args = get_parsed_args(command, query['arguments'])
                    add_defaults(command, args)
                    return argument.completer('', '', args)
                except TypeError:
                    try:
                        return argument.completer('')
                    except TypeError:
                        try:
                            return argument.completer()
                        except TypeError:
                            if verbose: print('Completer not run ({} {})'.format(command_name, argument_name), file=stderr)
            elif verbose: print('Completions not found ({} {})'.format(command_name, argument_name), file=stderr)
        elif verbose and not [ a for a in GLOBAL_ARGUMENTS.values() if argument_name in a['options'] ]: print('Argument not found ({} {})'.format(command_name, argument_name), file=stderr)
    elif verbose: print('Command not found ({})'.format(command_name), file=stderr)
    return []

def get_parsed_args(command, arguments):
    result = lambda: None
    for argument_name, value in arguments.items():
        name, _ = get_argument(command, argument_name)
        setattr(result, name, value)
    return result

def get_argument(command, argument_name):
    for name, argument in command.arguments.items():
        if argument_name in argument.options_list:
            return name, argument
    return None, None

def add_defaults(command, arguments):
    reloaded = False
    for name, argument in command.arguments.items():
        if not hasattr(arguments, name) and hasattr(argument.type, 'default_name_tooling') and argument.type.default_name_tooling:
            if not reloaded:
                reload_config()
                reloaded = True
            default = find_default(argument.type.default_name_tooling)
            if default:
                setattr(arguments, name, default)

    return arguments

def reload_config():
    az_config.config_parser.read(GLOBAL_CONFIG_PATH)

def find_default(default_name):
    try:
        return az_config.get(DEFAULTS_SECTION, default_name, None)
    except configparser.NoSectionError:
        return None

def get_global_parameter_name_completions(query):
    arguments = query['arguments']
    unused = [ argument for argument in GLOBAL_ARGUMENTS.values()
        if not [ option for option in argument['options'] if option in arguments ] ]
    return [ {
        'name': option,
        'kind': 'argument_name',
        'detail': 'global',
        'documentation': argument.get('help'),
        'sortText': '30_' + option
    } for argument in unused for option in argument['options'] ]

def get_global_parameter_value_list(query, verbose=False):
    argument_name = query['argument']
    argument = next((argument for argument in GLOBAL_ARGUMENTS.values() if argument_name in argument['options']), None)
    if argument:
        if 'choices' in argument:
            return argument['choices']
        elif verbose: print('Completions not found ({})'.format(argument_name), file=stderr)
    return []

PROFILE = Profile()

def get_status():
    load_profile()
    try:
        subscription = PROFILE.get_subscription()[_SUBSCRIPTION_NAME]
        defaults = get_defaults_status()
        return { 'message': 'Subscription: {0}{1}'.format(subscription, defaults) }
    except CLIError:
        return { 'message': 'Not logged in' }

def get_defaults_status():
    reload_config()
    try:
        options = az_config.config_parser.options(DEFAULTS_SECTION)
        defaults_status = ''
        for opt in options:
            value = az_config.get(DEFAULTS_SECTION, opt)
            if value:
                defaults_status += ', ' + opt.capitalize() + ': ' + az_config.get(DEFAULTS_SECTION, opt)
        return defaults_status
    except configparser.NoSectionError:
        return ''

def get_hover_text(group_index, command_table, command):
    subcommand = command['subcommand']
    if 'argument' in command and subcommand in command_table:
        argument_name = command['argument']
        argument = next((argument for argument in command_table[subcommand].arguments.values() if argument_name in argument.options_list), None)
        if argument:
            req = is_required(argument)
            return { 'paragraphs': [ '`' + ' '.join(argument.options_list) + '`' + ('*' if req else '') + ': ' + argument.type.settings.get('help')
                 + ('\n\n*Required' if req else '') ] }
        argument = next((argument for argument in GLOBAL_ARGUMENTS.values() if argument_name in argument['options']), None)
        if argument:
            return { 'paragraphs': [ '`' + ' '.join(argument['options']) + '`: ' + argument['help'] ] }
        return

    if subcommand in helps:
        help = yaml.load(helps[subcommand])
        short_summary = help.get('short-summary')
        if short_summary:
            paragraphs = [ '{1}\n\n`{0}`\n\n{2}'.format(subcommand, short_summary, help.get('long-summary', '')).strip() ]
            if subcommand in command_table:
                list = sorted([ argument for argument in command_table[subcommand].arguments.values() if argument.type.settings.get('help') != '==SUPPRESS==' ], key=lambda e: str(not is_required(e)) + e.options_list[0])
                if list:
                    paragraphs.append('Arguments\n' + '\n'.join([ '- `' + ' '.join(argument.options_list) + '`' + ('*' if is_required(argument) else '') + ': ' + argument.type.settings.get('help')
                        for argument in list ]) + ('\n\n*Required' if is_required(list[0]) else ''))
                paragraphs.append('Global Arguments\n' + '\n'.join([ '- `' + ' '.join(argument['options']) + '`: ' + argument['help']
                    for argument in GLOBAL_ARGUMENTS.values() ]))
            elif subcommand in group_index:
                list = sorted(group_index[subcommand], key=lambda e: e['name'])
                groups = [ element for element in list if element['kind'] == 'group' ]
                if groups:
                    paragraphs.append('Subgroups\n' + '\n'.join([ '- `' + element['name'] + '`: ' + get_short_summary(element.get('detail'), '-') for element in groups ]))
                commands = [ element for element in list if element['kind'] == 'command' ]
                if commands:
                    paragraphs.append('Commands\n' + '\n'.join([ '- `' + element['name'] + '`: ' + get_short_summary(element.get('detail'), '-') for element in commands ]))
            examples = help.get('examples')
            if examples:
                paragraphs.append('Examples\n\n' + '\n\n'.join([ '{0}\n```azcli\n{1}\n```'.format(example['name'].strip(), example['text'].strip())
                    for example in examples ]))
            return { 'paragraphs': paragraphs }
        return

def is_required(argument):
    return hasattr(argument.type, 'required_tooling') and argument.type.required_tooling == True and argument.name != 'is_linux'

def has_default(argument):
    return argument.type.settings.get('default') is not None or hasattr(argument.type, 'default_name_tooling') and argument.type.default_name_tooling and not not find_default(argument.type.default_name_tooling)

def get_short_summary(subcommand, fallback):
    if subcommand in helps:
        help = yaml.load(helps[subcommand])
        return help.get('short-summary', fallback)
    return fallback

def main():
    timings = False
    start = time.time()
    load_profile()
    if timings: print('load_profile {} s'.format(time.time() - start), file=stderr)

    start = time.time()
    command_table = load_command_table()
    if timings: print('load_command_table {} s'.format(time.time() - start), file=stderr)

    start = time.time()
    group_index = get_group_index(command_table)
    if timings: print('get_group_index {} s'.format(time.time() - start), file=stderr)

    start = time.time()
    snippets = get_snippets(command_table) if AUTOMATIC_SNIPPETS_ENABLED else []
    if timings: print('get_snippets {} s'.format(time.time() - start), file=stderr)

    while True:
        line = stdin.readline()
        request = json.loads(line)
        response_data = None
        if request['data'].get('request') == 'status':
            response_data = get_status()
        elif request['data'].get('request') == 'hover':
            start = time.time()
            response_data = get_hover_text(group_index, command_table, request['data']['command'])
            if timings: print('get_hover_text {} s'.format(time.time() - start), file=stderr)
        else:
            response_data = get_completions(group_index, command_table, snippets, request['data'], True)
        response = {
            'sequence': request['sequence'],
            'data': response_data
        }
        output = json.dumps(response)
        print(output)
        stdout.flush()

main()

# {"sequence":4,"data":{"request":"status"}}
# {"sequence":4,"data":{}}
# {"sequence":4,"data":{"subcommand":""}}
# {"sequence":4,"data":{"subcommand":"appservice"}}
# {"sequence":4,"data":{"subcommand":"appservice plan"}}
# {"sequence":4,"data":{"subcommand":"appservice plan create","arguments":{}}}
# {"sequence":4,"data":{"subcommand":"webapp"}}
# {"sequence":4,"data":{"subcommand":"webapp create","arguments":{}}}
# {"sequence":4,"data":{"subcommand":"webapp browse","arguments":{}}}
# {"sequence":4,"data":{"subcommand":"webapp browse","arguments":{"--resource-group":null}}}
# {"sequence":4,"data":{"subcommand":"webapp browse","arguments":{"--output":"table"}}}
# {"sequence":4,"data":{"subcommand":"webapp browse","argument":"--resource-group","arguments":{}}}
# {"sequence":4,"data":{"subcommand":"webapp browse","argument":"--name","arguments":{}}}
# {"sequence":4,"data":{"subcommand":"webapp browse","argument":"--name","arguments":{"-g":"chrmarti-test"}}}
# {"sequence":4,"data":{"subcommand":"webapp browse","argument":"--output","arguments":{}}}
# {"sequence":4,"data":{"request":"hover","command":{"subcommand":"appservice"}}}
# {"sequence":4,"data":{"request":"hover","command":{"subcommand":"appservice something"}}}
# {"sequence":4,"data":{"request":"hover","command":{"subcommand":"acs create"}}}
