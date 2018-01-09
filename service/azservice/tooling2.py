"""tooling integration"""
# --------------------------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
# --------------------------------------------------------------------------------------------
from __future__ import print_function

import yaml

from six.moves import configparser

from knack.help_files import helps

from azure.cli.core import get_default_cli
from azure.cli.core._profile import _SUBSCRIPTION_NAME, Profile
from azure.cli.core.util import CLIError
from azure.cli.core._config import GLOBAL_CONFIG_PATH, DEFAULTS_SECTION


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


cli_ctx = None
def initialize():
    global cli_ctx
    cli_ctx = get_default_cli()


def load_command_table():
    invoker = cli_ctx.invocation_cls(cli_ctx=cli_ctx, commands_loader_cls=cli_ctx.commands_loader_cls, parser_cls=cli_ctx.parser_cls, help_cls=cli_ctx.help_cls)
    cli_ctx.invocation = invoker
    cmd_table = invoker.commands_loader.load_command_table(None)
    for command in cmd_table:
        invoker.commands_loader.load_arguments(command)
    return cmd_table


HELP_CACHE = {}


def get_help(group_or_command):
    if group_or_command not in HELP_CACHE and group_or_command in helps:
        HELP_CACHE[group_or_command] = yaml.load(helps[group_or_command])
    return HELP_CACHE.get(group_or_command)


def get_current_subscription():
    try:
        profile = Profile(cli_ctx=cli_ctx)
        return profile.get_subscription()[_SUBSCRIPTION_NAME]
    except CLIError:
        return None  # Not logged in
    return None  # Not logged in


def get_configured_defaults():
    _reload_config()
    try:
        options = cli_ctx.config.config_parser.options(DEFAULTS_SECTION)
        defaults = {}
        for opt in options:
            value = cli_ctx.config.get(DEFAULTS_SECTION, opt)
            if value:
                defaults[opt] = value
        return defaults
    except configparser.NoSectionError:
        return {}


def is_required(argument):
    required_tooling = hasattr(argument.type, 'required_tooling') and argument.type.required_tooling is True
    return required_tooling and argument.name != 'is_linux'


def get_defaults(arguments):
    _reload_config()
    return {name: _get_default(argument) for name, argument in arguments.items()}


def _get_default(argument):
    configured = _find_configured_default(argument)
    # TODO: Some default values are built-in (not configured as we want here), but we don't know which.
    return configured or argument.type.settings.get('default')


def run_argument_value_completer(command, argument, cli_arguments):
    try:
        args = _to_argument_object(command, cli_arguments)
        _add_defaults(command, args)
        return argument.completer(prefix='', action=None, parsed_args=args)
    except TypeError:
        try:
            return argument.completer(prefix='')
        except TypeError:
            try:
                return argument.completer()
            except TypeError:
                return None


def _to_argument_object(command, cli_arguments):
    result = lambda: None  # noqa: E731
    for argument_name, value in cli_arguments.items():
        name, _ = _find_argument(command, argument_name)
        setattr(result, name, value)
    setattr(result, '_cmd', command)
    return result


def _find_argument(command, argument_name):
    for name, argument in command.arguments.items():
        if argument_name in argument.options_list:
            return name, argument
    return None, None


def _add_defaults(command, arguments):
    _reload_config()
    for name, argument in command.arguments.items():
        if not hasattr(arguments, name):
            default = _find_configured_default(argument)
            if default:
                setattr(arguments, name, default)

    return arguments


def _reload_config():
    cli_ctx.config.config_parser.read(GLOBAL_CONFIG_PATH)


def _find_configured_default(argument):
    if not (hasattr(argument.type, 'default_name_tooling') and argument.type.default_name_tooling):
        return None
    try:
        return cli_ctx.config.get(DEFAULTS_SECTION, argument.type.default_name_tooling, None)
    except configparser.NoSectionError:
        return None
