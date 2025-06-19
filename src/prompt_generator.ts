import { ModelDefinition, ExecutionContext } from './interface';
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, LanguageModel } from "ai";
import { PathParameterResolver } from './path_resolver';

export interface PromptStrategy {
  tone: 'conversational' | 'technical' | 'step-by-step' | 'contextual';
  emphasis: string[];
  examples: boolean;
  contextLevel: 'minimal' | 'moderate' | 'extensive';
}

export class EnhancedPromptGenerator {
  private llmModel: LanguageModel;
  private promptHistory: Map<string, { prompt: string; success: boolean }[]> = new Map();

  constructor(private useClaudeForPrompting: boolean = true) {
  if (useClaudeForPrompting && process.env.ANTHROPIC_API_KEY) {
    try {
      this.llmModel = anthropic("claude-sonnet-4-20250514");
    } catch (error) {
      console.warn("Failed to initialize Claude for prompting, falling back to GPT-4.1");
      this.llmModel = openai("gpt-4.1");
    }
  } else {
    this.llmModel = openai("gpt-4.1");
  }
}

  async generateAdaptivePrompt(
  action: ModelDefinition,
  context: ExecutionContext,
  history: readonly any[],
  attemptNumber: number = 1,
  previousError?: string,
  dependencyGraph?: any,
  previousResponse?: string 
): Promise<{ prompt: string; strategy: PromptStrategy }> {
  
  const strategy = this.determinePromptStrategy(action, context, attemptNumber, previousError);
  
  const examples = this.getRelevantExamples(action, context);
  
  let prompt = await this.buildPrompt(action, context, strategy, examples, dependencyGraph, previousError);
  
  if (previousResponse) {
    prompt = this.incorporateResponseRefinements(prompt, action, context, previousResponse);
  }
  
  const actionKey = `${action.connectionPlatform}:${action.modelName}:${action.actionName}`;
  if (!this.promptHistory.has(actionKey)) {
    this.promptHistory.set(actionKey, []);
  }
  
  return { prompt, strategy };
}

  private determinePromptStrategy(
  action: ModelDefinition,
  context: ExecutionContext,
  attemptNumber: number,
  previousError?: string
): PromptStrategy {
  const actionName = action.actionName.toLowerCase();
  const hasContext = context.availableIds && context.availableIds.size > 0;
  const needsId = action.path.includes('{{');
  
  if (needsId && hasContext) {
    return {
      tone: 'contextual',
      emphasis: ['use the provided IDs from context', 'do not ask for IDs', 'IDs are already available'],
      examples: true,
      contextLevel: 'extensive'
    };
  }
  
  if (attemptNumber === 1) {
    if (actionName.includes('create')) {
      return {
        tone: 'conversational',
        emphasis: ['realistic data', 'professional naming'],
        examples: true,
        contextLevel: hasContext ? 'moderate' : 'minimal'
      };
    } else if (actionName.includes('get') || actionName.includes('list')) {
      return {
        tone: 'technical',
        emphasis: ['fetch all data', 'include IDs'],
        examples: false,
        contextLevel: hasContext ? 'extensive' : 'minimal'
      };
    }
  }
  
  if (previousError) {
    if (previousError && (previousError.includes('403') || previousError.includes('permission') || 
        previousError.includes('forbidden') || previousError.includes('scope'))) {
      return {
        tone: 'technical',
        emphasis: ['check authentication', 'verify permissions', 'this appears to be a permission issue'],
        examples: false,
        contextLevel: 'minimal'
      };
    }
    
    if (previousError.includes('missing') || previousError.includes('required')) {
      return {
        tone: 'step-by-step',
        emphasis: ['use context IDs', 'check requirements', 'IDs are in the context above'],
        examples: true,
        contextLevel: 'extensive'
      };
    } else if (previousError.includes('format') || previousError.includes('invalid')) {
      return {
        tone: 'technical',
        emphasis: ['exact format', 'data types'],
        examples: true,
        contextLevel: 'moderate'
      };
    }
  }
  
  return {
    tone: 'contextual',
    emphasis: ['complete the task', 'use available resources'],
    examples: attemptNumber > 1,
    contextLevel: hasContext ? 'extensive' : 'moderate'
  };
}

  private async buildPrompt(
  action: ModelDefinition,
  context: ExecutionContext,
  strategy: PromptStrategy,
  examples: string[],
  dependencyGraph?: any,
  previousError?: string 
): Promise<string> {
  let prompt = '';
  
  const metadata = dependencyGraph?.nodes.find((n: any) => n.id === action._id);
  const needsContext = metadata && metadata.requiresIds.length > 0;
  
  if (needsContext && context.availableIds && context.availableIds.size > 0) {
    prompt = "**IMPORTANT CONTEXT FROM PREVIOUS ACTIONS:**\n";
    for (const reqId of metadata.requiresIds) {
      if (context.availableIds.has(reqId)) {
        const values = context.availableIds.get(reqId)!;
        const value = Array.isArray(values) ? values[0] : values;
        prompt += `• ${reqId}: "${value}" (USE THIS - already created)\n`;
      }
    }

    if (action._id && previousError && 
        (previousError.includes('403') || previousError.includes('permission'))) {
      prompt = "⚠️ **PERMISSION ERROR DETECTED**\n" +
        "This action previously failed due to insufficient permissions or scopes.\n" +
        "The connector may need additional OAuth scopes to perform this action.\n\n" + prompt;
    }
    
    prompt += "\n";
  }
  
  switch (strategy.tone) {
    case 'conversational':
      prompt += this.getConversationalOpening(action, context);
      break;
    case 'step-by-step':
      prompt += this.getStepByStepOpening(action, context);
      break;
    case 'technical':
      prompt += this.getTechnicalOpening(action, context);
      break;
    case 'contextual':
      prompt += this.getContextualOpening(action, context);
      break;
  }
  
  if (strategy.contextLevel !== 'minimal' && context.availableIds && context.availableIds.size > 0) {
    prompt += this.buildContextSection(action, context, strategy.contextLevel);
  }
  
  if (strategy.emphasis.length > 0) {
    prompt += '\n\nKey points to remember:\n';
    strategy.emphasis.forEach(point => {
      prompt += `• ${point}\n`;
    });
  }
  
  if (strategy.contextLevel !== 'minimal') {
      prompt += this.buildPathSection(action, context);
    }
  

  if (strategy.examples && examples.length > 0) {
    prompt += '\n\nHere are some examples that worked well:\n';
    examples.forEach(example => {
      prompt += `• ${example}\n`;
    });
  }
  
  if (dependencyGraph) {
    const metadata = dependencyGraph.nodes.find((n: any) => n.id === action._id);
    if (metadata && metadata.dependsOn.length > 0) {
      prompt += '\n\nThis action depends on previous actions that should have provided:\n';
      metadata.requiresIds.forEach((id: string) => {
        const hasId = context.availableIds.has(id) && context.availableIds.get(id)!.length > 0;
        if (hasId) {
          const value = context.availableIds.get(id)![0];
          prompt += `• ${id}: "${value}" (available in context - use this!)\n`;
        } else {
          prompt += `• ${id} (should be available from previous actions)\n`;
        }
      });
    }
  }
  
  prompt += `\n\n---\n### Technical Details\n${action.knowledge}`;
  prompt += `\n\n### Execute Task\nUse Action ID: ${action._id} to complete this task.`;
  
  return prompt;
}

private incorporateResponseRefinements(
  basePrompt: string,
  action: ModelDefinition,
  context: ExecutionContext,
  previousResponse?: string
): string {
  if (!previousResponse) return basePrompt;
  
  const requestPatterns = [
    /(?:provide|specify|need|require)\s+(?:the\s+)?(\w+Id)\b/gi,
    /what\s+is\s+(?:the\s+)?(\w+Id)\b/gi
  ];
  
  const requestedIds: string[] = [];
  for (const pattern of requestPatterns) {
    let match;
    while ((match = pattern.exec(previousResponse)) !== null) {
      requestedIds.push(match[1]);
    }
  }
  
  if (requestedIds.length > 0 && context.availableIds) {
    let refinedPrompt = "⚠️ IMPORTANT - USE THESE VALUES (DO NOT ASK USER):\n";
    
    for (const reqId of requestedIds) {
      if (context.availableIds.has(reqId)) {
        const value = context.availableIds.get(reqId)![0];
        refinedPrompt += `• ${reqId} = "${value}" (USE THIS EXACT VALUE)\n`;
      }
    }
    
    refinedPrompt += "\n" + basePrompt;
    return refinedPrompt;
  }
  
  return basePrompt;
}

  private getConversationalOpening(action: ModelDefinition, context: ExecutionContext): string {
    const platform = action.connectionPlatform.replace(/-/g, ' ');
    const model = action.modelName.toLowerCase();
    
    const openings = [
      `Hey! I need your help to ${action.actionName.toLowerCase()} a ${model} in ${platform}. `,
      `Hi there! Could you please ${action.actionName.toLowerCase()} a ${model} using ${platform}? `,
      `Great! Now let's ${action.actionName.toLowerCase()} a ${model} in ${platform}. `
    ];
    
    return openings[Math.floor(Math.random() * openings.length)];
  }

  private getStepByStepOpening(action: ModelDefinition, context: ExecutionContext): string {
    return `Let's carefully ${action.actionName.toLowerCase()} a ${action.modelName.toLowerCase()} step by step:\n\n` +
           `Step 1: Check if we have all required information\n` +
           `Step 2: Use the correct action with proper parameters\n` +
           `Step 3: Verify the operation completed successfully\n\n`;
  }

  private getTechnicalOpening(action: ModelDefinition, context: ExecutionContext): string {
    return `Execute ${action.actionName.toUpperCase()} operation on ${action.modelName} via ${action.connectionPlatform}. `;
  }

  private getContextualOpening(action: ModelDefinition, context: ExecutionContext): string {
  const recentSuccess = context.recentActions.filter(a => a.success).slice(-1)[0];
  
  const hasRelevantNames = context.availableNames && context.availableNames.size > 0;
  
  if (recentSuccess && hasRelevantNames) {
    const nameHint = Array.from(context.availableNames.values())[0];
    return `Following up on the ${recentSuccess.actionTitle}, now we need to ${action.actionName.toLowerCase()} the ${action.modelName.toLowerCase()} named "${nameHint}". Use the name when possible, not technical IDs. `;
  } else if (recentSuccess) {
    return `Following up on the ${recentSuccess.actionTitle}, now we need to ${action.actionName.toLowerCase()} the ${action.modelName.toLowerCase()}. `;
  }
  return `For our testing workflow, please ${action.actionName.toLowerCase()} a ${action.modelName.toLowerCase()} in ${action.connectionPlatform}. Use human-readable names when possible. `;
}
  private buildContextSection(
  action: ModelDefinition, 
  context: ExecutionContext, 
  level: 'moderate' | 'extensive'
): string {
  let section = '\n\n📋 Session Context (Important - each request is a new chat):\n';
  
  if (context.availableIds && context.availableIds.size > 0) {
    section += 'IDs from previous actions in this testing session:\n';
    if (context.availableNames && context.availableNames.size > 0) {
      section += 'Resource names (use these for user-friendly operations):\n';
      for (const [idType, name] of context.availableNames.entries()) {
        section += `• ${idType.replace('Id', 'Name')}: "${name}" - PREFER THIS for operations\n`;
      }
      section += '\n';
    }

    section += 'Technical IDs (use only if names don\'t work):\n';
        for (const [type, ids] of context.availableIds.entries()) {
          const idList = Array.isArray(ids) ? ids : [ids];
          section += `• ${type}: "${idList[0]}" - USE THIS DIRECTLY, it already exists\n`;
          if (idList.length > 1) {
            section += `  Additional ${type}s: ${idList.slice(1).map(id => `"${id}"`).join(', ')}\n`;
          }
        }
        section += '\nThese resources were created in earlier actions. You should use these IDs directly without creating new ones.\n';
      }
  
  if (level === 'extensive') {
    if (context.createdResources && context.createdResources.size > 0) {
      section += '\nResources created in this session:\n';
      for (const [key, resource] of context.createdResources.entries()) {
        section += `• ${key}`;
        if (typeof resource === 'object' && resource !== null && resource.id) {
          section += ` (ID: ${resource.id})`;
        }
        section += '\n';
      }
    }
    
    const recentSuccesses = context.recentActions.filter(a => a.success).slice(-3);
    if (recentSuccesses.length > 0) {
      section += '\nWhat happened in recent actions:\n';
      recentSuccesses.forEach((action, idx) => {
        section += `${idx + 1}. ${action.actionTitle} - Completed successfully`;
        if (action.output && typeof action.output === 'string') {
          const idMatch = action.output.match(/"id"\s*:\s*"([^"]+)"/);
          if (idMatch) {
            section += ` (created ID: ${idMatch[1]})`;
          }
        }
        section += '\n';
      });
    }
  }
  
  return section;
}

private buildPathSection(action: ModelDefinition, context: ExecutionContext): string {
  const { resolvedPath, missingParams } = PathParameterResolver.resolvePath(
    action.path, 
    context, 
    context.availableIds ? Object.fromEntries(context.availableIds) : undefined
  );
  
  let section = '';
  
  if (missingParams.length > 0) {
    section += `\n\n⚠️ CRITICAL: Missing required parameters for this action:\n`;
    missingParams.forEach(param => {
      section += `• ${param} - `;
      if (context.availableIds) {
        const similarParams = Array.from(context.availableIds.keys())
          .filter(key => key.toLowerCase().includes(param.toLowerCase()) || 
                        param.toLowerCase().includes(key.toLowerCase()));
        if (similarParams.length > 0) {
          const value = context.availableIds.get(similarParams[0]);
          section += `Use "${value}" from context\n`;
        } else {
          section += `Need to create or find this resource first\n`;
        }
      } else {
        section += `Need to create or find this resource first\n`;
      }
    });
  } else if (resolvedPath !== action.path) {
    section += `\n\n✅ Using resolved path: ${resolvedPath}\n`;
  }
  
  return section;
}

  private getRelevantExamples(action: ModelDefinition, context: ExecutionContext): string[] {
    const examples: string[] = [];
    const platform = action.connectionPlatform.toLowerCase();
    const model = action.modelName.toLowerCase();
    const actionName = action.actionName.toLowerCase();
    
    if (actionName.includes('create')) {
      if (platform.includes('google') && model.includes('doc')) {
        examples.push('Title: "Q4 2024 Strategic Planning Document"');
      } else if (platform.includes('sheet') || platform.includes('excel')) {
        examples.push('Title: "Sales Analysis - December 2024"');
      } else if (platform.includes('email')) {
        examples.push('Subject: "Project Update - Testing Framework Progress"');
      }
    } else if (actionName.includes('update')) {
      examples.push('Add today\'s date to show the update worked');
      examples.push('Append " - Updated" to the title or name');
    }
    
    return examples.slice(0, 2); 
  }

  recordPromptResult(actionId: string, prompt: string, success: boolean): void {
    const history = this.promptHistory.get(actionId) || [];
    history.push({ prompt, success });
    this.promptHistory.set(actionId, history);
  }

  
}