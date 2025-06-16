import { ExecutionContext } from './interface';

export class PathParameterResolver {
  /**
   * Resolves path parameters in a template using available context data
   * @param pathTemplate - Template like "/spreadsheets/{{spreadsheetId}}/values/{{range}}:append"
   * @param context - Execution context containing available IDs
   * @param extractedData - Additional data from current execution
   * @returns Resolved path with parameters substituted
   */
  static resolvePath(
    pathTemplate: string, 
    context?: ExecutionContext, 
    extractedData?: any
  ): { resolvedPath: string; missingParams: string[] } {
    if (!pathTemplate) {
      return { resolvedPath: '', missingParams: [] };
    }

    const missingParams: string[] = [];
    let resolvedPath = pathTemplate;

    const templateVars = pathTemplate.match(/\{\{(\w+)\}\}/g) || [];
    
    for (const templateVar of templateVars) {
      const paramName = templateVar.replace(/[{}]/g, '');
      let paramValue: string | undefined;

      paramValue = this.findParameterValue(paramName, context, extractedData);

      if (paramValue) {
        resolvedPath = resolvedPath.replace(templateVar, paramValue);
      } else {
        missingParams.push(paramName);
        console.warn(`Missing parameter: ${paramName} for path: ${pathTemplate}`);
      }
    }

    return { resolvedPath, missingParams };
  }

  
  private static findParameterValue(
    paramName: string, 
    context?: ExecutionContext, 
    extractedData?: any
  ): string | undefined {
    if (extractedData?.ids?.[paramName]) {
      return extractedData.ids[paramName];
    }

    if (context?.availableIds?.has(paramName)) {
      const ids = context.availableIds.get(paramName);
      if (ids && ids.length > 0) {
        return Array.isArray(ids) ? ids[0] : ids;
      }
    }

    const commonMappings = this.getCommonParameterMappings();
    if (commonMappings[paramName] && context?.availableIds) {
      for (const mappedParam of commonMappings[paramName]) {
        if (context.availableIds.has(mappedParam)) {
          const ids = context.availableIds.get(mappedParam);
          if (ids && ids.length > 0) {
            return Array.isArray(ids) ? ids[0] : ids;
          }
        }
      }
    }

    if (context?.createdResources) {
      for (const [key, resource] of context.createdResources.entries()) {
        if (typeof resource === 'object' && resource !== null) {
          if (resource[paramName]) {
            return resource[paramName];
          }
          if (paramName.endsWith('Id') && resource.id) {
            return resource.id;
          }
        }
      }
    }

    return undefined;
  }

  
  private static getCommonParameterMappings(): Record<string, string[]> {
    return {
      'databaseId': ['spreadsheetId', 'documentId', 'fileId'],
      'sheetName': ['Sheet1', 'sheet1', 'defaultSheet'],
      'range': ['A1:Z1000', 'A:Z'],
      'id': ['documentId', 'spreadsheetId', 'fileId', 'messageId'],
      'documentId': ['fileId', 'id'],
      'fileId': ['documentId', 'id'],
      'folderId': ['parentId', 'directoryId'],
      'messageId': ['emailId', 'id'],
      'contactId': ['personId', 'id'],
      'taskId': ['itemId', 'id']
    };
  }

  
  static validateRequiredParameters(
    pathTemplate: string, 
    context?: ExecutionContext, 
    extractedData?: any
  ): { isValid: boolean; missingParams: string[] } {
    const { missingParams } = this.resolvePath(pathTemplate, context, extractedData);
    return {
      isValid: missingParams.length === 0,
      missingParams
    };
  }

  
  static getDefaultParameterValues(): Record<string, string> {
    return {
      'sheetName': 'Sheet1',
      'range': 'A1:Z1000',
      'majorDimension': 'ROWS',
      'valueInputOption': 'RAW',
      'includeValuesInResponse': 'true'
    };
  }
}