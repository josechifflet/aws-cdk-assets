/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import dotEnv = require('dotenv');
import {envVarsSchema, envVarsSchemaType} from './env-schema';

dotEnv.config();

class Config {
  config: envVarsSchemaType;

  constructor() {
    this.config = this.loadConfig();
  }

  public loadConfig = (): envVarsSchemaType => {
    const validateEnvVarsSchemaResult = envVarsSchema.safeParse(process.env);
    if (!validateEnvVarsSchemaResult.success)
      throw new Error(validateEnvVarsSchemaResult.error.toString());

    this.config = validateEnvVarsSchemaResult.data;
    return validateEnvVarsSchemaResult.data;
  };
}

export const configEnvironment = new Config();
export const {config} = configEnvironment;
