import { defineConfig } from "@neon/config/v1";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required intake configuration: ${name}`);
  return value;
}

const runtimeDatabaseUrl = required("AGENT_INTAKE_DATABASE_URL");

export default defineConfig({
  // Keep the Auth service already enabled on the linked production branch.
  auth: true,
  functions: {
    githubintake: {
      name: "Agent issue intake",
      source: "./src/automation/function.mjs",
      env: {
        GITHUB_WEBHOOK_SECRET: required("GITHUB_WEBHOOK_SECRET"),
        GITHUB_READ_TOKEN: required("GITHUB_READ_TOKEN"),
        GITHUB_REPOSITORY_ID: required("GITHUB_REPOSITORY_ID"),
        GITHUB_REPOSITORY_FULL_NAME: "randoneering/mellon",
        AGENT_INTAKE_DATABASE_URL: runtimeDatabaseUrl,
        // Override both injected URLs so dependencies cannot use an owner connection.
        DATABASE_URL: runtimeDatabaseUrl,
        DATABASE_URL_UNPOOLED: runtimeDatabaseUrl,
      },
    },
  },
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});
