import { ExecutionContext, ModelDefinition } from './interface';

export class URLValidator {
  static validateAndFixURL(
    url: string, 
    action: ModelDefinition,
    context: ExecutionContext
  ): { 
    isValid: boolean; 
    fixedURL?: string; 
    missingParams?: string[];
    error?: string;
  } {
    // Extract parameter placeholders from URL
    const paramMatches = url.match(/:(\w+)/g) || [];
    const missingParams: string[] = [];
    let fixedURL = url;

    // Check for double slashes (except after http://)
    fixedURL = fixedURL.replace(/([^:]\/)\/+/g, '$1');

    // Check for missing parameters
    for (const param of paramMatches) {
      const paramName = param.substring(1); // Remove ':'
      let paramValue: string | undefined;

      // Try to find value in context
      if (context.availableIds?.has(paramName)) {
        paramValue = context.availableIds.get(paramName)![0];
      } else if (context.availableIds?.has(paramName + 'Id')) {
        paramValue = context.availableIds.get(paramName + 'Id')![0];
      }

      if (!paramValue) {
        // Check if it's already replaced
        if (!fixedURL.includes(param)) continue;
        missingParams.push(paramName);
      } else {
        fixedURL = fixedURL.replace(param, paramValue);
      }
    }

    // Validate URL structure
    const urlPattern = /^https?:\/\/[^\s]+$/;
    if (!urlPattern.test(fixedURL)) {
      return {
        isValid: false,
        error: 'Invalid URL format'
      };
    }

    // Check if URL still contains unreplaced parameters
    if (fixedURL.match(/:\w+/)) {
      return {
        isValid: false,
        fixedURL,
        missingParams,
        error: `URL contains unresolved parameters: ${missingParams.join(', ')}`
      };
    }

    return {
      isValid: true,
      fixedURL
    };
  }

  static extractParametersFromPath(path: string): string[] {
    const params: string[] = [];
    
    // Match {{param}} style
    const templateMatches = path.match(/\{\{(\w+)\}\}/g) || [];
    templateMatches.forEach(match => {
      params.push(match.replace(/[{}]/g, ''));
    });

    // Match :param style
    const colonMatches = path.match(/:(\w+)/g) || [];
    colonMatches.forEach(match => {
      params.push(match.substring(1));
    });

    return [...new Set(params)];
  }
}