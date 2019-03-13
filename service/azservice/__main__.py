"""az service"""
# --------------------------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
# --------------------------------------------------------------------------------------------
from __future__ import print_function

from sys import stdin, stdout, stderr
import json
import time
from threading  import Thread
try:
    from Queue import Queue, Empty
except ImportError:
    from queue import Queue, Empty # python 3.x

from azservice.tooling import GLOBAL_ARGUMENTS, initialize, load_command_table, get_help, get_current_subscription, get_configured_defaults, get_defaults, is_required, run_argument_value_completer, get_arguments, load_arguments, arguments_loaded

NO_AZ_PREFIX_COMPLETION_ENABLED = True # Adds proposals without 'az' as prefix to trigger, 'az' is then inserted as part of the completion.
AUTOMATIC_SNIPPETS_ENABLED = True # Adds snippet proposals derived from the command table
TWO_SEGMENTS_COMPLETION_ENABLED = False # Adds 'webapp create', 'appservice plan', etc. as proposals.
REQUIRED_ARGUMENTS_IN_COMMAND_COMPLETIONS = False # Adds required arguments to command completions (always for snippets)

AZ_COMPLETION = {
    'name': 'az',
    'kind': 'command',
    'documentation': 'Microsoft command-line tools for Azure.'
}

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
                help = get_help(group)
                if help:
                    description = help.get('short-summary')
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
    help = get_help(command.name)
    if help:
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

def get_completions(group_index, command_table, snippets, query, verbose=False):
    if 'argument' in query:
        return get_argument_value_completions(command_table, query, verbose)
    if 'subcommand' not in query:
        return get_snippet_completions(command_table, snippets) + get_prefix_command_completions(group_index, command_table) + [AZ_COMPLETION]
    command_name = query['subcommand']
    if command_name in command_table:
        return get_argument_name_completions(command_table, query) + \
            get_global_argument_name_completions(query)
    if command_name in group_index:
        return get_command_completions(group_index, command_table, command_name)
    if verbose: print('Subcommand not found ({})'.format(command_name), file=stderr)
    return []

def get_snippet_completions(command_table, snippets):
    return [
        with_snippet(command_table, snippet['subcommand'], 'az ' + snippet['subcommand'], snippet['completion'])
        for snippet in snippets if arguments_loaded(snippet['subcommand'])
    ]

def get_command_completions(group_index, command_table, command_name):
    if not REQUIRED_ARGUMENTS_IN_COMMAND_COMPLETIONS:
        return group_index[command_name]
    return [
        (with_snippet(command_table, (command_name + ' ' + completion['name']).strip(), completion['name'], completion)
            if completion['kind'] == 'command' else completion)
        for completion in group_index[command_name]
    ]

def get_prefix_command_completions(group_index, command_table):
    if not REQUIRED_ARGUMENTS_IN_COMMAND_COMPLETIONS:
        return group_index['-']
    return [
        (with_snippet(command_table, completion['name'], completion['snippet'], completion)
            if completion['kind'] == 'command' else completion)
        for completion in group_index['-']
    ]

def with_snippet(command_table, subcommand, snippet_prefix, completion):
    arguments = get_argument_name_completions(command_table, { 'subcommand': subcommand, 'arguments': [] })
    snippet = snippet_prefix
    tabstop = 1
    for argument in arguments:
        if argument['required'] and not argument['default'] and argument['name'].startswith('--'):
            snippet += ' ' + argument['name'] + '$' + str(tabstop)
            tabstop += 1
    if snippet != completion['name']:
        completion = completion.copy()
        completion['snippet'] = snippet
    return completion

def get_argument_name_completions(command_table, query):
    command_name = query['subcommand']
    command = command_table[command_name]
    arguments = query['arguments']
    unused = { name: argument for name, argument in get_arguments(command).items()
        if not [ option for option in get_options(argument.options_list) if option in arguments ]
            and argument.type.settings.get('help') != '==SUPPRESS==' }
    defaults = get_defaults(unused)
    return [ {
        'name': option,
        'kind': 'argument_name',
        'required': is_required(argument),
        'default': not not defaults.get(name),
        'detail': 'required' if is_required(argument) and not defaults.get(name) else None,
        'documentation': argument.type.settings.get('help'),
        'sortText': ('10_' if is_required(argument) and not defaults.get(name) else '20_') + option
    } for name, argument in unused.items() for option in get_options(argument.options_list) ]

def get_argument_value_completions(command_table, query, verbose=False):
    list = get_argument_value_list(command_table, query, verbose) + \
        get_global_argument_value_list(query, verbose)
    return [ {
        'name': item,
        'kind': 'argument_value',
        'snippet': '"' + item + '"' if ' ' in item else item
    } for item in list ]

def get_argument_value_list(command_table, query, verbose=False):
    command_name = query['subcommand']
    if command_name in command_table:
        command = command_table[command_name]
        argument_name = query['argument']
        _, argument = get_argument(command, argument_name)
        if argument:
            if argument.choices:
                return argument.choices
            if argument.completer:
                values = run_argument_value_completer(command, argument, query['arguments'])
                if values is not None:
                    return values
                if verbose: print('Completer not run ({} {})'.format(command_name, argument_name), file=stderr)
            elif verbose: print('Completions not found ({} {})'.format(command_name, argument_name), file=stderr)
        elif verbose and not [ a for a in GLOBAL_ARGUMENTS.values() if argument_name in a['options'] ]: print('Argument not found ({} {})'.format(command_name, argument_name), file=stderr)
    elif verbose: print('Command not found ({})'.format(command_name), file=stderr)
    return []

def get_argument(command, argument_name):
    for name, argument in get_arguments(command).items():
        if argument_name in get_options(argument.options_list):
            return name, argument
    return None, None

def get_global_argument_name_completions(query):
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

def get_global_argument_value_list(query, verbose=False):
    argument_name = query['argument']
    argument = next((argument for argument in GLOBAL_ARGUMENTS.values() if argument_name in argument['options']), None)
    if argument:
        if 'choices' in argument:
            return argument['choices']
        elif verbose: print('Completions not found ({})'.format(argument_name), file=stderr)
    return []

def get_status():
    subscription = get_current_subscription()
    if not subscription:
        return { 'message': 'Not logged in' }
    defaults = get_defaults_status()
    return { 'message': 'Subscription: {0}{1}'.format(subscription, defaults) }

def get_defaults_status():
    defaults = get_configured_defaults()
    defaults_status = ''
    for name, value in defaults.items():
        defaults_status += ', ' + name.capitalize() + ': ' + value
    return defaults_status

def get_hover_text(group_index, command_table, command):
    subcommand = command['subcommand']
    if 'argument' in command and subcommand in command_table:
        argument_name = command['argument']
        argument = next((argument for argument in get_arguments(command_table[subcommand]).values() if argument_name in get_options(argument.options_list)), None)
        if argument:
            req = is_required(argument)
            return { 'paragraphs': [ '`' + ' '.join(get_options(argument.options_list)) + '`' + ('*' if req else '') + ': ' + argument.type.settings.get('help')
                 + ('\n\n*Required' if req else '') ] }
        argument = next((argument for argument in GLOBAL_ARGUMENTS.values() if argument_name in argument['options']), None)
        if argument:
            return { 'paragraphs': [ '`' + ' '.join(argument['options']) + '`: ' + argument['help'] ] }
        return

    help = get_help(subcommand)
    if help:
        short_summary = help.get('short-summary')
        if short_summary:
            paragraphs = [ '{1}\n\n`{0}`\n\n{2}'.format(subcommand, short_summary, help.get('long-summary', '')).strip() ]
            if subcommand in command_table:
                list = sorted([ argument for argument in get_arguments(command_table[subcommand]).values() if argument.type.settings.get('help') != '==SUPPRESS==' ], key=lambda e: str(not is_required(e)) + get_options(e.options_list)[0])
                if list:
                    paragraphs.append('Arguments\n' + '\n'.join([ '- `' + ' '.join(get_options(argument.options_list)) + '`' + ('*' if is_required(argument) else '') + ': ' + (argument.type.settings.get('help') or '')
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

def get_short_summary(subcommand, fallback):
    help = get_help(subcommand)
    if help:
        return help.get('short-summary', fallback)
    return fallback

def get_options(options):
    return [ option for option in [
        option if isinstance(option, str) else
        option.target if hasattr(option, 'target') else
        None
    for option in options ] if option ]

def main():
    timings = False
    start = time.time()
    initialize()
    if timings: print('initialize {} s'.format(time.time() - start), file=stderr)

    start = time.time()
    command_table = load_command_table()
    if timings: print('load_command_table {} s'.format(time.time() - start), file=stderr)

    start = time.time()
    group_index = get_group_index(command_table)
    if timings: print('get_group_index {} s'.format(time.time() - start), file=stderr)

    start = time.time()
    snippets = get_snippets(command_table) if AUTOMATIC_SNIPPETS_ENABLED else []
    if timings: print('get_snippets {} s'.format(time.time() - start), file=stderr)

    def enqueue_output(input, queue):
        for line in iter(input.readline, b''):
            queue.put(line)

    queue = Queue()
    thread = Thread(target=enqueue_output, args=(stdin, queue))
    thread.daemon = True
    thread.start()

    bkg_start = time.time()
    keep_loading = True
    while True:

        if keep_loading:
            keep_loading = load_arguments(command_table, 10)
            if not keep_loading and timings: print('load_arguments {} s'.format(time.time() - bkg_start), file=stderr)

        try:
            line = queue.get_nowait() if keep_loading else queue.get()
        except Empty:
            continue
        
        start = time.time()
        request = json.loads(line)
        response_data = None
        if request['data'].get('request') == 'status':
            response_data = get_status()
            if timings: print('get_status {} s'.format(time.time() - start), file=stderr)
        elif request['data'].get('request') == 'hover':
            response_data = get_hover_text(group_index, command_table, request['data']['command'])
            if timings: print('get_hover_text {} s'.format(time.time() - start), file=stderr)
        else:
            response_data = get_completions(group_index, command_table, snippets, request['data'], True)
            if timings: print('get_completions {} s'.format(time.time() - start), file=stderr)
        response = {
            'sequence': request['sequence'],
            'data': response_data
        }
        output = json.dumps(response)
        stdout.write(output + '\n')
        stdout.flush()
        stderr.flush()

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
# {"sequence":4,"data":{"subcommand":"webapp browse","argument":"-g","arguments":{}}}
# {"sequence":4,"data":{"subcommand":"webapp browse","argument":"--name","arguments":{}}}
# {"sequence":4,"data":{"subcommand":"webapp browse","argument":"--name","arguments":{"-g":"chrmarti-group"}}}
# {"sequence":4,"data":{"subcommand":"webapp browse","argument":"--output","arguments":{}}}
# {"sequence":4,"data":{"request":"hover","command":{"subcommand":"appservice"}}}
# {"sequence":4,"data":{"request":"hover","command":{"subcommand":"appservice something"}}}
# {"sequence":4,"data":{"request":"hover","command":{"subcommand":"acs create"}}}
