/** @public */
export type BrowserAuthHandler = {
  handler(request: Request): Promise<Response> | Response;
  api?: {
    getSession(input: { headers: Headers }): Promise<{
      session: { id: string };
      user: { id: string };
    } | null>;
  };
};
