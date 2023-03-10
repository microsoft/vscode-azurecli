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
    isExecuted: boolean | false
}

export interface RecommendationQuery {
    request: 'recommendation';
    commandList: string;
}


export class RecommendService {

    private static currentRecommends: Recommendation | null = null;

    constructor(private azService: AzService) {
    }

    static getCurrentRecommends(commandList: string[]): Recommendation | null {
        return RecommendService.currentRecommends;
    }

    static setCurrentRecommends(recommends: Recommendation): void {
        let executeIndex = recommends.executeIndex;
        let nextCommandSet = [];
        for (let index of executeIndex) {
            nextCommandSet.push(recommends.nextCommandSet[index]);
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

    static preprocessRecommend(executedCommands: string[]){
        
    }

    async getRecommendation(commandList: string, onCancel: (handle: () => void) => void): Promise<Recommendation[]> {
        try {
            return this.azService.send<RecommendationQuery, Recommendation[]>({
                request: 'recommendation',
                commandList: commandList
            }, onCancel);
        } catch (err) {
            console.error(err);
            return [];
        }
    }
}

