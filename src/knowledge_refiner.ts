import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, generateObject, LanguageModel } from "ai";
import { z } from 'zod';
import { ModelDefinition, ExecutionContext } from './interface';
import { EnhancedModelSelector } from './enhanced_model_selector';

const RefinementSchema = z.object({
  knowledge: z.string().nullable().describe("Updated knowledge text, or null if no changes needed"),
  promptStrategy: z.string().nullable().describe("New prompting approach suggestion, or null if no changes needed"),
  contextMapping: z.record(z.string()).optional().describe("Explicit mapping of context IDs to parameters"),
  additionalSteps: z.array(z.string()).optional().describe("Additional verification or preparation steps")
});

export class KnowledgeRefiner {
  private llmModel: LanguageModel;
  private useClaudeForRefinement: boolean;

  constructor(openAIApiKey: string, useClaudeForRefinement: boolean = true) {
  if (!openAIApiKey && !process.env.ANTHROPIC_API_KEY) {
    console.warn("Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY provided; KnowledgeRefiner may fail.");
  }
  
  this.useClaudeForRefinement = useClaudeForRefinement && !!process.env.ANTHROPIC_API_KEY;
  
  if (this.useClaudeForRefinement) {
    try {
      this.llmModel = anthropic("claude-sonnet-4-20250514");
    } catch (error) {
      console.warn("Failed to initialize Claude for refinement, falling back to GPT-4.1");
      this.llmModel = openai("gpt-4.1");
      this.useClaudeForRefinement = false;
    }
  } else {
    this.llmModel = openai("gpt-4.1");
  }
}

private async analyzeAgentResponse(
  agentResponse: string,
  action: ModelDefinition,
  context?: ExecutionContext
): Promise<{
  missingParams: string[];
  requestedFromUser: string[];
  shouldHaveUsedFromContext: Record<string, string>;
}> {
  const systemPrompt = `Analyze this agent response to identify what went wrong with the prompt.

ANALYSIS GOALS:
1. Identify parameters the agent asked the user for (like "please provide X")
2. Check if those parameters were available in context
3. Identify what the agent tried to do vs what it should have done
4. Extract any specific IDs or values the agent mentioned needing

BE VERY SPECIFIC about parameter names and values.`;

  const contextInfo = this.buildDetailedContextInfo(context);
  
  const userPrompt = `Agent Response:
${agentResponse}

Action Path: ${action.path}
Available Context:
${contextInfo}

Identify:
1. What parameters did the agent ask for?
2. Which of those were already available in context?
3. What specific values should have been used?`;

  try {
    const { text } = await generateText({
      model: this.llmModel,
      system: systemPrompt,
      prompt: userPrompt,
    });

    const missingParams: string[] = [];
    const requestedFromUser: string[] = [];
    const shouldHaveUsedFromContext: Record<string, string> = {};

    const requestPatterns = [
      /(?:provide|specify|need|require|missing)\s+(?:the\s+)?(\w+)/gi,
      /what\s+is\s+(?:the\s+)?(\w+)/gi,
      /please\s+(?:provide|specify)\s+(?:the\s+)?(\w+)/gi
    ];

    for (const pattern of requestPatterns) {
      let match;
      while ((match = pattern.exec(agentResponse)) !== null) {
        requestedFromUser.push(match[1]);
      }
    }

    if (context?.availableIds) {
      for (const requested of requestedFromUser) {
        if (context.availableIds.has(requested)) {
          const value = context.availableIds.get(requested)![0];
          shouldHaveUsedFromContext[requested] = value;
        }
      }
    }

    const pathParams = action.path.match(/\{\{(\w+)\}\}/g) || [];
    for (const param of pathParams) {
      const paramName = param.replace(/[{}]/g, '');
      if (!context?.availableIds?.has(paramName)) {
        missingParams.push(paramName);
      }
    }

    return {
      missingParams,
      requestedFromUser: [...new Set(requestedFromUser)],
      shouldHaveUsedFromContext
    };
  } catch (error) {
    console.error('Error analyzing agent response:', error);
    return {
      missingParams: [],
      requestedFromUser: [],
      shouldHaveUsedFromContext: {}
    };
  }
}

  async refineKnowledge(
  originalKnowledge: string,
  errorMessage: string,
  actionDetails: Readonly<ModelDefinition>,
  context?: ExecutionContext,
  failedPrompt?: string,
  agentResponse?: string  
): Promise<{ knowledge?: string; promptStrategy?: string; contextMapping?: Record<string, string> }> {
  try {
    let responseAnalysis = null;
    if (agentResponse) {
      responseAnalysis = await this.analyzeAgentResponse(agentResponse, actionDetails, context);
    }

    const systemPrompt = `You are an expert at fixing API action failures. You analyze errors and agent responses to provide fixes for both the knowledge AND the prompting strategy.

ANALYSIS FOCUS:
1. **Agent Behavior**: If the agent asked for parameters that were in context, the prompt needs to be more explicit or say the agent to exceute the action by making  data itself that is required to execute the action and then exceute
2. **Missing Context Usage**: If error mentions "missing" but context has that data, make the prompt emphasize using context
3. **Parameter Clarity**: If agent misunderstood what parameters to use, clarify in both knowledge and prompt
4. **Response Analysis**: Use the agent's actual response to understand what went wrong
5. **
PROMPT REFINEMENT RULES:
- If agent asked user for data that were in context, create explicit instructions to use those IDs adn data
- Add concrete examples using actual context values
- Make parameter usage crystal clear

KNOWLEDGE REFINEMENT RULES:
- Keep the original structure but add clarifications
- If IDs are available in context, explicitly mention to use them
- Add examples of valid data formats if format errors occurred
- Include fallback instructions for edge cases
- Fix path, if any issues in the path in the definition
- Fix data structure of json object so that the ai understands better
- Motivating the ai to actually send query and path params in their respective params instead of json body
- Ensure to send id in the path parameter not in the json body.
- Ensure to send id in the query parameter not in the json body.
`;


    const contextInfo = this.buildDetailedContextInfo(context);
    const promptAnalysis = failedPrompt ? `\nFAILED PROMPT PREVIEW:\n${failedPrompt.substring(0, 500)}...\n` : '';
    const errorAnalysis = this.analyzeErrorType(errorMessage);

    let userPrompt = `${promptAnalysis}
ERROR: ${errorMessage}
ERROR TYPE: ${errorAnalysis.type}

ACTION: ${actionDetails.title} (${actionDetails.modelName})
PLATFORM: ${actionDetails.connectionPlatform}
PATH: ${actionDetails.path}

${contextInfo}`;

    if (responseAnalysis) {
      userPrompt += `\n\nAGENT RESPONSE ANALYSIS:
- Parameters agent asked for: ${responseAnalysis.requestedFromUser.join(', ')}
- Should have used from context: ${JSON.stringify(responseAnalysis.shouldHaveUsedFromContext)}
- Missing parameters: ${responseAnalysis.missingParams.join(', ')}\n`;
    }

    if (agentResponse) {
      userPrompt += `\n\nAGENT'S ACTUAL RESPONSE (excerpt):
${agentResponse.substring(0, 500)}...\n`;
    }

    userPrompt += `\n\nORIGINAL KNOWLEDGE:
${originalKnowledge}

Provide specific refinements to fix this error. Focus on making the prompt use context values directly.`;

    const fullContent = systemPrompt + userPrompt + originalKnowledge + (agentResponse || '');
    const inputLength = fullContent.length;
    const modelToUse = EnhancedModelSelector.selectModel('refinement', inputLength, this.useClaudeForRefinement);
    
    const model = modelToUse === 'claude-sonnet-4-20250514' ? 
      anthropic("claude-sonnet-4-20250514") : 
      openai(modelToUse);

    const { object: refinement } = await generateObject({
      model,
      schema: RefinementSchema,
      system: systemPrompt,
      prompt: userPrompt,
    });

    let promptStrategy = refinement.promptStrategy;
    if (responseAnalysis && Object.keys(responseAnalysis.shouldHaveUsedFromContext).length > 0) {
      promptStrategy = `CRITICAL: Use these exact values from context (DO NOT ask the user):
${Object.entries(responseAnalysis.shouldHaveUsedFromContext)
  .map(([param, value]) => `- ${param}: "${value}"`)
  .join('\n')}

${promptStrategy || 'Execute the action using the above values directly.'}`;
    }

    let enhancedKnowledge = refinement.knowledge;
    if (enhancedKnowledge && refinement.contextMapping && Object.keys(refinement.contextMapping).length > 0) {
      enhancedKnowledge += '\n\n## Context Mapping\n';
      for (const [param, contextKey] of Object.entries(refinement.contextMapping)) {
        enhancedKnowledge += `- Use ${contextKey} from context for ${param}\n`;
      }
    }

    if (enhancedKnowledge && refinement.additionalSteps && refinement.additionalSteps.length > 0) {
      enhancedKnowledge += '\n\n## Additional Steps\n';
      refinement.additionalSteps.forEach((step, index) => {
        enhancedKnowledge += `${index + 1}. ${step}\n`;
      });
    }

    return {
      knowledge: enhancedKnowledge?.trim() || undefined,
      promptStrategy: promptStrategy?.trim() || undefined,
      contextMapping: refinement.contextMapping
    };

  } catch (error) {
    console.error('Error during knowledge refinement:', error);
    return this.createFallbackRefinement(errorMessage, actionDetails, context);
  }
}

  private analyzeErrorType(errorMessage: string): { type: string; details: string[] } {
    const error = errorMessage.toLowerCase();
    const details: string[] = [];
    let type = 'unknown';

    if (error.includes('missing') || error.includes('required') || error.includes('need')) {
      type = 'missing_parameter';
      const paramMatch = error.match(/(?:missing|required|need)\s+(\w+)/g);
      if (paramMatch) details.push(...paramMatch);
    } else if (error.includes('format') || error.includes('invalid') || error.includes('type')) {
      type = 'format_error';
    } else if (error.includes('not found') || error.includes('does not exist')) {
      type = 'resource_not_found';
    } else if (error.includes('permission') || error.includes('unauthorized')) {
      type = 'permission_error';
    } else if (error.includes('already exists')) {
      type = 'duplicate_resource';
    }

    return { type, details };
  }

  private buildDetailedContextInfo(context?: ExecutionContext): string {
    if (!context) return "CONTEXT: None available";
    
    let info = "AVAILABLE CONTEXT:\n";
    
    if (context.availableIds && context.availableIds.size > 0) {
      info += "\nIDs that can be used:\n";
      for (const [type, ids] of context.availableIds.entries()) {
        const idList = Array.isArray(ids) ? ids : [ids];
        info += `- ${type}: "${idList[0]}" (use this directly in the action)\n`;
        if (idList.length > 1) {
          info += `  Additional ${type}s: ${idList.slice(1).join(', ')}\n`;
        }
      }
    }

    if (context.createdResources && context.createdResources.size > 0) {
      info += "\nResources created in this session:\n";
      for (const [type, resource] of context.createdResources.entries()) {
        info += `- ${type}: Available with full data\n`;
        if (typeof resource === 'object' && resource !== null) {
          const keys = Object.keys(resource).slice(0, 5);
          if (keys.length > 0) {
            info += `  Keys: ${keys.join(', ')}\n`;
          }
        }
      }
    }

    if (context.recentActions && context.recentActions.length > 0) {
      const recentSuccesses = context.recentActions.filter(a => a.success).slice(-3);
      if (recentSuccesses.length > 0) {
        info += "\nRecent successful actions:\n";
        recentSuccesses.forEach(action => {
          info += `- ${action.actionTitle} (${action.modelName})\n`;
        });
      }
    }

    return info;
  }

  private createFallbackRefinement(
    errorMessage: string,
    actionDetails: ModelDefinition,
    context?: ExecutionContext
  ): { knowledge?: string; promptStrategy?: string } {
    const error = errorMessage.toLowerCase();
    let knowledge = actionDetails.knowledge;
    let promptStrategy = undefined;

    if (error.includes('missing') && error.includes('id')) {
      if (context?.availableIds && context.availableIds.size > 0) {
        const availableId = Array.from(context.availableIds.entries())[0];
        knowledge += `\n\n## Using Context IDs\nIf a ${availableId[0]} is needed, use: "${availableId[1][0]}"`;
        promptStrategy = "Emphasize using the specific ID from context immediately";
      }
    } else if (error.includes('format')) {
      knowledge += "\n\n## Format Requirements\n- Ensure all dates use ISO format\n- Numbers should not be quoted\n- Boolean values must be true/false (not strings)";
    }

    return {
      knowledge: knowledge !== actionDetails.knowledge ? knowledge : undefined,
      promptStrategy
    };
  }

  async getExecutionOrder(analysisPrompt: string): Promise<string[] | null> {
    try {
      const systemPrompt = `You are a silent API workflow architect. Your only job is to determine the optimal execution order of API actions based on their function and dependencies.

CRITICAL INSTRUCTIONS:
- Analyze the user's list of actions carefully
- Determine the logical sequence considering:
  1. Resource creation must happen before using those resources
  2. List operations can help discover existing resources
  3. Update/Delete operations require existing resources
  4. Some actions may be independent and can run in parallel
- Your ONLY output MUST be a single, raw JSON array of the action "_id" strings in the correct execution order
- Do NOT include any explanations, commentary, or markdown
- Consider that some platforms have hierarchical resources (e.g., spreadsheet -> sheet -> values)

Example Output:
["id_of_create_spreadsheet", "id_of_create_sheet", "id_of_list_sheets", "id_of_update_values", "id_of_delete_sheet"]`;

      const { text: analysisResult } = await generateText({
        model: this.llmModel,
        system: systemPrompt,
        prompt: analysisPrompt,
      });

      const jsonMatch = analysisResult.match(/\[\s*"[^"]+"\s*(?:,\s*"[^"]+"\s*)*\]/);
      if (jsonMatch && jsonMatch[0]) {
        const sortedIds = JSON.parse(jsonMatch[0]);
        if (Array.isArray(sortedIds) && sortedIds.length > 0) {
          console.log(`Execution order determined: ${sortedIds.length} actions sorted`);
          return sortedIds as string[];
        }
      }
      
      console.log("Could not parse a valid sorted ID array from the AI response.");
      return null;

    } catch (error) {
      console.error('Error during execution order analysis:', error);
      return null;
    }
  }

  async generateSmartKnowledge(
    action: ModelDefinition,
    similarActions: ModelDefinition[],
    platformContext: string
  ): Promise<string | null> {
    try {
      const systemPrompt = `You are an API documentation expert. Generate clear, actionable knowledge for API actions based on similar actions and platform context.`;
      
      const userPrompt = `Generate knowledge for this action:
Action: ${action.title}
Method: ${action.action}
Path: ${action.path}
Platform: ${action.connectionPlatform}

Similar actions from the same platform:
${similarActions.slice(0, 3).map(a => `- ${a.title}: ${a.knowledge.substring(0, 200)}...`).join('\n')}

Create knowledge that includes:
1. Clear description
2. Required and optional parameters
3. Expected response format
4. Common use cases`;

      const { text } = await generateText({
        model: this.llmModel,
        system: systemPrompt,
        prompt: userPrompt,
      });

      return text.trim();
    } catch (error) {
      console.error('Error generating smart knowledge:', error);
      return null;
    }
  }
}