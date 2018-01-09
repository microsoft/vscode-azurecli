"""tooling integration"""
# --------------------------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
# --------------------------------------------------------------------------------------------

from distutils.version import LooseVersion
from azure.cli.core import __version__
if LooseVersion(__version__) < LooseVersion('2.0.24'):
    from azservice.tooling1 import GLOBAL_ARGUMENTS, initialize, load_command_table, get_help, get_current_subscription, get_configured_defaults, get_defaults, is_required, run_argument_value_completer, get_arguments, load_arguments, arguments_loaded
else:
    from azservice.tooling2 import GLOBAL_ARGUMENTS, initialize, load_command_table, get_help, get_current_subscription, get_configured_defaults, get_defaults, is_required, run_argument_value_completer, get_arguments, load_arguments, arguments_loaded
