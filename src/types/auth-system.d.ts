/**
 * Types for `@profullstack/auth-system`, which ships none.
 *
 * Only the surface nixamp uses, written from its source rather than guessed:
 * `register` and `login` resolve `{ success, user, tokens }` and THROW on a bad
 * password or a taken address, while `validateToken` resolves the claims
 * directly. The two shapes differ, so they are typed differently here rather
 * than smoothed over.
 */
declare module "@profullstack/auth-system" {
  export interface AuthUser {
    id: string;
    email: string;
    profile?: Record<string, unknown>;
    emailVerified?: boolean;
  }

  export interface AuthTokens {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  }

  export interface AuthResponse {
    success: boolean;
    message?: string;
    user: AuthUser;
    tokens: AuthTokens;
  }

  /** What `validateToken` resolves to: the claims, with no wrapper. */
  export interface AuthClaims {
    userId: string;
    email: string;
    profile?: Record<string, unknown>;
    emailVerified?: boolean;
  }

  export interface AuthSystem {
    /** Throws when the address is already registered. */
    register(input: { email: string; password: string; profile?: Record<string, unknown> }): Promise<AuthResponse>;
    /** Throws `Invalid email or password` rather than resolving success: false. */
    login(input: { email: string; password: string }): Promise<AuthResponse>;
    validateToken(token: string): Promise<AuthClaims>;
    logout(refreshToken?: string, accessToken?: string): Promise<{ success: boolean }>;
  }

  export interface PostgresAdapterOptions {
    pool?: unknown;
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    usersTable?: string;
    tokensTable?: string;
  }

  export class PostgresAdapter {
    constructor(options?: PostgresAdapterOptions);
    initialize(): Promise<void>;
    close(): Promise<void>;
  }

  export class MemoryAdapter {
    constructor();
    clear(): Promise<void>;
  }

  export function createAuthSystem(options?: {
    adapter?: unknown;
    jwtSecret?: string;
    accessTokenExpiry?: string | number;
    refreshTokenExpiry?: string | number;
    /**
     * Composition rules. Every "require" defaults to true except
     * requireSpecialChars, so leaving this out is stricter than passing it.
     */
    passwordOptions?: {
      minLength?: number;
      requireUppercase?: boolean;
      requireLowercase?: boolean;
      requireNumbers?: boolean;
      requireSpecialChars?: boolean;
    };
  }): AuthSystem;
}
