# --------------------------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
# --------------------------------------------------------------------------------------------
from __future__ import print_function

import os
from importlib import import_module
from sys import stdin, stdout, stderr
import json
import pkgutil

from azure.cli.core.application import APPLICATION
from azure.cli.core.commands import _update_command_definitions
from azure.cli.core._session import ACCOUNT
from azure.cli.core._environment import get_config_dir as cli_config_dir
from azure.cli.core._config import az_config, GLOBAL_CONFIG_PATH, DEFAULTS_SECTION


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
            print("Error loading: {}".format(mod))
    _update_command_definitions(command_table)

def load_profile():
    azure_folder = cli_config_dir()
    if not os.path.exists(azure_folder):
        os.makedirs(azure_folder)

    ACCOUNT.load(os.path.join(azure_folder, 'azureProfile.json'))

def get_completions(command_table, query, verbose=False):
    command_name = query['command']
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
        elif verbose: print('Argument not found ({} {})'.format(command_name, argument_name), file=stderr)
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

load_profile()

command_table = load_command_table()

while True:
    line = stdin.readline()
    query = json.loads(line)
    completions = get_completions(command_table, query, True)
    output = json.dumps({ 'sequence': query['sequence'], 'completions': completions })
    print(output)
    stdout.flush()

# {"sequence":3,"command":"appservice web browse","argument":"--resource-group","arguments": {}}
# {"sequence":4,"command":"appservice web browse","argument":"--name","arguments":{"-g":"chrmarti-test"}}
# {"sequence":5,"command":"appservice web browse","argument":"--name","arguments":{}}
