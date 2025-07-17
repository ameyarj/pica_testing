import { Agent } from "@mastra/core/agent";
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { Pica } from '@picahq/ai';
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, generateObject, LanguageModel } from "ai";
import { z } from 'zod';
import { ModelDefinition, ExecutionContext, ExtractedDataEnhanced } from './interfaces/interface';
import { PathParameterResolver } from './path_resolver';
import { EnhancedModelSelector } from './enhanced_model_selector';
import { ExecutionLogger } from './execution_logger';
import { ConversationHandler } from './conversation_handler';
import { tokenTracker } from './global_token_tracker';
import { initializeModel } from './utils/modelInitializer';
import { extractResourceFromTitle } from './utils/resourceExtractor';
import { trackLLMCall } from './utils/tokenTrackerUtils';
import { extractParametersFromPath } from './utils/pathUtils';
import { RateLimitManager } from './rate_limit_manager';
import chalk from 'chalk';

const ExtractedDataSchema = z.object({
    ids: z.record(z.string())
        .describe("A dictionary of extracted IDs. The key should be a descriptive name (e.g., 'documentId', 'revisionId') and the value is the ID string.")
        .default({}),
    names: z.record(z.string())
        .describe("A dictionary of extracted names. The key should match the ID key (e.g., 'documentName' for 'documentId')")
        .default({}),
    emails: z.array(z.string())
        .describe("Array of any email addresses found in the response")
        .default([]),
    phones: z.array(z.string())
        .describe("Array of any phone numbers found in the response")
        .default([]),
    created_resources: z.record(z.object({}).passthrough())
        .describe("A dictionary to hold entire JSON objects of newly created resources, keyed by a descriptive name like 'created_document'.")
        .default({}),
    extracted_lists: z.record(z.array(z.unknown()))
        .describe("A dictionary for any arrays or lists of items returned, keyed by a descriptive name like 'document_list'.")
        .default({}),
    metadata: z.record(z.any())
        .describe("Any additional metadata or context from the response")
        .default({})
}).default({
    ids: {},
    names: {},
    emails: [],
    phones: [],
    created_resources: {},
    extracted_lists: {},
    metadata: {}
});

type ExtractedData = z.infer<typeof ExtractedDataSchema>;


export class EnhancedAgentService {
  private picaClient: Pica;
  private agent!: Agent;
  private memory: Memory;
  private analysisModel: LanguageModel;
  private useClaudeForAgent: boolean;
  private logger?: ExecutionLogger;
  private conversationHandler: ConversationHandler;
  private rateLimitManager: RateLimitManager;

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
  
  this.analysisModel = initializeModel(this.useClaudeForAgent, 'agent-service-analysis');

  this.picaClient = new Pica(picaSecretKey, {
    connectors: ["*"],
    serverUrl: "https://development-api.picaos.com",
  });

  this.memory = new Memory({
    storage: new LibSQLStore({
      url: 'file::memory:',
    }),
  });

  this.conversationHandler = new ConversationHandler();
  this.rateLimitManager = new RateLimitManager();
  this.initializeAgent(openAIApiKey);
}

setLogger(logger: ExecutionLogger): void {
  this.logger = logger;
}

  private async initializeAgent(openAIApiKey: string) {
    const systemPrompt = await this.picaClient.generateSystemPrompt();
    
    const agentModel = initializeModel(this.useClaudeForAgent, 'agent-service');
    
    this.agent = new Agent({
      name: "PicaTestingAgent",
      instructions: `${systemPrompt}

You are an intelligent API testing agent that executes actions across diverse platforms and models. Your core mission is to successfully execute the provided Pica tool action.

🚨 CRITICAL PLATFORM SELECTION RULE:
- ALWAYS use the platform explicitly mentioned in the user's prompt
- If the user says "Show me my Ably Control API token", use ONLY Ably Control, never GitHub, Gmail, or other platforms
- If the user says "Create a document in Google Drive", use ONLY Google Drive
- If the user says "Send an email using Gmail", use ONLY Gmail, never Outlook
- When multiple platforms are available, the platform mentioned in the prompt takes absolute priority
- If no platform is specified, ask for clarification rather than guessing

EXECUTION PRINCIPLES:
- ALWAYS call the Pica tool to execute the action - never simulate or describe
- Use available context data (IDs, resources) from previous actions automatically
- When you encounter missing parameters, use reasonable defaults:
  - For userId/userEmail: Use test values like "connectors@picaos.com" 
  - For DateTime: Use current date/time in ISO format (e.g., new Date().toISOString())
  - For names/titles: Generate realistic test data
- If an ID is needed and available in context, use it immediately without asking
- For create actions: generate realistic, human-like data appropriate to the platform
- For update/delete actions: verify the target resource exists first, create mock data if needed
- NEVER stop at planning or analysis - always proceed to execution

🚨 CRITICAL TOOL EXECUTION RULE:
- You must ALWAYS make actual Pica tool call and WAIT for complete response
- Do not respond until the Pica tool has fully executed and returned complete results
- If tool execution seems incomplete, wait longer or retry the tool call
- Never provide partial responses - always ensure tool execution is complete
- The tool response must contain "START" and "END" markers - verify these are present
- Only after receiving complete tool results should you format and present your response

CONTEXT UTILIZATION:
- The "Available Data" JSON contains IDs and resources from previous successful actions
- Map these contextual values to required parameters intelligently
- Example: if action needs 'documentId' and context has documentId: "abc123", use "abc123"
- If pica tool tells that to execute the action it needs some data, ask it to how to obtain tha data if not available in context
- If you need to create a resource, use the "Create" action first, then use the created data in subsequent actions

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
  
  const { resolvedPath, missingParams } = PathParameterResolver.resolvePath(
    action.path, 
    context, 
    context.availableIds ? Object.fromEntries(context.availableIds) : undefined
  );
  
  const humanLikePrompt = this.buildHumanLikePrompt(action, context, history);
  const verificationSteps = this.getVerificationSteps(action, context);
  
  let finalPrompt = humanLikePrompt;

  if (action.path && (action.path.includes('{{') || action.path.includes(':'))) {
    const requiredParams = extractParametersFromPath(action.path);
    
    if (requiredParams.length > 0) {
      finalPrompt += "\n\n⚠️ CRITICAL URL PARAMETERS NEEDED:\n";
      requiredParams.forEach(param => {
        if (context.availableIds?.has(param)) {
          const value = context.availableIds.get(param)![0];
          finalPrompt += `• ${param}: "${value}" ✓ (USE THIS VALUE)\n`;
        } else {
          finalPrompt += `• ${param}: ❌ MISSING - You need to create/find this first\n`;
          finalPrompt += `  Hint: Look for a "Create ${param.replace(/Id$/, '')}" or "List" action\n`;
        }
      });
    }
  }

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

  if (missingParams.length > 0) {
    finalPrompt += `\n\n⚠️ MISSING PATH PARAMETERS: ${missingParams.join(', ')}`;
    finalPrompt += `\nYou may need to create or find these resources first.`;
  } else if (resolvedPath !== action.path) {
    finalPrompt += `\n\n✅ PATH RESOLVED: Using ${resolvedPath}`;
  }

  if (verificationSteps) {
    finalPrompt += `\n\n${verificationSteps}`;
  }

  let updatedKnowledge = action.knowledge;
  if (resolvedPath !== action.path) {
    updatedKnowledge = updatedKnowledge.replace(action.path, resolvedPath);
  }

  finalPrompt += `\n\n---\n### Knowledge\n${updatedKnowledge}`;
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
      const nameMapping = new Map<string, string>();
      
      for (const [idType, idValues] of context.availableIds.entries()) {
        const nameKey = idType.replace('Id', 'Name');
        if (context.createdResources.has(nameKey)) {
          const names = context.createdResources.get(nameKey);
          if (Array.isArray(names) && names.length > 0) {
            nameMapping.set(idType, names[0]);
          }
        }
      }
      
      if (nameMapping.size > 0) {
        prompt += "\nI'll work with ";
        const nameEntries = Array.from(nameMapping.entries());
        nameEntries.forEach(([idType, name], index) => {
          prompt += `"${name}"`;
          if (index < nameEntries.length - 1) prompt += ", ";
        });
        prompt += ". ";
      }
    }
    
    return prompt;
  }

  private getConversationalOpener(
    action: Readonly<ModelDefinition>,
    context: ExecutionContext,
    history: Readonly<any[]>
  ): string {
    const actionName = action.actionName.toLowerCase();
    const platform = action.connectionPlatform.replace('-', ' ');
    
    const resourceName = extractResourceFromTitle(action.title);
    
    if (history.length > 0 && context.availableIds && context.availableIds.size > 0) {
      if (actionName.includes('create')) {
        return `Great! Now I need you to create a new ${resourceName} in ${platform}. `;
      } else if (actionName.includes('get') || actionName.includes('retrieve')) {
        return `Perfect! Now let's retrieve the ${resourceName} we just worked with. `;
      } else if (actionName.includes('update')) {
        return `Excellent! Now I'd like you to update the ${resourceName} with some new information. `;
      } else if (actionName.includes('delete')) {
        return `Now let's clean up by deleting the ${resourceName} we created. `;
      }
    }
    
    if (actionName.includes('create')) {
      return `Hi! I need you to create a new ${resourceName} in ${platform}. `;
    } else if (actionName.includes('list')) {
      return `Hello! Can you show me all the ${resourceName} available in ${platform}? `;
    } else {
      return `Hi! I need help with ${action.title.toLowerCase()} in ${platform}. `;
    }
  }

  
  private async analyzeExecutionResultWithLLM(
    outputText: string,
    toolResults: any[]
  ): Promise<{ success: boolean; reason: string; isPermissionError?: boolean }> {
    const inputLength = outputText.length + 2000; 
    const modelToUse = EnhancedModelSelector.selectModel('analysis', inputLength, this.useClaudeForAgent);
    
    const model = modelToUse === 'claude-sonnet-4-20250514' ? 
      anthropic("claude-sonnet-4-20250514") : 
      openai(modelToUse);

    const systemPrompt = `You are a Triage Analyst. Your job is to determine if an action succeeded or failed based ONLY on the agent's final text output.

SUCCESS CRITERIA:
- The agent's text explicitly states success AND provides evidence, like a resource ID or the requested data
- If JSON output is shown with resource IDs or successful response data, it's a success
- 2xx status codes in API responses

FAILURE CRITERIA:
- The text indicates failure, an error, or an inability to perform the action
- The text asks the user for information it should have had
- Error messages or failed API calls
- 4xx or 5xx status codes
- URL construction errors (404 with malformed URLs)

SPECIAL CASES:
- 404 errors with URLs containing ':parameter' or unresolved placeholders = parameter substitution failure
- Rate limit errors = temporary failure, suggest retry
- Missing required fields = prompt needs more context

Respond ONLY with a raw JSON object with "success" (boolean) and "reason" (string) keys.`;

    const userPrompt = `Analyze this result:

### Agent's Final Text Output:
\`\`\`
${outputText || "No text output."}
\`\`\`
`;
    try {
      const text = await trackLLMCall(
      modelToUse,
      systemPrompt,
      userPrompt,
      'agent-service',
      'analyze-execution-result',
      async () => {
        const result = await generateText({
          model,
          system: systemPrompt,
          prompt: userPrompt,
        });
        return { result: result.text, outputText: result.text };
      }
    );

      let jsonString = text;
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        jsonString = jsonMatch[1];
      }

      const jsonResponse = JSON.parse(jsonString);
      if (typeof jsonResponse.success === 'boolean' && typeof jsonResponse.reason === 'string') {
        const isPermissionError = outputText.toLowerCase().includes('403') && 
          (outputText.toLowerCase().includes('permission') || 
           outputText.toLowerCase().includes('scope') ||
           outputText.toLowerCase().includes('authentication') ||
           outputText.toLowerCase().includes('forbidden'));
        
        return {
          ...jsonResponse,
          isPermissionError
        };
      }
      throw new Error("Invalid JSON structure from analysis model.");

    } catch (error) {
      const failureKeywords = ['fail', 'error', 'could not', 'unable to', 'provide the id', 'need the specific'];
      const isError = failureKeywords.some(kw => outputText.toLowerCase().includes(kw));
      
      const isPermissionError = outputText.toLowerCase().includes('403') && 
        (outputText.toLowerCase().includes('permission') || 
         outputText.toLowerCase().includes('scope') ||
         outputText.toLowerCase().includes('authentication') ||
         outputText.toLowerCase().includes('forbidden'));
      
      return {
        success: !isError,
        reason: isError ? "Fallback: Detected failure keyword in output text." : "Fallback: No failure keywords detected in output text.",
        isPermissionError
      };
    }
  }

  private async extractDataWithLLM(outputText: string, toolExecutionResults: any[]): Promise<ExtractedData> {
    const inputLength = outputText.length + 3000;
    const modelToUse = EnhancedModelSelector.selectModel('extraction', inputLength, this.useClaudeForAgent);
    
    const model = modelToUse === 'claude-sonnet-4-20250514' ? 
      anthropic("claude-sonnet-4-20250514") : 
      modelToUse === 'gpt-4o' ? openai("gpt-4o") : openai("gpt-4.1");

    const systemPrompt = `You are a comprehensive data extraction engine. Extract ALL meaningful data from any platform's API responses.

    EXTRACTION PRIORITIES (in order):
    1. **NAMES/TITLES**: Any human-readable names, titles, labels, subjects
    2. **IDs/TOKENS**: Technical identifiers, keys, tokens, and reference numbers
    3. **OTHER DATA**: Emails, phones, URLs, metadata

    UNIVERSAL PATTERNS TO FIND:
    - **Platform IDs**: cloudId, accountId, workspaceId, organizationId, teamId, userId, projectId
    - **Resource IDs**: documentId, fileId, folderId, issueId, taskId, channelId, repositoryId
    - **Authentication**: apiKey, accessToken, authToken, sessionId, clientId
    - **Names/Titles**: title, name, subject, summary, label, displayName, description
    - **Contact Info**: emails, phone numbers, usernames
    - **URLs/Links**: webhookUrl, apiUrl, downloadUrl, shareUrl

    SMART KEY INFERENCE:
    - Match context clues: "Jira Cloud ID" → jiraCloudId, "GitHub Token" → githubToken
    - Generic fallbacks: unknown IDs → "id", unknown names → "name"
    - Platform-specific: mention of platform → platformId (e.g., "slack" → slackId)
    - Resource-specific: mention of resource → resourceId (e.g., "document" → documentId)

    EXTRACTION RULES:
    - Extract IDs from any format: JSON, natural language, backticks, quotes
    - Handle phrases like "I have the X ID: Y", "Found X: Y", "X is: Y"
    - Look for UUIDs, alphanumeric codes, tokens (8+ chars typically)
    - Extract names from titles, subjects, labels, displayNames
    - Capture emails and phones when present
    - Store metadata for dates, status, types, counts

    Be thorough and adapt to any platform (Google, Microsoft, Slack, GitHub, Jira, etc.).`;

    const userPrompt = `Extract ALL meaningful data from this output. Focus on finding:

    1. NAMES/TITLES (highest priority): Any human-readable identifiers
    2. IDs: Technical identifiers  
    3. OTHER: Emails, phones, metadata

    Response to analyze:
    ${outputText}

    Look for names in fields like: title, name, subject, summary, displayName, label, etc.
    Extract IDs from fields like: id, eventId, documentId, fileId, etc.
    
    IMPORTANT: If you see JSON with a "title" field, extract it as documentName/spreadsheetName/etc based on context.
    If you see "name" fields, extract them with appropriate keys.
    Extract ANY email addresses you find into the emails array.
    Extract ANY phone numbers you find into the phones array.
    Put any other useful data (dates, status, type, etc.) into metadata.`;

    try {
      const inputTokens = tokenTracker.estimateTokens(systemPrompt + userPrompt);
      
      const { object: extractedData } = await generateObject({
        model,
        schema: ExtractedDataSchema,
        prompt: userPrompt,
        system: systemPrompt,
      });
      
      const outputTokens = tokenTracker.estimateTokens(JSON.stringify(extractedData));
      tokenTracker.trackUsage(
        modelToUse,
        inputTokens,
        outputTokens,
        'agent-service',
        'extract-data'
      );

      if ((!extractedData.ids || Object.keys(extractedData.ids).length === 0) && outputText) {
        const manualData = this.manualExtraction(outputText);
        extractedData.ids = { ...extractedData.ids, ...manualData.ids };
        extractedData.names = { ...extractedData.names, ...manualData.names };
      }

      return extractedData;

    } catch (error) {
      return { ids: {}, names: {}, emails: [], phones: [], created_resources: {}, extracted_lists: {}, metadata: {} };
    }
  }

  private manualExtraction(text: string): { ids: Record<string, string>; names: Record<string, string> } {
    const ids: Record<string, string> = {};
    const names: Record<string, string> = {};
    
    const idPatterns = [
      /(?:^|[^\w])([a-zA-Z0-9_-]{8,})\s*`([a-zA-Z0-9_-]{8,})`/gi,
      /`([a-zA-Z0-9_-]{10,})`/gi,
      
      /(?:I have|found|retrieved|got|obtained)\s+(?:the\s+)?(?:(\w+(?:\s+\w+)*)\s+)?(?:ID|id|Id):\s*["'`]?([a-zA-Z0-9_-]{8,})["'`]?/gi,
      /(?:(\w+(?:\s+\w+)*)\s+)?(?:ID|id|Id)(?:\s*is)?:\s*["'`]?([a-zA-Z0-9_-]{8,})["'`]?/gi,
      
      /"(\w*[iI]d\w*)"\s*:\s*"([a-zA-Z0-9_-]{8,})"/gi,
      /"id"\s*:\s*"([a-zA-Z0-9_-]{8,})"/gi,
      
      /(\w+(?:\s+\w+)*)\s*(?:ID|id|Id|Token|Key|Code)\s*:\s*["'`]?([a-zA-Z0-9_-]{8,})["'`]?/gi,
      
      /(?:^|[^\w])ID(?:\s*is)?:\s*["'`]?([a-zA-Z0-9_-]{10,})["'`]?/gi,
    ];
    
    const namePatterns = [
      /(?:created|found|retrieved|named|called)\s+(?:.*?\s+)?["'`]([^"'`]{3,})["'`]/gi,
      /(?:title|name|label|subject|displayName)(?:\s*is)?:\s*["'`]([^"'`]{3,})["'`]/gi,
      /"(?:title|name|label|subject|displayName|.*Name)"\s*:\s*"([^"]{3,})"/gi,
      /name:\s*["']([^"']{3,})["']/gi,
    ];
    
    for (const pattern of idPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        let idKey = 'id';
        let idValue = '';
        
        if (match.length === 3 && match[1] && match[2]) {
          const keyPart = match[1].toLowerCase().trim();
          idValue = match[2];
          
          if (keyPart.includes('cloud')) idKey = keyPart.replace(/\s+/g, '') + 'Id';
          else if (keyPart.includes('account')) idKey = 'accountId';
          else if (keyPart.includes('user')) idKey = 'userId';
          else if (keyPart.includes('project')) idKey = 'projectId';
          else if (keyPart.includes('workspace')) idKey = 'workspaceId';
          else if (keyPart.includes('organization')) idKey = 'organizationId';
          else if (keyPart.includes('team')) idKey = 'teamId';
          else if (keyPart.includes('api')) idKey = 'apiKey';
          else if (keyPart.includes('access')) idKey = 'accessToken';
          else if (keyPart.includes('auth')) idKey = 'authToken';
          else if (keyPart) idKey = keyPart.replace(/\s+/g, '') + 'Id';
        } else if (match[1]) {
          idValue = match[1];
        }
        
        if (idValue && idValue.length >= 8) {
          ids[idKey] = idValue;
          console.log(`[Manual Extraction] Found ID: ${idKey} = ${idValue}`);
        }
      }
    }
    
    for (const pattern of namePatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1];
        if (name && name.trim() && name.length >= 3) {
          let nameKey = 'name';
          
          const lowerText = text.toLowerCase();
          if (lowerText.includes('document')) nameKey = 'documentName';
          else if (lowerText.includes('spreadsheet')) nameKey = 'spreadsheetName';
          else if (lowerText.includes('file')) nameKey = 'fileName';
          else if (lowerText.includes('project')) nameKey = 'projectName';
          else if (lowerText.includes('workspace')) nameKey = 'workspaceName';
          else if (lowerText.includes('repository')) nameKey = 'repositoryName';
          else if (lowerText.includes('folder')) nameKey = 'folderName';
          else if (lowerText.includes('event')) nameKey = 'eventName';
          else if (lowerText.includes('calendar')) nameKey = 'calendarName';
          else if (lowerText.includes('task')) nameKey = 'taskName';
          else if (lowerText.includes('issue')) nameKey = 'issueName';
          
          names[nameKey] = name.trim();
          console.log(`[Manual Extraction] Found name: ${nameKey} = ${name.trim()}`);
        }
      }
    }
    
    return { ids, names };
  }
  
  async handleRateLimitIfNeeded(
    error: string, 
    output: string, 
    action?: ModelDefinition
  ): Promise<'retry' | 'abort' | null> {
    if (!this.rateLimitManager.isRateLimitError(error, output)) {
      return null; 
    }

    const platform = action?.connectionPlatform || 'Unknown Platform';
    console.log(chalk.red(`   🚨 Rate limit detected for ${platform}`));
    
    const decision = await this.rateLimitManager.handleRateLimit(
      platform,
      error,
      output,
      action?.path
    );
    
    return decision;
  }

  close(): void {
    this.rateLimitManager.close();
  }
  async executeSmartTask(
    taskPrompt: string,
    threadId?: string,
    action?: ModelDefinition,
    context?: ExecutionContext,
    attemptNumber: number = 1,
    strategy?: string
  ): Promise<{ success: boolean; output?: any; error?: string; extractedData?: any; analysisReason?: string; agentResponse?: string; isPermissionError?: boolean; conversationTurns?: number; isRateLimitError?: boolean }> {
    const startTime = Date.now();
    console.log(chalk.blue('   🚀 Starting unified smart execution...'));
    
    let conversationState = this.conversationHandler.createInitialState();
    let currentPrompt = taskPrompt;
    let lastResult: any = null;
    let extractedDataAccumulated: any = {};
    
    const conversationThreadId = threadId || `conv-${Date.now()}`;
    
    conversationState = this.conversationHandler.addTurn(conversationState, 'user', currentPrompt);
    
    while (!this.conversationHandler.isConversationComplete([], conversationState)) {
      console.log(chalk.gray(`   📨 Turn ${conversationState.turnCount + 1}/3...`));
      
      try {
        const result = await this.agent.generate(currentPrompt, {
          threadId: conversationThreadId,
          resourceId: action?._id || `resource-${Date.now()}`
        });
        
        const outputText = result.text || "";
        const toolResults = result.toolResults || [];
        
        const patterns = this.conversationHandler.detectResponsePatterns(outputText);
        
        conversationState = this.conversationHandler.addTurn(
          conversationState, 
          'assistant', 
          outputText, 
          patterns
        );
        
        const turnExtractedData = await this.extractDataWithLLM(outputText, toolResults);
        
        if (turnExtractedData) {
          extractedDataAccumulated = {
            ids: { ...extractedDataAccumulated.ids, ...turnExtractedData.ids },
            names: { ...extractedDataAccumulated.names, ...turnExtractedData.names },
            emails: [...(extractedDataAccumulated.emails || []), ...(turnExtractedData.emails || [])],
            phones: [...(extractedDataAccumulated.phones || []), ...(turnExtractedData.phones || [])],
            created_resources: { ...extractedDataAccumulated.created_resources, ...turnExtractedData.created_resources },
            extracted_lists: { ...extractedDataAccumulated.extracted_lists, ...turnExtractedData.extracted_lists },
            metadata: { ...extractedDataAccumulated.metadata, ...turnExtractedData.metadata }
          };
        }
        
        if (patterns.length > 0) {
          console.log(chalk.cyan(`   🎯 Detected patterns: ${patterns.map(p => p.type).join(', ')}`));
        }
        
        if (this.conversationHandler.isConversationComplete(patterns, conversationState)) {
          console.log(chalk.green('   ✅ Conversation complete!'));
          lastResult = result;
          break;
        }
        
        const followUpPrompt = this.conversationHandler.generateFollowUpPrompt(
          patterns, 
          conversationState, 
          taskPrompt
        );
        
        if (!followUpPrompt) {
          console.log(chalk.yellow('   ⚠️ No follow-up prompt generated, ending conversation'));
          lastResult = result;
          break;
        }
        
        console.log(chalk.blue(`   💬 Follow-up: "${followUpPrompt.substring(0, 100)}..."`));
        
        conversationState = this.conversationHandler.addTurn(conversationState, 'user', followUpPrompt);
        currentPrompt = followUpPrompt;
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error: any) {
        console.error(chalk.red('   ❌ Error in conversation turn:'), error.message);
        conversationState.lastError = error.message;
        break;
      }
    }
    
    const finalResult = this.conversationHandler.extractFinalResult(conversationState);
    
    let analysis: { success: boolean; reason: string; isPermissionError?: boolean } = { 
      success: false, 
      reason: 'No result obtained' 
    };
    if (finalResult.output) {
      analysis = await this.analyzeExecutionResultWithLLM(finalResult.output, []);
    }
    
    if (action && this.logger && finalResult.output) {
      const allPrompts = conversationState.turns
        .filter(t => t.role === 'user')
        .map(t => t.content)
        .join('\n\n---\n\n');
      
      const inputTokens = this.logger.estimateTokens(allPrompts);
      const outputTokens = this.logger.estimateTokens(finalResult.output);
      
        this.logger.logExecution({
          platform: action.connectionPlatform,
          model: action.modelName,
          action: action.actionName,
          actionId: action._id,
          attempt: 1,
          prompt: {
            strategy: strategy || 'conversational',
            length: allPrompts.length,
            content: taskPrompt.substring(0, 200) + '...'
          },
        response: {
          success: analysis.success,
          error: analysis.success ? undefined : analysis.reason,
          extractedData: extractedDataAccumulated as ExtractedDataEnhanced,
          agentOutput: finalResult.output.substring(0, 1000),
          analysisReason: analysis.reason
        },
        tokens: {
          model: this.useClaudeForAgent ? 'claude-sonnet-4-20250514' : 'gpt-4.1',
          input: inputTokens,
          output: outputTokens,
          cost: this.logger.calculateCost(
            this.useClaudeForAgent ? 'claude-sonnet-4-20250514' : 'gpt-4.1',
            inputTokens,
            outputTokens
          )
        },
        duration: Date.now() - startTime
      });
    }
    
    const finalSuccess = analysis.success || (finalResult.success && !analysis.reason.includes('fail'));
    
    return {
      success: finalSuccess,
      output: finalResult.output,
      error: !finalSuccess ? (finalResult.error || analysis.reason) : undefined,
      extractedData: extractedDataAccumulated,
      analysisReason: analysis.reason,
      agentResponse: finalResult.output,
      isPermissionError: analysis.isPermissionError,
      conversationTurns: conversationState.turnCount
    };
  }
  async executeTask(
    taskPrompt: string,
    threadId?: string,
    action?: ModelDefinition,
    attemptNumber: number = 1,
    strategy?: string
  ): Promise<{ success: boolean; output?: any; error?: string; extractedData?: any; analysisReason?: string; agentResponse?: string; isPermissionError?: boolean }> {
    const startTime = Date.now();
    const knowledgeSeparator = '\n\n---\n';
    const promptForDisplay = taskPrompt.split(knowledgeSeparator)[0];

    try {
      const result = await this.agent.generate(taskPrompt, {
        threadId: threadId || `test-${Date.now()}`,
        resourceId: `resource-${Date.now()}`
      });
      const outputText = result.text || "";
      const toolResults = result.toolResults || [];

      const extractedData = await this.extractDataWithLLM(outputText, toolResults);
      const analysis = await this.analyzeExecutionResultWithLLM(outputText, toolResults);

      if (action && this.logger) {
        const inputTokens = this.logger.estimateTokens(taskPrompt);
        const outputTokens = this.logger.estimateTokens(outputText);
        
        this.logger.logExecution({
          platform: action.connectionPlatform,
          model: action.modelName,
          action: action.actionName,
          actionId: action._id,
          attempt: attemptNumber,
          prompt: {
            strategy: strategy || 'conversational',
            length: taskPrompt.length,
            content: promptForDisplay
          },
          response: {
            success: analysis.success,
            error: analysis.success ? undefined : analysis.reason,
            extractedData: extractedData as ExtractedDataEnhanced,
            agentOutput: outputText.substring(0, 1000), 
            analysisReason: analysis.reason
          },
          tokens: {
            model: this.useClaudeForAgent ? 'claude-sonnet-4-20250514' : 'gpt-4.1',
            input: inputTokens,
            output: outputTokens,
            cost: this.logger.calculateCost(
              this.useClaudeForAgent ? 'claude-sonnet-4-20250514' : 'gpt-4.1',
              inputTokens,
              outputTokens
            )
          },
          duration: Date.now() - startTime
        });
      }

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
        agentResponse: outputText,
        isPermissionError: analysis.isPermissionError 
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message || "Unknown error during task execution",
        analysisReason: "Task execution failed with an exception.",
        agentResponse: error.message
      };
    }
  }
}
