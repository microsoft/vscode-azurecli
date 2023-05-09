import { AzService } from "../azService";

export interface Recommendation {
    description: string;
    executeIndex: number[]
    nextCommandSet: CommandInfo[]
}

export interface CommandInfo {
    command: string,
    arguments: string[],
    reason: string;
    example: string;
    isExecuted: boolean | null
}

export interface RecommendationQuery {
    request: 'recommendation';
    commandList: string;
}

export class RecommendService {

    private static currentRecommends: Recommendation | null = null;

    // the line on which the recommended scenarios are based
    private static requestServiceLine: number = -1;
    private static nextScenarios: Recommendation[] | null = null;

    constructor(private azService: AzService) {
    }

    static isReadyToRequestService(currentLine: number) {
        return RecommendService.requestServiceLine != currentLine; // RecommendService.isReInit && 
    }

    static getCurrentRecommends(): Recommendation | null {
        return RecommendService.currentRecommends;
    }
    
    static setNextScenarios(nextScenarios: Recommendation[]) {
        RecommendService.nextScenarios = nextScenarios;
    }
    
    static setCurrentLine(line: number) {
        return RecommendService.requestServiceLine = line;
    }

    static setCurrentRecommends(recommends: Recommendation): void {
        let executeIndex = recommends.executeIndex;
        let nextCommandSet = [];
        for (let index of executeIndex) {
            recommends.nextCommandSet[index].isExecuted = false;
            nextCommandSet.push(recommends.nextCommandSet[index]);
        }
        for (let command of recommends.nextCommandSet) {
            if (command.isExecuted == null || command.isExecuted) {
                command.isExecuted = true
                nextCommandSet.push(command);
            }
        }
        recommends.nextCommandSet = nextCommandSet;
        RecommendService.currentRecommends = recommends;
    }

    static initCurrentRecommends() {
        RecommendService.currentRecommends = null;
    }

    static postProcessOfRecommend(index: number) {
        if (RecommendService.currentRecommends == null) {
            return;
        }
        let nextCommandSet = RecommendService.currentRecommends.nextCommandSet
        const executedCommand = nextCommandSet[index]
        delete nextCommandSet[index]
        executedCommand.isExecuted = true
        nextCommandSet.push(executedCommand)
    }

    static preprocessRecommend(executedCommands: Set<string>){
        if (RecommendService.currentRecommends == null) {
            return;
        }
        let nextCommandSet = RecommendService.currentRecommends.nextCommandSet;
        const unusedCommands = [];
        const usedCommands = []
        for (let command of nextCommandSet) {
            if (executedCommands.has(command.command)) {
                command.isExecuted = true;
                usedCommands.push(command)
            } else {
                command.isExecuted = false;
                unusedCommands.push(command)
            }
        }

        RecommendService.currentRecommends.nextCommandSet = unusedCommands.concat(usedCommands);
    }

    async getRecommendation(commandList: string, onCancel: (handle: () => void) => void, isRequestService?: boolean): Promise<Recommendation[]> {
        try {
            if (RecommendService.nextScenarios == null || isRequestService) {
                console.log('request recommendation service');
                return this.azService.send<RecommendationQuery, Recommendation[]>({
                    request: 'recommendation',
                    commandList: commandList
                }, onCancel);
            }
            console.log('get next scenarios directly');
            return RecommendService.nextScenarios;
        } catch (err) {
            console.error(err);
            return [];
        }
    }
}

