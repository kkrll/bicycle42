// What the type check (bun run check) needs to know and cannot read from the .js files.

/** A stylesheet imported by a module is its text: the build loads it as a string. */
declare module "*.css" {
  const text: string;
  export default text;
}

interface Window {
  /** page → host: the host's binding, or the harness's shim. Takes a message as JSON. */
  __review?: (json: string) => void;
  /** host → page: what mount.js puts here. Its presence stops a second copy of the overlay. */
  __b42?: { version: string; busy(): boolean; receive(msg: any): void };
}
