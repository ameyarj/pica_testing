import { openai } from "@ai-sdk/openai";
import { generateText, generateObject } from "ai";
import { z } from 'zod';
import { ModelDefinition } from './interface';
import chalk from 'chalk';
import { tokenTracker } from './global_token_tracker';

const ApiDocumentationSchema = z.object({
  parameters: z.array(z.object({
    name: z.string().describe("Parameter name"),
    type: z.string().describe("Data type (string, number, boolean, object, array, etc.)"),
    required: z.boolean().describe("Whether this parameter is required"),
    location: z.enum(['path', 'query', 'body', 'header']).describe("Where the parameter should be sent"),
    description: z.string().describe("What this parameter does"),
    example: z.any().describe("Example value for this parameter"),
    constraints: z.array(z.string()).optional().describe("Any constraints (min/max length, format, etc.)")
  })),
  responseFormat: z.object({
    type: z.string().describe("Response type (object, array, etc.)"),
    fields: z.record(z.string()).optional().describe("Key fields in the response"),
    example: z.any().optional().describe("Example response")
  }).optional(),
  authentication: z.object({
    type: z.string().describe("Auth type (OAuth, API Key, etc.)"),
    scopes: z.array(z.string()).optional().describe("Required OAuth scopes")
  }).optional(),
  examples: z.array(z.object({
    title: z.string().describe("Example title"),
    request: z.any().describe("Example request"),
    response: z.any().describe("Example response")
  })).optional()
});

type ApiDocumentation = z.infer<typeof ApiDocumentationSchema>;

export class ApiDocAnalyzer {
  private searchModel = openai("gpt-4o-search-preview");
  private cache: Map<string, ApiDocumentation> = new Map();

  async searchApiDocumentation(
    action: ModelDefinition,
    platform: string
  ): Promise<ApiDocumentation | null> {
    const cacheKey = `${platform}:${action.actionName}:${action.modelName}`;
    
    if (this.cache.has(cacheKey)) {
      console.log(chalk.gray(`   📚 Using cached API documentation for ${action.title}`));
      return this.cache.get(cacheKey)!;
    }

    try {
      console.log(chalk.blue(`   🔍 Searching API documentation for ${action.title}...`));
      
      const searchQuery = this.buildSearchQuery(action, platform);
      
      const searchResult = await this.performSearch(searchQuery);
      
      if (!searchResult) {
        console.log(chalk.yellow(`   ⚠️ No API documentation found for ${action.title}`));
        return null;
      }

      const documentation = await this.parseDocumentation(searchResult, action);
      
      if (documentation) {
        this.cache.set(cacheKey, documentation);
        console.log(chalk.green(`   ✅ Found and cached API documentation`));
      }
      
      return documentation;
    } catch (error) {
      console.error(chalk.red(`   ❌ Error searching API documentation:`), error);
      return null;
    }
  }

  private buildSearchQuery(action: ModelDefinition, platform: string): string {
    const queries = [
      `${platform} API ${action.actionName} ${action.modelName} documentation`,
      `${platform} ${action.title} API parameters`,
      `${platform} ${action.action} ${action.path} API reference`
    ];
    
    if (platform.toLowerCase().includes('google')) {
      queries.push(`Google Workspace API ${action.modelName} ${action.actionName}`);
    } else if (platform.toLowerCase().includes('microsoft')) {
      queries.push(`Microsoft Graph API ${action.modelName} ${action.actionName}`);
    } else if (platform.toLowerCase().includes('linear')) {
      queries.push(`Linear GraphQL API ${action.modelName} ${action.actionName}`);
    }
    
    return queries[0]; 
  }

  private async performSearch(query: string): Promise<string | null> {
    try {
      const prompt = `Search for API documentation: ${query}. 
        Focus on finding:
        1. Required and optional parameters
        2. Parameter types and locations (path, query, body)
        3. Authentication requirements
        4. Example requests and responses
        5. Any special constraints or formats
        
        Return the most relevant API documentation information.`;
      
      const inputTokens = tokenTracker.estimateTokens(prompt);
      
      const { text } = await generateText({
        model: this.searchModel,
        prompt,
        maxTokens: 4000
      });
      
      const outputTokens = tokenTracker.estimateTokens(text);
      tokenTracker.trackUsage(
        'gpt-4o-search-preview',
        inputTokens,
        outputTokens,
        'api-doc-analyzer',
        'search-documentation'
      );

      return text;
    } catch (error) {
      console.error('Search error:', error);
      return null;
    }
  }

  private async parseDocumentation(
    searchResult: string,
    action: ModelDefinition
  ): Promise<ApiDocumentation | null> {
    try {
      const systemPrompt = `You are an API documentation parser. Extract structured information from API documentation.

EXTRACTION RULES:
1. Identify ALL parameters (required and optional)
2. Determine parameter location (path, query, body, header)
3. Extract parameter types and constraints
4. Find example values
5. Identify authentication requirements
6. Extract response format information

IMPORTANT:
- Path parameters are in the URL path (e.g., /users/{userId})
- Query parameters come after ? (e.g., ?page=1&limit=10)
- Body parameters are in the request body (usually JSON)
- Be very specific about parameter locations`;

      const userPrompt = `Parse this API documentation for the action "${action.title}":

Action Details:
- Method: ${action.action}
- Path: ${action.path}
- Platform: ${action.connectionPlatform}

Documentation:
${searchResult}

Extract all parameter information, examples, and requirements.`;

      const inputTokens = tokenTracker.estimateTokens(systemPrompt + userPrompt);
      
      const { object: documentation } = await generateObject({
        model: openai("gpt-4o"),
        schema: ApiDocumentationSchema,
        system: systemPrompt,
        prompt: userPrompt,
      });
      
      const outputTokens = tokenTracker.estimateTokens(JSON.stringify(documentation));
      tokenTracker.trackUsage(
        'gpt-4o',
        inputTokens,
        outputTokens,
        'api-doc-analyzer',
        'parse-documentation'
      );

      return documentation;
    } catch (error) {
      console.error('Parsing error:', error);
      return null;
    }
  }

  generateParameterSummary(documentation: ApiDocumentation): string {
    let summary = '';
    
    const pathParams = documentation.parameters.filter(p => p.location === 'path');
    const queryParams = documentation.parameters.filter(p => p.location === 'query');
    const bodyParams = documentation.parameters.filter(p => p.location === 'body');
    
    if (pathParams.length > 0) {
      summary += '\n## Path Parameters:\n';
      pathParams.forEach(p => {
        summary += `- ${p.name} (${p.type}${p.required ? ', required' : ', optional'}): ${p.description}\n`;
        if (p.example) summary += `  Example: ${JSON.stringify(p.example)}\n`;
      });
    }
    
    if (queryParams.length > 0) {
      summary += '\n## Query Parameters:\n';
      queryParams.forEach(p => {
        summary += `- ${p.name} (${p.type}${p.required ? ', required' : ', optional'}): ${p.description}\n`;
        if (p.example) summary += `  Example: ${JSON.stringify(p.example)}\n`;
      });
    }
    
    if (bodyParams.length > 0) {
      summary += '\n## Body Parameters:\n';
      bodyParams.forEach(p => {
        summary += `- ${p.name} (${p.type}${p.required ? ', required' : ', optional'}): ${p.description}\n`;
        if (p.example) summary += `  Example: ${JSON.stringify(p.example)}\n`;
      });
    }
    
    if (documentation.authentication) {
      summary += '\n## Authentication:\n';
      summary += `- Type: ${documentation.authentication.type}\n`;
      if (documentation.authentication.scopes && documentation.authentication.scopes.length > 0) {
        summary += `- Required scopes: ${documentation.authentication.scopes.join(', ')}\n`;
      }
    }
    
    return summary;
  }

  getRequiredParameters(documentation: ApiDocumentation): {
    path: string[];
    query: string[];
    body: string[];
  } {
    return {
      path: documentation.parameters
        .filter(p => p.location === 'path' && p.required)
        .map(p => p.name),
      query: documentation.parameters
        .filter(p => p.location === 'query' && p.required)
        .map(p => p.name),
      body: documentation.parameters
        .filter(p => p.location === 'body' && p.required)
        .map(p => p.name)
    };
  }

  buildExampleRequest(
    action: ModelDefinition,
    documentation: ApiDocumentation,
    context?: any
  ): any {
    const example: any = {
      method: action.action,
      path: action.path,
      headers: {},
      query: {},
      body: {}
    };
    
    documentation.parameters.forEach(param => {
      let value = param.example;
      
      if (context && context.availableIds && context.availableIds.has(param.name)) {
        value = context.availableIds.get(param.name)[0];
      }
      
      switch (param.location) {
        case 'path':
          example.path = example.path.replace(`{${param.name}}`, value || `<${param.name}>`);
          break;
        case 'query':
          if (param.required || value) {
            example.query[param.name] = value || `<${param.name}>`;
          }
          break;
        case 'body':
          if (param.required || value) {
            example.body[param.name] = value || `<${param.name}>`;
          }
          break;
        case 'header':
          if (param.required || value) {
            example.headers[param.name] = value || `<${param.name}>`;
          }
          break;
      }
    });
    
    if (Object.keys(example.query).length === 0) delete example.query;
    if (Object.keys(example.body).length === 0) delete example.body;
    
    return example;
  }

  async enhanceActionKnowledge(
    action: ModelDefinition,
    documentation: ApiDocumentation
  ): Promise<string> {
    let enhancedKnowledge = action.knowledge;
    
    const paramSummary = this.generateParameterSummary(documentation);
    if (paramSummary) {
      enhancedKnowledge += '\n\n' + paramSummary;
    }
    
    const exampleRequest = this.buildExampleRequest(action, documentation);
    enhancedKnowledge += '\n\n## Example Request:\n```json\n' + 
      JSON.stringify(exampleRequest, null, 2) + '\n```';
    
    if (documentation.responseFormat && documentation.responseFormat.example) {
      enhancedKnowledge += '\n\n## Example Response:\n```json\n' + 
        JSON.stringify(documentation.responseFormat.example, null, 2) + '\n```';
    }
    
    if (documentation.examples && documentation.examples.length > 0) {
      enhancedKnowledge += '\n\n## Additional Examples:';
      documentation.examples.forEach((ex, idx) => {
        enhancedKnowledge += `\n\n### ${ex.title}:\n`;
        enhancedKnowledge += 'Request:\n```json\n' + 
          JSON.stringify(ex.request, null, 2) + '\n```\n';
        enhancedKnowledge += 'Response:\n```json\n' + 
          JSON.stringify(ex.response, null, 2) + '\n```';
      });
    }
    
    return enhancedKnowledge;
  }

  clearCache(): void {
    this.cache.clear();
    console.log(chalk.gray('   🗑️ API documentation cache cleared'));
  }
}
