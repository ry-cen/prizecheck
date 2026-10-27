// Vite resolves an imported image to its URL (inlined as a data URI when small). tsconfig has no vite/client types.
declare module "*.svg" {
  const src: string;
  export default src;
}
