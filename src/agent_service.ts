import { Agent } from "@mastra/core/agent";
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { Pica } from '@picahq/ai';
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
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
  private useClaudeForAgent: boolean;

  constructor(
    picaSecretKey: string, 
    openAIApiKey: string,
    useClaudeForAgent: boolean = true
  ) {
    if (!picaSecretKey) {
      throw new Error("PICA_SECRET_KEY is required for EnhancedAgentService.");
    }
    if (!openAIApiKey && !process.env.ANTHROPIC_API_KEY) {
      console.warn("Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY provided; LLM interactions may fail.");
    }
    
    this.useClaudeForAgent = useClaudeForAgent && !!process.env.ANTHROPIC_API_KEY;
    
    this.analysisModel = this.useClaudeForAgent 
      ? anthropic("claude-sonnet-4-20250514")
      : openai("gpt-4.1");

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
    
    const agentModel = this.useClaudeForAgent 
      ? anthropic("claude-sonnet-4-20250514")
      : openai("gpt-4.1");
    
    this.agent = new Agent({
      name: "PicaTestingAgent",
      instructions: `${systemPrompt}

You are an intelligent API testing agent that executes actions across diverse platforms and models. Your core mission is to successfully execute the provided Pica tool action.

EXECUTION PRINCIPLES:
- ALWAYS call the Pica tool to execute the action - never simulate or describe
- Use available context data (IDs, resources) from previous actions automatically
- If an ID is needed and available in context, use it immediately without asking
- For create actions: generate realistic, human-like data appropriate to the platform
- For update/delete actions: verify the target resource exists first, create mock data if needed

CONTEXT UTILIZATION:
- The "Available Data" JSON contains IDs and resources from previous successful actions
- Map these contextual values to required parameters intelligently
- Example: if action needs 'documentId' and context has documentId: "abc123", use "abc123"

VERIFICATION PROTOCOL:
- Before modifying/deleting: verify the target exists via a get/list operation
- If target doesn't exist: create appropriate mock data first
- Then proceed with the original action

RESPONSE REQUIREMENTS:
- Always include the complete raw JSON output from the Pica tool in markdown code blocks
- If the tool creates a resource, ensure the full JSON (including IDs) is displayed
- Provide clear success/failure indication with specific details

You must adapt to any platform (Google, Microsoft, Slack, etc.) and any model (emails, documents, files, etc.) generically.`,
      model: agentModel,
      tools: { ...this.picaClient.oneTool },
      memory: this.memory,
    });
    
    console.log(`Agent initialized with ${this.useClaudeForAgent ? 'Claude 3.5 Sonnet' : 'GPT-4.1'}`);
  }

  private getVerificationSteps(
    action: Readonly<ModelDefinition>,
    context: ExecutionContext
  ): string | null {
    const actionName = action.actionName.toLowerCase();
    const needsId = action.path.includes('{{') && (!context.availableIds || context.availableIds.size === 0);
    
    if (needsId && (actionName.includes('get') || actionName.includes('update') || actionName.includes('delete'))) {
      return `Important: If you need an ID for this action but don't have one, please first create or list resources to get a valid ID, then proceed with the main task.`;
    }
    
    return null;
  }

  async generateTaskPrompt(
    action: Readonly<ModelDefinition>,
    context: ExecutionContext,
    history: Readonly<any[]>
  ): Promise<string> {
    
    const humanLikePrompt = this.buildHumanLikePrompt(action, context, history);
    
    const verificationSteps = this.getVerificationSteps(action, context);
    
    let finalPrompt = humanLikePrompt;

    if (verificationSteps) {
      finalPrompt += `\n\n${verificationSteps}`;
    }

    finalPrompt += `\n\n---\n### Knowledge\n${action.knowledge}`;
    
    finalPrompt += `\n\n### Final Instruction\nUse Action ID: ${action._id} to execute the task based on the Knowledge provided above.`;

    return finalPrompt;
  }

  private buildHumanLikePrompt(
    action: Readonly<ModelDefinition>,
    context: ExecutionContext,
    history: Readonly<any[]>
  ): string {
    
    let prompt = this.getConversationalOpener(action, context, history);
    
    if (context.availableIds && context.availableIds.size > 0) {
      prompt += this.buildContextualInstructions(action, context);
    } else {
      prompt += this.buildStandaloneInstructions(action);
    }
    
    prompt += this.getRealisticDataSuggestions(action);
    
    return prompt;
  }

  private getConversationalOpener(
    action: Readonly<ModelDefinition>,
    context: ExecutionContext,
    history: Readonly<any[]>
  ): string {
    const actionName = action.actionName.toLowerCase();
    const platform = action.connectionPlatform.replace('-', ' ');
    
    if (history.length > 0 && context.availableIds && context.availableIds.size > 0) {
      if (actionName.includes('create')) {
        return `Great! Now I need you to create a new ${action.modelName.toLowerCase()} in ${platform}. `;
      } else if (actionName.includes('get') || actionName.includes('retrieve')) {
        return `Perfect! Now let's retrieve the ${action.modelName.toLowerCase()} we just worked with. `;
      } else if (actionName.includes('update')) {
        return `Excellent! Now I'd like you to update the ${action.modelName.toLowerCase()} with some new information. `;
      } else if (actionName.includes('delete')) {
        return `Now let's clean up by deleting the ${action.modelName.toLowerCase()} we created. `;
      }
    }
    
    if (actionName.includes('create')) {
      return `Hi! I need you to create a new ${action.modelName.toLowerCase()} in ${platform}. `;
    } else if (actionName.includes('list')) {
      return `Hello! Can you show me all the ${action.modelName.toLowerCase()} available in ${platform}? `;
    } else {
      return `Hi! I need help with ${action.title.toLowerCase()} in ${platform}. `;
    }
  }

  private buildContextualInstructions(
    action: Readonly<ModelDefinition>,
    context: ExecutionContext
  ): string {
    let instructions = "";
    
    for (const [idType, values] of context.availableIds.entries()) {
      const idValues = Array.isArray(values) ? values : [values];
      if (idValues.length > 0 && action.path.includes(`{{${idType}}}`)) {
        instructions += `Use the ${idType} "${idValues[0]}" that we just worked with. `;
      }
    }
    
    const actionName = action.actionName.toLowerCase();
    if (actionName.includes('update') || actionName.includes('patch')) {
      instructions += `Please make a meaningful change - maybe add today's date or update some content to show the action worked. `;
    } else if (actionName.includes('get') || actionName.includes('retrieve')) {
      instructions += `Just fetch the current data so we can see what's there. `;
    }
    
    return instructions;
  }

  private buildStandaloneInstructions(action: Readonly<ModelDefinition>): string {
    const actionName = action.actionName.toLowerCase();
    
    if (actionName.includes('create')) {
      return `Please create it with some realistic sample data. Make it look professional and give it a meaningful name. `;
    } else if (actionName.includes('list')) {
      return `Just show me what's currently available. `;
    } else if (actionName.includes('get')) {
      return `If you need specific IDs, try to find or create a resource first, then retrieve it. `;
    }
    
    return `Please handle this request in the most logical way possible. `;
  }

  private getRealisticDataSuggestions(action: Readonly<ModelDefinition>): string {
    const actionName = action.actionName.toLowerCase();
    const model = action.modelName.toLowerCase();
    const platform = action.connectionPlatform.toLowerCase();
    
    if (!actionName.includes('create') && !actionName.includes('update')) {
      return "";
    }
    
    let suggestions = "Here are some realistic examples you could use: ";
    
    if (platform.includes('sheet') || platform.includes('excel')) {
      if (model.includes('spreadsheet')) {
        suggestions += `Title: "Monthly Sales Report - ${new Date().toLocaleDateString()}", `;
      } else if (model.includes('values')) {
        suggestions += `Data: Headers like "Name, Email, Department" with a few sample rows, `;
      }
    } else if (platform.includes('doc') || platform.includes('word')) {
      suggestions += `Title: "Project Planning Document - ${new Date().getFullYear()}", Content: "Meeting notes from today's discussion...", `;
    } else if (platform.includes('email') || platform.includes('gmail')) {
      suggestions += `Subject: "Test Email - ${new Date().toDateString()}", Body: "This is a test message sent via API", `;
    }
    
    return suggestions + "or something similar that makes sense for this context.";
  }
  
  private async analyzeExecutionResultWithLLM(
    outputText: string,
    toolResults: any[]
  ): Promise<{ success: boolean; reason: string }> {
    const systemPrompt = `You are a Triage Analyst. Your job is to determine if an action succeeded or failed based ONLY on the agent's final text output.

SUCCESS CRITERIA:
- The agent's text explicitly states success AND provides evidence, like a resource ID or the requested data.
- If JSON output is shown with resource IDs or successful response data, it's a success.

FAILURE CRITERIA:
- The text indicates failure, an error, or an inability to perform the action.
- The text asks the user for information it should have had.
- Error messages or failed API calls.

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
        console.log(`ℹ️ Analysis Result: Success=${jsonResponse.success}, Reason='${jsonResponse.reason}'`);
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
    2.  **Extract All IDs:** Find any key that looks like an ID (e.g., "id", "_id", "documentId", "revisionId", "spreadsheetId", "sheetId", "messageId"). Create a descriptive key for it in the 'ids' object.
    3.  **Look for JSON blocks:** Often the output contains JSON in code blocks with the created resource data.
    4.  **Be Precise:** Do not guess or hallucinate data. If no ID is mentioned, return an empty object.

    **Example 1:**
    - Agent Text: "The new document ID is 1a2b3c-4d5e."
    - Your Output MUST be: \`{"ids": {"documentId": "1a2b3c-4d5e"}}\`
    
    **Example 2:**
    - Agent Text: "Success! Here is the JSON: \`\`\`json\n{"documentId": "xyz-789", "revisionId": "rev-123"}\`\`\`"
    - Your Output MUST be: \`{"ids": {"documentId": "xyz-789", "revisionId": "rev-123"}}\`

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

      console.log('✅ Extracted Data:', JSON.stringify(extractedData, null, 2));
      return extractedData;

    } catch (error) {
      console.error('Error during LLM-based data extraction:', error);
      return { ids: {}, created_resources: {}, extracted_lists: {} };
    }
  }

  async executeTask(
    taskPrompt: string,
    threadId?: string
  ): Promise<{ success: boolean; output?: any; error?: string; extractedData?: any; analysisReason?: string }> {
    try {
      const result = await this.agent.generate(taskPrompt, {
        threadId: threadId || `test-${Date.now()}`,
        resourceId: `resource-${Date.now()}`
      });

      const outputText = result.text || "";
      const toolResults = result.toolResults || [];

      const extractedData = await this.extractDataWithLLM(outputText, toolResults);
      const analysis = await this.analyzeExecutionResultWithLLM(outputText, toolResults);

      if (!analysis.success) {
        return {
          success: false,
          error: analysis.reason,
          output: outputText,
          extractedData,
          analysisReason: analysis.reason 
        };
      }
      
      return {
        success: true,
        output: outputText,
        extractedData,
        analysisReason: analysis.reason 
      };

    } catch (error: any) {
      console.error('Error in EnhancedAgentService.executeTask:', error);
      return {
        success: false,
        error: error.message || "Unknown error during task execution",
        analysisReason: "Task execution failed with an exception." 
      };
    }
  }
}