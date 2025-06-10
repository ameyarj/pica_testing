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
    context?: ExecutionContext
  ): Promise<string | null> {
    try {
      const systemPrompt = `You are an AI assistant expert in debugging and refining PicaOS Action Knowledge based on execution errors and context. Your goal is to fix the "Original Knowledge" to resolve the error.

Focus on the "### Enforcements" section to add conditional logic. Pay close attention to the error and the available context.

COMMON FIXES:
- If error mentions "Missing ID", "Not Found", "need the specific documentId", or "provide the document ID": Use an ID from the "Available Context" section. Add an enforcement like: "If documentId is required, use the first available 'documentId' from the context: [SPECIFIC_ID]."
- If error is about "missing field" or "bad request": Check if a resource was created in a recent action. Use data from that created resource to fill in required fields.
- If error mentions asking user for information: The knowledge should include automatic use of context data instead of prompting user.
- If error is "authentication" or "permission": This is usually not fixable by knowledge change. Suggest "NO_CHANGE".

CRITICAL: When IDs are available in context, the knowledge MUST include specific instructions to use those exact IDs without asking the user.

Output ONLY the complete, updated knowledge block. If no specific, actionable improvement can be made, output "NO_CHANGE". Do not just rephrase; the change must be a logical fix for the error.`;

      const contextInfo = context ? this.buildContextInfo(context) : "No context available.";

      const userPrompt = `
Action: ${actionDetails.title} (${actionDetails.modelName})
Platform: ${actionDetails.connectionPlatform}

ERROR MESSAGE:
\`\`\`
${errorMessage}
\`\`\`

AVAILABLE CONTEXT:
\`\`\`
${contextInfo}
\`\`\`

ORIGINAL KNOWLEDGE:
\`\`\`
${originalKnowledge}
\`\`\`

Based on the error and context, refine the "Original Knowledge" to use available context data automatically.`;

      const { text: refinedKnowledgeText } = await generateText({
        model: this.llmModel,
        system: systemPrompt,
        prompt: userPrompt,
      });

      if (refinedKnowledgeText && 
          refinedKnowledgeText.trim().toUpperCase() !== "NO_CHANGE" && 
          refinedKnowledgeText.trim().length > 10) {
        if (refinedKnowledgeText.includes("# Action:") || 
            refinedKnowledgeText.includes("### Enforcements") ||
            refinedKnowledgeText.includes("documentId")) {
          console.log("Knowledge refiner suggested an update with context.");
          return refinedKnowledgeText.trim();
        }
      }
      
      console.log("Knowledge refiner suggested NO_CHANGE or output was invalid.");
      return null;

    } catch (error) {
      console.error('Error during knowledge refinement:', error);
      return null;
    }
  }

  private buildContextInfo(context: ExecutionContext): string {
    let info = "";
    
    if (context.availableIds && Object.keys(context.availableIds).length > 0) {
      info += "Available Resource IDs:\n";
      for (const [type, ids] of Object.entries(context.availableIds)) {
        const idList = Array.isArray(ids) ? ids : [ids];
        info += `- ${type}: ${idList.join(', ')}\n`;
      }
    }

    if (context.createdResources && Object.keys(context.createdResources).length > 0) {
      info += "\nCreated Resources:\n";
      for (const [type, resource] of Object.entries(context.createdResources)) {
        info += `- ${type}: Available for reference\n`;
      }
    }

    if (context.recentActions && context.recentActions.length > 0) {
      info += "\nRecent Successful Actions:\n";
      context.recentActions
        .filter(action => action.success)
        .slice(-3)
        .forEach(action => {
          info += `- ${action.actionTitle} (${action.modelName})\n`;
        });
    }

    return info || "No relevant context available.";
  }
}