import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, generateObject, LanguageModel } from "ai";
import { z } from 'zod';
import { ModelDefinition, ExecutionContext} from './interfaces/interface';
import { EnhancedModelSelector } from './enhanced_model_selector';
import { initializeModel } from './utils/modelInitializer';
import { trackLLMCall } from './utils/tokenTrackerUtils';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

const RefinementSchema = z.object({
  knowledge: z.string().nullable().describe("Updated knowledge text, or null if no changes needed"),
  promptStrategy: z.string().nullable().describe("New prompting approach suggestion, or null if no changes needed"),
  contextMapping: z.record(z.string()).optional().describe("Explicit mapping of context IDs to parameters"),
  additionalSteps: z.array(z.string()).optional().describe("Additional verification or preparation steps"),
  enforcementRequired: z.boolean().optional().describe("Whether enforcement rules are needed for ID resolution")
});

interface EnforcementPattern {
  resourceType: string;
  idParameter: string;
  nameParameter?: string;
  listAction?: string;
  searchPattern?: string;
}

export class KnowledgeRefiner {
  private llmModel: LanguageModel;
  private useClaudeForRefinement: boolean;
  private pendingKnowledge: Map<string, {actionId: string, platform: string, knowledge: string}> = new Map();

  constructor(openAIApiKey: string, useClaudeForRefinement: boolean = true) {
  if (!openAIApiKey && !process.env.ANTHROPIC_API_KEY) {
    console.warn("Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY provided; KnowledgeRefiner may fail.");
  }
  
  this.useClaudeForRefinement = useClaudeForRefinement && !!process.env.ANTHROPIC_API_KEY;
  
  this.llmModel = initializeModel(this.useClaudeForRefinement, 'knowledge-refiner');
}

private standardizeKnowledgeFormat(knowledge: string): string {
  let standardized = knowledge;
  
  standardized = standardized.replace(/### Context Usage Guidelines/g, '### Usage Guidelines');
  standardized = standardized.replace(/### Context Value Usage Patterns/g, '### Value Usage Patterns');
  standardized = standardized.replace(/### Example Request Body Using Context/g, '### Example Request Body');
  standardized = standardized.replace(/### Generic Example/g, '### Example');
  
  const contextMappingSections = standardized.match(/## Context Mapping[\s\S]*?(?=##|$)/g) || [];
  if (contextMappingSections.length > 1) {
    standardized = standardized.replace(/## Context Mapping[\s\S]*?(?=##|$)/g, '');
    
    const combinedContent = contextMappingSections
      .map(section => section.replace(/## Context Mapping\s*/, '').trim())
      .filter(content => content.length > 0)
      .join('\n');
    
    if (combinedContent) {
      standardized += '\n\n## Context Mapping\n' + combinedContent;
    }
  }
  
  return standardized;
}

private detectIdParameters(action: ModelDefinition): EnforcementPattern[] {
  const patterns: EnforcementPattern[] = [];
  
  const pathParams = action.path.match(/\{\{(\w+)\}\}/g) || [];
  for (const param of pathParams) {
    const paramName = param.replace(/[{}]/g, '');
    if (paramName.toLowerCase().includes('id')) {
      const resourceType = paramName.replace(/[iI]d$/, '').replace(/[iI]D$/, '');
      patterns.push({
        resourceType: resourceType || 'resource',
        idParameter: paramName,
        nameParameter: resourceType ? `${resourceType}Name` : 'resourceName'
      });
    }
  }
  
  const method = action.action?.toUpperCase();
  const needsId = method === 'GET' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  
  if (needsId && patterns.length === 0) {
    const pathSegments = action.path.split('/').filter(s => s && !s.includes('{'));
    const lastSegment = pathSegments[pathSegments.length - 1];
    const resourceType = lastSegment || action.modelName.toLowerCase();
    
    patterns.push({
      resourceType,
      idParameter: `${resourceType}Id`,
      nameParameter: `${resourceType}Name`
    });
  }
  
  return patterns;
}

private generateEnforcementSection(patterns: EnforcementPattern[], action: ModelDefinition): string {
  if (patterns.length === 0) return '';
  
  const method = action.action?.toUpperCase();
  const isReadOperation = method === 'GET';
  const isModifyOperation = method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  
  let enforcement = '\n\n### Enforcements\n';
  
  for (const pattern of patterns) {
    const { resourceType, idParameter, nameParameter } = pattern;
    
    enforcement += `- If a \`${idParameter}\` is provided, proceed directly with the ${action.title.toLowerCase()}\n`;
    enforcement += `- If only a ${resourceType} name is provided:\n`;
    enforcement += `  - List the ${resourceType}s in the platform\n`;
    enforcement += `  - Search for exact name match\n`;
    enforcement += `  - Extract the \`${idParameter}\` from the matched ${resourceType}\n`;
    enforcement += `  - Use this ID in the ${isReadOperation ? 'request' : 'operation'}\n`;
    enforcement += `- If neither \`${idParameter}\` nor ${resourceType} name is provided:\n`;
    enforcement += `  - Prompt user: "Please provide either the ${resourceType} ID or exact ${resourceType} name"\n`;
    
    if (isModifyOperation) {
      enforcement += `- Do not execute the ${action.title} without a valid \`${idParameter}\` substituted into the URL path\n`;
    }
    
    if (isReadOperation && method === 'GET') {
      enforcement += `- Ensure no request body is sent for the GET method\n`;
    }
    
    enforcement += '\n';
  }
  
  return enforcement;
}

private detectEnforcementNeeds(
  errorMessage: string,
  agentResponse: string,
  action: ModelDefinition
): boolean {
  const error = errorMessage.toLowerCase();
  const response = agentResponse.toLowerCase();
  
  const idNeededPatterns = [
    /please provide.*id/i,
    /need.*id/i,
    /missing.*id/i,
    /what.*id/i,
    /specify.*id/i,
    /enter.*id/i,
    /give.*id/i
  ];
  
  const needsIdResolution = idNeededPatterns.some(pattern => 
    pattern.test(agentResponse) || pattern.test(errorMessage)
  );
  
  const hasIdInPath = action.path.includes('{{') && action.path.includes('id');
  
  const method = action.action?.toUpperCase();
  const isModifyingOperation = method === 'GET' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  
  return needsIdResolution || (hasIdInPath && isModifyingOperation);
}

private enhanceKnowledgeWithEnforcements(
  knowledge: string,
  action: ModelDefinition,
  errorMessage: string,
  agentResponse?: string
): string {
  const needsEnforcement = this.detectEnforcementNeeds(errorMessage, agentResponse || '', action);
  
  if (!needsEnforcement) {
    return this.standardizeKnowledgeFormat(knowledge);
  }
  
  const patterns = this.detectIdParameters(action);
  const enforcementSection = this.generateEnforcementSection(patterns, action);
  
  let enhanced = this.standardizeKnowledgeFormat(knowledge);
  
  if (enforcementSection) {
    const paramGuidelinesIndex = enhanced.lastIndexOf('## Parameter Usage Guidelines');
    if (paramGuidelinesIndex !== -1) {
      enhanced = enhanced.slice(0, paramGuidelinesIndex) + 
                 enforcementSection + 
                 enhanced.slice(paramGuidelinesIndex);
    } else {
      enhanced += enforcementSection;
    }
  }
  
  return enhanced;
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
    const text  = await trackLLMCall(
      this.useClaudeForRefinement ? 'claude-sonnet-4-20250514' : 'gpt-4.1',
      systemPrompt,
      userPrompt,
      'knowledge-refiner',
      'analyze-agent-response',
      async () => {
        const result = await generateText({
          model: this.llmModel,
          system: systemPrompt,
          prompt: userPrompt,
        });
        return { result: result.text, outputText: result.text };
      }
    );    

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

    const systemPrompt = `You are an expert at creating GENERIC knowledge refinements for API actions. Your refinements must work for millions of different users with different prompts and contexts.

CRITICAL RULES FOR GENERIC REFINEMENTS:
1. **NO SPECIFIC VALUES**: Never include specific IDs, names, emails, or other user data
2. **USE PLACEHOLDERS**: Replace specific values with generic placeholders like {contextId}, {userName}, {resourceName}
3. **PATTERN-BASED FIXES**: Focus on structural patterns, not specific errors
4. **UNIVERSAL APPLICABILITY**: Refinements must work regardless of the user's prompt or context

ANALYSIS FOCUS:
1. **Parameter Placement Issues**: Fix where parameters should go (path vs query vs body)
2. **Context Usage Patterns**: Create generic instructions for using available context
3. **Data Format Issues**: Fix JSON structure, data types, required fields
4. **API Call Structure**: Clarify how to construct proper API requests
5. **Common Failure Patterns**: Address recurring issues across different scenarios

GENERIC REFINEMENT RULES:
- Replace all specific IDs/values with placeholders: {contextId}, {userId}, {resourceId}
- Use generic examples: "user@example.com" instead of real emails
- Focus on parameter placement rules: "IDs go in path parameters, not request body"
- Add universal validation rules: "ensure required fields are present"
- Create fallback instructions: "if context missing, use system defaults"
- Emphasize data type correctness: "numbers as integers, not strings"
- Include universal error handling patterns

KNOWLEDGE STRUCTURE IMPROVEMENTS:
- Add parameter placement section: "Path Parameters: {id}", "Query Parameters: {filter}", "Body: {data}"
- Include data format examples with placeholders
- Add validation rules that work universally
- Focus on API contract compliance
- Provide generic troubleshooting steps

Remember: Your refinements will be used by millions of users. Make them universally applicable!`;


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

    const refinement = await trackLLMCall(
      modelToUse,
      systemPrompt,
      userPrompt,
      'knowledge-refiner',
      'refine-knowledge',
      async () => {
        const result = await generateObject({
          model,
          schema: RefinementSchema,
          system: systemPrompt,
          prompt: userPrompt,
        });
        return { result: result.object, outputText: JSON.stringify(result.object) };
      }
    );

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

    const enhancedWithEnforcements = enhancedKnowledge ? 
      this.enhanceKnowledgeWithEnforcements(enhancedKnowledge, actionDetails, errorMessage, agentResponse) : 
      this.enhanceKnowledgeWithEnforcements(originalKnowledge, actionDetails, errorMessage, agentResponse);

    const generalizedKnowledge = this.generalizeRefinedKnowledge(enhancedWithEnforcements, context);

    if (generalizedKnowledge) {
      this.pendingKnowledge.set(actionDetails._id, {
        actionId: actionDetails._id,
        platform: actionDetails.connectionPlatform,
        knowledge: generalizedKnowledge
      });
    }

    return {
      knowledge: generalizedKnowledge?.trim() || undefined,
      promptStrategy: promptStrategy?.trim() || undefined,
      contextMapping: refinement.contextMapping
    };

  } catch (error) {
    console.error('Error during knowledge refinement:', error);
    return this.createFallbackRefinement(errorMessage, actionDetails, context);
  }
}

  private generalizeRefinedKnowledge(knowledge: string, context?: ExecutionContext): string {
    let generalized = knowledge;

    if (context?.availableIds) {
      for (const [type, ids] of context.availableIds.entries()) {
        const idList = Array.isArray(ids) ? ids : [ids];
        for (const id of idList) {
          const regex = new RegExp(`"${id}"`, 'g');
          generalized = generalized.replace(regex, `"{${type}}"`);
          
          const regexNoQuotes = new RegExp(`\\b${id}\\b`, 'g');
          generalized = generalized.replace(regexNoQuotes, `{${type}}`);
        }
      }
    }

    if (context?.availableNames) {
      for (const [type, name] of context.availableNames.entries()) {
        const regex = new RegExp(`"${name}"`, 'g');
        generalized = generalized.replace(regex, `"{${type}}"`);
        
        const regexNoQuotes = new RegExp(`\\b${name}\\b`, 'g');
        generalized = generalized.replace(regexNoQuotes, `{${type}}`);
      }
    }

    generalized = generalized
      .replace(/[\w\.-]+@[\w\.-]+\.\w+/g, 'user@example.com')
      .replace(/\+?\d{1,3}[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{4}/g, '+1-555-0123')
      .replace(/https?:\/\/(?!.*\{)[^\s"]+/g, 'https://api.example.com/endpoint')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[\.\d]*Z?/g, '2024-01-01T12:00:00Z')
      .replace(/"(\d{6,})"/g, '"{contextId}"')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}');

    if (!generalized.includes('Parameter Placement') && !generalized.includes('contextId')) {
      generalized += '\n\n## Parameter Usage Guidelines\n';
      generalized += '- Use IDs from context: {contextId}, {userId}, {resourceId}\n';
      generalized += '- Path parameters: Place IDs in URL path segments\n';
      generalized += '- Query parameters: Use for filters and options\n';
      generalized += '- Request body: Include data payload, not IDs\n';
    }

    return generalized;
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

persistRefinedKnowledge(platform: string, batchNumber: number, actionId: string, refinedKnowledge: string): void {
  const knowledgeDir = path.join(process.cwd(), 'logs', 'knowledge', platform);
  if (!fs.existsSync(knowledgeDir)) {
    fs.mkdirSync(knowledgeDir, { recursive: true });
  }

  const filename = `${actionId.replace(/[^a-zA-Z0-9]/g, '_')}.md`;
  const filepath = path.join(knowledgeDir, filename);
  
  const content = `# Refined Knowledge - Batch ${batchNumber}\n\n## Action ID: ${actionId}\n\n${refinedKnowledge}`;
  fs.writeFileSync(filepath, content);
}

loadRefinedKnowledge(platform: string, batchNumbers: number[], actionId: string): string | null {
  const knowledgeDir = path.join(process.cwd(), 'logs', 'knowledge', platform);
  
  for (const batchNumber of batchNumbers.reverse()) {
    const filename = `${actionId.replace(/[^a-zA-Z0-9]/g, '_')}.md`;
    const filepath = path.join(knowledgeDir, filename);
    
    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, 'utf-8');
      const knowledgeMatch = content.match(/## Action ID: .+\n\n([\s\S]+)$/);
      return knowledgeMatch ? knowledgeMatch[1] : null;
    }
  }
  
  return null;
}

saveAllPendingKnowledge(): void {
  if (this.pendingKnowledge.size === 0) {
    console.log(chalk.gray('   No pending knowledge to save'));
    return;
  }

  console.log(chalk.blue(`   💾 Saving ${this.pendingKnowledge.size} pending knowledge files...`));
  
  for (const [actionId, data] of this.pendingKnowledge) {
    try {
      const knowledgeDir = path.join(process.cwd(), 'knowledge', data.platform);
      if (!fs.existsSync(knowledgeDir)) {
        fs.mkdirSync(knowledgeDir, { recursive: true });
      }

      const cleanActionId = actionId
        .replace(/::/g, '_')
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/_{2,}/g, '_');
      
      const filename = `${cleanActionId}.md`;
      const filepath = path.join(knowledgeDir, filename);
      
      const content = `# Refined Knowledge\n\n${data.knowledge}`;
      fs.writeFileSync(filepath, content);
      
      console.log(chalk.green(`   ✓ Saved: ${filename}`));
    } catch (error) {
      console.error(chalk.red(`   ❌ Failed to save knowledge for ${actionId}: ${error}`));
    }
  }
  
  this.pendingKnowledge.clear();
}

}
