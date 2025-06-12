import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { ModelDefinition, ExecutionContext } from './interface';

export class KnowledgeRefiner {
  private llmModel: any;

  constructor(openAIApiKey: string) {
    if (!openAIApiKey) {
      console.warn("OPENAI_API_KEY not provided; KnowledgeRefiner LLM interactions may fail.");
    }
    this.llmModel = openai("gpt-4.1"); 
  }

  async refineKnowledge(
  originalKnowledge: string,
  errorMessage: string,
  actionDetails: Readonly<ModelDefinition>,
  context?: ExecutionContext,
  failedPrompt?: string
): Promise<{ knowledge?: string; promptStrategy?: string }> {
  try {
    const systemPrompt = `You are an expert at fixing API action failures. You analyze errors and provide fixes for both the knowledge AND the prompting strategy.

ANALYSIS FOCUS:
1. **Missing Context Usage**: If error mentions "missing ID" or "need specific [field]" but context has that data, fix the knowledge to use context automatically
2. **Bad Prompting**: If the prompt was too technical or unclear, suggest a more human-like approach
3. **Parameter Issues**: Add specific parameter mappings based on available context

OUTPUT FORMAT:
Return a JSON object with:
- "knowledge": Updated knowledge (null if no change needed)
- "promptStrategy": New prompting approach (null if no change needed)

CONTEXT USAGE RULES:
- Always prefer context data over asking users
- Include specific ID values when available
- Make instructions actionable and specific`;

    const contextInfo = this.buildDetailedContextInfo(context);
    const promptAnalysis = failedPrompt ? `FAILED PROMPT:\n${failedPrompt.substring(0, 500)}...\n\n` : '';

    const userPrompt = `${promptAnalysis}ERROR: ${errorMessage}

ACTION: ${actionDetails.title} (${actionDetails.modelName})
PLATFORM: ${actionDetails.connectionPlatform}

${contextInfo}

ORIGINAL KNOWLEDGE:
${originalKnowledge}

Fix the knowledge and/or suggest a better prompting strategy.`;

    const { text } = await generateText({
      model: this.llmModel,
      system: systemPrompt,
      prompt: userPrompt,
    });

    try {
      const result = JSON.parse(text);
      return {
        knowledge: result.knowledge?.trim() || null,
        promptStrategy: result.promptStrategy?.trim() || null
      };
    } catch {
      if (text.includes("context") || text.includes("ID") || text.length > 50) {
        return { knowledge: text.trim() };
      }
      return {};
    }

  } catch (error) {
    console.error('Error during knowledge refinement:', error);
    return {};
  }
}

private buildDetailedContextInfo(context?: ExecutionContext): string {
  if (!context) return "CONTEXT: None available";
  
  let info = "AVAILABLE CONTEXT:\n";
  
  if (context.availableIds && Object.keys(context.availableIds).length > 0) {
    info += "IDs that can be used:\n";
    for (const [type, ids] of Object.entries(context.availableIds)) {
      const idList = Array.isArray(ids) ? ids : [ids];
      info += `- ${type}: ${idList[0]} (use this directly)\n`;
    }
  }

  if (context.createdResources && Object.keys(context.createdResources).length > 0) {
    info += "Resources created in this session:\n";
    Object.keys(context.createdResources).forEach(type => {
      info += `- ${type}: Available for reference\n`;
    });
  }

  return info;
}

async getExecutionOrder(analysisPrompt: string): Promise<string[] | null> {
    try {
      const systemPrompt = `You are a silent API workflow architect. Your only job is to determine the optimal execution order of API actions based on their function.

CRITICAL INSTRUCTIONS:
- Analyze the user's list of actions.
- Determine the logical sequence (e.g., create -> list -> update -> delete).
- Your ONLY output MUST be a single, raw JSON array of the action "_id" strings in the correct execution order.
- Do NOT include any explanations, commentary, or markdown.

Example Output:
["id_of_create_action", "id_of_list_action", "id_of_get_action", "id_of_update_action", "id_of_delete_action"]`;

      const { text: analysisResult } = await generateText({
        model: this.llmModel,
        system: systemPrompt,
        prompt: analysisPrompt,
      });

      const jsonMatch = analysisResult.match(/\[\s*".*?"\s*\]/s);
      if (jsonMatch && jsonMatch[0]) {
        const sortedIds = JSON.parse(jsonMatch[0]);
        if (Array.isArray(sortedIds) && sortedIds.length > 0) {
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

}