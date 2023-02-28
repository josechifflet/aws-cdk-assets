import { z } from "zod";

export const stringSplit = (s: string | undefined): string[] =>
  !s || s.trim() === "" ? [] : s.split(" ");

export const envVarsSchema = z.object({
  // DEPLOYMENT PURPOSES
  PROJECT_NAME: z.string(),
  ENVIRONMENT: z.string(),
  AWS_ACCOUNT: z.string(),
  AWS_PROFILE: z.string(),
  AWS_DEFAULT_REGION: z.string(),
  AWS_SECRETS_ARN: z.string(),
  AWS_CERTIFICATE_ARN: z.string(),

  DB_PORT: z.string(),
  DB_DATABASE: z.string(),
  DB_USERNAME: z.string(),
});

export type envVarsSchemaType = z.infer<typeof envVarsSchema>;
