import { Agent } from "@mastra/core/agent";
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { Pica } from '@picahq/ai';
import { openai } from "@ai-sdk/openai";
import { generateText, generateObject, LanguageModel } from "ai";
import { z } from 'zod';
import { ModelDefinition, ExecutionContext } from './interface';

const ExtractedDataSchema = z.object({
    ids: z.record(z.string())
        .describe("A dictionary of extracted IDs. The key should be a descriptive name (e.g., 'documentId', 'revisionId') and the value is the ID string.")
        .default({}),
    created_resources: z.record(z.object({}).passthrough())
        .describe("A dictionary to hold entire JSON objects of newly created resources, keyed by a descriptive name like 'created_document'.")
        .default({}),
    extracted_lists: z.record(z.array(z.unknown()))
        .describe("A dictionary for any arrays or lists of items returned, keyed by a descriptive name like 'document_list'.")
        .default({})
}).default({
    ids: {},
    created_resources: {},
    extracted_lists: {}
});

type ExtractedData = z.infer<typeof ExtractedDataSchema>;

export class EnhancedAgentService {
  private picaClient: Pica;
  private agent!: Agent;
  private memory: Memory;
  private analysisModel: LanguageModel;

  constructor(picaSecretKey: string, openAIApiKey: string) {
    if (!picaSecretKey) {
      throw new Error("PICA_SECRET_KEY is required for EnhancedAgentService.");
    }
    if (!openAIApiKey) {
      console.warn("OPENAI_API_KEY not provided; LLM interactions may fail.");
    }
    this.analysisModel = openai("gpt-4-turbo");

    this.picaClient = new Pica(picaSecretKey, {
      connectors: ["*"],
      serverUrl: "https://development-api.picaos.com",
    });

    this.memory = new Memory({
      storage: new LibSQLStore({
        url: 'file::memory:',
      }),
    });

    this.initializeAgent(openAIApiKey);
  }

  private async initializeAgent(openAIApiKey: string) {
    const systemPrompt = await this.picaClient.generateSystemPrompt();
    this.agent = new Agent({
      name: "PicaTestingAgent",
      instructions: `${systemPrompt}

You are an automated execution engine. Your SOLE PURPOSE is to call the provided Pica tool.
- You MUST call the tool to accomplish the task. Do NOT simulate or describe the action. EXECUTE IT.
- Use the context, especially the 'Available Data' JSON object, to find necessary IDs or data for the tool's arguments.
- CRITICAL: If you need an ID (like documentId) and it's available in the context, USE IT IMMEDIATELY. Do not ask the user for IDs that are already available.

**Verification Principle: For any action that modifies, updates, or deletes data (e.g., 'update document', 'delete user'), you MUST first verify the target data exists. If it does not, you must take a preliminary step to CREATE it before proceeding with the original action. This may require you to perform multiple tool calls.**

**CRITICAL RULE: After the tool call, your final response to the user MUST include the raw JSON output from the Pica tool. This is not optional. If the tool creates a new resource, you MUST include the entire JSON object of that resource, including its ID (e.g., "documentId"). Wrap the JSON in markdown code blocks.**
`,
      model: openai("gpt-4.1"),
      tools: { ...this.picaClient.oneTool },
      memory: this.memory,
    });
  }

  private buildContextualPrompt(action: ModelDefinition, context: ExecutionContext): string {
    let contextPrompt = "";
    
    const availableData: { [key: string]: any } = {};

    if (context.availableIds && context.availableIds.size > 0) {
      availableData.ids = Object.fromEntries(context.availableIds);
    }

    if (context.createdResources && context.createdResources.size > 0) {
        availableData.resources = Object.fromEntries(context.createdResources);
    }

    if (Object.keys(availableData).length > 0) {
      contextPrompt += `--- AVAILABLE DATA FOR TOOL ARGUMENTS ---\n`;
      contextPrompt += `\`\`\`json\n${JSON.stringify(availableData, null, 2)}\n\`\`\`\n`;
      contextPrompt += `-----------------------------------------\n\n`;
      
      contextPrompt += `**IMPORTANT**: The above JSON contains IDs and data from previous successful actions. `;
      contextPrompt += `If this action requires any of these IDs (like documentId, revisionId, etc.), `;
      contextPrompt += `you MUST use them from the JSON above. Do NOT ask the user for IDs that are already available.\n\n`;
    }

    return contextPrompt;
  }

  private getVerificationInstructions(action: Readonly<ModelDefinition>): string {
    const actionName = action.actionName.toLowerCase();
    const modificationKeywords = ['update', 'patch', 'modify', 'replace', 'change'];
    const deletionKeywords = ['delete', 'remove', 'revoke'];

    let instructions = '';

    if (modificationKeywords.some(kw => actionName.includes(kw))) {
      instructions = `
**VERIFICATION STEP REQUIRED:**
This is an UPDATE action. Before executing it, you must first verify that the data you are trying to update actually exists.
1.  **Check Data:** Use a "get" or "list" action to check the resource's current state. For example, to update text in a document, first get the document's content to ensure the text you want to replace is present.
2.  **Create if Missing:** If the data is not present (e.g., the document is empty or the text is missing), you MUST first use a "create" or "insert" action to add mock data.
3.  **Execute Update:** Only after confirming or creating the data, proceed with the original "${action.title}" action.
`;
    } else if (deletionKeywords.some(kw => actionName.includes(kw))) {
      instructions = `
**VERIFICATION STEP REQUIRED:**
This is a DELETE action. Before executing it, you must first verify that the resource you are trying to delete actually exists.
1.  **Check Existence:** Use a "get" or "list" action to confirm the resource exists using its ID.
2.  **Create if Missing:** If the resource does not exist (perhaps it was deleted in a previous step), you MUST first use a "create" action to create a new resource. Use the ID of this newly created resource for the deletion.
3.  **Execute Deletion:** Only after confirming or creating the resource, proceed with the original "${action.title}" action.
`;
    }
    
    return instructions;
  }

  async generateTaskPrompt(
    action: Readonly<ModelDefinition>,
    context: ExecutionContext
  ): Promise<string> {
    const contextualInfo = this.buildContextualPrompt(action, context);
    const verificationInstructions = this.getVerificationInstructions(action);

    let taskInstruction = `Perform the PicaOS action: "${action.title}".`;

    if (verificationInstructions) {
        taskInstruction += `\n\n${verificationInstructions}`;
    }

    if (contextualInfo.trim() !== "") {
        taskInstruction += `\n\nYou MUST use the data from the "AVAILABLE DATA" JSON object to populate the required parameters for the tool call. For example, if the action requires a 'documentId', find it inside the 'ids' object in the JSON and use it directly.`;
        
        if (context.availableIds && context.availableIds.size > 0) {
          taskInstruction += `\n\n**PARAMETER MAPPING**: `;
          for (const [key, values] of context.availableIds.entries()) {
            if (Array.isArray(values) && values.length > 0) {
              taskInstruction += `For ${key}, use: "${values[0]}". `;
            }
          }
        }
    }

    if (action.actionName.toLowerCase().includes('create')) {
        taskInstruction += `\n\nWhen you call the tool, provide a realistic 'title' for the document.`
    }
    
    const prompt = `${taskInstruction}

${contextualInfo}

Action Details:
- Model: ${action.modelName}
- Platform: ${action.connectionPlatform}
- API Path: ${action.path || 'N/A'}

You MUST call the Pica tool using this specific Action ID: **${action._id}**

Knowledge:
${action.knowledge}
`;
    return prompt;
  }
  
  private async analyzeExecutionResultWithLLM(
    outputText: string,
    toolResults: any[]
  ): Promise<{ success: boolean; reason: string }> {
    const systemPrompt = `You are a Triage Analyst. Your job is to determine if an action succeeded or failed based ONLY on the agent's final text output.

SUCCESS CRITERIA:
- The agent's text explicitly states success AND provides evidence, like a resource ID or the requested data.

FAILURE CRITERIA:
- The text indicates failure, an error, or an inability to perform the action.
- The text asks the user for information it should have had.

Respond ONLY with a raw JSON object with "success" (boolean) and "reason" (string) keys.`;

    const userPrompt = `Analyze this result:

### Agent's Final Text Output:
\`\`\`
${outputText || "No text output."}
\`\`\`
`;
    try {
      let { text } = await generateText({
        model: this.analysisModel,
        system: systemPrompt,
        prompt: userPrompt,
      });

      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        text = jsonMatch[1];
      }

      const jsonResponse = JSON.parse(text);
      if (typeof jsonResponse.success === 'boolean' && typeof jsonResponse.reason === 'string') {
        console.log(`ℹ️ LLM Analysis Result: Success=${jsonResponse.success}, Reason='${jsonResponse.reason}'`);
        return jsonResponse;
      }
      throw new Error("Invalid JSON structure from analysis model.");

    } catch (error) {
      console.error('Error during LLM-based result analysis:', error);
      const failureKeywords = ['fail', 'error', 'could not', 'unable to', 'provide the id', 'need the specific'];
      if(failureKeywords.some(kw => outputText.toLowerCase().includes(kw))) {
          return { success: false, reason: "Fallback: Detected failure keyword in output text." };
      }
      return { success: true, reason: "Fallback: No failure keywords detected in output text." };
    }
  }

  private async extractDataWithLLM(outputText: string, toolExecutionResults: any[]): Promise<ExtractedData> {
    const systemPrompt = `You are a highly precise data extraction engine. Your sole purpose is to extract structured data from an AI agent's output. The 'Tool Execution Results' will likely be empty; you MUST focus on the 'Agent's Final Text Output'.

    ### Rules of Extraction:
    1.  **Search the Text:** You MUST meticulously search the agent's text output for resource IDs. The ID might be in a sentence or inside a JSON code block.
    2.  **Extract All IDs:** Find any key that looks like an ID (e.g., "id", "_id", "documentId", "revisionId"). Create a descriptive key for it in the 'ids' object.
    3.  **Be Precise:** Do not guess or hallucinate data. If no ID is mentioned, return an empty object.

    **Example 1:**
    - Agent Text: "The new document ID is 1a2b3c-4d5e."
    - Your Output MUST be: \`{"ids": {"documentId": "1a2b3c-4d5e"}}\`
    
    **Example 2:**
    - Agent Text: "Success! Here is the JSON: \`\`\`json\n{"documentId": "xyz-789"}\`\`\`"
    - Your Output MUST be: \`{"ids": {"documentId": "xyz-789"}}\`

    You MUST return ONLY the raw JSON object that conforms to the schema.`;

    const userPrompt = `Extract structured data from the following execution logs:

### Agent's Final Text Output:
\`\`\`
${outputText || "No output."}
\`\`\`
`;
    try {
      const { object: extractedData } = await generateObject({
        model: this.analysisModel,
        schema: ExtractedDataSchema,
        prompt: userPrompt,
        system: systemPrompt,
      });

      console.log('✅ LLM Extracted Data:', JSON.stringify(extractedData, null, 2));
      return extractedData;

    } catch (error) {
      console.error('Error during LLM-based data extraction:', error);
      return { ids: {}, created_resources: {}, extracted_lists: {} };
    }
  }

  async executeTask(
    taskPrompt: string,
    threadId?: string
  ): Promise<{ success: boolean; output?: any; error?: string; extractedData?: any }> {
    try {
      const result = await this.agent.generate(taskPrompt, {
        threadId: threadId || `test-${Date.now()}`,
        resourceId: `resource-${Date.now()}`
      });
      console.log('Tool results:', JSON.stringify(result.toolResults, null, 2));
      console.log('Agent output:', result.text);

      const outputText = result.text || "";
      const toolResults = result.toolResults || [];

      const extractedData = await this.extractDataWithLLM(outputText, toolResults);
      const analysis = await this.analyzeExecutionResultWithLLM(outputText, toolResults);

      if (!analysis.success) {
        return {
          success: false,
          error: analysis.reason,
          output: outputText,
          extractedData
        };
      }
      
      const successfulOutput = outputText;

      return {
        success: true,
        output: successfulOutput,
        extractedData
      };

    } catch (error: any) {
      console.error('Error in EnhancedAgentService.executeTask:', error);
      return {
        success: false,
        error: error.message || "Unknown error during task execution"
      };
    }
  }
}