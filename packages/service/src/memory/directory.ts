import type { UserDirectory } from '../ports';

/** Email → userId lookup for tests (production: Cognito ListUsers / Keycloak admin API). */
export class InMemoryUserDirectory implements UserDirectory {
  private readonly byEmail = new Map<string, string>();

  register(email: string, userId: string): void {
    this.byEmail.set(email.toLowerCase(), userId);
  }

  async findUserIdByEmail(email: string): Promise<string | undefined> {
    return this.byEmail.get(email.toLowerCase());
  }
}
