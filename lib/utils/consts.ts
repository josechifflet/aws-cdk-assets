import { config } from "./config";

export const { AWS_SECRETS_ARN } = config;
export const BASTION_HOST_INSTANCE_NAME = `${config.PROJECT_NAME}-bastion`;
export const FILES_BUCKET_NAME = `${config.PROJECT_NAME}-files-bucket`;

export const API_SERVICE_NAME = `${config.PROJECT_NAME}-api-service`;
export const API_ECR_REPO_NAME = `${config.PROJECT_NAME}-node-api-repo`;
export const TASK_CONTAINER_NAME = `${config.PROJECT_NAME}-api-task-container`;
export const TASK_CONTAINER_FAMILY = `${config.PROJECT_NAME}-api-task-definition`;

export const CLIENT_SERVICE_NAME = `${config.PROJECT_NAME}-client-service`;
export const CLIENT_TASK_CONTAINER_NAME = `${config.PROJECT_NAME}-client-task-container`;
export const CLIENT_TASK_CONTAINER_FAMILY = `${config.PROJECT_NAME}-client-task-definition`;
export const CLIENT_ECR_REPO_NAME = `${config.PROJECT_NAME}-nextjs-client-repo`;

export const BASE_URL = "https://base-domain.com";
export const BASE_DOMAIN = "base-domain.com";
export const SHORTENED_BASE_DOMAIN = "base-domain.com";
