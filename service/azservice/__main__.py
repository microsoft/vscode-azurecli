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

def get_completions(command_table, query):
    command_name = query['command']
    if command_name in command_table:
        command = command_table[command_name]
        argument_name = query['argument']
        if argument_name in command.arguments:
            argument = command.arguments[argument_name]
            # TODO: choices
            if argument.completer:
                try:
                    return argument.completer('', 'action?', {})
                except TypeError:
                    try:
                        return argument.completer('')
                    except TypeError:
                        try:
                            return argument.completer()
                        except TypeError:
                            pass
    return []

load_profile()

command_table = load_command_table()

while True:
    line = stdin.readline()
    query = json.loads(line)
    completions = get_completions(command_table, query)
    output = json.dumps(completions)
    print(output)
    stdout.flush()

# {"command":"appservice web browse","argument":"name"}
