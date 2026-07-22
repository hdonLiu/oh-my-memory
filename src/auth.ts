import { z } from "zod";

export interface AuthContext {
  uid: string;
  agentIds: string[];
}

export interface AuthenticationProvider {
  authenticate(authorization: string | undefined): Promise<AuthContext>;
}

const tokenConfigSchema = z.record(
  z.object({ uid: z.string().min(1), agentIds: z.array(z.string().min(1)).min(1) })
);

/**
 * Minimal production provider for direct deployments. Larger deployments can
 * inject an OIDC/API-gateway provider through the same interface.
 */
export class EnvironmentBearerAuthenticationProvider implements AuthenticationProvider {
  private readonly tokens: Record<string, AuthContext>;

  constructor(raw = process.env.MEMORY_API_TOKENS) {
    if (!raw) throw new Error("MEMORY_API_TOKENS is required");
    this.tokens = tokenConfigSchema.parse(JSON.parse(raw));
  }

  async authenticate(authorization: string | undefined): Promise<AuthContext> {
    const match = /^Bearer (.+)$/.exec(authorization ?? "");
    const context = match ? this.tokens[match[1]!] : undefined;
    if (!context) throw new Error("unauthenticated");
    return { uid: context.uid, agentIds: [...context.agentIds] };
  }
}
