import * as vscode from 'vscode';
import { DefaultAzureCredential } from "@azure/identity";


type Dictionary = { 
    [key: string]: any 
};

async function sendPostRequest(url: string, data: Dictionary): Promise<any> {  
    try {  

        const credential = new DefaultAzureCredential();
        const auth_token = await credential.getToken("https://management.core.windows.net/.default")

        const response = await fetch(url, {  
            method: 'POST',  
            headers: {  
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + auth_token.token  
            },
            body: JSON.stringify(data),  
        });  
  
        if (!response.body) {  
            throw new Error('No body in response'); 
        }  

        return response.body.getReader();  

    } catch (error) {  
        console.error('Unexpected error:', error);  
        throw error;  
    }  
}  

const endpointUrl = 'https://azclitools-copilot-apim-vscode.azure-api.net/azcli/copilot/streaming';

export async function copilotRequestHandler(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) {

    const previousMessages = context.history.filter(h => h instanceof vscode.ChatRequestTurn);
    
    const history_questions = previousMessages.map((item) => {
        const requestTurn = item as vscode.ChatRequestTurn;
        return {
            "role": "user",
            "content": requestTurn.prompt
        }
    });

    const postData: Dictionary = {  
        "question": request.prompt,
        "history": history_questions
    };

    stream.progress('Retrieve Azure CLI related knowledge ......');

    const reader = await sendPostRequest(endpointUrl, postData);
    const decoder = new TextDecoder(); 
 
    while (true) {  
        const { done, value } = await reader.read();  

        if (done) {  
            break;  
        }  

        const fragment = decoder.decode(value, { stream: true });  
        stream.markdown(fragment);
    }  

}
