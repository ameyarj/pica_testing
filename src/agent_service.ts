import { Agent } from "@mastra/core/agent";
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { Pica } from '@picahq/ai';
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, generateObject, LanguageModel } from "ai";
import { z } from 'zod';
import { ModelDefinition, ExecutionContext } from './interface';
import chalk from 'chalk';

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
  
  if (this.useClaudeForAgent) {
    try {
      this.analysisModel = anthropic("claude-sonnet-4-20250514");
    } catch (error) {
      console.warn("Failed to initialize Claude, falling back to GPT-4.1");
      this.analysisModel = openai("gpt-4.1");
      this.useClaudeForAgent = false;
    }
  } else {
    this.analysisModel = openai("gpt-4.1");
  }

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

  if (context.availableIds && context.availableIds.size > 0) {
    finalPrompt += "\n\n### 📋 Session Context (from previous actions):";
    for (const [idType, values] of context.availableIds.entries()) {
      const idValues = Array.isArray(values) ? values : [values];
      if (idValues.length > 0) {
        finalPrompt += `\n- ${idType}: "${idValues[0]}" (already created/available)`;
      }
    }
    
    const recentSuccesses = context.recentActions.filter(a => a.success).slice(-3);
    if (recentSuccesses.length > 0) {
      finalPrompt += "\n\n### Recent successful actions in this session:";
      recentSuccesses.forEach(action => {
        finalPrompt += `\n- ✓ ${action.actionTitle}`;
        if (action.output && typeof action.output === 'string' && action.output.includes('"id"')) {
          finalPrompt += " (created resource with ID)";
        }
      });
    }
  }

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
  const systemPrompt = `You are a highly precise data extraction engine. Your sole purpose is to extract structured data from an AI agent's output.

EXTRACTION RULES:
1. **Search aggressively**: Look for ANY mention of IDs in the text, including:
   - Sentences like "created with ID: xyz123" or "document ID is abc456"
   - JSON blocks with id fields
   - URLs containing IDs (e.g., /documents/123abc)
   - Any alphanumeric string that looks like an ID after words like: id, ID, documentId, spreadsheetId, fileId, etc.

2. **Common ID patterns to find**:
   - After "ID:", "id:", "ID is", "with ID"
   - Inside quotes after ID-related words
   - Long alphanumeric strings (10+ characters)
   - Strings matching patterns like: 1a2b3c4d5e6f or 123456789012

3. **Extract ALL variations**: If you see "documentId", "document ID", "doc ID" - they all go under "documentId"

4. **Be aggressive but accurate**: If it looks like an ID and is mentioned in context of creation/retrieval, extract it.

IMPORTANT: The agent often says things like "I created a document with ID: XYZ123" - you MUST extract "XYZ123" as the documentId.`;

  const userPrompt = `Extract ALL IDs and resources from this output:

${outputText}

Look for phrases like:
- "created ... with ID"
- "document ID is"
- "ID:"
- JSON blocks
- Any ID-like strings after creation/retrieval mentions`;

  try {
    const { object: extractedData } = await generateObject({
      model: this.analysisModel,
      schema: ExtractedDataSchema,
      prompt: userPrompt,
      system: systemPrompt,
    });

    if ((!extractedData.ids || Object.keys(extractedData.ids).length === 0) && outputText) {
      const manualIds: Record<string, string> = {};
      
      const patterns = [
        /(?:document\s*)?ID(?:\s*is)?:\s*["']?([a-zA-Z0-9_-]{10,})["']?/gi,
        /created.*?(?:with\s+)?ID:\s*["']?([a-zA-Z0-9_-]{10,})["']?/gi,
        /"(?:id|documentId|spreadsheetId|fileId|messageId)"\s*:\s*"([^"]+)"/gi,
        /(?:documentId|spreadsheetId|fileId)(?:\s+is)?\s*["']?([a-zA-Z0-9_-]{10,})["']?/gi
      ];
      
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(outputText)) !== null) {
          const id = match[1];
          if (id && id.length >= 10) {
            const lowerText = outputText.toLowerCase();
            if (lowerText.includes('document')) {
              manualIds.documentId = id;
            } else if (lowerText.includes('spreadsheet')) {
              manualIds.spreadsheetId = id;
            } else if (lowerText.includes('file')) {
              manualIds.fileId = id;
            } else {
              manualIds.id = id;
            }
          }
        }
      }
      
      if (Object.keys(manualIds).length > 0) {
        console.log('📍 Manual ID extraction found:', manualIds);
        extractedData.ids = { ...extractedData.ids, ...manualIds };
      }
    }

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
): Promise<{ success: boolean; output?: any; error?: string; extractedData?: any; analysisReason?: string; agentResponse?: string }> {
  try {
    // const knowledgeSeparator = '\n\n---\n';
    // const promptForDisplay = taskPrompt.split(knowledgeSeparator)[0];

    console.log(chalk.gray('\n📝 Prompt being sent to Agent (Knowledge hidden for brevity):'));
    console.log(chalk.gray('─'.repeat(80)));
    console.log(chalk.gray(taskPrompt));
    console.log(chalk.gray('\n[... Technical knowledge block hidden ...]'));
    console.log(chalk.gray('─'.repeat(80) + '\n'));
    
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
        analysisReason: analysis.reason,
        agentResponse: outputText 
      };
    }
    
    return {
      success: true,
      output: outputText,
      extractedData,
      analysisReason: analysis.reason,
      agentResponse: outputText 
    };

  } catch (error: any) {
    console.error('Error in EnhancedAgentService.executeTask:', error);
    return {
      success: false,
      error: error.message || "Unknown error during task execution",
      analysisReason: "Task execution failed with an exception." ,
      agentResponse: error.message
    };
  }
}
}