import hashlib
import json
import time
from enum import Enum
from sys import stdout, stderr

from azure.cli.core import get_default_cli, __version__ as version
from azure.cli.core import telemetry
from azure.cli.core.azclierror import RecommendationError

from azservice.output_tool import flush_output

class RecommendType(int, Enum):
    All = 1
    Solution = 2
    Command = 3
    Scenario = 4


cli_ctx = None


def initialize():
    global cli_ctx
    cli_ctx = get_default_cli()
    print(f"version = {version}", file=stderr)


def request_recommend_service(request):
    start = time.time()

    if cli_ctx is None:
        initialize()

    command_list = request['data']['commandList']
    recommends = []
    from azure.cli.core.azclierror import RecommendationError
    try:
        recommends = get_recommends(command_list)
    except RecommendationError as e:
        print(e.error_msg, file=stderr)

    response = {
            'sequence': request['sequence'],
            'data': recommends
    }
    output = json.dumps(response)
    flush_output(output)
    print('request_recommend_service {} s'.format(time.time() - start), file=stderr)


def get_recommends(command_list):
    api_recommends = get_recommends_from_api(command_list, cli_ctx.config.getint('next', 'num_limit', fallback=5))
    recommends = get_scenarios_info(api_recommends)
    return recommends


def get_recommends_from_api(command_list, top_num=5):
    """query next command from web api"""
    import requests
    url = "https://cli-recommendation.azurewebsites.net/api/RecommendationService"
    debug_url = "http://localhost:7071/api/RecommendationService"

    user_id = telemetry._get_user_azure_id()  # pylint: disable=protected-access
    hashed_user_id = hashlib.sha256(user_id.encode('utf-8')).hexdigest()

    type = RecommendType.All

    payload = {
        "command_list": command_list,
        "type": type,
        "top_num": top_num,
        'cli_version': version,
        'user_id': hashed_user_id
    }

    correlation_id = telemetry._session.correlation_id
    subscription_id = telemetry._get_azure_subscription_id()
    if telemetry.is_telemetry_enabled():
        if correlation_id:
            payload['correlation_id'] = correlation_id
        if subscription_id:
            payload['subscription_id'] = subscription_id

    print('request body - {}'.format(payload), file=stderr)

    try:
        request_body = json.dumps(payload)
        start = time.time()
        response = requests.post(url, request_body, timeout=2)
        print('request recommendation service {} s'.format(time.time() - start), file=stderr)
        response.raise_for_status()
    except requests.ConnectionError as e:
        raise RecommendationError(f'Network Error: {e}') from e
    except requests.exceptions.HTTPError as e:
        raise RecommendationError(f'{e}') from e
    except requests.RequestException as e:
        raise RecommendationError(f'Request Error: {e}') from e

    recommends = []
    if 'data' in response.json():
        recommends = response.json()['data']

    return recommends


def get_scenarios_info(recommends):
    scenarios = get_scenarios(recommends) or []
    scenarios_info = []
    print('scenarios size - {}'.format(len(scenarios)), file=stderr)
    for idx, s in enumerate(scenarios):
        scenarios_info.append(get_info_of_one_scenario(s, idx))
    return scenarios_info


def get_info_of_one_scenario(s, index):
    idx_display = f'[{index + 1}]'
    scenario_desc = f'{s["scenario"]}'
    command_size = f'{len(s["nextCommandSet"])} Commands'
    description = f'{idx_display} {scenario_desc} ({command_size})'

    next_command_set = []
    arg_index = 1
    for next_command in s['nextCommandSet']:
        command = 'az ' + next_command['command']
        command_info = {
            'command': command,
            'arguments': next_command['arguments'],
            'reason': next_command['reason'],
            'example': next_command['example']
        }
        next_command_set.append(command_info)

    return {
        'description': description,
        'executeIndex': s['executeIndex'],
        'nextCommandSet': next_command_set
    }


def get_scenarios(recommends):
    return [rec for rec in recommends if rec['type'] == RecommendType.Scenario]
