import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, generateObject, LanguageModel } from "ai";
import { z } from 'zod';
import { ModelDefinition, ExecutionContext } from './interface';

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

  async refineKnowledge(
    originalKnowledge: string,
    errorMessage: string,
    actionDetails: Readonly<ModelDefinition>,
    context?: ExecutionContext,
    failedPrompt?: string
  ): Promise<{ knowledge?: string; promptStrategy?: string; contextMapping?: Record<string, string> }> {
    try {
      const systemPrompt = `You are an expert at fixing API action failures. You analyze errors and provide fixes for both the knowledge AND the prompting strategy.

ANALYSIS FOCUS:
1. **Missing Context Usage**: If error mentions "missing ID" or "need specific [field]" but context has that data, fix the knowledge to use context automatically
2. **Bad Prompting**: If the prompt was too technical or unclear, suggest a more human-like approach
3. **Parameter Issues**: Add specific parameter mappings based on available context
4. **Missing Steps**: Add verification or data preparation steps if needed

KNOWLEDGE REFINEMENT RULES:
- Keep the original structure but add clarifications
- If IDs are available in context, explicitly mention to use them
- Add examples of valid data formats if format errors occurred
- Include fallback instructions for edge cases

OUTPUT FORMAT:
Return structured refinements that address the specific error. Be precise and actionable.`;

      const contextInfo = this.buildDetailedContextInfo(context);
      const promptAnalysis = failedPrompt ? `\nFAILED PROMPT PREVIEW:\n${failedPrompt.substring(0, 500)}...\n` : '';
      const errorAnalysis = this.analyzeErrorType(errorMessage);

      const userPrompt = `${promptAnalysis}
ERROR: ${errorMessage}
ERROR TYPE: ${errorAnalysis.type}

ACTION: ${actionDetails.title} (${actionDetails.modelName})
PLATFORM: ${actionDetails.connectionPlatform}
PATH: ${actionDetails.path}

${contextInfo}

ORIGINAL KNOWLEDGE:
${originalKnowledge}

Provide specific refinements to fix this error.`;

      const { object: refinement } = await generateObject({
        model: this.llmModel,
        schema: RefinementSchema,
        system: systemPrompt,
        prompt: userPrompt,
      });

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
        promptStrategy: refinement.promptStrategy?.trim() || undefined,
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