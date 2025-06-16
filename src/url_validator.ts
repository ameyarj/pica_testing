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
    const paramMatches = url.match(/:(\w+)/g) || [];
    const missingParams: string[] = [];
    let fixedURL = url;

    fixedURL = fixedURL.replace(/([^:]\/)\/+/g, '$1');

    for (const param of paramMatches) {
      const paramName = param.substring(1); 
      let paramValue: string | undefined;

      if (context.availableIds?.has(paramName)) {
        paramValue = context.availableIds.get(paramName)![0];
      } else if (context.availableIds?.has(paramName + 'Id')) {
        paramValue = context.availableIds.get(paramName + 'Id')![0];
      }

      if (!paramValue) {
        if (!fixedURL.includes(param)) continue;
        missingParams.push(paramName);
      } else {
        fixedURL = fixedURL.replace(param, paramValue);
      }
    }

    const urlPattern = /^https?:\/\/[^\s]+$/;
    if (!urlPattern.test(fixedURL)) {
      return {
        isValid: false,
        error: 'Invalid URL format'
      };
    }

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
    
    const templateMatches = path.match(/\{\{(\w+)\}\}/g) || [];
    templateMatches.forEach(match => {
      params.push(match.replace(/[{}]/g, ''));
    });

    const colonMatches = path.match(/:(\w+)/g) || [];
    colonMatches.forEach(match => {
      params.push(match.substring(1));
    });

    return [...new Set(params)];
  }
}