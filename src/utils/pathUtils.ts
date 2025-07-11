import { ExecutionContext } from '../interfaces/interface';

export interface PathResolution {
  resolvedPath: string;
  missingParams: string[];
  isValid: boolean;
}

export function resolvePathParameters(
  pathTemplate: string,
  context?: ExecutionContext,
  extractedData?: any
): PathResolution {
  if (!pathTemplate) {
    return { resolvedPath: '', missingParams: [], isValid: true };
  }

  const missingParams: string[] = [];
  let resolvedPath = pathTemplate;

  // Handle both {{param}} and :param formats
  const allParams = [
    ...(pathTemplate.match(/\{\{(\w+)\}\}/g) || []).map(p => p.replace(/[{}]/g, '')),
    ...(pathTemplate.match(/:(\w+)/g) || []).map(p => p.substring(1))
  ];

  for (const paramName of allParams) {
    const value = findParameterValue(paramName, context, extractedData);
    
    if (value) {
      resolvedPath = resolvedPath
        .replace(`{{${paramName}}}`, value)
        .replace(`:${paramName}`, value);
    } else {
      missingParams.push(paramName);
    }
  }

  return {
    resolvedPath,
    missingParams,
    isValid: missingParams.length === 0
  };
}

function findParameterValue(
  paramName: string,
  context?: ExecutionContext,
  extractedData?: any
): string | undefined {
  if (extractedData?.ids?.[paramName]) {
    return extractedData.ids[paramName];
  }

  if (context?.availableIds?.has(paramName)) {
    const ids = context.availableIds.get(paramName);
    return Array.isArray(ids) ? ids[0] : ids;
  }

  if (context?.createdResources?.has(paramName)) {
    return context.createdResources.get(paramName);
  }

  return undefined;
}

export function validateAndFixURL(
  url: string,
  context?: ExecutionContext
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
    const paramValue = findParameterValue(paramName, context);

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

export function extractParametersFromPath(path: string): string[] {
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