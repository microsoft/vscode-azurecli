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

from azure.cli.core.application import APPLICATION
from azure.cli.core.commands import _update_command_definitions
from azure.cli.core._session import ACCOUNT
from azure.cli.core._environment import get_config_dir as cli_config_dir
from azure.cli.core._config import az_config, GLOBAL_CONFIG_PATH, DEFAULTS_SECTION
from azure.cli.core.help_files import helps


global_arguments = {
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
    command_table = APPLICATION.configuration.get_command_table()
    install_modules(command_table)
    return command_table

def install_modules(command_table):
    for cmd in command_table:
        command_table[cmd].load_arguments()

    try:
        mods_ns_pkg = import_module('azure.cli.command_modules')
        installed_command_modules = [modname for _, modname, _ in
                                     pkgutil.iter_modules(mods_ns_pkg.__path__)]
    except ImportError:
        pass
    for mod in installed_command_modules:
        try:
            import_module('azure.cli.command_modules.' + mod).load_params(mod)
        except Exception:  # pylint: disable=broad-except
            print("Error loading: {}".format(mod), file=stderr)
            traceback.print_exc(file=stderr)
    _update_command_definitions(command_table)

def get_group_index(command_table):
    index = { '': [] }
    for command in command_table.values():
        parts = command.name.split()
        for i in range(1, len(parts)):
            group = ' '.join(parts[0:i])
            if group not in index:
                index[group] = []
                parent = ' '.join(parts[0:i - 1])
                completion = {
                    'name': parts[i - 1],
                    'kind': 'group'
                }
                if group in helps:
                    description = yaml.load(helps[group]).get('short-summary')
                    if description:
                        completion['description'] = description
                index[parent].append(completion)
        parent = ' '.join(parts[0:-1])
        completion = {
            'name': parts[-1],
            'kind': 'command'
        }
        if command.name in helps:
            description = yaml.load(helps[command.name]).get('short-summary')
            if description:
                completion['description'] = description
        index[parent].append(completion)
    return index

def load_profile():
    azure_folder = cli_config_dir()
    if not os.path.exists(azure_folder):
        os.makedirs(azure_folder)

    ACCOUNT.load(os.path.join(azure_folder, 'azureProfile.json'))

def get_completions(group_index, command_table, query, verbose=False):
    if 'argument' in query:
        return get_parameter_value_completions(command_table, query, verbose)
    command_name = query['subcommand']
    if command_name in command_table:
        return get_parameter_name_completions(command_table, query, verbose) + \
            get_global_parameter_name_completions(query, verbose)
    if command_name in group_index:
        return group_index[command_name]
    if verbose: print('Subcommand not found ({})'.format(command_name), file=stderr)
    return []

def get_parameter_name_completions(command_table, query, verbose=False):
    command_name = query['subcommand']
    command = command_table[command_name]
    arguments = query['arguments']
    unused = [ argument for argument in command.arguments.values()
        if not [ option for option in argument.options_list if option in arguments ] ]
    return [ {
        'name': option,
        'kind': 'argument_name',
        'description': argument.type.settings.get('help')
    } for argument in unused for option in argument.options_list ]

def get_parameter_value_completions(command_table, query, verbose=False):
    list = get_parameter_value_list(command_table, query, verbose) + \
        get_global_parameter_value_list(query, verbose)
    return [ {
        'name': item,
        'kind': 'argument_value'
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
        elif verbose and not [ a for a in global_arguments.values() if argument_name in a['options'] ]: print('Argument not found ({} {})'.format(command_name, argument_name), file=stderr)
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
    # TODO Needs change in CLI module that removes 'configured_default' from argument.type.settings (here copied to argument.type).
    # azure/cli/core/commands/__init__.py:
    #     if 'configured_default' in overrides.settings:
    #         def_config = overrides.settings.pop('configured_default', None)
    #         setattr(arg.type, 'configured_default', def_config) <<< Added line
    reloaded = False
    for name, argument in command.arguments.items():
        if not hasattr(arguments, name) and hasattr(argument.type, 'configured_default'):
            if not reloaded:
                reload_config()
                reloaded = True
            default = find_default(argument.type.configured_default)
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

def get_global_parameter_name_completions(query, verbose=False):
    arguments = query['arguments']
    unused = [ argument for argument in global_arguments.values()
        if not [ option for option in argument['options'] if option in arguments ] ]
    return [ {
        'name': option,
        'kind': 'argument_name',
        'description': argument.get('help')
    } for argument in unused for option in argument['options'] ]

def get_global_parameter_value_list(query, verbose=False):
    argument_name = query['argument']
    argument = next((argument for argument in global_arguments.values() if argument_name in argument['options']), None)
    if argument:
        if 'choices' in argument:
            return argument['choices']
        elif verbose: print('Completions not found ({})'.format(argument_name), file=stderr)
    return []

load_profile()

command_table = load_command_table()
group_index = get_group_index(command_table)

while True:
    line = stdin.readline()
    request = json.loads(line)
    completions = get_completions(group_index, command_table, request['query'], True)
    response = {
        'sequence': request['sequence'],
        'completions': completions
    }
    output = json.dumps(response)
    print(output)
    stdout.flush()

# {"sequence":4,"query":{"subcommand":"appservice"}}
# {"sequence":4,"query":{"subcommand":"appservice web"}}
# {"sequence":4,"query":{"subcommand":"appservice web browse","arguments": {}}}
# {"sequence":4,"query":{"subcommand":"appservice web browse","arguments": {"--resource-group":null}}}
# {"sequence":4,"query":{"subcommand":"appservice web browse","arguments": {"--output":"table"}}}
# {"sequence":4,"query":{"subcommand":"appservice web browse","argument":"--resource-group","arguments": {}}}
# {"sequence":4,"query":{"subcommand":"appservice web browse","argument":"--name","arguments":{}}}
# {"sequence":4,"query":{"subcommand":"appservice web browse","argument":"--name","arguments":{"-g":"chrmarti-test"}}}
# {"sequence":4,"query":{"subcommand":"appservice web browse","argument":"--output","arguments": {}}}
