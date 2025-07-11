import { ExecutionContext } from './interfaces/interface';
import { resolvePathParameters } from './utils/pathUtils';

export class PathParameterResolver {
  static resolvePath(
    pathTemplate: string, 
    context?: ExecutionContext, 
    extractedData?: any
  ): { resolvedPath: string; missingParams: string[] } {
    const result = resolvePathParameters(pathTemplate, context, extractedData);
    return {
      resolvedPath: result.resolvedPath,
      missingParams: result.missingParams
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