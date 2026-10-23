export interface SignedBuildPlan {
  identity: string
  config: Record<string, any> & { directories: Record<string, any>; mac: Record<string, any> }
  env: { APPLE_ID: string; APPLE_APP_SPECIFIC_PASSWORD: string; APPLE_TEAM_ID: string }
}

export function parseSigningEnv(text: string): Record<string, string>
export function resolveSignedBuild(
  baseConfig: Record<string, any>,
  vars: Record<string, string>,
  keychainIdentities: string,
): SignedBuildPlan
