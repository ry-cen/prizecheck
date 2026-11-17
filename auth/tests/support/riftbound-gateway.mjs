// The stream-gateway stub with one addition: every session lookup writes `session-lookup` to stderr, so a test can show
// that a request never reached the lookup. Only the session adapter is replaced; the real HTTP server and fetch run.
import { registerHooks } from "node:module";
const source = `
export const auth = {api: {getSession: async ({headers}) => {
  console.error('session-lookup');
  return headers.get('cookie') === 'session=fixture' ? {user:{id:'stream-reader'}} : null;
}}};
export const budgetedAuth = auth;
export const emailSignIn = true;
export const providers = [];
export const pool = {query: async () => ({rows:[]})};
export const rateLimits = {};
export const publicSignup = {};
export const removeSignIn = {};
export const SIGN_IN_PAGE = '/sign-in';
`;
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "./auth.js" &&
      context.parentURL?.endsWith("/auth/src/server.ts")
    )
      return {
        url: `data:text/javascript,${encodeURIComponent(source)}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
