import axios from 'axios';
import { ConnectionDefinition, ModelDefinition } from '../interface';

const PICA_DEV_API_BASE_URL = 'https://development-api.picaos.com/v1';

export class PicaApiService {
  private picaSecretKey: string;

  constructor(picaSecretKey: string) {
    this.picaSecretKey = picaSecretKey;
  }

  async getAllConnectionDefinitions(): Promise<ConnectionDefinition[]> {
    try {
      const response = await axios.get(
        `${PICA_DEV_API_BASE_URL}/public/connection-definitions?limit=1000&skip=0`,
        {
          headers: {
            'x-pica-secret': this.picaSecretKey,
            'authorization': `Bearer ${process.env.PICA_USER_TOKEN}`
          }
        }
      );
      return response.data.rows as ConnectionDefinition[];
    } catch (error) {
      console.error('Error fetching connection definitions:', error);
      throw error;
    }
  }

  async getModelDefinitions(connectionDefinitionId: string): Promise<ModelDefinition[]> {
    try {
      const response = await axios.get(
        `${PICA_DEV_API_BASE_URL}/connection-model-definitions?skip=0&limit=1000&connectionDefinitionId=${connectionDefinitionId}`,
        {
          headers: {
            'x-pica-secret': this.picaSecretKey,
            'authorization': `Bearer ${process.env.PICA_USER_TOKEN}`
          }
        }
      );
      return response.data.rows as ModelDefinition[];
    } catch (error) {
      console.error(`Error fetching model definitions for ${connectionDefinitionId}:`, error);
      throw error;
    }
  }
}